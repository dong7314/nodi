package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"github.com/nodi-app/nodi/api/internal/database"
	"golang.org/x/net/websocket"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIntegrationConcurrentPageMovesCannotPersistCycle(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	for _, id := range []string{"a", "b"} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": id, "title": id}), 201)
	}
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_page_move BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	results := make(chan *httptest.ResponseRecorder, 2)
	go func() {
		results <- integrationRequest(s, "PATCH", "/pages/a", token, map[string]any{"parentId": "b", "revision": 1})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		results <- integrationRequest(s, "PATCH", "/pages/b", token, map[string]any{"parentId": "a", "revision": 1})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	requireStatus(t, awaitAuthorizationResponse(t, results), 200)
	requireStatus(t, awaitAuthorizationResponse(t, results), 404)
	var cycle bool
	if err := s.pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM pages a JOIN pages b ON a.parent_id=b.id AND b.parent_id=a.id)`).Scan(&cycle); err != nil || cycle {
		t.Fatalf("cycle=%v err=%v", cycle, err)
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/a", token, map[string]any{"archived": true}), 200)

}

type gatedUploadBody struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
	reader  io.Reader
}

func (b *gatedUploadBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started); <-b.release })
	return b.reader.Read(p)
}
func (b *gatedUploadBody) Close() error { return nil }

type reviewUpload struct{ UploadURL, AssetURL, CompleteURL, ObjectKey, UploadID string }

func createReviewUpload(t *testing.T, s *Server, token, pageID, content string) reviewUpload {
	t.Helper()
	response := integrationRequest(s, "POST", "/attachments/presign", token, map[string]any{"pageId": pageID, "fileName": "note.txt", "contentType": "text/plain", "kind": "file", "size": len(content)})
	requireStatus(t, response, 201)
	var upload reviewUpload
	if err := json.Unmarshal(response.Body.Bytes(), &upload); err != nil {
		t.Fatal(err)
	}
	return upload
}
func TestIntegrationConcurrentUploadPreservesSuccessfulFile(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "page"}), 201)
	const content = "a successful attachment"
	upload := createReviewUpload(t, s, token, "page", content)
	first, second := &gatedUploadBody{make(chan struct{}), make(chan struct{}), sync.Once{}, strings.NewReader(content)}, &gatedUploadBody{make(chan struct{}), make(chan struct{}), sync.Once{}, strings.NewReader(content)}
	run := func(body *gatedUploadBody) <-chan *httptest.ResponseRecorder {
		out := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			request := httptest.NewRequest("PUT", upload.UploadURL, body)
			request.ContentLength = int64(len(content))
			response := httptest.NewRecorder()
			s.ServeHTTP(response, request)
			out <- response
		}()
		return out
	}
	one, two := run(first), run(second)
	select {
	case <-first.started:
	case <-time.After(3 * time.Second):
		t.Fatal("first body not reached")
	}
	select {
	case <-second.started:
	case <-time.After(3 * time.Second):
		t.Fatal("second body not reached")
	}
	close(first.release)
	requireStatus(t, awaitAuthorizationResponse(t, one), 204)
	assetPath := strings.TrimPrefix(upload.AssetURL, "http://localhost/v1")
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 200)
	close(second.release)
	requireStatus(t, awaitAuthorizationResponse(t, two), 409)
	download := integrationRequest(s, "GET", assetPath, token, nil)
	requireStatus(t, download, 200)
	if download.Body.String() != content {
		t.Fatalf("successful object changed: %q", download.Body.String())
	}
	var uploaded bool
	if err := s.pool.QueryRow(context.Background(), `SELECT uploaded_at IS NOT NULL FROM attachments WHERE id=$1`, upload.UploadID).Scan(&uploaded); err != nil || !uploaded {
		t.Fatalf("completed metadata: %v %v", uploaded, err)
	}
	path, _ := s.attachmentPath(upload.ObjectKey)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("successful object missing: %v", err)
	}

}

func TestIntegrationCopiedAttachmentSurvivesSourceDeletion(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	const content = "file retained in copied page"
	upload := createReviewUpload(t, s, token, "source", content)
	request := httptest.NewRequest("PUT", upload.UploadURL, strings.NewReader(content))
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	requireStatus(t, response, 204)
	blocks := []any{map[string]any{"id": "file", "type": "file", "props": map[string]any{"url": upload.AssetURL, "name": "note.txt"}}}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/source", token, map[string]any{"blocks": blocks}), 200)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "copy", "blocks": blocks}), 201)
	assetPath := strings.TrimPrefix(upload.AssetURL, "http://localhost/v1")
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/copy", token, nil), 200)
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/copy?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 404)
	path, _ := s.attachmentPath(upload.ObjectKey)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("last page deletion left file: %v", err)
	}
}

func uploadReviewContent(t *testing.T, s *Server, token, pageID string) (reviewUpload, string, json.RawMessage) {
	t.Helper()
	const content = "attachment retained by the copied resource"
	upload := createReviewUpload(t, s, token, pageID, content)
	request := httptest.NewRequest("PUT", upload.UploadURL, strings.NewReader(content))
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	requireStatus(t, response, 204)
	blocks, _ := json.Marshal([]any{map[string]any{"id": "file", "type": "file", "props": map[string]any{"url": upload.AssetURL, "name": "note.txt"}}})
	return upload, strings.TrimPrefix(upload.AssetURL, "http://localhost/v1"), blocks
}

func TestIntegrationCopiedAttachmentUsesDestinationACL(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	copier, copyToken := integrationUser(t, s)
	viewer, viewerToken := integrationUser(t, s)
	_, stranger := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "source"}), 201)
	upload, path, blocks := uploadReviewContent(t, s, owner, "source")
	// A raw URL plus a valid token is insufficient without source read access.
	requireStatus(t, integrationRequest(s, "POST", "/pages", stranger, map[string]any{"id": "forged", "blocks": blocks}), 403)
	requireStatus(t, integrationRequest(s, "GET", "/pages/forged", stranger, nil), 404)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/source/shares/"+copier.ID.String(), owner, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "POST", "/pages", copyToken, map[string]any{"id": "copy", "blocks": blocks}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/copy/shares/"+viewer.ID.String(), copyToken, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/pages/source", viewerToken, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", path, viewerToken, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source/shares/"+copier.ID.String(), owner, nil), 204)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/copy", copyToken, map[string]any{"blocks": blocks}), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/attachments/"+upload.UploadID, owner, nil), 409)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, viewerToken, nil), 200)
	requireStatus(t, integrationRequest(s, "GET", path, stranger, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", path, "", nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/copy", copyToken, map[string]any{"settings": map[string]any{"publicAccess": true}}), 200)
	requireStatus(t, integrationRequest(s, "GET", path, "", nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/copy", copyToken, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, "", nil), 404)
	requireStatus(t, integrationRequest(s, "GET", path, viewerToken, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", path, copyToken, nil), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/copy", copyToken, map[string]any{"archived": false}), 200)
	requireStatus(t, integrationRequest(s, "GET", path, viewerToken, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/copy?hard=true", copyToken, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, owner, nil), 404)
}

func TestIntegrationAttachmentCopyDeleteOrdering(t *testing.T) {
	for _, copyFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "copy first", false: "delete first"}[copyFirst], func(t *testing.T) {
			s := integrationServer(t)
			_, owner := integrationUser(t, s)
			copier, token := integrationUser(t, s)
			requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "source"}), 201)
			_, path, blocks := uploadReviewContent(t, s, owner, "source")
			requireStatus(t, integrationRequest(s, "PUT", "/pages/source/shares/"+copier.ID.String(), owner, map[string]any{"permission": "view"}), 200)
			requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "copy"}), 201)
			trigger := `CREATE TRIGGER pause_copy BEFORE INSERT ON attachment_references FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`
			if !copyFirst {
				trigger = `CREATE TRIGGER pause_delete BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`
			}
			release := pauseAuthorizationWrite(t, s, trigger)
			copied, deleted := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
			copyRequest := func() {
				copied <- integrationRequest(s, "PATCH", "/pages/copy", token, map[string]any{"blocks": blocks})
			}
			deleteRequest := func() { deleted <- integrationRequest(s, "DELETE", "/pages/source?hard=true", owner, nil) }
			if copyFirst {
				go copyRequest()
			} else {
				go deleteRequest()
			}
			waitForBlockedQueries(t, s.pool, 1)
			if copyFirst {
				go deleteRequest()
			} else {
				go copyRequest()
			}
			waitForBlockedQueries(t, s.pool, 2)
			release()
			requireStatus(t, awaitAuthorizationResponse(t, deleted), 204)
			if copyFirst {
				requireStatus(t, awaitAuthorizationResponse(t, copied), 200)
				requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
			} else {
				requireStatus(t, awaitAuthorizationResponse(t, copied), 403)
				value := responseData[page](t, integrationRequest(s, "GET", "/pages/copy", token, nil))
				if strings.Contains(string(value.Blocks), "assetToken") {
					t.Fatal("failed copy saved dangling attachment")
				}
			}
		})
	}
}

func TestIntegrationRemovedCopiedBlockCanBeUndone(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	_, path, blocks := uploadReviewContent(t, s, token, "source")
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "copy", "blocks": blocks}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/copy/blocks", token, map[string]any{"blocks": []any{}}), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/copy/blocks", token, map[string]any{"blocks": blocks}), 200)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/copy?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 404)
}

func TestIntegrationCopiedAttachmentResourceLifetimes(t *testing.T) {
	for _, kind := range []string{"home", "preset", "database"} {
		t.Run(kind, func(t *testing.T) {
			s := integrationServer(t)
			_, owner := integrationUser(t, s)
			copier, token := integrationUser(t, s)
			_, other := integrationUser(t, s)
			requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "source"}), 201)
			_, path, blocks := uploadReviewContent(t, s, owner, "source")
			requireStatus(t, integrationRequest(s, "PUT", "/pages/source/shares/"+copier.ID.String(), owner, map[string]any{"permission": "view"}), 200)
			switch kind {
			case "home":
				requireStatus(t, integrationRequest(s, "PUT", "/home", token, map[string]any{"blocks": blocks}), 200)
			case "preset":
				requireStatus(t, integrationRequest(s, "POST", "/presets", token, map[string]any{"id": "copy", "name": "Copy", "icon": "x", "pageTitle": "Copy", "blocks": blocks}), 201)
			case "database":
				requireStatus(t, integrationRequest(s, "PUT", "/databases/copy", token, map[string]any{"state": map[string]any{"blocks": blocks}}), 201)
			}
			requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", owner, nil), 204)
			requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
			requireStatus(t, integrationRequest(s, "GET", path, other, nil), 404)
			requireStatus(t, integrationRequest(s, "GET", path, "", nil), 404)
			if kind == "preset" {
				requireStatus(t, integrationRequest(s, "DELETE", "/presets/copy", token, nil), 204)
			}
			if kind == "database" {
				requireStatus(t, integrationRequest(s, "DELETE", "/databases/copy", token, nil), 204)
			}
			if kind != "home" {
				requireStatus(t, integrationRequest(s, "GET", path, token, nil), 404)
			}
		})
	}
}

func TestIntegrationAttachmentDeleteRollbackAndCleanupRetry(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	upload, path, _ := uploadReviewContent(t, s, token, "source")
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `CREATE FUNCTION reject_page_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$; CREATE TRIGGER reject_delete BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION reject_page_delete()`); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 500)
	requireStatus(t, integrationRequest(s, "GET", "/pages/source", token, nil), 200)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
	if _, err := s.pool.Exec(ctx, `DROP TRIGGER reject_delete ON pages; UPDATE attachments SET storage_backend='minio'`); err != nil {
		t.Fatal(err)
	}
	// Missing object storage must not undo success or suppress page.deleted.
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	socket := openIntegrationSocket(t, httpServer.URL, "source", token)
	defer socket.Close()
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 204)
	readIntegrationEvent(t, socket, "page.deleted")
	var queued int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM attachment_object_deletions`).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("queued=%d err=%v", queued, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE attachment_object_deletions SET storage_backend='local'`); err != nil {
		t.Fatal(err)
	}
	if err := s.cleanupDeletedAttachmentObjects(ctx); err != nil {
		t.Fatal(err)
	}
	objectPath, _ := s.attachmentPath(upload.ObjectKey)
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("retry left object: %v", err)
	}
}

func TestIntegrationLegacyPageCycleTerminatesAndCanBeRepaired(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	for _, id := range []string{"a", "b"} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": id}), 201)
	}
	if _, err := s.pool.Exec(context.Background(), `UPDATE pages SET parent_id=CASE id WHEN 'a' THEN 'b' ELSE 'a' END WHERE id IN ('a','b')`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r := httptest.NewRequest("PATCH", "/v1/pages/a", strings.NewReader(`{"order":3}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	s.ServeHTTP(response, r)
	requireStatus(t, response, 404)
	if ctx.Err() != nil {
		t.Fatal("legacy cycle exhausted query deadline")
	}
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "c", "parentId": "a"}), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/a", token, map[string]any{"parentId": nil}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/b", token, map[string]any{"order": 4}), 200)
}

