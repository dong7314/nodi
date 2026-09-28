package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Server) searchUsersHandler(w http.ResponseWriter, r *http.Request) {
	current, _ := userFromContext(r.Context())
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := boundedInt(r.URL.Query().Get("limit"), 20, 1, 50)
	rows, err := s.pool.Query(r.Context(), `
		SELECT id,name,email,avatar_color,avatar_icon,role,status,'' AS password_hash,requested_at,decided_at
		FROM users
		WHERE status='approved' AND id<>$1
		  AND ($2='' OR name ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%')
		ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,name,email LIMIT $3
	`, current.ID, query, limit)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	users := make([]authUser, 0, limit)
	for rows.Next() {
		var u authUser
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.AvatarColor, &u.AvatarIcon, &u.Role, &u.Status, &u.Password, &u.RequestedAt, &u.DecidedAt); err != nil {
			handleError(w, err)
			return
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, users)
}

func (s *Server) registrationRequestsHandler(w http.ResponseWriter, r *http.Request) {
	limit := boundedInt(r.URL.Query().Get("limit"), 50, 1, 100)
	rows, err := s.pool.Query(r.Context(), `SELECT id,name,email,status,requested_at,decided_at FROM users WHERE role='member' ORDER BY requested_at DESC LIMIT $1`, limit)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	type item struct {
		ID          uuid.UUID  `json:"id"`
		Name        string     `json:"name"`
		Email       string     `json:"email"`
		Status      string     `json:"status"`
		RequestedAt time.Time  `json:"requestedAt"`
		DecidedAt   *time.Time `json:"decidedAt"`
	}
	result := make([]item, 0, limit)
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.ID, &value.Name, &value.Email, &value.Status, &value.RequestedAt, &value.DecidedAt); err != nil {
			handleError(w, err)
			return
		}
		result = append(result, value)
	}
	writeData(w, 200, result)
}

func (s *Server) decideRegistrationHandler(w http.ResponseWriter, r *http.Request) {
	userID, err := routeUUID(r, "userID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		Status string `json:"status"`
	}
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.Status != "approved" && input.Status != "rejected" {
		writeError(w, 400, "VALIDATION_ERROR", "승인 또는 거절 상태를 입력해 주세요.", nil)
		return
	}
	var decidedAt time.Time
	err = s.pool.QueryRow(r.Context(), `UPDATE users SET status=$1,decided_at=now(),updated_at=now() WHERE id=$2 AND role='member' RETURNING decided_at`, input.Status, userID).Scan(&decidedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	if input.Status == "rejected" {
		_, _ = s.pool.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, userID)
	}
	writeData(w, 200, map[string]any{"id": userID, "status": input.Status, "decidedAt": decidedAt})
}

func boundedInt(value string, fallback, minValue, maxValue int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	if parsed < minValue {
		return minValue
	}
	if parsed > maxValue {
		return maxValue
	}
	return parsed
}
