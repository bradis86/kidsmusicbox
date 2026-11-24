import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store, hash } from '../src/server/db';
import { createHub } from '../src/server/app';
import { MusicAssistantBackend } from '../src/server/adapters/music-assistant';
let store: Store;
let backend: MusicAssistantBackend;
let first: ReturnType<Store['createSession']>;
let second: typeof first;
let hub: ReturnType<typeof createHub>;
const one = 'a'.repeat(43),
  two = 'b'.repeat(43);
beforeEach(() => {
  store = new Store(':memory:');
  backend = new MusicAssistantBackend({
    url: 'http://127.0.0.1:1',
    token: 'test',
  });
  first = store.createSession('child');
  second = store.createSession('child');
  vi.spyOn(backend, 'configure').mockResolvedValue(undefined);
  vi.spyOn(backend, 'players').mockResolvedValue([
    { id: one, name: 'Phone', type: 'music-assistant', available: true },
    { id: two, name: 'Tablet', type: 'music-assistant', available: true },
  ]);
  vi.spyOn(backend, 'rpc').mockResolvedValue({});
  vi.spyOn(backend, 'state').mockImplementation(async (playerId) => ({
    simulated: false,
    collectionId: null,
    playerId,
    connected: true,
    status: 'idle',
    track: null,
    elapsed: 0,
    volume: 25,
    shuffle: false,
    repeat: false,
  }));
  vi.spyOn(backend, 'command').mockResolvedValue(undefined);
  hub = createHub({
    store,
    backend,
    musicAssistantUrl: 'http://127.0.0.1:1',
    musicAssistantToken: 'test',
    browserPlayerId: 'mpd-hub',
    tickMs: 100000,
  });
});
function register(s: typeof first, clientId: string, claim: boolean) {
  return request(hub.app)
    .post('/api/child/audio/register')
    .set('Cookie', `hub_child=${s.token}`)
    .set('X-CSRF-Token', s.csrf)
    .send({ clientId, claim });
}
afterEach(async () => {
  await hub.close();
  store.close();
  vi.restoreAllMocks();
});
it('requires a deliberate claim, rejects stale playback, and prevents reconnect takeover across sessions', async () => {
  expect((await register(first, one, false)).status).toBe(409);
  expect((await register(first, one, true)).status).toBe(200);
  expect(store.get('audioOwner', '')).toBe(hash(first.token));
  expect((await register(second, two, false)).status).toBe(409);
  expect(store.get('audioClientId', '')).toBe(one);
  expect((await register(second, two, true)).status).toBe(200);
  expect((await register(first, one, false)).status).toBe(409);
  const play = (s: typeof first, id: string) =>
    request(hub.app)
      .post('/api/child/playback')
      .set('Cookie', `hub_child=${s.token}`)
      .set('X-CSRF-Token', s.csrf)
      .set('X-Audio-Client-Id', id)
      .send({ action: 'pause' });
  expect((await play(first, one)).status).toBe(409);
  expect((await play(first, two)).status).toBe(409);
  expect(backend.command).not.toHaveBeenCalled();
  expect((await play(second, two)).status).toBe(200);
  expect(backend.command).toHaveBeenCalledTimes(1);
});

