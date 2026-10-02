import { PAGES_CHANGED_EVENT, PAGES_STORAGE_KEY, readStoredPages, type StoredPages } from "./page-store";

// Child links need only titles. Share one snapshot and one storage subscription
// instead of parsing every page body once for every visible link.
let titles: Map<string, string> | undefined;
const listeners = new Set<() => void>();

function refresh(pages: StoredPages | null = readStoredPages()) {
  const next = new Map(Object.values(pages ?? {}).map((page) => [page.id, page.title]));
  if (titles && titles.size === next.size && [...next].every(([id, title]) => titles?.get(id) === title)) return;
  titles = next;
  listeners.forEach((listener) => listener());
}

function onPagesChanged(event: Event) {
  refresh((event as CustomEvent<{ pages?: StoredPages }>).detail?.pages);
}

function onStorage(event: StorageEvent) {
  if (event.storageArea !== window.localStorage || (event.key !== null && event.key !== PAGES_STORAGE_KEY)) return;
  refresh();
}

export function subscribePageTitles(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener(PAGES_CHANGED_EVENT, onPagesChanged);
    window.addEventListener("storage", onStorage);
    // Recheck the render-to-subscription gap, once for the whole link group.
    refresh();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener(PAGES_CHANGED_EVENT, onPagesChanged);
      window.removeEventListener("storage", onStorage);
      // A later mount must not retain titles from a logged-out workspace.
      titles = undefined;
    }
  };
}

export function getPageTitle(pageId: string, fallbackTitle: string) {
  if (!titles) refresh();
  return titles?.get(pageId) || fallbackTitle || "제목 없음";
}
