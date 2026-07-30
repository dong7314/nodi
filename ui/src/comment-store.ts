export const BLOCK_COMMENTS_STORAGE_KEY = "nodi:block-comments";
export const BLOCK_COMMENTS_CHANGED_EVENT = "nodi:block-comments-changed";

export type BlockCommentMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  createdAt: string;
};

export type BlockCommentThread = {
  id: string;
  pageId: string;
  blockId: string;
  blockPreview: string;
  messages: BlockCommentMessage[];
  resolvedAt: string | null;
  resolvedBy: string | null;
  updatedAt: string;
};

export type StoredBlockComments = Record<string, BlockCommentThread>;

export function readStoredBlockComments(): StoredBlockComments {
  try {
    const saved = window.localStorage.getItem(BLOCK_COMMENTS_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as StoredBlockComments;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, thread]) => (
        thread
        && typeof thread.id === "string"
        && typeof thread.pageId === "string"
        && typeof thread.blockId === "string"
        && Array.isArray(thread.messages)
      )),
    );
  } catch {
    return {};
  }
}

export function persistStoredBlockComments(comments: StoredBlockComments) {
  window.localStorage.setItem(BLOCK_COMMENTS_STORAGE_KEY, JSON.stringify(comments));
  window.dispatchEvent(new CustomEvent(BLOCK_COMMENTS_CHANGED_EVENT));
}
