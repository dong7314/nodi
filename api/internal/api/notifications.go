package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func notificationExcerpt(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func createPageNotifications(ctx context.Context, tx pgx.Tx, actor authUser, pageID, threadID, kind, title, description string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO notifications(recipient_id,actor_id,kind,page_id,thread_id,title,description)
		SELECT recipients.user_id,$2,$3,$1,$4,$5,$6
		FROM (
			SELECT owner_id AS user_id FROM pages WHERE id=$1
			UNION
			SELECT user_id FROM page_shares WHERE page_id=$1
		) recipients
		WHERE recipients.user_id<>$2
	`, pageID, actor.ID, kind, threadID, title, notificationExcerpt(description, 300))
	return err
}

type notification struct {
	ID          uuid.UUID  `json:"id"`
	Kind        string     `json:"kind"`
	PageID      *string    `json:"pageId,omitempty"`
	ThreadID    *string    `json:"threadId,omitempty"`
	ActorID     *uuid.UUID `json:"actorId,omitempty"`
	ActorName   *string    `json:"actorName,omitempty"`
	ActorEmail  *string    `json:"actorEmail,omitempty"`
	AvatarColor *string    `json:"avatarColor,omitempty"`
	AvatarIcon  *string    `json:"avatarIcon,omitempty"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	ReadAt      *time.Time `json:"readAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	limit := boundedInt(r.URL.Query().Get("limit"), 30, 1, 100)
	unreadOnly := r.URL.Query().Get("unread") == "true"
	var before *time.Time
	if value := strings.TrimSpace(r.URL.Query().Get("before")); value != "" {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_CURSOR", "알림 커서가 올바르지 않습니다.", nil)
			return
		}
		before = &parsed
	}
	rows, err := s.pool.Query(r.Context(), `
		SELECT n.id,n.kind,n.page_id,n.thread_id,n.actor_id,u.name,u.email,u.avatar_color,u.avatar_icon,
		       n.title,n.description,n.read_at,n.created_at
		FROM notifications n
		LEFT JOIN users u ON u.id=n.actor_id
		WHERE n.recipient_id=$1 AND (NOT $2 OR n.read_at IS NULL)
		  AND ($3::timestamptz IS NULL OR n.created_at<$3)
		ORDER BY n.created_at DESC,n.id DESC LIMIT $4
	`, user.ID, unreadOnly, before, limit+1)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	values := make([]notification, 0, limit)
	var nextCursor *time.Time
	for rows.Next() {
		var value notification
		if err = rows.Scan(&value.ID, &value.Kind, &value.PageID, &value.ThreadID, &value.ActorID, &value.ActorName, &value.ActorEmail, &value.AvatarColor, &value.AvatarIcon, &value.Title, &value.Description, &value.ReadAt, &value.CreatedAt); err != nil {
			handleError(w, err)
			return
		}
		if len(values) == limit {
			cursor := values[len(values)-1].CreatedAt
			nextCursor = &cursor
			break
		}
		values = append(values, value)
	}
	if err = rows.Err(); err != nil {
		handleError(w, err)
		return
	}
	// A paginated response breaks before Next exhausts the rows. Release that
	// connection before acquiring another one for the unread count.
	rows.Close()
	var unreadCount int
	if err = s.pool.QueryRow(r.Context(), `SELECT count(*) FROM notifications WHERE recipient_id=$1 AND read_at IS NULL`, user.ID).Scan(&unreadCount); err != nil {
		handleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": values,
		"meta": map[string]any{"unreadCount": unreadCount, "nextCursor": nextCursor},
	})
}

func (s *Server) updateNotification(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	notificationID, err := routeUUID(r, "notificationID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		Read bool `json:"read"`
	}
	if err = decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	var readAt *time.Time
	err = s.pool.QueryRow(r.Context(), `UPDATE notifications SET read_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$2 AND recipient_id=$3 RETURNING read_at`, input.Read, notificationID, user.ID).Scan(&readAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{"id": notificationID, "readAt": readAt})
}

func (s *Server) readAllNotifications(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	result, err := s.pool.Exec(r.Context(), `UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{"updated": result.RowsAffected()})
}

func (s *Server) deleteNotification(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	notificationID, err := routeUUID(r, "notificationID")
	if err != nil {
		handleError(w, err)
		return
	}
	result, err := s.pool.Exec(r.Context(), `DELETE FROM notifications WHERE id=$1 AND recipient_id=$2`, notificationID, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	if result.RowsAffected() == 0 {
		handleError(w, pgx.ErrNoRows)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
