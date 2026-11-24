import { describe, it, expect } from 'vitest';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
import { defaultSettings, type ApprovedItem } from '../src/shared/types';
const item: ApprovedItem = {
  ...sampleLibrary[0],
  displayName: sampleLibrary[0].name,
  position: 0,
  artworkOverride: null,
  hiddenTrackIds: [],
};
describe('mock playback engine', () => {
  it('progresses, pauses, resumes, skips, and stops at queue end', async () => {
    let now = 0;
    const b = new MockBackend(() => now);
    const tracks = await b.tracks(item);
    await b.start(item, tracks, defaultSettings);
    expect((await b.state('mock-lenovo')).status).toBe('playing');
    now = 10_000;
    expect((await b.state('mock-lenovo')).elapsed).toBe(10);
    await b.command({ action: 'pause' }, defaultSettings);
    now = 20_000;
    expect((await b.state('mock-lenovo')).elapsed).toBe(10);
    await b.command({ action: 'play' }, defaultSettings);
    now = (tracks[0].duration + 11) * 1000;
    expect((await b.state('mock-lenovo')).track?.id).toBe(tracks[1].id);
    await b.command({ action: 'previous' }, defaultSettings);
    expect((await b.state('mock-lenovo')).track?.id).toBe(tracks[0].id);
    await b.command({ action: 'next' }, defaultSettings);
    await b.command({ action: 'next' }, defaultSettings);
    now += tracks.reduce((sum, t) => sum + t.duration, 0) * 1000;
    expect((await b.state('mock-lenovo')).status).toBe('idle');
  });
  it('loops an approved queue and clamps volume', async () => {
    let now = 0;
    const b = new MockBackend(() => now);
    const tracks = await b.tracks(item);
    const s = {
      ...defaultSettings,
      repeat: true,
      maxVolume: 35,
      startupVolume: 20,
    };
    await b.start(item, tracks, s);
    now = (tracks.reduce((sum, t) => sum + t.duration, 0) + 5) * 1000;
    const state = await b.state('mock-lenovo');
    expect(state.track?.id).toBe(tracks[0].id);
    expect(state.elapsed).toBe(5);
    await b.command({ action: 'volume', volume: 99 }, s);
    expect((await b.state('mock-lenovo')).volume).toBe(35);
  });
  it('rejects commands on disconnect and recovers paused', async () => {
    const b = new MockBackend();
    await b.start(item, await b.tracks(item), defaultSettings);
    b.setAvailable(false);
    expect((await b.state('mock-lenovo')).status).toBe('unavailable');
    await expect(
      b.command({ action: 'play' }, defaultSettings),
    ).rejects.toThrow('disconnected');
    b.setAvailable(true);
    expect((await b.state('mock-lenovo')).status).toBe('paused');
    await b.command({ action: 'play' }, defaultSettings);
    expect((await b.state('mock-lenovo')).status).toBe('playing');
  });
  it('does not include audio files or claim actual audio', async () => {
    const b = new MockBackend();
    expect((await b.state('mock-lenovo')).simulated).toBe(true);
    expect((await b.providers())[0].name).toContain('no audio');
  });
});

describe('individual mock track selection', () => {
  it('starts at the chosen song and progresses to its following track', async () => {
    let now = 0;
    const b = new MockBackend(() => now);
    const tracks = await b.tracks(item);
    await b.start(item, tracks, defaultSettings, tracks[1].id);
    expect((await b.state('mock-lenovo')).track?.name).toBe(tracks[1].name);
    now = (tracks[1].duration + 1) * 1000;
    expect((await b.state('mock-lenovo')).track?.name).toBe(tracks[2].name);
  });
});

it('keeps the chosen song first and retains the full shuffled queue', async () => {
  const b = new MockBackend();
  const tracks = await b.tracks(item);
  await b.start(
    item,
    tracks,
    { ...defaultSettings, shuffle: true },
    tracks[2].id,
  );
  expect((await b.state('mock-lenovo')).track?.id).toBe(tracks[2].id);
  const heard = new Set<string>();
  for (let i = 0; i < tracks.length; i++) {
    heard.add((await b.state('mock-lenovo')).track!.id);
    await b.command({ action: 'next' }, defaultSettings);
  }
  expect(heard.size).toBe(tracks.length);
});
it('shuffles upcoming songs while keeping the current song and playback position', async () => {
  const b = new MockBackend(),
    tracks = await b.tracks(item);
  await b.start(item, tracks, defaultSettings);
  await b.command({ action: 'pause' }, defaultSettings);
  const original = await b.state('');
  await b.command({ action: 'shuffle', enabled: true }, defaultSettings);
  expect(await b.state('')).toMatchObject({
    track: original.track,
    elapsed: original.elapsed,
    status: 'paused',
    shuffle: true,
  });
  await b.command({ action: 'shuffle', enabled: false }, defaultSettings);
  await b.command({ action: 'next' }, defaultSettings);
  expect((await b.state('')).track?.id).toBe(tracks[1].id);
});
