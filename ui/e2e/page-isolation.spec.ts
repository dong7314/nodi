import { test, expect } from "@playwright/test";
import { documentEditor, editDocument, makePage, mockWorkspace, openPage, savedPages } from "./workspace-fixture";

test("undo and redo never restore a different page or persist its blocks", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await editDocument(page, " second edit");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await editDocument(page, " first edit");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL first edit");
  // Going past the page's own edits used to undo the navigation replacement.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(async () => JSON.stringify((await savedPages(page))["page-1"].blocks)).not.toContain("PAGE TWO");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).not.toContain("PAGE TWO");
  await openPage(page, "page-2", "PAGE TWO ORIGINAL second edit");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL second edit");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  expect(server.writes.filter(({ id }) => id === "page-1").some(({ patch }) => JSON.stringify(patch.blocks).includes("PAGE TWO"))).toBe(false);
  expect(server.failures).toEqual([]);
});

test("opening a page clears redo from the previous page", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await editDocument(page, " second edit");
  await page.keyboard.press("ControlOrMeta+z");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await documentEditor(page).click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});

test("rapid navigation preserves each page's title, settings and blocks", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].settings.cover = "sunset";
  server.pages["page-2"].settings.cover = "ocean";
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await editDocument(page, " second edit");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await page.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("페이지 1 수정");
  await editDocument(page, " first edit");
  await openPage(page, "page-2", "PAGE TWO ORIGINAL second edit");
  await expect(page.locator(".cover--ocean")).toBeVisible();
  await openPage(page, "page-1", "PAGE ONE ORIGINAL first edit");
  await expect(page.locator(".cover--sunset")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("페이지 1 수정");
  await expect.poll(() => server.pages["page-1"].title).toBe("페이지 1 수정");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).toContain("second edit");
  expect(server.pages["page-2"].title).toBe("페이지 2");
  expect(server.pages["page-2"].settings.cover).toBe("ocean");
  expect(server.failures).toEqual([]);
});

test("initial server hydration cannot be undone into stale cached content", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-2"] = { ...makePage("page-2", "페이지 2", "SERVER TWO LATEST"), revision: 5 };
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("SERVER TWO LATEST");
  await documentEditor(page).click();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("SERVER TWO LATEST");
  expect(server.failures).toEqual([]);
});

test("background server snapshots are not undoable document replacements", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  server.pages["page-1"] = { ...makePage("page-1", "페이지 1", "REMOTE ONE LATEST"), revision: 2 };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(documentEditor(page)).toHaveText("REMOTE ONE LATEST");
  await editDocument(page, " local edit");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("REMOTE ONE LATEST");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).toHaveText("REMOTE ONE LATEST");
  expect(server.failures).toEqual([]);
});

test("a delayed page response cannot overwrite edits made while it was in flight", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started();
    await gate;
    await route.fulfill({ json: { data: { ...makePage("page-1", "페이지 1", "DELAYED REMOTE COPY"), revision: 2 } } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await inFlight;
  await editDocument(page, " unsaved local edit");
  const response = page.waitForResponse((value) => value.url().endsWith("/api/pages/page-1") && value.request().method() === "GET");
  release();
  await response;
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("unsaved local edit");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL unsaved local edit");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).not.toContain("DELAYED");
  expect(server.failures).toEqual([]);
});

test("revoking access replaces the shared editor before any home save", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-2"].permission = "edit";
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await expect.poll(() => server.sockets.has("page-2")).toBe(true);
  server.send("page-2", { type: "access.revoked" });
  await expect(page).toHaveURL((url) => !url.searchParams.has("page"));
  await expect(documentEditor(page)).not.toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await openPage(page, "quick-note", "HOME ORIGINAL");
  await expect(documentEditor(page)).toHaveText("HOME ORIGINAL");
  expect(JSON.stringify((await savedPages(page))["quick-note"].blocks)).not.toContain("PAGE TWO");
  expect(server.writes.filter(({ id }) => id === "quick-note").some(({ patch }) => JSON.stringify(patch.blocks)?.includes("PAGE TWO"))).toBe(false);
  expect(server.failures).toEqual([]);
});

test("undo keeps another participant's edit to a different block", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  server.pages["page-1"].blocks!.push({ id: "remote-block", type: "paragraph", content: "REMOTE ORIGINAL" });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("REMOTE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await documentEditor(page).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("LOCAL EDIT ");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("LOCAL EDIT");
  // Let the real client process its own echo before delivering another user's edit.
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  const remote = {
    ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
    blocks: [server.pages["page-1"].blocks![0], { id: "remote-block", type: "paragraph" as const, content: "REMOTE CHANGED" }],
  };
  server.pages["page-1"] = remote;
  server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", changedBlockIds: ["remote-block"], structural: false });
  await expect(documentEditor(page)).toContainText("REMOTE CHANGED");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).not.toContainText("LOCAL EDIT");
  await expect(documentEditor(page)).toContainText("REMOTE CHANGED");
  expect(server.failures).toEqual([]);
});

test("leaving a shared page flushes its pending edits to its own room", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-2"].permission = "edit";
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await expect.poll(() => server.sockets.has("page-2")).toBe(true);
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await editDocument(page, " pending shared edit");
  // Freeze the 70 ms debounce. Keyboard navigation must flush it itself.
  await page.locator('[data-sidebar-page-id="page-1"]').first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).toContain("pending shared edit");
  await page.clock.runFor(20);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).not.toContain("PAGE TWO");
  expect(server.failures).toEqual([]);
});

test("browser back and reload preserve the two saved documents", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await editDocument(page, " second edit");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).toContain("second edit");
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await editDocument(page, " first edit");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("first edit");
  await page.goBack();
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL second edit");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL second edit");
  await openPage(page, "page-1", "PAGE ONE ORIGINAL first edit");
  expect(server.failures).toEqual([]);
});
