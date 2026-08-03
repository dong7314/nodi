import { useMemo, useState } from "react";
import {
  Clock3,
  FileText,
  Folder,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { StoredFolders, StoredPage, StoredPages } from "./page-store";

type TrashViewProps = {
  pages: StoredPages;
  folders: StoredFolders;
  busyPageId: string | null;
  onRestore: (pageId: string) => void;
  onDeletePermanently: (pageId: string) => void;
  onEmptyTrash: () => void;
};

function deletedAtLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "삭제 시각을 알 수 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function pageLocation(page: StoredPage, pages: StoredPages, folders: StoredFolders) {
  const segments: string[] = [];
  const visitedFolders = new Set<string>();
  let folderId = page.folderId;
  while (folderId && folders[folderId] && !visitedFolders.has(folderId)) {
    visitedFolders.add(folderId);
    segments.unshift(folders[folderId].title || "제목 없는 폴더");
    folderId = folders[folderId].parentId;
  }

  const parent = page.parentId ? pages[page.parentId] : undefined;
  if (parent) segments.push(parent.title || "제목 없는 페이지");
  return segments.length > 0 ? segments.join(" / ") : "페이지 최상위";
}

export function TrashView({
  pages,
  folders,
  busyPageId,
  onRestore,
  onDeletePermanently,
  onEmptyTrash,
}: TrashViewProps) {
  const [query, setQuery] = useState("");
  const archivedPages = useMemo(() => Object.values(pages)
    .filter((page) => page.archived && (page.permission ?? "owner") === "owner")
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)), [pages]);
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const visiblePages = archivedPages.filter((page) => {
    if (!normalizedQuery) return true;
    const location = pageLocation(page, pages, folders);
    return `${page.title} ${location}`.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
  });

  return (
    <section className="trash-view" aria-labelledby="trash-view-title">
      <header className="trash-hero">
        <div className="trash-hero-copy">
          <span>삭제한 페이지 관리</span>
          <h1 id="trash-view-title">휴지통</h1>
          <p>삭제한 페이지를 원래 위치로 복원하거나 영구적으로 삭제할 수 있어요.</p>
        </div>
        <div className="trash-summary" aria-label="휴지통 요약">
          <span><strong>{archivedPages.length}</strong><small>삭제된 페이지</small></span>
          <i aria-hidden="true" />
          <span><strong>{visiblePages.length}</strong><small>현재 표시</small></span>
        </div>
      </header>

      <div className="trash-toolbar">
        <label className="trash-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="휴지통에서 검색"
            aria-label="휴지통에서 검색"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="검색어 지우기">
              <X size={14} />
            </button>
          )}
        </label>
        <button
          className="trash-empty-button"
          type="button"
          disabled={archivedPages.length === 0 || busyPageId !== null}
          onClick={onEmptyTrash}
        >
          <Trash2 size={14} /> 휴지통 비우기
        </button>
      </div>

      {visiblePages.length > 0 ? (
        <div className="trash-list" role="list" aria-label="삭제된 페이지">
          {visiblePages.map((page) => {
            const busy = busyPageId === page.id || busyPageId === "all";
            return (
              <article className="trash-row" role="listitem" key={page.id}>
                <span className="trash-page-icon" aria-hidden="true">
                  {page.settings.icon || <FileText size={18} />}
                </span>
                <div className="trash-page-copy">
                  <strong>{page.title || "제목 없음"}</strong>
                  <span><Folder size={13} /> {pageLocation(page, pages, folders)}</span>
                </div>
                <time dateTime={page.updatedAt}><Clock3 size={13} /> {deletedAtLabel(page.updatedAt)}</time>
                <div className="trash-row-actions">
                  <button type="button" disabled={busy} onClick={() => onRestore(page.id)}>
                    <RotateCcw size={14} /> 복원
                  </button>
                  <button className="is-danger" type="button" disabled={busy} onClick={() => onDeletePermanently(page.id)}>
                    <Trash2 size={14} /> 영구 삭제
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="trash-empty-state">
          <span><Trash2 size={24} /></span>
          <strong>{archivedPages.length === 0 ? "휴지통이 비어 있어요." : "검색 결과가 없어요."}</strong>
          <p>{archivedPages.length === 0
            ? "삭제한 페이지가 생기면 이곳에서 복원하거나 영구 삭제할 수 있어요."
            : "페이지 제목이나 이전 위치로 다시 검색해 보세요."}</p>
          {query && <button type="button" onClick={() => setQuery("")}>검색 초기화</button>}
        </div>
      )}
    </section>
  );
}
