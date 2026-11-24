import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { Store } from '../src/server/db';
import { MockBackend } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
import { defaultSettings } from '../src/shared/types';
import { BackendError } from '../src/server/adapters/backend';
let store: Store;
let backend: MockBackend;
let hub: ReturnType<typeof createHub>;
let parent: ReturnType<typeof request.agent>;
let csrf = '';
let childCookie = '';
let childCsrf = '';
let testNow = new Date('2026-11-11T10:00:00Z');
beforeEach(async () => {
  testNow = new Date('2026-11-11T10:00:00Z');
  store = new Store(':memory:');
  backend = new MockBackend(() => testNow.getTime());
  hub = createHub({
    store,
    backend,
    setupCode: 'test-setup-code',
    automationToken: 'a'.repeat(40),
    tickMs: 100_000,
    now: () => testNow,
  });
  parent = request.agent(hub.app);
  const r = await parent.post('/api/auth/setup').send({
    password: 'a secure parent password',
    setupCode: 'test-setup-code',
  });
  csrf = r.body.csrf;
  const pair = await parent
    .post('/api/admin/pair')
    .set('X-CSRF-Token', csrf)
    .send({});
  childCookie = (pair.headers['set-cookie'] as unknown as string[])
    .find((v) => v.startsWith('hub_child='))!
    .split(';')[0];
  childCsrf = pair.body.csrf;
});
afterEach(async () => {
  await hub.close();
  store.close();
});
const admin = (
  path: string,
  body: object,
  method: 'post' | 'put' | 'patch' | 'delete' = 'post',
) => parent[method](path).set('X-CSRF-Token', csrf).send(body);
const child = (body: object) =>
  request(hub.app)
    .post('/api/child/playback')
    .set('Cookie', childCookie)
    .set('X-CSRF-Token', childCsrf)
    .send(body);
