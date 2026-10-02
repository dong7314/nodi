package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/net/websocket"
)

// A trigger pauses a write after its authorization checks. Unlike sleeps, the
// advisory lock and pg_stat_activity establish the exact concurrent ordering.
func pauseAuthorizationWrite(t *testing.T, s *Server, trigger string) func() {
	t.Helper()
	ctx := context.Background()
	gate, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(751338)`); err != nil {
		gate.Release()
		t.Fatal(err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			if _, err := gate.Exec(ctx, `SELECT pg_advisory_unlock(751338)`); err != nil {
				t.Error(err)
			}
			gate.Release()
		}
	}
	t.Cleanup(release)
	if _, err = s.pool.Exec(ctx, `CREATE FUNCTION pause_authorization_write() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN PERFORM pg_advisory_xact_lock(751338); IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END; $$;`+trigger); err != nil {
		t.Fatal(err)
	}
	return release
}

func awaitAuthorizationResponse(t *testing.T, result <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case response := <-result:
		return response
	case <-time.After(6 * time.Second):
		t.Fatal("authorization request did not complete")
		return nil
	}
}

func integrationPassword(t *testing.T, s *Server, user authUser, password string) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(context.Background(), `UPDATE users SET password_hash=$1 WHERE id=$2`, string(hash), user.ID); err != nil {
		t.Fatal(err)
	}
}

func responseSession(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == "nodi_session" && cookie.Value != "" {
			return cookie.Value
		}
	}
	t.Fatal("successful login did not issue a session")
	return ""
}

func TestIntegrationDelayedLoginCannotSurvivePasswordChange(t *testing.T) {
	s := integrationServer(t)
	user, token := integrationUser(t, s)
	const old, next = "old-password-123", "new-password-456"
	integrationPassword(t, s, user, old)
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_login BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	defer release()
	login, change := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		login <- integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": user.Email, "password": old})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		change <- integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": old, "nextPassword": next})
	}()
	// The password change must wait for the already verified login, so its
	// session deletion also covers the session that login is about to create.
	waitForBlockedQueries(t, s.pool, 2)
	release()
	loginResponse := awaitAuthorizationResponse(t, login)
	requireStatus(t, loginResponse, 200)
	requireStatus(t, awaitAuthorizationResponse(t, change), 204)
	requireStatus(t, integrationRequest(s, "GET", "/auth/me", token, nil), 401)
	requireStatus(t, integrationRequest(s, "GET", "/auth/me", responseSession(t, loginResponse), nil), 401)
	requireStatus(t, integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": user.Email, "password": old}), 401)
	newLogin := integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": user.Email, "password": next})
	requireStatus(t, newLogin, 200)
	requireStatus(t, integrationRequest(s, "GET", "/auth/me", responseSession(t, newLogin), nil), 200)
}

func TestIntegrationQueuedLoginRechecksCredentialsAndStatus(t *testing.T) {
	for _, changeKind := range []string{"password", "rejected"} {
		t.Run(changeKind, func(t *testing.T) {
			s := integrationServer(t)
			admin, adminToken := integrationUser(t, s)
			if _, err := s.pool.Exec(context.Background(), `UPDATE users SET role='admin' WHERE id=$1`, admin.ID); err != nil {
				t.Fatal(err)
			}
			user, token := integrationUser(t, s)
			const old = "old-password-123"
			integrationPassword(t, s, user, old)
			release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_user BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
			defer release()
			change, login := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
			go func() {
				if changeKind == "password" {
					change <- integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": old, "nextPassword": "new-password-456"})
				} else {
					change <- integrationRequest(s, "PATCH", "/auth/registration-requests/"+user.ID.String(), adminToken, map[string]any{"status": "rejected"})
				}
			}()
			waitForBlockedQueries(t, s.pool, 1)
			go func() {
				login <- integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": user.Email, "password": old})
			}()
			waitForBlockedQueries(t, s.pool, 2)
			release()
			wantChange, wantLogin := 204, 401
			if changeKind == "rejected" {
				wantChange, wantLogin = 200, 403
			}
			requireStatus(t, awaitAuthorizationResponse(t, change), wantChange)
			requireStatus(t, awaitAuthorizationResponse(t, login), wantLogin)
			var sessions int
			if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE user_id=$1`, user.ID).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if sessions != 0 {
				t.Fatalf("invalid login left %d sessions", sessions)
			}
		})
	}
}

func TestIntegrationConcurrentPasswordChangeRechecksCurrentPassword(t *testing.T) {
	s := integrationServer(t)
	user, token := integrationUser(t, s)
	const old, firstPassword = "old-password-123", "first-password-456"
	integrationPassword(t, s, user, old)
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_password BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	defer release()
	first, second := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		first <- integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": old, "nextPassword": firstPassword})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		second <- integrationRequest(s, "POST", "/auth/change-password", token, map[string]any{"currentPassword": old, "nextPassword": "stale-password-789"})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	requireStatus(t, awaitAuthorizationResponse(t, first), 204)
	requireStatus(t, awaitAuthorizationResponse(t, second), 400)
	requireStatus(t, integrationRequest(s, "POST", "/auth/login", "", map[string]any{"email": user.Email, "password": firstPassword}), 200)
}

