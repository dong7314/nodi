import type { DatabaseState } from "./InlineDatabase";

const stateKey = (id: string) => `nodi:database:${id}`;
// Keep readiness beside the state so account-cache transitions carry both.
const readyKey = (id: string) => `${stateKey(id)}:ready`;
export const DATABASE_NOT_READY_MESSAGE = "표 내용을 불러온 뒤 다시 복사해 주세요.";

type LiveSnapshot = { id: string; element: HTMLElement; read: () => DatabaseState | null; current: () => boolean };
const liveSnapshots = new Set<LiveSnapshot>();
const pendingSnapshots = new Map<string, { state: DatabaseState; current: () => boolean }>();
type DatabaseDraft = { state: DatabaseState; base?: DatabaseState; revision?: number };
const pendingDrafts = new Map<string, { draft: DatabaseDraft | null; current: () => boolean }>();

// A late response from an old account must not publish into its replacement's
// cache. Normalize the owner before the first authenticated bootstrap as well.
export function captureDatabaseWorkspace() {
  const owner = () => {
    try {
      const userId = (parse(localStorage.getItem("nodi:auth:session")) as { userId?: string } | null)?.userId ?? null;
      return JSON.stringify([localStorage.getItem("nodi:workspace-owner") ?? userId ?? "guest", userId]);
    } catch { return null; }
  };
  const captured = owner();
  return () => captured !== null && owner() === captured;
}

export function registerLiveDatabaseSnapshot(id: string, element: HTMLElement, read: () => DatabaseState | null) {
  const snapshot = { id, element, read, current: captureDatabaseWorkspace() };
  liveSnapshots.add(snapshot);
  return () => { liveSnapshots.delete(snapshot); };
}

export function isDatabaseState(value: unknown): value is DatabaseState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DatabaseState>;
  return Array.isArray(state.properties) && Array.isArray(state.records)
    && Array.isArray(state.trash) && Array.isArray(state.views);
}

function parse(value: string | null): unknown {
  try { return JSON.parse(value ?? "null"); } catch { return null; }
}

export function readDatabaseDraft(id: string): DatabaseDraft | null {
  const pending = pendingDrafts.get(id);
  if (pending?.current()) return pending.draft;
  const value = parse(localStorage.getItem(`nodi:database-draft:${id}`)) as { state?: unknown } | null;
  return isDatabaseState(value?.state) ? value as DatabaseDraft : null;
}

export function cacheDatabaseDraft(id: string, draft: DatabaseDraft | null) {
  pendingDrafts.set(id, { draft, current: captureDatabaseWorkspace() });
  if (draft) localStorage.setItem(`nodi:database-draft:${id}`, JSON.stringify(draft));
  else localStorage.removeItem(`nodi:database-draft:${id}`);
  pendingDrafts.delete(id);
}

export function readPendingDatabaseSnapshot(id: string) {
  const pending = pendingSnapshots.get(id);
  return pending?.current() ? pending.state : null;
}

export function readDatabaseSnapshot(id: string, sourceRoot?: Element): DatabaseState | null {
  if (sourceRoot) {
    for (const snapshot of liveSnapshots) {
      if (snapshot.id === id && sourceRoot.contains(snapshot.element)) {
        // A mounted table owns the selected content. Never fall back to an old
        // disk snapshot if this instance is not ready or its account changed.
        return snapshot.current() ? snapshot.read() : null;
      }
    }
  }
  const pending = readPendingDatabaseSnapshot(id);
  if (pending) return pending;
  const cached = parse(localStorage.getItem(stateKey(id)));
  if (isDatabaseState(cached)) {
    // Older versions persisted this exact placeholder before the first GET.
    // Retain useful legacy/offline caches, but only trust an empty placeholder
    // once it was confirmed by a server response or a local table creation.
    const placeholder = cached.properties.length === 0 && cached.records.length === 0
      && cached.trash.length === 0 && cached.views.length === 0
      && cached.activeViewId === null && cached.name === "새 데이터베이스";
    if (!placeholder || localStorage.getItem(readyKey(id)) === "1") return cached;
  }
  return readDatabaseDraft(id)?.state ?? null;
}

export function cacheDatabaseSnapshot(id: string, state: DatabaseState) {
  // A quota failure must not make an account transition import/archive an old
  // table. Retain the newest attempted write until it can be persisted.
  pendingSnapshots.set(id, { state, current: captureDatabaseWorkspace() });
  localStorage.setItem(stateKey(id), JSON.stringify(state));
  localStorage.setItem(readyKey(id), "1");
  pendingSnapshots.delete(id);
}

export function flushPendingDatabaseSnapshots() {
  for (const [id, snapshot] of pendingSnapshots) {
    if (!snapshot.current()) { pendingSnapshots.delete(id); continue; }
    cacheDatabaseSnapshot(id, snapshot.state);
  }
  for (const [id, snapshot] of pendingDrafts) {
    if (!snapshot.current()) { pendingDrafts.delete(id); continue; }
    cacheDatabaseDraft(id, snapshot.draft);
  }
}
