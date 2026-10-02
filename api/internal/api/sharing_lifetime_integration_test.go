package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func requireNoRealtimeData(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var event pageRealtimeEvent
		if err := websocket.JSON.Receive(conn, &event); err != nil {
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatal("unauthorized realtime connection remained open")
			}
			return
		}
		if event.Page != nil || event.Database != nil {
			t.Fatalf("unauthorized connection received private data: %+v", event)
		}
	}
}

func TestIntegrationDatabaseMutationsRecheckPageAccess(t *testing.T) {
	for _, changeKind := range []string{"revoke", "downgrade", "lock"} {
		for _, method := range []string{"PUT", "DELETE", "create"} {
			t.Run(changeKind+"/"+method, func(t *testing.T) {
				s := integrationServer(t)
				_, owner := integrationUser(t, s)
				member, token := integrationUser(t, s)
				requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared"}), 201)
				requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "shared", "state": map[string]any{"value": "Original"}}), 201)
				share := "/pages/shared/shares/" + member.ID.String()
				requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
				trigger := `CREATE TRIGGER pause_share BEFORE UPDATE OR DELETE ON page_shares FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`
				if changeKind == "lock" {
					trigger = `CREATE TRIGGER pause_page BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`
				}
				release := pauseAuthorizationWrite(t, s, trigger)
				defer release()
				change, edit := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
				go func() {
					switch changeKind {
					case "revoke":
						change <- integrationRequest(s, "DELETE", share, owner, nil)
					case "downgrade":
						change <- integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "view"})
					case "lock":
						change <- integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"settings": map[string]any{"lockPage": true}})
					}
				}()
				waitForBlockedQueries(t, s.pool, 1)
				go func() {
					requestMethod, path := method, "/databases/db"
					if method == "create" {
						requestMethod, path = "PUT", "/databases/new-db"
					}
					edit <- integrationRequest(s, requestMethod, path, token, map[string]any{"pageId": "shared", "state": map[string]any{"value": "Unauthorized"}})
				}()
				waitForBlockedQueries(t, s.pool, 2)
				release()
				changeStatus, editStatus := 200, 403
				if changeKind == "revoke" {
					changeStatus, editStatus = 204, 404
				}
				if changeKind == "lock" {
					editStatus = 423
				}
				requireStatus(t, awaitAuthorizationResponse(t, change), changeStatus)
				requireStatus(t, awaitAuthorizationResponse(t, edit), editStatus)
				value := responseData[inlineDatabase](t, integrationRequest(s, "GET", "/databases/db", owner, nil))
				if !strings.Contains(string(value.State), "Original") || value.Revision != 1 {
					t.Fatalf("rejected DB mutation changed original: %+v", value)
				}
				requireStatus(t, integrationRequest(s, "GET", "/databases/new-db", owner, nil), 404)
			})
		}
	}
}

func TestIntegrationDatabaseMovesCheckBothPagesAndOwnership(t *testing.T) {
	s := integrationServer(t)
	ownerUser, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	for _, id := range []string{"source", "target"} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": id}), 201)
	}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "source", "state": map[string]any{"name": "Original"}}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/source/shares/"+member.ID.String(), owner, map[string]any{"permission": "edit"}), 200)
	move := map[string]any{"pageId": "target", "state": map[string]any{"name": "Moved"}, "revision": 1}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", token, move), 404)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/target/shares/"+member.ID.String(), owner, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", token, move), 403)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/target/shares/"+member.ID.String(), owner, map[string]any{"permission": "edit"}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/target", owner, map[string]any{"settings": map[string]any{"lockPage": true}}), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", token, move), 423)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/target", owner, map[string]any{"settings": map[string]any{"lockPage": false}}), 200)
	moved := integrationRequest(s, "PUT", "/databases/db", token, move)
	requireStatus(t, moved, 200)
	value := responseData[inlineDatabase](t, moved)
	if value.OwnerID != ownerUser.ID || value.PageID == nil || *value.PageID != "target" || value.Revision != 2 {
		t.Fatalf("move changed ownership or revision: %+v", value)
	}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": nil, "state": map[string]any{"name": "Detached"}, "revision": 2}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/databases/db", token, nil), 404)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", token, map[string]any{"state": map[string]any{}}), 404)
	requireStatus(t, integrationRequest(s, "DELETE", "/databases/db", token, nil), 404)
	requireStatus(t, integrationRequest(s, "GET", "/databases/db", owner, nil), 200)
}

