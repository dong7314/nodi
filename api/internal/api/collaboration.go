package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type commentMessage struct {
	ID          string    `json:"id"`
	ParentID    *string   `json:"parentId"`
	AuthorID    uuid.UUID `json:"authorId"`
	AuthorName  string    `json:"authorName"`
	AuthorEmail string    `json:"authorEmail"`
	Body        string    `json:"body"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
type commentThread struct {
	ID           string           `json:"id"`
	PageID       string           `json:"pageId"`
	BlockID      string           `json:"blockId"`
	BlockPreview string           `json:"blockPreview"`
	Messages     []commentMessage `json:"messages"`
	ResolvedAt   *time.Time       `json:"resolvedAt"`
	ResolvedBy   *uuid.UUID       `json:"resolvedBy"`
	CreatedAt    time.Time        `json:"createdAt"`
	UpdatedAt    time.Time        `json:"updatedAt"`
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "view"); err != nil {
		handleError(w, err)
		return
	}
	includeResolved := r.URL.Query().Get("includeResolved") != "false"
	limit := boundedInt(r.URL.Query().Get("limit"), 100, 1, 200)
	rows, err := s.pool.Query(r.Context(), `SELECT id,page_id,block_id,block_preview,resolved_at,resolved_by,created_at,updated_at FROM comment_threads WHERE page_id=$1 AND ($2 OR resolved_at IS NULL) ORDER BY updated_at DESC LIMIT $3`, pageID, includeResolved, limit)
	if err != nil {
		handleError(w, err)
		return
	}
	threads := make([]commentThread, 0, limit)
	ids := make([]string, 0, limit)
	for rows.Next() {
		var value commentThread
		if err := rows.Scan(&value.ID, &value.PageID, &value.BlockID, &value.BlockPreview, &value.ResolvedAt, &value.ResolvedBy, &value.CreatedAt, &value.UpdatedAt); err != nil {
			rows.Close()
			handleError(w, err)
			return
		}
		value.Messages = []commentMessage{}
		threads = append(threads, value)
		ids = append(ids, value.ID)
	}
	rows.Close()
	if len(ids) > 0 {
		messageRows, err := s.pool.Query(r.Context(), `SELECT m.id,m.thread_id,m.parent_id,m.author_id,u.name,u.email,m.body,m.created_at,m.updated_at FROM comment_messages m JOIN users u ON u.id=m.author_id WHERE m.thread_id=ANY($1) ORDER BY m.created_at`, ids)
		if err != nil {
			handleError(w, err)
			return
		}
		defer messageRows.Close()
		index := make(map[string]int, len(threads))
		for i := range threads {
			index[threads[i].ID] = i
		}
		for messageRows.Next() {
			var threadID string
			var message commentMessage
			if err := messageRows.Scan(&message.ID, &threadID, &message.ParentID, &message.AuthorID, &message.AuthorName, &message.AuthorEmail, &message.Body, &message.CreatedAt, &message.UpdatedAt); err != nil {
				handleError(w, err)
				return
			}
			position := index[threadID]
			threads[position].Messages = append(threads[position].Messages, message)
		}
	}
	writeData(w, 200, threads)
}

func (s *Server) createCommentThread(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "view"); err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		ID           string `json:"id"`
		BlockID      string `json:"blockId"`
		BlockPreview string `json:"blockPreview"`
		Body         string `json:"body"`
	}
	if err := decodeJSON(w, r, 128*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.ID == "" {
		input.ID = "thread-" + uuid.NewString()
	}
	input.Body = strings.TrimSpace(input.Body)
	if !validResourceID(input.ID) || !nonEmpty(input.BlockID, 300) || !nonEmpty(input.Body, 10000) || len([]rune(input.BlockPreview)) > 500 {
		writeError(w, 400, "VALIDATION_ERROR", "댓글 값이 올바르지 않습니다.", nil)
		return
	}
	messageID := "comment-" + uuid.NewString()
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `INSERT INTO comment_threads(id,page_id,block_id,block_preview) VALUES($1,$2,$3,$4)`, input.ID, pageID, input.BlockID, input.BlockPreview); err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO comment_messages(id,thread_id,author_id,body) VALUES($1,$2,$3,$4)`, messageID, input.ID, user.ID, input.Body)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	value, err := s.loadThread(r, input.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 201, value)
}

