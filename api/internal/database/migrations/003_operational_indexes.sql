CREATE INDEX attachments_pending_cleanup_idx
  ON attachments (created_at)
  WHERE uploaded_at IS NULL;

CREATE INDEX comment_threads_access_idx
  ON comment_threads (page_id, resolved_at, updated_at DESC);
