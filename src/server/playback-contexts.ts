import type { AdultSelection } from './adult-catalogue.js';
import { Store, secret } from './db.js';
import { BrowserAudioGateway } from './browser-audio.js';
import { MockBackend } from './adapters/mock.js';
import { MusicAssistantBackend } from './adapters/music-assistant.js';
import { BackendError, type MusicBackend } from './adapters/backend.js';
import type { PlaybackState, Settings } from '../shared/types.js';

/** Only playback intent is namespaced; accounts, approvals and tastes stay shared. */
class PlaybackStore {
  constructor(
    private shared: Store,
    private context: PlaybackContext,
    private independent: boolean,
  ) {}
  get<T>(key: string, fallback: T): T {
    return this.shared.get(this.key(key), fallback);
  }
  set(key: string, value: unknown) {
    this.shared.set(this.key(key), value);
  }
  private key(key: string) {
    return this.independent ? `playback:${this.context.id}:${key}` : key;
  }
  settings(): Settings {
    const s = {
      ...this.shared.settings(),
      ...this.get<Partial<Pick<Settings, 'shuffle' | 'repeat'>>>(
        'queueModes',
        {},
      ),
    };
    return this.independent
      ? {
          ...s,
          playerId: this.context.target,
          playbackMode: 'local',
          resumeAfterRestart: false,
        }
      : s;
  }
  log(message: string) {
    this.shared.log(message);
  }
}
export class PlaybackContext {
  readonly store: PlaybackStore;
  adultSelection: AdultSelection | null = null;
  target = '';
  audio: BrowserAudioGateway | null = null;
  itemVersion = secret();
  lastSeen = 0;
  heartbeatScreenOff: boolean | null = null;
  polling = false;
  nextPoll = 0;
  failures = 0;
  bootHandled = false;
  serial: Promise<unknown> = Promise.resolve();
  playback: PlaybackState;
  constructor(
    readonly id: string,
    readonly backend: MusicBackend,
    shared: Store,
    independent: boolean,
  ) {
    this.store = new PlaybackStore(shared, this, independent);
    this.playback = {
      status: independent ? 'idle' : 'unavailable',
      connected: independent,
      playerId: '',
      track: null,
      elapsed: 0,
      volume: shared.settings().startupVolume,
      shuffle: false,
      repeat: false,
      collectionId: null,
      simulated: backend.mode === 'mock',
    };
  }
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.serial.then(fn, fn);
    this.serial = operation.catch(() => {});
    return operation;
  }
}
export interface IndependentPlayback {
  playerIds: string[];
  backendFactory?: () => MusicBackend;
}
export class PlaybackContexts {
  readonly legacy: PlaybackContext;
  private contexts = new Map<string, PlaybackContext>();
  readonly gateways: (BrowserAudioGateway | null)[];
  constructor(
    private shared: Store,
    private backend: MusicBackend,
    readonly independent: IndependentPlayback | undefined,
    gateway: () => BrowserAudioGateway | null,
  ) {
    if (
      independent &&
      (independent.playerIds.length !== 2 ||
        new Set(independent.playerIds).size !== 2 ||
        independent.playerIds.some((id) => !id))
    )
      throw Error(
        'Independent playback requires exactly two distinct player targets',
      );
    this.legacy = new PlaybackContext('legacy', backend, shared, false);
    this.gateways = Array.from(
      { length: independent?.playerIds.length ?? 1 },
      gateway,
    );
    if (!independent) this.legacy.audio = this.gateways[0];
    else {
      const assigned = shared.db
        .prepare('SELECT slot,device_id FROM playback_slots')
        .all() as { slot: number; device_id: string }[];
      for (const row of assigned)
        this.attach(this.forDevice(row.device_id), row.slot);
    }
  }
  forDevice(id: string): PlaybackContext {
    if (!this.independent) return this.legacy;
    let context = this.contexts.get(id);
    if (!context) {
      const backend =
        this.independent.backendFactory?.() ??
        (this.backend instanceof MusicAssistantBackend
          ? this.backend.fork()
          : this.backend instanceof MockBackend
            ? this.backend.fork()
            : null);
      if (!backend) throw Error('Independent playback needs a backend factory');
      context = new PlaybackContext(id, backend, this.shared, true);
      this.contexts.set(id, context);
    }
    return context;
  }
  private attach(c: PlaybackContext, slot: number) {
    c.target = this.independent!.playerIds[slot];
    c.audio = this.gateways[slot];
    c.playback.playerId = c.target;
  }
  allocate(c: PlaybackContext) {
    if (!this.independent || c.target) return;
    const occupied = this.all().map((context) => context.target);
    const assigned = this.shared.db
      .prepare('SELECT slot FROM playback_slots')
      .all() as { slot: number }[];
    const slot = [0, 1].find(
      (i) =>
        !assigned.some((row) => row.slot === i) &&
        !occupied.includes(this.independent!.playerIds[i]),
    );
    if (slot === undefined)
      throw new BackendError(
        'Both audio players are assigned. Ask a parent to release a player in Children & preferences.',
        409,
      );
    this.shared.db
      .prepare('INSERT INTO playback_slots(slot,device_id) VALUES(?,?)')
      .run(slot, c.id);
    this.attach(c, slot);
  }
  release(c: PlaybackContext) {
    if (!this.independent) return;
    this.shared.db
      .prepare('DELETE FROM playback_slots WHERE device_id=?')
      .run(c.id);
    c.audio?.stop();
    c.adultSelection = null;
    c.audio = null;
    c.target = '';
    c.itemVersion = secret();
    c.store.set('activeCollection', null);
    c.store.set('audioOwner', '');
    c.store.set('audioClientId', '');
    c.playback = {
      ...c.playback,
      status: 'idle',
      track: null,
      elapsed: 0,
      collectionId: null,
      playerId: '',
    };
  }
  all() {
    return this.independent ? [...this.contexts.values()] : [this.legacy];
  }
  active() {
    return this.all().filter((c) => !this.independent || !!c.target);
  }
  async close() {
    await Promise.all(this.all().map((c) => c.serial));
    for (const c of this.contexts.values()) c.backend.close();
    for (const audio of this.gateways) audio?.close();
  }
}
