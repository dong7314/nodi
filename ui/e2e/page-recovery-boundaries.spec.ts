import { expect, test } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

for (const choice of ["local", "remote"] as const) {
  test(`an initial websocket snapshot preserves a recovered conflict until the ${choice} choice`, async ({ page }) => {
    const server = await mockWorkspace(page);
    const sharedOwner = "00000000-0000-4000-8000-000000000002";
    server.pages["page-1"] = {
      ...server.pages["page-1"], title: "WS REVISION TWO", permission: "edit", ownerId: sharedOwner, revision: 2,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "REMOTE REVISION TWO" }],
    };
    await page.addInitScript((ownerId) => {
      if (localStorage.getItem("recovery-boundary-seeded")) return;
      localStorage.setItem("recovery-boundary-seeded", "true");
      const pages = JSON.parse(localStorage.getItem("nodi:pages")!);
      const base = { ...pages["page-1"], permission: "edit", ownerId };
      const draft = {
        ...base, updatedAt: new Date().toISOString(),
        blocks: [{ id: "page-1-block", type: "paragraph", content: "RECOVERED UNSAVED LOCAL" }],
      };
      pages["page-1"] = draft;
      localStorage.setItem("nodi:pages", JSON.stringify(pages));
      localStorage.setItem("nodi:page-draft:page-1", JSON.stringify({ base, page: draft }));
    }, sharedOwner);
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    await page.route("**/api/pages?*", async (route) => {
      await bootstrapGate;
      return route.fallback();
    });
    await page.goto("/?page=page-1");
    await expect.poll(() => server.sockets.has("page-1")).toBe(true);
    await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("WS REVISION TWO");
    const chooseLocal = page.getByRole("button", { name: "내 변경 저장", exact: true });
    await expect(chooseLocal).toBeVisible();
    await expect(documentEditor(page)).toContainText("RECOVERED UNSAVED LOCAL");
    expect(await page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("RECOVERED UNSAVED LOCAL");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("REMOTE REVISION TWO");

    server.pages["page-1"] = {
      ...server.pages["page-1"], revision: 3,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "REMOTE REVISION THREE" }],
    };
    server.send("page-1", {
      type: "page.updated", page: server.pages["page-1"], actorId: sharedOwner,
      changedBlockIds: ["page-1-block"], deletedBlockIds: [], structural: false,
    });
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nodi:pages")!)["page-1"].revision)).toBe(3);
    await expect(chooseLocal).toBeVisible();
    await expect(documentEditor(page)).toContainText("RECOVERED UNSAVED LOCAL");

    const bootstrapResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pages");
    releaseBootstrap();
    await bootstrapResponse;
    await expect(chooseLocal).toBeVisible();
    await expect(documentEditor(page)).toContainText("RECOVERED UNSAVED LOCAL");
    const selectedText = choice === "local" ? "RECOVERED UNSAVED LOCAL" : "REMOTE REVISION THREE";
    await page.getByRole("button", { name: choice === "local" ? "내 변경 저장" : "서버 내용 사용", exact: true }).click();
    await expect(chooseLocal).toHaveCount(0);
    await expect(documentEditor(page)).toContainText(selectedText);
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain(selectedText);
    // A later edit also has to leave the selected version intact with the
    // existing socket open, rather than revive its discarded draft.
    await editDocument(page, " AFTER_RESOLUTION");
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("AFTER_RESOLUTION");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain(selectedText);
    await page.reload();
    await expect(documentEditor(page)).toContainText(selectedText);
    await expect(documentEditor(page)).toContainText("AFTER_RESOLUTION");
    await expect(chooseLocal).toHaveCount(0);
    expect(server.failures).toEqual([]);
  });

  test(`aggregate quota during a 409 merge still requires the ${choice} conflict choice`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].title = "SERVER READY";
    await page.goto("/?page=page-1");
    const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
    await expect(title).toHaveValue("SERVER READY");
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      (window as typeof window & { restorePageCacheWrites: () => void }).restorePageCacheWrites = () => {
        Storage.prototype.setItem = setItem;
      };
      Storage.prototype.setItem = function(key: string, value: string) {
        if (this === localStorage && key === "nodi:pages") throw new DOMException("Full page cache", "QuotaExceededError");
        return setItem.call(this, key, value);
      };
    });
    server.pages["page-1"] = {
      ...server.pages["page-1"], revision: 2,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "REMOTE UNSAVED CONFLICT" }],
    };
    await editDocument(page, " LOCAL CONFLICT");
    const chooseLocal = page.getByRole("button", { name: "내 변경 저장", exact: true });
    await expect(chooseLocal).toBeVisible();
    expect(server.writes.filter((write) => write.id === "page-1")).toHaveLength(1);
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await title.fill("FOLLOWUP TITLE");
    await page.clock.runFor(1_500);
    // Subsequent edits cannot use the now-current revision to silently bypass
    // the conflict just because saving the merged aggregate cache failed.
    await expect(chooseLocal).toBeVisible();
    expect(server.pages["page-1"].title).toBe("SERVER READY");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("REMOTE UNSAVED CONFLICT");
    expect(server.writes.filter((write) => write.id === "page-1")).toHaveLength(1);
    await page.clock.resume();
    await page.getByRole("button", { name: choice === "local" ? "내 변경 저장" : "서버 내용 사용", exact: true }).click();
    const selectedText = choice === "local" ? "LOCAL CONFLICT" : "REMOTE UNSAVED CONFLICT";
    const selectedTitle = choice === "local" ? "FOLLOWUP TITLE" : "SERVER READY";
    await expect(chooseLocal).toHaveCount(0);
    await expect(documentEditor(page)).toContainText(selectedText);
    await expect.poll(() => server.pages["page-1"].title).toBe(selectedTitle);
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain(selectedText);
    // Resolving the conflict must work even while aggregate writes still fail.
    // Restore them only after the chosen content is confirmed on the server.
    await page.evaluate(() => (window as typeof window & { restorePageCacheWrites: () => void }).restorePageCacheWrites());
    await editDocument(page, " AFTER_RESOLUTION");
    await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("AFTER_RESOLUTION");
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain(selectedText);
    await page.reload();
    await expect(title).toHaveValue(selectedTitle);
    await expect(documentEditor(page)).toContainText(selectedText);
    await expect(documentEditor(page)).toContainText("AFTER_RESOLUTION");
    await expect(chooseLocal).toHaveCount(0);
    expect(server.failures).toEqual([]);
  });
}

