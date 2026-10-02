import { expect, test, type Page } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";

const user = {
  id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid",
  role: "member", avatarColor: "purple",
};
const otherUser = { ...user, id: "00000000-0000-4000-8000-000000000002", name: "다른 계정", email: "other@example.invalid" };

async function confirmLogout(page: Page) {
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
}

async function openAccountModule(page: Page) {
  await page.route("**/auth-race-test", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Authentication race regression</title>",
  }));
  await page.goto("/auth-race-test");
  await page.evaluate((user) => {
    localStorage.setItem("nodi:workspace-owner", user.id);
    localStorage.setItem("nodi:auth:accounts", JSON.stringify([{ ...user, status: "approved" }]));
    localStorage.setItem("nodi:auth:session", JSON.stringify({ userId: user.id, signedInAt: "2026-10-01T00:00:00Z" }));
  }, user);
}

test("same-account tabs preserve their session timestamp and do not reload one another", async ({ page, context }) => {
  const first = await mockWorkspace(page);
  first.pages["page-1"].title = "FIRST TAB READY";
  let firstNavigations = 0;
  let secondNavigations = 0;
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) firstNavigations += 1; });
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("FIRST TAB READY");
  const originalSession = await page.evaluate(() => localStorage.getItem("nodi:auth:session"));
  const other = await context.newPage();
  const second = await mockWorkspace(other);
  second.pages["page-2"].title = "SECOND TAB READY";
  other.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === other.mainFrame()) secondNavigations += 1; });
  await other.goto("/?page=page-2");
  await expect(other.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("SECOND TAB READY");
  // Repeated authentication reads and a profile response exercise both passive
  // session writers. Neither may manufacture a new sign-in timestamp.
  await other.route("**/api/auth/me", (route) => route.request().method() === "PATCH"
    ? route.fulfill({ json: { data: { ...user, name: "프로필 변경" } } }) : route.fallback());
  await other.evaluate(async () => {
    const account = await import(/* @vite-ignore */ "/src/account-store.ts");
    await account.restoreServerAuth();
    await account.updateLocalAccountProfile({ name: "프로필 변경", avatarColor: "purple" });
    await account.restoreServerAuth();
  });
  // Allow storage events and the former reload ping-pong to run in real time.
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBe(originalSession);
  expect(firstNavigations).toBe(1);
  expect(secondNavigations).toBe(1);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect(documentEditor(other)).toHaveText("PAGE TWO ORIGINAL");
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
  await other.close();
});

test("a late auth restore cannot undo logout even when the logout API fails", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "SERVER READY TITLE";
  let releaseMe!: () => void;
  let releaseLogout!: () => void;
  const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
  const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
  let startedLogout = false;
  let initialMe = true;
  await page.route("**/api/auth/me", async (route) => {
    if (initialMe) await meGate;
    return route.fallback();
  });
  await page.route("**/api/auth/logout", async (route) => {
    startedLogout = true;
    await logoutGate;
    await route.fulfill({ status: 503, json: { error: { code: "TEMPORARILY_UNAVAILABLE", message: "Temporary server problem" } } });
  });
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("SERVER READY TITLE");
  await confirmLogout(page);
  await expect.poll(() => startedLogout).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:signed-out"))).toBe("true");
  const response = page.waitForResponse("**/api/auth/me");
  initialMe = false;
  releaseMe();
  await (await response).finished();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:signed-out"))).toBe("true");
  const reload = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
  releaseLogout();
  await reload;
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBeNull();
  await expect(page.locator("body")).not.toContainText("PAGE ONE ORIGINAL");
  // A still-valid HttpOnly cookie must not silently override explicit logout.
  await page.reload();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:signed-out"))).toBe("true");
  expect(server.failures).toEqual([]);
});