func TestIntegrationConcurrentDatabaseMoveRechecksNewPage(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	for _, id := range []string{"source", "private"} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": id}), 201)
	}
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "source", "state": map[string]any{"name": "Original"}}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/source/shares/"+member.ID.String(), owner, map[string]any{"permission": "edit"}), 200)
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_move BEFORE UPDATE ON inline_databases FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	defer release()
	move, edit := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		move <- integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "private", "state": map[string]any{"name": "Private"}})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		edit <- integrationRequest(s, "PUT", "/databases/db", token, map[string]any{"state": map[string]any{"name": "Stale access"}})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	requireStatus(t, awaitAuthorizationResponse(t, move), 200)
	requireStatus(t, awaitAuthorizationResponse(t, edit), 404)
	value := responseData[inlineDatabase](t, integrationRequest(s, "GET", "/databases/db", owner, nil))
	if value.PageID == nil || *value.PageID != "private" || !strings.Contains(string(value.State), "Private") {
		t.Fatalf("queued update lost move: %+v", value)
	}
}

func TestIntegrationDatabaseMoveAndParentDeletionLockOrder(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "z-parent"}), 201)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "a-child", "parentId": "z-parent"}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "z-parent", "state": map[string]any{}}), 201)
	ctx := context.Background()
	gate, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(ctx)
	if _, err = gate.Exec(ctx, `SELECT id FROM pages WHERE id='z-parent' FOR NO KEY UPDATE`); err != nil {
		t.Fatal(err)
	}
	move, remove := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		move <- integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "a-child", "state": map[string]any{"name": "Preserved"}})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() { remove <- integrationRequest(s, "DELETE", "/pages/z-parent?hard=true", owner, nil) }()
	waitForBlockedQueries(t, s.pool, 2)
	if err = gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, awaitAuthorizationResponse(t, move), 200)
	requireStatus(t, awaitAuthorizationResponse(t, remove), 204)
	value := responseData[inlineDatabase](t, integrationRequest(s, "GET", "/databases/db", owner, nil))
	if value.PageID == nil || *value.PageID != "a-child" {
		t.Fatalf("parent cascade lost moved database: %+v", value)
	}
	child := responseData[page](t, integrationRequest(s, "GET", "/pages/a-child", owner, nil))
	if child.ParentID != nil {
		t.Fatal("deleted parent reference remained")
	}
}

func TestIntegrationRealtimeTerminalEventsContainNoPageData(t *testing.T) {
	for _, mode := range []string{"archive", "delete"} {
		t.Run(mode, func(t *testing.T) {
			s := integrationServer(t)
			_, owner := integrationUser(t, s)
			member, token := integrationUser(t, s)
			requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "title": "Private title", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Private"}]`)}), 201)
			requireStatus(t, integrationRequest(s, "PUT", "/pages/shared/shares/"+member.ID.String(), owner, map[string]any{"permission": "view"}), 200)
			srv := httptest.NewServer(s)
			defer srv.Close()
			conn := openIntegrationSocket(t, srv.URL, "shared", token)
			defer conn.Close()
			path, kind := "/pages/shared", "page.archived"
			if mode == "delete" {
				path, kind = path+"?hard=true", "page.deleted"
			}
			requireStatus(t, integrationRequest(s, "DELETE", path, owner, nil), 204)
			event := readIntegrationEvent(t, conn, kind)
			if event.Page != nil || event.Database != nil {
				t.Fatalf("terminal event exposed page data: %+v", event)
			}
		})
	}
}