func TestIntegrationBrokenAttachmentAndOrdinaryURLsDoNotBlockEditing(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	upload, path, blocks := uploadReviewContent(t, s, token, "source")
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "legacy"}), 201)
	// Simulate a pre-migration broken reference without granting it any ACL.
	if _, err := s.pool.Exec(context.Background(), `UPDATE pages SET blocks_json=$1 WHERE id='legacy'`, blocks); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/legacy", token, map[string]any{"title": "Still editable", "blocks": blocks}), 200)
	ordinary := []any{map[string]any{"type": "paragraph", "content": upload.AssetURL}}
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "text", "blocks": ordinary}), 201)
	var value []map[string]any
	if err := json.Unmarshal(blocks, &value); err != nil {
		t.Fatal(err)
	}
	value[0]["props"].(map[string]any)["url"] = strings.Replace(upload.AssetURL, "http://localhost", "https://example.invalid", 1)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "external", "blocks": value}), 201)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "broken-copy", "blocks": blocks}), 403)
}

func TestIntegrationRealtimeAttachmentCopyRegistersReference(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	_, path, blocks := uploadReviewContent(t, s, token, "source")
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "copy"}), 201)
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	socket := openIntegrationSocket(t, httpServer.URL, "copy", token)
	defer socket.Close()
	if err := websocket.JSON.Send(socket, map[string]any{"type": "page.blocks.patch", "blocks": blocks, "changedBlockIds": []string{"file"}, "structural": true, "mutationId": "copy-attachment"}); err != nil {
		t.Fatal(err)
	}
	event := readIntegrationEvent(t, socket, "page.updated")
	if event.MutationID != "copy-attachment" {
		t.Fatalf("wrong ACK: %+v", event)
	}
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/source?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/copy?hard=true", token, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", path, token, nil), 404)
}

