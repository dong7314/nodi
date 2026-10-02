import { test, expect } from "@playwright/test";
import type { ServerPage } from "../src/server-api";
import { withDatabase } from "./database-fixture";
import { documentEditor, editDocument, makePage, mockWorkspace, openPage, savedPages } from "./workspace-fixture";

const currentUserId = "00000000-0000-4000-8000-000000000001";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("another session of the same account updates the document before the next local edit", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);

  const remote: ServerPage = {
    ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "SAME ACCOUNT REMOTE EDIT" }],
  };
  server.pages["page-1"] = remote;
  // User identity alone cannot identify this editor's own acknowledgement.
  server.send("page-1", {
    type: "page.updated", page: remote, actorId: currentUserId,
    changedBlockIds: ["page-1-block"], structural: false,
  });
  await expect(documentEditor(page)).toHaveText("SAME ACCOUNT REMOTE EDIT");
  await editDocument(page, " LOCAL SUFFIX");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("SAME ACCOUNT REMOTE EDIT LOCAL SUFFIX");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("SAME ACCOUNT REMOTE EDIT LOCAL SUFFIX");
  expect(server.failures).toEqual([]);
});

test("another session of the same account updates a mounted table", async ({ page }) => {
  const { server, database, writes } = await withDatabase(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const writesBefore = writes.length;
  database.state = {
    ...database.state, records: [{ id: "record-1", values: { name: "SAME ACCOUNT REMOTE CELL" } }],
  };
  database.revision++;
  server.send("page-1", { type: "database.updated", actorId: currentUserId, database: database as never });
  await expect(cell).toHaveValue("SAME ACCOUNT REMOTE CELL");
  await page.clock.install();
  await page.clock.runFor(800);
  expect(writes).toHaveLength(writesBefore);
  expect(server.failures).toEqual([]);
});

test("an older acknowledgement does not release protection for a newer pending block edit", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const sent: Array<{ type: string; blocks: ServerPage["blocks"]; changedBlockIds: string[]; mutationId?: string }> = [];
  server.sockets.get("page-1")!.onMessage((raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "page.blocks.patch") sent.push(message);
  });
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await editDocument(page, " FIRST");
  await page.clock.runFor(100);
  await expect.poll(() => sent.length).toBe(1);
  await editDocument(page, " SECOND");
  await page.clock.runFor(100);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0].mutationId).toBeTruthy();
  expect(sent[1].mutationId).not.toBe(sent[0].mutationId);

  const firstAck = { ...server.pages["page-1"], blocks: sent[0].blocks, revision: 2 };
  server.pages["page-1"] = firstAck;
  server.send("page-1", {
    type: "page.updated", page: firstAck, actorId: currentUserId,
    changedBlockIds: sent[0].changedBlockIds, mutationId: sent[0].mutationId,
  });
  const remote: ServerPage = {
    ...firstAck, revision: 3,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "INTERLEAVED REMOTE EDIT" }],
  };
  server.pages["page-1"] = remote;
  server.send("page-1", {
    type: "page.updated", page: remote, actorId: "other-user",
    changedBlockIds: ["page-1-block"], structural: false,
  });
  await page.clock.runFor(100);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL FIRST SECOND");

  const secondAck = { ...remote, blocks: sent[1].blocks, revision: 4 };
  server.pages["page-1"] = secondAck;
  server.send("page-1", {
    type: "page.updated", page: secondAck, actorId: currentUserId,
    changedBlockIds: sent[1].changedBlockIds, mutationId: sent[1].mutationId,
  });
  await expect.poll(async () => (await savedPages(page))["page-1"].revision).toBe(4);
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL FIRST SECOND");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("FIRST SECOND");
  expect(server.failures).toEqual([]);
});