func (s *Server) addCommentMessage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	threadID, err := routeResourceID(r, "threadID")
	if err != nil {
		handleError(w, err)
		return
	}
	var pageID string
	if err = s.pool.QueryRow(r.Context(), `SELECT page_id FROM comment_threads WHERE id=$1`, threadID).Scan(&pageID); err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "view"); err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		ID       string  `json:"id"`
		ParentID *string `json:"parentId"`
		Body     string  `json:"body"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.ID == "" {
		input.ID = "comment-" + uuid.NewString()
	}
	input.Body = strings.TrimSpace(input.Body)
	if !validResourceID(input.ID) || !nonEmpty(input.Body, 10000) {
		writeError(w, 400, "VALIDATION_ERROR", "댓글 값이 올바르지 않습니다.", nil)
		return
	}
	if input.ParentID != nil {
		var valid bool
		if err = s.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM comment_messages WHERE id=$1 AND thread_id=$2)`, *input.ParentID, threadID).Scan(&valid); err != nil || !valid {
			writeError(w, 400, "INVALID_COMMENT_PARENT", "답글 대상 댓글이 올바르지 않습니다.", nil)
			return
		}
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `INSERT INTO comment_messages(id,thread_id,parent_id,author_id,body) VALUES($1,$2,$3,$4,$5)`, input.ID, threadID, input.ParentID, user.ID, input.Body)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE comment_threads SET updated_at=now() WHERE id=$1`, threadID)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	value, err := s.loadThread(r, threadID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 201, value)
}

func (s *Server) resolveCommentThread(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	threadID, err := routeResourceID(r, "threadID")
	if err != nil {
		handleError(w, err)
		return
	}
	var pageID string
	if err = s.pool.QueryRow(r.Context(), `SELECT page_id FROM comment_threads WHERE id=$1`, threadID).Scan(&pageID); err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "view"); err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		Resolved bool `json:"resolved"`
	}
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	_, err = s.pool.Exec(r.Context(), `UPDATE comment_threads SET resolved_at=CASE WHEN $1 THEN now() ELSE NULL END,resolved_by=CASE WHEN $1 THEN $2 ELSE NULL END,updated_at=now() WHERE id=$3`, input.Resolved, user.ID, threadID)
	if err != nil {
		handleError(w, err)
		return
	}
	value, err := s.loadThread(r, threadID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, value)
}

func (s *Server) deleteCommentThread(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	threadID, err := routeResourceID(r, "threadID")
	if err != nil {
		handleError(w, err)
		return
	}
	var pageID string
	var authorID uuid.UUID
	err = s.pool.QueryRow(r.Context(), `SELECT t.page_id,m.author_id FROM comment_threads t JOIN LATERAL(SELECT author_id FROM comment_messages WHERE thread_id=t.id ORDER BY created_at LIMIT 1)m ON true WHERE t.id=$1`, threadID).Scan(&pageID, &authorID)
	if err != nil {
		handleError(w, err)
		return
	}
	access, err := s.authorizePage(r, user.ID, pageID, "view")
	if err != nil {
		handleError(w, err)
		return
	}
	if access.Permission != "owner" && authorID != user.ID {
		writeError(w, 403, "COMMENT_DELETE_FORBIDDEN", "댓글 작성자 또는 페이지 소유자만 삭제할 수 있습니다.", nil)
		return
	}
	_, err = s.pool.Exec(r.Context(), `DELETE FROM comment_threads WHERE id=$1`, threadID)
	if err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) loadThread(r *http.Request, threadID string) (commentThread, error) {
	var value commentThread
	err := s.pool.QueryRow(r.Context(), `SELECT id,page_id,block_id,block_preview,resolved_at,resolved_by,created_at,updated_at FROM comment_threads WHERE id=$1`, threadID).Scan(&value.ID, &value.PageID, &value.BlockID, &value.BlockPreview, &value.ResolvedAt, &value.ResolvedBy, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		return value, err
	}
	rows, err := s.pool.Query(r.Context(), `SELECT m.id,m.parent_id,m.author_id,u.name,u.email,m.body,m.created_at,m.updated_at FROM comment_messages m JOIN users u ON u.id=m.author_id WHERE m.thread_id=$1 ORDER BY m.created_at`, threadID)
	if err != nil {
		return value, err
	}
	defer rows.Close()
	value.Messages = []commentMessage{}
	for rows.Next() {
		var message commentMessage
		if err := rows.Scan(&message.ID, &message.ParentID, &message.AuthorID, &message.AuthorName, &message.AuthorEmail, &message.Body, &message.CreatedAt, &message.UpdatedAt); err != nil {
			return value, err
		}
		value.Messages = append(value.Messages, message)
	}
	return value, rows.Err()
}

func (s *Server) listPageShares(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	access, err := s.authorizePage(r, user.ID, pageID, "view")
	if err != nil {
		handleError(w, err)
		return
	}
	var owner authUser
	err = s.pool.QueryRow(r.Context(), `SELECT id,name,email,avatar_color,avatar_icon,role,status,'' AS password_hash,requested_at,decided_at FROM users WHERE id=$1`, access.OwnerID).Scan(&owner.ID, &owner.Name, &owner.Email, &owner.AvatarColor, &owner.AvatarIcon, &owner.Role, &owner.Status, &owner.Password, &owner.RequestedAt, &owner.DecidedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	type member struct {
		User       authUser  `json:"user"`
		Permission string    `json:"permission"`
		SharedAt   time.Time `json:"sharedAt"`
	}
	rows, err := s.pool.Query(r.Context(), `SELECT u.id,u.name,u.email,u.avatar_color,u.avatar_icon,u.role,u.status,'' AS password_hash,u.requested_at,u.decided_at,ps.permission,ps.shared_at FROM page_shares ps JOIN users u ON u.id=ps.user_id WHERE ps.page_id=$1 ORDER BY ps.shared_at LIMIT 200`, pageID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	members := []member{}
	for rows.Next() {
		var value member
		if err := rows.Scan(&value.User.ID, &value.User.Name, &value.User.Email, &value.User.AvatarColor, &value.User.AvatarIcon, &value.User.Role, &value.User.Status, &value.User.Password, &value.User.RequestedAt, &value.User.DecidedAt, &value.Permission, &value.SharedAt); err != nil {
			handleError(w, err)
			return
		}
		members = append(members, value)
	}
	writeData(w, 200, map[string]any{"pageId": pageID, "owner": owner, "permission": access.Permission, "members": members, "updatedAt": access.UpdatedAt})
}

func (s *Server) setPageShare(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "owner"); err != nil {
		handleError(w, err)
		return
	}
	targetID, err := routeUUID(r, "userID")
	if err != nil {
		handleError(w, err)
		return
	}
	if targetID == user.ID {
		writeError(w, 400, "CANNOT_SHARE_WITH_SELF", "자신에게 페이지를 공유할 수 없습니다.", nil)
		return
	}
	var input struct {
		Permission string `json:"permission"`
	}
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.Permission != "view" && input.Permission != "edit" {
		writeError(w, 400, "VALIDATION_ERROR", "공유 권한이 올바르지 않습니다.", nil)
		return
	}
	var approved bool
	if err = s.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND status='approved')`, targetID).Scan(&approved); err != nil || !approved {
		writeError(w, 404, "USER_NOT_FOUND", "공유할 사용자를 찾을 수 없습니다.", nil)
		return
	}
	var sharedAt time.Time
	err = s.pool.QueryRow(r.Context(), `INSERT INTO page_shares(page_id,user_id,permission) VALUES($1,$2,$3) ON CONFLICT(page_id,user_id) DO UPDATE SET permission=excluded.permission,shared_at=now() RETURNING shared_at`, pageID, targetID, input.Permission).Scan(&sharedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, map[string]any{"userId": targetID, "permission": input.Permission, "sharedAt": sharedAt})
}