type pausedRealtimeUpgrade struct {
	http.ResponseWriter
	entered chan struct{}
	release chan struct{}
}

func (w pausedRealtimeUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	close(w.entered)
	<-w.release
	return w.ResponseWriter.(http.Hijacker).Hijack()
}

func TestIntegrationRevocationDuringRealtimeUpgrade(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
	share := "/pages/shared/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeHTTP(pausedRealtimeUpgrade{w, entered, release}, r)
	}))
	defer srv.Close()
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	cfg, err := websocket.NewConfig("ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/pages/shared/realtime", "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Header = http.Header{"Authorization": []string{"Bearer " + token}}
	type outcome struct {
		conn *websocket.Conn
		err  error
	}
	connected := make(chan outcome, 1)
	go func() { conn, err := websocket.DialConfig(cfg); connected <- outcome{conn, err} }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("upgrade did not pause")
	}
	requireStatus(t, integrationRequest(s, "DELETE", share, owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/shared", token, nil), 404)
	close(release)
	released = true
	var conn *websocket.Conn
	select {
	case result := <-connected:
		if result.err != nil {
			t.Fatal(result.err)
		}
		conn = result.conn
	case <-time.After(3 * time.Second):
		t.Fatal("upgrade did not complete")
	}
	defer conn.Close()
	requireNoRealtimeData(t, conn)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Private after completed revocation"}]`)}), 200)

}

func TestIntegrationRevocationWaitsForDatabaseWrite(t *testing.T) {
	for _, method := range []string{"PUT", "DELETE"} {
		t.Run(method, func(t *testing.T) {
			s := integrationServer(t)
			_, owner := integrationUser(t, s)
			member, token := integrationUser(t, s)
			requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared"}), 201)
			requireStatus(t, integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "shared", "state": map[string]any{"value": "Original"}}), 201)
			share := "/pages/shared/shares/" + member.ID.String()
			requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
			ctx := context.Background()
			gate, err := s.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(ctx)
			if _, err = gate.Exec(ctx, `SELECT id FROM inline_databases WHERE id='db' FOR UPDATE`); err != nil {
				t.Fatal(err)
			}
			edit := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				edit <- integrationRequest(s, method, "/databases/db", token, map[string]any{"state": map[string]any{"value": "Authorized before revocation"}})
			}()
			waitForBlockedQueries(t, s.pool, 1)
			revoke := make(chan *httptest.ResponseRecorder, 1)
			go func() { revoke <- integrationRequest(s, "DELETE", share, owner, nil) }()
			waitForBlockedQueries(t, s.pool, 2)
			if err = gate.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case response := <-edit:
				want := 200
				if method == "DELETE" {
					want = 204
				}
				requireStatus(t, response, want)
			case <-time.After(3 * time.Second):
				t.Fatal("queued database write did not finish")
			}
			requireStatus(t, awaitAuthorizationResponse(t, revoke), 204)
			requireStatus(t, integrationRequest(s, "GET", "/databases/db", token, nil), 404)
			if method == "PUT" {
				value := responseData[inlineDatabase](t, integrationRequest(s, "GET", "/databases/db", owner, nil))
				if !strings.Contains(string(value.State), "Authorized before revocation") {
					t.Fatalf("not reproduced: %s", value.State)
				}
			} else {
				requireStatus(t, integrationRequest(s, "GET", "/databases/db", owner, nil), 404)
			}

		})
	}
}

