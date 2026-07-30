import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  CornerDownRight,
  MessageCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { BlockCommentThread } from "./comment-store";
import type { NodiUser } from "./sharing-store";

type BlockCommentPanelProps = {
  pageTitle: string;
  blockPreview: string;
  thread?: BlockCommentThread;
  currentUser: NodiUser;
  canComment: boolean;
  onAddComment: (body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onClose: () => void;
};

const relativeTime = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

function formatCommentTime(value: string) {
  const timestamp = new Date(value).getTime();
  const difference = timestamp - Date.now();
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 60_000) return "방금 전";
  if (absoluteDifference < 3_600_000) return relativeTime.format(Math.round(difference / 60_000), "minute");
  if (absoluteDifference < 86_400_000) return relativeTime.format(Math.round(difference / 3_600_000), "hour");
  if (absoluteDifference < 604_800_000) return relativeTime.format(Math.round(difference / 86_400_000), "day");
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function BlockCommentPanel({
  pageTitle,
  blockPreview,
  thread,
  currentUser,
  canComment,
  onAddComment,
  onDeleteComment,
  onResolve,
  onReopen,
  onClose,
}: BlockCommentPanelProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const isResolved = Boolean(thread?.resolvedAt);
  const messageCount = thread?.messages.length ?? 0;
  const canSubmit = canComment && !isResolved && Boolean(draft.trim());
  const participants = useMemo(
    () => new Set(thread?.messages.map((message) => message.authorId) ?? []).size,
    [thread?.messages],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!isResolved) window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isResolved]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [messageCount]);

  const submitComment = () => {
    const body = draft.trim();
    if (!body || !canSubmit) return;
    onAddComment(body);
    setDraft("");
  };

  return (
    <aside className="block-comment-panel" role="dialog" aria-label="블록 댓글">
      <header className="block-comment-header">
        <span><MessageCircle size={17} /> 댓글</span>
        <div>
          {thread && messageCount > 0 && (
            <button
              className={isResolved ? "is-reopen" : ""}
              type="button"
              onClick={isResolved ? onReopen : onResolve}
              aria-label={isResolved ? "댓글 다시 열기" : "댓글 해결"}
            >
              {isResolved ? <CornerDownRight size={15} /> : <Check size={15} />}
              {isResolved ? "다시 열기" : "해결"}
            </button>
          )}
          <button type="button" aria-label="댓글 닫기" onClick={onClose}><X size={17} /></button>
        </div>
      </header>

      <div className="block-comment-context">
        <span className="block-comment-context-icon"><MessageCircle size={16} /></span>
        <span>
          <small>{pageTitle || "제목 없음"}</small>
          <strong>{blockPreview || "빈 블록"}</strong>
        </span>
        {messageCount > 0 && <em>{messageCount}</em>}
      </div>

      {isResolved && (
        <div className="block-comment-resolved">
          <CheckCircle2 size={16} />
          <span><strong>해결된 댓글</strong><small>필요하면 다시 열어 대화를 이어갈 수 있어요.</small></span>
        </div>
      )}

      <div ref={messageListRef} className="block-comment-messages">
        {messageCount > 0 ? thread?.messages.map((message, index) => {
          const isOwnComment = message.authorId === currentUser.id;
          return (
            <article className="block-comment-message" key={message.id}>
              <span className="block-comment-avatar" aria-hidden="true">
                {message.authorName.trim().charAt(0) || "N"}
              </span>
              <div>
                <header>
                  <strong>{message.authorName}</strong>
                  {index === 0 && <em>댓글 작성자</em>}
                  <time dateTime={message.createdAt}>{formatCommentTime(message.createdAt)}</time>
                  {isOwnComment && (
                    <button
                      type="button"
                      aria-label="댓글 삭제"
                      onClick={() => onDeleteComment(message.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </header>
                <p>{message.body}</p>
              </div>
            </article>
          );
        }) : (
          <div className="block-comment-empty">
            <span><MessageCircle size={22} /></span>
            <strong>이 블록의 대화를 시작해 보세요.</strong>
            <p>선택한 내용에 대한 의견이나 질문을 남길 수 있어요.</p>
          </div>
        )}
      </div>

      <footer className="block-comment-composer">
        {!canComment ? (
          <div className="block-comment-share-required">
            <MessageCircle size={16} />
            <span><strong>공유된 페이지에서 댓글을 사용할 수 있어요.</strong><small>오른쪽 위 공유 버튼에서 회원을 초대하거나 링크를 공개해 주세요.</small></span>
          </div>
        ) : isResolved ? (
          <button className="block-comment-reopen-action" type="button" onClick={onReopen}>
            <CornerDownRight size={15} /> 댓글 다시 열기
          </button>
        ) : (
          <>
            <label>
              <span className="block-comment-avatar is-current" aria-hidden="true">
                {currentUser.name.trim().charAt(0) || "N"}
              </span>
              <textarea
                ref={textareaRef}
                value={draft}
                rows={2}
                maxLength={1000}
                placeholder={messageCount > 0 ? "답글을 입력하세요…" : "댓글을 입력하세요…"}
                aria-label={messageCount > 0 ? "답글 입력" : "댓글 입력"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submitComment();
                  }
                }}
              />
              <button type="button" disabled={!canSubmit} aria-label="댓글 보내기" onClick={submitComment}>
                <Send size={15} />
              </button>
            </label>
            <div>
              <span>{participants > 0 ? `${participants}명이 대화 중` : "공유 멤버에게 표시됩니다"}</span>
              <kbd>⌘/Ctrl ↵</kbd>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
