import { test, expect } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";

test("touch navigation and browser back preserve each page's title and body", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "사이드바 닫기", exact: true }).tap();
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await title.tap();
  await title.fill("모바일 첫 페이지");
  await documentEditor(page).tap();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" 모바일 내용");
  await page.getByRole("button", { name: "사이드바 열기", exact: true }).tap();
  await page.locator('[data-sidebar-page-id="page-2"]').first().tap();
  await expect(documentEditor(page)).toContainText("PAGE TWO ORIGINAL");
  await page.getByRole("button", { name: "사이드바 닫기", exact: true }).tap();
  await title.fill("모바일 두 번째 페이지");
  await page.goBack();
  await expect(title).toHaveValue("모바일 첫 페이지");
  await expect(documentEditor(page)).toContainText("모바일 내용");
  await expect.poll(() => server.pages["page-2"].title).toBe("모바일 두 번째 페이지");
  expect(JSON.stringify(server.pages["page-2"].blocks)).not.toContain("모바일 내용");
});

test("touch settings can lock and unlock the page without losing content", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await page.getByRole("button", { name: "사이드바 닫기", exact: true }).tap();
  await page.getByRole("button", { name: "페이지 설정", exact: true }).tap();
  await page.locator(".setting-toggle").filter({ hasText: "페이지 잠금" }).tap();
  await page.getByRole("button", { name: "페이지 설정 닫기" }).tap();
  await expect(page.getByRole("dialog", { name: "페이지 설정", exact: true })).not.toBeVisible();
  await expect(page.locator(".bn-editor").first()).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "페이지 설정", exact: true }).tap();
  await page.locator(".setting-toggle").filter({ hasText: "페이지 잠금" }).tap();
  await page.getByRole("button", { name: "페이지 설정 닫기" }).tap();
  await expect(page.getByRole("dialog", { name: "페이지 설정", exact: true })).not.toBeVisible();
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
});
