import { expect, test, type Page } from "@playwright/test";
import type { ServerShare } from "../src/server-api";
import type { LocalAuthUser } from "../src/account-store";
import { documentEditor, makePage, mockWorkspace, openPage } from "./workspace-fixture";

const owner: LocalAuthUser = { id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid", role: "member", avatarColor: "purple" };
const colleague = { ...owner, id: "00000000-0000-4000-8000-000000000002", name: "동료", email: "colleague@example.invalid" };
const sharedAt = "2026-10-03T00:00:00Z";

function childShare(permission: "view" | "edit"): ServerShare {
  return { pageId: "page-2", owner, permission: "owner", updatedAt: sharedAt, members: [{
    user: colleague, permission, sharedAt, inheritedFromPageId: "page-1", inheritedFromTitle: "페이지 1",
  }] };
}

async function sharingWorkspace(page: Page) {
  const server = await mockWorkspace(page);
  server.pages["page-2"].parentId = "page-1";
  await page.route("**/api/auth/users?*", route => route.fulfill({ json: { data: [colleague] } }));
  return server;
}

test("inherited edit access identifies its source and cannot be removed from the child", async ({ page }) => {
  const server = await sharingWorkspace(page);
  const share = childShare("edit");
  await page.route("**/api/shares", route => route.fulfill({ json: { data: [share] } }));
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await page.getByRole("button", { name: "공유", exact: true }).click();
  await expect(page.getByText("“페이지 1”에서 상속 · 상위 페이지에서 관리")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "동료 공유 권한" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "동료 공유 해제" })).toBeDisabled();
  expect(server.failures).toEqual([]);
});

test("a child can add edit access above inherited view despite an older share poll", async ({ page }) => {
  const server = await sharingWorkspace(page);
  let share = childShare("view");
  let holdNext = false;
  let releaseOld: (() => void) | undefined;
  let freshAfterMutation = false;
  await page.route("**/api/shares", async route => {
    const snapshot = share;
    if (holdNext) {
      holdNext = false;
      await new Promise<void>(resolve => { releaseOld = resolve; });
    } else if (snapshot.members[0].directPermission) freshAfterMutation = true;
    await route.fulfill({ json: { data: [snapshot] } });
  });
  await page.route("**/api/pages/page-2/shares", route => route.fulfill({ json: { data: share } }));
  await page.route("**/api/pages/page-2/shares/*", async route => {
    expect(route.request().postDataJSON()).toEqual({ permission: "edit" });
    share = { ...share, members: [{ user: colleague, permission: "edit", directPermission: "edit", sharedAt }] };
    await route.fulfill({ json: { data: share.members[0] } });
  });
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await page.getByRole("button", { name: "공유", exact: true }).click();
  const permission = page.getByRole("combobox", { name: "동료 공유 권한" });
  await expect(permission).toHaveText("보기만");
  await expect(page.getByRole("button", { name: "동료 공유 해제" })).toBeDisabled();
  // Opening the inbox forces a poll without relying on the periodic timer.
  holdNext = true;
  await page.getByRole("button", { name: "받은 편지함", exact: true }).click();
  await expect.poll(() => Boolean(releaseOld)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "공유", exact: true }).click();
  await permission.click();
  await page.getByRole("option", { name: "편집 가능", exact: true }).click();
  await expect.poll(() => freshAfterMutation).toBe(true);
  await expect(permission).toHaveText("편집 가능");
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/shares");
  releaseOld!();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("button", { name: "동료 공유 해제" })).toBeEnabled();
  await expect(permission).toHaveText("편집 가능");
  expect(server.failures).toEqual([]);
});

async function unknownChildWorkspace(page: Page) {
  const server = await mockWorkspace(page);
  server.pages["page-1"].blocks.push({ id: "child-link", type: "childPage", props: { pageId: "new-child", title: "새 하위 페이지" } });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  server.pages["new-child"] = { ...makePage("new-child", "서버 하위 페이지", "CHILD SERVER CONTENT"), parentId: "page-1" };
  return server;
}

test("a child created by another session loads on demand and saves to its own page", async ({ page }) => {
  const server = await unknownChildWorkspace(page);
  await page.locator(".child-page-block").click();
  await expect(page.getByRole("textbox", { name: "미리보기 페이지 제목" })).toHaveValue("서버 하위 페이지");
  const preview = page.locator('[role="dialog"] .bn-editor[contenteditable=true]');
  await expect(preview).toContainText("CHILD SERVER CONTENT");
  await preview.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" CHILD EDIT");
  await expect.poll(() => JSON.stringify(server.pages["new-child"].blocks)).toContain("CHILD EDIT");
  expect(JSON.stringify(server.pages["page-1"].blocks)).not.toContain("CHILD EDIT");
  expect(server.failures).toEqual([]);
});

test("a delayed child lookup cannot open a preview after navigating elsewhere", async ({ page }) => {
  const server = await unknownChildWorkspace(page);
  let release: (() => void) | undefined;
  let finished = false;
  await page.route("**/api/pages/new-child", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { data: server.pages["new-child"] } });
    finished = true;
  });
  await page.locator(".child-page-block").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  release!();
  await expect.poll(() => finished).toBe(true);
  await expect(page.getByRole("textbox", { name: "미리보기 페이지 제목" })).toHaveCount(0);
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  expect(server.failures).toEqual([]);
});
