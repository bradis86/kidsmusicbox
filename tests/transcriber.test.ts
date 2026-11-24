import { beforeEach, afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { LocalTranscriber } from '../src/server/voice/transcriber';
let server: Server, service: LocalTranscriber, url: string;
let status = 200,
  payload: unknown,
  captured = '',
  auth = '',
  calls = 0,
  stall = false;
beforeEach(async () => {
  status = 200;
  stall = false;
  captured = '';
  calls = 0;
  payload = {
    api_version: 1,
    text: 'Play Sunspun.',
    language: 'en',
    no_speech: false,
    audio_duration_ms: 1200,
  };
  server = createServer(async (req, res) => {
    calls++;
    auth = req.headers.authorization ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = Buffer.concat(chunks).toString();
    if (stall) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No test port');
  url = `http://127.0.0.1:${address.port}`;
  service = new LocalTranscriber({ url, key: 'server-only-fixture-key' });
});
afterEach(async () => {
  service.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('sends bounded multipart audio with server-side authentication and no vocabulary hints', async () => {
  expect(
    await service.transcribe(Buffer.from('fixture-audio'), 'audio/webm'),
  ).toEqual({ text: 'Play Sunspun.', noSpeech: false, durationMs: 1200 });
  expect(auth).toBe('Bearer server-only-fixture-key');
  expect(captured).toContain('name="file"');
  expect(captured).toContain('fixture-audio');
  expect(captured).not.toContain('name="context"');
  expect(captured).not.toContain('server-only-fixture-key');
  expect(calls).toBe(1);
});
it('sanitizes upstream errors and respects silence and response schema', async () => {
  status = 429;
  payload = { error: { message: 'private upstream details' } };
  await expect(
    service.transcribe(Buffer.from('x'), 'audio/wav'),
  ).rejects.toMatchObject({
    status: 429,
    message: expect.not.stringContaining('private upstream'),
  });
  status = 200;
  payload = {
    api_version: 1,
    text: 'hallucinated text',
    language: 'en',
    no_speech: true,
    audio_duration_ms: 1000,
  };
  expect(await service.transcribe(Buffer.from('x'), 'audio/wav')).toMatchObject(
    { text: '', noSpeech: true },
  );
  payload = { api_version: 99, text: 'Sunspun' };
  await expect(
    service.transcribe(Buffer.from('x'), 'audio/wav'),
  ).rejects.toMatchObject({ status: 502 });
});
it('cancels the upstream request without retrying', async () => {
  stall = true;
  const controller = new AbortController();
  const result = service.transcribe(
    Buffer.from('x'),
    'audio/wav',
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({ status: 504 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await rejected;
  expect(calls).toBe(1);
});
it('requires verified HTTPS outside loopback and rejects embedded credentials or invalid configuration', () => {
  expect(
    () => new LocalTranscriber({ url: 'http://192.0.2.30:8443', key: 'test' }),
  ).toThrow('HTTPS');
  expect(
    () =>
      new LocalTranscriber({
        url: 'https://user:password@example.com',
        key: 'test',
      }),
  ).toThrow('embedded credentials');
  expect(() => new LocalTranscriber({ url, key: 'bad\nkey' })).toThrow(
    'API key',
  );
  expect(
    () => new LocalTranscriber({ url, key: 'test', timeoutMs: 100 }),
  ).toThrow('TIMEOUT');
});
