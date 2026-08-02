CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL,
  email varchar(254) NOT NULL,
  avatar_color varchar(16) NOT NULL DEFAULT 'purple',
  avatar_icon varchar(32),
  role varchar(16) NOT NULL CHECK (role IN ('admin', 'member')),
  status varchar(16) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  password_hash text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email));
CREATE INDEX users_status_idx ON users (status, requested_at DESC);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE folders (
  id varchar(160) PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id varchar(160) REFERENCES folders(id) ON DELETE SET NULL,
  title varchar(200) NOT NULL,
  order_index bigint NOT NULL DEFAULT 0,
  collapsed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folders_owner_tree_idx ON folders (owner_id, parent_id, order_index);

CREATE TABLE pages (
  id varchar(160) PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id varchar(160) REFERENCES pages(id) ON DELETE SET NULL,
  folder_id varchar(160) REFERENCES folders(id) ON DELETE SET NULL,
  order_index bigint NOT NULL DEFAULT 0,
  title varchar(500) NOT NULL DEFAULT '제목 없음',
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_document tsvector,
  archived boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pages_owner_sidebar_idx ON pages (owner_id, archived, order_index, updated_at DESC);
CREATE INDEX pages_parent_idx ON pages (parent_id, order_index);
CREATE INDEX pages_folder_idx ON pages (folder_id, order_index);
CREATE INDEX pages_search_idx ON pages USING gin (search_document);

CREATE FUNCTION nodi_pages_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_document := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.blocks_json::text, ''));
  RETURN NEW;
END;
$$;
CREATE TRIGGER pages_search_update BEFORE INSERT OR UPDATE OF title, blocks_json ON pages
FOR EACH ROW EXECUTE FUNCTION nodi_pages_search_update();

CREATE TABLE page_shares (
  page_id varchar(160) NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission varchar(8) NOT NULL CHECK (permission IN ('view', 'edit')),
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_shares_user_idx ON page_shares (user_id, shared_at DESC);

CREATE TABLE page_favorites (
  page_id varchar(160) NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  favorited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_favorites_user_idx ON page_favorites (user_id, favorited_at DESC);

CREATE TABLE comment_threads (
  id varchar(160) PRIMARY KEY,
  page_id varchar(160) NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id varchar(300) NOT NULL,
  block_preview varchar(500) NOT NULL DEFAULT '',
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_threads_page_idx ON comment_threads (page_id, updated_at DESC);
CREATE INDEX comment_threads_block_idx ON comment_threads (page_id, block_id);

CREATE TABLE comment_messages (
  id varchar(160) PRIMARY KEY,
  thread_id varchar(160) NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  parent_id varchar(160) REFERENCES comment_messages(id) ON DELETE SET NULL,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_messages_thread_idx ON comment_messages (thread_id, created_at);

CREATE TABLE inline_databases (
  id varchar(160) PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id varchar(160) REFERENCES pages(id) ON DELETE CASCADE,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inline_databases_page_idx ON inline_databases (page_id);

CREATE TABLE starter_presets (
  id varchar(160) PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(24) NOT NULL,
  icon varchar(32) NOT NULL,
  page_title varchar(80) NOT NULL,
  blocks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_file_name varchar(120),
  order_index smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX starter_presets_owner_idx ON starter_presets (owner_id, order_index);

CREATE TABLE tags (
  id varchar(160) PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  color varchar(16) NOT NULL CHECK (color IN ('purple','blue','green','orange','pink','gray')),
  order_index bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tags_owner_idx ON tags (owner_id, order_index);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id varchar(160) REFERENCES pages(id) ON DELETE SET NULL,
  file_name varchar(255) NOT NULL,
  content_type varchar(200) NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('image', 'file')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  object_key text NOT NULL UNIQUE,
  upload_token_hash bytea NOT NULL,
  asset_token_hash bytea NOT NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_owner_idx ON attachments (owner_id, created_at DESC);
