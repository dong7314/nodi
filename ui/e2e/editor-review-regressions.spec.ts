import { test, expect, type Locator, type Page } from "@playwright/test";
import { withDatabase } from "./database-fixture";
import { documentEditor, makePage, mockWorkspace } from "./workspace-fixture";

async function copyPreviewSelection(page: Page, editor: Locator, options: {
  cut?: boolean;
  start?: { blockId: string; offset: number };
  end?: { blockId: string; offset: number };
} = {}) {
  // Set the exact native selection inside a real keyboard gesture. Waiting
  // between selecting and copying lets browser selection normalization drop
  // the last non-text block; execCommand outside a gesture is denied by WebKit.
  await editor.evaluate((element, selectionOptions) => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== (selectionOptions.cut ? "x" : "c")) return;
      document.removeEventListener("keydown", onKey, true);
      const range = document.createRange();
      range.selectNodeContents(element);
      const { start, end } = selectionOptions;
      if (start) range.setStart(element.querySelector(`[data-id="${start.blockId}"] .bn-inline-content`)!.firstChild!, start.offset);
      if (end) range.setEnd(element.querySelector(`[data-id="${end.blockId}"] .bn-inline-content`)!.firstChild!, end.offset);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      event.preventDefault();
      event.stopImmediatePropagation();
      document.execCommand(selectionOptions.cut ? "cut" : "copy");
    };
    document.addEventListener("keydown", onKey, true);
  }, options);
  await page.keyboard.press(options.cut ? "ControlOrMeta+x" : "ControlOrMeta+c");
}

test("pasting a table into another page preview gives it independent storage", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.locator('[data-sidebar-page-id="page-2"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 2 페이지 미리보기", exact: true });
  await preview.locator(".bn-editor[contenteditable=true]").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  const copy = preview.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(copy).toHaveValue("ORIGINAL CELL");
  await copy.fill("PREVIEW COPY EDIT");
  await expect.poll(() => Object.values(databases).some((value) => value.state.records[0]?.values.name === "PREVIEW COPY EDIT")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).not.toContain("audit-db");
  expect(server.failures).toEqual([]);
});

for (const destination of ["main editor", "another preview"] as const) {
  test(`copying a table out of a preview into ${destination} keeps the source independent`, async ({ page }) => {
    const { server, databases } = await withDatabase(page);
    await page.goto("/?page=page-2");
    await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
    await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
    const source = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
    await expect(source.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
    await source.locator(".bn-editor[contenteditable=true]").focus();
    await copyPreviewSelection(page, source.locator(".bn-editor"));
    await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
    await expect(source).not.toBeVisible();
    if (destination === "another preview") {
      await page.locator('[data-sidebar-page-id="page-2"]').first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
    }
    const target = destination === "main editor" ? page.locator(".block-editor-context-target")
      : page.getByRole("dialog", { name: "페이지 2 페이지 미리보기", exact: true });
    await target.locator(".bn-editor[contenteditable=true]").focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("ControlOrMeta+v");
    const cell = target.getByRole("textbox", { name: "이름 값", exact: true });
    await expect(cell).toHaveValue("ORIGINAL CELL");
    await cell.fill("INDEPENDENT PREVIEW COPY");
    await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === "INDEPENDENT PREVIEW COPY")).toBe(true);
    expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
    await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).not.toContain("audit-db");
    expect(server.failures).toEqual([]);
  });
}

test("cutting preview blocks keeps undo working and pastes an independent table", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  const previewEditor = preview.locator(".bn-editor[contenteditable=true]");
  await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await previewEditor.focus();
  await copyPreviewSelection(page, previewEditor, { cut: true });
  await expect(preview.locator(".inline-database")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(preview).not.toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  await page.getByRole("textbox", { name: "이름 값", exact: true }).fill("CUT COPY EDIT");
  await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === "CUT COPY EDIT")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  expect(server.failures).toEqual([]);
});

