package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestIntegrationPageLifecycleWithRelatedResources(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	_, other := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/folders", owner, map[string]any{"id": "work", "title": "Work"}), 201)
	requireStatus(t, integrationRequest(s, "POST", "/folders", other, map[string]any{"id": "other-folder", "title": "Other"}), 201)
	for _, id := range []string{"parent", "note"} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": id, "title": "Original"}), 201)
	}
	changed := integrationRequest(s, "PATCH", "/pages/note", owner, map[string]any{"parentId": "parent", "folderId": "work", "order": 1, "title": "Lifecycle searchable", "revision": 1})
	requireStatus(t, changed, 200)
	value := responseData[page](t, changed)
	if value.ParentID == nil || *value.ParentID != "parent" || value.FolderID == nil || *value.FolderID != "work" || value.Revision != 2 {
		t.Fatalf("page move changed contract: %+v", value)
	}
	// Failed structural/validation requests must leave the document untouched.
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/parent", owner, map[string]any{"parentId": "note"}), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/note", owner, map[string]any{"parentId": "note"}), 400)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/note", owner, map[string]any{"folderId": "other-folder"}), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/note", owner, map[string]any{"title": strings.Repeat("가", 501)}), 400)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/note", other, map[string]any{"title": "Forbidden"}), 404)
	unchanged := responseData[page](t, integrationRequest(s, "GET", "/pages/note", owner, nil))
	if unchanged.Revision != 2 || unchanged.Title != "Lifecycle searchable" {
		t.Fatalf("rejected patch changed page: %+v", unchanged)
	}
	blocks := json.RawMessage(`[{"id":"paragraph","type":"paragraph","content":"Saved text"},{"id":"table","type":"database","props":{"databaseId":"table-db"}}]`)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/note/blocks", owner, map[string]any{"blocks": blocks, "revision": 2}), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/note/favorite", owner, map[string]any{"favorite": true}), 200)
	search := integrationRequest(s, "GET", "/search?q=searchable", owner, nil)
	requireStatus(t, search, 200)
	if !strings.Contains(search.Body.String(), "Lifecycle searchable") {
		t.Fatal("updated title missing from search")
	}
	state := map[string]any{"name": "Table", "records": []any{}, "trash": []any{}}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/table-db", owner, map[string]any{"pageId": "note", "state": state}), 201)
	state["name"] = "Updated table"
	requireStatus(t, integrationRequest(s, "PUT", "/databases/table-db", owner, map[string]any{"state": state, "revision": 1}), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/table-db", owner, map[string]any{"state": state, "revision": 1}), 409)
	requireStatus(t, integrationRequest(s, "POST", "/pages/note/comments", owner, map[string]any{"id": "thread", "blockId": "paragraph", "blockPreview": "Saved text", "body": "Keep this comment"}), 201)
	requireStatus(t, integrationRequest(s, "PATCH", "/comments/thread", owner, map[string]any{"resolved": true}), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/note", owner, nil), 204)
	archived := responseData[page](t, integrationRequest(s, "GET", "/pages/note", owner, nil))
	if !archived.Archived {
		t.Fatal("delete did not archive page")
	}
	restored := integrationRequest(s, "PATCH", "/pages/note", owner, map[string]any{"archived": false, "parentId": nil, "folderId": nil, "revision": archived.Revision})
	requireStatus(t, restored, 200)
	value = responseData[page](t, restored)
	if value.Archived || value.ParentID != nil || value.FolderID != nil || value.FavoritedAt == nil || !jsonValuesEqual(value.Blocks, blocks) {
		t.Fatalf("restore lost page state: %+v", value)
	}
	comments := integrationRequest(s, "GET", "/pages/note/comments", owner, nil)
	requireStatus(t, comments, 200)
	threads := responseData[[]commentThread](t, comments)
	if len(threads) != 1 || threads[0].ResolvedAt == nil || len(threads[0].Messages) != 1 || threads[0].Messages[0].Body != "Keep this comment" {
		t.Fatalf("archive/restore lost comments: %s", comments.Body.String())
	}
	requireStatus(t, integrationRequest(s, "GET", "/databases/table-db", owner, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/note?hard=true", owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/note", owner, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", "/pages/note/comments", owner, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", "/databases/table-db", owner, nil), 404)
}

func TestIntegrationAttachmentAccessFollowsPageVisibility(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	_, other := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "attachment-page", "title": "Attachments"}), 201)
	const content = "Nodi attachment regression test"
	metadata := map[string]any{"pageId": "attachment-page", "fileName": "note.txt", "contentType": "text/plain", "kind": "file", "size": len(content)}
	presign := integrationRequest(s, "POST", "/attachments/presign", owner, metadata)
	requireStatus(t, presign, 201)
	var upload struct{ UploadURL, AssetURL, CompleteURL, ObjectKey, UploadID string }
	if err := json.Unmarshal(presign.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	uploadRequest := httptest.NewRequest("PUT", upload.UploadURL, strings.NewReader(content))
	uploadRequest.Header.Set("Content-Type", "text/plain")
	uploadResponse := httptest.NewRecorder()
	s.ServeHTTP(uploadResponse, uploadRequest)
	requireStatus(t, uploadResponse, 204)
	delete(metadata, "pageId")
	metadata["objectKey"], metadata["uploadId"] = upload.ObjectKey, upload.UploadID
	completePath := strings.TrimPrefix(upload.CompleteURL, "http://localhost/v1")
	requireStatus(t, integrationRequest(s, "POST", completePath, owner, metadata), 200)
	assetPath := strings.TrimPrefix(upload.AssetURL, "http://localhost/v1")
	requireStatus(t, integrationRequest(s, "GET", assetPath, "", nil), 404)
	requireStatus(t, integrationRequest(s, "GET", assetPath, other, nil), 404)
	download := integrationRequest(s, "GET", assetPath, owner, nil)
	requireStatus(t, download, 200)
	if download.Body.String() != content {
		t.Fatal("download changed file content")
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/attachment-page", owner, map[string]any{"settings": map[string]any{"publicAccess": true}}), 200)
	requireStatus(t, integrationRequest(s, "GET", assetPath, "", nil), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/attachment-page", owner, map[string]any{"settings": map[string]any{"publicAccess": false}}), 200)
	requireStatus(t, integrationRequest(s, "GET", assetPath, "", nil), 404)
	objectPath, err := s.attachmentPath(upload.ObjectKey)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/attachment-page?hard=true", owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", assetPath, owner, nil), 404)
	if _, err = os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("hard delete left attachment object: %v", err)
	}
}
