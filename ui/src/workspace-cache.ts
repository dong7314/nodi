import { flushPendingDatabaseSnapshots } from "./database-cache";

// Active keys stay compatible with the existing stores. Account transitions
// preserve the old workspace until the backup succeeds, and roll back a failed
// restore instead of exposing a partially restored account as a guest.
const ownerKey = "nodi:workspace-owner";
const cacheKey = (id: string) => `nodi:workspace-cache:${id}`;
const keys = new Set([
  "nodi:pages", "nodi:page-folders", "nodi:page-shares", "nodi:block-comments",
  "nodi:starter-presets", "nodi:home-title-v2", "nodi:user:name", "nodi:user:profile", "nodi:auth:user",
]);
const isWorkspaceKey = (key: string) => keys.has(key)
  || ["nodi:quick-note:", "nodi:database:", "nodi:database-draft:", "nodi:page-draft:"].some((prefix) => key.startsWith(prefix));
const failure = () => new Error("작성 중인 내용을 안전하게 보관할 저장 공간이 부족해요. 기존 내용은 유지했습니다. 공간을 확보한 뒤 다시 시도해 주세요.");
type Cache = Record<string, string>;

function workspaceOwner() {
  const storage = window.localStorage;
  const owner = storage.getItem(ownerKey);
  if (owner) return owner;
  try {
    return JSON.parse(storage.getItem("nodi:auth:session") ?? "null")?.userId
      ?? JSON.parse(storage.getItem("nodi:pages") ?? "null")?.["quick-note"]?.ownerId ?? "guest";
  } catch { return "guest"; }
}

function activeCache(): Cache {
  return Object.fromEntries(Object.keys(localStorage).filter(isWorkspaceKey).map((key) => [key, localStorage.getItem(key)!]));
}

// Run this before logging out on the server. Failure must leave both the
// authenticated session and the latest local edits intact.
export function backupWorkspaceCache() {
  const owner = workspaceOwner();
  if (owner === "guest") return;
  try {
    flushPendingDatabaseSnapshots();
    localStorage.setItem(cacheKey(owner), JSON.stringify(activeCache()));
  }
  catch { throw failure(); }
}

type TransitionCommit = {
  // Authentication metadata belongs to the same rollback boundary as the
  // active workspace. Its session key is written last by the caller.
  keys: readonly string[];
  write: () => void;
};

export function activateWorkspaceCache(userId: string | null, commit?: TransitionCommit) {
  const storage = window.localStorage;
  const previous = workspaceOwner();
  const next = userId ?? "guest";
  try { flushPendingDatabaseSnapshots(); }
  catch { throw failure(); }
  const active = activeCache();
  const trackedKeys = new Set([
    ...Object.keys(active), ownerKey, ...(commit?.keys ?? []),
    ...(previous === "guest" ? [] : [cacheKey(previous)]),
    ...(userId ? [cacheKey(userId), `nodi:guest-workspace-migrated:${userId}:v1`] : []),
  ]);
  const original = new Map([...trackedKeys].map((key) => [key, storage.getItem(key)]));
  let desired: Cache = userId && previous === "guest" ? { ...active } : {};
  let changedPages: unknown = {};
  let committingMetadata = false;
  try {
    if (previous !== next) {
      if (previous !== "guest") backupWorkspaceCache();
      const raw = userId ? storage.getItem(cacheKey(userId)) : null;
      if (raw) {
        const saved = JSON.parse(raw) as Cache;
        for (const [key, value] of Object.entries(saved)) {
          if (isWorkspaceKey(key) && typeof value === "string") desired[key] = value;
        }
        const guestPages = previous === "guest" ? JSON.parse(active["nodi:pages"] ?? "{}") : {};
        const guestFolders = previous === "guest" ? JSON.parse(active["nodi:page-folders"] ?? "{}") : {};
        const imports = Object.fromEntries(Object.entries(guestPages).filter(([id, page]) => id !== "quick-note" && !(page as { ownerId?: string }).ownerId));
        const guestHome = guestPages["quick-note"];
        if (guestHome && !guestHome.ownerId && guestHome.updatedAt !== guestHome.createdAt) {
          const id = `page-guest-${crypto.randomUUID()}`;
          imports[id] = { ...guestHome, id, title: "가져온 게스트 메모", parentId: null, folderId: null };
        }
        if (Object.keys(imports).length) {
          desired["nodi:pages"] = JSON.stringify({ ...JSON.parse(desired["nodi:pages"] ?? "{}"), ...imports });
          desired["nodi:page-folders"] = JSON.stringify({ ...JSON.parse(desired["nodi:page-folders"] ?? "{}"), ...guestFolders });
        }
        // Reclaim the archive's disk space before restoring its active keys.
        // The original snapshot also restores it if later auth writes fail.
        storage.removeItem(cacheKey(userId!));
      }
      changedPages = JSON.parse(desired["nodi:pages"] ?? "{}");
      Object.keys(active).forEach((key) => storage.removeItem(key));
      for (const [key, value] of Object.entries(desired)) storage.setItem(key, value);
    }
    storage.setItem(ownerKey, next);
    if (userId && previous === "guest" && previous !== next) storage.removeItem(`nodi:guest-workspace-migrated:${userId}:v1`);
    committingMetadata = true;
    commit?.write();
  } catch (error) {
    // Remove only changed values, reclaiming their capacity before restoration.
    // An unchanged metadata key may be the key whose write was rejected, so do
    // not rewrite it and risk turning a recoverable quota error into data loss.
    const changedKeys = new Set([...trackedKeys, ...Object.keys(activeCache())]);
    for (const key of changedKeys) {
      const before = original.get(key) ?? null;
      if (storage.getItem(key) !== before) storage.removeItem(key);
    }
    for (const [key, value] of original) {
      if (value !== null && storage.getItem(key) !== value) storage.setItem(key, value);
    }
    throw committingMetadata ? error : failure();
  }
  if (previous !== next) {
    window.dispatchEvent(new CustomEvent("nodi:pages-changed", { detail: { pages: changedPages } }));
  }
}
