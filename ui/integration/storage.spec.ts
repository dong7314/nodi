import { test, expect, request, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const api = "http://127.0.0.1:18787/v1";
const password = "integration-test-password";
let admin: APIRequestContext;
let adminState: Awaited<ReturnType<APIRequestContext["storageState"]>>;

test.beforeAll(async () => {
  admin = await request.newContext();
  const account = { name: "테스트 관리자", email: "browser-admin@example.invalid", password };
  const registration = await admin.post(`${api}/auth/register`, { data: account });
  if (registration.status() === 409) expect((await admin.post(`${api}/auth/login`, { data: { email: account.email, password } })).ok()).toBe(true);
  else expect(registration.status()).toBe(201);
  adminState = await admin.storageState();
});
test.afterAll(async () => { await admin?.dispose(); });

async function seed(context: BrowserContext, blocks: unknown[]) {
  await context.addCookies(adminState.cookies);
  const id = `page-${randomUUID()}`;
  const result = await context.request.post(`${api}/pages`, { data: { id, title: "실제 연동 문서", settings: { showProperties: false }, blocks } });
  expect(result.status()).toBe(201);
  return id;
}
async function prepare(page: Page) {
  const me = await page.context().request.get(`${api}/auth/me`);
  const { data: user } = await me.json();
  await page.addInitScript((user) => {
    localStorage.setItem("nodi:auth:accounts", JSON.stringify([{ ...user, status: "approved" }]));
    localStorage.setItem("nodi:auth:session", JSON.stringify({ userId: user.id }));
    localStorage.setItem(`nodi:guest-workspace-migrated:${user.id}:v1`, "done");
  }, user);
}
async function readDatabase(id: string) {
  return (await (await admin.get(`${api}/databases/${id}`)).json()).data;
}
async function pasteFile(page: Page, name: string, mime: string, bytes: number[], selector = ".bn-editor[contenteditable=true]") {
  await page.locator(selector).first().focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.evaluate(({ name, mime, bytes, selector }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mime }));
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    // Firefox drops files passed to the synthetic ClipboardEvent constructor.
    // Supply the same payload a native clipboard file paste exposes.
    if (!event.clipboardData?.files.length) Object.defineProperty(event, "clipboardData", { value: transfer });
    document.querySelector(selector)!.dispatchEvent(event);
  }, { name, mime, bytes, selector });
}

test("real MinIO image and file uploads survive reload and require authorization", async ({ page, context }) => {
  const id = await seed(context, [{ id: "intro", type: "paragraph", content: "업로드 검증" }]);
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?page=${id}`);
  await expect(page.locator(".bn-editor").first()).toContainText("업로드 검증");
  const png = [...Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")];
  const files = [{ name: "한글 이미지.png", mime: "image/png", bytes: png }, { name: "메모.txt", mime: "text/plain", bytes: [...Buffer.from("실제 파일 내용\n", "utf8")] }];
  for (const file of files) {
    const presign = page.waitForResponse((r) => r.url().endsWith("/attachments/presign"));
    const complete = page.waitForResponse((r) => r.url().includes("/attachments/") && r.url().endsWith("/complete"));
    await pasteFile(page, file.name, file.mime, file.bytes);
    const response = await complete;
    expect(response.ok()).toBe(true);
    const { assetUrl } = await (await presign).json();
    const download = await context.request.get(assetUrl);
    expect(download.ok()).toBe(true);
    expect([...await download.body()]).toEqual(file.bytes);
    const anonymous = await request.newContext();
    expect((await anonymous.get(assetUrl)).ok()).toBe(false);
    await anonymous.dispose();
    await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${id}`)).json()).data.blocks)).toContain(assetUrl);
  }
  await page.reload();
  const img = page.locator('.bn-editor img[src*="/attachments/"]');
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.locator(".bn-editor").first()).toContainText("메모.txt");
  expect(errors).toEqual([]);
});

