import { test, expect } from "@playwright/test";
import { mockWorkspace, documentEditor, editDocument, savedPages } from "./workspace-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a title typed during a conflict fetch survives merging and saving", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "HYDRATED TITLE";
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("HYDRATED TITLE");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  const started = deferred(), release = deferred();
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { data: server.pages["page-1"] } });
  });
  server.pages["page-1"] = {
    ...server.pages["page-1"], revision: 2,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "REMOTE BODY" }],
  };
  await editDocument(page, " LOCAL BODY");
  await page.clock.runFor(800);
  await started.promise;
  await title.fill("NEW TITLE DURING FETCH");
  expect((await savedPages(page))["page-1"].title).toBe("NEW TITLE DURING FETCH");
  release.resolve();
  const keepLocal = page.getByRole("button", { name: "내 변경 저장", exact: true });
  await expect(keepLocal).toBeVisible();
  await expect(title).toHaveValue("NEW TITLE DURING FETCH");
  await keepLocal.click();
  await page.clock.runFor(1500);
  await expect.poll(() => server.pages["page-1"].title).toBe("NEW TITLE DURING FETCH");
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("LOCAL BODY");
  await page.reload();
  await expect(title).toHaveValue("NEW TITLE DURING FETCH");
  await expect(documentEditor(page)).toContainText("LOCAL BODY");
  expect(server.failures).toEqual([]);
});

test("background revalidation preserves a title still waiting for its server save", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "HYDRATED TITLE";
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("HYDRATED TITLE");
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  const started = deferred(), release = deferred();
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { data: server.pages["page-1"] } });
  });
  server.pages["page-1"] = {
    ...server.pages["page-1"], revision: 2,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "REMOTE BODY" }],
  };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await started.promise;
  await title.fill("TITLE DURING REVALIDATION");
  const response = page.waitForResponse((result) => result.url().endsWith("/api/pages/page-1"));
  release.resolve();
  await response;
  await expect(title).toHaveValue("TITLE DURING REVALIDATION");
  await page.clock.resume();
  await expect.poll(() => server.pages["page-1"].title).toBe("TITLE DURING REVALIDATION");
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("REMOTE BODY");
  await page.reload();
  await expect(title).toHaveValue("TITLE DURING REVALIDATION");
  expect(server.failures).toEqual([]);
});

test("bootstrap cache failure still loads the latest page and resumes saving after recovery", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "BEFORE BOOTSTRAP TITLE";
  await page.goto("/?page=page-1");
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await expect(title).toHaveValue("BEFORE BOOTSTRAP TITLE");
  await expect.poll(async () => (await savedPages(page))["page-1"].title).toBe("BEFORE BOOTSTRAP TITLE");
  server.pages["page-1"] = {
    ...server.pages["page-1"], title: "LATEST REMOTE TITLE", revision: 2,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "LATEST REMOTE BODY" }],
  };
  await page.evaluate(() => localStorage.setItem("block-bootstrap-cache", "true"));
  await page.addInitScript(() => {
    if (!localStorage.getItem("block-bootstrap-cache")) return;
    const state = window as typeof window & { allowCacheWrites: boolean; blockedCacheWrites: number };
    state.allowCacheWrites = false;
    state.blockedCacheWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "nodi:pages" && !state.allowCacheWrites) {
        state.blockedCacheWrites += 1;
        throw new DOMException("Injected bootstrap quota", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  await page.reload();
  await page.waitForFunction(() => (window as typeof window & { blockedCacheWrites: number }).blockedCacheWrites > 0);
  await expect(title).toHaveValue("LATEST REMOTE TITLE");
  await expect(documentEditor(page)).toContainText("LATEST REMOTE BODY");

  await page.evaluate(() => { (window as typeof window & { allowCacheWrites: boolean }).allowCacheWrites = true; });
  await editDocument(page, " BODY AFTER RECOVERY");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("BODY AFTER RECOVERY");
  expect(server.pages["page-1"].title).toBe("LATEST REMOTE TITLE");
  expect(server.writes.filter(({ id, patch }) => id === "page-1" && patch.title === "BEFORE BOOTSTRAP TITLE")).toEqual([]);
  await expect.poll(async () => JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("BODY AFTER RECOVERY");

  await page.evaluate(() => localStorage.removeItem("block-bootstrap-cache"));
  await page.reload();
  await expect(title).toHaveValue("LATEST REMOTE TITLE");
  await expect(documentEditor(page)).toContainText("LATEST REMOTE BODY");
  await expect(documentEditor(page)).toContainText("BODY AFTER RECOVERY");
  expect(server.pages["page-1"].title).toBe("LATEST REMOTE TITLE");
  expect(server.failures).toEqual([]);
});