test("preview text selection does not copy its surrounding table", async ({ page }) => {
  const { server } = await withDatabase(page);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  await preview.locator('[data-id="page-1-block"] .bn-inline-content').click();
  await copyPreviewSelection(page, preview.locator(".bn-editor"), {
    start: { blockId: "page-1-block", offset: 0 }, end: { blockId: "page-1-block", offset: 4 },
  });
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(preview).not.toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await documentEditor(page).textContent())?.replace("PAGE TWO ORIGINAL", "").trim()).toBe("PAGE");
  await expect(page.locator(".inline-database")).toHaveCount(0);
  expect(server.failures).toEqual([]);
});

test("a read-only preview can copy a table without sharing its storage", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  server.pages["page-1"].settings.lockPage = true;
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  const source = preview.locator(".bn-editor");
  await expect(source).toHaveAttribute("contenteditable", "false");
  await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await preview.locator('[data-id="page-1-block"] .bn-inline-content').click();
  await copyPreviewSelection(page, source);
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(preview).not.toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await cell.fill("READONLY COPY EDIT");
  await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === "READONLY COPY EDIT")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  expect(server.failures).toEqual([]);
});

test("a preview selection containing a table keeps only the selected paragraph edges", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  server.pages["page-1"].blocks![0] = { id: "selection-start", type: "paragraph", content: "PREFIX selected" } as never;
  server.pages["page-1"].blocks!.push({ id: "selection-end", type: "paragraph", content: "selected SUFFIX" } as never);
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "페이지 1 페이지 미리보기", exact: true });
  await expect(preview.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  await preview.locator(".bn-editor").focus();
  await copyPreviewSelection(page, preview.locator(".bn-editor"), {
    start: { blockId: "selection-start", offset: 7 }, end: { blockId: "selection-end", offset: 8 },
  });
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(preview).not.toBeVisible();
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+v");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  const content = documentEditor(page).locator(".bn-inline-content");
  await expect(content).toHaveText(["PAGE TWO ORIGINAL", "selected", "selected"]);
  await cell.fill("PARTIAL COPY EDIT");
  await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === "PARTIAL COPY EDIT")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  expect(server.failures).toEqual([]);
});

test("each application of an imported table preset uses independent storage", async ({ page }) => {
  const { server, databases } = await withDatabase(page);
  await page.route("**/api/presets", (route) => route.fulfill({ json: { data: [{
    id: "db-preset", name: "표 프리셋", icon: "📄", pageTitle: "새 표 메모",
    blocks: structuredClone(server.pages["page-1"].blocks), orderIndex: 0,
  }] } }));
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
  for (const value of ["FIRST PRESET EDIT", "SECOND PRESET EDIT"]) {
    await page.getByRole("button", { name: "페이지 및 폴더 추가" }).click();
    await page.getByRole("menuitem", { name: /^페이지/ }).click();
    await page.getByRole("button", { name: /표 프리셋/ }).click();
    await page.getByRole("button", { name: "시작하기", exact: true }).click();
    const copy = page.getByRole("textbox", { name: "이름 값", exact: true });
    await expect(copy).toHaveValue("ORIGINAL CELL");
    await copy.fill(value);
    await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === value)).toBe(true);
  }
  expect(Object.values(databases).map((database) => database.state.records[0].values.name).sort())
    .toEqual(["FIRST PRESET EDIT", "ORIGINAL CELL", "SECOND PRESET EDIT"]);
  expect(server.failures).toEqual([]);
});

async function newPageWithUncachedTablePreset(page: Page) {
  const fixture = await withDatabase(page);
  await page.route("**/api/presets", (route) => route.fulfill({ json: { data: [
    { id: "table-preset", name: "표 프리셋", icon: "📄", pageTitle: "새 표 메모", blocks: structuredClone(fixture.server.pages["page-1"].blocks), orderIndex: 0 },
    { id: "text-preset", name: "텍스트 프리셋", icon: "📄", pageTitle: "텍스트 메모", blocks: [{ type: "paragraph", content: "LATEST PRESET" }], orderIndex: 1 },
  ] } }));
  await page.goto("/?page=page-2");
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await page.getByRole("button", { name: "페이지 및 폴더 추가" }).click();
  await page.getByRole("menuitem", { name: /^페이지/ }).click();
  await page.getByRole("button", { name: /표 프리셋/ }).click();
  expect(await page.evaluate(() => localStorage.getItem("nodi:database:audit-db"))).toBeNull();
  return fixture;
}