test("two authenticated editors merge different cells and resolve same-cell conflicts", async ({ page, context, browser }) => {
  const databaseId = `db-${randomUUID()}`;
  const id = await seed(context, [{ id: "intro", type: "paragraph", content: "공동 편집 검증" }, { id: "table-block", type: "database", props: { databaseId } }]);
  const state = {
    name: "공유 표", properties: [{ id: "name", name: "이름", type: "text", options: [] }, { id: "note", name: "메모", type: "text", options: [] }],
    records: [{ id: "row", values: { name: "처음 이름", note: "처음 메모" } }], trash: [], views: [{ id: "table", type: "table", name: "테이블" }], activeViewId: "table",
  };
  expect((await admin.put(`${api}/databases/${databaseId}`, { data: { pageId: id, state } })).ok()).toBe(true);
  const otherContext = await browser.newContext();
  try {
    const email = `member-${randomUUID()}@example.invalid`;
    expect((await otherContext.request.post(`${api}/auth/register`, { data: { name: "공동 편집자", email, password } })).status()).toBe(202);
    const directory = (await (await admin.get(`${api}/auth/registration-requests`)).json()).data;
    const member = directory.find((item: { email: string }) => item.email === email);
    expect(member).toBeTruthy();
    expect((await admin.patch(`${api}/auth/registration-requests/${member.id}`, { data: { status: "approved" } })).ok()).toBe(true);
    expect((await otherContext.request.post(`${api}/auth/login`, { data: { email, password } })).ok()).toBe(true);
    expect((await admin.put(`${api}/pages/${id}/shares/${member.id}`, { data: { permission: "edit" } })).ok()).toBe(true);
    const other = await otherContext.newPage();
    await prepare(page); await prepare(other);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message)); other.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/?page=${id}`); await other.goto(`http://127.0.0.1:4184/?page=${id}`);
    const firstName = page.getByRole("textbox", { name: "이름 값", exact: true });
    const secondName = other.getByRole("textbox", { name: "이름 값", exact: true });
    await expect(firstName).toHaveValue("처음 이름"); await expect(secondName).toHaveValue("처음 이름");
    await page.clock.install(); await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await other.clock.install(); await other.clock.pauseAt((await other.evaluate(() => Date.now())) + 100);
    await firstName.fill("첫 사용자 이름");
    await other.getByRole("textbox", { name: "메모 값", exact: true }).fill("다른 사용자 메모");
    await page.clock.runFor(700); await other.clock.runFor(700);
    await expect.poll(async () => (await readDatabase(databaseId)).state.records[0].values).toEqual({ name: "첫 사용자 이름", note: "다른 사용자 메모" });
    const mergedRevision = (await readDatabase(databaseId)).revision;
    await page.clock.runFor(2000); await other.clock.runFor(2000);
    expect((await readDatabase(databaseId)).revision).toBe(mergedRevision);
    // Both editors must observe the merged snapshot before the next edit.
    await expect(secondName).toHaveValue("첫 사용자 이름");
    await expect(page.getByRole("textbox", { name: "메모 값", exact: true })).toHaveValue("다른 사용자 메모");
    await firstName.fill("첫 사용자 최종"); await secondName.fill("두 번째 사용자 최종");
    await page.clock.runFor(700);
    await expect.poll(async () => (await readDatabase(databaseId)).state.records[0].values.name).toBe("첫 사용자 최종");
    await other.clock.runFor(700);
    await other.getByRole("button", { name: "변경 비교", exact: true }).click();
    await other.getByRole("radio", { name: "내 변경 두 번째 사용자 최종", exact: true }).check();
    await other.getByRole("button", { name: "선택한 내용 저장" }).click();
    await expect.poll(async () => (await readDatabase(databaseId)).state.records[0].values.name).toBe("두 번째 사용자 최종");
    await expect(firstName).toHaveValue("두 번째 사용자 최종");
    await other.reload();
    await expect(secondName).toHaveValue("두 번째 사용자 최종");
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});

