package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type apiError struct {
	Status  int
	Code    string
	Message string
	Details any
}

type optionalUUID struct {
	Set   bool
	Value *uuid.UUID
}

type optionalString struct {
	Set   bool
	Value *string
}

func (value *optionalString) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	raw = strings.TrimSpace(raw)
	if !validResourceID(raw) {
		return fmt.Errorf("invalid resource id")
	}
	value.Value = &raw
	return nil
}

func (value *optionalUUID) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return err
	}
	value.Value = &parsed
	return nil
}

func (e *apiError) Error() string { return e.Message }

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, map[string]any{"data": data})
}

func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	payload := map[string]any{"code": code, "message": message}
	if details != nil {
		payload["details"] = details
	}
	writeJSON(w, status, map[string]any{"error": payload})
}

func handleError(w http.ResponseWriter, err error) {
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "요청 데이터가 허용 크기를 초과했습니다.", nil)
		return
	}
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		writeError(w, apiErr.Status, apiErr.Code, apiErr.Message, apiErr.Details)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "RESOURCE_NOT_FOUND", "요청한 데이터를 찾을 수 없습니다.", nil)
		return
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23505":
			writeError(w, http.StatusConflict, "RESOURCE_CONFLICT", "이미 존재하는 값과 충돌합니다.", nil)
		case "23503", "23514":
			writeError(w, http.StatusBadRequest, "CONSTRAINT_VIOLATION", "연결된 데이터 또는 입력 값이 올바르지 않습니다.", nil)
		default:
			writeError(w, http.StatusInternalServerError, "DATABASE_ERROR", "데이터를 처리하지 못했습니다.", nil)
		}
		return
	}
	writeError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "서버에서 요청을 처리하지 못했습니다.", nil)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return &apiError{Status: http.StatusRequestEntityTooLarge, Code: "PAYLOAD_TOO_LARGE", Message: "요청 데이터가 허용 크기를 초과했습니다."}
		}
		return &apiError{Status: http.StatusBadRequest, Code: "INVALID_JSON", Message: "JSON 요청 본문이 올바르지 않습니다.", Details: err.Error()}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &apiError{Status: http.StatusBadRequest, Code: "INVALID_JSON", Message: "요청 본문에는 하나의 JSON 값만 사용할 수 있습니다."}
	}
	return nil
}

func routeUUID(r *http.Request, name string) (uuid.UUID, error) {
	value := chi.URLParam(r, name)
	id, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, &apiError{Status: http.StatusBadRequest, Code: "INVALID_ID", Message: fmt.Sprintf("%s 값이 올바르지 않습니다.", name)}
	}
	return id, nil
}

func routeResourceID(r *http.Request, name string) (string, error) {
	value := strings.TrimSpace(chi.URLParam(r, name))
	if !validResourceID(value) {
		return "", &apiError{Status: http.StatusBadRequest, Code: "INVALID_ID", Message: fmt.Sprintf("%s 값이 올바르지 않습니다.", name)}
	}
	return value, nil
}

func validResourceID(value string) bool {
	if len(value) == 0 || len(value) > 160 {
		return false
	}
	for _, char := range value {
		if char <= 0x20 || char == '/' || char == '\\' {
			return false
		}
	}
	return true
}

func contextWithTimeout(r *http.Request, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), timeout)
}

func nonEmpty(value string, max int) bool {
	length := len([]rune(strings.TrimSpace(value)))
	return length > 0 && length <= max
}
