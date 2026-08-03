package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const homePageResourceID = "quick-note"

type homePage struct {
	ID        string          `json:"id"`
	OwnerID   uuid.UUID       `json:"ownerId"`
	Title     string          `json:"title"`
	Settings  json.RawMessage `json:"settings"`
	Blocks    json.RawMessage `json:"blocks"`
	Revision  int64           `json:"revision"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

func privatePageSettings(value json.RawMessage) (json.RawMessage, error) {
	if len(value) == 0 {
		value = json.RawMessage(`{}`)
	}
	var settings map[string]any
	if err := json.Unmarshal(value, &settings); err != nil || settings == nil {
		return nil, &apiError{Status: http.StatusBadRequest, Code: "VALIDATION_ERROR", Message: "홈 설정은 JSON 객체여야 합니다."}
	}
	settings["publicAccess"] = false
	return json.Marshal(settings)
}

func scanHomePage(row pgx.Row) (homePage, error) {
	var value homePage
	value.ID = homePageResourceID
	err := row.Scan(&value.OwnerID, &value.Title, &value.Settings, &value.Blocks, &value.Revision, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func (s *Server) ensureHomePage(r *http.Request, userID uuid.UUID) (homePage, error) {
	_, err := s.pool.Exec(r.Context(), `INSERT INTO home_pages(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, userID)
	if err != nil {
		return homePage{}, err
	}
	return scanHomePage(s.pool.QueryRow(r.Context(), `SELECT user_id,title,settings_json,blocks_json,revision,created_at,updated_at FROM home_pages WHERE user_id=$1`, userID))
}

func (s *Server) getHomePage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	value, err := s.ensureHomePage(r, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}

func (s *Server) updateHomePage(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		Title    *string         `json:"title"`
		Settings json.RawMessage `json:"settings"`
		Blocks   json.RawMessage `json:"blocks"`
		Revision *int64          `json:"revision"`
	}
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &input); err != nil {
		handleError(w, err)
		return
	}
	current, err := s.ensureHomePage(r, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != current.Revision {
		writeError(w, http.StatusConflict, "REVISION_CONFLICT", "홈 메모가 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": current.Revision})
		return
	}
	title, settings, blocks := current.Title, current.Settings, current.Blocks
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
		if title == "" {
			title = "오늘의 기록"
		}
		if len([]rune(title)) > 500 {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "홈 제목이 너무 깁니다.", nil)
			return
		}
	}
	if input.Settings != nil {
		settings, err = privatePageSettings(input.Settings)
		if err != nil {
			handleError(w, err)
			return
		}
	}
	if input.Blocks != nil {
		if !validJSONArray(input.Blocks) {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "홈 블록은 JSON 배열이어야 합니다.", nil)
			return
		}
		blocks = input.Blocks
	}
	value, err := scanHomePage(s.pool.QueryRow(r.Context(), `UPDATE home_pages SET title=$1,settings_json=$2,blocks_json=$3,revision=revision+1,updated_at=now() WHERE user_id=$4 AND revision=$5 RETURNING user_id,title,settings_json,blocks_json,revision,created_at,updated_at`, title, settings, blocks, user.ID, current.Revision))
	if err == pgx.ErrNoRows {
		writeError(w, http.StatusConflict, "REVISION_CONFLICT", "홈 메모가 다른 위치에서 변경되었습니다.", nil)
		return
	}
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}
