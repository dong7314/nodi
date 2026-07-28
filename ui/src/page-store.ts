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
  createdAt: string;
  updatedAt: string;
};

export type StoredPages = Record<string, StoredPage>;

export type StoredFolder = {
  id: string;
  parentId: string | null;
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
