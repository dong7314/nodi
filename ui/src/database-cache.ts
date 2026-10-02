import type { DatabaseState } from "./InlineDatabase";

const stateKey = (id: string) => `nodi:database:${id}`;
// Keep readiness beside the state so account-cache transitions carry both.
const readyKey = (id: string) => `${stateKey(id)}:ready`;
export const DATABASE_NOT_READY_MESSAGE = "표 내용을 불러온 뒤 다시 복사해 주세요.";

export function isDatabaseState(value: unknown): value is DatabaseState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DatabaseState>;
  return Array.isArray(state.properties) && Array.isArray(state.records)
    && Array.isArray(state.trash) && Array.isArray(state.views);
}

function parse(value: string | null): unknown {
  try { return JSON.parse(value ?? "null"); } catch { return null; }
}

export function readDatabaseDraft(id: string): { state: DatabaseState; base?: DatabaseState; revision?: number } | null {
  const value = parse(localStorage.getItem(`nodi:database-draft:${id}`)) as { state?: unknown } | null;
  return isDatabaseState(value?.state) ? value as { state: DatabaseState; base?: DatabaseState; revision?: number } : null;
}

export function readDatabaseSnapshot(id: string): DatabaseState | null {
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
  localStorage.setItem(stateKey(id), JSON.stringify(state));
  localStorage.setItem(readyKey(id), "1");
}
