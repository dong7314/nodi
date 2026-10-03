import { expect, test, type Page } from "@playwright/test";
import { documentEditor, mockWorkspace } from "./workspace-fixture";

const paragraph = (id: string, text: string) => ({ id, type: "paragraph" as const, content: text });
const table = (id: string, text: string) => ({ id, type: "table" as const, content: { type: "tableContent" as const, rows: [{ cells: [[{ type: "text" as const, text, styles: {} }]] }] } });

async function cursor(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection()!;
    const element = selection.anchorNode?.parentElement;
    const block = element?.closest('[data-id]');
    const stage = document.querySelector(".editor-stage")!;
    return { id: block?.getAttribute("data-id"), offset: selection.anchorOffset,
      scroll: stage.scrollTop, top: block?.getBoundingClientRect().top };
  });
}

for (const kind of ["paragraph", "structure", "table"] as const) {
  test(`remote ${kind} edits keep the local caret and viewport`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].permission = "edit";
    server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
    if (kind === "table") {
      server.pages["page-1"].blocks[4] = table("line-4", "REMOTE TABLE");
      server.pages["page-1"].blocks[60] = table("line-60", "LOCAL TABLE");
    }
    await page.goto("/?page=page-1");
    await expect.poll(() => server.sockets.has("page-1")).toBe(true);
    const local = documentEditor(page).locator(kind === "table" ? '[data-id="line-60"] td p' : '[data-id="line-60"] .bn-inline-content').first();
    await local.click();
    await page.keyboard.insertText(" LOCAL INPUT");
    await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
    await local.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await cursor(page);
    expect(before.id).toBe("line-60");
    expect(before.scroll).toBeGreaterThan(1000);

    // Presence and edits arrive from a second participant above our viewport.
    server.send("page-1", { type: "presence.updated", participants: [{
      user: { id: "other-user", name: "동료", email: "other@example.invalid", role: "member", avatarColor: "blue" },
      activeBlockId: "line-4", updatedAt: new Date().toISOString(),
    }] as never });
    const remote = structuredClone(server.pages["page-1"]);
    remote.revision++;
    if (kind === "structure") remote.blocks!.splice(5, 0, paragraph("remote-new", "REMOTE NEW LINE"));
    else remote.blocks![4] = kind === "table" ? table("line-4", "REMOTE UPDATED") : paragraph("line-4", "REMOTE UPDATED");
    server.pages["page-1"] = remote;
    server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", changedBlockIds: [kind === "structure" ? "remote-new" : "line-4"], structural: kind === "structure" });
    await expect(documentEditor(page)).toContainText(kind === "structure" ? "REMOTE NEW LINE" : "REMOTE UPDATED");
    // A later keystroke is what makes an incorrectly moved caret scroll into view.
    expect((await cursor(page)).id).toBe("line-60");
    await page.keyboard.insertText(" AFTER REMOTE");
    await expect(local).toContainText("LOCAL INPUT AFTER REMOTE");
    const after = await cursor(page);
    expect(after.id).toBe("line-60");
    expect(Math.abs(after.top! - before.top!)).toBeLessThan(3);
    expect(server.failures).toEqual([]);
  });
}

