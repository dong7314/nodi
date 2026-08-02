package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type attachment struct {
	ID          uuid.UUID  `json:"id"`
	OwnerID     uuid.UUID  `json:"ownerId"`
	PageID      *string    `json:"pageId"`
	FileName    string     `json:"fileName"`
	ContentType string     `json:"contentType"`
	Kind        string     `json:"kind"`
	Size        int64      `json:"size"`
	ObjectKey   string     `json:"objectKey"`
	UploadedAt  *time.Time `json:"uploadedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func randomToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token := hex.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	return token, hash[:], nil
}

func tokenHash(value string) []byte {
	hash := sha256.Sum256([]byte(value))
	return hash[:]
}

func (s *Server) presignAttachment(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		PageID       *string `json:"pageId"`
		FileName     string  `json:"fileName"`
		ContentType  string  `json:"contentType"`
		Kind         string  `json:"kind"`
		Size         int64   `json:"size"`
		LastModified int64   `json:"lastModified"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	input.FileName = strings.TrimSpace(filepath.Base(input.FileName))
	input.ContentType = strings.TrimSpace(input.ContentType)
	if input.ContentType == "" {
		input.ContentType = "application/octet-stream"
	}
	limit := s.config.MaxFileBytes
	if input.Kind == "image" {
		limit = s.config.MaxImageBytes
	}
	if (input.Kind != "image" && input.Kind != "file") || !nonEmpty(input.FileName, 255) || len(input.ContentType) > 200 || input.Size <= 0 || input.Size > limit {
		writeError(w, http.StatusBadRequest, "INVALID_ATTACHMENT", "첨부파일 정보 또는 크기가 올바르지 않습니다.", nil)
		return
	}
	if input.PageID != nil {
		if !validResourceID(*input.PageID) {
			writeError(w, http.StatusBadRequest, "INVALID_PAGE_ID", "페이지 ID가 올바르지 않습니다.", nil)
			return
		}
		if _, err := s.authorizePage(r, user.ID, *input.PageID, "edit"); err != nil {
			handleError(w, err)
			return
		}
	}

	id := uuid.New()
	objectKey := filepath.ToSlash(filepath.Join(user.ID.String(), id.String()))
	uploadToken, uploadHash, err := randomToken()
	if err != nil {
		handleError(w, err)
		return
	}
	assetToken, assetHash, err := randomToken()
	if err != nil {
		handleError(w, err)
		return
	}
	_, err = s.pool.Exec(r.Context(), `INSERT INTO attachments
		(id,owner_id,page_id,file_name,content_type,kind,size_bytes,object_key,upload_token_hash,asset_token_hash)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, user.ID, input.PageID, input.FileName, input.ContentType, input.Kind, input.Size, objectKey, uploadHash, assetHash)
	if err != nil {
		handleError(w, err)
		return
	}
	uploadURL := fmt.Sprintf("%s/v1/attachments/%s/content?uploadToken=%s", s.config.PublicBaseURL, id, uploadToken)
	assetURL := fmt.Sprintf("%s/v1/attachments/%s/content?assetToken=%s", s.config.PublicBaseURL, id, assetToken)
	completeURL := fmt.Sprintf("%s/v1/attachments/%s/complete", s.config.PublicBaseURL, id)
	writeJSON(w, http.StatusCreated, map[string]any{
		"uploadUrl": uploadURL, "method": "PUT", "headers": map[string]string{"Content-Type": input.ContentType},
		"objectKey": objectKey, "uploadId": id.String(), "completeUrl": completeURL, "assetUrl": assetURL,
	})
}

func (s *Server) uploadAttachmentContent(w http.ResponseWriter, r *http.Request) {
	id, err := routeUUID(r, "attachmentID")
	if err != nil {
		handleError(w, err)
		return
	}
	token := r.URL.Query().Get("uploadToken")
	if token == "" {
		writeError(w, http.StatusUnauthorized, "UPLOAD_TOKEN_REQUIRED", "업로드 토큰이 필요합니다.", nil)
		return
	}
	var value attachment
	var expectedHash []byte
	err = s.pool.QueryRow(r.Context(), `SELECT id,owner_id,page_id,file_name,content_type,kind,size_bytes,object_key,uploaded_at,created_at,upload_token_hash
		FROM attachments WHERE id=$1`, id).Scan(&value.ID, &value.OwnerID, &value.PageID, &value.FileName, &value.ContentType, &value.Kind, &value.Size, &value.ObjectKey, &value.UploadedAt, &value.CreatedAt, &expectedHash)
	if err != nil {
		handleError(w, err)
		return
	}
	if value.UploadedAt != nil {
		writeError(w, http.StatusConflict, "ALREADY_UPLOADED", "이미 업로드가 완료된 첨부파일입니다.", nil)
		return
	}
	if !equalBytes(expectedHash, tokenHash(token)) {
		writeError(w, http.StatusUnauthorized, "INVALID_UPLOAD_TOKEN", "업로드 토큰이 올바르지 않습니다.", nil)
		return
	}
	if r.ContentLength > value.Size {
		writeError(w, http.StatusRequestEntityTooLarge, "ATTACHMENT_TOO_LARGE", "발급된 크기를 초과했습니다.", nil)
		return
	}
	path, err := s.attachmentPath(value.ObjectKey)
	if err != nil {
		handleError(w, err)
		return
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		handleError(w, err)
		return
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		handleError(w, err)
		return
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	reader := http.MaxBytesReader(w, r.Body, value.Size+1)
	written, copyErr := io.Copy(temporary, reader)
	closeErr := temporary.Close()
	if copyErr != nil || closeErr != nil {
		if copyErr == nil {
			copyErr = closeErr
		}
		handleError(w, copyErr)
		return
	}
	if written != value.Size {
		writeError(w, http.StatusBadRequest, "ATTACHMENT_SIZE_MISMATCH", "발급 요청과 실제 파일 크기가 다릅니다.", map[string]any{"expected": value.Size, "received": written})
		return
	}
	if err = os.Rename(temporaryPath, path); err != nil {
		handleError(w, err)
		return
	}
	result, err := s.pool.Exec(r.Context(), `UPDATE attachments SET uploaded_at=now() WHERE id=$1 AND uploaded_at IS NULL`, id)
	if err != nil || result.RowsAffected() != 1 {
		_ = os.Remove(path)
		if err == nil {
			err = fmt.Errorf("attachment upload state conflict")
		}
		handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) completeAttachment(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeUUID(r, "attachmentID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input struct {
		ObjectKey   string `json:"objectKey"`
		UploadID    string `json:"uploadId"`
		FileName    string `json:"fileName"`
		ContentType string `json:"contentType"`
		Kind        string `json:"kind"`
		Size        int64  `json:"size"`
	}
	if err := decodeJSON(w, r, 64*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	var objectKey string
	var uploadedAt *time.Time
	var fileName, contentType, kind string
	var size int64
	err = s.pool.QueryRow(r.Context(), `SELECT object_key,uploaded_at,file_name,content_type,kind,size_bytes FROM attachments WHERE id=$1 AND owner_id=$2`, id, user.ID).Scan(&objectKey, &uploadedAt, &fileName, &contentType, &kind, &size)
	if err != nil {
		handleError(w, err)
		return
	}
	if uploadedAt == nil || input.ObjectKey != objectKey || (input.UploadID != "" && input.UploadID != id.String()) || input.FileName != fileName || input.ContentType != contentType || input.Kind != kind || input.Size != size {
		writeError(w, http.StatusConflict, "UPLOAD_NOT_COMPLETE", "업로드가 아직 완료되지 않았거나 정보가 일치하지 않습니다.", nil)
		return
	}
	// The raw asset token is only returned at presign time. The client already keeps
	// that stable URL, so completion confirms it without rotating or exposing a hash.
	writeJSON(w, http.StatusOK, map[string]any{"uploaded": true, "objectKey": objectKey})
}

func (s *Server) downloadAttachmentContent(w http.ResponseWriter, r *http.Request) {
	id, err := routeUUID(r, "attachmentID")
	if err != nil {
		handleError(w, err)
		return
	}
	var value attachment
	var expectedHash []byte
	err = s.pool.QueryRow(r.Context(), `SELECT id,owner_id,page_id,file_name,content_type,kind,size_bytes,object_key,uploaded_at,created_at,asset_token_hash
		FROM attachments WHERE id=$1`, id).Scan(&value.ID, &value.OwnerID, &value.PageID, &value.FileName, &value.ContentType, &value.Kind, &value.Size, &value.ObjectKey, &value.UploadedAt, &value.CreatedAt, &expectedHash)
	if err != nil {
		handleError(w, err)
		return
	}
	if value.UploadedAt == nil || !equalBytes(expectedHash, tokenHash(r.URL.Query().Get("assetToken"))) {
		writeError(w, http.StatusNotFound, "ATTACHMENT_NOT_FOUND", "첨부파일을 찾을 수 없습니다.", nil)
		return
	}
	path, err := s.attachmentPath(value.ObjectKey)
	if err != nil {
		handleError(w, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "ATTACHMENT_NOT_FOUND", "첨부파일을 찾을 수 없습니다.", nil)
			return
		}
		handleError(w, err)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		handleError(w, err)
		return
	}
	disposition := "attachment"
	if value.Kind == "image" {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", value.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": value.FileName}))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, value.FileName, stat.ModTime(), file)
}

func (s *Server) deleteAttachment(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeUUID(r, "attachmentID")
	if err != nil {
		handleError(w, err)
		return
	}
	var objectKey string
	err = s.pool.QueryRow(r.Context(), `DELETE FROM attachments WHERE id=$1 AND owner_id=$2 RETURNING object_key`, id, user.ID).Scan(&objectKey)
	if err != nil {
		handleError(w, err)
		return
	}
	if path, pathErr := s.attachmentPath(objectKey); pathErr == nil {
		_ = os.Remove(path)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) attachmentPath(objectKey string) (string, error) {
	root, err := filepath.Abs(s.config.UploadDir)
	if err != nil {
		return "", err
	}
	path, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(objectKey)))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid attachment object key")
	}
	return path, nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for i := range left {
		difference |= left[i] ^ right[i]
	}
	return difference == 0
}

type starterPreset struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Icon           string          `json:"icon"`
	PageTitle      string          `json:"pageTitle"`
	Blocks         json.RawMessage `json:"blocks"`
	SourceFileName *string         `json:"sourceFileName,omitempty"`
	OrderIndex     int16           `json:"orderIndex"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

func scanPreset(row pgx.Row) (starterPreset, error) {
	var value starterPreset
	err := row.Scan(&value.ID, &value.Name, &value.Icon, &value.PageTitle, &value.Blocks, &value.SourceFileName, &value.OrderIndex, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func (s *Server) listPresets(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	rows, err := s.pool.Query(r.Context(), `SELECT id,name,icon,page_title,blocks_json,source_file_name,order_index,created_at,updated_at FROM starter_presets WHERE owner_id=$1 ORDER BY order_index,id LIMIT 5`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	values := make([]starterPreset, 0, 5)
	for rows.Next() {
		value, err := scanPreset(rows)
		if err != nil {
			handleError(w, err)
			return
		}
		values = append(values, value)
	}
	writeData(w, http.StatusOK, values)
}

type presetInput struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Icon           string          `json:"icon"`
	PageTitle      string          `json:"pageTitle"`
	Blocks         json.RawMessage `json:"blocks"`
	SourceFileName *string         `json:"sourceFileName"`
	OrderIndex     int16           `json:"orderIndex"`
}

func validPresetInput(input presetInput) bool {
	return nonEmpty(input.Name, 24) && nonEmpty(input.Icon, 32) && nonEmpty(input.PageTitle, 80) && validJSONArray(input.Blocks) && (input.SourceFileName == nil || len([]rune(*input.SourceFileName)) <= 120)
}

func (s *Server) createPreset(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input presetInput
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.ID == "" {
		input.ID = "preset-" + uuid.NewString()
	}
	if !validResourceID(input.ID) || !validPresetInput(input) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "프리셋 값이 올바르지 않습니다.", nil)
		return
	}
	var count int
	if err := s.pool.QueryRow(r.Context(), `SELECT count(*) FROM starter_presets WHERE owner_id=$1`, user.ID).Scan(&count); err != nil {
		handleError(w, err)
		return
	}
	if count >= 5 {
		writeError(w, http.StatusConflict, "PRESET_LIMIT", "시작 프리셋은 최대 5개까지 저장할 수 있습니다.", nil)
		return
	}
	value, err := scanPreset(s.pool.QueryRow(r.Context(), `INSERT INTO starter_presets(id,owner_id,name,icon,page_title,blocks_json,source_file_name,order_index)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,icon,page_title,blocks_json,source_file_name,order_index,created_at,updated_at`, input.ID, user.ID, strings.TrimSpace(input.Name), input.Icon, strings.TrimSpace(input.PageTitle), input.Blocks, input.SourceFileName, input.OrderIndex))
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusCreated, value)
}

func (s *Server) updatePreset(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeResourceID(r, "presetID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input presetInput
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validPresetInput(input) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "프리셋 값이 올바르지 않습니다.", nil)
		return
	}
	value, err := scanPreset(s.pool.QueryRow(r.Context(), `UPDATE starter_presets SET name=$1,icon=$2,page_title=$3,blocks_json=$4,source_file_name=$5,order_index=$6,updated_at=now()
		WHERE id=$7 AND owner_id=$8 RETURNING id,name,icon,page_title,blocks_json,source_file_name,order_index,created_at,updated_at`, strings.TrimSpace(input.Name), input.Icon, strings.TrimSpace(input.PageTitle), input.Blocks, input.SourceFileName, input.OrderIndex, id, user.ID))
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}

