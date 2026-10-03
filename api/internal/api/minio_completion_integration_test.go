package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
)

func TestIntegrationMinIOCompletionCleanupOrdering(t *testing.T) {
	for _, first := range []string{"completion", "cleanup"} {
		t.Run(first, func(t *testing.T) {
			s := integrationServer(t)
			_, token := integrationUser(t, s)
			requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "source"}), 201)
			upload := createReviewUpload(t, s, token, "source", "content")
			ctx := context.Background()
			if _, err := s.pool.Exec(ctx, `UPDATE attachments SET storage_backend='minio',created_at=now()-interval '25 hours' WHERE id=$1`, upload.UploadID); err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "HEAD" {
					if first == "completion" {
						close(entered)
						<-release
					}
					w.Header().Set("Content-Length", "7")
					w.Header().Set("Content-Type", "text/plain")
					w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
					w.Header().Set("ETag", `"test"`)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer storage.Close()
			defer unblock()
			var err error
			s.minio, err = minio.New(strings.TrimPrefix(storage.URL, "http://"), &minio.Options{Secure: false, Region: "us-east-1"})
			if err != nil {
				t.Fatal(err)
			}
			s.config.MinIOBucket = "test-bucket"
			completed := make(chan *httptest.ResponseRecorder, 1)
			complete := func() {
				completed <- integrationRequest(s, "POST", "/attachments/"+upload.UploadID+"/complete", token, map[string]any{"objectKey": upload.ObjectKey, "uploadId": upload.UploadID, "fileName": "note.txt", "contentType": "text/plain", "kind": "file", "size": 7})
			}
			cleanup := make(chan error, 1)
			clean := func() { cleanup <- s.cleanupStaleAttachments(ctx, time.Now().Add(-24*time.Hour), 100) }
			if first == "completion" {
				go complete()
				select {
				case <-entered:
				case <-time.After(3 * time.Second):
					t.Fatal("MinIO HEAD did not start")
				}
				go clean()
				select {
				case err := <-cleanup:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("cleanup did not skip active completion")
				}
				var exists bool
				if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM attachments WHERE id=$1)`, upload.UploadID).Scan(&exists); err != nil || !exists {
					t.Fatalf("cleanup removed completing upload: exists=%v err=%v", exists, err)
				}
				unblock()
				requireStatus(t, awaitAuthorizationResponse(t, completed), 200)
			} else {
				releaseCleanup := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_minio_cleanup BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
				defer releaseCleanup()
				go clean()
				waitForBlockedQueries(t, s.pool, 1)
				go complete()
				waitForBlockedQueries(t, s.pool, 2)
				releaseCleanup()
				if err := <-cleanup; err != nil {
					t.Fatal(err)
				}
				requireStatus(t, awaitAuthorizationResponse(t, completed), 404)
			}
		})
	}
}
