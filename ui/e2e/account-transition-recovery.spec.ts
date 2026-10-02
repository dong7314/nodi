import { expect, test, type Page } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

const user = {
  id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid",
  role: "member", avatarColor: "purple",
};

async function logout(page: Page) {
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
}

async function login(page: Page) {
  await page.getByRole("button", { name: "로그인", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nodi에 로그인" });
  await dialog.getByPlaceholder("name@example.com").fill(user.email);
  await dialog.getByPlaceholder("8자 이상").fill("test-password");
  await dialog.getByRole("button", { name: "로그인", exact: true }).click();
}

test("another tab's logout preserves the title just typed before its server save", async ({ page, context }) => {
  let signedIn = true;
  let logoutStarted = false;
  let releaseLogout!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLogout = resolve; });
  const setup = async (tab: Page) => {
    const server = await mockWorkspace(tab);
    await tab.route("**/api/auth/me", (route) => signedIn
      ? route.fulfill({ json: { data: user } })
      : route.fulfill({ status: 401, json: { error: { code: "INVALID_SESSION" } } }));
    await tab.route("**/api/auth/logout", async (route) => {
      logoutStarted = true;
      await gate;
      signedIn = false;
      await route.fulfill({ status: 204 });
    });
    await tab.route("**/api/auth/login", (route) => {
      signedIn = true;
      return route.fulfill({ json: { data: { user } } });
    });
    return server;
  };
  const first = await setup(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  const other = await context.newPage();
  const second = await setup(other);
  await other.goto("/?page=page-2");
  await expect(documentEditor(other)).toHaveText("PAGE TWO ORIGINAL");
  await logout(page);
  await expect.poll(() => logoutStarted).toBe(true);
  // Freeze only after the confirmation's closing animation has submitted the
  // request. The title then has no opportunity to rely on a debounce timer.
  await other.clock.install();
  await other.clock.pauseAt((await other.evaluate(() => Date.now())) + 100);
  await other.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("TITLE JUST TYPED IN OTHER TAB");
  expect(await other.evaluate(() => localStorage.getItem("nodi:page-draft:page-2"))).toContain("TITLE JUST TYPED IN OTHER TAB");
  expect(second.writes.filter((write) => write.id === "page-2")).toEqual([]);
  releaseLogout();
  await expect(other.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  expect(await page.evaluate((id) => localStorage.getItem(`nodi:workspace-cache:${id}`), user.id)).toContain("TITLE JUST TYPED IN OTHER TAB");
  expect(await other.evaluate(() => localStorage.getItem("nodi:pages"))).not.toContain("TITLE JUST TYPED IN OTHER TAB");
  await other.clock.resume();
  await login(page);
  await expect(page.getByRole("button", { name: "프로필 설정 열기", exact: true })).toBeVisible();
  await page.locator('[data-sidebar-page-id="page-2"]').first().click();
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("TITLE JUST TYPED IN OTHER TAB");
  await expect.poll(() => first.pages["page-2"].title).toBe("TITLE JUST TYPED IN OTHER TAB");
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
  await other.close();
});

test("failed login metadata rolls back the private archive and permits safe guest edits and retry", async ({ page }) => {
  const server = await mockWorkspace(page);
  let signedIn = true;
  await page.route("**/api/auth/me", (route) => signedIn
    ? route.fulfill({ json: { data: user } })
    : route.fulfill({ status: 401, json: { error: { code: "INVALID_SESSION" } } }));
  await page.route("**/api/auth/logout", (route) => { signedIn = false; return route.fulfill({ status: 204 }); });
  await page.route("**/api/auth/login", (route) => { signedIn = true; return route.fulfill({ json: { data: { user } } }); });
  await page.route("**/api/pages/page-1", (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await editDocument(page, " PRIVATE UNSAVED LOCAL BODY");
  await logout(page);
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  await editDocument(page, "GUEST BODY");
  const before = await page.evaluate((id) => ({
    archive: localStorage.getItem(`nodi:workspace-cache:${id}`),
    pages: localStorage.getItem("nodi:pages"),
    accounts: localStorage.getItem("nodi:auth:accounts"),
  }), user.id);
  expect(before.archive).toContain("PRIVATE UNSAVED LOCAL BODY");
  // A one-shot storage fault targets metadata after the workspace restore.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key === "nodi:auth:accounts") {
        Storage.prototype.setItem = original;
        throw new DOMException("AUTH METADATA QUOTA", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await login(page);
  await expect(page.getByText("AUTH METADATA QUOTA", { exact: true })).toBeVisible();
  const rolledBack = await page.evaluate((id) => ({
    owner: localStorage.getItem("nodi:workspace-owner"),
    session: localStorage.getItem("nodi:auth:session"),
    pages: localStorage.getItem("nodi:pages"),
    archive: localStorage.getItem(`nodi:workspace-cache:${id}`),
    accounts: localStorage.getItem("nodi:auth:accounts"),
  }), user.id);
  expect(rolledBack).toEqual({ owner: "guest", session: null, ...before });
  await page.getByRole("button", { name: "인증 창 닫기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Nodi에 로그인" })).toHaveCount(0);
  await editDocument(page, " AFTER FAILED LOGIN");
  expect(await page.evaluate((id) => localStorage.getItem(`nodi:workspace-cache:${id}`), user.id)).toBe(before.archive);
  await login(page);
  await expect(page.getByRole("button", { name: "프로필 설정 열기", exact: true })).toBeVisible();
  await page.locator('[data-sidebar-page-id="page-1"]').first().click();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL PRIVATE UNSAVED LOCAL BODY");
  await expect.poll(() => Object.values(server.pages).some((entry) => JSON.stringify(entry.blocks).includes("GUEST BODY AFTER FAILED LOGIN"))).toBe(true);
  await editDocument(page, " NEXT NORMAL EDIT");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL PRIVATE UNSAVED LOCAL BODY NEXT NORMAL EDIT");
  expect(server.failures).toEqual([]);
});

for (const failedKey of [
  "nodi:auth:accounts", "nodi:auth:last-email", "nodi:auth:initialized",
  "nodi:user:name", "nodi:user:profile", "nodi:auth:user", "nodi:auth:session",
]) {
  test(`account transition restores all keys when writing ${failedKey} fails`, async ({ page }) => {
    await page.route("**/auth-transition-test", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Account transition rollback</title>" }));
    await page.goto("/auth-transition-test");
    await page.route("**/api/auth/login", (route) => route.fulfill({ json: { data: { user } } }));
    const result = await page.evaluate(async ({ user, failedKey }) => {
      const account = await import(/* @vite-ignore */ "/src/account-store.ts");
      const guestPages = JSON.stringify({ "quick-note": { id: "quick-note", title: "Guest", blocks: [], createdAt: "2026-10-01", updatedAt: "2026-10-01" } });
      const privatePages = JSON.stringify({ private: { id: "private", ownerId: user.id, title: "Private unsaved page", blocks: [] } });
      localStorage.setItem("nodi:workspace-owner", "guest");
      localStorage.setItem("nodi:pages", guestPages);
      localStorage.setItem("nodi:user:name", "Guest");
      localStorage.setItem("nodi:user:profile", JSON.stringify({ name: "Guest" }));
      localStorage.setItem("nodi:auth:user", JSON.stringify({ name: "Guest" }));
      localStorage.setItem("nodi:auth:accounts", JSON.stringify([{ ...user, status: "approved", name: "Previous name" }]));
      localStorage.setItem("nodi:auth:last-email", "old@example.invalid");
      localStorage.setItem("nodi:auth:initialized", "false");
      localStorage.setItem("nodi:auth:signed-out", "true");
      localStorage.setItem(`nodi:guest-workspace-migrated:${user.id}:v1`, "done");
      localStorage.setItem(`nodi:workspace-cache:${user.id}`, JSON.stringify({ "nodi:pages": privatePages, "nodi:page-draft:private": "PRIVATE UNSAVED JOURNAL" }));
      const snapshot = () => Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]));
      const before = snapshot();
      let failed = false;
      let authEvents = 0;
      let pageEvents = 0;
      window.addEventListener("nodi:local-auth-changed", () => { authEvents += 1; });
      window.addEventListener("nodi:pages-changed", () => { pageEvents += 1; });
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key: string, value: string) {
        if (!failed && key === failedKey && localStorage.getItem("nodi:workspace-owner") === user.id) {
          failed = true;
          throw new DOMException("AUTH METADATA QUOTA", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
      let loginResult;
      try { loginResult = await account.loginLocalAccount(user.email, "test-password"); }
      finally { Storage.prototype.setItem = original; }
      return { before, after: snapshot(), failed, authEvents, pageEvents, ok: loginResult.ok };
    }, { user, failedKey });
    expect(result.failed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.after).toEqual(result.before);
    expect(result.authEvents).toBe(0);
    expect(result.pageEvents).toBe(0);
  });
}

test("title changes persist immediately while requests retain the server debounce", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "READY TITLE";
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("READY TITLE");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await title.fill("IMMEDIATE LOCAL TITLE");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("nodi:pages") ?? "{}")["page-1"].title)).toBe("IMMEDIATE LOCAL TITLE");
  expect(server.writes.filter((write) => write.id === "page-1")).toEqual([]);
  await page.clock.runFor(650);
  expect(server.writes.filter((write) => write.id === "page-1")).toEqual([]);
  await page.clock.runFor(100);
  await expect.poll(() => server.pages["page-1"].title).toBe("IMMEDIATE LOCAL TITLE");
  expect(server.failures).toEqual([]);
});

test("a stale account title handler cannot write into a newly activated guest workspace", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  const guestPages = JSON.stringify({ "quick-note": { id: "quick-note", title: "GUEST ONLY", blocks: [] } });
  // Model the interval between another tab committing its identity change and
  // this tab handling the queued storage notification. No reload is dispatched.
  await page.evaluate((guestPages) => {
    localStorage.setItem("nodi:workspace-owner", "guest");
    localStorage.removeItem("nodi:auth:session");
    localStorage.setItem("nodi:pages", guestPages);
  }, guestPages);
  await page.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("OLD ACCOUNT INPUT");
  expect(await page.evaluate(() => localStorage.getItem("nodi:pages"))).toBe(guestPages);
  expect(await page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1") ?? "")).not.toContain("OLD ACCOUNT INPUT");
  expect(server.failures).toEqual([]);
});
