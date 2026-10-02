import { test, expect } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";

test("a failed clipboard upload removes its empty block and leaves text intact", async ({ page }) => {
  const server = await mockWorkspace(page);
  await page.route("**/api/attachments/presign", (route) => route.fulfill({ status: 503, json: { error: { message: "unavailable" } } }));
  await page.goto("/?page=page-1");
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await documentEditor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["failed upload"], "실패.txt", { type: "text/plain" }));
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    // Firefox drops files passed to the synthetic ClipboardEvent constructor.
    // Supply the same payload a native clipboard file paste exposes.
    if (!event.clipboardData?.files.length) Object.defineProperty(event, "clipboardData", { value: transfer });
    document.querySelector(".bn-editor")!.dispatchEvent(event);
  });
  await expect(page.getByText(/업로드 주소를 발급받지 못했습니다/)).toBeVisible();
  await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
  await expect(page.locator('[data-content-type="file"]')).toHaveCount(0);
  expect(server.failures).toEqual([]);
});

for (const format of ["text/plain", "text/html"]) {
  test(`clipboard ${format} keeps its existing priority when files are also present`, async ({ page }) => {
    const server = await mockWorkspace(page);
    await page.goto("/?page=page-1");
    await expect(documentEditor(page)).toContainText("PAGE ONE ORIGINAL");
    await documentEditor(page).focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.evaluate((format) => {
      const transfer = new DataTransfer();
      transfer.setData(format, format === "text/html" ? "<p>MIXED CLIPBOARD TEXT</p>" : "MIXED CLIPBOARD TEXT");
      transfer.items.add(new File(["file"], "mixed.txt", { type: "text/plain" }));
      const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      if (!event.clipboardData?.files.length) Object.defineProperty(event, "clipboardData", { value: transfer });
      document.querySelector(".bn-editor")!.dispatchEvent(event);
    }, format);
    await expect(documentEditor(page)).toContainText("MIXED CLIPBOARD TEXT");
    await expect(page.locator('[data-content-type="file"]')).toHaveCount(0);
    expect(server.failures).toEqual([]);
  });
}
