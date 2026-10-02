import { test, expect } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";
import { withDatabase } from "./database-fixture";

for (const mode of ["composing", "safari-229"] as const) {
  const init = { key: "Enter", code: "Enter", bubbles: true, isComposing: mode === "composing", keyCode: mode === "safari-229" ? 229 : 13 };
  test(`Korean ${mode} Enter does not prematurely commit a sidebar rename`, async ({ page }) => {
    const server = await mockWorkspace(page);
    await page.goto("/?page=page-1");
    await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
    await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "이름 바꾸기", exact: true }).click();
    const input = page.locator(".sidebar-inline-rename");
    await input.fill("한글 조합");
    await input.dispatchEvent("keydown", init);
    await expect(input).toBeVisible();
    await input.fill("한글 조합 완료");
    await input.press("Enter");
    await expect.poll(() => server.pages["page-1"].title).toBe("한글 조합 완료");
  });
  test(`Korean ${mode} Enter does not open a search result or finish a view rename`, async ({ page }) => {
    await withDatabase(page);
    await page.goto("/?page=page-1");
    await expect(page.getByRole("textbox", { name: "이름 값", exact: true })).toHaveValue("ORIGINAL CELL");
    await page.getByRole("tab", { name: "테이블", exact: true }).dblclick();
    const tabName = page.getByRole("textbox", { name: "테이블 탭 이름", exact: true });
    await tabName.fill("한글 보기");
    await tabName.dispatchEvent("keydown", init);
    await expect(tabName).toBeVisible();
    await tabName.press("Enter");
    await expect(page.getByRole("tab", { name: "한글 보기", exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.locator(".workspace-search-input");
    await search.fill("페이지");
    await search.dispatchEvent("keydown", init);
    await expect(search).toBeVisible();
  });
}
