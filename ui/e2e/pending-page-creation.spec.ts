import { expect, test } from "@playwright/test";
import { documentEditor, makePage, mockWorkspace } from "./workspace-fixture";

test("reload recovers a page whose creation has not reached the server", async ({ page }) => {
  const server = await mockWorkspace(page);
  const pending = { ...makePage("pending-child", "저장 전 새 문서", "UNSAVED NEW PAGE CONTENT"), revision: undefined, parentId: "quick-note" };
  await page.addInitScript(pending => {
    const pages = JSON.parse(localStorage.getItem("nodi:pages")!);
    pages[pending.id] = pending;
    localStorage.setItem("nodi:pages", JSON.stringify(pages));
  }, pending);
  await page.goto("/?page=pending-child");
  await expect.poll(() => server.pages["pending-child"]?.title).toBe("저장 전 새 문서");
  expect(server.pages["pending-child"].parentId).toBeNull();
  expect(JSON.stringify(server.pages["pending-child"].blocks)).toContain("UNSAVED NEW PAGE CONTENT");
  await expect(documentEditor(page)).toContainText("UNSAVED NEW PAGE CONTENT");
  expect(server.failures).toEqual([]);
});
