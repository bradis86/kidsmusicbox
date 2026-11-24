import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { hash } from './db.js';
import { BackendError } from './adapters/backend.js';
import type {
  ChildProfile,
  Track,
  TrackPreference,
  TrackReaction,
} from '../shared/types.js';
type Device = {
  id: string;
  session_hash: string;
  name: string;
  profile_id: string;
  revision: number;
};
type Row = {
  id: string;
  reaction: TrackReaction;
  track: string;
  version: number;
  updated: number;
};
export const trackUris = (track: Pick<Track, 'id' | 'uri' | 'sourceUris'>) => [
  ...new Set(
    [track.id, track.uri, ...(track.sourceUris ?? [])].filter(Boolean),
  ),
];
export class Profiles {
  constructor(private store: Store) {}
  all() {
    return this.store.db
      .prepare(
        'SELECT id,name,avatar,kind FROM child_profiles WHERE archived=0 ORDER BY rowid',
      )
      .all() as unknown as ChildProfile[];
  }
  get(id: string) {
    return this.all().find((p) => p.id === id);
  }
  device(token: string) {
    const sessionHash = hash(token);
    let row = this.store.db
      .prepare('SELECT * FROM child_devices WHERE session_hash=?')
      .get(sessionHash) as Device | undefined;
    if (!row) {
      if (this.store.session(token)?.role !== 'child')
        throw new BackendError('Pair this player first', 401);
      const defaultChild = this.all().find((p) => p.kind !== 'adult');
      if (!defaultChild)
        throw new BackendError(
          'Ask a parent to create a child profile before pairing this player',
          409,
        );
      const id = randomUUID();
      const count = Number(
        (
          this.store.db
            .prepare('SELECT count(*) AS n FROM child_devices')
            .get() as { n: number }
        ).n,
      );
      this.store.db
        .prepare(
          'INSERT INTO child_devices(id,session_hash,name,profile_id) VALUES(?,?,?,?)',
        )
        .run(id, sessionHash, `Player ${count + 1}`, defaultChild.id);
      row = this.store.db
        .prepare('SELECT * FROM child_devices WHERE id=?')
        .get(id) as Device;
    }
    return row;
  }
  archived() {
    return this.store.db
      .prepare(
        'SELECT id,name,avatar,kind FROM child_profiles WHERE archived=1 ORDER BY rowid',
      )
      .all() as unknown as ChildProfile[];
  }
  restore(id: string) {
    const result = this.store.db
      .prepare('UPDATE child_profiles SET archived=0 WHERE id=? AND archived=1')
      .run(id);
    if (!result.changes)
      throw new BackendError('Archived profile not found', 404);
  }
  devices() {
    return this.store.db
      .prepare(
        'SELECT d.id,d.name,d.profile_id AS profileId,d.revision FROM child_devices d JOIN sessions s ON s.token_hash=d.session_hash WHERE s.expires>? ORDER BY d.rowid',
      )
      .all(Date.now()) as unknown as {
      id: string;
      name: string;
      profileId: string;
      revision: number;
    }[];
  }
  assign(id: string, profileId: string, name?: string) {
    if (!this.get(profileId))
      throw new BackendError('Child profile not found', 404);
    const row = this.store.db
      .prepare('SELECT * FROM child_devices WHERE id=?')
      .get(id) as Device | undefined;
    if (!row) throw new BackendError('Paired player not found', 404);
    this.store.db
      .prepare(
        'UPDATE child_devices SET profile_id=?,name=?,revision=revision+1 WHERE id=?',
      )
      .run(profileId, name ?? row.name, id);
    return row;
  }
  create(name: string, avatar: string, kind: 'child' | 'adult' = 'child') {
    const id = randomUUID();
    this.store.db
      .prepare(
        'INSERT INTO child_profiles(id,name,avatar,kind) VALUES(?,?,?,?)',
      )
      .run(id, name, avatar, kind);
    return this.get(id)!;
  }
  update(id: string, name: string, avatar: string, kind?: 'child' | 'adult') {
    const profile = this.get(id);
    if (!profile) throw new BackendError('Child profile not found', 404);
    if (
      profile.kind !== 'adult' &&
      kind === 'adult' &&
      this.all().filter((p) => p.kind !== 'adult').length < 2
    )
      throw new BackendError(
        'Keep at least one child profile for newly paired players',
        409,
      );
    this.store.db
      .prepare('UPDATE child_profiles SET name=?,avatar=?,kind=? WHERE id=?')
      .run(name, avatar, kind ?? profile.kind ?? 'child', id);
    if (kind && kind !== profile.kind)
      this.store.db
        .prepare(
          'UPDATE child_devices SET revision=revision+1 WHERE profile_id=?',
        )
        .run(id);
  }
  archive(id: string) {
    const other = this.all().find((p) => p.id !== id && p.kind !== 'adult');
    if (!other)
      throw new BackendError(
        'Keep at least one child profile for newly paired players',
        409,
      );
    if (!this.get(id)) throw new BackendError('Child profile not found', 404);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db
        .prepare(
          'UPDATE child_devices SET profile_id=?,revision=revision+1 WHERE profile_id=?',
        )
        .run(other.id, id);
      this.store.db
        .prepare('UPDATE child_profiles SET archived=1 WHERE id=?')
        .run(id);
      this.store.db.exec('COMMIT');
    } catch (e) {
      this.store.db.exec('ROLLBACK');
      throw e;
    }
  }
  preferenceVersion(profileId: string) {
    return hash(
      JSON.stringify(
        this.store.db
          .prepare(
            'SELECT id,reaction,version FROM track_preferences WHERE profile_id=? ORDER BY id',
          )
          .all(profileId),
      ),
    );
  }
  list(profileId: string) {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM track_preferences WHERE profile_id=? AND reaction!='neutral' ORDER BY updated DESC,id",
        )
        .all(profileId) as Row[]
    ).map(this.view);
  }
  private view(row: Row): TrackPreference {
    return {
      id: row.id,
      reaction: row.reaction,
      track: JSON.parse(row.track),
      version: row.version,
    };
  }
  find(profileId: string, track: Pick<Track, 'id' | 'uri' | 'sourceUris'>) {
    const ids = trackUris(track);
    if (!ids.length) return null;
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT p.* FROM track_preferences p JOIN preference_aliases a ON a.preference_id=p.id WHERE a.profile_id=? AND a.uri IN (${ids.map(() => '?').join(',')}) ORDER BY p.updated DESC`,
      )
      .all(profileId, ...ids) as Row[];
    // A newly resolved canonical identity may connect two previously separate
    // preferences. A block wins until an explicit user/parent choice changes it.
    const row = rows.find((r) => r.reaction === 'blocked') ?? rows[0];
    return row ? this.view(row) : null;
  }
  blocked(profileId: string, track: Pick<Track, 'id' | 'uri' | 'sourceUris'>) {
    return this.find(profileId, track)?.reaction === 'blocked';
  }
  blockedIds(profileId: string) {
    return this.list(profileId)
      .filter((r) => r.reaction === 'blocked')
      .flatMap((r) => trackUris(r.track));
  }
  set(
    profileId: string,
    track: Track,
    reaction: TrackReaction,
    expectedVersion?: number,
  ) {
    if (!this.get(profileId))
      throw new BackendError('Child profile not found', 404);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.find(profileId, track);
      if (
        expectedVersion !== undefined &&
        expectedVersion !== (existing?.version ?? 0)
      )
        throw new BackendError(
          'This preference changed on another player. Please try again.',
          409,
        );
      const id = existing?.id ?? randomUUID();
      const version = (existing?.version ?? 0) + 1;
      const incoming = trackUris(track);
      const related = this.store.db
        .prepare(
          `SELECT DISTINCT p.track FROM track_preferences p JOIN preference_aliases a ON a.preference_id=p.id WHERE a.profile_id=? AND a.uri IN (${incoming.map(() => '?').join(',')})`,
        )
        .all(profileId, ...incoming) as { track: string }[];
      const allUris = [
        ...new Set([
          ...incoming,
          ...related.flatMap((row) => trackUris(JSON.parse(row.track))),
        ]),
      ];
      const resolved = { ...track, sourceUris: allUris };
      this.store.db
        .prepare(
          'INSERT INTO track_preferences(id,profile_id,reaction,track,version,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reaction=excluded.reaction,track=excluded.track,version=excluded.version,updated=excluded.updated',
        )
        .run(
          id,
          profileId,
          reaction,
          JSON.stringify(resolved),
          version,
          Date.now(),
        );
      const alias = this.store.db.prepare(
        'INSERT INTO preference_aliases(profile_id,uri,preference_id) VALUES(?,?,?) ON CONFLICT(profile_id,uri) DO UPDATE SET preference_id=excluded.preference_id',
      );
      for (const uri of allUris) alias.run(profileId, uri, id);
      // Remove redundant preference rows only when every alias moved to the
      // chosen record; no title/artist heuristic is used to merge recordings.
      this.store.db
        .prepare(
          'DELETE FROM track_preferences WHERE profile_id=? AND id!=? AND NOT EXISTS(SELECT 1 FROM preference_aliases WHERE preference_id=track_preferences.id)',
        )
        .run(profileId, id);
      this.store.db.exec('COMMIT');
      return this.find(profileId, resolved)!;
    } catch (e) {
      this.store.db.exec('ROLLBACK');
      throw e;
    }
  }
  changeById(
    profileId: string,
    id: string,
    reaction: TrackReaction,
    version: number,
  ) {
    const row = this.store.db
      .prepare('SELECT * FROM track_preferences WHERE id=? AND profile_id=?')
      .get(id, profileId) as Row | undefined;
    if (!row) throw new BackendError('Preference not found', 404);
    return this.set(profileId, JSON.parse(row.track), reaction, version);
  }
}
