ALTER TABLE attachments
  ADD COLUMN storage_backend varchar(16) NOT NULL DEFAULT 'local'
  CHECK (storage_backend IN ('local', 'minio'));

CREATE TABLE home_pages (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title varchar(500) NOT NULL DEFAULT '오늘의 기록',
  settings_json jsonb NOT NULL DEFAULT '{"publicAccess":false}'::jsonb,
  blocks_json jsonb NOT NULL DEFAULT '[{"type":"paragraph","content":""}]'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('share', 'comment', 'mention')),
  page_id varchar(160) REFERENCES pages(id) ON DELETE CASCADE,
  thread_id varchar(160) REFERENCES comment_threads(id) ON DELETE CASCADE,
  title varchar(500) NOT NULL,
  description varchar(1000) NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_feed_idx
  ON notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_recipient_unread_idx
  ON notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL;
