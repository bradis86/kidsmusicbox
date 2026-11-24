import type {
  MusicItem,
  Track,
  Player,
  Provider,
  PlaybackState,
  PlaybackCommand,
  Settings,
  ApprovedItem,
  BackendMode,
} from '../../shared/types.js';
export interface MusicBackend {
  readonly mode: BackendMode;
  library(search?: string, offset?: number): Promise<MusicItem[]>;
  searchCatalog(query: string): Promise<MusicItem[]>;
  tracks(item: MusicItem): Promise<Track[]>;
  resolvePlaylist(uri: string): Promise<MusicItem>;
  providers(): Promise<Provider[]>;
  players(): Promise<Player[]>;
  state(playerId: string): Promise<PlaybackState>;
  start(
    item: ApprovedItem,
    tracks: Track[],
    settings: Settings,
    startTrackId?: string,
  ): Promise<void>;
  command(
    command: Exclude<PlaybackCommand, { action: 'start' | 'start-sleep' }>,
    settings: Settings,
  ): Promise<void>;
  configure(settings: Settings): Promise<void>;
  close(): void;
}
export class BackendError extends Error {
  constructor(
    message: string,
    public status = 503,
  ) {
    super(message);
  }
}
