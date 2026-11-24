import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../src/server/db';
import { Profiles } from '../src/server/profiles';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
import type { HubState, ApprovedItem } from '../src/shared/types';
let store: Store,
  profiles: Profiles,
  backend: MockBackend,
  hub: ReturnType<typeof createHub>;
let parent: ReturnType<Store['createSession']>,
  adult: typeof parent,
  kid: typeof parent,
  second: typeof parent;
let adultId: string;
beforeEach(() => {
  store = new Store(':memory:');
  profiles = new Profiles(store);
  backend = new MockBackend();
  parent = store.createSession('parent');
  adult = store.createSession('child');
  kid = store.createSession('child');
  second = store.createSession('child');
  adultId = profiles.create('Dad', '🦊', 'adult').id;
  profiles.assign(profiles.device(adult.token).id, adultId);
  hub = createHub({
    store,
    backend,
    independentPlayback: { playerIds: ['one', 'two'] },
    tickMs: 100000,
    voice: {
      ready: async () => ({ ready: true }),
      transcribe: async () => ({
        text: 'Play River Compass',
        noSpeech: false,
        durationMs: 100,
      }),
    },
  });
});
afterEach(async () => {
  await hub.close();
  store.close();
  vi.restoreAllMocks();
});
async function state(s = adult): Promise<HubState> {
  return (
    await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', `hub_child=${s.token}`)
  ).body;
}
async function headers(s = adult) {
  const p = (await state(s)).personal!;
  return {
    Cookie: `hub_child=${s.token}`,
    'X-CSRF-Token': s.csrf,
    'X-Child-Profile': p.profile.id,
    'X-Child-Device': p.deviceId,
    'X-Profile-Revision': String(p.revision),
  };
}
async function search(text = 'River Compass', s = adult) {
  return request(hub.app)
    .get('/api/child/catalogue/search')
    .query({ search: text })
    .set(await headers(s));
}
async function command(body: object, s = adult) {
  return request(hub.app)
    .post('/api/child/playback')
    .set(await headers(s))
    .send(body);
}
async function preview(item: ApprovedItem, s = adult) {
  return request(hub.app)
    .get('/api/child/collection/' + encodeURIComponent(item.id))
    .set(await headers(s));
}
const admin = (
  path: string,
  body: object,
  method: 'post' | 'patch' | 'delete' = 'post',
) =>
  request(hub.app)
    [method](path)
    .set('Cookie', `hub_parent=${parent.token}`)
    .set('X-CSRF-Token', parent.csrf)
    .send(body);
