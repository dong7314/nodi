import { test, expect } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace, openPage, savedPages } from "./workspace-fixture";
import { withDatabase } from "./database-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a recently edited and archived page can be restored without a revision conflict", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await editDocument(page, " saved edit");
  await expect.poll(() => server.pages["page-1"].revision).toBeGreaterThan(1);
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "페이지 삭제", exact: true }).click();
  await page.getByRole("button", { name: "휴지통으로 이동", exact: true }).click();
  await expect.poll(() => server.pages["page-1"].archived).toBe(true);
  await page.getByRole("button", { name: /^휴지통/ }).click();
  await page.getByRole("button", { name: "복원", exact: true }).click();
  await expect.poll(() => server.pages["page-1"].archived).toBe(false);
  await openPage(page, "page-1", "PAGE ONE ORIGINAL saved edit");
  expect(server.failures).toEqual([]);
});

test("a delayed shared list never replaces a newer local edit", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  const started = deferred();
  const release = deferred();
  await page.route("**/api/pages?*", async (route) => {
    const snapshot = structuredClone(Object.values(server.pages).filter((entry) => entry.id !== "quick-note"));
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { data: snapshot } });
  });
  await page.getByRole("button", { name: /^공유 페이지/ }).click();
  await started.promise;
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  await editDocument(page, " newer edit");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).toContain("newer edit");
  const response = page.waitForResponse((value) => value.url().includes("/api/pages?") && value.status() === 200);
  release.resolve();
  await response;
  await expect.poll(async () => JSON.stringify((await savedPages(page))["page-2"].blocks)).toContain("newer edit");
  expect(server.failures).toEqual([]);
});

test("refreshing unchanged sharing information keeps the current undo history", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const socket = server.sockets.get("page-1");
  await editDocument(page, " undo me");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("undo me");
  const response = page.waitForResponse((value) => value.url().endsWith("/api/shares"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
  await expect.poll(() => server.sockets.get("page-1") === socket).toBe(true);
  await documentEditor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});


test("leaving a page flushes pending table edits before its editor unmounts", async ({ page }) => {
  const { server, database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await page.getByRole("textbox", { name: "이름 값", exact: true }).fill("EDIT BEFORE LEAVING");
  await page.locator('[data-sidebar-page-id="page-2"]').first().focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(800);
  await expect.poll(() => database.state.records[0].values.name).toBe("EDIT BEFORE LEAVING");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("EDIT BEFORE LEAVING");
  expect(server.failures).toEqual([]);
});

test("slow table saves serialize revisions and preserve the newest edit", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  // Complete any initial hydration write before controlling the first edit.
  await page.clock.install();
  await page.clock.runFor(600);
  const started = deferred();
  const release = deferred();
  let first = true;
  await page.route("**/api/databases/audit-db", async (route) => {
    if (route.request().method() === "PUT" && first) {
      first = false;
      started.resolve();
      await release.promise;
    }
    return route.fallback();
  });
  await cell.fill("FIRST EDIT");
  await page.clock.runFor(600);
  await started.promise;
  await cell.fill("LATEST EDIT");
  await page.clock.runFor(600);
  release.resolve();
  await expect.poll(() => database.state.records[0].values.name).toBe("LATEST EDIT");
  await expect(cell).toHaveValue("LATEST EDIT");
});

test("editing the current page in its preview cannot be overwritten by the main editor", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  await preview.locator(".bn-editor[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" PREVIEW EDIT");
  await page.getByRole("textbox", { name: "미리보기 페이지 제목" }).fill("미리보기 수정 제목");
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(preview).not.toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(documentEditor(page)).toContainText("PREVIEW EDIT");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("미리보기 수정 제목");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("PREVIEW EDIT");
  await page.reload();
  await expect(documentEditor(page)).toContainText("PREVIEW EDIT");
  expect(server.failures).toEqual([]);
});

test("a locked page still offers settings so its owner can unlock it", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].settings.lockPage = true;
  await page.goto("/?page=page-1");
  await expect(page.locator(".bn-editor").first()).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "페이지 설정", exact: true }).click({ timeout: 3000 });
  await page.locator(".setting-toggle").filter({ hasText: "페이지 잠금" }).click();
  await page.getByRole("button", { name: "페이지 설정 닫기" }).click();
  await editDocument(page, " UNLOCKED EDIT");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("UNLOCKED EDIT");
  expect(server.failures).toEqual([]);
});

test("table revision conflicts retain the local draft across navigation", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  database.revision++;
  database.state = { ...database.state, records: [{ id: "record-1", values: { name: "REMOTE CELL" } }] };
  await cell.fill("MY UNSAVED CELL");
  await expect(page.getByText(/작성 내용은 이 브라우저에 보관/)).toBeVisible();
  await expect(cell).toHaveValue("MY UNSAVED CELL");
  expect(database.state.records[0].values.name).toBe("REMOTE CELL");
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await expect(cell).toHaveValue("MY UNSAVED CELL");
  expect(database.state.records[0].values.name).toBe("REMOTE CELL");
});

test("duplicating a database copies its rows into an independent database", async ({ page }) => {
  const { databases } = await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+d");
  const cells = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(1)).toHaveValue("ORIGINAL CELL");
  await cells.nth(1).fill("COPY ONLY");
  await expect.poll(() => Object.values(databases).some((value) => value.state.records[0]?.values.name === "COPY ONLY")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
});

test("returning a table cell to its original value cancels the older pending edit", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await cell.fill("TEMPORARY EDIT");
  await cell.fill("ORIGINAL CELL");
  await page.clock.runFor(800);
  expect(database.state.records[0].values.name).toBe("ORIGINAL CELL");
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await expect(cell).toHaveValue("ORIGINAL CELL");
});

test("copying a database to another page preserves rows without sharing its storage id", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await cell.fill("PAGE TWO COPY");
  await expect.poll(() => Object.values(databases).some((value) => value.state.records[0]?.values.name === "PAGE TWO COPY")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).not.toContain("audit-db");
  expect(server.failures).toEqual([]);
});

test("a remote table snapshot cannot replace an unsaved local cell", async ({ page }) => {
  const { server, database } = await withDatabase(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await cell.fill("LOCAL DRAFT");
  database.revision++;
  database.state = { ...database.state, records: [{ id: "record-1", values: { name: "REMOTE CELL" } }] };
  server.send("page-1", { type: "database.updated", actorId: "other-user", database: database as never });
  await page.clock.runFor(800);
  await expect(cell).toHaveValue("LOCAL DRAFT");
  await expect(page.getByText(/작성 내용은 이 브라우저에 보관/)).toBeVisible();
  expect(database.state.records[0].values.name).toBe("REMOTE CELL");
});
