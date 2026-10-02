import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { ServerFolder, ServerPage, ServerPageRealtimeEvent } from "../src/server-api";

const user = {
  id: "00000000-0000-4000-8000-000000000001", name: "테스트", email: "test@example.invalid",
  role: "member", avatarColor: "purple",
};

export function makePage(id: string, title: string, text: string): ServerPage {
  return {
    id, title, ownerId: user.id, permission: "owner", revision: 1,
    parentId: null, folderId: null, order: 1, archived: false, favoritedAt: null,
    createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    settings: {
      icon: "📄", cover: "paper", fullWidth: false, smallText: false, lockPage: false,
      publicAccess: false, showProperties: false, status: "초안", tags: [], date: "",
    },
    blocks: [{ id: `${id}-block`, type: "paragraph", content: text }],
  };
}

// The real React/BlockNote application runs in a real browser. Only the remote API is
// replaced, so navigation, keyboard history, local storage and autosave all run.
export async function mockWorkspace(browserPage: Page) {
  const pages: Record<string, ServerPage> = {
    "quick-note": makePage("quick-note", "테스트의 홈", "HOME ORIGINAL"),
    "page-1": makePage("page-1", "페이지 1", "PAGE ONE ORIGINAL"),
    "page-2": makePage("page-2", "페이지 2", "PAGE TWO ORIGINAL"),
  };
  const writes: Array<{ id: string; patch: Partial<ServerPage> }> = [];
  const folders: Record<string, ServerFolder> = {};
  const sockets = new Map<string, WebSocketRoute>();
  const failures: string[] = [];
  browserPage.on("pageerror", (error) => failures.push(error.message));
  await browserPage.addInitScript(({ user, pages }) => {
    // Seed once: reload assertions must inspect the data saved by the app.
    if (localStorage.getItem("nodi-e2e-seeded")) return;
    localStorage.setItem("nodi-e2e-seeded", "true");
    localStorage.setItem("nodi:pages", JSON.stringify(pages));
    localStorage.setItem("nodi:auth:accounts", JSON.stringify([{ ...user, status: "approved" }]));
    localStorage.setItem("nodi:auth:session", JSON.stringify({ userId: user.id }));
    localStorage.setItem(`nodi:guest-workspace-migrated:${user.id}:v1`, "done");
  }, { user, pages });

  await browserPage.routeWebSocket("**/api/pages/*/realtime", (socket) => {
    const id = new URL(socket.url()).pathname.split("/")[3];
    sockets.set(id, socket);
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "page.blocks.patch") {
        pages[id] = { ...pages[id], blocks: message.blocks, revision: pages[id].revision + 1 };
        socket.send(JSON.stringify({ type: "page.updated", page: pages[id], actorId: user.id, mutationId: message.mutationId, changedBlockIds: message.changedBlockIds, deletedBlockIds: message.deletedBlockIds }));
      }
    });
    socket.send(JSON.stringify({ type: "page.snapshot", page: pages[id] }));
    socket.onClose(() => { if (sockets.get(id) === socket) sockets.delete(id); });
  });
  await browserPage.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const method = request.method();
    const reply = (data: unknown) => route.fulfill({ json: { data } });
    if (path === "/auth/me") return reply(user);
    if (["/auth/users", "/shares", "/comments", "/notifications"].includes(path)) return reply([]);
    if (path === "/folders" && method === "GET") return reply(Object.values(folders));
    if (path === "/folders" && method === "POST") {
      const input = request.postDataJSON();
      folders[input.id] = { ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return reply(folders[input.id]);
    }
    const folderId = path.match(/^\/folders\/([^/]+)$/)?.[1];
    if (folderId && folders[folderId]) {
      if (method === "DELETE") { delete folders[folderId]; return route.fulfill({ status: 204 }); }
      folders[folderId] = { ...folders[folderId], ...request.postDataJSON() };
      return reply(folders[folderId]);
    }
    if (path === "/preferences") return reply({ preferences: { theme: "light" }, revision: 1 });
    if (path === "/presets") return reply([{ id: "daily", name: "기본", icon: "📄", pageTitle: "메모", blocks: [], orderIndex: 0 }]);
    if (path === "/tags") return reply([{ id: "personal", name: "개인", color: "purple", orderIndex: 0 }]);
    if (path === "/pages" && method === "GET") return reply(Object.values(pages).filter((value) => value.id !== "quick-note"));
    if (path === "/pages" && method === "POST") {
      const input = request.postDataJSON();
      pages[input.id] = { ...makePage(input.id, input.title, ""), ...input };
      return reply(pages[input.id]);
    }
    const favoriteId = path.match(/^\/pages\/([^/]+)\/favorite$/)?.[1];
    if (favoriteId && pages[favoriteId]) {
      pages[favoriteId].favoritedAt = request.postDataJSON().favorite ? new Date().toISOString() : null;
      return reply({ favoritedAt: pages[favoriteId].favoritedAt });
    }
    const id = path === "/home" ? "quick-note" : path.match(/^\/pages\/([^/]+)$/)?.[1];
    if (id && pages[id]) {
      if (method === "GET") return reply(pages[id]);
      if (method === "DELETE") {
        if (new URL(request.url()).searchParams.get("hard") === "true") delete pages[id];
        else pages[id] = { ...pages[id], archived: true, revision: pages[id].revision + 1 };
        return route.fulfill({ status: 204 });
      }
      if (method === "PATCH" || method === "PUT") {
        const patch = request.postDataJSON() as Partial<ServerPage>;
        writes.push({ id, patch });
        if (patch.revision !== undefined && patch.revision !== pages[id].revision) {
          return route.fulfill({ status: 409, json: { error: { code: "REVISION_CONFLICT", message: "revision conflict" } } });
        }
        pages[id] = { ...pages[id], ...patch, revision: pages[id].revision + 1, updatedAt: new Date().toISOString() };
        return reply(pages[id]);
      }
    }
    failures.push(`Unexpected API request: ${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return {
    pages, folders, writes, failures, sockets,
    send(id: string, event: ServerPageRealtimeEvent) {
      const socket = sockets.get(id);
      if (!socket) throw new Error(`No socket for ${id}`);
      socket.send(JSON.stringify(event));
    },
  };
}

export const documentEditor = (page: Page) => page.locator(".bn-editor[contenteditable=true]").first();

export async function openPage(page: Page, id: string, text: string) {
  if (id === "quick-note") await page.getByRole("button", { name: "홈", exact: true }).click();
  else await page.locator(`[data-sidebar-page-id="${id}"]`).first().click();
  await expect(documentEditor(page)).toContainText(text);
  await expect(page).toHaveURL((url) => url.searchParams.get("page") === (id === "quick-note" ? null : id));
}

export async function editDocument(page: Page, text: string) {
  const editor = documentEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
  await expect(editor).toContainText(text);
}

export async function savedPages(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("nodi:pages") ?? "{}") as Record<string, ServerPage>);
}
