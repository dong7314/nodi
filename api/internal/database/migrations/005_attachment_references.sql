-- A copied block keeps its stable URL, but each containing resource has its own
-- current ACL. Token possession alone never creates one of these references.
CREATE TABLE attachment_references (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  page_id varchar(160) REFERENCES pages(id) ON DELETE CASCADE,
  home_owner_id uuid REFERENCES home_pages(user_id) ON DELETE CASCADE,
  database_id varchar(160) REFERENCES inline_databases(id) ON DELETE CASCADE,
  preset_owner_id uuid,
  preset_id varchar(160),
  FOREIGN KEY (preset_owner_id,preset_id) REFERENCES starter_presets(owner_id,id) ON DELETE CASCADE,
  CHECK (num_nonnulls(page_id,home_owner_id,database_id,preset_id)=1),
  CHECK ((preset_owner_id IS NULL)=(preset_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (attachment_id,page_id,home_owner_id,database_id,preset_owner_id,preset_id)
);
CREATE INDEX attachment_references_page_idx ON attachment_references(page_id);
CREATE INDEX attachment_references_database_idx ON attachment_references(database_id);

CREATE FUNCTION attachment_readable(attachment uuid, viewer uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM attachments a WHERE a.id=attachment AND (
      (a.page_id IS NULL AND a.owner_id=viewer)
      OR EXISTS (
        SELECT 1 FROM pages p LEFT JOIN page_shares ps ON ps.page_id=p.id AND ps.user_id=viewer
        WHERE (p.id=a.page_id OR p.id IN (
          SELECT coalesce(ref.page_id,db.page_id) FROM attachment_references ref
          LEFT JOIN inline_databases db ON db.id=ref.database_id WHERE ref.attachment_id=a.id
        )) AND (p.owner_id=viewer OR (NOT p.archived AND (
          ps.user_id=viewer OR p.settings_json @> '{"publicAccess":true}'::jsonb
        )))
      ) OR EXISTS (
        SELECT 1 FROM attachment_references ref LEFT JOIN inline_databases db ON db.id=ref.database_id
        WHERE ref.attachment_id=a.id AND (ref.home_owner_id=viewer OR ref.preset_owner_id=viewer
          OR (db.page_id IS NULL AND db.owner_id=viewer))
      )
    )
  )
$$;

-- Backfill previously saved copies only if their owner can still read the
-- source and the document contains the real asset token. Unknown/expired
-- grants are not inferred from a URL or from the copier's claimed page ID.
WITH resources AS (
  SELECT owner_id,blocks_json AS document,id AS page_id,NULL::uuid AS home_owner_id,
    NULL::varchar AS database_id,NULL::uuid AS preset_owner_id,NULL::varchar AS preset_id FROM pages
  UNION ALL SELECT user_id,blocks_json,NULL,user_id,NULL,NULL,NULL FROM home_pages
  UNION ALL SELECT owner_id,state_json,NULL,NULL,id,NULL,NULL FROM inline_databases
  UNION ALL SELECT owner_id,blocks_json,NULL,NULL,NULL,owner_id,id FROM starter_presets
), urls AS (
  SELECT resources.*,regexp_match(value #>> '{props,url}', '/attachments/([0-9a-fA-F-]{36})/content[?].*assetToken=([0-9a-f]{64})(?:&|$)') AS parts
  FROM resources CROSS JOIN LATERAL jsonb_path_query(document,'strict $.** ? (@.type() == "object")') value
  WHERE value->>'type' IN ('image','file','video','audio')
)
INSERT INTO attachment_references(attachment_id,page_id,home_owner_id,database_id,preset_owner_id,preset_id)
SELECT a.id,u.page_id,u.home_owner_id,u.database_id,u.preset_owner_id,u.preset_id
FROM urls u JOIN attachments a ON a.id::text=lower(u.parts[1])
WHERE digest(u.parts[2],'sha256')=a.asset_token_hash AND attachment_readable(a.id,u.owner_id)
ON CONFLICT DO NOTHING;

-- Delete metadata in the page transaction; object deletion is retried after
-- commit/startup, so a failed page transaction can never destroy its files.
CREATE TABLE attachment_object_deletions (
  attachment_id uuid PRIMARY KEY,
  object_key text NOT NULL,
  storage_backend text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