test("an uncached preset table is fetched and cloned without opening its source page", async ({ page }) => {
  const { databases, server } = await newPageWithUncachedTablePreset(page);
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await cell.fill("FETCHED COPY");
  await expect.poll(() => Object.values(databases).some((database) => database.state.records[0]?.values.name === "FETCHED COPY")).toBe(true);
  expect(databases["audit-db"].state.records[0].values.name).toBe("ORIGINAL CELL");
  expect(server.failures).toEqual([]);
});

test("a preset with an inaccessible table leaves the current page intact", async ({ page }) => {
  await newPageWithUncachedTablePreset(page);
  await page.route("**/api/databases/audit-db", (route) => route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "원본 표에 접근할 수 없어요" } } }));
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await expect(page.getByText("원본 표에 접근할 수 없어요", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("제목 없음");
  await expect(page.locator(".inline-database")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "새 페이지 시작 프리셋" })).toBeVisible();
});

for (const action of ["edit", "navigate", "newer preset"] as const) {
  test(`a delayed preset table cannot overwrite ${action}`, async ({ page }) => {
    await newPageWithUncachedTablePreset(page);
    let started!: () => void, release!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/databases/audit-db", async (route) => {
      started(); await released; await route.fallback();
    });
    await page.getByRole("button", { name: "시작하기", exact: true }).click();
    await pending;
    if (action === "edit") {
      await documentEditor(page).click();
      await page.keyboard.insertText("KEEP MY EDIT");
    } else if (action === "navigate") {
      await page.locator('[data-sidebar-page-id="page-2"]').first().click();
      await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
    } else {
      await page.getByRole("button", { name: /텍스트 프리셋/ }).click();
      await page.getByRole("button", { name: "시작하기", exact: true }).click();
      await expect(documentEditor(page)).toHaveText("LATEST PRESET");
    }
    const response = page.waitForResponse((value) => value.url().endsWith("/api/databases/audit-db"));
    release(); await response;
    await expect(documentEditor(page)).toContainText(action === "edit" ? "KEEP MY EDIT" : action === "navigate" ? "PAGE TWO ORIGINAL" : "LATEST PRESET");
    await expect(page.locator(".inline-database")).toHaveCount(0);
  });
}

test("a pending table preset is cancelled before logout can discard its unsaved application", async ({ page }) => {
  await newPageWithUncachedTablePreset(page);
  let started!: () => void, release!: () => void, logoutStarted!: () => void, releaseLogout!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const logoutPending = new Promise<void>((resolve) => { logoutStarted = resolve; });
  const logoutReleased = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/databases/audit-db", async (route) => {
    started(); await released; await route.fallback();
  });
  await page.route("**/api/auth/logout", async (route) => {
    logoutStarted(); await logoutReleased; await route.fulfill({ status: 204 });
  });
  await page.getByRole("button", { name: "시작하기", exact: true }).click();
  await pending;
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  await logoutPending;
  const response = page.waitForResponse((value) => value.url().endsWith("/api/databases/audit-db"));
  release(); await response;
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("제목 없음");
  await expect(page.locator(".inline-database")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("nodi:database:")))).toEqual([]);
  releaseLogout();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
});

const member = {
  id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid",
  role: "member", avatarColor: "purple",
};
const otherUser = { ...member, id: "00000000-0000-4000-8000-000000000002", name: "새회원", email: "new@example.invalid" };

