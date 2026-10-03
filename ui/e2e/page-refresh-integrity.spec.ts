import { expect, test, type Page } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

async function blockPageCache(page: Page) {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as typeof window & { restorePageCache: () => void }).restorePageCache = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === "nodi:pages") throw new DOMException("Full page cache", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
}

for (const quota of [false, true]) {
  test(`a delayed peer bootstrap preserves another tab's latest draft with aggregate quota=${quota}`, async ({ page, context }) => {
    const first = await mockWorkspace(page);
    first.pages["page-1"].title = "FIRST READY";
    await page.route("**/api/pages/page-1", route => route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
    await page.goto("/?page=page-1");
    await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("FIRST READY");

    const other = await context.newPage();
    const second = await mockWorkspace(other);
    second.pages["page-2"].title = "SECOND READY";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending = false;
    await other.route("**/api/pages?*", async route => { pending = true; await gate; return route.fallback(); });
    // Recovered drafts must remain available even if this tab's autosave fails.
    await other.route("**/api/pages/page-1", route => route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
    await other.goto("/?page=page-2");
    await expect.poll(() => pending).toBe(true);
    await expect(documentEditor(other)).toHaveText("PAGE TWO ORIGINAL");
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    if (quota) await blockPageCache(page);
    await editDocument(page, " LATEST_FROM_TAB_A");
    expect(await page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("LATEST_FROM_TAB_A");

    release();
    await expect(other.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("SECOND READY");
    expect(await page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("LATEST_FROM_TAB_A");
    expect(await page.evaluate(() => localStorage.getItem("nodi:pages"))).toContain("LATEST_FROM_TAB_A");
    await other.close();
    await page.reload();
    await expect(documentEditor(page)).toContainText("LATEST_FROM_TAB_A");
    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
  });
}

for (const choice of ["local", "remote"] as const) {
  test(`shared list refresh keeps a dirty conflict until the ${choice} choice`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].title = "READY TITLE";
    await page.goto("/?page=page-1");
    await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("READY TITLE");
    let offline = true, failed = 0;
    await page.route("**/api/pages/page-1", route => {
      if (offline && route.request().method() === "PATCH") {
        failed++;
        return route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } });
      }
      return route.fallback();
    });
    await editDocument(page, " UNSAVED LOCAL BODY");
    await expect.poll(() => failed).toBeGreaterThan(0);
    server.pages["page-1"] = {
      ...server.pages["page-1"], revision: 2,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "NEW REMOTE BODY TO PROTECT" }],
    };
    const listed = page.waitForResponse(r => new URL(r.url()).pathname === "/api/pages");
    await page.getByRole("button", { name: /^공유 페이지/ }).click();
    await listed;
    offline = false;
    await page.locator('[data-sidebar-page-id="page-1"]').first().click();
    await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).toBeVisible();
    await editDocument(page, " ANOTHER LOCAL EDIT");
    await page.keyboard.press("ControlOrMeta+s");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("NEW REMOTE BODY TO PROTECT");
    expect(server.writes).toHaveLength(0);
    await page.getByRole("button", { name: choice === "local" ? "내 변경 저장" : "서버 내용 사용", exact: true }).click();
    const expected = choice === "local" ? "ANOTHER LOCAL EDIT" : "NEW REMOTE BODY TO PROTECT";
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain(expected);
    await page.reload();
    await expect(documentEditor(page)).toContainText(expected);
    expect(server.failures).toEqual([]);
  });
}

test("peer bootstrap retains independent edits made in both tabs while the request was pending", async ({ page, context }) => {
  const first = await mockWorkspace(page);
  first.pages["page-1"].title = "FIRST READY";
  await page.route("**/api/pages/page-1", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("FIRST READY");
  const other = await context.newPage();
  const second = await mockWorkspace(other);
  second.pages["page-1"].title = "FIRST READY";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending = false;
  await other.route("**/api/pages?*", async route => { pending = true; await gate; return route.fallback(); });
  await other.route("**/api/pages/page-1", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
  await other.goto("/?page=page-1");
  await expect.poll(() => pending).toBe(true);
  await other.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("TITLE FROM TAB B");
  await editDocument(page, " BODY FROM TAB A");
  release();
  await expect(documentEditor(other)).toContainText("BODY FROM TAB A");
  await expect(other.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("TITLE FROM TAB B");
  await expect.poll(() => other.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("TITLE FROM TAB B");
  await page.close();
  await other.reload();
  await expect(documentEditor(other)).toContainText("BODY FROM TAB A");
  await expect(other.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("TITLE FROM TAB B");
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
});

test("shared list refresh merges independent server fields into the dirty active editor", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "READY TITLE";
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("READY TITLE");
  let offline = true, failed = 0;
  await page.route("**/api/pages/page-1", route => {
    if (offline && route.request().method() === "PATCH") {
      failed++;
      return route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } });
    }
    return route.fallback();
  });
  await editDocument(page, " LOCAL BODY");
  await expect.poll(() => failed).toBeGreaterThan(0);
  server.pages["page-1"] = { ...server.pages["page-1"], title: "REMOTE TITLE", revision: 2 };
  const listed = page.waitForResponse(r => new URL(r.url()).pathname === "/api/pages");
  await page.getByRole("button", { name: /^공유 페이지/ }).click();
  await listed;
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nodi:pages")!)["page-1"].title)).toBe("REMOTE TITLE");
  offline = false;
  await page.locator('[data-sidebar-page-id="page-1"]').first().click();
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("REMOTE TITLE");
  await expect(documentEditor(page)).toContainText("LOCAL BODY");
  await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).toHaveCount(0);
  await editDocument(page, " NEXT EDIT");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("NEXT EDIT");
  expect(server.pages["page-1"].title).toBe("REMOTE TITLE");
  expect(server.failures).toEqual([]);
});

for (const transport of ["http", "websocket"] as const) {
  test(`a ${transport} refresh completes the editor update even when aggregate caching fails`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].title = "READY TITLE";
    if (transport === "websocket") server.pages["page-1"].permission = "edit";
    await page.goto("/?page=page-1");
    const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
    await expect(title).toHaveValue("READY TITLE");
    if (transport === "websocket") await expect.poll(() => server.sockets.has("page-1")).toBe(true);
    await blockPageCache(page);
    server.pages["page-1"] = {
      ...server.pages["page-1"], title: "NEW REMOTE TITLE", revision: 2,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "NEW REMOTE BODY TO PROTECT" }],
    };
    if (transport === "http") await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    else server.send("page-1", { type: "page.updated", page: server.pages["page-1"], structural: true });
    await expect(title).toHaveValue("NEW REMOTE TITLE");
    await expect(documentEditor(page)).toHaveText("NEW REMOTE BODY TO PROTECT");
    await page.evaluate(() => (window as typeof window & { restorePageCache: () => void }).restorePageCache());
    await editDocument(page, " NEXT EDIT AFTER QUOTA");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("NEXT EDIT AFTER QUOTA");
    expect(server.pages["page-1"].title).toBe("NEW REMOTE TITLE");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("NEW REMOTE BODY TO PROTECT");
    expect(server.failures).toEqual([]);
  });
}
