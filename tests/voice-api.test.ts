import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../src/server/db';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
import { defaultSettings } from '../src/shared/types';
import { BackendError } from '../src/server/adapters/backend';
let store: Store, backend: MockBackend, hub: ReturnType<typeof createHub>;
let parent: ReturnType<typeof request.agent>,
  csrf = '',
  cookie = '',
  childCsrf = '';
const speech = { transcribe: vi.fn(), ready: vi.fn() };
beforeEach(async () => {
  speech.transcribe.mockReset().mockResolvedValue({
    text: 'Play Sunspun.',
    noSpeech: false,
    durationMs: 1000,
  });
  speech.ready
    .mockReset()
    .mockResolvedValue({ ready: true, model: 'base.en', device: 'cpu' });
  store = new Store(':memory:');
  backend = new MockBackend();
  hub = createHub({
    store,
    backend,
    voice: speech,
    setupCode: 'voice-setup',
    tickMs: 100000,
  });
  parent = request.agent(hub.app);
  csrf = (
    await parent.post('/api/auth/setup').send({
      setupCode: 'voice-setup',
      password: 'a secure voice test password',
    })
  ).body.csrf;
  const pair = await parent
    .post('/api/admin/pair')
    .set('X-CSRF-Token', csrf)
    .send({});
  childCsrf = pair.body.csrf;
  cookie = pair.headers['set-cookie'][0].split(';')[0];
  store.approve({
    ...sampleLibrary[0],
    displayName: sampleLibrary[0].name,
    position: 0,
    artworkOverride: null,
    hiddenTrackIds: [],
  });
});
afterEach(async () => {
  await hub.close();
  store.close();
});
const capture = () =>
  request(hub.app)
    .post('/api/child/voice/search')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', childCsrf)
    .set('Content-Type', 'audio/wav')
    .send(Buffer.from('test-audio'));
const match = (text: string) =>
  request(hub.app)
    .post('/api/child/voice/matches')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', childCsrf)
    .send({ text });
it('authenticates voice, enforces CSRF and exposes no automatic playback or arbitrary catalogue lookup', async () => {
  expect(
    (await request(hub.app).post('/api/child/voice/search').send({})).status,
  ).toBe(401);
  expect(
    (
      await request(hub.app)
        .post('/api/child/voice/search')
        .set('Cookie', cookie)
        .send({})
    ).status,
  ).toBe(403);
  const library = vi.spyOn(backend, 'library');
  const result = await capture();
  expect(result.status).toBe(200);
  expect(result.body.matches.map((m: { name: string }) => m.name)).toEqual([
    'Sunspun',
  ]);
  expect(hub.snapshot().playback.status).toBe('idle');
  expect(library).not.toHaveBeenCalled();
  expect((await match('Orbit Lanterns')).body.matches).toEqual([]);
});
it('rechecks hidden tracks and removals even when the approved metadata is cached', async () => {
  expect((await capture()).body.matches).toHaveLength(1);
  const track = (await backend.tracks(store.collection()[0]))[0];
  store.approve({ ...store.collection()[0], hiddenTrackIds: [track.id] });
  expect((await match('Sunspun')).body.matches).toEqual([]);
  await parent
    .delete(`/api/admin/collection/${sampleLibrary[0].id}`)
    .set('X-CSRF-Token', csrf);
  expect((await match('Sunbeams')).body.matches).toEqual([]);
});
it('persists the parent voice switch and reports voice-only service failures', async () => {
  speech.ready.mockRejectedValue(new Error('private upstream error'));
  const status = await parent.get('/api/admin/voice');
  expect(status.body).toMatchObject({ configured: true, ready: false });
  expect(JSON.stringify(status.body)).not.toContain('private upstream');
  await parent
    .put('/api/admin/settings')
    .set('X-CSRF-Token', csrf)
    .send({ ...defaultSettings, voiceSearchEnabled: false });
  expect(hub.snapshot('child').voice.enabled).toBe(false);
  expect((await capture()).status).toBe(403);
  expect(speech.transcribe).not.toHaveBeenCalled();
});
it('returns silence without querying track metadata and rejects malformed or excessive uploads', async () => {
  speech.transcribe.mockResolvedValue({
    text: '',
    noSpeech: true,
    durationMs: 1000,
  });
  const tracks = vi.spyOn(backend, 'tracks');
  expect((await capture()).body).toMatchObject({
    text: '',
    noSpeech: true,
    matches: [],
  });
  expect(tracks).not.toHaveBeenCalled();
  expect(
    (
      await request(hub.app)
        .post('/api/child/voice/search')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', childCsrf)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('bad'))
    ).status,
  ).toBe(415);
  expect(
    (
      await request(hub.app)
        .post('/api/child/voice/search')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', childCsrf)
        .set('Content-Type', 'audio/wav')
        .send(Buffer.alloc(5 * 1024 * 1024 + 1))
    ).status,
  ).toBe(413);
  speech.transcribe.mockResolvedValue({
    text: 'Sunspun',
    noSpeech: false,
    durationMs: 14000,
  });
  expect((await capture()).status).toBe(422);
});
it('bounds concurrency and recovers after upstream failure without affecting playback controls', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  speech.transcribe.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const first = capture().then((result) => result);
  await started;
  try {
    const second = await capture();
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('1');
  } finally {
    release({ text: 'Sunspun', noSpeech: false, durationMs: 1000 });
  }
  expect((await first).status).toBe(200);
  speech.transcribe.mockRejectedValueOnce(
    new BackendError('Voice took too long', 504),
  );
  expect((await capture()).status).toBe(504);
  expect((await capture()).status).toBe(200);
  expect(
    (
      await request(hub.app)
        .post('/api/child/playback')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', childCsrf)
        .send({ action: 'volume', volume: 20 })
    ).status,
  ).toBe(200);
});
