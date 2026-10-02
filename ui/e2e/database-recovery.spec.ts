import { test, expect } from "@playwright/test";
import { withDatabase } from "./database-fixture";

const cellName = { name: "이름 값", exact: true } as const;

test("independent table edits merge without losing either user's data", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  database.state = { ...database.state, name: "REMOTE TABLE NAME" };
  database.revision++;
  await cell.fill("MY CELL");
  await expect.poll(() => database.state.records[0].values.name).toBe("MY CELL");
  expect(database.state.name).toBe("REMOTE TABLE NAME");
  await expect(page.getByRole("textbox", { name: "데이터베이스 이름" })).toHaveValue("REMOTE TABLE NAME");
  await page.reload();
  await expect(cell).toHaveValue("MY CELL");
});

test("same-cell conflicts can be resolved after reload while unrelated edits survive", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  database.state = { ...database.state, name: "REMOTE NAME", records: [{ id: "record-1", values: { name: "REMOTE CELL" } }] };
  database.revision++;
  await cell.fill("MY CELL");
  await expect(page.getByRole("button", { name: "변경 비교", exact: true })).toBeVisible();
  await page.reload();
  await expect(cell).toHaveValue("MY CELL");
  await page.getByRole("button", { name: "변경 비교", exact: true }).click();
  await page.getByRole("radio", { name: "내 변경 MY CELL", exact: true }).check();
  await page.getByRole("button", { name: "선택한 내용 저장" }).click();
  await expect.poll(() => database.state.records[0].values.name).toBe("MY CELL");
  expect(database.state.name).toBe("REMOTE NAME");
  await expect(page.getByRole("textbox", { name: "데이터베이스 이름" })).toHaveValue("REMOTE NAME");
  await expect(cell).toBeEnabled();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:database-draft:audit-db"))).toBeNull();
});

test("another revision during conflict resolution requires a fresh choice", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  database.state = { ...database.state, records: [{ id: "record-1", values: { name: "REMOTE FIRST" } }] };
  database.revision++;
  await cell.fill("MY CELL");
  await page.getByRole("button", { name: "변경 비교", exact: true }).click();
  await page.getByRole("radio", { name: "내 변경 MY CELL", exact: true }).check();
  database.state = { ...database.state, records: [{ id: "record-1", values: { name: "REMOTE LATEST" } }] };
  database.revision++;
  await page.getByRole("button", { name: "선택한 내용 저장" }).click();
  await page.getByRole("button", { name: "변경 비교", exact: true }).click();
  await page.getByRole("radio", { name: "서버 변경 REMOTE LATEST", exact: true }).check();
  await page.getByRole("button", { name: "선택한 내용 저장" }).click();
  await expect(cell).toHaveValue("REMOTE LATEST");
  expect(database.state.records[0].values.name).toBe("REMOTE LATEST");
});

test("a failed table save keeps its draft and retries on reconnection", async ({ page }) => {
  const { database } = await withDatabase(page);
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  let disconnected = true;
  await page.route("**/api/databases/audit-db", (route) => disconnected && route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.fallback());
  await cell.fill("OFFLINE DRAFT");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nodi:database-draft:audit-db"))).toContain("OFFLINE DRAFT");
  expect(database.state.records[0].values.name).toBe("ORIGINAL CELL");
  await page.clock.install();
  await page.clock.fastForward(10 * 60 * 1000);
  await page.reload();
  await expect(cell).toHaveValue("OFFLINE DRAFT");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  disconnected = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => database.state.records[0].values.name).toBe("OFFLINE DRAFT");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).not.toBeVisible();
});

test("a failed initial table load can be retried without leaving the page", async ({ page }) => {
  await withDatabase(page);
  let disconnected = true;
  await page.route("**/api/databases/audit-db", (route) => disconnected ? route.abort("internetdisconnected") : route.fallback());
  await page.goto("/?page=page-1");
  await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
  disconnected = false;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("textbox", cellName)).toHaveValue("ORIGINAL CELL");
  await expect(page.getByRole("textbox", cellName)).toBeEnabled();
});

test("the same table in the main page and preview stays in sync after saves", async ({ page }) => {
  await withDatabase(page);
  await page.goto("/?page=page-1");
  await expect(page.getByRole("textbox", cellName)).toHaveValue("ORIGINAL CELL");
  await page.locator('[data-sidebar-page-id="page-1"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "옆에서 열기", exact: true }).click();
  const cells = page.getByRole("textbox", cellName);
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(1)).toHaveValue("ORIGINAL CELL");
  await cells.nth(0).fill("MAIN TABLE EDIT");
  await expect(cells.nth(1)).toHaveValue("MAIN TABLE EDIT");
  await cells.nth(1).fill("PREVIEW TABLE EDIT");
  await expect(cells.nth(0)).toHaveValue("PREVIEW TABLE EDIT");
});

test("losing edit permission preserves the table draft until permission returns", async ({ page }) => {
  const { server, database } = await withDatabase(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await cell.fill("DRAFT BEFORE PERMISSION CHANGE");
  server.pages["page-1"].permission = "view";
  server.send("page-1", { type: "permission.updated", permission: "view" });
  await expect(cell).toBeDisabled();
  await page.clock.runFor(1000);
  expect(database.state.records[0].values.name).toBe("ORIGINAL CELL");
  server.pages["page-1"].permission = "edit";
  server.send("page-1", { type: "permission.updated", permission: "edit" });
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue("DRAFT BEFORE PERMISSION CHANGE");
  await expect.poll(() => database.state.records[0].values.name).toBe("DRAFT BEFORE PERMISSION CHANGE");
});

test("a remote table revision overtaking a slow save acknowledgement is retained", async ({ page }) => {
  const { server, database } = await withDatabase(page);
  server.pages["page-1"].permission = "edit";
  await page.goto("/?page=page-1");
  const cell = page.getByRole("textbox", cellName);
  await expect(cell).toHaveValue("ORIGINAL CELL");
  await expect.poll(() => server.sockets.has("page-1")).toBe(true);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const saving = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/databases/audit-db", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    database.state = route.request().postDataJSON().state;
    database.revision++;
    const saved = structuredClone(database);
    started();
    await gate;
    return route.fulfill({ json: { data: saved } });
  });
  await cell.fill("MY SAVED CELL");
  await saving;
  database.state = { ...database.state, name: "NEWER REMOTE NAME" };
  database.revision++;
  server.send("page-1", { type: "database.updated", actorId: "other-user", database: database as never });
  release();
  await expect(page.getByRole("textbox", { name: "데이터베이스 이름", exact: true })).toHaveValue("NEWER REMOTE NAME");
  await expect(cell).toHaveValue("MY SAVED CELL");
});