test("acknowledging a newly inserted block keeps the local undo history", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  // The backend echoes structural changes too; include that part of its
  // protocol explicitly while controlling the acknowledgement in this case.
  server.sockets.get("page-1")!.onMessage((raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "page.blocks.patch") return;
    server.pages["page-1"] = { ...server.pages["page-1"], blocks: message.blocks, revision: server.pages["page-1"].revision + 1 };
    server.send("page-1", {
      type: "page.updated", page: server.pages["page-1"], actorId: currentUserId,
      mutationId: message.mutationId, changedBlockIds: message.changedBlockIds,
      deletedBlockIds: message.deletedBlockIds, structural: message.structural,
    });
  });
  await documentEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("OWN NEW BLOCK");
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("OWN NEW BLOCK");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await documentEditor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(documentEditor(page)).not.toContainText("OWN NEW BLOCK");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});

test("typing while the initial workspace request is pending survives hydration and saves", async ({ page }) => {
  const server = await mockWorkspace(page);
  const started = deferred();
  const release = deferred();
  await page.route("**/api/pages?*", async (route) => {
    const snapshot = structuredClone(Object.values(server.pages).filter((entry) => entry.id !== "quick-note"));
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { data: snapshot } });
  });
  await page.goto("/?page=page-1");
  await started.promise;
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await editDocument(page, " TYPED DURING INITIAL LOAD");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("TYPED DURING INITIAL LOAD");

  release.resolve();
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("TYPED DURING INITIAL LOAD");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL TYPED DURING INITIAL LOAD");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("TYPED DURING INITIAL LOAD");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL TYPED DURING INITIAL LOAD");
  expect(server.failures).toEqual([]);
});

test("a conflicting page preserves both drafts without blocking another page's save", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "서버에서 읽은 페이지 1";
  await page.goto("/?page=page-1");
  // A changed server title distinguishes completed hydration from the initial cache.
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("서버에서 읽은 페이지 1");
  server.pages["page-1"] = {
    ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "OTHER DEVICE CONFLICTING BODY" }],
  };
  await editDocument(page, " LOCAL CONFLICTING BODY");
  await expect.poll(() => server.writes.some(({ id, patch }) => id === "page-1" && patch.revision === 1)).toBe(true);

  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  await editDocument(page, " INDEPENDENT PAGE EDIT");
  await expect.poll(() => JSON.stringify(server.pages["page-2"].blocks)).toContain("INDEPENDENT PAGE EDIT");
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("OTHER DEVICE CONFLICTING BODY");
  expect(JSON.stringify((await savedPages(page))["page-1"].blocks)).toContain("LOCAL CONFLICTING BODY");
  await page.reload();
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL INDEPENDENT PAGE EDIT");
  await openPage(page, "page-1", "LOCAL CONFLICTING BODY");
  await page.getByRole("button", { name: "내 변경 저장", exact: true }).click();
  await expect.poll(() => JSON.stringify(server.pages["page-1"].blocks)).toContain("LOCAL CONFLICTING BODY");
  await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).not.toBeVisible();
  await page.reload();
  await expect(documentEditor(page)).toContainText("LOCAL CONFLICTING BODY");
  await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).not.toBeVisible();
  expect(server.failures).toEqual([]);
});

test("choosing the server version of a page conflict stays resolved after reload", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "서버에서 읽은 페이지 1";
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("서버에서 읽은 페이지 1");
  server.pages["page-1"] = {
    ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "SERVER VERSION TO KEEP" }],
  };
  await editDocument(page, " LOCAL VERSION TO DISCARD");
  await page.getByRole("button", { name: "서버 내용 사용", exact: true }).click();
  await expect(documentEditor(page)).toHaveText("SERVER VERSION TO KEEP");
  await expect(page.getByRole("button", { name: "서버 내용 사용", exact: true })).not.toBeVisible();
  await page.reload();
  await expect(documentEditor(page)).toHaveText("SERVER VERSION TO KEEP");
  await expect(page.getByRole("button", { name: "서버 내용 사용", exact: true })).not.toBeVisible();
  expect(JSON.stringify(server.pages["page-1"].blocks)).not.toContain("LOCAL VERSION TO DISCARD");
  expect(server.failures).toEqual([]);
});

