import { expect, test } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";

test("a remote insertion at the top does not scroll away from the focused title", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => ({ id: `line-${i}`, type: "paragraph", content: `LINE ${i} original content` }));
  await page.goto("/?page=page-1");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const title = page.getByRole("textbox", { name: "페이지 제목", exact: true });
  await title.focus();
  await page.locator(".editor-stage").evaluate(element => { element.scrollTop = 0; });
  const remote = structuredClone(server.pages["page-1"]);
  remote.revision++;
  remote.blocks!.unshift({ id: "remote-new", type: "paragraph", content: "REMOTE FIRST PARAGRAPH" });
  server.pages["page-1"] = remote;
  server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", structural: true });
  await expect(documentEditor(page)).toContainText("REMOTE FIRST PARAGRAPH");
  await expect(title).toBeFocused();
  expect(await page.locator(".editor-stage").evaluate(element => element.scrollTop)).toBe(0);
  expect(server.failures).toEqual([]);
});