it('lets an assigned adult search and play an unapproved catalogue song without approving it for children', async () => {
  const result = await search();
  expect(result.status).toBe(200);
  const item = result.body.find(
    (i: ApprovedItem) => i.kind === 'track',
  ) as ApprovedItem;
  expect(item.id).toMatch(/^adult:/);
  const tracks = await preview(item);
  expect(tracks.status).toBe(200);
  expect(tracks.body.tracks[0].name).toBe('River Compass');
  const started = await command({ action: 'start', collectionId: item.id });
  expect(started.status).toBe(200);
  expect(started.body.playback.track.name).toBe('River Compass');
  expect(store.collection()).toEqual([]);
  expect((await state(kid)).collection.map((i) => i.id)).toEqual([
    '__favourites__',
  ]);
  expect((await command({ action: 'next' })).status).toBe(200);
  expect((await command({ action: 'repeat', enabled: true })).status).toBe(200);
});
it('requires adult assignment and blocks cross-device result IDs and arbitrary URIs', async () => {
  expect(
    (
      await request(hub.app).get(
        '/api/child/catalogue/search?search=Orbit Lanterns',
      )
    ).status,
  ).toBe(401);
  expect((await search('Orbit Lanterns', kid)).status).toBe(403);
  const item = (await search()).body[0] as ApprovedItem;
  expect((await preview(item, kid)).status).toBe(403);
  expect(
    (await command({ action: 'start', collectionId: item.id }, kid)).status,
  ).toBe(403);
  profiles.assign(profiles.device(second.token).id, adultId);
  expect((await preview(item, second)).status).toBe(404);
  expect(
    (await command({ action: 'start', collectionId: item.id }, second)).status,
  ).toBe(403);
  expect(
    (
      await command({
        action: 'start',
        collectionId: 'spotify://track/arbitrary',
      })
    ).status,
  ).toBe(403);
});
it('children cannot select an adult profile or create/upgrade profiles themselves', async () => {
  const p = (await state(kid)).personal!;
  expect(
    (
      await request(hub.app)
        .put('/api/child/profile')
        .set(await headers(kid))
        .send({ profileId: adultId, revision: p.revision })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(hub.app)
        .post('/api/admin/profiles')
        .set(await headers(kid))
        .send({ name: 'Attack', avatar: '⭐', kind: 'adult' })
    ).status,
  ).toBe(401);
  expect((await state(kid)).personal?.profile.kind).toBe('child');
  const fresh = store.createSession('child');
  expect((await state(fresh)).personal?.profile.kind).toBe('child');
});
it('adult favourites play outside the child shelf and become unavailable after returning to child mode', async () => {
  const item = (await search()).body.find(
    (i: ApprovedItem) => i.kind === 'track',
  );
  await command({ action: 'start', collectionId: item.id });
  const p = (await state()).personal!;
  expect(
    (
      await request(hub.app)
        .put('/api/child/reaction')
        .set(await headers())
        .send({
          reaction: 'favourite',
          version: 0,
          trackVersion: p.trackVersion,
        })
    ).status,
  ).toBe(200);
  const managed = await request(hub.app)
    .get(`/api/admin/profiles/${adultId}/preferences`)
    .set('Cookie', `hub_parent=${parent.token}`);
  expect(managed.body[0].available).toBe(true);
  const favourite = { id: '__favourites__' } as ApprovedItem;
  expect((await preview(favourite)).body.tracks).toHaveLength(1);
  expect(
    (await command({ action: 'start', collectionId: '__favourites__' })).status,
  ).toBe(200);
  expect(
    (
      await request(hub.app)
        .post('/api/child/adult/lock')
        .set(await headers())
        .send({})
    ).status,
  ).toBe(200);
  expect((await state()).personal?.profile.kind).toBe('child');
  expect((await state()).playback.track).toBeNull();
  expect((await preview(favourite)).body.tracks).toEqual([]);
  expect((await search()).status).toBe(403);
  expect(
    (await command({ action: 'start', collectionId: item.id })).status,
  ).toBe(403);
});
it('role downgrade invalidates an in-flight adult search and old playback capabilities', async () => {
  const item = (await search()).body[0] as ApprovedItem;
  await command({ action: 'start', collectionId: item.id });
  let finish!: (value: never[]) => void;
  const gate = new Promise<never[]>((r) => (finish = r));
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  vi.spyOn(backend, 'searchCatalog').mockImplementation(async () => {
    entered();
    return gate;
  });
  const pending = search('Orbit Lanterns').then((r) => r);
  await started;
  try {
    expect(
      (
        await admin(
          `/api/admin/profiles/${adultId}`,
          { name: 'Dad', avatar: '🦊', kind: 'child' },
          'patch',
        )
      ).status,
    ).toBe(200);
  } finally {
    finish([]);
  }
  expect([403, 409]).toContain((await pending).status);
  expect((await search()).status).toBe(403);
  expect((await state()).playback.status).toBe('idle');
  expect(
    (await command({ action: 'start', collectionId: item.id })).status,
  ).toBe(403);
});
it('voice searches the catalogue only for an adult and keeps explicit selection before playback', async () => {
  const results = await request(hub.app)
    .post('/api/child/voice/matches')
    .set(await headers())
    .send({ text: 'Play River Compass' });
  expect(results.status).toBe(200);
  expect(
    results.body.matches.some(
      (m: { name: string }) => m.name === 'River Compass',
    ),
  ).toBe(true);
  expect((await state()).playback.track).toBeNull();
  const blocked = await request(hub.app)
    .post('/api/child/voice/matches')
    .set(await headers(kid))
    .send({ text: 'River Compass' });
  expect(blocked.body.matches).toEqual([]);
});
it('a locked shared display returns to its previous child and does not stop another device', async () => {
  const other = profiles.create('Ben', '🚀');
  profiles.assign(profiles.device(kid.token).id, other.id);
  const item = sampleLibrary[0];
  store.approve({
    ...item,
    displayName: item.name,
    position: 0,
    hiddenTrackIds: [],
    artworkOverride: null,
  });
  await command({ action: 'start', collectionId: item.id });
  const device = (await state(kid)).personal!.deviceId;
  expect(
    (
      await admin(
        `/api/admin/profile-devices/${device}`,
        { profileId: adultId, name: 'Shared player' },
        'patch',
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(hub.app)
        .post('/api/child/adult/lock')
        .set(await headers(kid))
        .send({})
    ).status,
  ).toBe(200);
  expect((await state(kid)).personal?.profile.id).toBe(other.id);
  expect((await state()).playback.status).toBe('playing');
});
it('new pairings remain children even when the first existing profile is an adult', async () => {
  const child = profiles.create('Child', '⭐');
  profiles.update('child-default', 'Original', '⭐', 'adult');
  const fresh = store.createSession('child');
  expect((await state(fresh)).personal?.profile.id).toBe(child.id);
  expect(() => profiles.archive(child.id)).toThrow('Keep at least one child');
});
it('migrates old profiles to child access and persists explicitly created adult profiles', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'hub-adult-migration-')),
    path = join(directory, 'old.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(readFileSync('migrations/001_initial.sql', 'utf8'));
    old.exec(readFileSync('migrations/002_child_profiles.sql', 'utf8'));
    old
      .prepare('INSERT INTO child_profiles(id,name,avatar) VALUES(?,?,?)')
      .run('named-adult', 'Dad', '⭐');
    old
      .prepare('INSERT INTO config VALUES(?,?)')
      .run('passwordHash', JSON.stringify('unchanged-fixture'));
    old.close();
    const migrated = new Store(path),
      p = new Profiles(migrated);
    expect(p.all().every((p) => p.kind === 'child')).toBe(true);
    expect(migrated.get('passwordHash', '')).toBe('unchanged-fixture');
    const created = p.create('Adult', '🦊', 'adult');
    migrated.close();
    const reopened = new Store(path);
    expect(new Profiles(reopened).get(created.id)?.kind).toBe('adult');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
