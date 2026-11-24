import { z } from 'zod';
export type BackendMode = 'mock' | 'music-assistant';
export type MediaKind = 'playlist' | 'album' | 'track';
export interface MusicItem {
  id: string;
  uri: string;
  name: string;
  kind: MediaKind;
  artist: string;
  artwork: string;
  provider: string;
}
export interface Track {
  id: string;
  uri: string;
  name: string;
  artist: string;
  duration: number;
  artwork: string;
  albumId?: string;
  /** Equivalent provider identities supplied by the music backend. */
  sourceUris?: string[];
}
export interface ApprovedItem extends MusicItem {
  displayName: string;
  position: number;
  artworkOverride: string | null;
  hiddenTrackIds: string[];
}
export interface Player {
  id: string;
  name: string;
  available: boolean;
  type: 'mock' | 'music-assistant' | 'lenovo';
}
export interface Provider {
  id: string;
  name: string;
  available: boolean;
}
export interface PlaybackState {
  status: 'idle' | 'playing' | 'paused' | 'unavailable';
  connected: boolean;
  playerId: string;
  track: Track | null;
  elapsed: number;
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  collectionId: string | null;
  simulated: boolean;
}
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const SettingsSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(80),
    maxVolume: z.number().int().min(0).max(100),
    startupVolume: z.number().int().min(0).max(100),
    shuffle: z.boolean(),
    repeat: z.boolean(),
    inactivitySeconds: z.number().int().min(10).max(3600),
    inactivityMode: z.enum(['library', 'dim', 'none']),
    bedtimeEnabled: z.boolean(),
    bedtimeStart: clock,
    bedtimeEnd: clock,
    sleepMusicEnd: clock.default('07:00'),
    screenScheduleEnabled: z.boolean(),
    sleepMusicTapToWake: z.boolean().default(true),
    screenOffAt: clock,
    screenOnAt: clock,
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone'),
    resumeAfterRestart: z.boolean(),
    playbackMode: z.enum(['local', 'remote']).default('local'),
    voiceSearchEnabled: z.boolean().default(true),
    playerId: z.string().max(200),
    screenOverride: z.enum(['auto', 'on', 'off']),
  })
  .strict()
  .refine((s) => s.startupVolume <= s.maxVolume, {
    message: 'Startup volume must not exceed maximum',
    path: ['startupVolume'],
  });
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings: Settings = {
  deviceName: 'My music',
  maxVolume: 60,
  startupVolume: 25,
  shuffle: false,
  repeat: false,
  inactivitySeconds: 120,
  inactivityMode: 'dim',
  bedtimeEnabled: false,
  bedtimeStart: '19:30',
  bedtimeEnd: '07:00',
  sleepMusicEnd: '07:00',
  screenScheduleEnabled: false,
  sleepMusicTapToWake: true,
  screenOffAt: '19:30',
  screenOnAt: '07:00',
  timezone: 'Australia/Perth',
  resumeAfterRestart: false,
  playbackMode: 'local',
  voiceSearchEnabled: true,
  playerId: 'mock-lenovo',
  screenOverride: 'auto',
};
export const PlaybackCommandSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.enum(['shuffle', 'repeat']), enabled: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal('start'),
      collectionId: z.string().min(1).max(500),
      trackId: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('start-sleep'),
      songId: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({ action: z.enum(['play', 'pause', 'stop', 'next', 'previous']) })
    .strict(),
  z
    .object({
      action: z.literal('volume'),
      volume: z.number().int().min(0).max(100),
    })
    .strict(),
]);
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
export interface ChildProfile {
  kind?: 'child' | 'adult';
  id: string;
  name: string;
  avatar: string;
}
export type TrackReaction = 'favourite' | 'blocked' | 'neutral';
export interface TrackPreference {
  id: string;
  reaction: TrackReaction;
  track: Track;
  version: number;
}
export interface PersonalState {
  deviceId: string;
  profile: ChildProfile;
  profiles: ChildProfile[];
  revision: number;
  trackVersion: string;
  preferencesVersion?: string;
  preference: TrackPreference | null;
}
export interface HubState {
  independentPlayback?: boolean;
  personal?: PersonalState;
  voice: { enabled: boolean; maxRecordingSeconds: number };
  playback: PlaybackState;
  collection: ApprovedItem[];
  sleepSongs?: Track[];
  sleepSession?: { songId: string; endsAt: string };
  device: {
    name: string;
    screenOff: boolean;
    screenReason: string;
    screenWakeAt?: number;
    sleepMusicTapToWake?: boolean;
    bedtime: boolean;
    online: boolean;
    lastSeen: string | null;
  };
  settings: Pick<
    Settings,
    | 'maxVolume'
    | 'shuffle'
    | 'repeat'
    | 'inactivitySeconds'
    | 'inactivityMode'
    | 'playbackMode'
  >;
  backend: BackendMode;
}
export interface SessionInfo {
  authenticated: boolean;
  csrf?: string;
  setupRequired?: boolean;
  personal?: PersonalState;
}
export interface VoiceMatch {
  kind: 'track' | 'album' | 'playlist';
  collectionId: string;
  trackId?: string;
  name: string;
  artist: string;
  artwork: string;
}
export interface VoiceSearchResponse {
  text: string;
  noSpeech: boolean;
  matches: VoiceMatch[];
  partial: boolean;
}
