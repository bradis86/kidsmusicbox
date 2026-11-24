CREATE TABLE IF NOT EXISTS child_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO child_profiles(id,name,avatar) VALUES('child-default','My music','⭐');
CREATE TABLE IF NOT EXISTS child_devices (
  id TEXT PRIMARY KEY, session_hash TEXT NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE,
  name TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES child_profiles(id), revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS track_preferences (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES child_profiles(id),
  reaction TEXT NOT NULL CHECK(reaction IN ('favourite','blocked','neutral')),
  track TEXT NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS preferences_profile ON track_preferences(profile_id,reaction);
CREATE TABLE IF NOT EXISTS preference_aliases (
  profile_id TEXT NOT NULL, uri TEXT NOT NULL COLLATE BINARY,
  preference_id TEXT NOT NULL REFERENCES track_preferences(id) ON DELETE CASCADE,
  PRIMARY KEY(profile_id,uri)
);
INSERT OR IGNORE INTO schema_version(version) VALUES(2);
