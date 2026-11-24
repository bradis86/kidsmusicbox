import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  defaultSettings,
  type Settings,
  type ApprovedItem,
} from '../shared/types.js';
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function passwordHash(password: string) {
  const salt = secret();
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, key] = stored.split(':');
  const a = Buffer.from(key, 'hex'),
    b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    this.db.exec(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'));
    this.db.exec(
      readFileSync(resolve('migrations/002_child_profiles.sql'), 'utf8'),
    );
    this.db.exec(
      readFileSync(resolve('migrations/003_playback_slots.sql'), 'utf8'),
    );
    const columns = this.db.prepare('PRAGMA table_info(child_profiles)').all();
    if (!columns.some((column) => column.name === 'kind'))
      this.db.exec(
        readFileSync(resolve('migrations/004_adult_profiles.sql'), 'utf8'),
      );
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value FROM config WHERE key=?')
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  settings(): Settings {
    return {
      ...defaultSettings,
      ...this.get<Partial<Settings>>('settings', {}),
    };
  }
  collection(): ApprovedItem[] {
    return (
      this.db
        .prepare('SELECT data,position FROM approved ORDER BY position,id')
        .all() as { data: string; position: number }[]
    ).map((r) => ({ ...JSON.parse(r.data), position: r.position }));
  }
  approve(item: ApprovedItem) {
    this.db
      .prepare(
        'INSERT INTO approved(id,data,position) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(item.id, JSON.stringify(item), item.position);
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM approved WHERE id=?').run(id);
  }
  reorder(ids: string[]) {
    const existing = this.collection().map((i) => i.id);
    if (
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.includes(id))
    )
      throw new Error('Order must contain each approved item exactly once');
    this.db.exec('BEGIN');
    try {
      const q = this.db.prepare('UPDATE approved SET position=? WHERE id=?');
      ids.forEach((id, i) => q.run(i, id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  createSession(role: 'parent' | 'child') {
    const token = secret(),
      csrf = secret(),
      expires =
        Date.now() + (role === 'parent' ? 12 * 3600_000 : 365 * 86400_000);
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(hash(token), role, csrf, expires);
    return { token, csrf, expires };
  }
  session(token: string | undefined) {
    if (!token) return null;
    return this.db
      .prepare(
        'SELECT role,csrf,expires FROM sessions WHERE token_hash=? AND expires>?',
      )
      .get(hash(token), Date.now()) as
      { role: 'parent' | 'child'; csrf: string; expires: number } | undefined;
  }
  revoke(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  }
  log(message: string) {
    this.db
      .prepare('INSERT INTO diagnostics(time,message) VALUES(?,?)')
      .run(new Date().toISOString(), message);
    this.db.exec(
      'DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 100)',
    );
  }
  logs() {
    return this.db
      .prepare('SELECT time,message FROM diagnostics ORDER BY id DESC LIMIT 40')
      .all();
  }
  close() {
    this.db.close();
  }
}