for (const choice of ["local", "remote"] as const) {
  test(`choosing ${choice} before the title server save applies only the chosen page version`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].title = "서버에서 읽은 제목";
    await page.goto("/?page=page-1");
    const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
    await expect(title).toHaveValue("서버에서 읽은 제목");
    server.pages["page-1"] = {
      ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
      blocks: [{ id: "page-1-block", type: "paragraph", content: "SERVER CONFLICT BODY" }],
    };
    await editDocument(page, " LOCAL CONFLICT BODY");
    await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await title.fill("JUST TYPED TITLE");
    expect((await savedPages(page))["page-1"].title).toBe("JUST TYPED TITLE");
    await page.getByRole("button", { name: choice === "local" ? "내 변경 저장" : "서버 내용 사용", exact: true }).click();

    const expectedTitle = choice === "local" ? "JUST TYPED TITLE" : "서버에서 읽은 제목";
    const expectedBody = choice === "local" ? "LOCAL CONFLICT BODY" : "SERVER CONFLICT BODY";
    await expect(title).toHaveValue(expectedTitle);
    await page.clock.runFor(1_500);
    await expect.poll(() => server.pages["page-1"].title).toBe(expectedTitle);
    expect(JSON.stringify(server.pages["page-1"].blocks)).toContain(expectedBody);
    expect((await savedPages(page))["page-1"].title).toBe(expectedTitle);
    await page.reload();
    await expect(title).toHaveValue(expectedTitle);
    await expect(documentEditor(page)).toContainText(expectedBody);
    await expect(page.getByRole("button", { name: "내 변경 저장", exact: true })).not.toBeVisible();
    expect(server.failures).toEqual([]);
  });
}

test("a remote block edit preserves and saves a pending local title", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await title.fill("LOCAL TITLE DRAFT");
  // The title has committed locally; the 700 ms HTTP save has not.
  await page.clock.runFor(350);
  expect((await savedPages(page))["page-1"].title).toBe("LOCAL TITLE DRAFT");

  const remote: ServerPage = {
    ...server.pages["page-1"], revision: server.pages["page-1"].revision + 1,
    blocks: [{ id: "page-1-block", type: "paragraph", content: "OTHER USER BLOCK EDIT" }],
  };
  server.pages["page-1"] = remote;
  server.send("page-1", {
    type: "page.updated", page: remote, actorId: "other-user",
    changedBlockIds: ["page-1-block"], structural: false,
  });
  await expect(documentEditor(page)).toHaveText("OTHER USER BLOCK EDIT");
  await expect(title).toHaveValue("LOCAL TITLE DRAFT");
  expect((await savedPages(page))["page-1"].title).toBe("LOCAL TITLE DRAFT");
  await page.clock.runFor(1_500);
  await expect.poll(() => server.pages["page-1"].title).toBe("LOCAL TITLE DRAFT");
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("OTHER USER BLOCK EDIT");
  expect(server.failures).toEqual([]);
});

test("logging out does not expose private documents in the guest workspace", async ({ page }) => {
  const server = await mockWorkspace(page);
  let loggedOut = false;
  await page.route("**/api/auth/logout", async (route) => {
    loggedOut = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/me", async (route) => {
    if (!loggedOut) return route.fallback();
    await route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } });
  });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBeNull();
  await expect(page.locator(".bn-editor").first()).not.toContainText("PAGE ONE ORIGINAL");
  expect((await savedPages(page))["page-1"]).toBeUndefined();
  await page.reload();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  await expect(page.locator(".bn-editor").first()).not.toContainText("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});

test("signing back into a cached account preserves a note written in the guest home", async ({ page }) => {
  const server = await mockWorkspace(page);
  let loggedOut = false;
  await page.route("**/api/auth/logout", async (route) => {
    loggedOut = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/me", async (route) => {
    if (!loggedOut) return route.fallback();
    await route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } });
  });
  await page.route("**/api/auth/login", async (route) => {
    loggedOut = false;
    await route.fulfill({ json: { data: { user: {
      id: currentUserId, name: "테스트", email: "test@example.invalid", role: "member", avatarColor: "purple",
    } } } });
  });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  await editDocument(page, "GUEST NOTE AFTER LOGOUT");

  await page.getByRole("button", { name: "로그인", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nodi에 로그인" });
  await dialog.getByPlaceholder("name@example.com").fill("test@example.invalid");
  await dialog.getByPlaceholder("8자 이상").fill("password-for-test");
  await dialog.getByRole("button", { name: "로그인", exact: true }).click();
  await expect.poll(() => Object.values(server.pages).some((entry) => JSON.stringify(entry.blocks).includes("GUEST NOTE AFTER LOGOUT"))).toBe(true);
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("PAGE ONE ORIGINAL");
  expect(JSON.stringify(server.pages["quick-note"].blocks)).toContain("HOME ORIGINAL");
  await expect.poll(async () => Object.values(await savedPages(page)).some((entry) => JSON.stringify(entry.blocks).includes("GUEST NOTE AFTER LOGOUT"))).toBe(true);
  expect(server.failures).toEqual([]);
});

