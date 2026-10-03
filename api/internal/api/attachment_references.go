package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type attachmentReferenceTarget struct {
	pageID        *string
	homeOwnerID   *uuid.UUID
	databaseID    *string
	presetOwnerID *uuid.UUID
	presetID      *string
}

// Only Nodi asset URLs are capabilities. Ordinary external links are not
// interpreted as storage IDs, even if their paths resemble this API.
func (s *Server) attachmentURLs(document json.RawMessage) map[uuid.UUID]string {
	result := make(map[uuid.UUID]string)
	var data any
	if json.Unmarshal(document, &data) != nil {
		return result
	}
	publicURL, _ := url.Parse(s.config.PublicBaseURL)
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			kind, _ := value["type"].(string)
			if kind == "image" || kind == "file" || kind == "video" || kind == "audio" {
				if props, ok := value["props"].(map[string]any); ok {
					if raw, ok := props["url"].(string); ok {
						collectAttachmentURL(result, publicURL, raw)
					}
				}
			}
			for _, child := range value {
				visit(child)
			}
		case []any:
			for _, child := range value {
				visit(child)
			}
		}
	}
	visit(data)
	return result
}

func collectAttachmentURL(result map[uuid.UUID]string, publicURL *url.URL, raw string) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.IsAbs() && (publicURL == nil || !strings.EqualFold(parsed.Host, publicURL.Host) || (parsed.Scheme != "http" && parsed.Scheme != "https"))) || (parsed.Host != "" && !parsed.IsAbs()) {
		return
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 3 || parts[len(parts)-3] != "attachments" || parts[len(parts)-1] != "content" {
		return
	}
	id, err := uuid.Parse(parts[len(parts)-2])
	if err != nil {
		return
	}
	if token := parsed.Query().Get("assetToken"); token != "" {
		result[id] = token
	}
}

// Resource/user/page locks precede attachment locks. The attachment locks are
// acquired in UUID order and also used by hard deletion, so a copy either
// commits a durable reference first or fails without saving a dangling URL.
func (s *Server) syncAttachmentReferences(ctx context.Context, tx pgx.Tx, userID uuid.UUID, target attachmentReferenceTarget, document, previous json.RawMessage) error {
	references := s.attachmentURLs(document)
	previousReferences := s.attachmentURLs(previous)
	approvedIDs := make([]uuid.UUID, 0, len(references))
	ids := make([]uuid.UUID, 0, len(references))
	for id := range references {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		var hash []byte
		err := tx.QueryRow(ctx, `SELECT asset_token_hash FROM attachments WHERE id=$1 FOR UPDATE`, id).Scan(&hash)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		if err == pgx.ErrNoRows || !equalBytes(hash, tokenHash(references[id])) {
			if previousReferences[id] == references[id] {
				continue
			}
			return &apiError{Status: http.StatusForbidden, Code: "ATTACHMENT_ACCESS_REQUIRED", Message: "첨부파일을 읽을 권한이 없거나 파일이 삭제되었습니다."}
		}
		var allowed bool
		if err = tx.QueryRow(ctx, `SELECT attachment_readable($1,$2)`, id, userID).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			if previousReferences[id] == references[id] {
				continue
			}
			return &apiError{Status: http.StatusForbidden, Code: "ATTACHMENT_ACCESS_REQUIRED", Message: "첨부파일을 읽을 권한이 필요합니다."}
		}
		approvedIDs = append(approvedIDs, id)
	}
	// Like attachments.page_id, an approved association lasts until its
	// containing resource is deleted. Removing a block must not destroy a
	// file that undo, a page draft or the resource's trash can still restore.

	for _, id := range approvedIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO attachment_references(attachment_id,page_id,home_owner_id,database_id,preset_owner_id,preset_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, id, target.pageID, target.homeOwnerID, target.databaseID, target.presetOwnerID, target.presetID); err != nil {
			return err
		}
	}
	return nil
}

type attachmentObject struct {
	id           uuid.UUID
	key, backend string
}

func pageAttachmentObjects(ctx context.Context, tx pgx.Tx, pageID string) ([]attachmentObject, error) {
	rows, err := tx.Query(ctx, `SELECT a.id,a.object_key,a.storage_backend FROM attachments a WHERE a.page_id=$1 OR a.id IN (SELECT r.attachment_id FROM attachment_references r LEFT JOIN inline_databases d ON d.id=r.database_id WHERE r.page_id=$1 OR d.page_id=$1) ORDER BY a.id FOR UPDATE OF a`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	objects := []attachmentObject{}
	for rows.Next() {
		var value attachmentObject
		if err = rows.Scan(&value.id, &value.key, &value.backend); err != nil {
			return nil, err
		}
		objects = append(objects, value)
	}
	return objects, rows.Err()
}

func queueUnreferencedAttachments(ctx context.Context, tx pgx.Tx, objects []attachmentObject) error {
	for _, object := range objects {
		result, err := tx.Exec(ctx, `DELETE FROM attachments a WHERE id=$1 AND page_id IS NULL AND NOT EXISTS(SELECT 1 FROM attachment_references WHERE attachment_id=a.id)`, object.id)
		if err != nil {
			return err
		}
		if result.RowsAffected() > 0 {
			if _, err = tx.Exec(ctx, `INSERT INTO attachment_object_deletions(attachment_id,object_key,storage_backend) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, object.id, object.key, object.backend); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) cleanupDeletedAttachmentObjects(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT attachment_id,object_key,storage_backend FROM attachment_object_deletions ORDER BY created_at LIMIT 100`)
	if err != nil {
		return err
	}
	objects := []attachmentObject{}
	for rows.Next() {
		var value attachmentObject
		if err = rows.Scan(&value.id, &value.key, &value.backend); err != nil {
			rows.Close()
			return err
		}
		objects = append(objects, value)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, object := range objects {
		if err = s.removeAttachmentObject(ctx, object.key, object.backend); err != nil {
			return err
		}
		if _, err = s.pool.Exec(ctx, `DELETE FROM attachment_object_deletions WHERE attachment_id=$1`, object.id); err != nil {
			return err
		}
	}
	return nil
}

// The metadata transaction has already succeeded. Storage cleanup is durable
// best effort and must not turn successful deletion into a failed UI mutation.
func (s *Server) retryDeletedAttachmentObjects(ctx context.Context) {
	cleanupContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := s.cleanupDeletedAttachmentObjects(cleanupContext); err != nil {
		slog.Warn("attachment object cleanup deferred", "error", err)
	}
}

func referenceAttachmentObjects(ctx context.Context, tx pgx.Tx, target attachmentReferenceTarget) ([]attachmentObject, error) {
	rows, err := tx.Query(ctx, `SELECT a.id,a.object_key,a.storage_backend FROM attachments a WHERE a.id IN (
 SELECT attachment_id FROM attachment_references WHERE page_id IS NOT DISTINCT FROM $1 AND home_owner_id IS NOT DISTINCT FROM $2 AND database_id IS NOT DISTINCT FROM $3 AND preset_owner_id IS NOT DISTINCT FROM $4 AND preset_id IS NOT DISTINCT FROM $5
 ) ORDER BY a.id FOR UPDATE OF a`, target.pageID, target.homeOwnerID, target.databaseID, target.presetOwnerID, target.presetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	objects := []attachmentObject{}
	for rows.Next() {
		var value attachmentObject
		if err = rows.Scan(&value.id, &value.key, &value.backend); err != nil {
			return nil, err
		}
		objects = append(objects, value)
	}
	return objects, rows.Err()
}
