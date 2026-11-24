import { afterEach, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { BrowserAudioGateway } from '../src/server/browser-audio';
const gateway = () =>
  new BrowserAudioGateway({
    url: 'http://127.0.0.1:8095',
    token: 'private-test-token',
  });
const bridges: BrowserAudioGateway[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const b of bridges.splice(0)) b.close();
  vi.restoreAllMocks();
});
async function renderer() {
  const bridge = gateway();
  bridges.push(bridge);
  await bridge.listen(0, '127.0.0.1');
  const address = bridge.address();
  if (!address || typeof address === 'string') throw Error('No MPD address');
  const socket = connect(address.port, '127.0.0.1');
  sockets.push(socket);
  socket.setEncoding('utf8');
  await once(socket, 'data');
  async function command(line: string) {
    const reply = once(socket, 'data');
    socket.write(line + '\n');
    return String((await reply)[0]);
  }
  bridge.claim('tablet', 'session');
  return { bridge, socket, command };
}
const uri = 'http://127.0.0.1:8097/flow/session/queue/item/player.mp3';
it('implements MA MPD status, pause/resume, volume and stream ending without a browser synchronization engine', async () => {
  const { bridge, command } = await renderer();
  expect(await command(`add "${uri}"`)).toBe('OK\n');
  expect(await command('play 0')).toBe('OK\n');
  let state = bridge.view('tablet', 'session')!;
  expect(state.src).toContain('/api/child/audio/stream/');
  bridge.report(state.generation, 'progress', 12.4);
  expect(await command('status')).toContain('elapsed: 12.400');
  await command('pause 1');
  expect(bridge.view('tablet', 'session')?.status).toBe('pause');
  await command('pause 0');
  await command('setvol 42');
  state = bridge.view('tablet', 'session')!;
  expect(state.volume).toBe(42);
  expect(state.status).toBe('play');
  bridge.report(state.generation, 'ended', 60);
  expect(await command('status')).toContain('state: stop');
});
it('reports player changes through MPD idle and rejects old stream events after replacement or handover', async () => {
  const { bridge, command } = await renderer();
  await command(`add "${uri}"`);
  await command('play');
  const old = bridge.view('tablet', 'session')!;
  await command('idle'); // consumes accumulated playlist/player notifications
  expect(await command('pause 1')).toBe('OK\n');
  expect(await command('idle')).toContain('changed: player');
  bridge.claim('phone', 'another-session');
  expect(bridge.view('tablet', 'session')).toBe(null);
  expect(bridge.view('phone', 'another-session')?.src).toBe(null);
  expect(() => bridge.report(old.generation, 'ended', 60)).toThrow('replaced');
  await command(`add "${uri}"`);
  await command('play');
  expect(bridge.view('phone', 'another-session')?.generation).not.toBe(
    old.generation,
  );
});
it.each([
  'http://evil.example/track.mp3',
  'http://127.0.0.1:8097/preview',
  'http://user:secret@127.0.0.1:8097/single/a/b/c/d.mp3',
  'http://127.0.0.1:8095/single/a/b/c/d.mp3',
])('refuses arbitrary upstream URLs: %s', async (uri) => {
  const { command } = await renderer();
  expect(await command(`add "${uri}"`)).toContain('ACK');
});
it('proxies bounded streaming with range/auth headers, validates codec, and rejects revoked stream access', async () => {
  const { bridge, command } = await renderer();
  await command(`add "${uri}"`);
  await command('play');
  const generation = bridge.view('tablet', 'session')!.generation;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-range': 'bytes 0-2/3',
        'accept-ranges': 'bytes',
      },
    }),
  );
  const app = express();
  let authorized = true;
  app.get('/audio', async (req, res, next) => {
    try {
      await bridge.stream(generation, req.get('range'), res, () => authorized);
    } catch (e) {
      next(e);
    }
  });
  const response = await request(app).get('/audio').set('Range', 'bytes=0-2');
  expect(response.status).toBe(206);
  expect(response.headers['content-range']).toBe('bytes 0-2/3');
  expect(fetcher).toHaveBeenCalledWith(
    uri,
    expect.objectContaining({
      redirect: 'error',
      headers: {
        Range: 'bytes=0-2',
        Authorization: 'Bearer private-test-token',
      },
    }),
  );
  authorized = false;
  expect((await request(app).get('/audio')).status).toBe(403);
  expect(fetcher).toHaveBeenCalledTimes(1);
  authorized = true;
  fetcher.mockResolvedValue(
    new Response('bad', { headers: { 'content-type': 'text/html' } }),
  );
  expect((await request(app).get('/audio')).status).toBe(502);
});
it('cancels an in-flight upstream when ownership changes', async () => {
  const { bridge, command } = await renderer();
  await command(`add "${uri}"`);
  await command('play');
  const generation = bridge.view('tablet', 'session')!.generation;
  let signal: AbortSignal | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
      { headers: { 'content-type': 'audio/mpeg' } },
    );
  });
  const app = express();
  app.get('/audio', async (_req, res) =>
    bridge.stream(generation, undefined, res, () => true),
  );
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No HTTP address');
  const { get } = await import('node:http');
  await new Promise<void>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${address.port}/audio`, (res) => {
      res.once('data', () => {
        bridge.claim('phone', 'other');
        expect(signal?.aborted).toBe(true);
        res.destroy();
        resolve();
      });
    });
    req.on('error', reject);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('ignores a late noidle after a change completed idle, preserving the next status response', async () => {
  const { bridge, socket, command } = await renderer();
  await command('idle'); // consume the initial claim notification
  const idleReply = once(socket, 'data');
  socket.write('idle\n');
  // Force a full network round trip on another connection so idle is pending.
  const address = bridge.address();
  if (!address || typeof address === 'string') throw Error('Missing address');
  const peer = connect(address.port, '127.0.0.1');
  sockets.push(peer);
  await once(peer, 'data');
  bridge.claim('phone', 'new-session');
  expect(String((await idleReply)[0])).toContain('changed: player');
  const reply = await command('noidle\nstatus');
  expect(reply).toMatch(/^volume:/);
  expect(reply.match(/OK\n/g)).toHaveLength(1);
});
it('cancels a pending idle once and then handles the pipelined status normally', async () => {
  const { socket, command } = await renderer();
  await command('idle');
  const reply = new Promise<string>((resolve) => {
    let data = '';
    const receive = (chunk: Buffer) => {
      data += String(chunk);
      if (data.match(/OK\n/g)?.length === 2) {
        socket.off('data', receive);
        resolve(data);
      }
    };
    socket.on('data', receive);
  });
  socket.write('idle\nnoidle\nstatus\n');
  const data = await reply;
  expect(data).toMatch(/^OK\nvolume:/);
  expect(data.match(/OK\n/g)).toHaveLength(2);
});

it('detects both real MA connections and notices a closed command socket', async () => {
  const { bridge, command } = await renderer();
  expect(bridge.connected()).toBe(false);
  const address = bridge.address();
  if (!address || typeof address === 'string') throw Error('No address');
  const peer = connect(address.port, '127.0.0.1');
  sockets.push(peer);
  await once(peer, 'data');
  expect(bridge.connected()).toBe(true);
  expect(bridge.activeReceiver()).toBe(false);
  await command(`add "${uri}"`);
  await command('play');
  expect(bridge.activeReceiver()).toBe(true);
  peer.destroy();
  await vi.waitFor(() => expect(bridge.connected()).toBe(false));
  bridge.stop();
  expect(bridge.activeReceiver()).toBe(false);
});
