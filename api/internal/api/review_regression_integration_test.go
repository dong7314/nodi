package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/net/websocket"
)

func openIntegrationSocket(t *testing.T, serverURL, pageID, token string) *websocket.Conn {
	t.Helper()
	cfg, err := websocket.NewConfig("ws"+strings.TrimPrefix(serverURL, "http")+"/v1/pages/"+pageID+"/realtime", "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Header = http.Header{"Authorization": []string{"Bearer " + token}}
	conn, err := websocket.DialConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	readIntegrationEvent(t, conn, "page.snapshot")
	return conn
}

func readIntegrationEvent(t *testing.T, conn *websocket.Conn, kind string) pageRealtimeEvent {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var event pageRealtimeEvent
		if err := websocket.JSON.Receive(conn, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == kind {
			return event
		}
	}
}

func requireClosedSocket(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var event pageRealtimeEvent
		err := websocket.JSON.Receive(conn, &event)
		if err != nil {
			var timeout net.Error
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatal("revoked socket remained open")
			}
			return
		}
		if event.Type == "page.updated" {
			t.Fatalf("revoked session received page data: %+v", event)
		}
	}
}

func TestIntegrationRealtimeSessionRevocation(t *testing.T) {
	for _, mode := range []string{"logout", "password", "rejected", "expired", "external-revocation"} {
		t.Run(mode, func(t *testing.T) {
			s := integrationServer(t)
			admin, owner := integrationUser(t, s)
			if _, err := s.pool.Exec(context.Background(), `UPDATE users SET role='admin' WHERE id=$1`, admin.ID); err != nil {
				t.Fatal(err)
			}
			member, token := integrationUser(t, s)
			password := strings.Repeat("a", 12)
			hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.pool.Exec(context.Background(), `UPDATE users SET password_hash=$1 WHERE id=$2`, string(hash), member.ID); err != nil {
				t.Fatal(err)
			}
			requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "session-note", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
			requireStatus(t, integrationRequest(s, "PUT", "/pages/session-note/shares/"+member.ID.String(), owner, map[string]any{"permission": "edit"}), 200)
			if mode == "expired" {
				if _, err = s.pool.Exec(context.Background(), `UPDATE sessions SET expires_at=now()+interval '400 milliseconds' WHERE token_hash=$1`, tokenHash(token)); err != nil {
					t.Fatal(err)
				}
			}
			srv := httptest.NewServer(s)
			defer srv.Close()
			conn := openIntegrationSocket(t, srv.URL, "session-note", token)
			var otherConn *websocket.Conn
			var otherToken string
			if mode == "password" || mode == "rejected" {
				otherToken, _, err = s.newSession(context.Background(), member.ID)
				if err != nil {
					t.Fatal(err)
				}
				otherConn = openIntegrationSocket(t, srv.URL, "session-note", otherToken)
			}
			switch mode {
			case "logout":
				requireStatus(t, integrationRequest(s, "POST", "/auth/logout", token, nil), 204)
			case "password":
				requireStatus(t, integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": password, "nextPassword": "Changed-pass-123"}), 204)
			case "rejected":
				requireStatus(t, integrationRequest(s, "PATCH", "/auth/registration-requests/"+member.ID.String(), owner, map[string]any{"status": "rejected"}), 200)
			case "external-revocation":
				if _, err = s.pool.Exec(context.Background(), `DELETE FROM sessions WHERE token_hash=$1`, tokenHash(token)); err != nil {
					t.Fatal(err)
				}
				// Simulate revocation on a different instance: outbound data must recheck
				// the session even when this process did not run the logout handler.
				requireStatus(t, integrationRequest(s, "PATCH", "/pages/session-note", owner, map[string]any{"title": "After revocation"}), 200)
			}
			requireClosedSocket(t, conn)
			if otherConn != nil {
				requireClosedSocket(t, otherConn)
				requireStatus(t, integrationRequest(s, "GET", "/pages/session-note", otherToken, nil), 401)
			}
			requireStatus(t, integrationRequest(s, "GET", "/pages/session-note", token, nil), 401)
			request := httptest.NewRequest("GET", "/", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			_, err = s.applyRealtimeBlocks(request, member, "session-note", struct {
				Blocks          json.RawMessage
				ChangedBlockIDs []string
				DeletedBlockIDs []string
				Structural      bool
			}{Blocks: json.RawMessage(`[{"id":"a","type":"paragraph","content":"Unauthorized"}]`), ChangedBlockIDs: []string{"a"}})
			var apiErr *apiError
			if !errors.As(err, &apiErr) || apiErr.Status != 401 {
				t.Fatalf("revoked mutation error = %v", err)
			}
			value := responseData[page](t, integrationRequest(s, "GET", "/pages/session-note", owner, nil))
			if strings.Contains(string(value.Blocks), "Unauthorized") {
				t.Fatal("revoked session persisted content")
			}
		})
	}
}

func TestIntegrationRealtimePatchExpiresWhileWaitingForPage(t *testing.T) {
	s := integrationServer(t)
	user, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "blocked", "title": "Original", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
	ctx := context.Background()
	gate, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(ctx)
	if _, err = gate.Exec(ctx, `SELECT id FROM pages WHERE id='blocked' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE sessions SET expires_at=now()+interval '400 milliseconds' WHERE token_hash=$1`, tokenHash(token)); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	result := make(chan error, 1)
	go func() {
		_, err := s.applyRealtimeBlocks(request, user, "blocked", struct {
			Blocks          json.RawMessage
			ChangedBlockIDs []string
			DeletedBlockIDs []string
			Structural      bool
		}{Blocks: json.RawMessage(`[{"id":"a","type":"paragraph","content":"After expiry"}]`), ChangedBlockIDs: []string{"a"}})
		result <- err
	}()
	waitForBlockedQueries(t, s.pool, 1)
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("queued patch did not stop at expiry: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expired patch still waiting for the page")
	}
	if err = gate.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var blocks string
	if err = s.pool.QueryRow(ctx, `SELECT blocks_json::text FROM pages WHERE id='blocked'`).Scan(&blocks); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(blocks, "After expiry") {
		t.Fatal("expired queued patch changed the document")
	}
}

func TestIntegrationLogoutClosesOnlyItsSession(t *testing.T) {
	s := integrationServer(t)
	user, token := integrationUser(t, s)
	otherToken, _, err := s.newSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "sessions"}), 201)
	srv := httptest.NewServer(s)
	defer srv.Close()
	first := openIntegrationSocket(t, srv.URL, "sessions", token)
	second := openIntegrationSocket(t, srv.URL, "sessions", otherToken)
	requireStatus(t, integrationRequest(s, "POST", "/auth/logout", token, nil), 204)
	requireClosedSocket(t, first)
	if err := websocket.JSON.Send(second, map[string]any{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	readIntegrationEvent(t, second, "pong")
}

func TestIntegrationRealtimeMutationAcknowledgement(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "ack", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
	srv := httptest.NewServer(s)
	defer srv.Close()
	first := openIntegrationSocket(t, srv.URL, "ack", token)
	second := openIntegrationSocket(t, srv.URL, "ack", token)
	message := map[string]any{"type": "page.blocks.patch", "mutationId": "tab-one-change", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Saved"}]`), "changedBlockIds": []string{"a"}}
	if err := websocket.JSON.Send(first, message); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []*websocket.Conn{first, second} {
		if event := readIntegrationEvent(t, conn, "page.updated"); event.MutationID != "tab-one-change" {
			t.Fatalf("mutation ID not echoed: %+v", event)
		}
	}
	message["changedBlockIds"] = []string{"missing"}
	message["mutationId"] = "invalid-change"
	if err := websocket.JSON.Send(first, message); err != nil {
		t.Fatal(err)
	}
	if event := readIntegrationEvent(t, first, "page.error"); event.MutationID != "invalid-change" {
		t.Fatalf("error mutation ID not echoed: %+v", event)
	}
	message["mutationId"] = strings.Repeat("x", 129)
	if err := websocket.JSON.Send(first, message); err != nil {
		t.Fatal(err)
	}
	if event := readIntegrationEvent(t, first, "page.error"); event.Code != "VALIDATION_ERROR" {
		t.Fatalf("oversized mutation ID accepted: %+v", event)
	}
}

// Hold a write in its trigger so a concurrent request deterministically reaches
// either the old unprotected read or the new account lock before release.
func folderWriteGate(t *testing.T, s *Server) func() {
	t.Helper()
	ctx := context.Background()
	gate, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(739918)`); err != nil {
		gate.Release()
		t.Fatal(err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			gate.Exec(ctx, `SELECT pg_advisory_unlock(739918)`)
			gate.Release()
		}
	}
	t.Cleanup(release)
	if _, err = s.pool.Exec(ctx, `CREATE FUNCTION pause_folder_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(739918); RETURN NEW; END; $$;CREATE TRIGGER pause_folder_write BEFORE UPDATE ON folders FOR EACH ROW EXECUTE FUNCTION pause_folder_write()`); err != nil {
		t.Fatal(err)
	}
	return release
}

func TestIntegrationConcurrentFolderPatchesPreserveFields(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/folders", token, map[string]any{"id": "folder", "title": "Original"}), 201)
	release := folderWriteGate(t, s)
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/folders/folder", token, map[string]any{"title": "Renamed"})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/folders/folder", token, map[string]any{"collapsed": true})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	for i := 0; i < 2; i++ {
		requireStatus(t, <-responses, 200)
	}
	value := responseData[[]folder](t, integrationRequest(s, "GET", "/folders", token, nil))[0]
	if value.Title != "Renamed" || !value.Collapsed {
		t.Fatalf("lost folder change: %+v", value)
	}
}

func TestIntegrationConcurrentFolderMovesRejectCycle(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	for _, id := range []string{"a", "b"} {
		requireStatus(t, integrationRequest(s, "POST", "/folders", token, map[string]any{"id": id, "title": id}), 201)
	}
	release := folderWriteGate(t, s)
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/folders/a", token, map[string]any{"parentId": "b"})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/folders/b", token, map[string]any{"parentId": "a"})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	codes := map[int]int{}
	for i := 0; i < 2; i++ {
		response := <-responses
		codes[response.Code]++
	}
	if codes[200] != 1 || codes[400] != 1 {
		t.Fatalf("move status counts: %v", codes)
	}
	var roots int
	if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM folders WHERE parent_id IS NULL`).Scan(&roots); err != nil {
		t.Fatal(err)
	}
	if roots != 1 {
		t.Fatalf("root count = %d", roots)
	}
}

func TestIntegrationFolderSubtreeDepthAndLegacyCycle(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	for _, v := range []struct {
		id     string
		parent any
	}{{"a", nil}, {"b", "a"}, {"c", "b"}, {"d", nil}, {"e", "d"}} {
		requireStatus(t, integrationRequest(s, "POST", "/folders", token, map[string]any{"id": v.id, "title": v.id, "parentId": v.parent}), 201)
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/folders/a", token, map[string]any{"parentId": "e"}), 400)
	requireStatus(t, integrationRequest(s, "PATCH", "/folders/c", token, map[string]any{"title": "Renamed"}), 200)
	requireStatus(t, integrationRequest(s, "POST", "/folders", token, map[string]any{"id": "too-deep", "parentId": "c"}), 400)
	// Guard recursive validation even if an old version already stored a cycle;
	// moving a member to the root must still provide a way to repair it.
	if _, err := s.pool.Exec(context.Background(), `UPDATE folders SET parent_id='e' WHERE id='d'`); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/folders/c", token, map[string]any{"parentId": "e"}), 400)
	requireStatus(t, integrationRequest(s, "PATCH", "/folders/d", token, map[string]any{"parentId": nil}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/folders/e", token, map[string]any{"title": "Repaired"}), 200)
}

func singleConnectionServer(t *testing.T, s *Server) {
	t.Helper()
	cfg := s.pool.Config()
	cfg.MaxConns = 1
	cfg.MinConns = 0
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s.pool = pool
}

func TestIntegrationSingleConnectionNotificationsAndCommentDelete(t *testing.T) {
	s := integrationServer(t)
	user, token := integrationUser(t, s)
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO notifications(recipient_id,kind,title,description) VALUES($1,'share','First','First'),($1,'share','Second','Second')`, user.ID); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "comment-page"}), 201)
	comment := integrationRequest(s, "POST", "/pages/comment-page/comments", token, map[string]any{"id": "comment-thread", "blockId": "a", "body": "Comment"})
	requireStatus(t, comment, 201)
	thread := responseData[commentThread](t, comment)
	singleConnectionServer(t, s)
	for _, request := range []struct {
		method, path string
		status       int
	}{{"GET", "/v1/notifications?limit=1", 200}, {"DELETE", "/v1/comments/comment-thread/messages/" + thread.Messages[0].ID, 204}} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		r := httptest.NewRequest(request.method, request.path, nil).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		s.ServeHTTP(response, r)
		cancel()
		requireStatus(t, response, request.status)
		if request.method == "GET" {
			var result struct {
				Data []notification
				Meta struct {
					UnreadCount int
					NextCursor  *time.Time
				}
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Data) != 1 || result.Meta.UnreadCount != 2 || result.Meta.NextCursor == nil {
				t.Fatalf("bad pagination: %s", response.Body.String())
			}
		}
	}
}

func TestIntegrationLongPageTitleCanBeShared(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, memberToken := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "long-title", "title": strings.Repeat("가", 500)}), 201)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/long-title/shares/"+member.ID.String(), owner, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/pages/long-title", memberToken, nil), 200)
	var title string
	if err := s.pool.QueryRow(context.Background(), `SELECT title FROM notifications WHERE recipient_id=$1`, member.ID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if len([]rune(title)) > 500 || !strings.HasSuffix(title, "…") {
		t.Fatalf("unbounded notification: %q", title)
	}
}

func TestIntegrationPasswordByteLimits(t *testing.T) {
	s := integrationServer(t)
	for _, password := range []string{strings.Repeat("a", 73), strings.Repeat("가", 25)} {
		requireStatus(t, integrationRequest(s, "POST", "/auth/register", "", map[string]any{"name": "Password test", "email": "limits@example.invalid", "password": password}), 400)
	}
	password := strings.Repeat("가", 24) // 72 UTF-8 bytes, supported by bcrypt.
	requireStatus(t, integrationRequest(s, "POST", "/auth/register", "", map[string]any{"name": "Password test", "email": "limits@example.invalid", "password": password}), 201)
	login := integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": "limits@example.invalid", "password": password})
	requireStatus(t, login, 200)
	var token string
	for _, cookie := range login.Result().Cookies() {
		if cookie.Name == "nodi_session" {
			token = cookie.Value
		}
	}
	if token == "" {
		t.Fatal("missing session")
	}
	requireStatus(t, integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": password, "nextPassword": strings.Repeat("b", 73)}), 400)
	requireStatus(t, integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": "limits@example.invalid", "password": password}), 200)
	requireStatus(t, integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": password, "nextPassword": strings.Repeat("b", 72)}), 204)
	requireStatus(t, integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": "limits@example.invalid", "password": strings.Repeat("b", 72)}), 200)
	requireStatus(t, integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": "limits@example.invalid", "password": strings.Repeat("b", 72) + "suffix"}), 401)
}
