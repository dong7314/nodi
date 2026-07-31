import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CornerDownRight,
  MessageCircle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { BlockCommentMessage, BlockCommentThread } from "./comment-store";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { NodiUserAvatar } from "./NodiUserAvatar";
import type { NodiUser } from "./sharing-store";

type BlockCommentPanelProps = {
  pageTitle: string;
  blockPreview: string;
  thread?: BlockCommentThread;
  currentUser: NodiUser;
  registeredUsers: NodiUser[];
  canComment: boolean;
  disabledReason: string;
  onAddComment: (body: string, parentId: string | null) => void;
  onDeleteComment: (commentId: string) => void;
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
  registeredUsers,
  canComment,
  disabledReason,
  onAddComment,
  onDeleteComment,
  onReopen,
  onClose,
}: BlockCommentPanelProps) {
  const [draft, setDraft] = useState("");
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [pendingDeleteCommentId, setPendingDeleteCommentId] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const isClosingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const isResolved = Boolean(thread?.resolvedAt);
  const messageCount = thread?.messages.length ?? 0;
  const canSubmit = canComment && !isResolved && Boolean(draft.trim());
  const participants = useMemo(
    () => new Set(thread?.messages.map((message) => message.authorId) ?? []).size,
    [thread?.messages],
  );
  const rootMessages = useMemo(
    () => thread?.messages.filter((message) => !message.parentId) ?? [],
    [thread?.messages],
  );
  const repliesByParent = useMemo(() => {
    const grouped = new Map<string, BlockCommentMessage[]>();
    thread?.messages.forEach((message) => {
      if (!message.parentId) return;
      const replies = grouped.get(message.parentId) ?? [];
      replies.push(message);
      grouped.set(message.parentId, replies);
    });
    return grouped;
  }, [thread?.messages]);
  const pendingDeleteComment = pendingDeleteCommentId
    ? thread?.messages.find((message) => message.id === pendingDeleteCommentId)
    : undefined;
  const pendingDeleteReplyCount = pendingDeleteComment
    ? repliesByParent.get(pendingDeleteComment.id)?.length ?? 0
    : 0;
  const replyTarget = replyTargetId
    ? thread?.messages.find((message) => message.id === replyTargetId)
    : undefined;
  const usersById = useMemo(
    () => new Map([...registeredUsers, currentUser].map((user) => [user.id, user])),
    [currentUser, registeredUsers],
  );
  const usersByEmail = useMemo(
    () => new Map([...registeredUsers, currentUser].map((user) => [user.email.toLocaleLowerCase(), user])),
    [currentUser, registeredUsers],
  );
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const closeWithAnimation = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), 180);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingDeleteCommentId) closeWithAnimation();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeWithAnimation, pendingDeleteCommentId]);

  useEffect(() => {
    if (canComment && !isResolved) window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [canComment, isResolved]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [messageCount]);

  useEffect(() => {
    if (replyTargetId && !thread?.messages.some((message) => message.id === replyTargetId)) {
      setReplyTargetId(null);
    }
  }, [replyTargetId, thread?.messages]);

  const resolveMessageUser = (message: BlockCommentMessage): NodiUser => (
    usersById.get(message.authorId)
    ?? usersByEmail.get(message.authorEmail.toLocaleLowerCase())
    ?? {
      id: message.authorId,
      name: message.authorName,
      email: message.authorEmail,
      avatarColor: "gray",
    }
  );

  const beginReply = (message: BlockCommentMessage) => {
    const rootId = message.parentId ?? message.id;
    setReplyTargetId(rootId);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submitComment = () => {
    const body = draft.trim();
    if (!body || !canSubmit) return;
    onAddComment(body, replyTargetId);
    setDraft("");
    setReplyTargetId(null);
  };

  const renderMessage = (
    message: BlockCommentMessage,
    options: { isReply?: boolean; isThreadAuthor?: boolean } = {},
  ) => {
    const isOwnComment = message.authorId === currentUser.id;
    const author = resolveMessageUser(message);
    return (
      <article className={`block-comment-message ${options.isReply ? "is-reply" : ""}`} key={message.id}>
        <NodiUserAvatar
          user={author}
          className={`block-comment-avatar ${isOwnComment ? "is-profile-avatar" : ""}`}
        />
        <div>
          <header>
            <strong>{message.authorName}</strong>
            {options.isThreadAuthor && <em>댓글 작성자</em>}
            <time dateTime={message.createdAt}>{formatCommentTime(message.createdAt)}</time>
            {isOwnComment && (
              <button
                type="button"
                aria-label="댓글 삭제"
                onClick={() => setPendingDeleteCommentId(message.id)}
              >
                <Trash2 size={13} />
              </button>
            )}
          </header>
          <p>{message.body}</p>
          {!isResolved && canComment && (
            <button
              className="block-comment-reply-button"
              type="button"
              onClick={() => beginReply(message)}
            >
              <CornerDownRight size={13} /> 답글
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <aside className={`block-comment-panel ${isClosing ? "is-closing" : ""}`} role="dialog" aria-label="블록 댓글">
      <header className="block-comment-header">
        <span><MessageCircle size={17} /> 댓글</span>
        <div>
          <button type="button" aria-label="댓글 닫기" onClick={closeWithAnimation}><X size={17} /></button>
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
        {messageCount > 0 ? rootMessages.map((message, index) => (
          <div className="block-comment-thread" key={message.id}>
            {renderMessage(message, { isThreadAuthor: index === 0 })}
            {(repliesByParent.get(message.id)?.length ?? 0) > 0 && (
              <div className="block-comment-replies">
                {repliesByParent.get(message.id)?.map((reply) => renderMessage(reply, { isReply: true }))}
              </div>
            )}
          </div>
        )) : (
          <div className="block-comment-empty">
            <span><MessageCircle size={22} /></span>
            <strong>이 블록의 대화를 시작해 보세요.</strong>
            <p>선택한 내용에 대한 의견이나 질문을 남길 수 있어요.</p>
          </div>
        )}
      </div>

      <footer className="block-comment-composer">
        {isResolved ? (
          <button className="block-comment-reopen-action" type="button" onClick={onReopen}>
            <CornerDownRight size={15} /> 댓글 다시 열기
          </button>
        ) : (
          <>
            {replyTarget && (
              <div className="block-comment-reply-target">
                <CornerDownRight size={14} />
                <span><strong>{replyTarget.authorName}</strong>님에게 답글 작성 중</span>
                <button type="button" aria-label="답글 취소" onClick={() => setReplyTargetId(null)}>
                  <X size={13} />
                </button>
              </div>
            )}
            <label className={!canComment ? "is-disabled" : ""}>
              <NodiUserAvatar
                user={currentUser}
                className="block-comment-avatar is-current is-profile-avatar"
              />
              <textarea
                ref={textareaRef}
                value={draft}
                rows={2}
                maxLength={1000}
                disabled={!canComment}
                placeholder={replyTarget ? "답글을 입력하세요…" : "댓글을 입력하세요…"}
                aria-label={replyTarget ? "답글 입력" : "댓글 입력"}
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
              <span>
                {!canComment
                  ? disabledReason
                  : participants > 0
                    ? `${participants}명이 대화 중`
                    : "공유 멤버에게 표시됩니다"}
              </span>
              {canComment && <kbd>⌘/Ctrl ↵</kbd>}
            </div>
          </>
        )}
      </footer>
      {pendingDeleteComment && (
        <ConfirmDialog
          ariaLabel="댓글 삭제"
          title="댓글을 삭제할까요?"
          description={pendingDeleteReplyCount > 0
            ? `이 댓글과 연결된 답글 ${pendingDeleteReplyCount}개가 함께 삭제됩니다. 삭제한 댓글은 복구할 수 없습니다.`
            : "이 댓글이 대화에서 삭제됩니다. 삭제한 댓글은 복구할 수 없습니다."}
          confirmLabel="댓글 삭제"
          onCancel={() => setPendingDeleteCommentId(null)}
          onConfirm={() => {
            onDeleteComment(pendingDeleteComment.id);
            setPendingDeleteCommentId(null);
          }}
        />
      )}
    </aside>
  );
}
