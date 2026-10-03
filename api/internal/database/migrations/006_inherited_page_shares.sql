-- Resolve grants from the current hierarchy instead of copying share rows.
-- A direct child grant survives removal of an ancestor grant. Grants are
-- additive: an inherited edit grant cannot be reduced by a direct view grant.
CREATE FUNCTION effective_page_shares(target_page_id text)
RETURNS TABLE(user_id uuid, permission text, shared_at timestamptz, source_page_id text, direct_permission text)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage AS (
    SELECT id, parent_id, owner_id, archived, 0 AS depth, ARRAY[id]::text[] AS path
    FROM pages WHERE id=target_page_id
    UNION ALL
    SELECT p.id,p.parent_id,p.owner_id,p.archived,l.depth+1,l.path||p.id
    FROM pages p JOIN lineage l ON p.id=l.parent_id
    WHERE p.owner_id=l.owner_id AND NOT p.archived AND NOT l.archived AND NOT p.id=ANY(l.path)
  )
  SELECT DISTINCT ON (s.user_id) s.user_id,s.permission,s.shared_at,s.page_id,
    (SELECT direct.permission FROM page_shares direct WHERE direct.page_id=target_page_id AND direct.user_id=s.user_id)
  FROM lineage l JOIN page_shares s ON s.page_id=l.id
  ORDER BY s.user_id,(s.permission='edit') DESC,l.depth,s.shared_at DESC
$$;

-- Downloads and attachment copies use this database function as well as the
-- HTTP page authorizer. Apply the same inherited ACL to every containing page.
CREATE OR REPLACE FUNCTION attachment_readable(attachment uuid, viewer uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM attachments a WHERE a.id=attachment AND (
      (a.page_id IS NULL AND a.owner_id=viewer)
      OR EXISTS (
        SELECT 1 FROM pages p LEFT JOIN LATERAL effective_page_shares(p.id) ps ON ps.user_id=viewer
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
