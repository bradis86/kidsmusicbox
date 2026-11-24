import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../src/server/db';
import { Profiles } from '../src/server/profiles';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
import type { HubState } from '../src/shared/types';
let store: Store, profiles: Profiles, hub: ReturnType<typeof createHub>;
let parent: ReturnType<Store['createSession']>,
  a: typeof parent,
  b: typeof parent,
  third: typeof parent;
let backends: MockBackend[];
function makeHub(factory = () => new MockBackend()) {
  return createHub({
    store,
    backend: new MockBackend(),
    tickMs: 100000,
    independentPlayback: {
      playerIds: ['target-a', 'target-b'],
      backendFactory: () => {
        const backend = factory();
        backends.push(backend);
        return backend;
      },
    },
  });
}
beforeEach(() => {
  store = new Store(':memory:');
  profiles = new Profiles(store);
  backends = [];
  parent = store.createSession('parent');
  a = store.createSession('child');
  b = store.createSession('child');
  third = store.createSession('child');
  const other = profiles.create('Other child', '🦊');
  profiles.assign(profiles.device(b.token).id, other.id);
  for (const [position, item] of sampleLibrary.slice(0, 2).entries())
    store.approve({
      ...item,
      displayName: item.name,
      position,
      artworkOverride: null,
      hiddenTrackIds: [],
    });
  hub = makeHub();
});
afterEach(async () => {
  await hub.close();
  store.close();
});
async function state(s = a): Promise<HubState> {
  return (
    await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', `hub_child=${s.token}`)
  ).body;
}
async function mutate(
  path: string,
  body: object,
  s = a,
  method: 'post' | 'put' = 'post',
) {
  const p = (await state(s)).personal!;
  return request(hub.app)
    [method](path)
    .set('Cookie', `hub_child=${s.token}`)
    .set('X-CSRF-Token', s.csrf)
    .set('X-Child-Device', p.deviceId)
    .set('X-Child-Profile', p.profile.id)
    .set('X-Profile-Revision', String(p.revision))
    .send(body);
}
function admin(
  path: string,
  body = {},
  method: 'post' | 'patch' | 'delete' = 'post',
) {
  return request(hub.app)
    [method](path)
    .set('Cookie', `hub_parent=${parent.token}`)
    .set('X-CSRF-Token', parent.csrf)
    .send(body);
}
const play = (s = a, id = sampleLibrary[0].id) =>
  mutate('/api/child/playback', { action: 'start', collectionId: id }, s);
const command = (action: string, s = a, extra = {}) =>
  mutate('/api/child/playback', { action, ...extra }, s);
