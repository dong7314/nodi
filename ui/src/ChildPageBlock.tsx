import { useEffect, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { OPEN_PAGE_EVENT, PAGES_CHANGED_EVENT, readStoredPages } from "./page-store";

type ChildPageBlockProps = {
  pageId: string;
  fallbackTitle: string;
};

function getPageTitle(pageId: string, fallbackTitle: string) {
  return readStoredPages()?.[pageId]?.title || fallbackTitle || "제목 없음";
}

export function ChildPageBlock({ pageId, fallbackTitle }: ChildPageBlockProps) {
  const [title, setTitle] = useState(() => getPageTitle(pageId, fallbackTitle));

  useEffect(() => {
    const refresh = () => setTitle(getPageTitle(pageId, fallbackTitle));
    window.addEventListener(PAGES_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PAGES_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [fallbackTitle, pageId]);

  return (
    <button
      className="child-page-block"
      type="button"
      contentEditable={false}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PAGE_EVENT, { detail: { pageId } }))}
      aria-label={`${title} 페이지 열기`}
    >
      <span className="child-page-icon"><FileText size={17} /></span>
      <span className="child-page-title">{title}</span>
      <ChevronRight className="child-page-arrow" size={16} />
    </button>
  );
}