test("an upload finishing after navigation remains attached to its original page", async ({ page, context }) => {
  const first = await seed(context, [{ id: "first-intro", type: "paragraph", content: "첫 업로드 문서" }]);
  const second = await seed(context, [{ id: "second-intro", type: "paragraph", content: "두 번째 문서" }]);
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?page=${first}`);
  await expect(page.locator(".bn-editor").first()).toContainText("첫 업로드 문서");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route("http://127.0.0.1:19000/**", async (route) => {
    if (route.request().method() === "PUT") { started(); await gate; }
    await route.continue();
  });
  await pasteFile(page, "지연 파일.txt", "text/plain", [...Buffer.from("지연 업로드")]);
  await uploadStarted;
  await page.locator(`[data-sidebar-page-id="${second}"]`).first().click();
  await expect(page.locator(".bn-editor").first()).toContainText("두 번째 문서");
  release();
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${first}`)).json()).data.blocks)).toContain("/attachments/");
  const secondBlocks = (await (await admin.get(`${api}/pages/${second}`)).json()).data.blocks;
  expect(JSON.stringify(secondBlocks)).not.toContain("/attachments/");
  await page.locator(`[data-sidebar-page-id="${first}"]`).first().click();
  await expect(page.locator(".bn-editor").first()).toContainText("지연 파일.txt");
  expect(errors).toEqual([]);
});

test("closing a preview during upload preserves its attachment", async ({ page, context }) => {
  const id = await seed(context, [{ id: "intro", type: "paragraph", content: "미리보기 문서" }]);
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?page=${id}`);
  await expect(page.locator(".bn-editor").first()).toContainText("미리보기 문서");
  await page.locator(`[data-sidebar-page-id="${id}"]`).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route("http://127.0.0.1:19000/**", async (route) => {
    if (route.request().method() === "PUT") { started(); await gate; }
    await route.continue();
  });
  await pasteFile(page, "미리보기 첨부.txt", "text/plain", [...Buffer.from("preview upload")], '[role="dialog"] .bn-editor[contenteditable=true]');
  await uploadStarted;
  await page.getByRole("button", { name: "페이지 미리보기 닫기" }).click();
  await expect(page.locator('[role="dialog"] .bn-editor')).not.toBeVisible();
  release();
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${id}`)).json()).data.blocks)).toContain("/attachments/");
  await page.reload();
  await expect(page.locator(".bn-editor").first()).toContainText("미리보기 첨부.txt");
  expect(errors).toEqual([]);
});

test("the file picker uploads through the existing file panel", async ({ page, context }) => {
  const id = await seed(context, [{ id: "intro", type: "paragraph", content: "파일 선택 검증" }, { id: "file-block", type: "file", props: { url: "", name: "" } }]);
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?page=${id}`);
  await page.getByText("파일 추가", { exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "선택한 파일.txt", mimeType: "text/plain", buffer: Buffer.from("picker upload") });
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${id}`)).json()).data.blocks)).toContain("/attachments/");
  await page.reload();
  await expect(page.locator(".bn-editor").first()).toContainText("선택한 파일.txt");
  expect(errors).toEqual([]);
});

