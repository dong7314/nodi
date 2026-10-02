import { test, expect } from "@playwright/test";
import { documentEditor, editDocument, mockWorkspace, openPage } from "./workspace-fixture";

test("folder creation, page creation, search and favorites retain the saved document", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "페이지 및 폴더 추가" }).click();
  await page.getByRole("menuitem", { name: /^폴더/ }).click();
  const folderName = page.getByRole("textbox", { name: "폴더 이름" });
  await folderName.fill("검증 폴더");
  await folderName.press("Enter");
  await expect.poll(() => Object.values(server.folders).some((folder) => folder.title === "검증 폴더")).toBe(true);
  await page.getByRole("button", { name: /검증 폴더/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 폴더에 페이지 추가" }).click();
  await page.getByRole("textbox", { name: "페이지 제목", exact: true }).fill("검색 검증 문서");
  await editDocument(page, "UNIQUE SEARCH CONTENT");
  await expect.poll(() => Object.values(server.pages).some((entry) => entry.title === "검색 검증 문서")).toBe(true);
  const saved = Object.values(server.pages).find((entry) => entry.title === "검색 검증 문서")!;
  expect(saved.folderId).toBe(Object.keys(server.folders)[0]);
  await page.getByRole("button", { name: "즐겨찾기에 추가", exact: true }).click();
  await expect.poll(() => Boolean(server.pages[saved.id].favoritedAt)).toBe(true);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".workspace-search-input").fill("UNIQUE SEARCH CONTENT");
  await expect(page.getByRole("dialog").getByText("검색 검증 문서", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(documentEditor(page)).toContainText("UNIQUE SEARCH CONTENT");
  await expect(page.getByRole("button", { name: "즐겨찾기에서 제거" })).toBeVisible();
  expect(server.failures).toEqual([]);
});

test("permanent deletion removes only the selected archived document", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-2"].archived = true;
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: /^휴지통/ }).click();
  await page.getByRole("button", { name: "영구 삭제", exact: true }).click();
  await page.getByRole("dialog", { name: "페이지 영구 삭제" }).getByRole("button", { name: "영구 삭제", exact: true }).click();
  await expect.poll(() => server.pages["page-2"]).toBeUndefined();
  await openPage(page, "page-1", "PAGE ONE ORIGINAL");
  await page.reload();
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});

test("a live permission downgrade immediately prevents text and metadata edits", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  server.pages["page-1"].permission = "view";
  server.send("page-1", { type: "permission.updated", permission: "view" });
  await expect(page.locator(".bn-editor").first()).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("textbox", { name: "페이지 제목", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "페이지 설정", exact: true })).not.toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  expect(JSON.stringify(server.pages["page-1"].blocks)).toContain("PAGE ONE ORIGINAL");
  expect(server.failures).toEqual([]);
});
