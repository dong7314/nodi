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
