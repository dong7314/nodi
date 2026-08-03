package api

import (
	"encoding/json"
	"net/http"
	"time"
)

type userPreferences struct {
	Preferences json.RawMessage `json:"preferences"`
	Revision    int64           `json:"revision"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

func (s *Server) getPreferences(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	_, err := s.pool.Exec(r.Context(), `INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	var value userPreferences
	err = s.pool.QueryRow(r.Context(), `SELECT preferences_json,revision,updated_at FROM user_preferences WHERE user_id=$1`, user.ID).Scan(&value.Preferences, &value.Revision, &value.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}

func (s *Server) updatePreferences(w http.ResponseWriter, r *http.Request) {
	user, _ := userFromContext(r.Context())
	var input struct {
		Preferences json.RawMessage `json:"preferences"`
		Revision    *int64          `json:"revision"`
	}
	if err := decodeJSON(w, r, 256*1024, &input); err != nil {
		handleError(w, err)
		return
	}
	if !validJSONObject(input.Preferences) {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "사용자 설정은 JSON 객체여야 합니다.", nil)
		return
	}
	_, err := s.pool.Exec(r.Context(), `INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, user.ID)
	if err != nil {
		handleError(w, err)
		return
	}
	var currentRevision int64
	if err = s.pool.QueryRow(r.Context(), `SELECT revision FROM user_preferences WHERE user_id=$1`, user.ID).Scan(&currentRevision); err != nil {
		handleError(w, err)
		return
	}
	if input.Revision != nil && *input.Revision != currentRevision {
		writeError(w, http.StatusConflict, "REVISION_CONFLICT", "사용자 설정이 다른 위치에서 변경되었습니다.", map[string]any{"currentRevision": currentRevision})
		return
	}
	var value userPreferences
	err = s.pool.QueryRow(r.Context(), `UPDATE user_preferences SET preferences_json=$1,revision=revision+1,updated_at=now() WHERE user_id=$2 AND revision=$3 RETURNING preferences_json,revision,updated_at`, input.Preferences, user.ID, currentRevision).Scan(&value.Preferences, &value.Revision, &value.UpdatedAt)
	if err != nil {
		handleError(w, err)
		return
	}
	writeData(w, http.StatusOK, value)
}
