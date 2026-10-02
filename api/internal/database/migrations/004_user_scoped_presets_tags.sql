-- Keep client-visible IDs (including built-in IDs) stable while allowing each
-- account to own its own copy. Neither table has incoming foreign keys.
ALTER TABLE starter_presets
  DROP CONSTRAINT starter_presets_pkey,
  ADD PRIMARY KEY (owner_id, id);

ALTER TABLE tags
  DROP CONSTRAINT tags_pkey,
  ADD PRIMARY KEY (owner_id, id);
