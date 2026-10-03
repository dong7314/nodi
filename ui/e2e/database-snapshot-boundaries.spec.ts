import { expect, test, type Locator, type Page } from "@playwright/test";
import { withDatabase } from "./database-fixture";
import { documentEditor } from "./workspace-fixture";

const cellName = { name: "이름 값", exact: true } as const;

test("a memory-only table draft survives temporary loss of edit permission", async ({ page }) => {
  const { server } = await withDatabase(page);
  server.pages["page-1"].ownerId = "00000000-0000-4000-8000-000000000002";
  server.pages["page-1"].permission = "edit";
  await page.route("**/api/databases/audit-db", route => route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.fallback());
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("nodi:database:") || key.startsWith("nodi:database-draft:")) throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await cell.fill("PRESERVED MEMORY DRAFT");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  server.pages["page-1"].permission = "view";
  server.send("page-1", { type: "permission.updated", permission: "view" });
  await expect(cell).toBeDisabled();
  await expect(cell).toHaveValue("ORIGINAL CELL");
  server.pages["page-1"].permission = "edit";
  server.send("page-1", { type: "permission.updated", permission: "edit" });
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue("PRESERVED MEMORY DRAFT");
});

test("logout stops if an unsaved table cannot be included in the account backup", async ({ page }) => {
  await withDatabase(page);
  let logouts = 0;
  await page.route("**/api/auth/logout", route => { logouts++; return route.fulfill({ status: 204 }); });
  await page.route("**/api/databases/audit-db", route => route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.fallback());
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("nodi:database:") || key.startsWith("nodi:database-draft:")) throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await cell.fill("MEMORY ONLY ACCOUNT CELL");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByText("작성 중인 내용을 안전하게 보관할 저장 공간이 부족해요. 기존 내용은 유지했습니다. 공간을 확보한 뒤 다시 시도해 주세요.", { exact: true })).toBeVisible();
  expect(logouts).toBe(0);
  await expect(cell).toHaveValue("MEMORY ONLY ACCOUNT CELL");
  expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).not.toBeNull();
});

async function clipboard(page: Page, editor: Locator, operation: "copy" | "cut") {
  await editor.focus();
  await editor.evaluate((element, action) => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== (action === "cut" ? "x" : "c")) return;
      document.removeEventListener("keydown", onKey, true);
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      event.preventDefault(); event.stopImmediatePropagation(); document.execCommand(action);
    };
    document.addEventListener("keydown", onKey, true);
  }, operation);
  await page.keyboard.press(operation === "cut" ? "ControlOrMeta+x" : "ControlOrMeta+c");
}

async function openPreview(page: Page) {
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  await expect(preview.getByRole("textbox", cellName)).toHaveValue("ORIGINAL CELL");
  return preview;
}

for (const operation of ["copy", "cut"] as const) {
  test(`${operation} keeps the live table when real storage quota and its server save both fail`, async ({ page }) => {
    const { server, databases } = await withDatabase(page);
    await page.goto("/?page=page-2");
    const preview = await openPreview(page);
    let failedSaves = 0;
    await page.route("**/api/databases/audit-db", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      failedSaves++;
      return route.abort("internetdisconnected");
    });
    expect(await page.evaluate(() => {
      let exhausted = false;
      try {
        for (let index = 0; index < 1024; index++) localStorage.setItem(`snapshot-quota-large-${index}`, "f".repeat(65_536));
      } catch (error) { exhausted = error instanceof DOMException && error.name === "QuotaExceededError"; }
      try {
        for (let index = 0; index < 256; index++) localStorage.setItem(`snapshot-quota-small-${index}`, "f".repeat(1024));
      } catch { /* Leave less than 1 KiB free using real browser quota. */ }
      return exhausted;
    })).toBe(true);
    const latest = `UNSAVED LATEST CELL ${"x".repeat(4096)}`;
    await preview.getByRole("textbox", cellName).fill(latest);
    await expect(preview.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
    const before = await page.evaluate(() => ({
      cache: localStorage.getItem("nodi:database:audit-db"),
      draft: localStorage.getItem("nodi:database-draft:audit-db"),
    }));
    expect(before.cache).toContain("ORIGINAL CELL");
    expect(before.draft).toBeNull();
    await preview.locator('[data-id="page-1-block"] .bn-inline-content').click();
    await clipboard(page, preview.locator(".bn-editor"), operation);
    await expect(preview.locator(".inline-database")).toHaveCount(operation === "cut" ? 0 : 1);
    await page.getByRole("button", { name: "페이지 미리보기 닫기", exact: true }).click();
    await expect(preview).not.toBeVisible();
    // Let the departing instance's failed flush finish while quota still holds.
    // Its orphan draft must not be what accidentally rescues this clipboard.
    await expect.poll(() => failedSaves).toBeGreaterThan(1);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => localStorage.getItem("nodi:database-draft:audit-db"))).toBeNull();
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("snapshot-quota-")).forEach((key) => localStorage.removeItem(key)));
    await documentEditor(page).focus();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(page.getByRole("textbox", cellName)).toHaveValue(latest);
    await expect.poll(() => Object.keys(databases).length).toBe(2);
    expect(Object.values(databases).find((value) => value.id !== "audit-db")!.state.records[0].values.name).toBe(latest);
    if (operation === "cut") await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).not.toContain("audit-db");
    expect(server.failures).toEqual([]);
  });
}

