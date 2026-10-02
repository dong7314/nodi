package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nodi-app/nodi/api/internal/config"
	"github.com/nodi-app/nodi/api/internal/database"
	"golang.org/x/net/websocket"
)

// Each test owns a fresh schema. DATABASE_URL is deliberately never used so
// ordinary test runs cannot accidentally write to an application's database.
func integrationPool(t *testing.T, migrate bool) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	if _, err = admin.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	schema := "nodi_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quotedSchema+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 16
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "10s"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "5s"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if migrate {
		if err = database.Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}

func integrationServer(t *testing.T) *Server {
	t.Helper()
	s, err := NewServer(integrationPool(t, true), config.Config{
		AttachmentStore: "local", UploadDir: t.TempDir(), PublicBaseURL: "http://localhost",
		SessionTTL: time.Hour, MaxBodyBytes: 10 << 20, MaxImageBytes: 20 << 20, MaxFileBytes: 100 << 20,
		MaxInFlight: 128, CORSOrigins: map[string]struct{}{"http://localhost": {}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func integrationUser(t *testing.T, s *Server) (authUser, string) {
	t.Helper()
	u := authUser{ID: uuid.New(), Name: "Test user", Role: "member", Status: "approved"}
	u.Email = u.ID.String() + "@example.invalid"
	_, err := s.pool.Exec(context.Background(), `INSERT INTO users(id,name,email,role,status,password_hash) VALUES($1,$2,$3,'member','approved','test-only')`, u.ID, u.Name, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := s.newSession(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	return u, token
}

func integrationRequest(s *Server, method, path, token string, body any) *httptest.ResponseRecorder {
	data, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	r := httptest.NewRequest(method, "/v1"+path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func requireStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d: %s", response.Code, want, response.Body.String())
	}
}

func responseData[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func testPreset(id, name string) map[string]any {
	return map[string]any{"id": id, "name": name, "icon": "☀️", "pageTitle": "오늘의 기록", "blocks": []any{}, "orderIndex": 0}
}

func TestIntegrationUserScopedPresetsAndTags(t *testing.T) {
	s := integrationServer(t)
	_, first := integrationUser(t, s)
	_, second := integrationUser(t, s)
	for _, token := range []string{first, second} {
		requireStatus(t, integrationRequest(s, "POST", "/presets", token, testPreset("daily", "기본 프리셋")), 201)
		requireStatus(t, integrationRequest(s, "POST", "/tags", token, map[string]any{"id": "personal", "name": "개인", "color": "purple"}), 201)
	}
	// Updating/retrying one account must not overwrite either account's data.
	requireStatus(t, integrationRequest(s, "PATCH", "/presets/daily", first, testPreset("daily", "내 프리셋")), 200)
	retry := integrationRequest(s, "POST", "/presets", first, testPreset("daily", "기본 프리셋"))
	requireStatus(t, retry, 200)
	if responseData[starterPreset](t, retry).Name != "내 프리셋" {
		t.Fatal("bootstrap retry replaced customized preset")
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/tags/personal", first, map[string]any{"name": "업무", "color": "blue"}), 200)
	retry = integrationRequest(s, "POST", "/tags", first, map[string]any{"id": "personal", "name": "개인", "color": "purple"})
	requireStatus(t, retry, 200)
	if responseData[tag](t, retry).Name != "업무" {
		t.Fatal("bootstrap retry replaced customized tag")
	}
	if values := responseData[[]starterPreset](t, integrationRequest(s, "GET", "/presets", second, nil)); len(values) != 1 || values[0].Name != "기본 프리셋" {
		t.Fatalf("other account's presets changed: %+v", values)
	}
	requireStatus(t, integrationRequest(s, "DELETE", "/presets/daily", first, nil), 204)
	requireStatus(t, integrationRequest(s, "DELETE", "/tags/personal", first, nil), 204)
	if values := responseData[[]tag](t, integrationRequest(s, "GET", "/tags", second, nil)); len(values) != 1 || values[0].Name != "개인" {
		t.Fatalf("other account's tags changed: %+v", values)
	}
	if values := responseData[[]starterPreset](t, integrationRequest(s, "GET", "/presets", second, nil)); len(values) != 1 {
		t.Fatal("delete crossed account boundary")
	}
}

func TestIntegrationConcurrentPresetLimit(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			responses <- integrationRequest(s, "POST", "/presets", token, testPreset(fmt.Sprintf("preset-%d", i), "프리셋"))
		}(i)
	}
	wg.Wait()
	close(responses)
	created := 0
	for response := range responses {
		if response.Code == 201 {
			created++
		} else {
			requireStatus(t, response, 409)
			if !strings.Contains(response.Body.String(), "PRESET_LIMIT") {
				t.Fatal(response.Body.String())
			}
		}
	}
	if created != 5 {
		t.Fatalf("created %d presets; want exactly 5", created)
	}
	values := responseData[[]starterPreset](t, integrationRequest(s, "GET", "/presets", token, nil))
	requireStatus(t, integrationRequest(s, "POST", "/presets", token, testPreset(values[0].ID, "재시도")), 200)
}

func TestIntegrationMigrationPreservesExistingIDs(t *testing.T) {
	pool := integrationPool(t, false)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_initial.sql", "002_notifications_home_minio.sql", "003_operational_indexes.sql"} {
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
	owner := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,name,email,role,status,password_hash) VALUES($1,'Before migration','old@example.invalid','member','approved','test')`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tags(id,owner_id,name,color) VALUES('personal',$1,'기존 태그','purple');`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO starter_presets(id,owner_id,name,icon,page_title) VALUES('daily',$1,'기존 프리셋','☀️','기존 제목')`, owner); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := pool.QueryRow(ctx, `SELECT name FROM tags WHERE owner_id=$1 AND id='personal'`, owner).Scan(&name); err != nil || name != "기존 태그" {
		t.Fatalf("tag changed: %q, %v", name, err)
	}
	if err := pool.QueryRow(ctx, `SELECT name FROM starter_presets WHERE owner_id=$1 AND id='daily'`, owner).Scan(&name); err != nil || name != "기존 프리셋" {
		t.Fatalf("preset changed: %q, %v", name, err)
	}
	other := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,name,email,role,status,password_hash) VALUES($1,'After migration','new@example.invalid','member','approved','test')`, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tags(id,owner_id,name,color) VALUES('personal',$1,'새 태그','blue')`, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO starter_presets(id,owner_id,name,icon,page_title) VALUES('daily',$1,'새 프리셋','☀️','새 제목')`, other); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationPublicPageResources(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	blocks := json.RawMessage(`[
		{"id":"p","type":"paragraph","content":"Visible document","children":[
			{"id":"private-link","type":"childPage","props":{"pageId":"private-child","title":"PRIVATE TITLE"}},
			{"id":"public-link","type":"childPage","props":{"pageId":"public-child","title":"Old title"}},
			{"id":"archived-link","type":"childPage","props":{"pageId":"archived-child","title":"ARCHIVED TITLE"}},
			{"id":"db","type":"database","props":{"databaseId":"visible-db"}},
			{"id":"legacy","type":"database","props":{}}
		]}
	]`)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "parent", "title": "Public parent", "settings": map[string]any{"publicAccess": true}, "blocks": blocks}), 201)
	for _, child := range []struct {
		id, title        string
		public, archived bool
	}{
		{"private-child", "PRIVATE TITLE", false, false}, {"public-child", "Public child", true, false}, {"archived-child", "ARCHIVED TITLE", true, true},
	} {
		requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": child.id, "parentId": "parent", "title": child.title, "settings": map[string]any{"publicAccess": child.public}, "archived": child.archived}), 201)
	}
	for _, id := range []string{"visible-db", "database-legacy", "removed-db"} {
		state := json.RawMessage(`{"name":"Visible database","properties":[],"records":[{"id":"live","values":{"title":"Visible row"}}],"trash":[{"id":"deleted","values":{"title":"DELETED CONTENT"}}],"views":[],"activeViewId":null}`)
		requireStatus(t, integrationRequest(s, "PUT", "/databases/"+id, token, map[string]any{"pageId": "parent", "state": state}), 201)
	}
	response := integrationRequest(s, "GET", "/public/pages/parent", "", nil)
	requireStatus(t, response, 200)
	for _, private := range []string{"PRIVATE TITLE", "private-child", "ARCHIVED TITLE", "archived-child", "DELETED CONTENT", "removed-db"} {
		if strings.Contains(response.Body.String(), private) {
			t.Fatalf("public response contains %q: %s", private, response.Body.String())
		}
	}
	type publicResponse struct {
		Page      page                         `json:"page"`
		Databases []inlineDatabase             `json:"databases"`
		Children  []struct{ ID, Title string } `json:"childPages"`
	}
	public := responseData[publicResponse](t, response)
	if len(public.Databases) != 2 || len(public.Children) != 1 || public.Children[0].ID != "public-child" {
		t.Fatalf("visible resources missing: %+v", public)
	}
	if !strings.Contains(string(public.Page.Blocks), "Public child") || !strings.Contains(string(public.Page.Blocks), "Visible document") {
		t.Fatal("public blocks lost visible content")
	}
	for _, db := range public.Databases {
		var state struct{ Records, Trash []json.RawMessage }
		if err := json.Unmarshal(db.State, &state); err != nil {
			t.Fatal(err)
		}
		if len(state.Records) != 1 || len(state.Trash) != 0 {
			t.Fatal("public database shape changed")
		}
	}
	ownerPage := integrationRequest(s, "GET", "/pages/parent", token, nil)
	if !strings.Contains(ownerPage.Body.String(), "PRIVATE TITLE") {
		t.Fatal("public projection modified stored blocks")
	}
	ownerDB := integrationRequest(s, "GET", "/databases/visible-db", token, nil)
	if !strings.Contains(ownerDB.Body.String(), "DELETED CONTENT") {
		t.Fatal("public projection modified database trash")
	}
	requireStatus(t, integrationRequest(s, "GET", "/public/pages/private-child", "", nil), 404)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/parent", token, map[string]any{"settings": map[string]any{"publicAccess": false}}), 200)
	requireStatus(t, integrationRequest(s, "GET", "/public/pages/parent", "", nil), 404)
}

func TestIntegrationConcurrentPagePatchesPreserveFields(t *testing.T) {
	s := integrationServer(t)
	_, token := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", token, map[string]any{"id": "concurrent", "title": "Original", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Original"}]`)}), 201)
	ctx := context.Background()
	// Hold the first UPDATE inside a trigger. A second request has time to read
	// the old snapshot on the broken path; the fixed path waits at SELECT FOR UPDATE.
	gate, err := s.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(730021)`); err != nil {
		t.Fatal(err)
	}
	defer gate.Exec(ctx, `SELECT pg_advisory_unlock(730021)`)
	if _, err = s.pool.Exec(ctx, `CREATE FUNCTION pause_page_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(730021); RETURN NEW; END; $$;
	CREATE TRIGGER pause_page_write BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION pause_page_write()`); err != nil {
		t.Fatal(err)
	}
	responses := make(chan *httptest.ResponseRecorder, 2)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/pages/concurrent", token, map[string]any{"title": "Changed title"})
	}()
	waitForBlockedQueries(t, s.pool, 1)
	go func() {
		responses <- integrationRequest(s, "PATCH", "/pages/concurrent", token, map[string]any{"blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Changed content"}]`)})
	}()
	waitForBlockedQueries(t, s.pool, 2)
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_unlock(730021)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case response := <-responses:
			requireStatus(t, response, 200)
		case <-time.After(6 * time.Second):
			t.Fatal("page update did not finish")
		}
	}
	value := responseData[page](t, integrationRequest(s, "GET", "/pages/concurrent", token, nil))
	if value.Title != "Changed title" || !strings.Contains(string(value.Blocks), "Changed content") {
		t.Fatalf("concurrent patch lost data: %+v", value)
	}
	if value.Revision != 3 {
		t.Fatalf("revision = %d, want 3", value.Revision)
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/concurrent", token, map[string]any{"title": "Stale", "revision": 1}), 409)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/concurrent/blocks", token, map[string]any{"blocks": []any{}, "revision": 1}), 409)
}

func waitForBlockedQueries(t *testing.T, pool *pgxpool.Pool, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock'`).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d blocked page requests", want)
}