func TestIntegrationAttachmentMigrationBackfillsAuthorizedResources(t *testing.T) {
	pool := integrationPool(t, false)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_initial.sql", "002_notifications_home_minio.sql", "003_operational_indexes.sql", "004_user_scoped_presets_tags.sql"} {
		script, err := os.ReadFile(filepath.Join("..", "database", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(script)); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	owner, stranger, attachmentID := uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{owner, stranger} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,name,email,role,status,password_hash) VALUES($1,'Test',$2,'member','approved','test')`, id, id.String()+"@example.invalid"); err != nil {
			t.Fatal(err)
		}
	}
	assetURL := "/api/attachments/" + attachmentID.String() + "/content?assetToken=" + strings.Repeat("a", 64)
	blocks, _ := json.Marshal([]any{map[string]any{"id": "image", "type": "image", "props": map[string]any{"url": assetURL}}})
	text, _ := json.Marshal([]any{map[string]any{"type": "paragraph", "content": assetURL}})
	for _, id := range []string{"source", "copy", "forged", "ordinary", "wrong-token"} {
		targetOwner, targetBlocks := owner, blocks
		if id == "forged" {
			targetOwner = stranger
		}
		if id == "ordinary" {
			targetBlocks = text
		}
		if id == "wrong-token" {
			targetBlocks = json.RawMessage(strings.ReplaceAll(string(blocks), strings.Repeat("a", 64), strings.Repeat("b", 64)))
		}
		if _, err := pool.Exec(ctx, `INSERT INTO pages(id,owner_id,title,blocks_json) VALUES($1,$2,$1,$3)`, id, targetOwner, targetBlocks); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO attachments(id,owner_id,page_id,file_name,content_type,kind,size_bytes,object_key,upload_token_hash,asset_token_hash,uploaded_at) VALUES($1,$2,'source','note.png','image/png','image',1,'test/key',$3,$4,now())`, attachmentID, owner, tokenHash("upload"), tokenHash(strings.Repeat("a", 64))); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO home_pages(user_id,blocks_json) VALUES($1,$2)`, owner, blocks); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO starter_presets(id,owner_id,name,icon,page_title,blocks_json) VALUES('copy',$1,'Copy','x','Copy',$2)`, owner, blocks); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var total, unsafe int
	if err := pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE page_id IN ('forged','ordinary','wrong-token')) FROM attachment_references`).Scan(&total, &unsafe); err != nil || total != 4 || unsafe != 0 {
		t.Fatalf("total=%d unsafe=%d err=%v", total, unsafe, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM pages WHERE id='source'`); err != nil {
		t.Fatal(err)
	}
	var allowed bool
	if err := pool.QueryRow(ctx, `SELECT attachment_readable($1,$2)`, attachmentID, owner).Scan(&allowed); err != nil || !allowed {
		t.Fatalf("backfill lost copy: allowed=%v err=%v", allowed, err)
	}
	if err := pool.QueryRow(ctx, `SELECT attachment_readable($1,$2)`, attachmentID, stranger).Scan(&allowed); err != nil || allowed {
		t.Fatalf("migration granted stranger access: %v %v", allowed, err)
	}
}