async function react(reaction: string, s = a) {
  const p = (await state(s)).personal!;
  return mutate(
    '/api/child/reaction',
    {
      reaction,
      version: p.preference?.version ?? 0,
      trackVersion: p.trackVersion,
    },
    s,
    'put',
  );
}
it('plays two different queues with independent volume, transport, metadata and heartbeat', async () => {
  expect((await play()).status).toBe(200);
  expect((await play(b, sampleLibrary[1].id)).status).toBe(200);
  expect((await state()).playback.track?.name).toBe('Sunspun');
  expect((await state(b)).playback.track?.name).toBe('Comet Parade');
  await command('volume', a, { volume: 12 });
  await command('pause');
  await command('next', b);
  expect((await state()).playback.status).toBe('paused');
  expect((await state()).playback.volume).toBe(12);
  expect((await state(b)).playback.status).toBe('playing');
  expect((await state(b)).playback.track?.name).toBe('Window Lights');
  expect((await state(b)).playback.volume).toBe(25);
  await mutate('/api/child/heartbeat', { screenOff: false });
  expect((await state()).device.online).toBe(true);
  expect((await state(b)).device.online).toBe(false);
  expect(backends).toHaveLength(2);
});
it('keeps the chosen volume and mute across song/album selections while respecting startup and parent limits', async () => {
  store.set('settings', {
    ...store.settings(),
    startupVolume: 35,
    maxVolume: 60,
  });
  expect((await play()).status).toBe(200);
  expect((await state()).playback.volume).toBe(35);
  await command('volume', a, { volume: 12 });
  const tracks = await backends[0].tracks(sampleLibrary[0]);
  expect(
    (
      await mutate('/api/child/playback', {
        action: 'start',
        collectionId: sampleLibrary[0].id,
        trackId: tracks[1].id,
      })
    ).status,
  ).toBe(200);
  expect((await state()).playback.volume).toBe(12);
  expect((await play(a, sampleLibrary[1].id)).status).toBe(200);
  expect((await state()).playback.volume).toBe(12);
  await command('next');
  await command('previous');
  expect((await state()).playback.volume).toBe(12);
  await command('volume', a, { volume: 0 });
  await command('stop');
  expect((await play()).status).toBe(200);
  expect((await state()).playback.volume).toBe(0);
  expect((await play(b)).status).toBe(200);
  expect((await state(b)).playback.volume).toBe(35);
  await command('volume', a, { volume: 59 });
  store.set('settings', { ...store.settings(), maxVolume: 20 });
  expect((await play(a, sampleLibrary[1].id)).status).toBe(200);
  expect((await state()).playback.volume).toBe(20);
});
it('opening or reconnecting a third player cannot steal a slot, and parents can release one', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  expect((await state(third)).playback.track).toBeNull();
  expect(store.db.prepare('SELECT * FROM playback_slots').all()).toHaveLength(
    2,
  );
  expect((await play(third)).status).toBe(409);
  expect((await state()).playback.status).toBe('playing');
  expect((await state(b)).playback.status).toBe('playing');
  const id = (await state()).personal!.deviceId;
  expect(
    (await admin(`/api/admin/profile-devices/${id}/release-audio`)).status,
  ).toBe(200);
  expect((await play(third)).status).toBe(200);
  expect((await command('pause')).status).toBe(409);
  expect((await state(b)).playback.track?.name).toBe('Comet Parade');
});
it('likes and blocks belong to the playing child and do not change the other child’s queue', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  expect((await react('favourite')).status).toBe(200);
  expect((await state()).personal?.preference?.reaction).toBe('favourite');
  expect((await state(b)).personal?.preference).toBeNull();
  expect((await react('blocked')).status).toBe(200);
  expect((await state()).playback.track?.name).toBe('Sunspun');
  await command('next');
  expect((await state()).playback.track?.name).toBe('Ribbon Steps');
  expect((await state(b)).playback.track?.name).toBe('Comet Parade');
});
it('a slow start on one player does not serialize another player behind it', async () => {
  await hub.close();
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let index = 0;
  hub = makeHub(() => {
    const backend = new MockBackend();
    if (index++ === 0) {
      const start = backend.start.bind(backend);
      vi.spyOn(backend, 'start').mockImplementation(async (...args) => {
        entered();
        await gate;
        return start(...args);
      });
    }
    return backend;
  });
  const slow = play().then((r) => r);
  await started;
  try {
    expect((await play(b, sampleLibrary[1].id)).status).toBe(200);
    expect((await state(b)).playback.status).toBe('playing');
  } finally {
    finish();
  }
  expect((await slow).status).toBe(200);
});
it('parent reassignment stops only the assigned player and invalidates stale child actions', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  const old = (await state()).personal!;
  expect(
    (
      await admin(
        `/api/admin/profile-devices/${old.deviceId}`,
        { profileId: (await state(b)).personal!.profile.id, name: 'Kitchen' },
        'patch',
      )
    ).status,
  ).toBe(200);
  expect((await state()).playback.status).toBe('idle');
  expect((await state(b)).playback.status).toBe('playing');
  const stale = await request(hub.app)
    .put('/api/child/reaction')
    .set('Cookie', `hub_child=${a.token}`)
    .set('X-CSRF-Token', a.csrf)
    .set('X-Child-Profile', old.profile.id)
    .set('X-Profile-Revision', String(old.revision))
    .send({ reaction: 'blocked', version: 0, trackVersion: old.trackVersion });
  expect(stale.status).toBe(409);
});
it('approval removal silences every affected queue while unrelated queues continue', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  expect(
    (await admin('/api/admin/collection/' + sampleLibrary[0].id, {}, 'delete'))
      .status,
  ).toBe(200);
  expect((await state()).playback.track).toBeNull();
  expect((await state()).playback.status).toBe('idle');
  expect((await state(b)).playback.status).toBe('playing');
});
it('pairing revocation stops both players and releases their slots', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  expect((await admin('/api/admin/revoke-devices')).status).toBe(200);
  expect(store.db.prepare('SELECT * FROM playback_slots').all()).toHaveLength(
    0,
  );
  for (const backend of backends)
    expect((await backend.state('')).status).toBe('idle');
});
it('hub restart retains target assignment and favourites without starting playback', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  await react('favourite');
  const slots = store.db
    .prepare('SELECT * FROM playback_slots ORDER BY slot')
    .all();
  await hub.close();
  backends = [];
  hub = makeHub();
  await hub.refresh();
  expect(
    store.db.prepare('SELECT * FROM playback_slots ORDER BY slot').all(),
  ).toEqual(slots);
  expect((await state()).personal?.profile.id).toBe('child-default');
  expect((await state()).playback.status).toBe('idle');
  expect((await state()).playback.track).toBeNull();
  expect(profiles.list('child-default')[0].reaction).toBe('favourite');
});
it('revoking approval during a slow start invalidates its stream intent before the command finishes', async () => {
  await hub.close();
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let index = 0;
  hub = makeHub(() => {
    const backend = new MockBackend();
    if (index++ === 0) {
      const start = backend.start.bind(backend);
      vi.spyOn(backend, 'start').mockImplementation(async (...args) => {
        entered();
        await gate;
        return start(...args);
      });
    }
    return backend;
  });
  const slow = play().then((r) => r);
  await started;
  await play(b, sampleLibrary[1].id);
  const id = (await state()).personal!.deviceId;
  const removal = admin(
    '/api/admin/collection/' + sampleLibrary[0].id,
    {},
    'delete',
  ).then((r) => r);
  try {
    await vi.waitFor(() =>
      expect(
        store.collection().some((item) => item.id === sampleLibrary[0].id),
      ).toBe(false),
    );
    expect(
      store.get(`playback:${id}:activeCollection`, 'not-cleared'),
    ).toBeNull();
    expect((await state(b)).playback.status).toBe('playing');
  } finally {
    finish();
  }
  await slow;
  expect((await removal).status).toBe(200);
  expect((await state()).playback.track).toBeNull();
  expect((await state()).playback.status).toBe('idle');
});
it('expired pairings are stopped and their targets become reusable without affecting another player', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  store.db
    .prepare(
      'UPDATE sessions SET expires=0 WHERE token_hash=(SELECT session_hash FROM child_devices WHERE id=?)',
    )
    .run((await state()).personal!.deviceId);
  store.createSession('child'); // ordinary expiry cleanup cascades the slot binding
  await hub.refresh();
  expect((await play(third)).status).toBe(200);
  expect((await state(b)).playback.status).toBe('playing');
});
it('publishes a changed preference version to another device using the same child without changing its track', async () => {
  profiles.assign(
    profiles.device(b.token).id,
    profiles.device(a.token).profile_id,
  );
  await play();
  await play(b, sampleLibrary[1].id);
  const previous = (await state(b)).personal!.preferencesVersion;
  await react('favourite');
  const next = await state(b);
  expect(next.personal!.preferencesVersion).not.toBe(previous);
  expect(next.playback.track?.name).toBe('Comet Parade');
  expect(next.personal!.preference).toBeNull();
  const favourites = await request(hub.app)
    .get('/api/child/collection/__favourites__')
    .set('Cookie', `hub_child=${b.token}`);
  expect(favourites.body.tracks.map((t: { name: string }) => t.name)).toEqual([
    'Sunspun',
  ]);
});
it('returns the parent-assigned display name and updates it without interrupting playback', async () => {
  await play();
  const id = (await state()).personal!.deviceId;
  expect(
    (
      await admin(
        `/api/admin/profile-devices/${id}`,
        { name: 'Kitchen tablet', profileId: 'child-default' },
        'patch',
      )
    ).status,
  ).toBe(200);
  expect((await state()).device.name).toBe('Kitchen tablet');
  expect((await state()).personal!.profile.name).toBe('My music');
  expect((await state()).playback.status).toBe('playing');
  expect((await state(b)).device.name).not.toBe('Kitchen tablet');
});
it('persists each display’s shuffle and repeat choices without restarting or changing another player', async () => {
  await play();
  await play(b, sampleLibrary[1].id);
  await command('pause');
  const name = (await state()).playback.track?.name;
  expect((await command('shuffle', a, { enabled: true })).status).toBe(200);
  expect((await command('repeat', a, { enabled: true })).status).toBe(200);
  expect((await state()).playback).toMatchObject({
    status: 'paused',
    shuffle: true,
    repeat: true,
  });
  expect((await state()).playback.track?.name).toBe(name);
  expect((await state(b)).playback).toMatchObject({
    status: 'playing',
    shuffle: false,
    repeat: false,
  });
  expect(store.settings().shuffle).toBe(false);
  expect(store.settings().repeat).toBe(false);
  await hub.close();
  hub = makeHub();
  await play();
  expect((await state()).playback).toMatchObject({
    shuffle: true,
    repeat: true,
  });
  expect((await command('repeat', a, { enabled: false })).status).toBe(200);
  expect((await command('shuffle', a, { enabled: false })).status).toBe(200);
  expect((await state()).playback).toMatchObject({
    shuffle: false,
    repeat: false,
  });
});
it('repeat wraps the queue and failed mode changes are not persisted', async () => {
  const tracks = await new MockBackend().tracks(sampleLibrary[0]);
  await mutate('/api/child/playback', {
    action: 'start',
    collectionId: sampleLibrary[0].id,
    trackId: tracks.at(-1)!.id,
  });
  await command('repeat', a, { enabled: true });
  await command('next');
  expect((await state()).playback.track?.name).toBe('Sunspun');
  vi.spyOn(backends[0], 'command').mockRejectedValueOnce(
    new Error('fixture failure'),
  );
  expect((await command('shuffle', a, { enabled: true })).status).toBe(500);
  expect((await state()).settings.shuffle).toBe(false);
  expect((await command('repeat', a, { enabled: 'true' })).status).toBe(422);
});

it('delivers the morning screen transition without an assigned audio slot', async () => {
  await hub.close();
  let now = new Date('2026-11-11T22:59:00Z');
  store.set('settings', { ...store.settings(), screenScheduleEnabled: true });
  hub = createHub({
    store,
    backend: new MockBackend(),
    independentPlayback: { playerIds: ['target-a', 'target-b'] },
    now: () => now,
    tickMs: 10,
  });
  const server = hub.app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((res) => server.once('listening', res));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/child/events`,
      {
        headers: { Cookie: `hub_child=${a.token}` },
        signal: AbortSignal.timeout(2_000),
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    async function nextState() {
      let event = '';
      while (!event.endsWith('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream closed before state arrived');
        event += decoder.decode(value, { stream: true });
      }
      return JSON.parse(
        event
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6),
      ) as HubState;
    }
    expect((await nextState()).device).toMatchObject({
      screenOff: true,
      screenWakeAt: Date.parse('2026-11-11T23:00:00Z'),
    });
    now = new Date('2026-11-11T23:00:00Z');
    expect((await nextState()).device.screenOff).toBe(false);
    await reader.cancel();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
