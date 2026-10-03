package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

func createSharedTree(t *testing.T, s *Server, owner string) {
	t.Helper()
	for _, p := range []struct{ id, parent string }{{"root", ""}, {"child", "root"}, {"grandchild", "child"}, {"private", ""}} {
		input := map[string]any{"id": p.id, "title": p.id, "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}
		if p.parent != "" {
			input["parentId"] = p.parent
		}
		requireStatus(t, integrationRequest(s, "POST", "/pages", owner, input), 201)
	}
}

func TestIntegrationInheritedSharingAccess(t *testing.T) {
	s := integrationServer(t)
	ownerUser, owner := integrationUser(t, s)
	member, editor := integrationUser(t, s)
	viewerUser, viewer := integrationUser(t, s)
	_, stranger := integrationUser(t, s)
	createSharedTree(t, s, owner)
	for _, grant := range []struct {
		id         uuid.UUID
		permission string
	}{{member.ID, "edit"}, {viewerUser.ID, "view"}} {
		requireStatus(t, integrationRequest(s, "PUT", "/pages/root/shares/"+grant.id.String(), owner, map[string]any{"permission": grant.permission}), 200)
	}
	for _, id := range []string{"child", "grandchild"} {
		for _, account := range []struct{ token, permission string }{{editor, "edit"}, {viewer, "view"}, {owner, "owner"}} {
			response := integrationRequest(s, "GET", "/pages/"+id, account.token, nil)
			requireStatus(t, response, 200)
			if got := responseData[page](t, response).Permission; got != account.permission {
				t.Fatalf("permission=%s want=%s", got, account.permission)
			}
		}
		requireStatus(t, integrationRequest(s, "GET", "/pages/"+id, stranger, nil), 404)
		requireStatus(t, integrationRequest(s, "GET", "/public/pages/"+id, "", nil), 404)
		requireStatus(t, integrationRequest(s, "PATCH", "/pages/"+id, viewer, map[string]any{"title": "Denied"}), 403)
	}
	pages := responseData[[]page](t, integrationRequest(s, "GET", "/pages?includeBlocks=true", editor, nil))
	if len(pages) != 3 {
		t.Fatalf("inherited list=%+v", pages)
	}
	search := responseData[[]page](t, integrationRequest(s, "GET", "/search?q=grandchild", editor, nil))
	if len(search) != 1 || search[0].ID != "grandchild" {
		t.Fatalf("inherited search=%+v", search)
	}
	type shareMember struct {
		User                authUser `json:"user"`
		Permission          string   `json:"permission"`
		InheritedFromPageID string   `json:"inheritedFromPageId"`
	}
	type shareRecord struct {
		PageID  string        `json:"pageId"`
		Members []shareMember `json:"members"`
	}
	shares := responseData[[]shareRecord](t, integrationRequest(s, "GET", "/shares", editor, nil))
	if len(shares) != 3 {
		t.Fatalf("inherited shares=%+v", shares)
	}
	child := responseData[shareRecord](t, integrationRequest(s, "GET", "/pages/child/shares", owner, nil))
	if len(child.Members) != 2 || child.Members[0].InheritedFromPageID != "root" {
		t.Fatalf("inherited metadata=%+v", child)
	}
	created := integrationRequest(s, "POST", "/pages", editor, map[string]any{"id": "member-child", "parentId": "grandchild", "title": "Member child"})
	requireStatus(t, created, 201)
	value := responseData[page](t, created)
	if value.OwnerID != ownerUser.ID || value.Permission != "edit" {
		t.Fatalf("child escaped shared ownership: %+v", value)
	}
	requireStatus(t, integrationRequest(s, "GET", "/pages/member-child", viewer, nil), 200)
	requireStatus(t, integrationRequest(s, "POST", "/pages", viewer, map[string]any{"id": "viewer-child", "parentId": "root"}), 403)
	requireStatus(t, integrationRequest(s, "POST", "/pages", editor, map[string]any{"id": "public-child", "parentId": "root", "settings": map[string]any{"publicAccess": true}}), 403)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/member-child/shares/"+viewerUser.ID.String(), editor, map[string]any{"permission": "edit"}), 403)
	var copied int
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM page_shares WHERE page_id<>'root'`).Scan(&copied); err != nil || copied != 0 {
		t.Fatalf("grants were copied: %d %v", copied, err)
	}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/child-db", editor, map[string]any{"pageId": "child", "state": map[string]any{"name": "Inherited"}}), 201)
	requireStatus(t, integrationRequest(s, "GET", "/databases/child-db", viewer, nil), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/child-db", viewer, map[string]any{"state": map[string]any{}}), 403)
	requireStatus(t, integrationRequest(s, "POST", "/pages/child/comments", editor, map[string]any{"id": "child-thread", "blockId": "a", "body": "Inherited comment"}), 201)
	comments := integrationRequest(s, "GET", "/comments", viewer, nil)
	requireStatus(t, comments, 200)
	if !strings.Contains(comments.Body.String(), "Inherited comment") {
		t.Fatal("inherited comments missing")
	}
	notices := integrationRequest(s, "GET", "/notifications", viewer, nil)
	requireStatus(t, notices, 200)
	if !strings.Contains(notices.Body.String(), "child-thread") {
		t.Fatal("inherited comment notification missing")
	}
}

func TestIntegrationInheritedSharingGrantAndHierarchyChanges(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	createSharedTree(t, s, owner)
	rootShare := "/pages/root/shares/" + member.ID.String()
	childShare := "/pages/child/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", rootShare, owner, map[string]any{"permission": "edit"}), 200)
	requireStatus(t, integrationRequest(s, "PUT", childShare, owner, map[string]any{"permission": "view"}), 200)
	if responseData[page](t, integrationRequest(s, "GET", "/pages/grandchild", token, nil)).Permission != "edit" {
		t.Fatal("direct view reduced ancestor edit")
	}
	requireStatus(t, integrationRequest(s, "DELETE", rootShare, owner, nil), 204)
	if responseData[page](t, integrationRequest(s, "GET", "/pages/grandchild", token, nil)).Permission != "view" {
		t.Fatal("direct child grant lost")
	}
	requireStatus(t, integrationRequest(s, "DELETE", childShare, owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 404)
	requireStatus(t, integrationRequest(s, "PUT", rootShare, owner, map[string]any{"permission": "edit"}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/child", owner, map[string]any{"parentId": nil}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/child", owner, map[string]any{"parentId": "root"}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/root", owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/root", owner, map[string]any{"archived": false}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 200)
	requireStatus(t, integrationRequest(s, "DELETE", "/pages/root?hard=true", owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", token, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", "/pages/grandchild", owner, nil), 200)
}

func TestIntegrationQueuedDescendantWritesRespectAncestorSharing(t *testing.T) {
	for _, changeKind := range []string{"revoke", "downgrade"} {
		for _, operation := range []string{"patch", "database", "create", "websocket"} {
			t.Run(changeKind+"/"+operation, func(t *testing.T) {
				s := integrationServer(t)
				_, owner := integrationUser(t, s)
				member, token := integrationUser(t, s)
				createSharedTree(t, s, owner)
				share := "/pages/root/shares/" + member.ID.String()
				requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
				requireStatus(t, integrationRequest(s, "PUT", "/databases/child-db", owner, map[string]any{"pageId": "grandchild", "state": map[string]any{"name": "Original"}}), 201)
				srv := httptest.NewServer(s)
				defer srv.Close()
				var conn *websocket.Conn
				if operation == "websocket" {
					conn = openIntegrationSocket(t, srv.URL, "grandchild", token)
					defer conn.Close()
				}
				release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_ancestor_share BEFORE UPDATE OR DELETE ON page_shares FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
				defer release()
				change, edit := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
				go func() {
					if changeKind == "revoke" {
						change <- integrationRequest(s, "DELETE", share, owner, nil)
					} else {
						change <- integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "view"})
					}
				}()
				waitForBlockedQueries(t, s.pool, 1)
				if conn != nil {
					if err := websocket.JSON.Send(conn, map[string]any{"type": "page.blocks.patch", "mutationId": "queued", "changedBlockIds": []string{"a"}, "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Unauthorized"}]`)}); err != nil {
						t.Fatal(err)
					}
				} else {
					go func() {
						switch operation {
						case "patch":
							edit <- integrationRequest(s, "PATCH", "/pages/grandchild", token, map[string]any{"title": "Unauthorized"})
						case "database":
							edit <- integrationRequest(s, "PUT", "/databases/child-db", token, map[string]any{"state": map[string]any{"name": "Unauthorized"}})
						case "create":
							edit <- integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "queued-child", "parentId": "grandchild"})
						}
					}()
				}
				waitForBlockedQueries(t, s.pool, 2)
				release()
				status, want := 200, 403
				if changeKind == "revoke" {
					status, want = 204, 404
				}
				requireStatus(t, awaitAuthorizationResponse(t, change), status)
				if conn == nil {
					requireStatus(t, awaitAuthorizationResponse(t, edit), want)
				} else if changeKind == "revoke" {
					requireNoRealtimeData(t, conn)
				} else {
					readIntegrationEvent(t, conn, "permission.updated")
				}
				waitForAuthorizationQueries(t, s)
				got := responseData[page](t, integrationRequest(s, "GET", "/pages/grandchild", owner, nil))
				if got.Title != "grandchild" || strings.Contains(string(got.Blocks), "Unauthorized") {
					t.Fatalf("ancestor change lost: %+v", got)
				}
			})
		}
	}
}

