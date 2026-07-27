import type { PartialBlock } from "@blocknote/core";
import type { PageSettings } from "./PageSettings";

export const ROOT_PAGE_ID = "quick-note";
export const PAGES_STORAGE_KEY = "nodi:pages";
export const FOLDERS_STORAGE_KEY = "nodi:page-folders";
export const PAGES_CHANGED_EVENT = "nodi:pages-changed";
export const OPEN_PAGE_EVENT = "nodi:open-page";

export type StoredPage = {
  id: string;
  parentId: string | null;
  folderId: string | null;
  order: number;
  title: string;
  settings: PageSettings;
  blocks: PartialBlock[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoredPages = Record<string, StoredPage>;

export type StoredFolder = {
  id: string;
  title: string;
  order: number;
  collapsed: boolean;
  createdAt: string;
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
  window.localStorage.setItem(PAGES_STORAGE_KEY, JSON.stringify(pages));
  window.dispatchEvent(new CustomEvent(PAGES_CHANGED_EVENT));
}

export function readStoredFolders(): StoredFolders {
  try {
    const saved = window.localStorage.getItem(FOLDERS_STORAGE_KEY);
    if (!saved) return {};
    return JSON.parse(saved) as StoredFolders;
  } catch {
    return {};
  }
}

export function persistStoredFolders(folders: StoredFolders) {
  window.localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
}
