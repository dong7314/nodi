import { expect, test, type Locator, type Page } from "@playwright/test";
import { withDatabase } from "./database-fixture";
import { documentEditor } from "./workspace-fixture";

const notReady = "표 내용을 불러온 뒤 다시 복사해 주세요.";
const empty = { name: "새 데이터베이스", properties: [], records: [], trash: [], views: [], activeViewId: null };

async function clipboard(page: Page, editor: Locator, operation: "copy" | "cut") {
  await editor.focus();
  await editor.evaluate((element, action) => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== (action === "cut" ? "x" : "c")) return;
      document.removeEventListener("keydown", onKey, true);
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      event.preventDefault(); event.stopImmediatePropagation();
      document.execCommand(action);
    };
    document.addEventListener("keydown", onKey, true);
  }, operation);
  await page.keyboard.press(operation === "cut" ? "ControlOrMeta+x" : "ControlOrMeta+c");
}

async function openSourcePreview(page: Page) {
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  await expect(preview.locator(".inline-database")).toHaveCount(1);
  return preview;
}

async function pasteIntoMain(page: Page, preview: Locator) {
  await page.getByRole("button", { name: "페이지 미리보기 닫기", exact: true }).click();
  await expect(preview).not.toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+v");
}

test("copy and cut wait for the first table GET without caching its placeholder", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/databases/audit-db", async (route) => { started(); await released; await route.fallback(); });
  const preview = await openSourcePreview(page); await pending;
  for (const action of ["copy", "cut"] as const) {
    await clipboard(page, preview.locator(".bn-editor"), action);
    await expect(page.getByText(notReady, { exact: true })).toBeVisible();
    await expect(preview.locator(".inline-database")).toHaveCount(1);
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("audit-db");
    expect(await page.evaluate(() => localStorage.getItem("nodi:database:audit-db"))).toBeNull();
  }
  release();
  await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await clipboard(page, preview.locator(".bn-editor"), "cut");
  await expect(preview.locator(".inline-database")).toHaveCount(0);
  await pasteIntoMain(page, preview);
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => Object.values(databases).filter((value) => value.id !== "audit-db")).toHaveLength(1);
  expect(Object.values(databases).find((value) => value.id !== "audit-db")!.state.records[0].values.name).toBe("ORIGINAL CELL");
  expect(server.failures).toEqual([]);
});

test("a failed first GET cannot turn a preview cut into an empty table", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.route("**/api/databases/audit-db", (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "표 조회 실패" } } }));
  const preview = await openSourcePreview(page);
  await expect(page.getByText("표 조회 실패", { exact: true })).toBeVisible();
  for (const action of ["copy", "cut"] as const) {
    await clipboard(page, preview.locator(".bn-editor"), action);
    await expect(page.getByText(notReady, { exact: true })).toBeVisible();
    await expect(preview.locator(".inline-database")).toHaveCount(1);
  }
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("audit-db");
  expect(Object.keys(databases)).toEqual(["audit-db"]);
  expect(await page.evaluate(() => localStorage.getItem("nodi:database:audit-db"))).toBeNull();
  expect(server.failures).toEqual([]);
});

test("a confirmed empty table can still be cut and copied independently", async ({ page }) => {
  const { server, database, databases } = await withDatabase(page);
  database.state = empty;
  const preview = await openSourcePreview(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:database:audit-db:ready"))).toBe("1");
  await clipboard(page, preview.locator(".bn-editor"), "cut");
  await expect(preview.locator(".inline-database")).toHaveCount(0);
  await pasteIntoMain(page, preview);
  await expect(documentEditor(page).locator(".inline-database")).toHaveCount(1);
  await expect.poll(() => Object.keys(databases).length).toBe(2);
  expect(Object.values(databases).find((value) => value.id !== "audit-db")!.state).toEqual(empty);
  expect(server.failures).toEqual([]);
});

for (const source of ["legacy cache", "durable draft"] as const) {
  test(`a ${source} remains available for copying while the source API is unavailable`, async ({ page }) => {
    const { server, database, databases } = await withDatabase(page);
    const local = structuredClone(database.state);
    local.records[0].values.name = "OFFLINE LOCAL CONTENT";
    await page.addInitScript(({ state, kind }) => localStorage.setItem(
      kind === "legacy cache" ? "nodi:database:audit-db" : "nodi:database-draft:audit-db",
      JSON.stringify(kind === "legacy cache" ? state : { state, revision: 1 }),
    ), { state: local, kind: source });
    await page.route("**/api/databases/audit-db", (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "표 조회 실패" } } }));
    const preview = await openSourcePreview(page);
    await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("OFFLINE LOCAL CONTENT");
    await clipboard(page, preview.locator(".bn-editor"), "cut");
    await expect(preview.locator(".inline-database")).toHaveCount(0);
    await pasteIntoMain(page, preview);
    await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("OFFLINE LOCAL CONTENT");
    await expect.poll(() => Object.keys(databases).length).toBe(2);
    expect(database.state.records[0].values.name).toBe("ORIGINAL CELL");
    expect(server.failures).toEqual([]);
  });
}

for (const response of ["success", "failure"] as const) {
  test(`a preset rechecks an old placeholder cache before applying (${response})`, async ({ page }) => {
    const { server, databases } = await withDatabase(page);
    await page.addInitScript((state) => localStorage.setItem("nodi:database:audit-db", JSON.stringify(state)), empty);
    await page.route("**/api/presets", (route) => route.fulfill({ json: { data: [{
      id: "table-preset", name: "표 프리셋", icon: "📄", pageTitle: "준비된 표",
      blocks: structuredClone(server.pages["page-1"].blocks), orderIndex: 0,
    }] } }));
    let lookups = 0;
    await page.route("**/api/databases/audit-db", async (route) => {
      lookups++;
      if (response === "failure") return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "표 조회 실패" } } });
      await route.fallback();
    });
    await page.goto("/?page=page-2");
    await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
    await page.getByRole("button", { name: "페이지 및 폴더 추가" }).click();
    await page.getByRole("menuitem", { name: /^페이지/ }).click();
    await page.getByRole("button", { name: /표 프리셋/ }).click();
    await page.getByRole("button", { name: "시작하기", exact: true }).click();
    if (response === "success") {
      await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
      await expect.poll(() => Object.keys(databases).length).toBe(2);
    } else {
      await expect(page.getByText("표 조회 실패", { exact: true })).toBeVisible();
      await expect(page.locator(".inline-database")).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("제목 없음");
      expect(Object.keys(databases)).toEqual(["audit-db"]);
    }
    expect(lookups).toBe(1);
    expect(server.failures).toEqual([]);
  });
}

test("duplicate rejects an unconfirmed placeholder after its source request fails", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.addInitScript((state) => localStorage.setItem("nodi:database:audit-db", JSON.stringify(state)), empty);
  await page.route("**/api/databases/audit-db", (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "표 조회 실패" } } }));
  await page.goto("/?page=page-1");
  await expect(page.getByText("표 조회 실패", { exact: true })).toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "선택한 블록 복제", exact: true }).click();
  await expect(page.getByText(notReady, { exact: true })).toBeVisible();
  await expect(page.locator(".inline-database")).toHaveCount(1);
  expect(Object.keys(databases)).toEqual(["audit-db"]);
  expect(server.failures).toEqual([]);
});
