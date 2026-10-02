import { useSyncExternalStore } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { OPEN_PAGE_EVENT } from "./page-store";
import { getPageTitle, subscribePageTitles } from "./child-page-titles";

type ChildPageBlockProps = {
  pageId: string;
  fallbackTitle: string;
};

export function ChildPageBlock({ pageId, fallbackTitle }: ChildPageBlockProps) {
  const title = useSyncExternalStore(subscribePageTitles, () => getPageTitle(pageId, fallbackTitle));

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