func waitForAuthorizationQueries(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var active int
		if err := s.pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND pid<>pg_backend_pid() AND state IN ('active','idle in transaction','idle in transaction (aborted)')`).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("queued authorization query did not finish")
}

func TestIntegrationQueuedPageEditsRespectSharingChanges(t *testing.T) {
	for _, changeKind := range []string{"revoke", "downgrade"} {
		for _, transport := range []string{"websocket", "patch", "blocks"} {
			t.Run(changeKind+"/"+transport, func(t *testing.T) {
				s := integrationServer(t)
				_, owner := integrationUser(t, s)
				member, token := integrationUser(t, s)
				requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
				share := "/pages/shared/shares/" + member.ID.String()
				requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
				srv := httptest.NewServer(s)
				defer srv.Close()
				var conn *websocket.Conn
				if transport == "websocket" {
					conn = openIntegrationSocket(t, srv.URL, "shared", token)
					defer conn.Close()
				}
				release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_share BEFORE UPDATE OR DELETE ON page_shares FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
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
				blocks := json.RawMessage(`[{"id":"a","type":"paragraph","content":"Unauthorized queued edit"}]`)
				if conn != nil {
					if err := websocket.JSON.Send(conn, map[string]any{"type": "page.blocks.patch", "mutationId": "queued", "blocks": blocks, "changedBlockIds": []string{"a"}}); err != nil {
						t.Fatal(err)
					}
				} else {
					go func() {
						method, path := "PATCH", "/pages/shared"
						if transport == "blocks" {
							method, path = "PUT", "/pages/shared/blocks"
						}
						edit <- integrationRequest(s, method, path, token, map[string]any{"blocks": blocks})
					}()
				}
				waitForBlockedQueries(t, s.pool, 2)
				release()
				wantShare, wantEdit := 204, 404
				if changeKind == "downgrade" {
					wantShare, wantEdit = 200, 403
				}
				requireStatus(t, awaitAuthorizationResponse(t, change), wantShare)
				if conn == nil {
					requireStatus(t, awaitAuthorizationResponse(t, edit), wantEdit)
				} else if changeKind == "revoke" {
					requireClosedSocket(t, conn)
					waitForAuthorizationQueries(t, s)
				} else {
					event := readIntegrationEvent(t, conn, "page.error")
					if event.Code != "PAGE_EDIT_REQUIRED" || event.MutationID != "queued" {
						t.Fatalf("unexpected downgrade error: %+v", event)
					}
				}
				value := responseData[page](t, integrationRequest(s, "GET", "/pages/shared", owner, nil))
				if !strings.Contains(string(value.Blocks), "Original") || value.Revision != 1 {
					t.Fatalf("queued edit bypassed sharing change: %+v", value)
				}
			})
		}
	}
}

func TestIntegrationShareRevocationWaitsForAuthorizedEdit(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	member, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared"}), 201)
	share := "/pages/shared/shares/" + member.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", share, owner, map[string]any{"permission": "edit"}), 200)
	release := pauseAuthorizationWrite(t, s, `CREATE TRIGGER pause_page BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pause_authorization_write()`)
	defer release()
	edit, revoke := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
	go func() {
		edit <- integrationRequest(s, "PATCH", "/pages/shared", token, map[string]any{"title": "Authorized before revocation"})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() { revoke <- integrationRequest(s, "DELETE", share, owner, nil) }()
	waitForBlockedQueries(t, s.pool, 2)
	release()
	requireStatus(t, awaitAuthorizationResponse(t, edit), 200)
	requireStatus(t, awaitAuthorizationResponse(t, revoke), 204)
	value := responseData[page](t, integrationRequest(s, "GET", "/pages/shared", owner, nil))
	if value.Title != "Authorized before revocation" {
		t.Fatalf("already authorized edit lost: %+v", value)
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", token, map[string]any{"title": "Too late"}), 404)
}

func TestIntegrationSharingLocksUsersBeforePage(t *testing.T) {
	s := integrationServer(t)
	ownerUser, owner := integrationUser(t, s)
	member, _ := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared"}), 201)
	ctx := context.Background()
	gate, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback(ctx)
	// Model a folder/workspace operation: user first, then its pages. A share
	// must not hold the page while its notification waits on the owner's FK.
	if _, err = gate.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, ownerUser.ID); err != nil {
		t.Fatal(err)
	}
	share := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		share <- integrationRequest(s, "PUT", "/pages/shared/shares/"+member.ID.String(), owner, map[string]any{"permission": "edit"})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	if _, err = gate.Exec(ctx, `SELECT id FROM pages WHERE id='shared' FOR UPDATE NOWAIT`); err != nil {
		t.Fatalf("share inverted the user/page lock order: %v", err)
	}
	if err = gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, awaitAuthorizationResponse(t, share), 200)
}