it.each(['unavailable', 'idle'] as const)(
  'recovers a deliberate handover from an %s receiver without a queue',
  async (status) => {
    expect((await register(first, one, true)).status).toBe(200);
    store.set('activeCollection', 'approved-playlist');
    store.set('activeTrackUris', ['approved-track']);
    vi.mocked(backend.state).mockImplementation(async (playerId) => ({
      playerId,
      connected: playerId !== 'mpd-hub' || status !== 'unavailable',
      status: playerId === 'mpd-hub' ? status : 'idle',
      track: null,
      elapsed: 0,
      volume: 25,
      shuffle: false,
      repeat: false,
      collectionId: null,
      simulated: false,
    }));
    vi.mocked(backend.command).mockRejectedValue(
      new Error('No active Music Assistant queue is available for this player'),
    );
    expect((await register(second, two, true)).status).toBe(200);
    expect(backend.command).not.toHaveBeenCalled();
    expect(store.get('audioClientId', '')).toBe(two);
    expect(store.get('audioOwner', '')).toBe(hash(second.token));
    expect(store.get('activeCollection', '')).toBe(null);
    expect(store.get('activeTrackUris', [])).toEqual([]);
  },
);
it.each(['playing', 'paused'] as const)(
  'stops a %s previous receiver before completing handover',
  async (status) => {
    expect((await register(first, one, true)).status).toBe(200);
    store.set('activeCollection', 'approved-playlist');
    const state = await backend.state(one);
    vi.mocked(backend.state).mockResolvedValue({ ...state, status });
    vi.mocked(backend.command).mockImplementation(async () => {
      expect(store.get('audioClientId', '')).toBe(one);
      expect(store.get('audioOwner', '')).toBe(hash(first.token));
    });
    expect((await register(second, two, true)).status).toBe(200);
    expect(backend.command).toHaveBeenCalledWith(
      { action: 'stop' },
      expect.objectContaining({ playerId: 'mpd-hub' }),
    );
    expect(store.get('audioClientId', '')).toBe(two);
  },
);
it('preserves ownership and metadata if the new receiver cannot be configured', async () => {
  expect((await register(first, one, true)).status).toBe(200);
  store.set('activeCollection', 'approved-playlist');
  store.set('activeTrackUris', ['approved-track']);
  vi.mocked(backend.configure).mockRejectedValue(
    new Error('New queue is not ready'),
  );
  expect((await register(second, two, true)).status).toBe(500);
  expect(store.get('audioClientId', '')).toBe(one);
  expect(store.get('audioOwner', '')).toBe(hash(first.token));
  expect(store.get('activeCollection', '')).toBe('approved-playlist');
  expect(store.get('activeTrackUris', [])).toEqual(['approved-track']);
  expect(backend.command).not.toHaveBeenCalled();
});
it('does not hide a failure to stop an active receiver or transfer its ownership', async () => {
  expect((await register(first, one, true)).status).toBe(200);
  store.set('activeCollection', 'approved-playlist');
  const state = await backend.state(one);
  vi.mocked(backend.state).mockResolvedValue({ ...state, status: 'playing' });
  vi.mocked(backend.command).mockRejectedValue(new Error('Stop failed'));
  expect((await register(second, two, true)).status).toBe(500);
  expect(store.get('audioClientId', '')).toBe(one);
  expect(store.get('audioOwner', '')).toBe(hash(first.token));
  expect(store.get('activeCollection', '')).toBe('approved-playlist');
});

it('keeps native delivery session-bound and rejects forged feedback or old Sendspin routes', async () => {
  expect((await register(first, one, true)).status).toBe(200);
  const read = (session: typeof first) =>
    request(hub.app)
      .get(`/api/child/audio/state?clientId=${one}`)
      .set('Cookie', `hub_child=${session.token}`);
  expect((await read(first)).body.status).toBe('stop');
  expect((await read(second)).body).toBe(null);
  expect(
    (
      await request(hub.app)
        .get('/api/child/audio/stream/old?clientId=' + one)
        .set('Cookie', `hub_child=${second.token}`)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(hub.app)
        .post('/api/child/audio/report')
        .set('Cookie', `hub_child=${second.token}`)
        .set('X-CSRF-Token', second.csrf)
        .send({ clientId: one, generation: 'old', event: 'ended', elapsed: 0 })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(hub.app)
        .post('/api/child/audio/report')
        .set('Cookie', `hub_child=${first.token}`)
        .set('X-CSRF-Token', first.csrf)
        .send({ clientId: one, generation: 'old', event: 'ended', elapsed: 0 })
    ).status,
  ).toBe(409);
  expect(
    (await request(hub.app).get('/api/child/audio/state?clientId=' + one))
      .status,
  ).toBe(401);
});

