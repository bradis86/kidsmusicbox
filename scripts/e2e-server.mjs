import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
// Test-only transcription fixture. Browser capture still uses real MediaRecorder.
const speech = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer e2e-voice-only') {
    res.writeHead(401);
    res.end('{}');
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/readyz')
    res.end(
      JSON.stringify({ status: 'ready', model: 'e2e-fixture', device: 'test' }),
    );
  else if (req.url === '/v1/transcribe' && body.length > 100)
    res.end(
      JSON.stringify({
        api_version: 1,
        text: 'Play Sunspun.',
        no_speech: false,
        audio_duration_ms: 1000,
        language: 'en',
      }),
    );
  else {
    res.writeHead(422);
    res.end('{}');
  }
});
await new Promise((resolve) => speech.listen(0, '127.0.0.1', resolve));
const directory = mkdtempSync(join(tmpdir(), 'jukebox-e2e-'));
const child = spawn(
  process.execPath,
  ['--experimental-sqlite', 'dist/server/server/index.js'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4173',
      DATABASE_PATH: join(directory, 'test.sqlite'),
      MUSIC_BACKEND: 'mock',
      INDEPENDENT_PLAYBACK:
        process.env.E2E_INDEPENDENT_PLAYBACK === 'true' ? 'true' : 'false',
      MA_DEVICE_PLAYER_IDS: 'mock-a,mock-b',
      PARENT_SETUP_CODE: 'playwright-one-time-code',
      PARENT_PASSWORD: '',
      PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
      VOICE_ENABLED: 'true',
      VOICE_STT_URL: `http://127.0.0.1:${speech.address().port}`,
      VOICE_STT_API_KEY: 'e2e-voice-only',
      VOICE_STT_API_KEY_FILE: '',
      VOICE_STT_CA_FILE: '',
    },
  },
);
function stop() {
  child.kill('SIGTERM');
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  speech.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(code ?? 0);
});