test("workspace loading follows every page cursor before resolving a deep link", async ({ page }) => {
  const server = await mockWorkspace(page);
  const allPages = Array.from({ length: 501 }, (_, index) => (
    makePage(`many-${String(index + 1).padStart(3, "0")}`, `페이지 ${index + 1}`, `BODY ${index + 1}`)
  ));
  allPages.forEach((entry) => { server.pages[entry.id] = entry; });
  const cursors: Array<string | null> = [];
  const nextCursor = "NTAwOm1hbnktNTAw";
  await page.route("**/api/pages?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    expect(cursor === null || cursor === nextCursor).toBe(true);
    await route.fulfill({ json: {
      data: cursor ? allPages.slice(500) : allPages.slice(0, 500),
      meta: { nextCursor: cursor ? null : nextCursor },
    } });
  });
  await page.goto("/?page=many-501");
  await expect(documentEditor(page)).toHaveText("BODY 501");
  await expect(page).toHaveURL((url) => url.searchParams.get("page") === "many-501");
  const cached = await savedPages(page);
  expect(allPages.every((entry) => cached[entry.id])).toBe(true);
  // Development StrictMode can replay bootstrap; each requested page must
  // still be present, regardless of how many bootstrap attempts were made.
  expect(cursors).toContain(null);
  expect(cursors).toContain(nextCursor);
  expect(server.failures).toEqual([]);
});

test("leaving the document aborts an in-flight background refresh and preserves the newly opened page", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].title = "서버에서 읽은 페이지 1";
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toHaveValue("서버에서 읽은 페이지 1");
  await page.clock.install();
  await page.clock.runFor(1_500);

  // Observe the real fetch after bootstrap so initialization requests are not
  // mistaken for the background refresh whose lifetime is under test.
  await page.evaluate(() => {
    const state = window as typeof window & { reviewRefreshSignal?: AbortSignal | null };
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pages/page-1" && (init?.method ?? "GET") === "GET") {
        state.reviewRefreshSignal = init?.signal;
      }
      return fetch(input, init);
    };
  });
  const release = deferred();
  const finished = deferred();
  let started = false;
  await page.route("**/api/pages/page-1", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started = true;
    await release.promise;
    try {
      await route.fulfill({ json: { data: {
        ...server.pages["page-1"], revision: 100,
        blocks: [{ id: "page-1-block", type: "paragraph", content: "STALE BACKGROUND RESPONSE" }],
      } } });
    } finally { finished.resolve(); }
  });
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(100);
    return started;
  }).toBe(true);
  expect(await page.evaluate(() => {
    const signal = (window as typeof window & { reviewRefreshSignal?: AbortSignal | null }).reviewRefreshSignal;
    return Boolean(signal && !signal.aborted);
  })).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { reviewRefreshSignal?: AbortSignal | null }).reviewRefreshSignal?.aborted
  ))).toBe(true);
  await openPage(page, "page-2", "PAGE TWO ORIGINAL");
  release.resolve();
  await finished.promise;
  await page.clock.runFor(100);
  await expect(documentEditor(page)).toHaveText("PAGE TWO ORIGINAL");
  await expect(page).toHaveURL((url) => url.searchParams.get("page") === "page-2");
  expect(JSON.stringify((await savedPages(page))["page-2"].blocks)).not.toContain("STALE BACKGROUND RESPONSE");
  expect(server.failures).toEqual([]);
});
