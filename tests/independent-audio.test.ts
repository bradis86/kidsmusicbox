import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createConnection, type AddressInfo } from 'node:net';
import { Store } from '../src/server/db';
import { createHub } from '../src/server/app';
import { MusicAssistantBackend } from '../src/server/adapters/music-assistant';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
const store = new Store(':memory:');
const clients = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)];
const children = clients.map(() => store.createSession('child'));
const parent = store.createSession('parent');
const ma = new MusicAssistantBackend({
  url: 'http://127.0.0.1:1',
  token: 'fixture',
});
const item = {
  ...sampleLibrary[0],
  id: 'approved',
  uri: 'spotify://playlist/approved',
  displayName: 'Approved',
  position: 0,
  artworkOverride: null,
  hiddenTrackIds: [],
};
store.approve(item);
function player() {
  const api = new MusicAssistantBackend({
      url: 'http://127.0.0.1:1',
      token: 'fixture',
    }),
    mock = new MockBackend();
  vi.spyOn(api, 'configure').mockImplementation((s) => mock.configure(s));
  vi.spyOn(api, 'state').mockImplementation(async (id) => ({
    ...(await mock.state(id)),
    playerId: id,
    simulated: false,
  }));
  vi.spyOn(api, 'tracks').mockImplementation(() =>
    mock.tracks(sampleLibrary[0]),
  );
  vi.spyOn(api, 'start').mockImplementation((...args) => mock.start(...args));
  vi.spyOn(api, 'command').mockImplementation((...args) =>
    mock.command(...args),
  );
  vi.spyOn(api, 'queueOrder').mockImplementation(async (_id, tracks) => tracks);
  return api;
}
const hub = createHub({
  store,
  backend: ma,
  musicAssistantUrl: 'http://127.0.0.1:1',
  musicAssistantToken: 'fixture',
  independentPlayback: { playerIds: ['one', 'two'], backendFactory: player },
  tickMs: 100000,
});
afterEach(async () => {
  await hub.close();
  store.close();
  vi.restoreAllMocks();
});
it('isolates actual native MPD gateways, stream generations and reports across sessions and slot reuse', async () => {
  const addresses = (await hub.listenAudio(0)) as AddressInfo[];
  const register = (i: number, claim = true) =>
    request(hub.app)
      .post('/api/child/audio/register')
      .set('Cookie', `hub_child=${children[i].token}`)
      .set('X-CSRF-Token', children[i].csrf)
      .send({ clientId: clients[i], claim });
  const state = (i: number, id = clients[i]) =>
    request(hub.app)
      .get('/api/child/audio/state?clientId=' + id)
      .set('Cookie', `hub_child=${children[i].token}`);
  const report = (i: number, generation: string, id = clients[i]) =>
    request(hub.app)
      .post('/api/child/audio/report')
      .set('Cookie', `hub_child=${children[i].token}`)
      .set('X-CSRF-Token', children[i].csrf)
      .send({ clientId: id, generation, event: 'progress', elapsed: 4 });
  expect((await register(0)).status).toBe(200);
  expect((await register(1)).status).toBe(200);
  for (const i of [0, 1]) {
    expect(
      (
        await request(hub.app)
          .post('/api/child/playback')
          .set('Cookie', `hub_child=${children[i].token}`)
          .set('X-CSRF-Token', children[i].csrf)
          .set('X-Audio-Client-Id', clients[i])
          .send({ action: 'start', collectionId: item.id })
      ).status,
    ).toBe(200);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(addresses[i].port, '127.0.0.1');
      let output = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        output += chunk;
        if (output.startsWith('OK MPD') && !output.includes('added:')) {
          output = 'added:';
          socket.write(
            `add "http://127.0.0.1:8097/flow/queue${i}/item/session/file.mp3"\nplay\n`,
          );
        } else if (output.match(/OK\n/g)?.length === 2) {
          socket.end();
          resolve();
        }
      });
    });
  }
  const first = (await state(0)).body,
    second = (await state(1)).body;
  expect(first.src).toContain(first.generation);
  expect(second.src).toContain(second.generation);
  expect(first.generation).not.toBe(second.generation);
  expect((await state(0, clients[1])).body).toBeNull();
  expect((await report(0, second.generation)).status).toBe(409);
  expect((await report(0, second.generation, clients[1])).status).toBe(409);
  expect((await report(0, first.generation)).status).toBe(200);
  expect((await report(1, second.generation)).status).toBe(200);
  expect((await register(2, false)).status).toBe(409);
  expect((await register(2)).status).toBe(409);
  expect((await state(0)).body.generation).toBe(first.generation);
  expect((await state(1)).body.generation).toBe(second.generation);
  const personal = (
    await request(hub.app)
      .get('/api/child/state')
      .set('Cookie', `hub_child=${children[0].token}`)
  ).body.personal;
  expect(
    (
      await request(hub.app)
        .post(`/api/admin/profile-devices/${personal.deviceId}/release-audio`)
        .set('Cookie', `hub_parent=${parent.token}`)
        .set('X-CSRF-Token', parent.csrf)
        .send({})
    ).status,
  ).toBe(200);
  expect((await register(2)).status).toBe(200);
  expect((await report(0, first.generation)).status).toBe(409);
  expect((await report(1, second.generation)).status).toBe(200);
});
