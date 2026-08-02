package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type page struct {
	ID          string          `json:"id"`
	OwnerID     uuid.UUID       `json:"ownerId"`
	ParentID    *string         `json:"parentId"`
	FolderID    *string         `json:"folderId"`
	Order       int64           `json:"order"`
	Title       string          `json:"title"`
	Settings    json.RawMessage `json:"settings"`
	Blocks      json.RawMessage `json:"blocks,omitempty"`
	Archived    bool            `json:"archived"`
	FavoritedAt *time.Time      `json:"favoritedAt"`
	Revision    int64           `json:"revision"`
	Permission  string          `json:"permission"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

type rowScanner interface{ Scan(...any) error }

func scanPage(scanner rowScanner) (page, error) {
	var value page
	err := scanner.Scan(&value.ID, &value.OwnerID, &value.ParentID, &value.FolderID, &value.Order, &value.Title, &value.Settings, &value.Blocks, &value.Archived, &value.Revision, &value.CreatedAt, &value.UpdatedAt, &value.Permission, &value.FavoritedAt)
	return value, err
}

const pageSelect = `
	SELECT p.id,p.owner_id,p.parent_id,p.folder_id,p.order_index,p.title,p.settings_json,p.blocks_json,
	       p.archived,p.revision,p.created_at,p.updated_at,
	       CASE WHEN p.owner_id=$1 THEN 'owner' ELSE coalesce(ps.permission,'view') END AS permission,
	       pf.favorited_at
	FROM pages p
	LEFT JOIN page_shares ps ON ps.page_id=p.id AND ps.user_id=$1
	LEFT JOIN page_favorites pf ON pf.page_id=p.id AND pf.user_id=$1
`

// Sidebar and search lists intentionally omit blocks_json. A large workspace can
// otherwise transfer every document just to render page titles in the drawer.
const pageListSelect = `
	SELECT p.id,p.owner_id,p.parent_id,p.folder_id,p.order_index,p.title,p.settings_json,
	       p.archived,p.revision,p.created_at,p.updated_at,
	       CASE WHEN p.owner_id=$1 THEN 'owner' ELSE coalesce(ps.permission,'view') END AS permission,
	       pf.favorited_at
	FROM pages p
	LEFT JOIN page_shares ps ON ps.page_id=p.id AND ps.user_id=$1
	LEFT JOIN page_favorites pf ON pf.page_id=p.id AND pf.user_id=$1
`

func scanPageSummary(scanner rowScanner) (page, error) {
	var value page
	err := scanner.Scan(&value.ID, &value.OwnerID, &value.ParentID, &value.FolderID, &value.Order, &value.Title, &value.Settings, &value.Archived, &value.Revision, &value.CreatedAt, &value.UpdatedAt, &value.Permission, &value.FavoritedAt)
	return value, err
}

func (s *Server) listPages(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	includeArchived := r.URL.Query().Get("includeArchived") == "true"
	favoriteOnly := r.URL.Query().Get("favorite") == "true"
	limit := boundedInt(r.URL.Query().Get("limit"), 200, 1, 500)
	cursorOrder, cursorID, err := decodePageCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeError(w, 400, "INVALID_CURSOR", "페이지 커서가 올바르지 않습니다.", nil)
		return
	}
	rows, err := s.pool.Query(r.Context(), pageListSelect+`
		WHERE (p.owner_id=$1 OR ps.user_id=$1) AND ($2 OR NOT p.archived) AND (NOT $3 OR pf.favorited_at IS NOT NULL)
		  AND ($4::bigint IS NULL OR (p.order_index,p.id)>($4,$5::text))
		ORDER BY p.order_index,p.id LIMIT $6
	`, user.ID, includeArchived, favoriteOnly, cursorOrder, cursorID, limit+1)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	result := make([]page, 0, limit)
	var nextCursor string
	for rows.Next() {
		value, err := scanPageSummary(rows)
		if err != nil {
			handleError(w, err)
			return
		}
		if len(result) == limit {
			last := result[len(result)-1]
			nextCursor = encodePageCursor(last.Order, last.ID)
			break
		}
		result = append(result, value)
	}
	writeJSON(w, 200, map[string]any{"data": result, "meta": map[string]any{"nextCursor": nullableString(nextCursor)}})
}

func (s *Server) createPage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		ID        string          `json:"id"`
		ParentID  *string         `json:"parentId"`
		FolderID  *string         `json:"folderId"`
		Order     *int64          `json:"order"`
		Title     string          `json:"title"`
		Settings  json.RawMessage `json:"settings"`
		Blocks    json.RawMessage `json:"blocks"`
		Archived  bool            `json:"archived"`
		Favorited bool            `json:"favorited"`
	}
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.Title == "" {
		input.Title = "제목 없음"
	}
	if len([]rune(input.Title)) > 500 {
		writeError(w, 400, "VALIDATION_ERROR", "페이지 제목이 너무 깁니다.", nil)
		return
	}
	if !validJSONObject(input.Settings) {
		input.Settings = json.RawMessage(`{}`)
	}
	if !validJSONArray(input.Blocks) {
		input.Blocks = json.RawMessage(`[{"type":"paragraph","content":""}]`)
	}
	if input.ID == "" {
		input.ID = "page-" + uuid.NewString()
	}
	if !validResourceID(input.ID) {
		writeError(w, 400, "INVALID_ID", "페이지 ID가 올바르지 않습니다.", nil)
		return
	}
	if err := s.validatePageLocation(r, user.ID, "", input.ParentID, input.FolderID); err != nil {
		handleError(w, err)
		return
	}
	order := time.Now().UnixMilli()
	if input.Order != nil {
		order = *input.Order
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var value page
	err = tx.QueryRow(r.Context(), `
		INSERT INTO pages(id,owner_id,parent_id,folder_id,order_index,title,settings_json,blocks_json,archived)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id,owner_id,parent_id,folder_id,order_index,title,settings_json,blocks_json,archived,revision,created_at,updated_at
	`, input.ID, user.ID, input.ParentID, input.FolderID, order, input.Title, input.Settings, input.Blocks, input.Archived).Scan(&value.ID, &value.OwnerID, &value.ParentID, &value.FolderID, &value.Order, &value.Title, &value.Settings, &value.Blocks, &value.Archived, &value.Revision, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	value.Permission = "owner"
	if input.Favorited {
		var at time.Time
		err = tx.QueryRow(r.Context(), `INSERT INTO page_favorites(page_id,user_id) VALUES($1,$2) RETURNING favorited_at`, value.ID, user.ID).Scan(&at)
		value.FavoritedAt = &at
	}
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 201, value)
}

func (s *Server) getPage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	value, err := scanPage(s.pool.QueryRow(r.Context(), pageSelect+` WHERE p.id=$2 AND (p.owner_id=$1 OR ps.user_id=$1)`, user.ID, pageID))
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, value)
}

func (s *Server) updatePage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		ParentID optionalString  `json:"parentId"`
		FolderID optionalString  `json:"folderId"`
		Order    *int64          `json:"order"`
		Title    *string         `json:"title"`
		Settings json.RawMessage `json:"settings"`
		Blocks   json.RawMessage `json:"blocks"`
		Archived *bool           `json:"archived"`
		Revision *int64          `json:"revision"`
	}
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	current, err := s.pageForAccess(r, user.ID, pageID, "edit")
	if err != nil {
		handleError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != current.Revision {
		writeError(w, 409, "REVISION_CONFLICT", "페이지가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": current.Revision})
		return
	}
	parentID, folderID := current.ParentID, current.FolderID
	if input.ParentID.Set {
		parentID = input.ParentID.Value
	}
	if input.FolderID.Set {
		folderID = input.FolderID.Value
	}
	structural := input.ParentID.Set || input.FolderID.Set || input.Order != nil || input.Archived != nil
	if structural && current.Permission != "owner" {
		writeError(w, 403, "PAGE_OWNER_REQUIRED", "페이지 구조는 소유자만 변경할 수 있습니다.", nil)
		return
	}
	if structural {
		if err := s.validatePageLocation(r, current.OwnerID, pageID, parentID, folderID); err != nil {
			handleError(w, err)
			return
		}
	}
	order, title, settings, blocks, archived := current.Order, current.Title, current.Settings, current.Blocks, current.Archived
	if input.Order != nil {
		order = *input.Order
	}
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
	}
	if input.Settings != nil {
		if !validJSONObject(input.Settings) {
			writeError(w, 400, "VALIDATION_ERROR", "페이지 설정은 JSON 객체여야 합니다.", nil)
			return
		}
		settings = input.Settings
	}
	if input.Blocks != nil {
		if !validJSONArray(input.Blocks) {
			writeError(w, 400, "VALIDATION_ERROR", "블록은 JSON 배열이어야 합니다.", nil)
			return
		}
		blocks = input.Blocks
	}
	if input.Archived != nil {
		archived = *input.Archived
	}
	err = s.pool.QueryRow(r.Context(), `UPDATE pages SET parent_id=$1,folder_id=$2,order_index=$3,title=$4,settings_json=$5,blocks_json=$6,archived=$7,revision=revision+1,updated_at=now() WHERE id=$8 AND revision=$9 RETURNING revision,updated_at`, parentID, folderID, order, title, settings, blocks, archived, pageID, current.Revision).Scan(&current.Revision, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		s.writePageRevisionConflict(w, r, pageID)
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	current.ParentID, current.FolderID, current.Order, current.Title, current.Settings, current.Blocks, current.Archived = parentID, folderID, order, title, settings, blocks, archived
	writeData(w, 200, current)
}

func (s *Server) updatePageBlocks(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		Blocks   json.RawMessage `json:"blocks"`
		Revision *int64          `json:"revision"`
	}
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validJSONArray(input.Blocks) {
		writeError(w, 400, "VALIDATION_ERROR", "블록은 JSON 배열이어야 합니다.", nil)
		return
	}
	current, err := s.pageForAccess(r, user.ID, pageID, "edit")
	if err != nil {
		handleError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != current.Revision {
		writeError(w, 409, "REVISION_CONFLICT", "페이지가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": current.Revision})
		return
	}
	err = s.pool.QueryRow(r.Context(), `UPDATE pages SET blocks_json=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND revision=$3 RETURNING revision,updated_at`, input.Blocks, pageID, current.Revision).Scan(&current.Revision, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		s.writePageRevisionConflict(w, r, pageID)
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	current.Blocks = input.Blocks
	writeData(w, 200, current)
}

func (s *Server) writePageRevisionConflict(w http.ResponseWriter, r *http.Request, pageID string) {
	var revision int64
	if err := s.pool.QueryRow(r.Context(), `SELECT revision FROM pages WHERE id=$1`, pageID).Scan(&revision); err != nil {
		handleError(w, err)
		return
	}
	writeError(w, http.StatusConflict, "REVISION_CONFLICT", "페이지가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": revision})
}

func (s *Server) setPageFavorite(w http.ResponseWriter, r *http.Request) {
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
		Favorite bool `json:"favorite"`
	}
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	var at *time.Time
	if input.Favorite {
		var value time.Time
		err = s.pool.QueryRow(r.Context(), `INSERT INTO page_favorites(page_id,user_id) VALUES($1,$2) ON CONFLICT(page_id,user_id) DO UPDATE SET favorited_at=now() RETURNING favorited_at`, pageID, user.ID).Scan(&value)
		at = &value
	} else {
		_, err = s.pool.Exec(r.Context(), `DELETE FROM page_favorites WHERE page_id=$1 AND user_id=$2`, pageID, user.ID)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, map[string]any{"pageId": pageID, "favoritedAt": at})
}

func (s *Server) deletePage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	current, err := s.pageForAccess(r, user.ID, pageID, "owner")
	if err != nil {
		handleError(w, err)
		return
	}
	if r.URL.Query().Get("hard") == "true" {
		_, err = s.pool.Exec(r.Context(), `DELETE FROM pages WHERE id=$1`, current.ID)
	} else {
		_, err = s.pool.Exec(r.Context(), `UPDATE pages SET archived=true,revision=revision+1,updated_at=now() WHERE id=$1`, current.ID)
	}
	if err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) getPublicPage(w http.ResponseWriter, r *http.Request) {
	pageID, err := routeResourceID(r, "pageID")
	if err != nil {
		handleError(w, err)
		return
	}
	var value page
	err = s.pool.QueryRow(r.Context(), `
	SELECT id,owner_id,parent_id,folder_id,order_index,title,settings_json,blocks_json,archived,revision,created_at,updated_at,'view',NULL
	FROM pages WHERE id=$1 AND NOT archived AND settings_json->>'publicAccess'='true'
`, pageID).Scan(&value.ID, &value.OwnerID, &value.ParentID, &value.FolderID, &value.Order, &value.Title, &value.Settings, &value.Blocks, &value.Archived, &value.Revision, &value.CreatedAt, &value.UpdatedAt, &value.Permission, &value.FavoritedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, value)
}

func (s *Server) searchPages(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeData(w, 200, []page{})
		return
	}
	limit := boundedInt(r.URL.Query().Get("limit"), 30, 1, 100)
	rows, err := s.pool.Query(r.Context(), pageListSelect+`
	WHERE (p.owner_id=$1 OR ps.user_id=$1) AND NOT p.archived AND p.search_document @@ websearch_to_tsquery('simple',$2)
	ORDER BY ts_rank_cd(p.search_document,websearch_to_tsquery('simple',$2)) DESC,p.updated_at DESC LIMIT $3
`, user.ID, query, limit)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	result := make([]page, 0, limit)
	for rows.Next() {
		value, err := scanPageSummary(rows)
		if err != nil {
			handleError(w, err)
			return
		}
		result = append(result, value)
	}
	writeData(w, 200, result)
}

func (s *Server) pageForAccess(r *http.Request, userID uuid.UUID, pageID, required string) (page, error) {
	value, err := scanPage(s.pool.QueryRow(r.Context(), pageSelect+` WHERE p.id=$2 AND (p.owner_id=$1 OR ps.user_id=$1)`, userID, pageID))
	if err != nil {
		return page{}, err
	}
	if required == "owner" && value.Permission != "owner" {
		return page{}, &apiError{Status: 403, Code: "PAGE_OWNER_REQUIRED", Message: "페이지 소유자만 수행할 수 있습니다."}
	}
	if required == "edit" && value.Permission == "view" {
		return page{}, &apiError{Status: 403, Code: "PAGE_EDIT_REQUIRED", Message: "페이지 편집 권한이 필요합니다."}
	}
	return value, nil
}

type pageAccess struct {
	OwnerID    uuid.UUID
	Permission string
	UpdatedAt  time.Time
}

// authorizePage avoids reading blocks_json for requests that only need an ACL
// check, such as comments, favorites, shares, and attachment uploads.
func (s *Server) authorizePage(r *http.Request, userID uuid.UUID, pageID, required string) (pageAccess, error) {
	var access pageAccess
	err := s.pool.QueryRow(r.Context(), `
		SELECT p.owner_id,CASE WHEN p.owner_id=$1 THEN 'owner' ELSE ps.permission END,p.updated_at
		FROM pages p
		LEFT JOIN page_shares ps ON ps.page_id=p.id AND ps.user_id=$1
		WHERE p.id=$2 AND (p.owner_id=$1 OR ps.user_id=$1)
	`, userID, pageID).Scan(&access.OwnerID, &access.Permission, &access.UpdatedAt)
	if err != nil {
		return pageAccess{}, err
	}
	if required == "owner" && access.Permission != "owner" {
		return pageAccess{}, &apiError{Status: 403, Code: "PAGE_OWNER_REQUIRED", Message: "페이지 소유자만 수행할 수 있습니다."}
	}
	if required == "edit" && access.Permission == "view" {
		return pageAccess{}, &apiError{Status: 403, Code: "PAGE_EDIT_REQUIRED", Message: "페이지 편집 권한이 필요합니다."}
	}
	return access, nil
}

func (s *Server) validatePageLocation(r *http.Request, ownerID uuid.UUID, pageID string, parentID, folderID *string) error {
	if parentID != nil {
		if *parentID == pageID {
			return &apiError{400, "PAGE_CYCLE", "순환하는 페이지 구조는 만들 수 없습니다.", nil}
		}
		var valid bool
		err := s.pool.QueryRow(r.Context(), `WITH RECURSIVE tree AS(SELECT id,owner_id,parent_id FROM pages WHERE id=$1 UNION ALL SELECT p.id,p.owner_id,p.parent_id FROM pages p JOIN tree t ON p.id=t.parent_id) SELECT count(*)>0 AND bool_and(owner_id=$2) AND NOT bool_or(id=$3) FROM tree`, *parentID, ownerID, pageID).Scan(&valid)
		if err != nil {
			return err
		}
		if !valid {
			return &apiError{404, "PARENT_PAGE_NOT_FOUND", "상위 페이지를 찾을 수 없습니다.", nil}
		}
	}
	if folderID != nil {
		var exists bool
		if err := s.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND owner_id=$2)`, *folderID, ownerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return &apiError{404, "FOLDER_NOT_FOUND", "폴더를 찾을 수 없습니다.", nil}
		}
	}
	return nil
}

func encodePageCursor(order int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%d:%s", order, id)))
}
func decodePageCursor(value string) (any, any, error) {
	if value == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, nil, err
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 || !validResourceID(parts[1]) {
		return nil, nil, fmt.Errorf("invalid cursor")
	}
	order, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, nil, err
	}
	return order, parts[1], nil
}
func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func validJSONObject(value json.RawMessage) bool {
	if len(value) == 0 {
		return false
	}
	var object map[string]any
	return json.Unmarshal(value, &object) == nil && object != nil
}
func validJSONArray(value json.RawMessage) bool {
	if len(value) == 0 {
		return false
	}
	var array []any
	return json.Unmarshal(value, &array) == nil && array != nil
}