func TestIntegrationAncestorRevocationWaitsForDescendantFrame(t *testing.T) {
	s := integrationServer(t)
	other, err := NewServer(s.pool, s.config)
	if err != nil {
		t.Fatal(err)
	}
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "root"}), 201)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "parentId": "root"}), 201)
	share := "/pages/root/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "view"}), 200)
	frame := &pausedRealtimeFrame{armed: make(chan struct{}), entered: make(chan struct{}), release: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeHTTP(pausedRealtimeFrameWriter{w, frame}, r)
	}))
	defer srv.Close()
	conn := openIntegrationSocket(t, srv.URL, "shared", token)
	defer conn.Close()
	readIntegrationEvent(t, conn, "presence.updated")
	released := false
	defer func() {
		if !released {
			close(frame.release)
		}
	}()
	close(frame.armed)
	edit, revoke := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		edit <- integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"title": "Authorized frame"})
	}()
	select {
	case <-frame.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("realtime frame did not pause")
	}
	go func() { revoke <- integrationRequest(other, "DELETE", share, owner, nil) }()
	waitForBlockedQueries(t, s.pool, 1)
	close(frame.release)
	released = true
	requireStatus(t, awaitAuthorizationResponse(t, edit), 200)
	requireStatus(t, awaitAuthorizationResponse(t, revoke), 204)
	readIntegrationEvent(t, conn, "page.updated")
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"title": "Private after revocation"}), 200)
	requireNoRealtimeData(t, conn)
}

func TestIntegrationInheritedAttachmentAccess(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	createSharedTree(t, s, owner)
	share := "/pages/root/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
	const content = "attachment in inherited child"
	upload := createReviewUpload(t, s, token, "grandchild", content)
	request := httptest.NewRequest("PUT", upload.UploadURL, strings.NewReader(content))
	request.ContentLength = int64(len(content))
	response := httptest.NewRecorder()
	s.ServeHTTP(response, request)
	requireStatus(t, response, 204)
	assetPath := strings.TrimPrefix(upload.AssetURL, "http://localhost/v1")
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 200)
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 200)
	requireStatus(t, integrationRequest(s, "POST", "/attachments/presign", token, map[string]any{"pageId": "grandchild", "fileName": "denied.txt", "contentType": "text/plain", "kind": "file", "size": 1}), 403)
	requireStatus(t, integrationRequest(s, "DELETE", share, owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", assetPath, token, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", assetPath, owner, nil), 200)
}