func TestIntegrationPagePermissionsAndRealtime(t *testing.T) {
	s := integrationServer(t)
	_, owner := integrationUser(t, s)
	viewerUser, viewer := integrationUser(t, s)
	requireStatus(t, integrationRequest(s, "POST", "/pages", owner, map[string]any{"id": "shared", "title": "Shared", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"A"},{"id":"b","type":"paragraph","content":"B"}]`)}), 201)
	sharePath := "/pages/shared/shares/" + viewerUser.ID.String()
	requireStatus(t, integrationRequest(s, "PUT", sharePath, owner, map[string]any{"permission": "view"}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", viewer, map[string]any{"title": "Forbidden"}), 403)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/shared/blocks", viewer, map[string]any{"blocks": []any{}}), 403)
	requireStatus(t, integrationRequest(s, "PUT", sharePath, owner, map[string]any{"permission": "edit"}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", viewer, map[string]any{"title": "Allowed"}), 200)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", viewer, map[string]any{"settings": map[string]any{"publicAccess": true}}), 403)
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", viewer, map[string]any{"parentId": nil}), 403)
	home := integrationRequest(s, "PUT", "/home", owner, map[string]any{"settings": map[string]any{"publicAccess": true}})
	requireStatus(t, home, 200)
	if strings.Contains(string(responseData[homePage](t, home).Settings), `"publicAccess":true`) {
		t.Fatal("home became public")
	}

	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	wsConfig, err := websocket.NewConfig("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/v1/pages/shared/realtime", "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	wsConfig.Header = http.Header{"Authorization": []string{"Bearer " + viewer}}
	conn, err := websocket.DialConfig(wsConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	readEvent := func(kind string) pageRealtimeEvent {
		t.Helper()
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
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
	readEvent("page.snapshot")
	if err := websocket.JSON.Send(conn, map[string]any{"type": "page.blocks.patch", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Realtime edit"},{"id":"b","type":"paragraph","content":"B"}]`), "changedBlockIds": []string{"a"}, "deletedBlockIds": []string{}, "structural": false}); err != nil {
		t.Fatal(err)
	}
	updated := readEvent("page.updated")
	if updated.Page == nil || !strings.Contains(string(updated.Page.Blocks), "Realtime edit") {
		t.Fatal("realtime edit missing")
	}
	requireStatus(t, integrationRequest(s, "PATCH", "/pages/shared", owner, map[string]any{"settings": map[string]any{"lockPage": true}}), 200)
	requireStatus(t, integrationRequest(s, "PUT", "/pages/shared/blocks", owner, map[string]any{"blocks": []any{}}), 423)
	if err := websocket.JSON.Send(conn, map[string]any{"type": "page.blocks.patch", "blocks": json.RawMessage(`[{"id":"a","type":"paragraph","content":"Blocked"}]`), "changedBlockIds": []string{"a"}}); err != nil {
		t.Fatal(err)
	}
	if event := readEvent("page.error"); event.Code != "PAGE_LOCKED" {
		t.Fatalf("unexpected error: %+v", event)
	}
	requireStatus(t, integrationRequest(s, "DELETE", sharePath, owner, nil), 204)
	readEvent("access.revoked")
}
