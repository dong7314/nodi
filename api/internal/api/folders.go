package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

type folder struct {
	ID        string    `json:"id"`
	ParentID  *string   `json:"parentId"`
	Title     string    `json:"title"`
	Order     int64     `json:"order"`
	Collapsed bool      `json:"collapsed"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (s *Server) listFolders(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	rows, err := s.pool.Query(r.Context(), `SELECT id,parent_id,title,order_index,collapsed,created_at,updated_at FROM folders WHERE owner_id=$1 ORDER BY parent_id NULLS FIRST,order_index,id LIMIT 1000`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	result := make([]folder, 0)
	for rows.Next() {
		var value folder
		if err := rows.Scan(&value.ID, &value.ParentID, &value.Title, &value.Order, &value.Collapsed, &value.CreatedAt, &value.UpdatedAt); err != nil {
			handleError(w, err)
			return
		}
		result = append(result, value)
	}
	writeData(w, 200, result)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		ID        string  `json:"id"`
		ParentID  *string `json:"parentId"`
		Title     string  `json:"title"`
		Order     *int64  `json:"order"`
		Collapsed bool    `json:"collapsed"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" {
		input.Title = "새 폴더"
	}
	if input.ID == "" {
		input.ID = "folder-" + uuid.NewString()
	}
	if !validResourceID(input.ID) || !nonEmpty(input.Title, 200) {
		writeError(w, 400, "VALIDATION_ERROR", "폴더 ID 또는 이름이 올바르지 않습니다.", nil)
		return
	}
	tx, err := s.beginWorkspaceWrite(r.Context(), user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if err := validateFolderParent(r, tx, user.ID, "", input.ParentID); err != nil {
		handleError(w, err)
		return
	}
	order := time.Now().UnixMilli()
	if input.Order != nil {
		order = *input.Order
	}
	var value folder
	err = tx.QueryRow(r.Context(), `INSERT INTO folders(id,owner_id,parent_id,title,order_index,collapsed) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,parent_id,title,order_index,collapsed,created_at,updated_at`, input.ID, user.ID, input.ParentID, input.Title, order, input.Collapsed).Scan(&value.ID, &value.ParentID, &value.Title, &value.Order, &value.Collapsed, &value.CreatedAt, &value.UpdatedAt)
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

func (s *Server) updateFolder(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	folderID, err := routeResourceID(r, "folderID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		ParentID  optionalString `json:"parentId"`
		Title     *string        `json:"title"`
		Order     *int64         `json:"order"`
		Collapsed *bool          `json:"collapsed"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	// Serializing all folder writes for this owner protects cross-row moves as
	// well as partial updates. Locking only the moved row cannot prevent A/B cycles.
	tx, err := s.beginWorkspaceWrite(r.Context(), user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var current folder
	err = tx.QueryRow(r.Context(), `SELECT id,parent_id,title,order_index,collapsed,created_at,updated_at FROM folders WHERE id=$1 AND owner_id=$2`, folderID, user.ID).Scan(&current.ID, &current.ParentID, &current.Title, &current.Order, &current.Collapsed, &current.CreatedAt, &current.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	parentID := current.ParentID
	if input.ParentID.Set {
		parentID = input.ParentID.Value
		if err := validateFolderParent(r, tx, user.ID, folderID, parentID); err != nil {
			handleError(w, err)
			return
		}
	}
	title := current.Title
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
	}
	if !nonEmpty(title, 200) {
		writeError(w, 400, "VALIDATION_ERROR", "폴더 이름이 올바르지 않습니다.", nil)
		return
	}
	order, collapsed := current.Order, current.Collapsed
	if input.Order != nil {
		order = *input.Order
	}
	if input.Collapsed != nil {
		collapsed = *input.Collapsed
	}
	err = tx.QueryRow(r.Context(), `UPDATE folders SET parent_id=$1,title=$2,order_index=$3,collapsed=$4,updated_at=now() WHERE id=$5 RETURNING parent_id,title,order_index,collapsed,updated_at`, parentID, title, order, collapsed, folderID).Scan(&current.ParentID, &current.Title, &current.Order, &current.Collapsed, &current.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	writeData(w, 200, current)
}

func (s *Server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	folderID, err := routeResourceID(r, "folderID")
	if err != nil {
		handleError(w, err)
		return
	}
	tx, err := s.beginWorkspaceWrite(r.Context(), user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM folders WHERE id=$1 AND owner_id=$2`, folderID, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		handleError(w, &apiError{404, "FOLDER_NOT_FOUND", "폴더를 찾을 수 없습니다.", nil})
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		handleError(w, err)
		return
	}
	w.WriteHeader(204)
}

func validateFolderParent(r *http.Request, query rowQuerier, ownerID uuid.UUID, folderID string, parentID *string) error {
	if parentID == nil {
		return nil
	}
	if *parentID == folderID {
		return &apiError{400, "FOLDER_CYCLE", "순환하는 폴더 구조는 만들 수 없습니다.", nil}
	}
	var count int
	var ownersMatch, noCycle bool
	err := query.QueryRow(r.Context(), `WITH RECURSIVE tree AS (
		SELECT id,owner_id,parent_id,ARRAY[id::text] AS path,false AS cycle FROM folders WHERE id=$1
		UNION ALL
		SELECT f.id,f.owner_id,f.parent_id,t.path||f.id,f.id=ANY(t.path)
		FROM folders f JOIN tree t ON f.id=t.parent_id WHERE NOT t.cycle
	) SELECT count(*),coalesce(bool_and(owner_id=$2),false),coalesce(NOT bool_or(id=$3 OR cycle),false) FROM tree`, *parentID, ownerID, folderID).Scan(&count, &ownersMatch, &noCycle)
	if err != nil {
		return err
	}
	if count == 0 || !ownersMatch {
		return &apiError{404, "FOLDER_NOT_FOUND", "상위 폴더를 찾을 수 없습니다.", nil}
	}
	if !noCycle {
		return &apiError{400, "FOLDER_CYCLE", "순환하는 폴더 구조는 만들 수 없습니다.", nil}
	}
	height := 1
	if folderID != "" {
		var cycle bool
		if err = query.QueryRow(r.Context(), `WITH RECURSIVE subtree AS (
			SELECT id,1 AS depth,ARRAY[id::text] AS path,false AS cycle FROM folders WHERE id=$1
			UNION ALL
			SELECT f.id,t.depth+1,t.path||f.id,f.id=ANY(t.path)
			FROM folders f JOIN subtree t ON f.parent_id=t.id WHERE NOT t.cycle
		) SELECT coalesce(max(depth),1),coalesce(bool_or(cycle),false) FROM subtree`, folderID).Scan(&height, &cycle); err != nil {
			return err
		}
		if cycle {
			return &apiError{400, "FOLDER_CYCLE", "순환하는 폴더 구조는 만들 수 없습니다.", nil}
		}
	}
	if count+height > 3 {
		return &apiError{400, "FOLDER_DEPTH_EXCEEDED", "폴더는 최대 3단계까지 중첩할 수 있습니다.", nil}
	}
	return nil
}
