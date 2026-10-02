import { expect, test } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

test("a newer journal restores before bootstrap and preserves typing while the server is loading", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "SERVER READY TITLE";
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("SERVER READY TITLE");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  // This deterministic storage fault isolates partial persistence: the small
  // journal succeeds while the aggregate cache retains its old snapshot.
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:pages" && value.includes("JOURNAL_ONLY_NEW")) {
        throw new DOMException("Full workspace does not fit", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await title.fill("JOURNAL_ONLY_NEW TITLE");
  await page.clock.runFor(350);
  await editDocument(page, " JOURNAL_ONLY_NEW");
  const before = await page.evaluate(() => ({
    cache: localStorage.getItem("nodi:pages"), journal: localStorage.getItem("nodi:page-draft:page-1"),
  }));
  expect(before.cache).not.toContain("JOURNAL_ONLY_NEW");
  expect(before.journal).toContain("JOURNAL_ONLY_NEW");
  let releaseBootstrap!: () => void;
  const bootstrapGate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  let requestedBootstrap = false;
  await page.route("**/api/pages?*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    requestedBootstrap = true;
    await bootstrapGate;
    return route.fallback();
  });
  await page.reload();
  await expect.poll(() => requestedBootstrap).toBe(true);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL JOURNAL_ONLY_NEW");
  await expect(title).toHaveValue("JOURNAL_ONLY_NEW TITLE");
  await page.clock.runFor(50);
  await editDocument(page, " TYPED_DURING_BOOTSTRAP");
  releaseBootstrap();
  await page.clock.resume();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL JOURNAL_ONLY_NEW TYPED_DURING_BOOTSTRAP");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("JOURNAL_ONLY_NEW TYPED_DURING_BOOTSTRAP");
  await expect.poll(() => server.pages["page-1"].title).toBe("JOURNAL_ONLY_NEW TITLE");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL JOURNAL_ONLY_NEW TYPED_DURING_BOOTSTRAP");
  await expect(title).toHaveValue("JOURNAL_ONLY_NEW TITLE");
  expect(server.failures).toEqual([]);
});

test("a shrinking journal survives real aggregate storage quota and reload", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-2"].title = "SERVER READY PAGE TWO";
  await page.route("**/api/pages/*", async (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({
      status: 503, json: { error: { code: "UNAVAILABLE", message: "Offline save" } },
    });
    return route.fallback();
  });
  await page.goto("/?page=page-2");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("SERVER READY PAGE TWO");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  const staleTitle = "OLD LOCAL TITLE ".repeat(7).trim();
  await title.fill(staleTitle);
  await page.clock.runFor(350);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("nodi:page-draft:page-2") ?? "null")?.page.title)).toBe(staleTitle);
  await page.locator('[data-sidebar-page-id="page-1"]').first().click();
  await page.clock.runFor(50);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  const quotaReached = await page.evaluate(() => {
    let exhausted = false;
    try {
      for (let index = 0; index < 512; index += 1) localStorage.setItem(`draft-quota-large-${index}`, "f".repeat(64 * 1024));
    } catch (error) { exhausted = error instanceof DOMException && error.name === "QuotaExceededError"; }
    try {
      for (let index = 0; index < 128; index += 1) localStorage.setItem(`draft-quota-small-${index}`, "f".repeat(1024));
    } catch { /* Leave less than 1 KiB free without mocking Storage.setItem. */ }
    return exhausted;
  });
  expect(quotaReached).toBe(true);
  // This unsaved page makes the aggregate cache grow. A subsequent shorter
  // title on another page shrinks its existing journal and still fits quota.
  await editDocument(page, ` UNSAVED_LARGE_PAGE_ONE_${"x".repeat(32 * 1024)}`);
  expect(await page.evaluate(() => localStorage.getItem("nodi:pages"))).not.toContain("UNSAVED_LARGE_PAGE_ONE");
  await page.locator('[data-sidebar-page-id="page-2"]').first().click();
  await page.clock.runFor(50);
  await title.fill("NEW JOURNAL");
  await page.clock.runFor(350);
  const before = await page.evaluate(() => ({
    cached: JSON.parse(localStorage.getItem("nodi:pages") ?? "{}")["page-2"].title,
    journal: JSON.parse(localStorage.getItem("nodi:page-draft:page-2") ?? "null")?.page.title,
  }));
  expect(before.cached).toBe(staleTitle);
  expect(before.journal).toBe("NEW JOURNAL");
  await page.reload();
  await expect(title).toHaveValue("NEW JOURNAL");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nodi:page-draft:page-2") ?? "null")?.page.title)).toBe("NEW JOURNAL");
  await page.clock.runFor(1_000);
  await expect(title).toHaveValue("NEW JOURNAL");
  expect(server.failures).toEqual([]);
});

test("an older journal cannot replace a newer full-cache snapshot", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "SERVER READY TITLE";
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("SERVER READY TITLE");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await title.fill("OLD JOURNAL TITLE");
  await page.clock.runFor(350);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key === "nodi:page-draft:page-1") {
        throw new DOMException("Journal write failed", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  // Exercise the real write order: the later UI edit reaches the aggregate
  // cache while the failed journal write leaves the previous draft behind.
  await title.fill("LATEST FULL CACHE TITLE");
  await page.clock.runFor(350);
  const before = await page.evaluate(() => ({
    cache: JSON.parse(localStorage.getItem("nodi:pages")!)["page-1"].title,
    journal: JSON.parse(localStorage.getItem("nodi:page-draft:page-1")!).page.title,
  }));
  expect(before.cache).toBe("LATEST FULL CACHE TITLE");
  expect(before.journal).toBe("OLD JOURNAL TITLE");
  await page.reload();
  await expect(title).toHaveValue("LATEST FULL CACHE TITLE");
  await page.clock.resume();
  await expect.poll(() => server.pages["page-1"].title).toBe("LATEST FULL CACHE TITLE");
  await page.reload();
  await expect(title).toHaveValue("LATEST FULL CACHE TITLE");
  expect(server.failures).toEqual([]);
});