test("logout and explicit login propagate once across tabs in the same browser context", async ({ page, context }) => {
  let signedIn = true;
  const configure = async (tab: Page) => {
    const server = await mockWorkspace(tab);
    await tab.route("**/api/auth/me", (route) => signedIn
      ? route.fulfill({ json: { data: user } })
      : route.fulfill({ status: 401, json: { error: { code: "INVALID_SESSION", message: "Logged out" } } }));
    await tab.route("**/api/auth/logout", (route) => { signedIn = false; return route.fulfill({ status: 204 }); });
    await tab.route("**/api/auth/login", (route) => { signedIn = true; return route.fulfill({ json: { data: { user } } }); });
    return server;
  };
  const first = await configure(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  const other = await context.newPage();
  const second = await configure(other);
  await other.goto("/?page=page-2");
  await expect(documentEditor(other)).toHaveText("PAGE TWO ORIGINAL");
  await confirmLogout(page);
  for (const tab of [page, other]) {
    await expect(tab.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
    await expect(tab.locator("body")).not.toContainText("PAGE TWO ORIGINAL");
  }
  await other.getByRole("button", { name: "로그인", exact: true }).first().click();
  const dialog = other.getByRole("dialog", { name: "Nodi에 로그인" });
  await dialog.getByPlaceholder("name@example.com").fill(user.email);
  await dialog.getByPlaceholder("8자 이상").fill("test-password");
  await dialog.getByRole("button", { name: "로그인", exact: true }).click();
  for (const tab of [page, other]) {
    await expect(tab.getByRole("button", { name: "프로필 설정 열기", exact: true })).toBeVisible();
    await expect.poll(() => tab.evaluate(() => JSON.parse(localStorage.getItem("nodi:auth:session") ?? "null")?.userId)).toBe(user.id);
  }
  const navigations: string[] = [];
  for (const tab of [page, other]) tab.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) navigations.push(request.url()); });
  await page.waitForTimeout(1_000);
  expect(navigations).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:signed-out"))).toBeNull();
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
  await other.close();
});

for (const status of [200, 401]) {
  test(`a stale auth/me ${status} response cannot replace a newer explicit login`, async ({ page }) => {
    await openAccountModule(page);
    let releaseMe!: () => void;
    const gate = new Promise<void>((resolve) => { releaseMe = resolve; });
    let requestedMe = false;
    await page.route("**/api/auth/me", async (route) => {
      requestedMe = true;
      await gate;
      await route.fulfill(status === 200 ? { json: { data: user } }
        : { status, json: { error: { code: "INVALID_SESSION", message: "Old session expired" } } });
    });
    await page.route("**/api/auth/login", (route) => route.fulfill({ json: { data: { user: otherUser } } }));
    await page.evaluate(() => {
      (window as unknown as { pendingRestore: Promise<unknown> }).pendingRestore = import(/* @vite-ignore */ "/src/account-store.ts").then((account) => account.restoreServerAuth());
    });
    await expect.poll(() => requestedMe).toBe(true);
    expect(await page.evaluate(async () => {
      const account = await import(/* @vite-ignore */ "/src/account-store.ts");
      return (await account.loginLocalAccount("other@example.invalid", "test-password")).ok;
    })).toBe(true);
    releaseMe();
    await page.evaluate(() => (window as unknown as { pendingRestore: Promise<unknown> }).pendingRestore);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("nodi:auth:session") ?? "null")?.userId)).toBe(otherUser.id);
    expect(await page.evaluate(() => localStorage.getItem("nodi:workspace-owner"))).toBe(otherUser.id);
  });
}

test("a profile response received after logout cannot recreate the old session", async ({ page }) => {
  await openAccountModule(page);
  let releaseProfile!: () => void;
  const gate = new Promise<void>((resolve) => { releaseProfile = resolve; });
  let requestedProfile = false;
  await page.route("**/api/auth/me", async (route) => {
    requestedProfile = true;
    await gate;
    await route.fulfill({ json: { data: { ...user, name: "늦은 프로필" } } });
  });
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.evaluate(() => {
    (window as unknown as { pendingProfile: Promise<unknown> }).pendingProfile = import(/* @vite-ignore */ "/src/account-store.ts")
      .then((account) => account.updateLocalAccountProfile({ name: "늦은 프로필", avatarColor: "purple" }));
  });
  await expect.poll(() => requestedProfile).toBe(true);
  await page.evaluate(async () => (await import(/* @vite-ignore */ "/src/account-store.ts")).logoutLocalAccount());
  releaseProfile();
  const result = await page.evaluate(() => (window as unknown as { pendingProfile: Promise<{ ok: boolean }> }).pendingProfile);
  expect(result.ok).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:signed-out"))).toBe("true");
});
