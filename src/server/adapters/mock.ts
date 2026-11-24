import type { MusicBackend } from './backend.js';
import { BackendError } from './backend.js';
import type {
  MusicItem,
  Track,
  PlaybackState,
  PlaybackCommand,
  Settings,
  ApprovedItem,
} from '../../shared/types.js';
const samples = [
  ['sunshine', 'Sunbeams', 'Sunbeams', 'playlist'],
  ['space', 'Orbit Lanterns essentials', 'Orbit Lanterns', 'playlist'],
  ['forest', 'Folded Maps', 'Mapmakers Club', 'album'],
  ['sleep', 'Classic rock', 'Orbit Lanterns · Mapmakers Club', 'playlist'],
  ['ocean', 'On repeat', 'Sunbeams · Orbit Lanterns', 'playlist'],
  [
    'dance',
    'Weekend mix',
    'Sunbeams · Orbit Lanterns · Mapmakers Club',
    'playlist',
  ],
] as const;
export const sampleLibrary: MusicItem[] = samples.map(
  ([id, name, artist, kind]) => ({
    id: `mock-${id}`,
    uri: `mock://${kind}/${id}`,
    name,
    artist,
    kind,
    artwork: `/art/${id}.svg?v=2`,
    provider: 'Demo metadata · no audio',
  }),
);
// Track names are references to real music. Timings are illustrative demo values;
// no audio, official cover art, lyrics or Spotify data is bundled.
const tracksByCollection: Record<string, [string, string, number][]> = {
  sunshine: [
    ['Sunspun', 'Sunbeams', 194],
    ['Ribbon Steps', 'Sunbeams', 183],
    ['Paper Skies', 'Sunbeams', 230],
    ['Moon Kite', 'Sunbeams', 180],
  ],
  space: [
    ['Comet Parade', 'Orbit Lanterns', 209],
    ['Window Lights', 'Orbit Lanterns', 296],
    ['Lunar Letters', 'Orbit Lanterns', 355],
  ],
  forest: [
    ['River Compass', 'Mapmakers Club', 222],
    ['Footpath Echo', 'Mapmakers Club', 201],
    ['Hilltop Postcard', 'Mapmakers Club', 214],
  ],
  sleep: [
    ['Lunar Letters', 'Orbit Lanterns', 355],
    ['River Compass', 'Mapmakers Club', 222],
    ['Night Radio', 'Orbit Lanterns', 348],
  ],
  ocean: [
    ['Sunspun', 'Sunbeams', 194],
    ['Night Radio', 'Orbit Lanterns', 348],
    ['River Compass', 'Mapmakers Club', 222],
  ],
  dance: [
    ['Ribbon Steps', 'Sunbeams', 183],
    ['Comet Parade', 'Orbit Lanterns', 209],
    ['Footpath Echo', 'Mapmakers Club', 201],
  ],
};
export class MockBackend implements MusicBackend {
  readonly mode = 'mock' as const;
  private queue: Track[] = [];
  private originalQueue: Track[] = [];
  private index = 0;
  private lastTick = Date.now();
  private available = true;
  private value: PlaybackState = {
    status: 'idle',
    connected: true,
    playerId: 'mock-lenovo',
    track: null,
    elapsed: 0,
    volume: 25,
    shuffle: false,
    repeat: false,
    collectionId: null,
    simulated: true,
  };
  constructor(private now: () => number = Date.now) {
    this.lastTick = now();
  }
  fork() {
    return new MockBackend(this.now);
  }
  async library(search = '') {
    return sampleLibrary.filter((i) =>
      `${i.name} ${i.artist}`.toLowerCase().includes(search.toLowerCase()),
    );
  }
  async tracks(item: MusicItem): Promise<Track[]> {
    if (item.kind === 'track') {
      for (const collection of sampleLibrary) {
        const found = (await this.tracks(collection)).find(
          (track) => track.uri === item.uri,
        );
        if (found) return [found];
      }
      return [];
    }
    const key = item.id.replace('mock-', '');
    return (tracksByCollection[key] ?? []).map(
      ([name, artist, duration], i) => ({
        id: `${item.id}-${i}`,
        uri: `mock://track/${key}-${i}`,
        name,
        artist,
        duration,
        artwork: item.artwork,
        albumId: item.kind === 'album' ? item.id : undefined,
      }),
    );
  }
  async searchCatalog(query: string): Promise<MusicItem[]> {
    const songs: MusicItem[] = [];
    for (const collection of sampleLibrary)
      for (const track of await this.tracks(collection))
        songs.push({
          id: track.uri,
          uri: track.uri,
          name: track.name,
          artist: track.artist,
          artwork: track.artwork,
          provider: collection.provider,
          kind: 'track',
        });
    return [...sampleLibrary, ...songs].filter((item) =>
      `${item.name} ${item.artist}`.toLowerCase().includes(query.toLowerCase()),
    );
  }
  async resolvePlaylist(_uri: string): Promise<MusicItem> {
    throw new BackendError(
      'Connect Music Assistant with your Spotify provider to import a real playlist. Mock mode cannot import Spotify links.',
      409,
    );
  }
  async providers() {
    return [
      {
        id: 'demo',
        name: 'Music demo · no audio',
        available: this.available,
      },
    ];
  }
  async players() {
    return [
      {
        id: 'mock-lenovo',
        name: 'Virtual Lenovo · simulated audio',
        available: this.available,
        type: 'mock' as const,
      },
    ];
  }
  private tick() {
    const now = this.now(),
      delta = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.value.status !== 'playing' || !this.available) return;
    this.value.elapsed += delta;
    while (
      this.value.track &&
      this.value.elapsed >= this.value.track.duration
    ) {
      this.value.elapsed -= this.value.track.duration;
      if (this.index + 1 < this.queue.length) {
        this.index++;
        this.value.track = this.queue[this.index];
      } else if (this.value.repeat) {
        this.index = 0;
        this.value.track = this.queue[0];
      } else {
        this.value.status = 'idle';
        this.value.elapsed = 0;
        break;
      }
    }
  }
  async state(_playerId: string) {
    this.tick();
    return {
      ...this.value,
      connected: this.available,
      status: this.available ? this.value.status : ('unavailable' as const),
    };
  }
  private shufflePending(enabled: boolean) {
    const pending = this.queue.slice(this.index + 1);
    if (enabled) {
      for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
      }
    } else
      pending.sort(
        (a, b) => this.originalQueue.indexOf(a) - this.originalQueue.indexOf(b),
      );
    this.queue = [...this.queue.slice(0, this.index + 1), ...pending];
    this.value.shuffle = enabled;
  }
  async configure(settings: Settings) {
    this.tick();
    this.value.repeat = settings.repeat;
    if (this.value.shuffle !== settings.shuffle)
      this.shufflePending(settings.shuffle);
    this.value.volume = Math.min(this.value.volume, settings.maxVolume);
  }
  async start(
    item: ApprovedItem,
    tracks: Track[],
    settings: Settings,
    startTrackId?: string,
  ) {
    if (!this.available) throw new BackendError('Mock player is disconnected');
    if (!tracks.length)
      throw new BackendError('No approved tracks are available', 422);
    if (startTrackId && !tracks.some((t) => t.id === startTrackId))
      throw new BackendError('Track is not available in this collection', 403);
    this.tick();
    this.originalQueue = [...tracks];
    this.queue = [...tracks];
    if (settings.shuffle) {
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
    }
    if (startTrackId) {
      const selected = this.queue.findIndex((t) => t.id === startTrackId);
      // Chosen song first, followed by the rest of the approved queue.
      this.queue = [
        ...this.queue.slice(selected),
        ...this.queue.slice(0, selected),
      ];
    }
    this.index = 0;
    this.value = {
      ...this.value,
      status: 'playing',
      track: this.queue[this.index],
      elapsed: 0,
      collectionId: item.id,
      volume: Math.min(settings.startupVolume, settings.maxVolume),
      repeat: settings.repeat,
      shuffle: settings.shuffle,
    };
  }
  async command(
    command: Exclude<PlaybackCommand, { action: 'start' | 'start-sleep' }>,
    settings: Settings,
  ) {
    this.tick();
    if (!this.available) throw new BackendError('Mock player is disconnected');
    switch (command.action) {
      case 'shuffle':
        this.shufflePending(command.enabled);
        break;
      case 'repeat':
        this.value.repeat = command.enabled;
        break;
      case 'play':
        if (this.value.track) this.value.status = 'playing';
        break;
      case 'pause':
        if (this.value.track) this.value.status = 'paused';
        break;
      case 'stop':
        this.value.status = 'idle';
        this.value.elapsed = 0;
        break;
      case 'volume':
        this.value.volume = Math.min(command.volume, settings.maxVolume);
        break;
      case 'next':
      case 'previous':
        if (this.queue.length) {
          const direction = command.action === 'next' ? 1 : -1;
          const next = this.index + direction;
          if (next >= this.queue.length && !this.value.repeat) {
            this.value.status = 'idle';
            this.value.elapsed = 0;
          } else {
            this.index = Math.max(
              0,
              (next + this.queue.length) % this.queue.length,
            );
            this.value.track = this.queue[this.index];
            this.value.elapsed = 0;
          }
        }
        break;
    }
  }
  setAvailable(value: boolean) {
    this.tick();
    this.available = value;
    if (!value) this.value.status = this.value.track ? 'paused' : 'idle';
    this.lastTick = this.now();
  }
  close() {}
}
