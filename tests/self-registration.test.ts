import { beforeEach, afterEach, it, expect } from 'vitest';
import request from 'supertest';
import { Store } from '../src/server/db';
import { Profiles } from '../src/server/profiles';
import { MockBackend } from '../src/server/adapters/mock';
import { createHub } from '../src/server/app';
let store: Store, profiles: Profiles, hub: ReturnType<typeof createHub>;
beforeEach(() => {
  store = new Store(':memory:');
  profiles = new Profiles(store);
  hub = createHub({
    store,
    backend: new MockBackend(),
    parentPassword: 'a secure parent password',
    publicOrigin: 'https://music.test',
    secureCookies: true,
    independentPlayback: { playerIds: ['a', 'b'] },
    tickMs: 100000,
  });
});
afterEach(async () => {
  await hub.close();
  store.close();
});
const pair = (body: object = {}) =>
  request(hub.app)
    .post('/api/child/pair')
    .set('Origin', 'https://music.test')
    .send(body);
const cookie = (r: { headers: Record<string, any> }) =>
  (r.headers['set-cookie'] as string[])
    .find((c) => c.startsWith('hub_child='))!
    .split(';')[0];
it('lets an unpaired browser create only a child pairing with a name and no audio reservation', async () => {
  profiles.create('Adult', '⭐', 'adult');
  const result = await pair({ name: 'Bedroom tablet' });
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({
    authenticated: true,
    personal: { profile: { kind: 'child' } },
  });
  expect(String(result.headers['set-cookie'])).toMatch(/HttpOnly/);
  expect(String(result.headers['set-cookie'])).toMatch(/SameSite=Strict/);
  expect(String(result.headers['set-cookie'])).toMatch(/Secure/);
  expect(String(result.headers['set-cookie'])).not.toContain('hub_parent=');
  const c = cookie(result),
    s = await request(hub.app).get('/api/child/state').set('Cookie', c);
  expect(s.body.device.name).toBe('Bedroom tablet');
  expect(s.body.playback.track).toBeNull();
  expect(store.db.prepare('SELECT * FROM playback_slots').all()).toEqual([]);
  expect(
    (await request(hub.app).get('/api/admin/settings').set('Cookie', c)).status,
  ).toBe(401);
  const p = s.body.personal;
  expect(
    (
      await request(hub.app)
        .get('/api/child/catalogue/search?search=Orbit Lanterns')
        .set('Cookie', c)
        .set('X-Child-Profile', p.profile.id)
        .set('X-Child-Device', p.deviceId)
        .set('X-Profile-Revision', String(p.revision))
    ).status,
  ).toBe(403);
});
it('reuses an existing pairing without resetting its adult profile, name, revision or cookie', async () => {
  const first = await pair({ name: 'Phone' }),
    c = cookie(first),
    id = first.body.personal.deviceId;
  const adult = profiles.create('Dad', '⭐', 'adult');
  profiles.assign(id, adult.id);
  const current = profiles.devices().find((d) => d.id === id)!;
  const second = await pair({ name: 'Replace' }).set('Cookie', c);
  expect(second.status).toBe(200);
  expect(second.body.personal).toMatchObject({
    deviceId: id,
    profile: { id: adult.id, kind: 'adult' },
    revision: current.revision,
  });
  expect(second.body.csrf).toBe(first.body.csrf);
  expect(second.headers['set-cookie']).toBeUndefined();
  expect(profiles.devices()).toHaveLength(1);
  expect(profiles.devices()[0].name).toBe('Phone');
});
it('rejects cross-site setup and non-JSON submissions before creating any session', async () => {
  expect((await pair().set('Origin', 'https://evil.example')).status).toBe(403);
  expect((await pair().set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
  expect(
    (
      await request(hub.app)
        .post('/api/child/pair')
        .type('form')
        .send({ name: 'Attack' })
    ).status,
  ).toBe(415);
  expect(profiles.devices()).toHaveLength(0);
});
it('never accepts requested adult access, another profile, or invalid names', async () => {
  for (const body of [
    { role: 'parent' },
    { kind: 'adult' },
    { profileId: 'child-default' },
    { name: ' ' },
    { name: 'x'.repeat(61) },
  ])
    expect((await pair(body)).status).toBe(422);
  expect(profiles.devices()).toHaveLength(0);
});
it('does not self-register before a parent has completed initial setup', async () => {
  store.set('passwordHash', null);
  const r = await pair();
  expect(r.status).toBe(409);
  expect(r.headers['set-cookie']).toBeUndefined();
});
it('starts new pairings on a child even if an earlier profile was made adult', async () => {
  const child = profiles.create('Child', '🚀');
  profiles.update('child-default', 'Dad', '⭐', 'adult');
  expect((await pair()).body.personal.profile.id).toBe(child.id);
});
it('bounds creation attempts while allowing an already registered browser to reopen', async () => {
  const first = await pair();
  for (let i = 0; i < 19; i++) expect((await pair()).status).toBe(201);
  expect((await pair()).status).toBe(429);
  expect((await pair().set('Cookie', cookie(first))).status).toBe(200);
  expect(profiles.devices()).toHaveLength(20);
});