test("a copied image survives source deletion and is removed after its last page is deleted", async ({ page, context }) => {
  const source = await seed(context, [{ id: "source-intro", type: "paragraph", content: "이미지 원본" }]);
  const destination = await seed(context, [{ id: "destination-intro", type: "paragraph", content: "이미지 복사본" }]);
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/?page=${source}`);
  await expect(page.locator(".bn-editor").first()).toContainText("이미지 원본");
  const bytes = [...Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64")];
  const presign = page.waitForResponse(response => response.url().endsWith("/attachments/presign"));
  await pasteFile(page, "복사할 이미지.png", "image/png", bytes);
  const { assetUrl } = await (await presign).json();
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${source}`)).json()).data.blocks)).toContain(assetUrl);
  const editor = page.locator(".bn-editor[contenteditable=true]").first();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.locator(`[data-sidebar-page-id="${destination}"]`).first().click();
  await expect(editor).toContainText("이미지 복사본");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${destination}`)).json()).data.blocks)).toContain(assetUrl);

  expect((await admin.delete(`${api}/pages/${source}?hard=true`)).status()).toBe(204);
  const download = await context.request.get(assetUrl);
  expect(download.ok()).toBe(true);
  expect([...await download.body()]).toEqual(bytes);
  const anonymous = await request.newContext();
  try { expect((await anonymous.get(assetUrl)).ok()).toBe(false); }
  finally { await anonymous.dispose(); }
  await page.reload();
  const image = editor.locator('img[src*="/attachments/"]');
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  expect((await admin.delete(`${api}/pages/${destination}?hard=true`)).status()).toBe(204);
  expect((await context.request.get(assetUrl)).status()).toBe(404);
  expect(errors).toEqual([]);
});

test("two shared-page editors retain their own caret and viewport during table and structural edits", async ({ page, context, browser }) => {
  const paragraph = (id: string, text: string) => ({ id, type: "paragraph", content: text });
  const nativeTable = (id: string, text: string) => ({ id, type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text, styles: {} }]] }] } });
  const blocks: unknown[] = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
  blocks[4] = nativeTable("line-4", "REMOTE TABLE");
  blocks[60] = nativeTable("line-60", "LOCAL TABLE");
  const id = await seed(context, blocks);
  const otherContext = await browser.newContext();
  try {
    const email = `scroll-member-${randomUUID()}@example.invalid`;
    expect((await otherContext.request.post(`${api}/auth/register`, { data: { name: "공동 편집자", email, password } })).status()).toBe(202);
    const directory = (await (await admin.get(`${api}/auth/registration-requests`)).json()).data;
    const member = directory.find((item: { email: string }) => item.email === email);
    expect(member).toBeTruthy();
    expect((await admin.patch(`${api}/auth/registration-requests/${member.id}`, { data: { status: "approved" } })).ok()).toBe(true);
    expect((await otherContext.request.post(`${api}/auth/login`, { data: { email, password } })).ok()).toBe(true);
    expect((await admin.put(`${api}/pages/${id}/shares/${member.id}`, { data: { permission: "edit" } })).ok()).toBe(true);
    const other = await otherContext.newPage();
    await prepare(page); await prepare(other);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    other.on("pageerror", error => errors.push(error.message));
    const roomReady = (target: Page) => target.waitForEvent("websocket", {
      predicate: socket => socket.url().includes(`/pages/${id}/realtime`),
    }).then(socket => socket.waitForEvent("framereceived", {
      predicate: frame => JSON.parse(String(frame.payload)).type === "page.snapshot",
    }));
    const bothReady = Promise.all([roomReady(page), roomReady(other)]);
    await page.goto(`/?page=${id}`); await other.goto(`http://127.0.0.1:4184/?page=${id}`);
    await bothReady;
    await Promise.all([page, other].map(target => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
    const local = page.locator('.bn-editor [data-id="line-60"] td p').first();
    const remote = other.locator('.bn-editor [data-id="line-4"] td p').first();
    await expect(local).toHaveText("LOCAL TABLE");
    await expect(remote).toHaveText("REMOTE TABLE");
    await local.click();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest("[data-id]")?.getAttribute("data-id"))).toBe("line-60");
    await page.keyboard.insertText(" LOCAL INPUT");
    await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
    await expect(other.locator('.bn-editor [data-id="line-60"] td p').first()).toContainText("LOCAL INPUT");
    await local.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const position = () => page.evaluate(() => {
      const selection = window.getSelection()!;
      const block = selection.anchorNode?.parentElement?.closest("[data-id]");
      return { id: block?.getAttribute("data-id"), top: block?.getBoundingClientRect().top };
    });
    const before = await position();
    expect(before.id).toBe("line-60");
    await remote.click();
    await other.keyboard.insertText(" PEER TABLE EDIT");
    await expect(page.locator('.bn-editor [data-id="line-4"] td p').first()).toContainText("PEER TABLE EDIT");
    expect((await position()).id).toBe("line-60");
    expect(Math.abs((await position()).top! - before.top!)).toBeLessThan(3);
    await page.keyboard.insertText(" AFTER TABLE");
    await expect(local).toContainText("LOCAL INPUT AFTER TABLE");
    await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
    await expect(other.locator('.bn-editor [data-id="line-60"] td p').first()).toContainText("AFTER TABLE");

    await other.locator('.bn-editor [data-id="line-5"] .bn-inline-content').first().click();
    await other.keyboard.press("Enter");
    await other.keyboard.insertText("PEER NEW PARAGRAPH");
    await expect(page.locator(".bn-editor").first()).toContainText("PEER NEW PARAGRAPH");
    expect((await position()).id).toBe("line-60");
    expect(Math.abs((await position()).top! - before.top!)).toBeLessThan(3);
    await page.keyboard.insertText(" AFTER STRUCTURE");
    await expect(local).toContainText("LOCAL INPUT AFTER TABLE AFTER STRUCTURE");
    await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${id}`)).json()).data.blocks))
      .toContain("LOCAL INPUT AFTER TABLE AFTER STRUCTURE");
    await expect(other.locator('.bn-editor [data-id="line-60"] td p').first()).toContainText("AFTER STRUCTURE");
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});

for (const creatorRole of ["owner", "member"] as const) {
  test(`a ${creatorRole} creates a child with /page and every parent member inherits access`, async ({ page, context, browser }) => {
    const root = await seed(context, [{ id: "intro", type: "paragraph", content: "상위 공유 문서" }]);
    const otherContext = await browser.newContext();
    try {
      const email = `child-member-${randomUUID()}@example.invalid`;
      expect((await otherContext.request.post(`${api}/auth/register`, { data: { name: "하위 페이지 동료", email, password } })).status()).toBe(202);
      const directory = (await (await admin.get(`${api}/auth/registration-requests`)).json()).data;
      const member = directory.find((item: { email: string }) => item.email === email);
      expect((await admin.patch(`${api}/auth/registration-requests/${member.id}`, { data: { status: "approved" } })).ok()).toBe(true);
      expect((await otherContext.request.post(`${api}/auth/login`, { data: { email, password } })).ok()).toBe(true);
      expect((await admin.put(`${api}/pages/${root}/shares/${member.id}`, { data: { permission: "edit" } })).ok()).toBe(true);
      const other = await otherContext.newPage();
      await prepare(page); await prepare(other);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message)); other.on("pageerror", error => errors.push(error.message));
      await page.goto(`/?page=${root}`); await other.goto(`http://127.0.0.1:4184/?page=${root}`);
      for (const target of [page, other]) await expect(target.locator(".bn-editor").first()).toContainText("상위 공유 문서");
      const creator = creatorRole === "owner" ? page : other;
      const receiver = creatorRole === "owner" ? other : page;
      const editor = creator.locator(".bn-editor[contenteditable=true]").first();
      await editor.click();
      await creator.keyboard.press("ControlOrMeta+End");
      await creator.keyboard.press("Enter");
      await creator.keyboard.type("/page");
      const creation = creator.waitForResponse(response => response.url() === `${api}/pages` && response.request().method() === "POST");
      await creator.getByRole("option").filter({ hasText: "현재 위치에 하위 페이지를 만들고 엽니다." }).click();
      const createdResponse = await creation;
      expect(createdResponse.status()).toBe(201);
      const { data: child } = await createdResponse.json();
      expect(child.parentId).toBe(root);
      expect(child.permission).toBe(creatorRole === "owner" ? "owner" : "edit");
      const title = `자동 공유 하위 문서 ${creatorRole}`;
      await creator.getByRole("textbox", { name: "미리보기 페이지 제목" }).fill(title);
      const preview = creator.locator('[role="dialog"] .bn-editor[contenteditable=true]');
      await preview.click(); await creator.keyboard.insertText("INHERITED CHILD CONTENT");
      await expect.poll(async () => (await (await admin.get(`${api}/pages/${child.id}`)).json()).data.title).toBe(title);
      await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${child.id}`)).json()).data.blocks)).toContain("INHERITED CHILD CONTENT");
      const presign = creator.waitForResponse(response => response.url().endsWith("/attachments/presign"));
      await pasteFile(creator, "상속된 첨부.txt", "text/plain", [...Buffer.from("inherited attachment")], '[role="dialog"] .bn-editor[contenteditable=true]');
      const { assetUrl } = await (await presign).json();
      await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/pages/${child.id}`)).json()).data.blocks)).toContain(assetUrl);
      expect(await (await receiver.context().request.get(assetUrl)).text()).toBe("inherited attachment");
      await expect(receiver.locator(".child-page-block").first()).toBeVisible();
      await receiver.locator(".child-page-block").first().click();
      await expect(receiver.getByRole("textbox", { name: "미리보기 페이지 제목" })).toHaveValue(title);
      await expect(receiver.locator('[role="dialog"] .bn-editor')).toContainText("INHERITED CHILD CONTENT");
      await expect(receiver.locator('[role="dialog"] .bn-editor')).toContainText("상속된 첨부.txt");
      const childGrants = (await (await admin.get(`${api}/pages/${child.id}/shares`)).json()).data.members;
      expect(childGrants).toHaveLength(1);
      expect(childGrants[0].inheritedFromPageId).toBe(root);
      expect(childGrants[0].directPermission).toBeUndefined();

      // The invited user's open child page must downgrade and revoke with its parent.
      await other.getByRole("button", { name: "전체 페이지로 열기" }).click();
      await expect(other).toHaveURL(new RegExp(`page=${child.id}`));
      await expect(other.locator(".bn-editor[contenteditable=true]").first()).toContainText("INHERITED CHILD CONTENT");
      expect((await admin.put(`${api}/pages/${root}/shares/${member.id}`, { data: { permission: "view" } })).ok()).toBe(true);
      await expect(other.locator(".bn-editor[contenteditable=false]").first()).toContainText("INHERITED CHILD CONTENT");
      expect((await otherContext.request.get(assetUrl)).ok()).toBe(true);
      expect((await otherContext.request.post(`${api}/pages`, { data: { id: `denied-${randomUUID()}`, parentId: child.id } })).status()).toBe(403);
      expect((await admin.delete(`${api}/pages/${root}/shares/${member.id}`)).status()).toBe(204);
      await expect(other).not.toHaveURL(new RegExp(`page=${child.id}`));
      expect((await otherContext.request.get(`${api}/pages/${child.id}`)).status()).toBe(404);
      expect((await otherContext.request.get(assetUrl)).status()).toBe(404);
      expect(errors).toEqual([]);
    } finally { await otherContext.close(); }
  });
}

