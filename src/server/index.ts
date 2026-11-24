import 'dotenv/config';
import { Store } from './db.js';
import { MockBackend, sampleLibrary } from './adapters/mock.js';
import { MusicAssistantBackend } from './adapters/music-assistant.js';
import { createHub } from './app.js';
import { selectBackend } from './backend-selection.js';
import { readFileSync } from 'node:fs';
import { LocalTranscriber } from './voice/transcriber.js';
const mode = process.env.MUSIC_BACKEND ?? 'mock';
if (!['mock', 'music-assistant'].includes(mode))
  throw new Error('MUSIC_BACKEND must be mock or music-assistant');
const store = new Store(process.env.DATABASE_PATH ?? 'data/hub.sqlite');
selectBackend(
  store,
  mode as 'mock' | 'music-assistant',
  process.env.MA_PLAYER_ID ?? '',
);
if (mode === 'mock') {
  const oldNames = [
    'Sunshine club',
    'Space explorers',
    'Woodland wonders',
    'Sleepy little stars',
    'Under the sea',
    'Kitchen disco',
  ];
  for (const item of store.collection()) {
    const current = sampleLibrary.find((i) => i.id === item.id);
    if (
      current &&
      ((item.provider === 'Demo library' && oldNames.includes(item.name)) ||
        (item.provider === current.provider &&
          item.name === current.name &&
          item.artwork !== current.artwork))
    ) {
      store.approve({
        ...item,
        ...current,
        displayName:
          item.displayName === item.name ? current.name : item.displayName,
      });
    }
  }
  if (store.settings().deviceName === 'My little jukebox')
    store.set('settings', { ...store.settings(), deviceName: 'My music' });
}
const backend =
  mode === 'mock'
    ? new MockBackend()
    : new MusicAssistantBackend({
        url: process.env.MA_URL ?? '',
        token: process.env.MA_TOKEN ?? '',
        expectedSchema: process.env.MA_EXPECTED_SCHEMA
          ? Number(process.env.MA_EXPECTED_SCHEMA)
          : undefined,
        commandTimeoutMs: process.env.MA_COMMAND_TIMEOUT_MS
          ? Number(process.env.MA_COMMAND_TIMEOUT_MS)
          : undefined,
      });
const hub = createHub({
  recoverRenderers: mode === 'music-assistant',
  store,
  backend,
  browserPlayerId: process.env.MA_BROWSER_PLAYER_ID,
  independentPlayback:
    process.env.INDEPENDENT_PLAYBACK === 'true'
      ? {
          playerIds: (process.env.MA_DEVICE_PLAYER_IDS ?? '')
            .split(',')
            .map((id) => id.trim()),
        }
      : undefined,
  musicAssistantUrl: process.env.MA_URL || undefined,
  musicAssistantToken: process.env.MA_TOKEN || undefined,
  parentPassword: process.env.PARENT_PASSWORD,
  setupCode: process.env.PARENT_SETUP_CODE || undefined,
  secureCookies: process.env.COOKIE_SECURE === 'true',
  publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
  automationToken: process.env.AUTOMATION_TOKEN || undefined,
  voice:
    process.env.VOICE_ENABLED === 'true'
      ? new LocalTranscriber({
          url: process.env.VOICE_STT_URL ?? '',
          key: process.env.VOICE_STT_API_KEY_FILE
            ? readFileSync(process.env.VOICE_STT_API_KEY_FILE, 'utf8').trim()
            : (process.env.VOICE_STT_API_KEY ?? ''),
          caFile: process.env.VOICE_STT_CA_FILE || undefined,
          timeoutMs: Number(process.env.VOICE_STT_TIMEOUT_MS ?? 35000),
        })
      : undefined,
  voiceMaxRecordingSeconds: Number(
    process.env.VOICE_MAX_RECORDING_SECONDS ?? 10,
  ),
});
const port = Number(process.env.PORT ?? 3000);
const server = hub.app.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(
    `Kids Music Hub: http://localhost:${port} · ${mode === 'mock' ? 'MOCK MODE — no audio' : 'Music Assistant mode'}`,
  );
  if (!store.get('passwordHash', null))
    console.log(
      `Create a parent account at /admin. One-time setup code: ${hub.setupCode}`,
    );
});
if (mode === 'music-assistant')
  await hub.listenAudio(Number(process.env.BROWSER_MPD_PORT ?? 6600));
async function shutdown() {
  server.close();
  await hub.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