for (const eventType of ["page.updated", "page.snapshot"] as const) {
  test(`${eventType} preserves a backwards text selection across structural changes`, async ({ page }) => {
    const server = await mockWorkspace(page);
    server.pages["page-1"].permission = "edit";
    server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
    await page.goto("/?page=page-1");
    await expect.poll(() => server.sockets.has("page-1")).toBe(true);
    const local = documentEditor(page).locator('[data-id="line-60"] .bn-inline-content').first();
    await local.click();
    await local.evaluate(element => {
      element.scrollIntoView({ block: "center" });
      const text = element.firstChild!;
      window.getSelection()!.setBaseAndExtent(text, 16, text, 8); // Select "original" backwards.
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("original");
    const before = await cursor(page);
    const remote = structuredClone(server.pages["page-1"]);
    remote.revision++;
    remote.blocks!.splice(5, 0, paragraph("remote-new", "REMOTE NEW LINE"));
    remote.blocks!.splice(85, 0, paragraph("remote-bottom", "REMOTE BOTTOM LINE"));
    server.pages["page-1"] = remote;
    server.send("page-1", { type: eventType, page: remote, actorId: "other-user", structural: true });
    await expect(documentEditor(page)).toContainText("REMOTE NEW LINE");
    expect(await page.evaluate(() => ({ text: window.getSelection()?.toString(), anchor: window.getSelection()?.anchorOffset, head: window.getSelection()?.focusOffset })))
      .toEqual({ text: "original", anchor: 16, head: 8 });
    expect((await cursor(page)).id).toBe("line-60");
    expect(Math.abs((await cursor(page)).top! - before.top!)).toBeLessThan(3);
    await page.keyboard.insertText("REPLACED");
    await expect(local).toHaveText("LINE 60 REPLACED content");
    expect(server.failures).toEqual([]);
  });
}

test("removing the selected block leaves a usable caret near the removed location", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "edit";
  server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
  await page.goto("/?page=page-1");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const local = documentEditor(page).locator('[data-id="line-60"] .bn-inline-content').first();
  await local.click();
  await local.evaluate(element => element.scrollIntoView({ block: "center" }));
  const remote = structuredClone(server.pages["page-1"]);
  remote.revision++;
  remote.blocks!.splice(60, 1);
  server.pages["page-1"] = remote;
  server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", structural: true, deletedBlockIds: ["line-60"] });
  await expect(local).toHaveCount(0);
  const position = await cursor(page);
  expect(["line-59", "line-61"]).toContain(position.id);
  await page.keyboard.insertText("LOCAL CONTINUED ");
  await expect(documentEditor(page).locator(`[data-id="${position.id}"]`).first()).toContainText("LOCAL CONTINUED");
  expect(server.failures).toEqual([]);
});

test("read-only viewing keeps a surviving visible block anchored when remote content grows or disappears", async ({ page }) => {
  const server = await mockWorkspace(page);
  server.pages["page-1"].permission = "view";
  server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
  await page.goto("/?page=page-1");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  const editor = page.locator(".bn-editor[contenteditable=false]").first();
  const reading = editor.locator('[data-id="line-60"]').first();
  await reading.evaluate(element => element.scrollIntoView({ block: "center" }));
  const before = await reading.evaluate(element => element.getBoundingClientRect().top);
  const remote = structuredClone(server.pages["page-1"]);
  remote.revision++;
  remote.blocks![4] = paragraph("line-4", "REMOTE LONG LINE ".repeat(100));
  server.pages["page-1"] = remote;
  server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", changedBlockIds: ["line-4"] });
  await expect(editor).toContainText("REMOTE LONG LINE");
  expect(Math.abs(await reading.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThan(3);
  const firstVisible = await page.evaluate(() => {
    const top = document.querySelector(".editor-stage")!.getBoundingClientRect().top;
    return [...document.querySelectorAll<HTMLElement>(".bn-editor [data-id]")].find(element => element.getBoundingClientRect().top >= top)?.dataset.id;
  });
  expect(firstVisible).toBeTruthy();
  const removed = structuredClone(remote);
  removed.revision++;
  removed.blocks = removed.blocks!.filter(block => block.id !== firstVisible);
  server.pages["page-1"] = removed;
  server.send("page-1", { type: "page.updated", page: removed, actorId: "other-user", structural: true, deletedBlockIds: [firstVisible!] });
  await expect(editor.locator(`[data-id="${firstVisible}"]`)).toHaveCount(0);
  expect(Math.abs(await reading.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThan(3);
  expect(server.failures).toEqual([]);
});

test("remote structural changes also preserve the active preview editor's caret and scroll", async ({ page }) => {
  const server = await mockWorkspace(page);
  const owner = { id: server.pages["page-1"].ownerId, name: "테스트", email: "test@example.invalid", role: "member", avatarColor: "purple" };
  const peer = { ...owner, id: "other-user", name: "동료", email: "other@example.invalid" };
  await page.route("**/api/shares", route => route.fulfill({ json: { data: [{
    pageId: "page-1", owner, updatedAt: "2026-10-03T00:00:00Z",
    members: [{ user: peer, permission: "edit", sharedAt: "2026-10-03T00:00:00Z" }],
  }] } }));
  server.pages["page-1"].blocks = Array.from({ length: 90 }, (_, i) => paragraph(`line-${i}`, `LINE ${i} original content`));
  await page.goto("/?page=page-1");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const preview = page.locator('[role="dialog"] .bn-editor[contenteditable=true]');
  const local = preview.locator('[data-id="line-60"] .bn-inline-content').first();
  await local.click();
  await page.keyboard.insertText(" LOCAL PREVIEW");
  await expect(page.getByText("저장됨", { exact: true })).toBeVisible();
  await local.evaluate(element => element.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await cursor(page);
  const remote = structuredClone(server.pages["page-1"]);
  remote.revision++;
  remote.blocks!.splice(5, 0, paragraph("remote-new", "REMOTE NEW LINE"));
  server.pages["page-1"] = remote;
  server.send("page-1", { type: "page.updated", page: remote, actorId: "other-user", structural: true });
  await expect(preview).toContainText("REMOTE NEW LINE");
  expect((await cursor(page)).id).toBe("line-60");
  expect(Math.abs((await cursor(page)).top! - before.top!)).toBeLessThan(3);
  await page.keyboard.insertText(" AFTER REMOTE");
  await expect(local).toContainText("LOCAL PREVIEW AFTER REMOTE");
  expect(server.failures).toEqual([]);
});
