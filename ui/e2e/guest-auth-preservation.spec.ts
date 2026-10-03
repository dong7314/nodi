import { expect, test, type Page } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace } from "./workspace-fixture";

const user = {
  id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid",
  role: "member", avatarColor: "purple",
};

async function guestWorkspace(page: Page) {
  const server = await mockWorkspace(page);
  let signedIn = true;
  await page.route("**/api/auth/me", (route) => signedIn
    ? route.fulfill({ json: { data: user } })
    : route.fulfill({ status: 401, json: { error: { code: "INVALID_SESSION" } } }));
  await page.route("**/api/auth/logout", (route) => {
    signedIn = false;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toHaveText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "프로필 설정 열기", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("dialog", { name: "로그아웃", exact: true }).getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true }).first()).toBeVisible();
  return { ...server, signedIn: () => { signedIn = true; } };
}

async function openLogin(page: Page) {
  await page.getByRole("button", { name: "로그인", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nodi에 로그인" });
  await dialog.getByPlaceholder("name@example.com").fill(user.email);
  await dialog.getByPlaceholder("8자 이상").fill("test-password");
  return dialog;
}

test("login cannot discard a guest table whose latest cells only exist in memory", async ({ page }) => {
  await guestWorkspace(page);
  await page.evaluate(() => {
    const pages = JSON.parse(localStorage.getItem("nodi:pages")!);
    pages["quick-note"].blocks = [{ id: "guest-table", type: "database", props: { databaseId: "guest-db" } }];
    localStorage.setItem("nodi:pages", JSON.stringify(pages));
    localStorage.setItem("nodi:database:guest-db", JSON.stringify({ name: "게스트 표", properties: [{ id: "name", name: "이름", type: "text", options: [] }], records: [{ id: "row", values: { name: "OLD CELL" } }], trash: [], views: [{ id: "table", type: "table", name: "표" }], activeViewId: "table" }));
  });
  await page.reload();
  const cell = page.getByRole("textbox", { name: "이름 값", exact: true });
  await expect(cell).toHaveValue("OLD CELL");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).rejectGuestTable = true;
    Storage.prototype.setItem = function(key, value) {
      if ((window as any).rejectGuestTable && key === "nodi:database:guest-db") throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await cell.fill("LATEST GUEST CELL");
  let attempts = 0;
  await page.route("**/api/auth/login", route => {
    attempts++;
    return route.fulfill({ status: 401, json: { error: { code: "INVALID_CREDENTIALS", message: "test retry" } } });
  });
  const dialog = await openLogin(page);
  const submit = dialog.getByRole("button", { name: "로그인", exact: true });
  await submit.click();
  await expect(dialog.getByRole("status")).toContainText("작성 중인 메모를 보관할 저장 공간이 부족해요");
  expect(attempts).toBe(0);
  await expect(cell).toHaveValue("LATEST GUEST CELL");
  await page.evaluate(() => { (window as any).rejectGuestTable = false; });
  await submit.click();
  await expect(dialog.getByRole("status")).toContainText("test retry");
  expect(attempts).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("nodi:database:guest-db"))).toContain("LATEST GUEST CELL");
});

for (const mode of ["login", "signup"] as const) {
  test(`${mode} preserves a memory-only guest draft at real storage quota and permits retry`, async ({ page }) => {
    const server = await guestWorkspace(page);
    let authRequests = 0;
    await page.route(`**/api/auth/${mode === "login" ? "login" : "register"}`, (route) => {
      authRequests += 1;
      server.signedIn();
      return route.fulfill({ json: { data: { user, status: "approved" } } });
    });
    const quotaReached = await page.evaluate(() => {
      let last = -1;
      let reached = false;
      try {
        for (let index = 0; index < 512; index += 1) {
          localStorage.setItem(`guest-auth-quota-${index}`, "x".repeat(64 * 1024));
          last = index;
        }
      } catch (error) {
        reached = error instanceof DOMException && error.name === "QuotaExceededError";
      }
      // Leave room for small authentication metadata, but not the new note.
      if (last >= 0) localStorage.removeItem(`guest-auth-quota-${last}`);
      return reached;
    });
    expect(quotaReached).toBe(true);
    const marker = `GUEST_REAL_QUOTA_${mode}_`;
    await editDocument(page, marker + "q".repeat(150 * 1024));
    expect(await page.evaluate(() => localStorage.getItem("nodi:pages"))).not.toContain(marker);
    let dialog = await openLogin(page);
    if (mode === "signup") {
      await dialog.getByRole("tab", { name: "회원가입", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "로컬 계정 만들기" });
      await dialog.getByPlaceholder("Nodi에서 사용할 이름").fill("테스트");
      await dialog.getByPlaceholder("8자 이상").fill("test-password");
      await dialog.getByPlaceholder("비밀번호를 다시 입력").fill("test-password");
    }
    const submit = dialog.getByRole("button", { name: mode === "login" ? "로그인" : "회원가입 요청", exact: true });
    await submit.click();
    await expect(dialog.getByRole("status")).toContainText("작성 중인 메모를 보관할 저장 공간이 부족해요");
    expect(authRequests).toBe(0);
    await expect(documentEditor(page)).toContainText(marker);
    expect(await page.evaluate(() => localStorage.getItem("nodi:auth:session"))).toBeNull();
    await expect(page.getByRole("button", { name: "인증 창 닫기", exact: true })).toBeEnabled();
    await expect(page.locator(".app-shell")).not.toHaveAttribute("inert");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("guest-auth-quota-")) localStorage.removeItem(key);
    });
    await submit.click();
    await expect(page.getByRole("button", { name: "프로필 설정 열기", exact: true })).toBeVisible();
    expect(authRequests).toBe(1);
    await expect.poll(() => Object.values(server.pages).some((entry) => JSON.stringify(entry.blocks).includes(marker))).toBe(true);
    const imported = Object.values(server.pages).find((entry) => JSON.stringify(entry.blocks).includes(marker))!;
    await page.goto(`/?page=${imported.id}`);
    await expect(documentEditor(page)).toContainText(marker);
    expect(server.failures).toEqual([]);
  });
}

test("pending login keeps the guest editor and dialog stable, then unlocks after failure", async ({ page }) => {
  const server = await guestWorkspace(page);
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  await page.route("**/api/auth/login", async (route) => {
    started = true;
    await gate;
    if (fail) return route.fulfill({ status: 401, json: { error: { code: "INVALID_CREDENTIALS", message: "다시 확인해 주세요" } } });
    server.signedIn();
    return route.fulfill({ json: { data: { user } } });
  });
  await editDocument(page, "PENDING LOGIN GUEST DRAFT");
  const dialog = await openLogin(page);
  await dialog.getByRole("button", { name: "로그인", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  await expect(page.locator(".bn-editor").first()).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "인증 창 닫기", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "인증 창 바깥 영역 닫기", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("tab", { name: "회원가입", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("status")).toContainText("다시 확인해 주세요");
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert");
  await expect(documentEditor(page)).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", { name: "인증 창 닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await editDocument(page, " AFTER FAILED REQUEST");
  fail = false;
  const retry = await openLogin(page);
  await retry.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "프로필 설정 열기", exact: true })).toBeVisible();
  await expect.poll(() => Object.values(server.pages).some((entry) => JSON.stringify(entry.blocks).includes("PENDING LOGIN GUEST DRAFT AFTER FAILED REQUEST"))).toBe(true);
  expect(server.failures).toEqual([]);
});
