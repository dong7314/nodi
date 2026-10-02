package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

type authContextKey struct{}

const maxPasswordBytes = 72 // bcrypt's maximum input length, including UTF-8 bytes.

func validPassword(value string) bool {
	return len(value) >= 8 && len(value) <= maxPasswordBytes
}

type authUser struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Email       string     `json:"email"`
	AvatarColor string     `json:"avatarColor"`
	AvatarIcon  *string    `json:"avatarIcon,omitempty"`
	Role        string     `json:"role"`
	Status      string     `json:"-"`
	Password    string     `json:"-"`
	RequestedAt time.Time  `json:"-"`
	DecidedAt   *time.Time `json:"-"`
}

func userFromContext(ctx context.Context) (authUser, bool) {
	user, ok := ctx.Value(authContextKey{}).(authUser)
	return user, ok
}

func sessionToken(r *http.Request) string {
	token := bearerToken(r)
	if token == "" {
		if cookie, err := r.Cookie("nodi_session"); err == nil {
			token = cookie.Value
		}
	}
	return token
}

func (s *Server) authenticatedUser(r *http.Request) (authUser, bool) {
	token := sessionToken(r)
	if token == "" {
		return authUser{}, false
	}
	hash := sha256.Sum256([]byte(token))
	var user authUser
	err := s.pool.QueryRow(r.Context(), `
			SELECT u.id, u.name, u.email, u.avatar_color, u.avatar_icon, u.role, u.status,
			       u.password_hash, u.requested_at, u.decided_at
			FROM sessions ss JOIN users u ON u.id=ss.user_id
			WHERE ss.token_hash=$1 AND ss.expires_at>now() AND u.status='approved'
	`, hash[:]).Scan(
		&user.ID, &user.Name, &user.Email, &user.AvatarColor, &user.AvatarIcon,
		&user.Role, &user.Status, &user.Password, &user.RequestedAt, &user.DecidedAt,
	)
	return user, err == nil
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sessionToken(r) == "" {
			writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "로그인이 필요합니다.", nil)
			return
		}
		user, ok := s.authenticatedUser(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "INVALID_SESSION", "로그인 세션이 만료되었습니다.", nil)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authContextKey{}, user)))
	})
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := userFromContext(r.Context())
		if !ok || user.Role != "admin" {
			writeError(w, http.StatusForbidden, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	if !nonEmpty(input.Name, 80) || !validEmail(input.Email) || !validPassword(input.Password) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "이름, 이메일 또는 비밀번호 형식이 올바르지 않습니다.", nil)
		return
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		handleError(w, err)
		return
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext('nodi_first_admin'))`); err != nil {
		handleError(w, err)
		return
	}
	var adminExists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users WHERE role='admin' AND status='approved')`).Scan(&adminExists); err != nil {
		handleError(w, err)
		return
	}
	role, status := "member", "pending"
	var decidedAt *time.Time
	if !adminExists {
		role, status = "admin", "approved"
		now := time.Now().UTC()
		decidedAt = &now
	}
	var user authUser
	err = tx.QueryRow(r.Context(), `
		INSERT INTO users(name,email,role,status,password_hash,decided_at)
		VALUES($1,$2,$3,$4,$5,$6)
		RETURNING id,name,email,avatar_color,avatar_icon,role,status,password_hash,requested_at,decided_at
	`, input.Name, input.Email, role, status, string(passwordHash), decidedAt).Scan(
		&user.ID, &user.Name, &user.Email, &user.AvatarColor, &user.AvatarIcon,
		&user.Role, &user.Status, &user.Password, &user.RequestedAt, &user.DecidedAt,
	)
	if err != nil {
		if strings.Contains(err.Error(), "users_email_unique_idx") {
			writeError(w, http.StatusConflict, "EMAIL_ALREADY_EXISTS", "이미 가입된 이메일입니다.", nil)
			return
		}
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	if status == "pending" {
		writeData(w, http.StatusAccepted, map[string]any{"status": status})
		return
	}
	token, expiresAt, err := s.newSession(r.Context(), user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	s.setSessionCookie(w, token, expiresAt)
	writeData(w, http.StatusCreated, map[string]any{"user": user, "status": status, "expiresAt": expiresAt})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct{ Email, Password string }
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validPassword(input.Password) {
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", nil)
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var user authUser
	// Keep credential verification and session creation behind the same user
	// lock as password/status changes. A delayed login must not issue a session
	// after a password change has already deleted the user's previous sessions.
	err = tx.QueryRow(r.Context(), `
		SELECT id,name,email,avatar_color,avatar_icon,role,status,password_hash,requested_at,decided_at
		FROM users WHERE lower(email)=lower($1) FOR SHARE
	`, input.Email).Scan(
		&user.ID, &user.Name, &user.Email, &user.AvatarColor, &user.AvatarIcon,
		&user.Role, &user.Status, &user.Password, &user.RequestedAt, &user.DecidedAt,
	)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.", nil)
		return
	}
	if user.Status != "approved" {
		code := "ACCOUNT_PENDING"
		message := "관리자의 가입 승인을 기다리고 있습니다."
		if user.Status == "rejected" {
			code, message = "ACCOUNT_REJECTED", "승인되지 않은 계정입니다."
		}
		writeError(w, http.StatusForbidden, code, message, nil)
		return
	}
	token, expiresAt, err := s.newSessionWith(r.Context(), tx, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	s.setSessionCookie(w, token, expiresAt)
	writeData(w, http.StatusOK, map[string]any{"user": user, "expiresAt": expiresAt})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if token := sessionToken(r); token != "" {
		hash := tokenHash(token)
		if _, err := s.pool.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash=$1`, hash); err != nil {
			handleError(w, err)
			return
		}
		s.realtime.revokeSession(hash)
	}
	http.SetCookie(w, &http.Cookie{Name: "nodi_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	writeData(w, http.StatusOK, user)
}

func (s *Server) updateMe(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		Name        *string `json:"name"`
		AvatarColor *string `json:"avatarColor"`
		AvatarIcon  *string `json:"avatarIcon"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	name, color := user.Name, user.AvatarColor
	icon := user.AvatarIcon
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	if input.AvatarColor != nil {
		color = *input.AvatarColor
	}
	if input.AvatarIcon != nil {
		trimmed := strings.TrimSpace(*input.AvatarIcon)
		icon = &trimmed
	}
	if !nonEmpty(name, 80) || !validColor(color) {
		writeError(w, 400, "VALIDATION_ERROR", "프로필 값이 올바르지 않습니다.", nil)
		return
	}
	err := s.pool.QueryRow(r.Context(), `
		UPDATE users SET name=$1,avatar_color=$2,avatar_icon=$3,updated_at=now() WHERE id=$4
		RETURNING id,name,email,avatar_color,avatar_icon,role,status,password_hash,requested_at,decided_at
	`, name, color, icon, user.ID).Scan(&user.ID, &user.Name, &user.Email, &user.AvatarColor, &user.AvatarIcon, &user.Role, &user.Status, &user.Password, &user.RequestedAt, &user.DecidedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, user)
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		CurrentPassword string `json:"currentPassword"`
		NextPassword    string `json:"nextPassword"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validPassword(input.NextPassword) {
		writeError(w, 400, "INVALID_PASSWORD", "새 비밀번호는 UTF-8 기준 8~72바이트여야 합니다.", nil)
		return
	}
	if !validPassword(input.CurrentPassword) || bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(input.CurrentPassword)) != nil {
		writeError(w, 400, "CURRENT_PASSWORD_MISMATCH", "현재 비밀번호가 올바르지 않거나 새 비밀번호 형식이 잘못되었습니다.", nil)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.NextPassword), bcrypt.DefaultCost)
	if err != nil {
		handleError(w, err)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// requireAuth read the password before this transaction. Recheck under the
	// user lock so two requests using the old password cannot both replace it.
	var currentHash string
	if err = tx.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id=$1 FOR UPDATE`, user.ID).Scan(&currentHash); err != nil {
		handleError(w, err)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(input.CurrentPassword)) != nil {
		writeError(w, 400, "CURRENT_PASSWORD_MISMATCH", "현재 비밀번호가 올바르지 않습니다.", nil)
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2`, string(hash), user.ID); err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, user.ID)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	s.realtime.revokeUser(user.ID)
	http.SetCookie(w, &http.Cookie{Name: "nodi_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) newSession(ctx context.Context, userID uuid.UUID) (string, time.Time, error) {
	return s.newSessionWith(ctx, s.pool, userID)
}

func (s *Server) newSessionWith(ctx context.Context, query rowQuerier, userID uuid.UUID) (string, time.Time, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)
	hash := sha256.Sum256([]byte(token))
	expires := time.Now().UTC().Add(s.config.SessionTTL)
	err := query.QueryRow(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3) RETURNING expires_at`, hash[:], userID, expires).Scan(&expires)
	return token, expires, err
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{Name: "nodi_session", Value: token, Path: "/", Expires: expires, MaxAge: int(s.config.SessionTTL.Seconds()), HttpOnly: true, Secure: strings.HasPrefix(s.config.PublicBaseURL, "https://"), SameSite: http.SameSiteLaxMode})
}

func bearerToken(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(value) > 7 && strings.EqualFold(value[:7], "Bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return ""
}

func validEmail(value string) bool {
	address, err := mail.ParseAddress(value)
	return err == nil && strings.EqualFold(address.Address, value)
}
func validColor(value string) bool {
	switch value {
	case "purple", "blue", "green", "orange", "pink", "gray":
		return true
	}
	return false
}
func opaqueHashHex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (s *Server) searchUsers(w http.ResponseWriter, r *http.Request) { s.searchUsersHandler(w, r) }
func (s *Server) listRegistrationRequests(w http.ResponseWriter, r *http.Request) {
	s.registrationRequestsHandler(w, r)
}
func (s *Server) decideRegistrationRequest(w http.ResponseWriter, r *http.Request) {
	s.decideRegistrationHandler(w, r)
}