func (s *Server) deletePageShare(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	if _, err = s.authorizePage(r, user.ID, pageID, "owner"); err != nil {
		handleError(w, err)
		return
	}
	targetID, err := routeUUID(r, "userID")
	if err != nil {
		handleError(w, err)
		return
	}
	_, err = s.pool.Exec(r.Context(), `DELETE FROM page_shares WHERE page_id=$1 AND user_id=$2`, pageID, targetID)
	if err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}

type inlineDatabase struct {
	ID        string          `json:"id"`
	OwnerID   uuid.UUID       `json:"ownerId"`
	PageID    *string         `json:"pageId"`
	State     json.RawMessage `json:"state"`
	Revision  int64           `json:"revision"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

func (s *Server) databaseForAccess(r *http.Request, userID uuid.UUID, databaseID, required string) (inlineDatabase, error) {
	var value inlineDatabase
	err := s.pool.QueryRow(r.Context(), `SELECT id,owner_id,page_id,state_json,revision,created_at,updated_at FROM inline_databases WHERE id=$1`, databaseID).Scan(&value.ID, &value.OwnerID, &value.PageID, &value.State, &value.Revision, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		return value, err
	}
	if value.PageID != nil {
		if _, err = s.authorizePage(r, userID, *value.PageID, required); err != nil {
			return value, err
		}
	} else if value.OwnerID != userID {
		return value, pgx.ErrNoRows
	}
	return value, nil
}
func (s *Server) getInlineDatabase(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	databaseID, err := routeResourceID(r, "databaseID")
	if err != nil {
		handleError(w, err)
		return
	}
	value, err := s.databaseForAccess(r, user.ID, databaseID, "view")
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, value)
}
func (s *Server) putInlineDatabase(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	databaseID, err := routeResourceID(r, "databaseID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		PageID   optionalString  `json:"pageId"`
		State    json.RawMessage `json:"state"`
		Revision *int64          `json:"revision"`
	}
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validJSONObject(input.State) {
		writeError(w, 400, "VALIDATION_ERROR", "데이터베이스 상태는 JSON 객체여야 합니다.", nil)
		return
	}
	current, err := s.databaseForAccess(r, user.ID, databaseID, "edit")
	if errorsIsNoRows(err) {
		var pageID *string
		if input.PageID.Set {
			pageID = input.PageID.Value
		}
		if pageID != nil {
			if _, accessErr := s.authorizePage(r, user.ID, *pageID, "edit"); accessErr != nil {
				handleError(w, accessErr)
				return
			}
		}
		err = s.pool.QueryRow(r.Context(), `INSERT INTO inline_databases(id,owner_id,page_id,state_json) VALUES($1,$2,$3,$4) RETURNING id,owner_id,page_id,state_json,revision,created_at,updated_at`, databaseID, user.ID, pageID, input.State).Scan(&current.ID, &current.OwnerID, &current.PageID, &current.State, &current.Revision, &current.CreatedAt, &current.UpdatedAt)
		if err != nil {
			handleError(w, err)
			return
		}
		writeData(w, 201, current)
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != current.Revision {
		writeError(w, 409, "REVISION_CONFLICT", "데이터베이스가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": current.Revision})
		return
	}
	pageID := current.PageID
	if input.PageID.Set {
		pageID = input.PageID.Value
	}
	if pageID != nil && current.PageID != pageID {
		if _, err = s.authorizePage(r, user.ID, *pageID, "edit"); err != nil {
			handleError(w, err)
			return
		}
	}
	err = s.pool.QueryRow(r.Context(), `UPDATE inline_databases SET page_id=$1,state_json=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND revision=$4 RETURNING page_id,state_json,revision,updated_at`, pageID, input.State, databaseID, current.Revision).Scan(&current.PageID, &current.State, &current.Revision, &current.UpdatedAt)
	if errorsIsNoRows(err) {
		var revision int64
		if scanErr := s.pool.QueryRow(r.Context(), `SELECT revision FROM inline_databases WHERE id=$1`, databaseID).Scan(&revision); scanErr != nil {
			handleError(w, scanErr)
			return
		}
		writeError(w, http.StatusConflict, "REVISION_CONFLICT", "데이터베이스가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": revision})
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, current)
}
func (s *Server) deleteInlineDatabase(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	databaseID, err := routeResourceID(r, "databaseID")
	if err != nil {
		handleError(w, err)
		return
	}
	current, err := s.databaseForAccess(r, user.ID, databaseID, "edit")
	if err != nil {
		handleError(w, err)
		return
	}
	_, err = s.pool.Exec(r.Context(), `DELETE FROM inline_databases WHERE id=$1`, current.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}

func errorsIsNoRows(err error) bool { return err == pgx.ErrNoRows }
