package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
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

func (s *Server) listAllComments(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	includeResolved := r.URL.Query().Get("includeResolved") != "false"
	limit := boundedInt(r.URL.Query().Get("limit"), 1000, 1, 2000)
	rows, err := s.pool.Query(r.Context(), `
		SELECT ct.id,ct.page_id,ct.block_id,ct.block_preview,ct.resolved_at,ct.resolved_by,ct.created_at,ct.updated_at
		FROM comment_threads ct
		JOIN pages p ON p.id=ct.page_id
		LEFT JOIN page_shares ps ON ps.page_id=p.id AND ps.user_id=$1
		WHERE (p.owner_id=$1 OR ps.user_id=$1) AND NOT p.archived AND ($2 OR ct.resolved_at IS NULL)
		ORDER BY ct.updated_at DESC LIMIT $3
	`, user.ID, includeResolved, limit)
	if err != nil {
		handleError(w, err)
		return
	}
	threads := make([]commentThread, 0, limit)
	ids := make([]string, 0, limit)
	for rows.Next() {
		var value commentThread
		if err = rows.Scan(&value.ID, &value.PageID, &value.BlockID, &value.BlockPreview, &value.ResolvedAt, &value.ResolvedBy, &value.CreatedAt, &value.UpdatedAt); err != nil {
			rows.Close()
			handleError(w, err)
			return
		}
		value.Messages = []commentMessage{}
		threads = append(threads, value)
		ids = append(ids, value.ID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		handleError(w, err)
		return
	}
	if len(ids) > 0 {
		messageRows, queryErr := s.pool.Query(r.Context(), `
			SELECT m.id,m.thread_id,m.parent_id,m.author_id,u.name,u.email,m.body,m.created_at,m.updated_at
			FROM comment_messages m JOIN users u ON u.id=m.author_id
			WHERE m.thread_id=ANY($1) ORDER BY m.created_at
		`, ids)
		if queryErr != nil {
			handleError(w, queryErr)
			return
		}
		defer messageRows.Close()
		index := make(map[string]int, len(threads))
		for position := range threads {
			index[threads[position].ID] = position
		}
		for messageRows.Next() {
			var threadID string
			var message commentMessage
			if err = messageRows.Scan(&message.ID, &threadID, &message.ParentID, &message.AuthorID, &message.AuthorName, &message.AuthorEmail, &message.Body, &message.CreatedAt, &message.UpdatedAt); err != nil {
				handleError(w, err)
				return
			}
			if position, ok := index[threadID]; ok {
				threads[position].Messages = append(threads[position].Messages, message)
			}
		}
		if err = messageRows.Err(); err != nil {
			handleError(w, err)
			return
		}
	}
	writeData(w, http.StatusOK, threads)
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
	if err == nil {
		err = createPageNotifications(r.Context(), tx, user, pageID, input.ID, "comment", user.Name+"님이 댓글을 남겼어요", input.Body)
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
		if !validResourceID(*input.ParentID) {
			writeError(w, 400, "INVALID_COMMENT_PARENT", "답글 대상 댓글이 올바르지 않습니다.", nil)
			return
		}
		var rootParentID *string
		if err = s.pool.QueryRow(r.Context(), `SELECT parent_id FROM comment_messages WHERE id=$1 AND thread_id=$2`, *input.ParentID, threadID).Scan(&rootParentID); err != nil {
			writeError(w, 400, "INVALID_COMMENT_PARENT", "답글 대상 댓글이 올바르지 않습니다.", nil)
			return
		}
		// Nodi 댓글은 원댓글 + 답글의 2단계까지만 허용한다. 답글에
		// 다시 답하면 동일한 원댓글 아래에 평탄화한다.
		if rootParentID != nil {
			input.ParentID = rootParentID
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
	if err == nil {
		err = createPageNotifications(r.Context(), tx, user, pageID, threadID, "comment", user.Name+"님이 답글을 남겼어요", input.Body)
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
	_, err = s.pool.Exec(r.Context(), `UPDATE comment_threads SET resolved_at=CASE WHEN $1 THEN now() ELSE NULL END,resolved_by=CASE WHEN $1 THEN $2::uuid ELSE NULL END,updated_at=now() WHERE id=$3`, input.Resolved, user.ID, threadID)
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

func (s *Server) deleteCommentMessage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	threadID, err := routeResourceID(r, "threadID")
	if err != nil {
		handleError(w, err)
		return
	}
	messageID, err := routeResourceID(r, "messageID")
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
	var pageID string
	var authorID, ownerID uuid.UUID
	var parentID *string
	err = tx.QueryRow(r.Context(), `
		SELECT t.page_id,m.author_id,p.owner_id,m.parent_id
		FROM comment_messages m
		JOIN comment_threads t ON t.id=m.thread_id
		JOIN pages p ON p.id=t.page_id
		WHERE m.id=$1 AND m.thread_id=$2
	`, messageID, threadID).Scan(&pageID, &authorID, &ownerID, &parentID)
	if err != nil {
		handleError(w, err)
		return
	}
	if _, err = authorizePageWith(r, tx, user.ID, pageID, "view"); err != nil {
		handleError(w, err)
		return
	}
	if user.ID != authorID && user.ID != ownerID {
		writeError(w, http.StatusForbidden, "COMMENT_DELETE_FORBIDDEN", "댓글 작성자 또는 페이지 소유자만 삭제할 수 있습니다.", nil)
		return
	}
	if parentID == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM comment_messages WHERE thread_id=$1 AND (id=$2 OR parent_id=$2)`, threadID, messageID)
	} else {
		_, err = tx.Exec(r.Context(), `DELETE FROM comment_messages WHERE thread_id=$1 AND id=$2`, threadID, messageID)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	var remaining int
	if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM comment_messages WHERE thread_id=$1`, threadID).Scan(&remaining); err != nil {
		handleError(w, err)
		return
	}
	if remaining == 0 {
		_, err = tx.Exec(r.Context(), `DELETE FROM comment_threads WHERE id=$1`, threadID)
	} else {
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
	w.WriteHeader(http.StatusNoContent)
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

func (s *Server) listAllPageShares(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	type member struct {
		User       authUser  `json:"user"`
		Permission string    `json:"permission"`
		SharedAt   time.Time `json:"sharedAt"`
	}
	type record struct {
		PageID     string    `json:"pageId"`
		Owner      authUser  `json:"owner"`
		Permission string    `json:"permission"`
		Members    []member  `json:"members"`
		UpdatedAt  time.Time `json:"updatedAt"`
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT p.id,o.id,o.name,o.email,o.avatar_color,o.avatar_icon,o.role,o.status,'' AS password_hash,o.requested_at,o.decided_at,
		       CASE WHEN p.owner_id=$1 THEN 'owner' ELSE current_share.permission END,p.updated_at
		FROM pages p
		JOIN users o ON o.id=p.owner_id
		LEFT JOIN page_shares current_share ON current_share.page_id=p.id AND current_share.user_id=$1
		WHERE (p.owner_id=$1 OR current_share.user_id=$1) AND NOT p.archived
		ORDER BY p.order_index,p.id
	`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	values := make([]record, 0, 32)
	pageIDs := make([]string, 0, 32)
	index := make(map[string]int, 32)
	for rows.Next() {
		var value record
		if err = rows.Scan(&value.PageID, &value.Owner.ID, &value.Owner.Name, &value.Owner.Email, &value.Owner.AvatarColor, &value.Owner.AvatarIcon, &value.Owner.Role, &value.Owner.Status, &value.Owner.Password, &value.Owner.RequestedAt, &value.Owner.DecidedAt, &value.Permission, &value.UpdatedAt); err != nil {
			rows.Close()
			handleError(w, err)
			return
		}
		value.Members = []member{}
		index[value.PageID] = len(values)
		pageIDs = append(pageIDs, value.PageID)
		values = append(values, value)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		handleError(w, err)
		return
	}
	if len(pageIDs) > 0 {
		memberRows, queryErr := s.pool.Query(r.Context(), `
			SELECT ps.page_id,u.id,u.name,u.email,u.avatar_color,u.avatar_icon,u.role,u.status,'' AS password_hash,u.requested_at,u.decided_at,ps.permission,ps.shared_at
			FROM page_shares ps JOIN users u ON u.id=ps.user_id
			WHERE ps.page_id=ANY($1) ORDER BY ps.shared_at
		`, pageIDs)
		if queryErr != nil {
			handleError(w, queryErr)
			return
		}
		defer memberRows.Close()
		for memberRows.Next() {
			var pageID string
			var value member
			if err = memberRows.Scan(&pageID, &value.User.ID, &value.User.Name, &value.User.Email, &value.User.AvatarColor, &value.User.AvatarIcon, &value.User.Role, &value.User.Status, &value.User.Password, &value.User.RequestedAt, &value.User.DecidedAt, &value.Permission, &value.SharedAt); err != nil {
				handleError(w, err)
				return
			}
			if position, ok := index[pageID]; ok {
				values[position].Members = append(values[position].Members, value)
			}
		}
		if err = memberRows.Err(); err != nil {
			handleError(w, err)
			return
		}
	}
	writeData(w, http.StatusOK, values)
}

func (s *Server) setPageShare(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	if pageID == homePageResourceID {
		writeError(w, http.StatusForbidden, "HOME_PAGE_PRIVATE", "개인 홈은 공유할 수 없습니다.", nil)
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
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Share/notification inserts check both user foreign keys. Take these locks
	// before the page lock, matching user -> page writes (folders and realtime),
	// rather than letting an FK check invert that order while holding the page.
	if _, err = tx.Exec(r.Context(), `SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR KEY SHARE`, user.ID, targetID); err != nil {
		handleError(w, err)
		return
	}
	if err = lockPageForWrite(r.Context(), tx, pageID); err != nil {
		handleError(w, err)
		return
	}
	if _, err = authorizePageWith(r, tx, user.ID, pageID, "owner"); err != nil {
		handleError(w, err)
		return
	}
	var sharedAt time.Time
	err = tx.QueryRow(r.Context(), `INSERT INTO page_shares(page_id,user_id,permission) VALUES($1,$2,$3) ON CONFLICT(page_id,user_id) DO UPDATE SET permission=excluded.permission,shared_at=now() RETURNING shared_at`, pageID, targetID, input.Permission).Scan(&sharedAt)
	var pageTitle string
	if err == nil {
		err = tx.QueryRow(r.Context(), `SELECT title FROM pages WHERE id=$1`, pageID).Scan(&pageTitle)
	}
	if err == nil {
		permissionLabel := "보기"
		if input.Permission == "edit" {
			permissionLabel = "편집"
		}
		title := notificationExcerpt(user.Name+"님이 “"+pageTitle+"” 페이지를 공유했어요", 499)
		_, err = tx.Exec(r.Context(), `INSERT INTO notifications(recipient_id,actor_id,kind,page_id,title,description) VALUES($1,$2,'share',$3,$4,$5)`, targetID, user.ID, pageID, title, permissionLabel+" 권한으로 초대되었습니다.")
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	s.realtime.sendTo(pageID, targetID, pageRealtimeEvent{
		Type:       "permission.updated",
		Permission: input.Permission,
		ActorID:    user.ID.String(),
		Message:    "공유 페이지 권한이 변경되었습니다.",
	})
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
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if err = lockPageForWrite(r.Context(), tx, pageID); err != nil {
		handleError(w, err)
		return
	}
	if _, err = authorizePageWith(r, tx, user.ID, pageID, "owner"); err != nil {
		handleError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `DELETE FROM page_shares WHERE page_id=$1 AND user_id=$2`, pageID, targetID)
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	s.realtime.revoke(pageID, targetID)
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
		if required == "edit" {
			pageValue, accessErr := s.pageForAccess(r, userID, *value.PageID, required)
			if accessErr != nil {
				return value, accessErr
			}
			if pageSettingsLocked(pageValue.Settings) {
				return value, &apiError{Status: http.StatusLocked, Code: "PAGE_LOCKED", Message: "잠긴 페이지의 데이터베이스는 변경할 수 없습니다."}
			}
		} else if _, err = s.authorizePage(r, userID, *value.PageID, required); err != nil {
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

// Serialize the database identity before reading its current page. This covers
// creation and moves even when no database row exists yet. Page rows are then
// locked in ID order, before any database row write, matching page deletion's
// page -> cascading database order. User FK locks always precede page locks.
func (s *Server) beginDatabaseWrite(r *http.Request, userID uuid.UUID, databaseID string, target optionalString) (pgx.Tx, inlineDatabase, bool, error) {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, inlineDatabase{}, false, err
	}
	fail := func(err error) (pgx.Tx, inlineDatabase, bool, error) {
		tx.Rollback(context.Background())
		return nil, inlineDatabase{}, false, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('inline_database:' || $1, 0))`, databaseID); err != nil {
		return fail(err)
	}
	var current inlineDatabase
	err = tx.QueryRow(ctx, `SELECT id,owner_id,page_id,state_json,revision,created_at,updated_at FROM inline_databases WHERE id=$1`, databaseID).Scan(&current.ID, &current.OwnerID, &current.PageID, &current.State, &current.Revision, &current.CreatedAt, &current.UpdatedAt)
	exists := err == nil
	if err != nil && !errorsIsNoRows(err) {
		return fail(err)
	}
	if exists && current.PageID == nil && current.OwnerID != userID {
		return fail(pgx.ErrNoRows)
	}
	pageIDs := make([]string, 0, 2)
	if current.PageID != nil {
		pageIDs = append(pageIDs, *current.PageID)
	}
	if target.Set && target.Value != nil && (current.PageID == nil || *target.Value != *current.PageID) {
		pageIDs = append(pageIDs, *target.Value)
	}
	sort.Strings(pageIDs)
	// Hard deletion also touches child pages through ON DELETE SET NULL.
	// Guard every involved owner before locking pages so deletion cannot hold
	// a parent while a database move holds its child (possibly in another order).
	if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 OR id IN (SELECT owner_id FROM pages WHERE id=ANY($2::text[])) ORDER BY id FOR KEY SHARE`, userID, pageIDs); err != nil {
		return fail(err)
	}
	for _, pageID := range pageIDs {
		if err = lockPageForWrite(ctx, tx, pageID); err != nil {
			return fail(err)
		}
		if _, err = authorizePageWith(r, tx, userID, pageID, "edit"); err != nil {
			return fail(err)
		}
		var settings json.RawMessage
		if err = tx.QueryRow(ctx, `SELECT settings_json FROM pages WHERE id=$1`, pageID).Scan(&settings); err != nil {
			return fail(err)
		}
		if pageSettingsLocked(settings) {
			return fail(&apiError{Status: http.StatusLocked, Code: "PAGE_LOCKED", Message: "잠긴 페이지의 데이터베이스는 변경할 수 없습니다."})
		}
	}
	return tx, current, exists, nil
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
	tx, current, exists, err := s.beginDatabaseWrite(r, user.ID, databaseID, input.PageID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if !exists {
		var pageID *string
		if input.PageID.Set {
			pageID = input.PageID.Value
		}
		err = tx.QueryRow(r.Context(), `INSERT INTO inline_databases(id,owner_id,page_id,state_json) VALUES($1,$2,$3,$4) RETURNING id,owner_id,page_id,state_json,revision,created_at,updated_at`, databaseID, user.ID, pageID, input.State).Scan(&current.ID, &current.OwnerID, &current.PageID, &current.State, &current.Revision, &current.CreatedAt, &current.UpdatedAt)
		if err != nil {
			handleError(w, err)
			return
		}
		if err = tx.Commit(r.Context()); err != nil {
			handleError(w, err)
			return
		}
		if current.PageID != nil {
			s.realtime.broadcast(*current.PageID, pageRealtimeEvent{Type: "database.updated", Database: &current, ActorID: user.ID.String()})
		}
		writeData(w, 201, current)
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
	err = tx.QueryRow(r.Context(), `UPDATE inline_databases SET page_id=$1,state_json=$2,revision=revision+1,updated_at=now() WHERE id=$3 AND revision=$4 RETURNING page_id,state_json,revision,updated_at`, pageID, input.State, databaseID, current.Revision).Scan(&current.PageID, &current.State, &current.Revision, &current.UpdatedAt)
	if errorsIsNoRows(err) {
		var revision int64
		if scanErr := tx.QueryRow(r.Context(), `SELECT revision FROM inline_databases WHERE id=$1`, databaseID).Scan(&revision); scanErr != nil {
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
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	if current.PageID != nil {
		s.realtime.broadcast(*current.PageID, pageRealtimeEvent{Type: "database.updated", Database: &current, ActorID: user.ID.String()})
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
	tx, current, exists, err := s.beginDatabaseWrite(r, user.ID, databaseID, optionalString{})
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if !exists {
		handleError(w, pgx.ErrNoRows)
		return
	}
	_, err = tx.Exec(r.Context(), `DELETE FROM inline_databases WHERE id=$1`, current.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	if current.PageID != nil {
		s.realtime.broadcast(*current.PageID, pageRealtimeEvent{Type: "database.deleted", DatabaseID: current.ID, ActorID: user.ID.String()})
	}
	w.WriteHeader(204)
}

func errorsIsNoRows(err error) bool { return err == pgx.ErrNoRows }
