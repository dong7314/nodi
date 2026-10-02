import type { PartialBlock } from "@blocknote/core";
import type { PageSettings } from "./PageSettings";

export const ROOT_PAGE_ID = "quick-note";
export const PAGES_STORAGE_KEY = "nodi:pages";
export const FOLDERS_STORAGE_KEY = "nodi:page-folders";
export const PAGES_CHANGED_EVENT = "nodi:pages-changed";
export const OPEN_PAGE_EVENT = "nodi:open-page";
export const MAX_FOLDER_DEPTH = 3;

export type StoredPage = {
  id: string;
  parentId: string | null;
  folderId: string | null;
  order: number;
  title: string;
  settings: PageSettings;
  blocks: PartialBlock[];
  archived: boolean;
  favoritedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
  permission?: "owner" | "view" | "edit";
  revision?: number;
  // Local persistence order only; never part of the server's page payload.
  localWriteOrder?: number;
};

export type StoredPages = Record<string, StoredPage>;

export type StoredFolder = {
  id: string;
  parentId: string | null;
  title: string;
  order: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type StoredFolders = Record<string, StoredFolder>;

export function readStoredPages(): StoredPages | null {
  try {
    const saved = window.localStorage.getItem(PAGES_STORAGE_KEY);
    if (!saved) return null;
    return JSON.parse(saved) as StoredPages;
  } catch {
    return null;
  }
}

export function persistStoredPages(pages: StoredPages) {
  const snapshots = Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, pageWithLocalOrder(page)]));
  window.localStorage.setItem(PAGES_STORAGE_KEY, JSON.stringify(snapshots));
  window.dispatchEvent(new CustomEvent(PAGES_CHANGED_EVENT, { detail: { pages } }));
}

let localWriteClock = 0;
let localWriteClockReady = false;
const pageWriteOrders = new WeakMap<StoredPage, number>();

function observeWriteOrder(raw: string | null, journal: boolean) {
  try {
    const value = JSON.parse(raw ?? "null");
    const pages = journal ? [value?.page] : Object.values(value ?? {});
    for (const page of pages as Array<StoredPage | undefined>) {
      if (Number.isSafeInteger(page?.localWriteOrder) && page!.localWriteOrder! > localWriteClock) {
        localWriteClock = page!.localWriteOrder!;
      }
    }
  } catch { /* Malformed cache entries do not affect valid pages' ordering. */ }
}

// Assign an order only when the page changes, never merely because an aggregate
// write also includes it. Otherwise another tab editing an unrelated page could
// promote its stale cache above a newer journal. Both persistence paths reuse
// the changed object's order, including when either write fails.
export function pageWithLocalOrder(page: StoredPage, changed = false): StoredPage {
  const existingOrder = pageWriteOrders.get(page);
  if (!changed || existingOrder !== undefined) {
    return existingOrder === undefined ? page : { ...page, localWriteOrder: existingOrder };
  }
  if (!localWriteClockReady) {
    observeWriteOrder(localStorage.getItem(PAGES_STORAGE_KEY), false);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("nodi:page-draft:")) observeWriteOrder(localStorage.getItem(key), true);
    }
    window.addEventListener("storage", (event) => {
      if (event.storageArea !== localStorage) return;
      if (event.key === PAGES_STORAGE_KEY) observeWriteOrder(event.newValue, false);
      else if (event.key?.startsWith("nodi:page-draft:")) observeWriteOrder(event.newValue, true);
    });
    localWriteClockReady = true;
  }
  localWriteClock = Math.max(localWriteClock, Number.isSafeInteger(page.localWriteOrder) ? page.localWriteOrder! : 0);
  const order = ++localWriteClock;
  pageWriteOrders.set(page, order);
  return { ...page, localWriteOrder: order };
}

export function readStoredFolders(): StoredFolders {
  try {
    const saved = window.localStorage.getItem(FOLDERS_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as Record<string, Omit<StoredFolder, "parentId"> & { parentId?: unknown }>;
    const folders = Object.fromEntries(
      Object.entries(parsed).map(([folderId, folder]) => [
        folderId,
        {
          ...folder,
          id: folder.id || folderId,
          parentId: typeof folder.parentId === "string" ? folder.parentId : null,
        } satisfies StoredFolder,
      ]),
    );

    Object.values(folders).forEach((folder) => {
      const seen = new Set([folder.id]);
      let parentId = folder.parentId;
      while (parentId) {
        const parent = folders[parentId];
        if (!parent || seen.has(parentId)) {
          folder.parentId = null;
          break;
        }
        seen.add(parentId);
        parentId = parent.parentId;
      }
    });
    return folders;
  } catch {
    return {};
  }
}

export function persistStoredFolders(folders: StoredFolders) {
  window.localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
}
