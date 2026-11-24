import { afterEach, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { Store, hash } from '../src/server/db';
import { Profiles } from '../src/server/profiles';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
import type { Track, HubState } from '../src/shared/types';
let store: Store,
  backend: MockBackend,
  hub: ReturnType<typeof createHub>,
  profiles: Profiles;
let parent: ReturnType<Store['createSession']>,
  first: typeof parent,
  second: typeof parent;
const defaultId = 'child-default';
beforeEach(() => {
  store = new Store(':memory:');
  backend = new MockBackend();
  profiles = new Profiles(store);
  parent = store.createSession('parent');
  first = store.createSession('child');
  second = store.createSession('child');
  for (const [position, item] of sampleLibrary.slice(0, 2).entries())
    store.approve({
      ...item,
      displayName: item.name,
      position,
      artworkOverride: null,
      hiddenTrackIds: [],
    });
  hub = createHub({
    store,
    backend,
    tickMs: 100000,
    voice: {
      ready: async () => ({ ready: true }),
      transcribe: async () => ({
        text: 'Sunspun',
        noSpeech: false,
        durationMs: 1000,
      }),
    } as never,
  });
});
afterEach(async () => {
  await hub.close();
  store.close();
});
async function state(session = first): Promise<HubState> {
  return (
    await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', `hub_child=${session.token}`)
  ).body;
}
async function child(
  path: string,
  body: object,
  session = first,
  method: 'post' | 'put' = 'post',
) {
  const personal = (await state(session)).personal!;
  return request(hub.app)
    [method](path)
    .set('Cookie', `hub_child=${session.token}`)
    .set('X-CSRF-Token', session.csrf)
    .set('X-Child-Profile', personal.profile.id)
    .set('X-Profile-Revision', String(personal.revision))
    .send(body);
}
function admin(
  path: string,
  body: object = {},
  method: 'post' | 'put' | 'delete' | 'patch' = 'post',
) {
  return request(hub.app)
    [method](path)
    .set('Cookie', `hub_parent=${parent.token}`)
    .set('X-CSRF-Token', parent.csrf)
    .send(body);
}
async function start() {
  expect(
    (
      await child('/api/child/playback', {
        action: 'start',
        collectionId: sampleLibrary[0].id,
      })
    ).status,
  ).toBe(200);
}
async function react(reaction: string, session = first) {
  const p = (await state(session)).personal!;
  return child(
    '/api/child/reaction',
    {
      reaction,
      trackVersion: p.trackVersion,
      version: p.preference?.version ?? 0,
    },
    session,
    'put',
  );
}
it('migrates existing child cookies without resetting authentication and persists profile assignments', async () => {
  const cookieHash = hash(first.token);
  const original = store.db
    .prepare('SELECT * FROM sessions WHERE token_hash=?')
    .get(cookieHash);
  const s = await state();
  expect(s.personal?.profile.id).toBe(defaultId);
  expect(profiles.devices()).toHaveLength(1);
  const created = await admin('/api/admin/profiles', {
    name: 'Sam',
    avatar: '🚀',
  });
  expect(created.status).toBe(200);
  expect(
    (
      await child(
        '/api/child/profile',
        { profileId: created.body.id, revision: s.personal!.revision },
        first,
        'put',
      )
    ).status,
  ).toBe(200);
  expect((await state()).personal?.profile.name).toBe('Sam');
  expect(
    store.db
      .prepare('SELECT * FROM sessions WHERE token_hash=?')
      .get(cookieHash),
  ).toEqual(original);
});
it('shows My favourites before the first heart and keeps it after the last is removed', async () => {
  expect((await state()).collection[0].id).toBe('__favourites__');
  const empty = await request(hub.app)
    .get('/api/child/collection/__favourites__')
    .set('Cookie', `hub_child=${first.token}`);
  expect(empty.status).toBe(200);
  expect(empty.body.tracks).toEqual([]);
  await start();
  await react('favourite');
  await react('neutral');
  expect((await state()).collection[0].id).toBe('__favourites__');
});
it('heart toggles are stored for the child and favourites produce an approved playable queue', async () => {
  await start();
  expect((await react('favourite')).status).toBe(200);
  expect((await state()).personal?.preference?.reaction).toBe('favourite');
  const favourites = await request(hub.app)
    .get('/api/child/collection/__favourites__')
    .set('Cookie', `hub_child=${first.token}`);
  expect(favourites.body.tracks).toHaveLength(1);
  expect(favourites.body.tracks[0].name).toBe('Sunspun');
  expect(
    (
      await child('/api/child/playback', {
        action: 'start',
        collectionId: '__favourites__',
      })
    ).status,
  ).toBe(200);
  expect((await state()).playback.track?.name).toBe('Sunspun');
  expect((await react('neutral')).status).toBe(200);
  expect(profiles.list(defaultId)).toEqual([]);
});
it('thumbs-down lets the current song continue but blocks new starts, next cycles, voice and favourites for only that child', async () => {
  await start();
  await react('favourite');
  const before = await state();
  expect((await react('blocked')).status).toBe(200);
  const after = await state();
  expect(after.playback.track?.name).toBe('Sunspun');
  expect(after.playback.status).toBe('playing');
  expect(after.personal?.preference?.reaction).toBe('blocked');
  const tracks = await request(hub.app)
    .get('/api/child/collection/' + sampleLibrary[0].id)
    .set('Cookie', `hub_child=${first.token}`);
  expect(tracks.body.tracks.map((t: Track) => t.name)).not.toContain('Sunspun');
  const voice = await child('/api/child/voice/matches', { text: 'Sunspun' });
  expect(voice.body.matches).toEqual([]);
  expect(
    (
      await child('/api/child/playback', {
        action: 'start',
        collectionId: sampleLibrary[0].id,
        trackId: before.playback.track!.id,
      })
    ).status,
  ).toBe(403);
  expect((await child('/api/child/playback', { action: 'next' })).status).toBe(
    200,
  );
  expect((await state()).playback.track?.name).toBe('Ribbon Steps');
  const other = profiles.create('Alex', '🦊');
  const binding = profiles.device(second.token);
  profiles.assign(binding.id, other.id);
  const otherTracks = await request(hub.app)
    .get('/api/child/collection/' + sampleLibrary[0].id)
    .set('Cookie', `hub_child=${second.token}`);
  expect(otherTracks.body.tracks.map((t: Track) => t.name)).toContain(
    'Sunspun',
  );
  expect((await state(second)).playback.track).toBe(null);
});
it('stale track/profile versions and another session cannot rate somebody else’s playback', async () => {
  await start();
  const before = (await state()).personal!;
  expect((await react('blocked', second)).status).toBe(409);
  await child('/api/child/playback', { action: 'next' });
  expect(
    (
      await child(
        '/api/child/reaction',
        { reaction: 'blocked', trackVersion: before.trackVersion, version: 0 },
        first,
        'put',
      )
    ).status,
  ).toBe(409);
  const p = profiles.create('Alex', '🦊');
  await child(
    '/api/child/profile',
    { profileId: p.id, revision: before.revision },
    first,
    'put',
  );
  const stale = await request(hub.app)
    .put('/api/child/reaction')
    .set('Cookie', `hub_child=${first.token}`)
    .set('X-CSRF-Token', first.csrf)
    .set('X-Child-Profile', defaultId)
    .set('X-Profile-Revision', String(before.revision))
    .send({
      reaction: 'blocked',
      trackVersion: before.trackVersion,
      version: 0,
    });
  expect(stale.status).toBe(409);
  expect(profiles.list(p.id)).toEqual([]);
});
it('parent can remove, block, unblock and restore profiles while child cannot use admin endpoints', async () => {
  await start();
  await react('blocked');
  const pref = profiles.list(defaultId)[0];
  expect(
    (
      await request(hub.app)
        .get(`/api/admin/profiles/${defaultId}/preferences`)
        .set('Cookie', `hub_child=${first.token}`)
    ).status,
  ).toBe(401);
  const listed = await request(hub.app)
    .get(`/api/admin/profiles/${defaultId}/preferences`)
    .set('Cookie', `hub_parent=${parent.token}`);
  expect(listed.body[0].available).toBe(true);
  expect(
    (
      await admin(
        `/api/admin/profiles/${defaultId}/preferences/${pref.id}`,
        { reaction: 'neutral', version: pref.version },
        'put',
      )
    ).status,
  ).toBe(200);
  expect(profiles.list(defaultId)).toEqual([]);
  expect(
    (
      await admin(`/api/admin/profiles/${defaultId}/preferences`, {
        collectionId: sampleLibrary[0].id,
        trackId: 'mock-sunshine-1',
        reaction: 'favourite',
      })
    ).status,
  ).toBe(200);
  const p = profiles.create('Jo', '🐼');
  profiles.set(p.id, (await backend.tracks(sampleLibrary[0]))[0], 'favourite');
  expect(
    (await admin(`/api/admin/profiles/${p.id}`, {}, 'delete')).status,
  ).toBe(200);
  expect(profiles.get(p.id)).toBeUndefined();
  expect((await admin(`/api/admin/profiles/${p.id}/restore`)).status).toBe(200);
  expect(profiles.list(p.id)).toHaveLength(1);
  expect(
    (
      await admin(`/api/admin/profiles/${defaultId}/preferences`, {
        collectionId: 'unapproved',
        trackId: 'x',
        reaction: 'favourite',
      })
    ).status,
  ).toBe(403);
});
it('revoking an approval hides favourites immediately and does not delete the stored taste', async () => {
  await start();
  await react('favourite');
  expect(
    (await admin('/api/admin/collection/' + sampleLibrary[0].id, {}, 'delete'))
      .status,
  ).toBe(200);
  const result = await request(hub.app)
    .get('/api/child/collection/__favourites__')
    .set('Cookie', `hub_child=${first.token}`);
  expect(result.body.tracks).toEqual([]);
  expect(profiles.list(defaultId)).toHaveLength(1);
  expect((await state()).playback.track).toBe(null);
});
it('matches verified aliases case-sensitively without blocking similarly named recordings', () => {
  const track: Track = {
    id: 'library://track/9',
    uri: 'library://track/9',
    sourceUris: ['spotify--AbC://track/A'],
    name: 'Song',
    artist: 'Artist',
    duration: 30,
    artwork: '/art/fallback.svg',
  };
  profiles.set(defaultId, track, 'blocked');
  expect(
    profiles.blocked(defaultId, {
      id: 'spotify--AbC://track/A',
      uri: 'spotify--AbC://track/A',
    }),
  ).toBe(true);
  expect(
    profiles.blocked(defaultId, {
      id: 'spotify--abc://track/A',
      uri: 'spotify--abc://track/A',
    }),
  ).toBe(false);
  expect(
    profiles.blocked(defaultId, {
      ...track,
      id: 'other',
      uri: 'other://track/A',
      sourceUris: [],
    }),
  ).toBe(false);
  const other = profiles.create('Other', '⭐');
  expect(profiles.blocked(other.id, track)).toBe(false);
});
it('stale preference updates cannot undo a newer parent edit', async () => {
  await start();
  await react('favourite');
  const old = (await state()).personal!;
  await react('blocked');
  const response = await child(
    '/api/child/reaction',
    {
      reaction: 'neutral',
      trackVersion: old.trackVersion,
      version: old.preference!.version,
    },
    first,
    'put',
  );
  expect(response.status).toBe(409);
  expect(profiles.list(defaultId)[0].reaction).toBe('blocked');
});

it('retains profiles, preferences, assignments and existing sessions across a real database reopen', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'hub-profiles-'));
  const path = join(directory, 'hub.sqlite');
  try {
    const firstStore = new Store(path),
      firstProfiles = new Profiles(firstStore);
    const existing = firstStore.createSession('child');
    firstStore.set('passwordHash', 'unchanged-private-fixture');
    const profile = firstProfiles.create('Persisted child', '🚀');
    const device = firstProfiles.device(existing.token);
    firstProfiles.assign(device.id, profile.id);
    const track = (await backend.tracks(sampleLibrary[0]))[0];
    firstProfiles.set(profile.id, track, 'favourite');
    firstStore.close();
    const reopened = new Store(path),
      restored = new Profiles(reopened);
    expect(reopened.get('passwordHash', '')).toBe('unchanged-private-fixture');
    expect(reopened.session(existing.token)?.csrf).toBe(existing.csrf);
    expect(restored.device(existing.token).profile_id).toBe(profile.id);
    expect(restored.list(profile.id)[0].reaction).toBe('favourite');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