func (s *Server) deletePreset(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeResourceID(r, "presetID")
	if err != nil {
		handleError(w, err)
		return
	}
	result, err := s.pool.Exec(r.Context(), `DELETE FROM starter_presets WHERE id=$1 AND owner_id=$2`, id, user.ID)
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

type tag struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Color      string    `json:"color"`
	OrderIndex int64     `json:"orderIndex"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

func validTagColor(value string) bool {
	switch value {
	case "purple", "blue", "green", "orange", "pink", "gray":
		return true
	default:
		return false
	}
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	rows, err := s.pool.Query(r.Context(), `SELECT id,name,color,order_index,created_at,updated_at FROM tags WHERE owner_id=$1 ORDER BY order_index,id LIMIT 200`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	defer rows.Close()
	values := make([]tag, 0, 16)
	for rows.Next() {
		var value tag
		if err := rows.Scan(&value.ID, &value.Name, &value.Color, &value.OrderIndex, &value.CreatedAt, &value.UpdatedAt); err != nil {
			handleError(w, err)
			return
		}
		values = append(values, value)
	}
	writeData(w, http.StatusOK, values)
}

type tagInput struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Color      string `json:"color"`
	OrderIndex int64  `json:"orderIndex"`
}

func (s *Server) createTag(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input tagInput
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if input.ID == "" {
		input.ID = "tag-" + uuid.NewString()
	}
	if !validResourceID(input.ID) || !nonEmpty(input.Name, 60) || !validTagColor(input.Color) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "태그 값이 올바르지 않습니다.", nil)
		return
	}
	var value tag
	err := s.pool.QueryRow(r.Context(), `INSERT INTO tags(id,owner_id,name,color,order_index) VALUES($1,$2,$3,$4,$5)
		RETURNING id,name,color,order_index,created_at,updated_at`, input.ID, user.ID, strings.TrimSpace(input.Name), input.Color, input.OrderIndex).Scan(&value.ID, &value.Name, &value.Color, &value.OrderIndex, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusCreated, value)
}

func (s *Server) updateTag(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeResourceID(r, "tagID")
	if err != nil {
		handleError(w, err)
		return
	}
	var input tagInput
	if err := decodeJSON(w, r, 32*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if !nonEmpty(input.Name, 60) || !validTagColor(input.Color) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "태그 값이 올바르지 않습니다.", nil)
		return
	}
	var value tag
	err = s.pool.QueryRow(r.Context(), `UPDATE tags SET name=$1,color=$2,order_index=$3,updated_at=now() WHERE id=$4 AND owner_id=$5
		RETURNING id,name,color,order_index,created_at,updated_at`, strings.TrimSpace(input.Name), input.Color, input.OrderIndex, id, user.ID).Scan(&value.ID, &value.Name, &value.Color, &value.OrderIndex, &value.CreatedAt, &value.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	id, err := routeResourceID(r, "tagID")
	if err != nil {
		handleError(w, err)
		return
	}
	result, err := s.pool.Exec(r.Context(), `DELETE FROM tags WHERE id=$1 AND owner_id=$2`, id, user.ID)
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