func TestIntegrationRevokedShareCannotReadOtherInstanceBroadcast(t *testing.T) {
	s := integrationServer(t)
	s2, err := NewServer(s.pool, s.config)
	if err != nil {
		t.Fatal(err)
	}
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
	share := "/pages/shared/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
	srv := httptest.NewServer(s)
	defer srv.Close()
	conn := openIntegrationSocket(t, srv.URL, "shared", token)
	defer conn.Close()
	requireStatus(t, integrationRequest(s2, "DELETE", share, owner, nil), 204)
	requireStatus(t, integrationRequest(s, "GET", "/pages/shared", token, nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Private content after revocation"}]`)}), 200)
	requireNoRealtimeData(t, conn)
}

func TestIntegrationRealtimeSnapshotRefreshesAfterUpgrade(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "title": "Before upgrade"}), 201)
	share := "/pages/shared/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeHTTP(pausedRealtimeUpgrade{w, entered, release}, r)
	}))
	defer srv.Close()
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	cfg, err := websocket.NewConfig("ws"+strings.TrimPrefix(srv.URL, "http")+"/v1/pages/shared/realtime", "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Header = http.Header{"Authorization": []string{"Bearer " + token}}
	type outcome struct {
		conn *websocket.Conn
		err  error
	}
	connected := make(chan outcome, 1)
	go func() { conn, err := websocket.DialConfig(cfg); connected <- outcome{conn, err} }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("upgrade did not pause")
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"title": "Latest title"}), 200)
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "view"}), 200)
	close(release)
	released = true
	var conn *websocket.Conn
	select {
	case result := <-connected:
		if result.err != nil {
			t.Fatal(result.err)
		}
		conn = result.conn
	case <-time.After(3 * time.Second):
		t.Fatal("upgrade did not complete")
	}
	defer conn.Close()
	event := readIntegrationEvent(t, conn, "page.snapshot")
	if event.Page == nil || event.Page.Title != "Latest title" || event.Page.Permission != "view" || event.Page.Revision != 2 {
		t.Fatalf("snapshot retained pre-upgrade state: %+v", event)
	}
}

func TestIntegrationDatabaseAndRealtimeUseOnePoolConnection(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "single"}), 201)
	singleConnectionServer(t, s)
	srv := httptest.NewServer(s)
	defer srv.Close()
	conn := openIntegrationSocket(t, srv.URL, "single", owner)
	defer conn.Close()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"pageId": "single", "state": map[string]any{"name": "Created"}})
	}()
	requireStatus(t, awaitAuthorizationResponse(t, result), 201)
	event := readIntegrationEvent(t, conn, "database.updated")
	if event.Database == nil || event.Database.Revision != 1 {
		t.Fatalf("missing create broadcast: %+v", event)
	}
	go func() {
		result <- integrationRequest(s, "PUT", "/databases/db", owner, map[string]any{"state": map[string]any{"name": "Updated"}, "revision": 1})
	}()
	requireStatus(t, awaitAuthorizationResponse(t, result), 200)
	event = readIntegrationEvent(t, conn, "database.updated")
	if event.Database == nil || event.Database.Revision != 2 {
		t.Fatalf("missing update broadcast: %+v", event)
	}
	go func() { result <- integrationRequest(s, "DELETE", "/databases/db", owner, nil) }()
	requireStatus(t, awaitAuthorizationResponse(t, result), 204)
	readIntegrationEvent(t, conn, "database.deleted")
}

type pausedRealtimeFrame struct {
	net.Conn
	armed, entered, release chan struct{}
	once                    sync.Once
}

func (c *pausedRealtimeFrame) Write(value []byte) (int, error) {
	select {
	case <-c.armed:
		c.once.Do(func() { close(c.entered); <-c.release })
	default:
	}
	return c.Conn.Write(value)
}

type pausedRealtimeFrameWriter struct {
	http.ResponseWriter
	frame *pausedRealtimeFrame
}

func (w pausedRealtimeFrameWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.frame.Conn = conn
	return w.frame, bufio.NewReadWriter(rw.Reader, bufio.NewWriter(w.frame)), nil
}

func TestIntegrationRevocationWaitsForAuthorizedRealtimeFrame(t *testing.T) {
	s := integrationServer(t)
	other, err := NewServer(s.pool, s.config)
	if err != nil {
		t.Fatal(err)
	}
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared"}), 201)
	share := "/pages/shared/shares/" + member.ID.String()
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