test("copy uses the selected preview's snapshot when the main view has different unsaved cells", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page).getByRole("textbox", cellName)).toHaveValue("ORIGINAL CELL");
  const preview = await openPreview(page);
  await page.route("**/api/databases/audit-db", (route) => route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.fallback());
  await preview.getByRole("textbox", cellName).fill("PREVIEW UNSAVED CELL");
  await documentEditor(page).getByRole("textbox", cellName).fill("MAIN LATER UNSAVED CELL");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:database:audit-db"))).toContain("MAIN LATER UNSAVED CELL");
  await preview.locator('[data-id="page-1-block"] .bn-inline-content').click();
  await clipboard(page, preview.locator(".bn-editor"), "copy");
  await page.getByRole("button", { name: "페이지 미리보기 닫기", exact: true }).click();
  await expect(preview).not.toBeVisible();
  await expect(documentEditor(page).getByRole("textbox", cellName)).toHaveValue("MAIN LATER UNSAVED CELL");
  await page.locator('[data-sidebar-page-id="page-2"]').first().click();
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await documentEditor(page).focus(); await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByRole("textbox", cellName)).toHaveValue("PREVIEW UNSAVED CELL");
  await expect.poll(() => Object.keys(databases).length).toBe(2);
  expect(server.failures).toEqual([]);
});

test("a readonly initial GET applies a newer realtime revision without erasing an editable draft", async ({ page }) => {
  const { server, database, writes } = await withDatabase(page);
  server.pages["page-1"].permission = "view";
  await page.addInitScript((base) => {
    localStorage.setItem("nodi:database-draft:audit-db", JSON.stringify({
      base, revision: 1, state: { ...base, records: [{ id: "record-1", values: { name: "PRESERVED EDITABLE DRAFT" } }] },
    }));
  }, database.state);
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stale = structuredClone(database);
  await page.route("**/api/databases/audit-db", async (route) => {
    started(); await gate;
    return route.fulfill({ json: { data: stale } });
  });
  await page.goto("/?page=page-1"); await pending;
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  database.state = { ...database.state, records: [{ id: "record-1", values: { name: "NEWER REMOTE CELL" } }] };
  database.revision++;
  server.send("page-1", { type: "database.updated", actorId: "other-user", database: database as never });
  await page.waitForTimeout(100); release();
  await expect(page.getByRole("textbox", cellName)).toBeDisabled();
  await expect(page.getByRole("textbox", cellName)).toHaveValue("NEWER REMOTE CELL");
  expect(await page.evaluate(() => localStorage.getItem("nodi:database-draft:audit-db"))).toContain("PRESERVED EDITABLE DRAFT");
  expect(writes).toEqual([]);
  expect(server.failures).toEqual([]);
});

test("a late table save failure cannot recreate private snapshots after an account transition", async ({ page }) => {
  const { server } = await withDatabase(page);
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", cellName)).toHaveValue("ORIGINAL CELL");
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/databases/audit-db", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    started(); await gate;
    return route.fulfill({ status: 503, json: { error: { code: "OFFLINE", message: "Delayed failure" } } });
  });
  await page.getByRole("textbox", cellName).fill("PRIVATE UNSAVED CELL"); await pending;
  // Execute the real account/cache transition while keeping this mounted
  // editor alive long enough to observe the delayed request's completion.
  await page.evaluate(async () => (await import(/* @vite-ignore */ "/src/account-store.ts")).logoutLocalAccount());
  expect(await page.evaluate(async () => {
    const cache = await import(/* @vite-ignore */ "/src/database-cache.ts");
    return cache.readDatabaseSnapshot("audit-db", document.querySelector(".bn-editor")!);
  })).toBeNull();
  const response = page.waitForResponse((value) => value.url().endsWith("/api/databases/audit-db") && value.request().method() === "PUT");
  release(); await (await response).finished();
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({
    owner: localStorage.getItem("nodi:workspace-owner"),
    cache: localStorage.getItem("nodi:database:audit-db"),
    draft: localStorage.getItem("nodi:database-draft:audit-db"),
  }));
  expect(after).toEqual({ owner: "guest", cache: null, draft: null });
  expect(server.failures).toEqual([]);
});
