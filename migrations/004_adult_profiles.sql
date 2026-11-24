-- Existing profiles remain children; only an authenticated parent can opt in.
ALTER TABLE child_profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'child'
  CHECK(kind IN ('child','adult'));
INSERT OR IGNORE INTO schema_version(version) VALUES(4);