it('invalidates native streams on approval removal even when MA cannot stop its queue', async () => {
  const item = {
    id: 'approved',
    uri: 'spotify://playlist/approved',
    name: 'Approved',
    displayName: 'Approved',
    artist: 'Artist',
    kind: 'playlist' as const,
    artwork: '/art/fallback.svg',
    provider: 'Spotify',
    position: 0,
    artworkOverride: null,
    hiddenTrackIds: [],
  };
  store.approve(item);
  expect((await register(first, one, true)).status).toBe(200);
  store.set('activeCollection', item.id);
  const read = () =>
    request(hub.app)
      .get(`/api/child/audio/state?clientId=${one}`)
      .set('Cookie', `hub_child=${first.token}`);
  const before = (await read()).body.generation;
  vi.mocked(backend.command).mockRejectedValue(new Error('MA offline'));
  const parent = store.createSession('parent');
  const removed = await request(hub.app)
    .delete('/api/admin/collection/' + item.id)
    .set('Cookie', `hub_parent=${parent.token}`)
    .set('X-CSRF-Token', parent.csrf);
  expect(removed.status).toBe(200);
  const after = (await read()).body;
  expect(after.generation).not.toBe(before);
  expect(after.src).toBe(null);
  expect(store.get('activeCollection', '')).toBe(null);
  expect(store.get('pendingStop', false)).toBe(true);
  expect(store.collection()).toEqual([]);
});

it('a personal block preserves the current native stream and advances only at its reported boundary', async () => {
  const tracks = [0, 1, 2].map((index) => ({
    id: `track-${index}`,
    uri: `spotify://track/${index}`,
    name: `Song ${index}`,
    artist: 'Artist',
    duration: 60,
    artwork: '/art/fallback.svg',
  }));
  store.approve({
    id: 'approved',
    uri: 'spotify://playlist/approved',
    name: 'Approved',
    displayName: 'Approved',
    kind: 'playlist',
    artist: 'Artist',
    artwork: '/art/fallback.svg',
    provider: 'Spotify',
    position: 0,
    artworkOverride: null,
    hiddenTrackIds: [],
  });
  vi.spyOn(backend, 'tracks').mockResolvedValue(tracks);
  let current = tracks[0];
  const base = await backend.state('mpd-hub');
  vi.mocked(backend.state).mockImplementation(async (playerId) => ({
    ...base,
    playerId,
    collectionId: 'approved',
    status: 'playing',
    track: current,
    elapsed: 10,
  }));
  vi.spyOn(backend, 'start').mockImplementation(
    async (_item, _tracks, _settings, startId) => {
      current = tracks.find((t) => t.id === startId) ?? tracks[0];
    },
  );
  expect((await register(first, one, true)).status).toBe(200);
  const headers = {
    Cookie: `hub_child=${first.token}`,
    'X-CSRF-Token': first.csrf,
    'X-Audio-Client-Id': one,
  };
  expect(
    (
      await request(hub.app)
        .post('/api/child/playback')
        .set(headers)
        .send({ action: 'start', collectionId: 'approved' })
    ).status,
  ).toBe(200);
  const s = (
    await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', `hub_child=${first.token}`)
  ).body;
  const response = await request(hub.app)
    .put('/api/child/reaction')
    .set(headers)
    .send({
      reaction: 'blocked',
      trackVersion: s.personal.trackVersion,
      version: 0,
    });
  expect(response.status).toBe(200);
  expect(response.body.playback.track.name).toBe('Song 0');
  expect(backend.start).toHaveBeenCalledTimes(1);
  const native = (
    await request(hub.app)
      .get(`/api/child/audio/state?clientId=${one}`)
      .set('Cookie', `hub_child=${first.token}`)
  ).body;
  expect(native.finishAt).toBe(50);
  expect(
    (
      await request(hub.app).post('/api/child/audio/report').set(headers).send({
        clientId: one,
        generation: native.generation,
        event: 'boundary',
        elapsed: 50,
      })
    ).status,
  ).toBe(200);
  expect(backend.start).toHaveBeenCalledTimes(2);
  expect(current.name).toBe('Song 1');
  expect(vi.mocked(backend.start).mock.calls[1][1].map((t) => t.name)).toEqual([
    'Song 1',
    'Song 2',
  ]);
  expect(
    (
      await request(hub.app).post('/api/child/audio/report').set(headers).send({
        clientId: one,
        generation: native.generation,
        event: 'boundary',
        elapsed: 50,
      })
    ).status,
  ).toBe(409);
});