func TestIntegrationStaleCleanupCannotDeleteCompletingUpload(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	const content = "slow but successful upload"
	upload := createReviewUpload(t, s, token, "source", content)
	if _, err := s.pool.Exec(context.Background(), `UPDATE attachments SET created_at=now()-interval '25 hours' WHERE id=$1`, upload.UploadID); err != nil {
		t.Fatal(err)
	}
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_upload BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest("PUT", upload.UploadURL, strings.NewReader(content))
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		completed <- response
	}()
	// This is after publishing the file, before its uploaded_at transaction commits.
	waitForBlockedQueries(t, s.pool, 1)
	cleanup := make(chan error, 1)
	go func() { cleanup <- s.cleanupStaleAttachments(context.Background(), time.Now().Add(-24*time.Hour), 100) }()
	// The old cleanup read the pre-commit NULL and removed the published file,
	// then waited on DELETE. The fixed cleanup skips this locked upload entirely.
	select {
	case err := <-cleanup:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		release()
		<-cleanup
		t.Fatal("stale cleanup waited on an upload instead of skipping it")
	}
	release()
	requireStatus(t, awaitAuthorizationResponse(t, completed), 204)
	response := integrationRequest(s, "GET", strings.TrimPrefix(upload.AssetURL, "http://localhost/v1"), token, nil)
	requireStatus(t, response, 200)
	if response.Body.String() != content {
		t.Fatal("cleanup changed the successful upload")
	}
}

