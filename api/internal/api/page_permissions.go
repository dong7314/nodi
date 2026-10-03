package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Account/FK locks precede ACL locks, which precede page and attachment locks.
// Reads and edits share this lock; changing a grant excludes every descendant
// authorization until commit without serializing unrelated page edits.
func lockPageACL(ctx context.Context, tx pgx.Tx, pageID string, exclusive bool) error {
	var ownerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=(SELECT owner_id FROM pages WHERE id=$1) FOR KEY SHARE`, pageID).Scan(&ownerID); err != nil {
		return err
	}
	function := "pg_advisory_xact_lock_shared"
	if exclusive {
		function = "pg_advisory_xact_lock"
	}
	_, err := tx.Exec(ctx, `SELECT `+function+`(hashtextextended('page_acl:' || $1, 0))`, ownerID.String())
	return err
}

// Re-evaluate live rooms after an ACL/hierarchy mutation, including inherited
// grants. A direct grant may still allow access after an ancestor is revoked.
func (s *Server) refreshPageTreePermissions(r *http.Request, pageID string, targetID *uuid.UUID) {
	rows, err := s.pool.Query(r.Context(), `WITH RECURSIVE tree AS (
   SELECT id,owner_id FROM pages WHERE id=$1
   UNION SELECT p.id,p.owner_id FROM pages p JOIN tree t ON p.parent_id=t.id AND p.owner_id=t.owner_id
 ) SELECT id FROM tree`, pageID)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		s.refreshPageRoomPermissions(r, id, targetID)
	}
}

func (s *Server) refreshPageRoomPermissions(r *http.Request, pageID string, targetID *uuid.UUID) {
	users := map[uuid.UUID]bool{}
	for _, client := range s.realtime.clients(pageID) {
		users[client.user.ID] = true
	}
	for userID := range users {
		if targetID != nil && userID != *targetID {
			continue
		}
		access, err := s.authorizePage(r, userID, pageID, "view")
		if err == pgx.ErrNoRows {
			s.realtime.revoke(pageID, userID)
			continue
		}
		if err != nil {
			continue
		}
		s.realtime.sendTo(pageID, userID, pageRealtimeEvent{Type: "permission.updated", Permission: access.Permission, Message: "상위 페이지를 포함한 공유 권한이 변경되었습니다."})
	}
}