test("a user found outside the initial directory can be invited and managed", async ({ page }) => {
  const server = await mockWorkspace(page);
  let shared = false;
  await page.route("**/api/shares", (route) => route.fulfill({ json: { data: shared ? [{
    pageId: "page-1", owner: member, updatedAt: "2026-10-02T00:00:00Z",
    members: [{ user: otherUser, permission: "edit", sharedAt: "2026-10-02T00:00:00Z" }],
  }] : [] } }));
  await page.route("**/api/auth/users?*", (route) => route.fulfill({ json: {
    data: new URL(route.request().url()).searchParams.get("q") ? [otherUser] : [],
  } }));
  await page.route("**/api/pages/page-1/shares/**", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ permission: "edit" });
    shared = true;
    await route.fulfill({ json: { data: { userId: otherUser.id, permission: "edit", sharedAt: "2026-10-02T00:00:00Z" } } });
  });
  await page.route("**/api/pages/page-1/shares", (route) => route.fulfill({ json: { data: {
    pageId: "page-1", owner: member, updatedAt: "2026-10-02T00:00:00Z",
    members: shared ? [{ user: otherUser, permission: "edit", sharedAt: "2026-10-02T00:00:00Z" }] : [],
  } } }));
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "공유", exact: true }).click();
  await page.getByRole("textbox", { name: "Nodi 회원 검색" }).fill("새회원");
  await page.getByRole("option", { name: /새회원/ }).click();
  await expect.poll(() => shared).toBe(true);
  await expect(page.getByRole("combobox", { name: "새회원 공유 권한" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새회원 공유 해제" })).toBeVisible();
  expect(server.failures).toEqual([]);
});

test("an invited editing member can write a comment without being in their own directory", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].ownerId = otherUser.id;
  server.pages["page-1"].permission = "edit";
  await page.route("**/api/auth/users?*", (route) => route.fulfill({ json: { data: [otherUser] } }));
  await page.route("**/api/shares", (route) => route.fulfill({ json: { data: [{
    pageId: "page-1", owner: otherUser, updatedAt: "2026-10-02T00:00:00Z",
    members: [{ user: member, permission: "edit", sharedAt: "2026-10-02T00:00:00Z" }],
  }] } }));
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await documentEditor(page).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "블록에 댓글 달기", exact: true }).click();
  const input = page.getByRole("textbox", { name: "댓글 입력" });
  await expect(input).toBeEnabled();
  await input.fill("공유받은 회원의 댓글");
  await expect(page.getByRole("button", { name: "댓글 보내기" })).toBeEnabled();
  expect(server.failures).toEqual([]);
});

test("child links share title updates without parsing the workspace for every link", async ({ page }) => {
  const server = await mockWorkspace(page);
  for (let i = 0; i < 100; i++) server.pages[`bulk-${i}`] = makePage(`bulk-${i}`, `bulk ${i}`, "x".repeat(10000));
  for (let i = 0; i < 50; i++) server.pages["page-1"].blocks!.push({
    id: `link-${i}`, type: "childPage", props: { pageId: "page-2", title: "페이지 2" },
  } as never);
  await page.goto("/?page=page-1");
  await expect(page.locator(".child-page-block")).toHaveCount(50);
  await page.locator('[data-id="page-1-block"] .bn-inline-content').click();
  await page.evaluate(() => {
    const original = Storage.prototype.getItem;
    (window as unknown as { workspaceReads: number }).workspaceReads = 0;
    Storage.prototype.getItem = function (key) {
      if (key === "nodi:pages") (window as unknown as { workspaceReads: number }).workspaceReads++;
      return original.call(this, key);
    };
  });
  await page.keyboard.insertText("TITLE CACHE INPUT");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("TITLE CACHE INPUT");
  expect(await page.evaluate(() => (window as unknown as { workspaceReads: number }).workspaceReads)).toBeLessThan(10);
  // Another tab supplies one storage event; all links must still update.
  await page.evaluate(() => {
    const pages = JSON.parse(localStorage.getItem("nodi:pages")!);
    pages["page-2"].title = "다른 탭에서 바뀐 제목";
    localStorage.setItem("nodi:pages", JSON.stringify(pages));
    window.dispatchEvent(new StorageEvent("storage", { key: "nodi:pages", storageArea: localStorage }));
  });
  await expect(page.getByRole("button", { name: "다른 탭에서 바뀐 제목 페이지 열기", exact: true })).toHaveCount(50);
  // Account-cache removal must clear the title snapshot too.
  await page.evaluate(() => {
    localStorage.removeItem("nodi:pages");
    window.dispatchEvent(new CustomEvent("nodi:pages-changed"));
  });
  await expect(page.getByRole("button", { name: "페이지 2 페이지 열기", exact: true })).toHaveCount(50);
  expect(server.failures).toEqual([]);
});