func TestIntegrationStaleCleanupWinsBeforeUploadPublishes(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
	const content = "upload expired during streaming"
	upload := createReviewUpload(t, s, token, "source", content)
	if _, err := s.pool.Exec(context.Background(), `UPDATE attachments SET created_at=now()-interval '25 hours' WHERE id=$1`, upload.UploadID); err != nil {
		t.Fatal(err)
	}
	body := &gatedUploadBody{make(chan struct{}), make(chan struct{}), sync.Once{}, strings.NewReader(content)}
	completed := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest("PUT", upload.UploadURL, body)
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		completed <- response
	}()
	select {
	case <-body.started:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not start")
	}
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_cleanup BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	cleanup := make(chan error, 1)
	go func() { cleanup <- s.cleanupStaleAttachments(context.Background(), time.Now().Add(-24*time.Hour), 100) }()
	waitForBlockedQueries(t, s.pool, 1)
	close(body.release)
	waitForBlockedQueries(t, s.pool, 2)
	release()
	if err := <-cleanup; err != nil {
		t.Fatal(err)
	}
	requireStatus(t, awaitAuthorizationResponse(t, completed), 404)
	objectPath, _ := s.attachmentPath(upload.ObjectKey)
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("expired upload left a published object: %v", err)
	}
}
