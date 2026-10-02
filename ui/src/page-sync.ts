import { jsonEqual } from "./json-equal";
import { pageWithLocalOrder, type StoredPage } from "./page-store";

const fields = ["title", "settings", "blocks", "parentId", "folderId", "order", "archived", "favoritedAt"] as const;
export type PageConflict = { base: StoredPage; remote: StoredPage };
const draftKey = (id: string) => `nodi:page-draft:${id}`;

// Preserve independent fields. An overlapping edit remains local until the user
// chooses; it is never silently submitted over a newer server value.
export function mergePageDraft(base: StoredPage, local: StoredPage, remote: StoredPage) {
  const conflicts: string[] = [];
  const merge = (b: unknown, l: unknown, r: unknown, path: string): unknown => {
    if (jsonEqual(l, b)) return r;
    if (jsonEqual(r, b) || jsonEqual(l, r)) return l;
    if (b && l && r && typeof b === "object" && typeof l === "object" && typeof r === "object"
      && !Array.isArray(b) && !Array.isArray(l) && !Array.isArray(r)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        result[key] = merge((b as Record<string, unknown>)[key], (l as Record<string, unknown>)[key], (r as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return result;
    }
    conflicts.push(path);
    return l;
  };
  const page = { ...remote };
  for (const field of fields) Object.assign(page, { [field]: merge(base[field], local[field], remote[field], field) });
  return { page, conflicts };
}

export function rememberPageDraft(page: StoredPage, base: StoredPage) {
  try {
    if (fields.every((field) => jsonEqual(page[field], base[field]))) localStorage.removeItem(draftKey(page.id));
    else localStorage.setItem(draftKey(page.id), JSON.stringify({ page: pageWithLocalOrder(page, true), base }));
  } catch { /* The ordinary page cache still retains the current draft. */ }
}

export function readPageDraft(id: string): { page: StoredPage; base: StoredPage } | null {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(id)) ?? "null");
    const valid = (page: StoredPage | undefined) => page?.id === id
      && typeof page.title === "string" && typeof page.updatedAt === "string"
      && Array.isArray(page.blocks) && page.settings && typeof page.settings === "object";
    return valid(draft?.page) && valid(draft?.base) ? draft : null;
  } catch { return null; }
}

// Recover before mounting the editor, including when quota prevents the whole
// workspace from being rewritten. A later successful cache write may be newer
// than a journal whose own write failed, so retain that newer cache as well.
export function restorePageDraft(cached: StoredPage): StoredPage {
  const draft = readPageDraft(cached.id);
  if (!draft || (draft.page.ownerId && cached.ownerId && draft.page.ownerId !== cached.ownerId)) return cached;
  // Legacy journals have no local sequence. Prefer their recoverable draft;
  // server/client timestamps cannot establish which local write happened last.
  if ((cached.localWriteOrder ?? 0) > (draft.page.localWriteOrder ?? 0)) return cached;
  return { ...draft.page, ownerId: cached.ownerId, permission: cached.permission, revision: cached.revision };
}