test("a page created with /page from home persists and opens again after reload", async ({ page, context }) => {
  await context.addCookies(adminState.cookies);
  const intro = `홈 페이지 생성 검사 ${randomUUID()}`;
  // Each browser uses the same server account. Do not click a child-page link
  // left in its home by a previous run when placing the initial caret.
  expect((await admin.put(`${api}/home`, { data: {
    blocks: [{ id: "home-intro", type: "paragraph", content: intro }],
  } })).ok()).toBe(true);
  await prepare(page);
  await page.goto("/");
  const editor = page.locator(".bn-editor[contenteditable=true]").first();
  await expect(editor).toContainText(intro);
  await editor.locator('[data-id="home-intro"] .bn-inline-content').click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/page");
  const creation = page.waitForResponse(response => response.url() === `${api}/pages` && response.request().method() === "POST");
  await page.getByRole("option").filter({ hasText: "현재 위치에 하위 페이지를 만들고 엽니다." }).click();
  const response = await creation;
  expect(response.status()).toBe(201);
  const { data: child } = await response.json();
  expect(child.parentId).toBeNull();
  const title = `홈에서 생성한 문서 ${child.id}`;
  await page.getByRole("textbox", { name: "미리보기 페이지 제목" }).fill(title);
  await expect.poll(async () => (await (await admin.get(`${api}/pages/${child.id}`)).json()).data.title).toBe(title);
  await expect.poll(async () => JSON.stringify((await (await admin.get(`${api}/home`)).json()).data.blocks)).toContain(child.id);
  await page.reload();
  await page.locator(".child-page-block").filter({ hasText: title }).click();
  await expect(page.getByRole("textbox", { name: "미리보기 페이지 제목" })).toHaveValue(title);
});
