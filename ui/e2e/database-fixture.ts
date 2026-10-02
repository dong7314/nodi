import { type Page } from "@playwright/test";
import { mockWorkspace } from "./workspace-fixture";
import type { DatabaseState } from "../src/InlineDatabase";

export async function withDatabase(page: Page) {
  const server = await mockWorkspace(page);
  server.pages["page-1"].blocks!.push({ id: "database-block", type: "database", props: { databaseId: "audit-db" } } as never);
  const initial: DatabaseState = {
    name: "검증 표", properties: [{ id: "name", name: "이름", type: "text", options: [] }],
    records: [{ id: "record-1", values: { name: "ORIGINAL CELL" } }], trash: [],
    views: [{ id: "table", name: "테이블", type: "table" }], activeViewId: "table",
  };
  const database = { id: "audit-db", pageId: "page-1", state: initial, revision: 1 };
  const databases: Record<string, typeof database> = { "audit-db": database };
  const writes: unknown[] = [];
  await page.route("**/api/databases/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    let current = databases[id];
    if (!current && route.request().method() === "GET") {
      return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    }
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      if (current && patch.revision !== undefined && patch.revision !== current.revision) {
        return route.fulfill({ status: 409, json: { error: { code: "REVISION_CONFLICT", message: "revision conflict" } } });
      }
      if (!current) current = databases[id] = { id, pageId: patch.pageId, state: patch.state, revision: 0 };
      current.state = patch.state;
      current.revision++;
    }
    return route.fulfill({ json: { data: current } });
  });
  return { server, database, databases, writes };
}