test("a server clock ahead by one minute cannot hide a newer journal after aggregate quota", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "SERVER READY";
  server.pages["page-1"].updatedAt = new Date(Date.now() + 60_000).toISOString();
  let offline = true;
  await page.route("**/api/pages/page-1", async (route) => {
    if (offline && route.request().method() === "PATCH") return route.fulfill({
      status: 503, json: { error: { code: "UNAVAILABLE", message: "Offline save" } },
    });
    return route.fallback();
  });
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("SERVER READY");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:pages") throw new DOMException("Full page cache", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await title.fill("JOURNAL LATEST TITLE");
  await editDocument(page, " JOURNAL LATEST BODY");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("JOURNAL LATEST TITLE");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("JOURNAL LATEST BODY");
  const before = await page.evaluate(() => ({
    cached: JSON.parse(localStorage.getItem("nodi:pages")!)["page-1"],
    journal: JSON.parse(localStorage.getItem("nodi:page-draft:page-1")!).page,
  }));
  expect(before.cached.title).toBe("SERVER READY");
  expect(Date.parse(before.cached.updatedAt)).toBeGreaterThan(Date.parse(before.journal.updatedAt));
  await page.reload();
  await expect(title).toHaveValue("JOURNAL LATEST TITLE");
  await expect(documentEditor(page)).toContainText("JOURNAL LATEST BODY");
  offline = false;
  await editDocument(page, " BACK_ONLINE");
  await expect.poll(() => server.pages["page-1"].title).toBe("JOURNAL LATEST TITLE");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("BACK_ONLINE");
  await page.reload();
  await expect(title).toHaveValue("JOURNAL LATEST TITLE");
  await expect(documentEditor(page)).toContainText("JOURNAL LATEST BODY");
  await expect(documentEditor(page)).toContainText("BACK_ONLINE");
  expect(server.failures).toEqual([]);
});

test("an unrelated edit in a stale tab cannot promote its old cache above a newer journal", async ({ page, context }) => {
  const first = await mockWorkspace(page);
  first.pages["page-1"].title = "FIRST BOOTSTRAP READY";
  let offline = true;
  await page.route("**/api/pages/page-1", (route) => offline && route.request().method() === "PATCH"
    ? route.fulfill({ status: 503, json: { error: { code: "OFFLINE" } } }) : route.fallback());
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("FIRST BOOTSTRAP READY");

  const other = await context.newPage();
  const second = await mockWorkspace(other);
  let releaseBootstrap!: () => void;
  const gate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  let pendingBootstrap = false;
  await other.route("**/api/pages?*", async (route) => {
    pendingBootstrap = true;
    await gate;
    if (!other.isClosed()) return route.fallback();
  });
  await other.goto("/?page=page-2");
  await expect(documentEditor(other)).toHaveText("PAGE TWO ORIGINAL");
  await expect.poll(() => pendingBootstrap).toBe(true);
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  // Only A's aggregate write fails. B can later serialize its cached pages,
  // including a stale page-1 object that B has not previously written.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:pages" && value.includes("LATEST_JOURNAL_ONLY")) {
        throw new DOMException("Whole cache quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await editDocument(page, " LATEST_JOURNAL_ONLY");
  const before = await page.evaluate(() => ({
    cached: JSON.parse(localStorage.getItem("nodi:pages") ?? "{}")["page-1"],
    journal: JSON.parse(localStorage.getItem("nodi:page-draft:page-1") ?? "null")?.page,
  }));
  expect(JSON.stringify(before.cached.blocks)).not.toContain("LATEST_JOURNAL_ONLY");
  expect(JSON.stringify(before.journal.blocks)).toContain("LATEST_JOURNAL_ONLY");
  await other.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("UNRELATED PAGE TWO TITLE");
  const after = await page.evaluate(() => ({
    cached: JSON.parse(localStorage.getItem("nodi:pages") ?? "{}")["page-1"],
    journal: JSON.parse(localStorage.getItem("nodi:page-draft:page-1") ?? "null")?.page,
  }));
  expect(after.cached.localWriteOrder ?? 0).toBe(before.cached.localWriteOrder ?? 0);
  expect(after.cached.localWriteOrder ?? 0).toBeLessThan(after.journal.localWriteOrder);
  expect(JSON.stringify(after.cached.blocks)).not.toContain("LATEST_JOURNAL_ONLY");
  await other.close();
  releaseBootstrap();
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL LATEST_JOURNAL_ONLY");
  expect(await page.evaluate(() => localStorage.getItem("nodi:page-draft:page-1"))).toContain("LATEST_JOURNAL_ONLY");

  offline = false;
  await page.clock.resume();
  await editDocument(page, " BACK_ONLINE");
  await expect.poll(() => JSON.stringify(first.pages["page-1"].blocks)).toContain("LATEST_JOURNAL_ONLY BACK_ONLINE");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL LATEST_JOURNAL_ONLY BACK_ONLINE");
  expect(first.failures).toEqual([]);
  expect(second.failures).toEqual([]);
});
