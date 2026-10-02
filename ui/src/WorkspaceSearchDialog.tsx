import { isComposingKey } from "./ime";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, FileText, Search, X } from "lucide-react";
import type { StoredFolder, StoredFolders, StoredPage, StoredPages } from "./page-store";

type WorkspaceSearchDialogProps = {
  pages: StoredPages;
  folders: StoredFolders;
  currentPageId: string;
  primaryShortcutLabel: string;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
};

type WorkspaceSearchRecord = {
  page: StoredPage;
  title: string;
  lines: string[];
  body: string;
  location: string;
  updatedAt: number;
};

type WorkspaceSearchResult = WorkspaceSearchRecord & {
  score: number;
  snippet: string;
};

const MAX_SEARCH_RESULTS = 80;

function normalizeSearchValue(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

function collectInlineText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectInlineText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;

  const props = record.props && typeof record.props === "object"
    ? record.props as Record<string, unknown>
    : null;
  const propText = props
    ? [props.title, props.caption, props.name].filter((item): item is string => typeof item === "string").join(" ")
    : "";

  return [
    collectInlineText(record.content),
    collectInlineText(record.children),
    propText,
  ].filter(Boolean).join(" ");
}

function getPageTextLines(page: StoredPage) {
  return page.blocks
    .map((block) => collectInlineText(block).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function getPageLocation(page: StoredPage, pages: StoredPages, folders: StoredFolders) {
  const folderCrumbs: string[] = [];
  const seenFolders = new Set<string>();
  let folderId = page.folderId;
  while (folderId && !seenFolders.has(folderId)) {
    const folder = folders[folderId];
    if (!folder) break;
    seenFolders.add(folderId);
    folderCrumbs.unshift(folder.title);
    folderId = folder.parentId;
  }

  const pageCrumbs: string[] = [];
  const seenPages = new Set<string>([page.id]);
  let parentId = page.parentId;
  while (parentId && !seenPages.has(parentId)) {
    const parent = pages[parentId];
    if (!parent) break;
    seenPages.add(parentId);
    pageCrumbs.unshift(parent.title || "제목 없음");
    parentId = parent.parentId;
  }

  const crumbs = [...folderCrumbs, ...pageCrumbs];
  return crumbs.length > 0 ? crumbs.join(" / ") : "개인 페이지";
}

function getSearchScore(record: WorkspaceSearchRecord, query: string) {
  if (!query) return 1;
  const title = normalizeSearchValue(record.title);
  const body = normalizeSearchValue(record.body);
  const location = normalizeSearchValue(record.location);
  let score = 0;

  if (title === query) score += 140;
  else if (title.startsWith(query)) score += 95;
  else if (title.includes(query)) score += 70;
  if (body.includes(query)) score += 34;
  if (location.includes(query)) score += 18;

  query.split(" ").filter(Boolean).forEach((token) => {
    if (title.includes(token)) score += 12;
    if (body.includes(token)) score += 5;
  });
  return score;
}

function createSearchSnippet(record: WorkspaceSearchRecord, query: string) {
  const fallback = record.lines[0] || "내용이 없는 페이지";
  if (!query) return fallback;
  const body = record.body || fallback;
  const matchIndex = normalizeSearchValue(body).indexOf(query);
  if (matchIndex < 0) return fallback;

  const start = Math.max(0, matchIndex - 38);
  const end = Math.min(body.length, matchIndex + query.length + 62);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

function getResultGroup(updatedAt: number) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(updatedAt);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const difference = Math.floor((today - targetDay) / 86_400_000);
  if (difference <= 0) return "오늘";
  if (difference === 1) return "어제";
  if (difference <= 7) return "지난 7일";
  if (difference <= 30) return "지난 30일";
  return "이전";
}

function formatResultTime(updatedAt: number) {
  const date = new Date(updatedAt);
  const now = new Date();
  if (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  ) {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function SearchHighlight({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const matchIndex = normalizeSearchValue(text).indexOf(query);
  if (matchIndex < 0) return text;
  return <>
    {text.slice(0, matchIndex)}
    <mark>{text.slice(matchIndex, matchIndex + query.length)}</mark>
    {text.slice(matchIndex + query.length)}
  </>;
}

export function WorkspaceSearchDialog({
  pages,
  folders,
  currentPageId,
  primaryShortcutLabel,
  onClose,
  onOpenPage,
}: WorkspaceSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const normalizedQuery = normalizeSearchValue(query);

  const records = useMemo<WorkspaceSearchRecord[]>(() => (
    Object.values(pages)
      .filter((page) => !page.archived && (page.permission ?? "owner") === "owner")
      .map((page) => {
        const lines = getPageTextLines(page);
        return {
          page,
          title: page.title.trim() || "제목 없음",
          lines,
          body: lines.join(" "),
          location: getPageLocation(page, pages, folders),
          updatedAt: new Date(page.updatedAt).getTime() || 0,
        };
      })
  ), [folders, pages]);

  const results = useMemo<WorkspaceSearchResult[]>(() => (
    records
      .map((record) => ({
        ...record,
        score: getSearchScore(record, normalizedQuery),
        snippet: createSearchSnippet(record, normalizedQuery),
      }))
      .filter((record) => !normalizedQuery || record.score > 0)
      .sort((first, second) => (
        second.score - first.score
        || second.updatedAt - first.updatedAt
        || first.title.localeCompare(second.title, "ko")
      ))
      .slice(0, MAX_SEARCH_RESULTS)
  ), [normalizedQuery, records]);

  const selectedResult = results.find((result) => result.page.id === selectedPageId) ?? results[0] ?? null;
  const selectedIndex = selectedResult
    ? results.findIndex((result) => result.page.id === selectedResult.page.id)
    : -1;

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (selectedPageId && results.some((result) => result.page.id === selectedPageId)) return;
    setSelectedPageId(results[0]?.page.id ?? null);
  }, [results, selectedPageId]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    resultsRef.current
      ?.querySelector<HTMLElement>(`[data-search-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const closeWithAnimation = (afterClose: () => void) => {
    if (isClosing) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      afterClose();
    }, 140);
  };

  const openResult = (result: WorkspaceSearchResult | null) => {
    if (!result || isClosing) return;
    closeWithAnimation(() => onOpenPage(result.page.id));
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeWithAnimation(onClose);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = selectedIndex < 0
        ? 0
        : (selectedIndex + direction + results.length) % results.length;
      setSelectedPageId(results[nextIndex].page.id);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      openResult(selectedResult);
    }
  };

  const groupedResults = normalizedQuery
    ? [{ label: `"${query.trim()}" 검색 결과`, items: results }]
    : results.reduce<Array<{ label: string; items: WorkspaceSearchResult[] }>>((groups, result) => {
        const label = getResultGroup(result.updatedAt);
        const currentGroup = groups.at(-1);
        if (currentGroup?.label === label) currentGroup.items.push(result);
        else groups.push({ label, items: [result] });
        return groups;
      }, []);

  let resultIndex = -1;
  const dialog = (
    <div
      className={`workspace-search-layer ${isClosing ? "is-closing" : ""}`}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeWithAnimation(onClose);
      }}
    >
      <div
        className="workspace-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="워크스페이스 검색"
        onKeyDown={handleDialogKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-search-header">
          <div className="workspace-search-input-wrap">
            <Search size={18} />
            <input
              ref={inputRef}
              className="workspace-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nodi 검색..."
              aria-label="검색어"
              aria-controls="workspace-search-results"
              aria-activedescendant={selectedResult ? `workspace-search-result-${selectedResult.page.id}` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button type="button" aria-label="검색어 지우기" onClick={() => setQuery("")}>
                <X size={15} />
              </button>
            )}
          </div>
          <div className="workspace-search-filters" aria-label="검색 범위">
            <span><FileText size={14} /> 제목 및 본문</span>
            <span>검색 범위: 전체 페이지</span>
            <em>{results.length}개 결과</em>
          </div>
        </header>

        <div className="workspace-search-body">
          <div
            id="workspace-search-results"
            ref={resultsRef}
            className="workspace-search-results"
            role="listbox"
            aria-label="검색 결과"
          >
            {groupedResults.length > 0 ? groupedResults.map((group) => (
              <section className="workspace-search-group" key={group.label}>
                <h3>{group.label}</h3>
                {group.items.map((result) => {
                  resultIndex += 1;
                  const index = resultIndex;
                  const selected = selectedResult?.page.id === result.page.id;
                  return (
                    <button
                      id={`workspace-search-result-${result.page.id}`}
                      data-search-index={index}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`workspace-search-result ${selected ? "is-selected" : ""}`}
                      key={result.page.id}
                      onMouseEnter={() => setSelectedPageId(result.page.id)}
                      onFocus={() => setSelectedPageId(result.page.id)}
                      onClick={() => openResult(result)}
                    >
                      <span className="workspace-search-result-icon">{result.page.settings.icon || "✦"}</span>
                      <span className="workspace-search-result-copy">
                        <strong>
                          <SearchHighlight text={result.title} query={normalizedQuery} />
                          {result.page.id === currentPageId && <small>현재 페이지</small>}
                        </strong>
                        <span><SearchHighlight text={result.snippet} query={normalizedQuery} /></span>
                        <small>{result.location}</small>
                      </span>
                      <time dateTime={result.page.updatedAt}>{formatResultTime(result.updatedAt)}</time>
                    </button>
                  );
                })}
              </section>
            )) : (
              <div className="workspace-search-empty">
                <span><Search size={22} /></span>
                <strong>검색 결과가 없습니다</strong>
                <p>다른 제목이나 본문 키워드로 검색해 보세요.</p>
              </div>
            )}
          </div>

          <aside className="workspace-search-preview" aria-label="선택한 페이지 미리보기">
            {selectedResult ? <>
              <header>
                <span>{selectedResult.page.settings.icon || "✦"}</span>
                <div>
                  <small>{selectedResult.location}</small>
                  <strong>{selectedResult.title}</strong>
                </div>
                <button type="button" aria-label="선택한 페이지 열기" onClick={() => openResult(selectedResult)}>
                  <ArrowUpRight size={16} />
                </button>
              </header>
              <div className="workspace-search-preview-content">
                {selectedResult.lines.length > 0
                  ? selectedResult.lines.slice(0, 12).map((line, index) => (
                      <p className={index === 0 ? "is-leading" : ""} key={`${selectedResult.page.id}-${index}`}>
                        <SearchHighlight text={line} query={normalizedQuery} />
                      </p>
                    ))
                  : <p className="workspace-search-preview-empty">아직 작성된 내용이 없습니다.</p>}
              </div>
              <footer>
                <span>마지막 수정 {formatResultTime(selectedResult.updatedAt)}</span>
                <span>{selectedResult.lines.length}개 텍스트 블록</span>
              </footer>
            </> : (
              <div className="workspace-search-preview-placeholder">
                <FileText size={22} />
                <span>결과를 선택하면 페이지 내용을 미리 볼 수 있어요.</span>
              </div>
            )}
          </aside>
        </div>

        <footer className="workspace-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 선택</span>
          <span><kbd>↵</kbd> 페이지 열기</span>
          <span><kbd>Esc</kbd> 닫기</span>
          <span className="workspace-search-command"><kbd>{primaryShortcutLabel}</kbd><kbd>K</kbd> 검색</span>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
