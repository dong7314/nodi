import { test, expect, type Page } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace, savedPages } from "./workspace-fixture";

const userId = "00000000-0000-4000-8000-000000000001";

async function fillPasswordSettings(page: Page, password: string) {
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByPlaceholder("현재 비밀번호", { exact: true }).fill("old-password");
  await page.getByPlaceholder("8자 이상", { exact: true }).fill(password);
  await page.getByPlaceholder("새 비밀번호 다시 입력", { exact: true }).fill(password);
}

test("password settings reject passwords exceeding 72 UTF-8 bytes before sending", async ({ page }) => {
  const server = await mockWorkspace(page);
  let writes = 0;
  await page.route("**/api/auth/change-password", async (route) => { writes++; await route.fulfill({ status: 204 }); });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await fillPasswordSettings(page, "x".repeat(73));
  for (const password of ["x".repeat(73), "가".repeat(25), "🔒".repeat(19)]) {
    await page.getByPlaceholder("8자 이상", { exact: true }).fill(password);
    await page.getByPlaceholder("새 비밀번호 다시 입력", { exact: true }).fill(password);
    await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
    await expect(page.getByText("비밀번호는 UTF-8 기준 72바이트 이내로 입력해 주세요.", { exact: true })).toBeVisible();
  }
  expect(writes).toBe(0);
  expect(server.failures).toEqual([]);
});

test("password settings back up local drafts and await logout after a successful change", async ({ page }) => {
  const server = await mockWorkspace(page);
  let revoked = false, writes = 0;
  let logoutStarted!: () => void, releaseLogout!: () => void;
  const started = new Promise<void>((resolve) => { logoutStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "아직 저장되지 않은 초안" } } });
  });
  await page.route("**/api/auth/change-password", async (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ currentPassword: "old-password", nextPassword: "가".repeat(24) });
    const backup = await page.evaluate((id) => localStorage.getItem(`nodi:workspace-cache:${id}`), userId);
    expect(backup).toContain("PRIVATE PASSWORD DRAFT");
    revoked = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/me", (route) => revoked
    ? route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } }) : route.fallback());
  await page.route("**/api/auth/logout", async (route) => {
    logoutStarted(); await released; await route.fulfill({ status: 204 });
  });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await editDocument(page, " PRIVATE PASSWORD DRAFT");
  await fillPasswordSettings(page, "가".repeat(24));
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await started;
  await expect(page.getByRole("button", { name: "변경 중…", exact: true })).toBeDisabled();
  await page.getByPlaceholder("새 비밀번호 다시 입력", { exact: true }).press("Enter");
  expect(writes).toBe(1);
  releaseLogout();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBeNull();
  expect((await savedPages(page))["page-1"]).toBeUndefined();
  expect(await page.evaluate((id) => localStorage.getItem(`nodi:workspace-cache:${id}`), userId)).toContain("PRIVATE PASSWORD DRAFT");
  expect(server.failures).toEqual([]);
});

test("password settings show backup errors and keep both password and session unchanged", async ({ page }) => {
  const server = await mockWorkspace(page);
  let writes = 0;
  await page.route("**/api/auth/change-password", async (route) => { writes++; await route.fulfill({ status: 204 }); });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await fillPasswordSettings(page, "new-password");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("nodi:workspace-cache:")) throw new DOMException("test storage quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await expect(page.getByText("작성 중인 내용을 안전하게 보관할 저장 공간이 부족해요. 기존 내용은 유지했습니다. 공간을 확보한 뒤 다시 시도해 주세요.", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).not.toBeNull();
  expect((await savedPages(page))["page-1"]).toBeDefined();
  expect(server.failures).toEqual([]);
});