async function approve(index = 0) {
  const r = await parent.get('/api/admin/library');
  const item = r.body[index];
  expect((await admin('/api/admin/collection', { id: item.id })).status).toBe(
    200,
  );
  return item;
}
describe('authentication and authorisation boundary', () => {
  it('retains validated playback ownership when the remote start acknowledgement is lost', async () => {
    const item = await approve();
    const start = backend.start.bind(backend);
    let calls = 0;
    backend.start = async (...args) => {
      calls++;
      await start(...args);
      throw new BackendError('Acknowledgement timed out', 504);
    };
    const result = await child({ action: 'start', collectionId: item.id });
    expect(result.status).toBe(200);
    expect(result.body.playback.track.name).toBe('Sunspun');
    expect(result.body.playback.collectionId).toBe(item.id);
    expect(calls).toBe(1);
    expect((await child({ action: 'pause' })).status).toBe(200);
    expect((await child({ action: 'play' })).status).toBe(200);
  });
  it('does not invent playback after a failed start and recognises a later confirmed provider identity', async () => {
    const item = await approve();
    const tracks = (
      await parent.get(`/api/admin/tracks?id=${encodeURIComponent(item.id)}`)
    ).body;
    const start = backend.start.bind(backend);
    backend.start = async () => {
      throw new BackendError('Response lost', 504);
    };
    expect(
      (await child({ action: 'start', collectionId: item.id })).status,
    ).toBe(504);
    expect(hub.snapshot('child').playback.track).toBeNull();
    await start(store.collection()[0], tracks, store.settings());
    const read = backend.state.bind(backend);
    backend.state = async (playerId) => {
      const state = await read(playerId);
      return {
        ...state,
        track: state.track
          ? {
              ...state.track,
              uri: 'library://track/resolved',
              sourceUris: [tracks[0].uri],
            }
          : null,
      };
    };
    await hub.refresh();
    expect(hub.snapshot('child').playback.track?.name).toBe('Sunspun');
    expect(hub.snapshot('child').playback.collectionId).toBe(item.id);
    backend.state = async (playerId) => ({
      ...(await read(playerId)),
      track: {
        ...tracks[0],
        uri: 'spotify://track/unapproved',
        sourceUris: ['other://track/unapproved'],
      },
    });
    await hub.refresh();
    expect(hub.snapshot('child').playback.track).toBeNull();
  });
  it('allows parents to inspect a browsed playlist before approval without changing playback or child access', async () => {
    const library = (await parent.get('/api/admin/library')).body;
    const item = library[0];
    const path = `/api/admin/tracks?id=${encodeURIComponent(item.id)}`;
    expect((await request(hub.app).get(path)).status).toBe(401);
    expect(
      (await request(hub.app).get(path).set('Cookie', childCookie)).status,
    ).toBe(401);
    const preview = await parent.get(path);
    expect(preview.status).toBe(200);
    expect(preview.body).toHaveLength(4);
    expect(preview.body[0]).toMatchObject({
      name: 'Sunspun',
      artist: 'Sunbeams',
      duration: 194,
    });
    expect(store.collection()).toEqual([]);
    expect((await backend.state(store.settings().playerId)).status).toBe(
      'idle',
    );
    expect(
      (
        await request(hub.app)
          .get(`/api/child/collection/${encodeURIComponent(item.id)}`)
          .set('Cookie', childCookie)
      ).status,
    ).toBe(404);
    expect((await parent.get('/api/admin/tracks?id=unknown')).status).toBe(404);
  });
  it('requires parent auth and CSRF; rejects cross-origin and unpaired controls', async () => {
    expect((await request(hub.app).get('/api/admin/settings')).status).toBe(
      401,
    );
    expect(
      (await parent.put('/api/admin/settings').send(defaultSettings)).status,
    ).toBe(403);
    expect(
      (await admin('/api/admin/pair', {}).set('Origin', 'https://evil.example'))
        .status,
    ).toBe(403);
    expect(
      (
        await request(hub.app)
          .post('/api/child/playback')
          .send({ action: 'play' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(hub.app)
          .get('/api/admin/settings')
          .set('Cookie', childCookie)
      ).status,
    ).toBe(401);
    expect(
      (await child({ action: 'start', collectionId: 'not-approved' })).status,
    ).toBe(403);
  });
  it('logs out and rejects incorrect passwords and setup takeover', async () => {
    expect(
      (
        await request(hub.app)
          .post('/api/auth/login')
          .send({ password: 'incorrect password' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(hub.app)
          .post('/api/auth/setup')
          .send({ password: 'another password', setupCode: 'test-setup-code' })
      ).status,
    ).toBe(409);
    await admin('/api/auth/logout', {});
    expect((await parent.get('/api/admin/settings')).status).toBe(401);
    const login = await parent
      .post('/api/auth/login')
      .send({ password: 'a secure parent password' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(login.headers['set-cookie'][0]).toContain('SameSite=Strict');
  });
  it('revokes device sessions and restricts automation to screen commands', async () => {
    expect(
      (
        await request(hub.app)
          .post('/api/automation/screen')
          .send({ mode: 'off' })
      ).status,
    ).toBe(401);
    const r = await request(hub.app)
      .post('/api/automation/screen')
      .set('Authorization', `Bearer ${'a'.repeat(40)}`)
      .send({ mode: 'off' });
    expect(r.body.screenOff).toBe(true);
    expect(
      (
        await request(hub.app)
          .post('/api/automation/screen')
          .set('Authorization', `Bearer ${'a'.repeat(40)}`)
          .send({ mode: 'off', playerId: 'other' })
      ).status,
    ).toBe(422);
    await admin('/api/admin/revoke-devices', {});
    expect((await child({ action: 'pause' })).status).toBe(401);
  });
});
describe('approved music and playback API', () => {
  it('handles approvals, filtering, rename, order, play, pause, next and removal', async () => {
    const a = await approve(0),
      b = await approve(1);
    await admin(
      `/api/admin/collection/${encodeURIComponent(a.id)}`,
      { displayName: 'Morning music' },
      'patch',
    );
    await admin('/api/admin/collection/order', { ids: [b.id, a.id] }, 'put');
    let state = (
      await request(hub.app).get('/api/child/state').set('Cookie', childCookie)
    ).body;
    expect(state.collection.map((i: any) => i.id)).toEqual([
      '__favourites__',
      b.id,
      a.id,
    ]);
    expect(
      (await child({ action: 'start', collectionId: a.id })).body.playback
        .status,
    ).toBe('playing');
    expect((await child({ action: 'pause' })).body.playback.status).toBe(
      'paused',
    );
    expect((await child({ action: 'play' })).body.playback.status).toBe(
      'playing',
    );
    const first = hub.snapshot().playback.track?.name;
    await child({ action: 'next' });
    expect(hub.snapshot().playback.track?.name).not.toBe(first);
    await admin(
      `/api/admin/collection/${encodeURIComponent(a.id)}`,
      {},
      'delete',
    );
    state = hub.snapshot();
    expect(state.collection).toHaveLength(1);
    expect(state.playback.status).toBe('idle');
    expect((await child({ action: 'play' })).status).toBe(403);
  });
  it('clamps requested volumes and rejects malformed API input', async () => {
    await admin(
      '/api/admin/settings',
      { ...defaultSettings, maxVolume: 30, startupVolume: 20 },
      'put',
    );
    await child({ action: 'volume', volume: 99 });
    expect(hub.snapshot().playback.volume).toBe(30);
    expect((await child({ action: 'volume', volume: 101 })).status).toBe(422);
    expect(
      (await child({ action: 'play', uri: 'spotify://track/arbitrary' }))
        .status,
    ).toBe(422);
    expect(
      (
        await admin(
          '/api/admin/settings',
          { ...defaultSettings, maxVolume: -1 },
          'put',
        )
      ).status,
    ).toBe(422);
    expect(
      (await admin('/api/admin/collection/order', { ids: ['invented'] }, 'put'))
        .status,
    ).toBe(422);
  });
  it('defaults to local speakers, keeps remote targets optional, and stops an owned queue when switching back', async () => {
    expect((await parent.get('/api/admin/settings')).body.playbackMode).toBe(
      'local',
    );
    await admin(
      '/api/admin/settings',
      { ...defaultSettings, playbackMode: 'remote' },
      'put',
    );
    const item = await approve();
    await child({ action: 'start', collectionId: item.id });
    expect(hub.snapshot().playback.status).toBe('playing');
    const result = await admin(
      '/api/admin/settings',
      { ...defaultSettings, playbackMode: 'local', playerId: '' },
      'put',
    );
    expect(result.status).toBe(200);
    expect(store.settings().playbackMode).toBe('local');
    expect(store.get('activeCollection', null)).toBeNull();
    expect((await backend.state('mock-lenovo')).status).toBe('idle');
    expect(
      (await request(hub.app).post('/api/child/audio/register').send({}))
        .status,
    ).toBe(401);
    expect(
      (
        await request(hub.app)
          .post('/api/child/audio/register')
          .set('Cookie', childCookie)
          .send({})
      ).status,
    ).toBe(403);
  });
  it('excludes hidden tracks and stops when new restrictions apply', async () => {
    const item = await approve();
    const tracks = (await parent.get(`/api/admin/tracks?id=${item.id}`)).body;
    expect(
      (
        await admin(
          `/api/admin/collection/${item.id}`,
          { hiddenTrackIds: [tracks[0].id] },
          'patch',
        )
      ).status,
    ).toBe(200);
    const start = await child({ action: 'start', collectionId: item.id });
    expect(start.body.playback.track.id).toBe(tracks[1].id);
    const endpoint = await request(hub.app)
      .get(`/api/child/collection/${item.id}`)
      .set('Cookie', childCookie);
    expect(endpoint.body.tracks).toHaveLength(tracks.length - 1);
    await admin(
      `/api/admin/collection/${item.id}`,
      { hiddenTrackIds: [tracks[1].id] },
      'patch',
    );
    expect(hub.snapshot().playback.status).toBe('idle');
  });
  it('handles player disconnect and recovery without losing the music shelf', async () => {
    const item = await approve();
    await child({ action: 'start', collectionId: item.id });
    await admin('/api/admin/mock/connection', { available: false });
    expect(hub.snapshot().playback.status).toBe('unavailable');
    expect((await child({ action: 'play' })).status).toBe(503);
    expect(hub.snapshot().collection).toHaveLength(1);
    await admin('/api/admin/mock/connection', { available: true });
    expect(hub.snapshot().playback.connected).toBe(true);
    expect((await child({ action: 'play' })).body.playback.status).toBe(
      'playing',
    );
  });
  it('validates and reencodes uploaded artwork; rejects SVG and arbitrary paths', async () => {
    expect(
      (
        await parent
          .post('/api/admin/artwork')
          .set('X-CSRF-Token', csrf)
          .set('Content-Type', 'image/svg+xml')
          .send('<svg/>')
      ).status,
    ).toBe(415);
    expect(
      (
        await parent
          .post('/api/admin/artwork')
          .set('X-CSRF-Token', csrf)
          .set('Content-Type', 'image/png')
          .send(Buffer.from('fake image'))
      ).status,
    ).toBe(422);
    const image = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#ffaa00' },
    })
      .png()
      .toBuffer();
    const upload = await parent
      .post('/api/admin/artwork')
      .set('X-CSRF-Token', csrf)
      .set('Content-Type', 'image/png')
      .send(image);
    expect(upload.status).toBe(200);
    expect(upload.body.url).toMatch(/^\/artwork\/upload\/[a-f0-9]{64}$/);
    const item = await approve();
    expect(
      (
        await admin(
          `/api/admin/collection/${item.id}`,
          { artworkOverride: upload.body.url },
          'patch',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await admin(
          `/api/admin/collection/${item.id}`,
          { artworkOverride: '/etc/passwd' },
          'patch',
        )
      ).status,
    ).toBe(422);
  });
  it('keeps collection visible on backend errors and retries pending stop', async () => {
    const item = await approve();
    await child({ action: 'start', collectionId: item.id });
    backend.setAvailable(false);
    await admin(`/api/admin/collection/${item.id}`, {}, 'delete');
    expect(store.get('pendingStop', false)).toBe(true);
    expect(hub.snapshot().collection).toHaveLength(0);
    backend.setAvailable(true);
    await hub.refresh();
    expect(hub.snapshot().playback.connected).toBe(true);
  });
});

describe('policy enforcement and restart ownership', () => {
  it('enforces bedtime server-side and blanks on an independent schedule', async () => {
    const item = await approve();
    await admin(
      '/api/admin/settings',
      { ...defaultSettings, bedtimeEnabled: true, screenScheduleEnabled: true },
      'put',
    );
    expect(
      (await child({ action: 'start', collectionId: item.id })).body.playback
        .status,
    ).toBe('playing');
    testNow = new Date('2026-11-11T12:00:00Z');
    await hub.refresh();
    expect(hub.snapshot().device).toMatchObject({
      bedtime: true,
      screenOff: true,
    });
    expect(hub.snapshot().playback.status).toBe('idle');
    expect((await child({ action: 'play' })).status).toBe(403);
    expect(
      (await child({ action: 'start', collectionId: item.id })).status,
    ).toBe(403);
    await admin('/api/admin/screen', { mode: 'on' });
    expect(hub.snapshot().device.screenOff).toBe(false);
    expect(hub.snapshot().device.bedtime).toBe(true);
  });
  it('restarts the last approved collection only when resume is enabled', async () => {
    const item = await approve();
    await admin(
      '/api/admin/settings',
      { ...defaultSettings, resumeAfterRestart: true },
      'put',
    );
    await child({ action: 'start', collectionId: item.id });
    await hub.close();
    backend = new MockBackend();
    hub = createHub({ store, backend, tickMs: 100_000 });
    await hub.refresh();
    expect(hub.snapshot().playback.status).toBe('playing');
    expect(hub.snapshot().playback.track?.name).toBe('Sunspun');
    await hub.close();
    store.set('settings', { ...defaultSettings, resumeAfterRestart: false });
    backend = new MockBackend();
    hub = createHub({ store, backend, tickMs: 100_000 });
    await hub.refresh();
    expect(hub.snapshot().playback.status).toBe('idle');
  });
  it('hides metadata and denies resume/skip when another controller replaces the queue', async () => {
    const item = await approve();
    await child({ action: 'start', collectionId: item.id });
    const initial = await backend.state(defaultSettings.playerId);
    backend.state = async () => ({
      ...initial,
      track: {
        ...initial.track!,
        uri: 'other://track/not-approved',
        name: 'Unapproved external music',
      },
    });
    await hub.refresh();
    expect(
      (await parent.get('/api/admin/state')).body.playback.track.name,
    ).toBe('Unapproved external music');
    const response = await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', childCookie);
    expect(response.body.playback.track).toBeNull();
    expect((await child({ action: 'next' })).status).toBe(403);
    expect((await child({ action: 'play' })).status).toBe(403);
    expect((await child({ action: 'pause' })).status).toBe(200);
  });
});

describe('track selection and Spotify sharing', () => {
  it('plays a chosen approved track and rejects hidden or foreign tracks', async () => {
    const item = await approve();
    const tracks = (await parent.get(`/api/admin/tracks?id=${item.id}`)).body;
    expect(
      (
        await child({
          action: 'start',
          collectionId: item.id,
          trackId: tracks[2].id,
        })
      ).body.playback.track.name,
    ).toBe('Paper Skies');
    await admin(
      `/api/admin/collection/${item.id}`,
      { hiddenTrackIds: [tracks[1].id] },
      'patch',
    );
    expect(
      (
        await child({
          action: 'start',
          collectionId: item.id,
          trackId: tracks[1].id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await child({
          action: 'start',
          collectionId: item.id,
          trackId: 'mock-space-1',
        })
      ).status,
    ).toBe(403);
    const visible = await request(hub.app)
      .get(`/api/child/collection/${item.id}`)
      .set('Cookie', childCookie);
    expect(visible.body.tracks.map((t: any) => t.id)).not.toContain(
      tracks[1].id,
    );
  });
  it('requires parent and CSRF for Spotify links and gives an honest mock-mode setup message', async () => {
    const link =
      'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=example';
    expect(
      (await request(hub.app).post('/api/admin/spotify/resolve').send({ link }))
        .status,
    ).toBe(401);
    expect(
      (await parent.post('/api/admin/spotify/resolve').send({ link })).status,
    ).toBe(403);
    const response = await admin('/api/admin/spotify/resolve', { link });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Connect Music Assistant');
    expect(
      (
        await admin('/api/admin/spotify/resolve', {
          link: 'http://127.0.0.1/secrets',
        })
      ).status,
    ).toBe(422);
  });
  it('resolves a parent link for review without approving it automatically', async () => {
    const item = (await backend.library())[0];
    let received = '';
    backend.resolvePlaylist = async (uri: string) => {
      received = uri;
      return item;
    };
    const response = await admin('/api/admin/spotify/resolve', {
      link: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(response.status).toBe(200);
    expect(received).toBe('spotify://playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(store.collection()).toHaveLength(0);
    expect(
      (await admin('/api/admin/collection', { id: response.body.id })).status,
    ).toBe(200);
    expect(store.collection()).toHaveLength(1);
  });
});

describe('Music Assistant parent integration panel', () => {
  it('restricts connection diagnostics to the parent and never exposes credentials', async () => {
    expect((await request(hub.app).get('/api/admin/integration')).status).toBe(
      401,
    );
    const response = await parent.get('/api/admin/integration');
    expect(response.body).toMatchObject({
      mode: 'mock',
      connected: true,
      serverUrl: null,
      playerId: 'mock-lenovo',
    });
    expect(response.body.players).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toMatch(/csrf|password|token/i);
  });
  it('isolates real approvals from mock mode without deleting either collection', async () => {
    const item = await approve();
    store.approve({
      ...item,
      id: 'library://album/1',
      uri: 'library://album/1',
      name: 'Real album',
      displayName: 'Real album',
      position: 1,
      hiddenTrackIds: [],
    });
    const response = await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', childCookie);
    expect(response.body.collection.map((i: any) => i.id)).toEqual([
      '__favourites__',
      item.id,
    ]);
    expect(
      (await child({ action: 'start', collectionId: 'library://album/1' }))
        .status,
    ).toBe(403);
    expect(
      (await admin('/api/admin/collection/order', { ids: [item.id] }, 'put'))
        .status,
    ).toBe(200);
    expect(store.collection()).toHaveLength(2);
  });
});

it('keeps catalogue discovery parent-only and approves exactly one song for child playback', async () => {
  expect(
    (await request(hub.app).get('/api/admin/search?search=Sunspun')).status,
  ).toBe(401);
  expect(
    (
      await request(hub.app)
        .get('/api/admin/search?search=Sunspun')
        .set('Cookie', childCookie)
    ).status,
  ).toBe(401);
  expect((await parent.get('/api/admin/search?search=')).status).toBe(422);
  const result = await parent.get('/api/admin/search?search=Sunspun');
  expect(result.status).toBe(200);
  const song = result.body.find(
    (item: { kind: string }) => item.kind === 'track',
  );
  expect(song).toBeTruthy();
  expect((await child({ action: 'start', collectionId: song.id })).status).toBe(
    403,
  );
  const preview = await parent.get(
    `/api/admin/tracks?id=${encodeURIComponent(song.id)}`,
  );
  expect(preview.body).toHaveLength(1);
  expect(store.collection()).toHaveLength(0);
  expect((await admin('/api/admin/collection', { id: song.id })).status).toBe(
    200,
  );
  const played = await child({ action: 'start', collectionId: song.id });
  expect(played.status).toBe(200);
  expect(played.body.playback.track.name).toBe('Sunspun');
  expect(store.collection()[0].kind).toBe('track');
  expect(
    (
      await child({
        action: 'start',
        collectionId: song.id,
        trackId: 'another-track',
      })
    ).status,
  ).toBe(403);
  const tracks = await backend.tracks(song);
  await admin(
    `/api/admin/collection/${encodeURIComponent(song.id)}`,
    { hiddenTrackIds: [tracks[0].id] },
    'patch',
  );
  expect((await child({ action: 'start', collectionId: song.id })).status).toBe(
    422,
  );
  const readTracks = backend.tracks.bind(backend);
  backend.tracks = async (item) =>
    (await readTracks(item)).map((track) => ({
      ...track,
      id: `canonical-${track.id}`,
      sourceUris: [track.id, track.uri, ...(track.sourceUris ?? [])],
    }));
  expect(
    (
      await request(hub.app)
        .get(`/api/child/collection/${encodeURIComponent(song.id)}`)
        .set('Cookie', childCookie)
    ).body.tracks,
  ).toEqual([]);
  expect((await child({ action: 'start', collectionId: song.id })).status).toBe(
    422,
  );
  expect(
    (
      await admin(
        `/api/admin/collection/${encodeURIComponent(song.id)}`,
        { hiddenTrackIds: [tracks[0].id] },
        'patch',
      )
    ).status,
  ).toBe(200);
});

describe('Sleep Music', () => {
  async function addSleepSong(index = 0) {
    const item = (await parent.get('/api/admin/library')).body[0];
    const tracks = (
      await parent.get(`/api/admin/tracks?id=${encodeURIComponent(item.id)}`)
    ).body;
    const added = await admin('/api/admin/sleep-music', {
      itemId: item.id,
      trackId: tracks[index].id,
    });
    expect(added.status).toBe(200);
    return added.body[index];
  }

  it('plays one parent-curated song during bedtime and stops at morning', async () => {
    const ordinary = await approve(1);
    const song = await addSleepSong();
    const otherSong = await addSleepSong(1);
    const state = await parent.get('/api/admin/state');
    expect(
      state.body.collection.map((item: { id: string }) => item.id),
    ).toEqual([ordinary.id]);
    expect(
      state.body.sleepSongs.map((item: { id: string }) => item.id),
    ).toEqual([song.id, otherSong.id]);
    expect(
      (await request(hub.app).post('/api/admin/sleep-music').send({})).status,
    ).toBe(401);
    expect(
      (await child({ action: 'start-sleep', songId: 'unknown-song' })).status,
    ).toBe(403);

    testNow = new Date('2026-11-11T13:00:00Z');
    await admin(
      '/api/admin/settings',
      {
        ...store.settings(),
        bedtimeEnabled: true,
        bedtimeEnd: '06:45',
        sleepMusicEnd: '07:20',
      },
      'put',
    );
    expect(
      (await child({ action: 'start', collectionId: ordinary.id })).status,
    ).toBe(403);
    const started = await child({ action: 'start-sleep', songId: song.id });
    expect(started.status).toBe(200);
    expect(started.body.sleepSession).toEqual({
      songId: song.id,
      endsAt: '2026-11-11T23:20:00.000Z',
    });
    expect(started.body.playback).toMatchObject({
      track: { uri: song.uri },
      repeat: true,
      status: 'playing',
    });
    expect(
      store
        .get<{ uri: string }[]>('activeQueueTracks', [])
        .map((track) => track.uri),
    ).toEqual([song.uri]);
    expect((await child({ action: 'repeat', enabled: false })).status).toBe(
      409,
    );

    testNow = new Date('2026-11-11T23:19:59Z');
    await hub.refresh();
    expect(hub.snapshot().device.bedtime).toBe(false);
    expect(hub.snapshot().playback).toMatchObject({
      status: 'playing',
      track: { uri: song.uri },
      elapsed:
        Math.floor(
          (testNow.getTime() - Date.parse('2026-11-11T13:00:00Z')) / 1000,
        ) % song.duration,
    });
    testNow = new Date('2026-11-11T23:20:00Z');
    await hub.refresh();
    expect(hub.snapshot().sleepSession).toBeUndefined();
    expect(hub.snapshot().playback).toMatchObject({
      status: 'idle',
      repeat: false,
    });
    expect(
      (await child({ action: 'start', collectionId: ordinary.id })).status,
    ).toBe(200);
  });

  it('stops when the parent removes the selected song and rejects a stale child selection', async () => {
    const song = await addSleepSong();
    await addSleepSong();
    expect(hub.snapshot().sleepSongs).toHaveLength(1);
    expect(
      (await child({ action: 'start-sleep', songId: song.id })).status,
    ).toBe(200);
    expect(
      (await admin(`/api/admin/sleep-music/${song.id}`, {}, 'delete')).body,
    ).toEqual([]);
    expect(hub.snapshot().sleepSession).toBeUndefined();
    expect(hub.snapshot().playback.status).toBe('idle');
    expect(
      (await child({ action: 'start-sleep', songId: song.id })).status,
    ).toBe(403);
  });
});
