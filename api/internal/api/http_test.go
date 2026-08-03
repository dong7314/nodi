package api

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/nodi-app/nodi/api/internal/config"
)

func TestClientIPUsesForwardedChainOnlyFromTrustedProxy(t *testing.T) {
	trusted, err := parseTrustedProxyCIDRs([]string{"10.42.0.0/16"})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest("GET", "http://nodi.local/v1/pages", nil)
	request.RemoteAddr = "10.42.1.15:43120"
	request.Header.Set("X-Forwarded-For", "203.0.113.25, 10.42.0.8")
	if actual := clientIP(request, trusted); actual != "203.0.113.25" {
		t.Fatalf("unexpected forwarded client IP: %s", actual)
	}

	request.RemoteAddr = "198.51.100.10:43120"
	request.Header.Set("X-Forwarded-For", "203.0.113.99")
	if actual := clientIP(request, trusted); actual != "198.51.100.10" {
		t.Fatalf("untrusted peer spoofed the client IP: %s", actual)
	}
}

func TestTrustedProxyCIDRsRejectInvalidValues(t *testing.T) {
	if _, err := parseTrustedProxyCIDRs([]string{"not-a-cidr"}); err == nil {
		t.Fatal("expected an invalid trusted proxy CIDR to fail")
	}
}

func TestValidResourceID(t *testing.T) {
	for _, value := range []string{"page-123", "folder-한글", "quick-note"} {
		if !validResourceID(value) {
			t.Fatalf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "has space", "../escape", "folder\\escape"} {
		if validResourceID(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestOptionalStringDistinguishesMissingAndNull(t *testing.T) {
	var input struct {
		Parent optionalString `json:"parent"`
	}
	if err := json.Unmarshal([]byte(`{}`), &input); err != nil {
		t.Fatal(err)
	}
	if input.Parent.Set {
		t.Fatal("missing property must remain unset")
	}
	if err := json.Unmarshal([]byte(`{"parent":null}`), &input); err != nil {
		t.Fatal(err)
	}
	if !input.Parent.Set || input.Parent.Value != nil {
		t.Fatal("explicit null must be represented")
	}
}

func TestPageCursorRoundTrip(t *testing.T) {
	encoded := encodePageCursor(42, "page-123")
	order, id, err := decodePageCursor(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if order != int64(42) || id != "page-123" {
		t.Fatalf("unexpected cursor values: %#v %#v", order, id)
	}
}

func TestIPLimiterResetsWindow(t *testing.T) {
	limiter := newIPLimiter(2, 2)
	start := time.Unix(100, 0)
	if !limiter.allow("127.0.0.1", start) || !limiter.allow("127.0.0.1", start) {
		t.Fatal("requests inside limit should pass")
	}
	if limiter.allow("127.0.0.1", start) {
		t.Fatal("request above limit should be rejected")
	}
	if !limiter.allow("127.0.0.1", start.Add(time.Minute)) {
		t.Fatal("new window should reset the bucket")
	}
}

func TestAttachmentPathStaysInsideUploadRoot(t *testing.T) {
	root := t.TempDir()
	server := &Server{config: config.Config{UploadDir: root}}
	path, err := server.attachmentPath("owner/attachment")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(filepath.Dir(path)) != filepath.Clean(root) {
		t.Fatalf("attachment path escaped root: %s", path)
	}
	if _, err := server.attachmentPath("../escape"); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}

func TestAttachmentTokensAreHashed(t *testing.T) {
	token, hash, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || len(hash) != 32 || !equalBytes(hash, tokenHash(token)) {
		t.Fatal("token and hash did not match")
	}
	if equalBytes(hash, tokenHash(token+"changed")) {
		t.Fatal("different token matched the stored hash")
	}
}

func TestAttachmentImageTypesRejectExecutableFormats(t *testing.T) {
	for _, contentType := range []string{"image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"} {
		if !validAttachmentContentType("image", contentType) {
			t.Fatalf("expected %s to be accepted", contentType)
		}
	}
	for _, contentType := range []string{"image/svg+xml", "text/html", "application/octet-stream"} {
		if validAttachmentContentType("image", contentType) {
			t.Fatalf("expected %s to be rejected for inline images", contentType)
		}
	}
}

func TestHomeSettingsAlwaysRemainPrivate(t *testing.T) {
	settings, err := privatePageSettings(json.RawMessage(`{"publicAccess":true,"wide":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err = json.Unmarshal(settings, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["publicAccess"] != false || decoded["wide"] != true {
		t.Fatalf("unexpected private settings: %#v", decoded)
	}
}

func TestOwnerPageSettingsDetectProtectedChanges(t *testing.T) {
	current := json.RawMessage(`{"publicAccess":false,"lockPage":false,"status":"초안"}`)
	if ownerPageSettingsChanged(current, json.RawMessage(`{"publicAccess":false,"lockPage":false,"status":"완료"}`)) {
		t.Fatal("ordinary page properties should remain editable")
	}
	if !ownerPageSettingsChanged(current, json.RawMessage(`{"publicAccess":true,"lockPage":false,"status":"초안"}`)) {
		t.Fatal("public access must be owner controlled")
	}
	if !ownerPageSettingsChanged(current, json.RawMessage(`{"publicAccess":false,"lockPage":true,"status":"초안"}`)) {
		t.Fatal("page lock must be owner controlled")
	}
}

func TestPageSettingsLocked(t *testing.T) {
	if !pageSettingsLocked(json.RawMessage(`{"lockPage":true}`)) {
		t.Fatal("expected the page to be locked")
	}
	if pageSettingsLocked(json.RawMessage(`{"lockPage":false}`)) || pageSettingsLocked(nil) {
		t.Fatal("expected the page to be editable")
	}
}

func TestNotificationExcerptUsesRuneLength(t *testing.T) {
	if actual := notificationExcerpt(" 가나다라마 ", 3); actual != "가나다…" {
		t.Fatalf("unexpected excerpt: %q", actual)
	}
}
