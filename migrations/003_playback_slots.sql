-- Two stable, parent-releasable renderer assignments. No secrets or live audio
-- state is stored here; existing pairings and shared child preferences remain.
CREATE TABLE IF NOT EXISTS playback_slots (
  slot INTEGER PRIMARY KEY CHECK(slot IN (0,1)),
  device_id TEXT NOT NULL UNIQUE REFERENCES child_devices(id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO schema_version(version) VALUES(3);
