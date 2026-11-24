import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, hash, passwordHash, verifyPassword, secret } from './db.js';
import { MockBackend } from './adapters/mock.js';
import {
  MusicAssistantBackend,
  MusicAssistantError,
} from './adapters/music-assistant.js';
import { BackendError, type MusicBackend } from './adapters/backend.js';
import { nextClockTime, policy } from './policy.js';
import { spotifyPlaylistUri } from './spotify-link.js';
import { BrowserAudioGateway } from './browser-audio.js';
import {
  PlaybackContexts,
  type PlaybackContext,
  type IndependentPlayback,
} from './playback-contexts.js';
import type { Transcriber } from './voice/transcriber.js';
import { matchApproved } from './voice/search.js';
import { Profiles, trackUris } from './profiles.js';
import { RendererRecovery } from './renderer-recovery.js';
import { AdultCatalogue, type AdultBinding } from './adult-catalogue.js';
import { trackHidden } from '../shared/music.js';
import {
  SettingsSchema,
  PlaybackCommandSchema,
  type Settings,
  type MusicItem,
  type HubState,
  type Track,
  type ApprovedItem,
} from '../shared/types.js';
interface SleepSession {
  songId: string;
  endsAt: number;
}
const sleepCollectionId = 'sleep-music';
interface Options {
  recoverRenderers?: boolean;
  independentPlayback?: IndependentPlayback;
  browserPlayerId?: string;
  musicAssistantUrl?: string;
  musicAssistantToken?: string;
  store: Store;
  backend: MusicBackend;
  setupCode?: string;
  parentPassword?: string;
  secureCookies?: boolean;
  publicOrigin?: string;
  automationToken?: string;
  tickMs?: number;
  now?: () => Date;
  voice?: Transcriber;
  voiceMaxRecordingSeconds?: number;
}
const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .filter((x) => x.includes('='))
      .map((x) => {
        const i = x.indexOf('=');
        return [x.slice(0, i).trim(), x.slice(i + 1).trim()];
      }),
  );
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function createHub(options: Options) {
  const { store, backend } = options;
  const profiles = new Profiles(store);
  const adultCatalogue = new AdultCatalogue();
  const isAdult = (profileId: string) =>
    profiles.get(profileId)?.kind === 'adult';
  function adultBinding(req: Request): AdultBinding {
    const device = checkContext(req);
    if (!isAdult(device.profile_id))
      throw new BackendError(
        'An adult profile is required. Ask a parent to assign this display.',
        403,
      );
    return {
      deviceId: device.id,
      profileId: device.profile_id,
      revision: device.revision,
    };
  }
  function sameBinding(a: AdultBinding, b: AdultBinding) {
    return (
      a.deviceId === b.deviceId &&
      a.profileId === b.profileId &&
      a.revision === b.revision
    );
  }
  function contextBinding(
    c: PlaybackContext,
    profileId: string,
  ): AdultBinding | null {
    if (!isAdult(profileId)) return null;
    const deviceId = options.independentPlayback
      ? c.id
      : c.store.get('playbackDeviceId', '');
    const d = profiles
      .devices()
      .find((d) => d.id === deviceId && d.profileId === profileId);
    return d
      ? { deviceId: d.id, profileId: d.profileId, revision: d.revision }
      : null;
  }
  function catalogueSelection(
    c: PlaybackContext,
    id: string,
    profileId = activeProfile(c),
  ) {
    const binding = contextBinding(c, profileId);
    if (!binding) return undefined;
    if (
      c.adultSelection?.item.id === id &&
      sameBinding(c.adultSelection, binding)
    )
      return c.adultSelection;
    return adultCatalogue.get(binding, id);
  }
  function sleepSongs() {
    return store
      .get<Track[]>('sleepSongs', [])
      .filter(
        (track) =>
          track.uri.startsWith('mock://') === (backend.mode === 'mock'),
      );
  }
  function sleepIntent(c: PlaybackContext) {
    return c.store.get<SleepSession | null>('sleepSession', null);
  }
  function activeSleep(c: PlaybackContext) {
    const sleep = sleepIntent(c);
    if (
      !sleep ||
      !c.bootHandled ||
      sleep.endsAt <= now().getTime() ||
      c.store.get<string>('activeCollection', '') !== sleepCollectionId
    )
      return null;
    const track = sleepSongs().find((song) => song.id === sleep.songId);
    return track && !profiles.blocked(activeProfile(c), track) ? sleep : null;
  }
  function playbackSettings(c: PlaybackContext, sleeping = activeSleep(c)) {
    const settings = c.store.settings();
    return sleeping ? { ...settings, shuffle: false, repeat: true } : settings;
  }
  function bedtimeBlocksAudio(c: PlaybackContext) {
    return sleepIntent(c)
      ? !activeSleep(c)
      : policy(c.store.settings(), now()).bedtime;
  }
  function availableCollection(
    c: PlaybackContext,
    id: string,
    profileId = activeProfile(c),
  ) {
    return (
      (id === sleepCollectionId && !!activeSleep(c)) ||
      id === favouriteId ||
      collection().some((i) => i.id === id) ||
      !!catalogueSelection(c, id, profileId)
    );
  }
  function playableItem(
    c: PlaybackContext,
    id: string,
    profileId = activeProfile(c),
  ) {
    return id === favouriteId
      ? favouriteItem(profileId)
      : (collection().find((i) => i.id === id) ??
          catalogueSelection(c, id, profileId)?.item);
  }
  async function playableTracks(
    c: PlaybackContext,
    item: ApprovedItem,
    profileId = activeProfile(c),
  ) {
    if (item.id === favouriteId) return favouriteTracks(profileId);
    const selection = catalogueSelection(c, item.id, profileId);
    return c.backend.tracks(selection?.source ?? item);
  }
  async function searchCatalogue(req: Request, query: string) {
    const binding = adultBinding(req);
    const found = await backend.searchCatalog(query);
    if (!sameBinding(binding, adultBinding(req)))
      throw new BackendError('The player profile changed. Search again.', 409);
    const result = await Promise.all(
      found
        .slice(0, 30)
        .map(async (source) =>
          adultCatalogue.remember(binding, await imageItem(source)),
        ),
    );
    if (!sameBinding(binding, adultBinding(req)))
      throw new BackendError('The player profile changed. Search again.', 409);
    return result;
  }
  async function searchVoice(req: Request, text: string, signal?: AbortSignal) {
    if (!isAdult(profileFor(req)))
      return voiceMatches(text, profileFor(req), signal);
    const query = text
      .replace(/^(?:please\s+)?(?:play|put on|find)\s+/i, '')
      .replace(/[.!?]+$/, '')
      .trim();
    const items = await searchCatalogue(req, query || text);
    return {
      partial: false,
      matches: items.map((item) => ({
        kind: item.kind,
        collectionId: item.id,
        name: item.name,
        artist: item.artist,
        artwork: item.artwork,
      })),
    };
  }
  const profileFor = (req: Request) =>
    profiles.device(cookies(req).hub_child ?? '').profile_id;
  const activeProfile = (c: PlaybackContext = contexts.legacy) =>
    profiles.get(c.store.get<string>('activeProfileId', profiles.all()[0].id))
      ?.id ?? profiles.all()[0].id;
  const favouriteId = '__favourites__';
  const favouriteItem = (profileId: string): ApprovedItem => ({
    id: favouriteId,
    uri: 'hub://favourites',
    name: 'My favourites',
    displayName: 'My favourites',
    artist: profiles.get(profileId)?.name ?? '',
    kind: 'playlist',
    artwork: '/art/favourites.svg',
    provider: 'My favourites',
    position: -1,
    artworkOverride: null,
    hiddenTrackIds: [],
  });
  const childCollection = (profileId: string) => {
    const blocked = profiles.blockedIds(profileId);
    const items = collection()
      .filter((i) => i.kind !== 'track' || !profiles.blocked(profileId, i))
      .map((i) => ({
        ...i,
        hiddenTrackIds: [...i.hiddenTrackIds, ...blocked],
      }));
    return [favouriteItem(profileId), ...items];
  };
  async function approvedTracks(profileId: string, ignoreBlocked = false) {
    const rows = await Promise.all(
      collection().map(async (item) => {
        try {
          return { id: item.id, tracks: await backend.tracks(item) };
        } catch {
          return { id: item.id, tracks: [] as Track[] };
        }
      }),
    );
    const current = collection();
    return rows.flatMap((row) => {
      const item = current.find((i) => i.id === row.id);
      return item
        ? row.tracks.filter(
            (t) =>
              !trackHidden(item.hiddenTrackIds, t) &&
              (ignoreBlocked || !profiles.blocked(profileId, t)),
          )
        : [];
    });
  }
  async function favouriteTracks(profileId: string) {
    if (isAdult(profileId))
      return profiles
        .list(profileId)
        .filter(
          (p) =>
            p.reaction === 'favourite' && !profiles.blocked(profileId, p.track),
        )
        .map((p) => p.track);
    const allowed = await approvedTracks(profileId);
    return allowed.filter(
      (t, index) =>
        profiles.find(profileId, t)?.reaction === 'favourite' &&
        allowed.findIndex((other) =>
          trackUris(other).some((uri) => trackUris(t).includes(uri)),
        ) === index,
    );
  }
  const currentTrackVersion = (c: PlaybackContext = contexts.legacy) =>
    c.itemVersion + ':' + hash(c.playback.track?.uri ?? '');
  function personal(token: string) {
    const c = contextFor(token);
    const device = profiles.device(token);
    return {
      deviceId: device.id,
      profile: profiles.get(device.profile_id)!,
      profiles: profiles.all(),
      revision: device.revision,
      trackVersion: currentTrackVersion(c),
      preferencesVersion: profiles.preferenceVersion(device.profile_id),
      preference:
        c.playback.track &&
        childTrackApproved(c) &&
        activeProfile(c) === device.profile_id
          ? profiles.find(device.profile_id, c.playback.track)
          : null,
    };
  }
  function checkContext(req: Request) {
    const device = profiles.device(cookies(req).hub_child ?? '');
    const supplied = req.get('x-child-profile');
    if (
      (supplied &&
        (supplied !== device.profile_id ||
          (req.get('x-child-device') &&
            req.get('x-child-device') !== device.id) ||
          Number(req.get('x-profile-revision')) !== device.revision)) ||
      (!supplied && profiles.all().length > 1)
    )
      throw new BackendError(
        'This player profile changed. Refresh the player and try again.',
        409,
      );
    return device;
  }
  const recordingSeconds = options.voiceMaxRecordingSeconds ?? 10;
  if (
    !Number.isInteger(recordingSeconds) ||
    recordingSeconds < 1 ||
    recordingSeconds > 15
  )
    throw Error('Voice recording limit must be 1–15 seconds');
  const voiceCache = new Map<string, { tracks: Track[]; expires: number }>();
  async function voiceMatches(
    text: string,
    profileId: string,
    signal?: AbortSignal,
  ) {
    const items = collection();
    for (const id of voiceCache.keys())
      if (!items.some((i) => i.id === id)) voiceCache.delete(id);
    const entries: { item: ApprovedItem; tracks: Track[] }[] = [];
    let partial = false,
      cursor = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          if (signal?.aborted) return;
          if (Date.now() - started > 10000) {
            partial = true;
            return;
          }
          let cached = voiceCache.get(item.id);
          if (!cached || cached.expires < Date.now()) {
            try {
              cached = {
                tracks: await backend.tracks(item),
                expires: Date.now() + 60000,
              };
              voiceCache.set(item.id, cached);
            } catch {
              partial = true;
            }
          }
          entries.push({ item, tracks: cached?.tracks ?? [] });
        }
      }),
    );
    // Approval/removal and hidden tracks are checked again after asynchronous work.
    const current = collection();
    const results = matchApproved(
      text,
      entries.flatMap((entry) => {
        const item = current.find((i) => i.id === entry.item.id);
        return item
          ? [
              {
                item,
                tracks: entry.tracks.filter(
                  (t) => !profiles.blocked(profileId, t),
                ),
              },
            ]
          : [];
      }),
    );
    return {
      matches: await Promise.all(
        results.map(async (result) => ({
          ...result,
          artwork: await cacheReference(result.artwork),
        })),
      ),
      partial,
    };
  }
  const contexts = new PlaybackContexts(
    store,
    backend,
    options.independentPlayback,
    () =>
      backend instanceof MusicAssistantBackend &&
      options.musicAssistantUrl &&
      options.musicAssistantToken
        ? new BrowserAudioGateway({
            url: options.musicAssistantUrl,
            token: options.musicAssistantToken,
            allowedAddress: new URL(options.musicAssistantUrl).hostname,
          })
        : null,
  );
  const recovery =
    options.recoverRenderers && backend instanceof MusicAssistantBackend
      ? new RendererRecovery(
          backend,
          contexts.gateways.flatMap((gateway, i) =>
            gateway
              ? [
                  {
                    playerId:
                      options.independentPlayback?.playerIds[i] ??
                      options.browserPlayerId ??
                      '',
                    connected: () => gateway.connected(),
                    active: () => gateway.activeReceiver(),
                  },
                ]
              : [],
          ),
          (message) => store.log(message),
        )
      : null;
  let audioListening = false,
    nextRecovery = 0;
  function contextFor(token: string) {
    return contexts.forDevice(profiles.device(token).id);
  }
  const requestContext = (req: Request) =>
    contextFor(cookies(req).hub_child ?? '');
  const now = options.now ?? (() => new Date());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: [
            "'self'",
            'data:',
            'blob:',
            (req) =>
              /^\/admin(?:[/?]|$)/.test(req.url ?? '') ? 'https:' : "'self'",
          ],
          connectSrc: ["'self'"],
          frameSrc: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: options.secureCookies ? undefined : false,
    }),
  );
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  if (
    options.parentPassword &&
    !store.get<string | null>('passwordHash', null)
  ) {
    if (options.parentPassword.length < 12)
      throw new Error('PARENT_PASSWORD must contain at least 12 characters');
    store.set('passwordHash', passwordHash(options.parentPassword));
  }
  const setupCode = options.setupCode ?? secret();
  const collection = () =>
    store
      .collection()
      .filter(
        (item) => (backend.mode === 'mock') === item.uri.startsWith('mock://'),
      );
  const catalog = new Map<string, MusicItem>();
  const listeners = new Set<{
    res: Response;
    role: 'parent' | 'child';
    expires: number;
    token: string;
  }>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const operation = serial.then(fn, fn);
    serial = operation.catch(() => {});
    return operation;
  }
  const parent = (req: Request) => store.session(cookies(req).hub_parent);
  const child = (req: Request) => store.session(cookies(req).hub_child);
  function auth(role: 'parent' | 'child') {
    return (req: Request, res: Response, next: NextFunction) => {
      const s = role === 'parent' ? parent(req) : child(req);
      if (!s || s.role !== role)
        return res.status(401).json({
          error:
            role === 'parent'
              ? 'Parent login required'
              : 'Set up this player to open your music',
        });
      res.locals.session = s;
      next();
    };
  }
  function mutation(req: Request, res: Response, next: NextFunction) {
    const origin = req.get('origin');
    const expected =
      options.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expected)
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    if (req.get('sec-fetch-site') === 'cross-site')
      return res.status(403).json({ error: 'Cross-site request rejected' });
    const s = res.locals.session as { csrf: string } | undefined;
    if (s && !equal(req.get('x-csrf-token') ?? '', s.csrf))
      return res.status(403).json({ error: 'Invalid CSRF token' });
    next();
  }
  const loginLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  function setSession(res: Response, role: 'parent' | 'child') {
    const s = store.createSession(role);
    res.cookie(`hub_${role}`, s.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
      path: '/',
      maxAge: s.expires - Date.now(),
    });
    return s;
  }
  async function cacheReference(path: string) {
    if (path.startsWith('/art/') || path.startsWith('/artwork/')) return path;
    const id = hash(path);
    store.set(`image:${id}`, path);
    return `/artwork/ma/${id}`;
  }
  async function imageItem<T extends MusicItem | Track>(item: T): Promise<T> {
    return { ...item, artwork: await cacheReference(item.artwork) };
  }
  let scheduledWake:
    { clock: string; timezone: string; at: number } | undefined;
  function getScheduledWake(settings: Settings, at: Date) {
    const { screenOnAt: clock, timezone } = settings;
    if (
      scheduledWake?.clock !== clock ||
      scheduledWake.timezone !== timezone ||
      scheduledWake.at <= at.getTime()
    )
      scheduledWake = {
        clock,
        timezone,
        at: nextClockTime(clock, timezone, at),
      };
    return scheduledWake.at;
  }
  function snapshot(
    role: 'parent' | 'child' = 'parent',
    token?: string,
  ): HubState {
    const c = role === 'child' && token ? contextFor(token) : contexts.legacy;
    const childPersonal =
      role === 'child' && token ? personal(token) : undefined;
    const ownProfile =
      !childPersonal || childPersonal.profile.id === activeProfile(c);
    const at = now();
    const s = c.store.settings(),
      p = policy(s, at);
    const screenWakeAt =
      p.screenOff && s.screenOverride === 'auto'
        ? getScheduledWake(s, at)
        : undefined;
    const approved = childTrackApproved(c);
    const sleep = ownProfile ? activeSleep(c) : null;
    const songs = sleepSongs().filter(
      (song) =>
        !childPersonal || !profiles.blocked(childPersonal.profile.id, song),
    );
    const visiblePlayback =
      s.playbackMode === 'local' && c.audio
        ? { ...c.playback, playerId: c.store.get('audioClientId', '') }
        : c.playback;
    const currentPlayback = approved
      ? {
          ...visiblePlayback,
          collectionId: c.store.get<string | null>('activeCollection', null),
        }
      : visiblePlayback;
    return {
      independentPlayback: !!options.independentPlayback,
      personal: childPersonal,
      ...(songs.length ? { sleepSongs: songs } : {}),
      ...(sleep
        ? {
            sleepSession: {
              songId: sleep.songId,
              endsAt: new Date(sleep.endsAt).toISOString(),
            },
          }
        : {}),
      voice: {
        enabled: !!options.voice && s.voiceSearchEnabled,
        maxRecordingSeconds: recordingSeconds,
      },
      playback:
        role === 'child' && (!approved || !ownProfile)
          ? { ...visiblePlayback, track: null, collectionId: null, elapsed: 0 }
          : currentPlayback,
      collection:
        role === 'child'
          ? childCollection(childPersonal?.profile.id ?? profiles.all()[0].id)
          : collection(),
      device: {
        name:
          role === 'child' && token
            ? profiles.device(token).name
            : s.deviceName,
        ...p,
        screenWakeAt,
        sleepMusicTapToWake:
          role === 'child' &&
          screenWakeAt !== undefined &&
          s.sleepMusicTapToWake &&
          songs.length > 0,
        online: Date.now() - c.lastSeen < 25_000,
        lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null,
      },
      settings: {
        maxVolume: s.maxVolume,
        shuffle: s.shuffle,
        repeat: s.repeat,
        inactivitySeconds: s.inactivitySeconds,
        inactivityMode: s.inactivityMode,
        playbackMode: s.playbackMode,
      },
      backend: c.backend.mode,
    };
  }
  function childTrackApproved(c: PlaybackContext = contexts.legacy) {
    const active = c.store.get<string | null>('activeCollection', null);
    return (
      !!active &&
      availableCollection(c, active) &&
      !!c.playback.track &&
      [c.playback.track.uri, ...(c.playback.track.sourceUris ?? [])].some(
        (uri) => c.store.get<string[]>('activeTrackUris', []).includes(uri),
      )
    );
  }
  function publish() {
    for (const listener of listeners) {
      if (listener.expires < Date.now() || !store.session(listener.token)) {
        listener.res.end();
        listeners.delete(listener);
      } else if (
        !listener.res.write(
          `data: ${JSON.stringify(snapshot(listener.role, listener.role === 'child' ? listener.token : undefined))}\n\n`,
        )
      ) {
        listener.res.end();
        listeners.delete(listener);
      }
    }
  }
  async function refresh(c: PlaybackContext = contexts.legacy) {
    const s = c.store.settings();
    if (
      options.independentPlayback &&
      !profiles.devices().some((d) => d.id === c.id)
    ) {
      await stopContext(c);
      if (!c.store.get('pendingStop', false)) contexts.release(c);
      return;
    }
    if (sleepIntent(c) && !activeSleep(c)) await stopContext(c);
    // Local policy must silence buffered audio even while MA is unreachable.
    if (c.audio && s.playbackMode === 'local' && bedtimeBlocksAudio(c))
      c.audio.stop();
    if (options.independentPlayback && !c.target) return;
    try {
      if (c.store.get('pendingStop', false)) {
        c.audio?.stop();
        await c.backend.command({ action: 'stop' }, s);
        c.store.set('pendingStop', false);
      }
      const previousTrack = c.playback.track,
        previousElapsed = c.playback.elapsed;
      c.playback = await c.backend.state(s.playerId);
      if (
        previousTrack?.uri !== c.playback.track?.uri ||
        (previousTrack && previousElapsed > c.playback.elapsed + 3)
      )
        c.itemVersion = secret();
      if (!c.playback.connected) {
        publish();
        return;
      }
      if (c.store.get('settingsDirty', false) || !c.bootHandled) {
        const configured = playbackSettings(c);
        await c.backend.configure(configured);
        c.playback = {
          ...c.playback,
          repeat: configured.repeat,
          shuffle: configured.shuffle,
        };
        c.store.set('settingsDirty', false);
      }
      if (c.failures) c.store.log('Music backend connection restored');
      c.failures = 0;
      c.playback.track = c.playback.track
        ? await imageItem(c.playback.track)
        : null;
      if (c.store.get('preferenceQueueDirty', false) && c.playback.track) {
        if (c.audio && s.playbackMode === 'local' && !c.audio.hasBoundary())
          c.audio.finishAfter(
            Math.max(0, c.playback.track.duration - c.playback.elapsed),
          );
        if (
          (!c.audio || s.playbackMode !== 'local') &&
          (c.playback.track.uri !== c.store.get('deferredFromUri', '') ||
            c.playback.status === 'idle' ||
            previousElapsed > c.playback.elapsed + 3)
        ) {
          await nextEligible(c, 'next', c.store.get('deferredFromUri', ''));
          c.playback = await c.backend.state(s.playerId);
        }
      }
      const p = policy(s, now());
      if (!c.bootHandled) {
        c.bootHandled = true;
        const owned = c.store.get<string | null>('activeCollection', null);
        if (owned) {
          if (
            s.resumeAfterRestart &&
            (!c.audio || s.playbackMode === 'remote') &&
            !p.bedtime
          ) {
            const item = collection().find((i) => i.id === owned);
            if (item) await start(c, item.id);
          } else if (c.playback.status === 'playing') {
            await c.backend.command({ action: 'stop' }, s);
            c.playback = await c.backend.state(s.playerId);
          }
        }
      }
      if (p.bedtime && !activeSleep(c) && c.playback.status === 'playing') {
        c.audio?.stop();
        await c.backend.command({ action: 'stop' }, s);
        c.playback = await c.backend.state(s.playerId);
        c.store.log('Bedtime restriction stopped playback');
      }
    } catch {
      if (!c.failures)
        c.store.log('Music backend unavailable; retrying with backoff');
      c.failures++;
      c.playback = { ...c.playback, status: 'unavailable', connected: false };
    }
    publish();
  }
  async function start(
    c: PlaybackContext = contexts.legacy,
    id: string,
    trackId?: string,
    profileId = activeProfile(c),
    explicitTracks?: Track[],
    retainVolume = false,
    sleep?: SleepSession,
  ) {
    const s = c.store.settings();
    if (!sleep && policy(s, now()).bedtime)
      throw new BackendError(
        'It is bedtime. Playback is resting until morning.',
        403,
      );
    if (c.audio && s.playbackMode === 'local')
      await recovery?.ensure(s.playerId);
    const sleepTrack =
      sleep && sleepSongs().find((song) => song.id === sleep.songId);
    const item: ApprovedItem | undefined = sleepTrack
      ? {
          ...sleepTrack,
          id: sleepCollectionId,
          kind: 'track',
          displayName: sleepTrack.name,
          provider: c.backend.mode,
          position: 0,
          artworkOverride: null,
          hiddenTrackIds: [],
        }
      : playableItem(c, id, profileId);
    if (!item)
      throw new BackendError(
        'This music is not in the approved collection',
        403,
      );
    const tracks = (
      explicitTracks ??
      (sleepTrack ? [sleepTrack] : await playableTracks(c, item, profileId))
    ).filter(
      (t) =>
        !trackHidden(item.hiddenTrackIds, t) && !profiles.blocked(profileId, t),
    );
    if (trackId && !tracks.some((t) => t.id === trackId))
      throw new BackendError(
        'This track is not approved in this collection',
        403,
      );
    if (options.independentPlayback) {
      const d = profiles.devices().find((d) => d.id === c.id);
      if (!d || d.profileId !== profileId)
        throw new BackendError(
          'This player profile changed. Choose music again.',
          409,
        );
    }
    const current = sleep
      ? sleep.endsAt > now().getTime() &&
        sleepSongs().some((song) => song.id === sleep.songId) &&
        item
      : playableItem(c, id, profileId);
    if (
      !current ||
      (sleep && !tracks.length) ||
      (!sleep && policy(store.settings(), now()).bedtime) ||
      tracks.some(
        (t) =>
          trackHidden(current.hiddenTrackIds, t) ||
          profiles.blocked(profileId, t),
      )
    )
      throw new BackendError(
        'The approved music changed. Choose music again.',
        409,
      );
    c.adultSelection = catalogueSelection(c, id, profileId) ?? null;
    c.bootHandled = true;
    // Persist validated intent before a remote mutation: the server can start
    // audio even if its acknowledgement is lost. Never retry that mutation.
    c.store.set('activeProfileId', profileId);
    const selectedIndex = trackId
      ? Math.max(
          0,
          tracks.findIndex((t) => t.id === trackId),
        )
      : 0;
    c.store.set('activeQueueTracks', [
      ...tracks.slice(selectedIndex),
      ...tracks.slice(0, selectedIndex),
    ]);
    c.store.set('preferenceQueueDirty', false);
    c.itemVersion = secret();
    if (sleep) {
      c.audio?.stop();
      c.store.set('sleepSession', sleep);
    }
    c.store.set('activeCollection', id);
    c.store.set('activeTrackUris', [
      ...new Set(tracks.flatMap((t) => [t.uri, ...(t.sourceUris ?? [])])),
    ]);
    const queueSettings = playbackSettings(c, sleep ?? null);
    await c.backend.start(
      item,
      tracks,
      retainVolume
        ? {
            ...queueSettings,
            startupVolume: Math.min(c.playback.volume, s.maxVolume),
          }
        : queueSettings,
      trackId,
    );
    c.store.set('pendingStop', false);
    if (c.backend instanceof MusicAssistantBackend) {
      try {
        const order = await c.backend.queueOrder(s.playerId, tracks);
        if (order.length) c.store.set('activeQueueTracks', order);
      } catch {
        /* The validated local queue remains the fallback during MA reconnection. */
      }
    }
    c.store.log(
      sleep ? 'Started Sleep Music' : `Started approved ${item.kind}`,
    );
  }
  async function nextEligible(
    c: PlaybackContext = contexts.legacy,
    direction: 'next' | 'previous',
    fromUri = c.playback.track?.uri,
  ) {
    const id = c.store.get<string | null>('activeCollection', null),
      profileId = activeProfile(c);
    if (!id) return;
    const original = c.store.get<Track[]>('activeQueueTracks', []);
    const index = original.findIndex((t) =>
      trackUris(t).includes(fromUri ?? ''),
    );
    const s = c.store.settings();
    const after =
      direction === 'next'
        ? original.slice(index + 1)
        : original.slice(0, Math.max(0, index)).reverse();
    const wrap =
      direction === 'next'
        ? original.slice(0, index + 1)
        : original.slice(Math.max(0, index)).reverse();
    const candidates = [...after, ...(s.repeat ? wrap : [])].filter(
      (t) => !profiles.blocked(profileId, t),
    );
    const item = playableItem(c, id, profileId);
    const eligible = item
      ? (await playableTracks(c, item, profileId)).filter(
          (t) =>
            !trackHidden(item.hiddenTrackIds, t) &&
            !profiles.blocked(profileId, t),
        )
      : [];
    const target = candidates.find((t) =>
      eligible.some((a) =>
        trackUris(a).some((uri) => trackUris(t).includes(uri)),
      ),
    );
    if (!target) {
      c.audio?.stop();
      await c.backend.command({ action: 'stop' }, s);
      c.store.set('activeCollection', null);
      c.store.set('preferenceQueueDirty', false);
      return;
    }
    const ordered = (direction === 'next' ? candidates : original).filter((t) =>
      eligible.some((a) =>
        trackUris(a).some((uri) => trackUris(t).includes(uri)),
      ),
    );
    await start(c, id, target.id, profileId, ordered, true);
  }
  function deferContextBlocks(
    c: PlaybackContext = contexts.legacy,
    profileId: string,
  ) {
    if (
      profileId !== activeProfile(c) ||
      !c.store.get('activeCollection', null)
    )
      return;
    if (sleepIntent(c)) {
      if (!activeSleep(c)) c.audio?.stop();
      return;
    }
    c.store.set('preferenceQueueDirty', true);
    c.store.set('deferredFromUri', c.playback.track?.uri ?? '');
    if (
      c.audio &&
      c.store.settings().playbackMode === 'local' &&
      c.playback.track &&
      c.playback.track.duration > 0
    )
      c.audio.finishAfter(
        Math.max(0, c.playback.track.duration - c.playback.elapsed),
      );
  }
  async function releaseContextProfile(
    c: PlaybackContext = contexts.legacy,
    profileId: string,
    owner?: string,
  ) {
    if (
      activeProfile(c) !== profileId ||
      (owner &&
        c.store.get('playbackSession', '') !== owner &&
        c.store.get('audioOwner', '') !== owner)
    )
      return;
    if (sleepIntent(c)) {
      await stopContext(c);
      return;
    }
    c.audio?.stop();
    c.adultSelection = null;
    c.store.set('activeCollection', null);
    c.store.set('activeTrackUris', []);
    c.store.set('preferenceQueueDirty', false);
    c.itemVersion = secret();
    try {
      await c.backend.command({ action: 'stop' }, c.store.settings());
    } catch {
      c.store.set('pendingStop', true);
    }
  }
  function deferBlocks(profileId: string) {
    for (const c of contexts.active()) deferContextBlocks(c, profileId);
  }
  async function releaseProfile(profileId: string, owner?: string) {
    await Promise.all(
      contexts
        .active()
        .map((c) => c.locked(() => releaseContextProfile(c, profileId, owner))),
    );
  }
  async function stopContext(c: PlaybackContext) {
    c.audio?.stop();
    if (sleepIntent(c)) {
      c.store.set('pendingStop', true);
      c.store.set('settingsDirty', true);
      c.store.set('sleepSession', null);
    }
    c.adultSelection = null;
    c.store.set('activeCollection', null);
    c.store.set('activeTrackUris', []);
    c.store.set('preferenceQueueDirty', false);
    c.itemVersion = secret();
    try {
      await c.backend.command({ action: 'stop' }, c.store.settings());
      c.store.set('pendingStop', false);
    } catch {
      c.store.set('pendingStop', true);
    }
    c.playback = {
      ...c.playback,
      status: 'idle',
      track: null,
      collectionId: null,
      elapsed: 0,
    };
  }
  async function stopAffected(id: string) {
    const affected = contexts
      .active()
      .filter(
        (c) =>
          c.playback.collectionId === id ||
          c.store.get('activeCollection', null) === id ||
          c.store.get('activeCollection', null) === favouriteId,
      );
    // Invalidate authorization immediately, including while a slow MA start is
    // holding this device's command lock. The eventual stop remains serialized.
    for (const c of affected) {
      c.audio?.stop();
      c.store.set('activeCollection', null);
      c.store.set('activeTrackUris', []);
    }
    await Promise.all(affected.map((c) => c.locked(() => stopContext(c))));
  }
  async function refreshAll() {
    await Promise.all(contexts.active().map((c) => c.locked(() => refresh(c))));
    publish();
  }
  async function play(req: Request, res: Response) {
    const c =
      res.locals.session?.role === 'child'
        ? requestContext(req)
        : contexts.legacy;
    if (options.independentPlayback && res.locals.session?.role !== 'child')
      throw new BackendError(
        'Use the controls for a paired player in Children & preferences.',
        409,
      );
    const command = PlaybackCommandSchema.parse(req.body);
    if (
      command.action === 'start-sleep' &&
      res.locals.session?.role !== 'child'
    )
      throw new BackendError(
        'Choose a Sleep Music song on the child player',
        403,
      );
    const starting =
      command.action === 'start' || command.action === 'start-sleep';
    let childDevice =
      res.locals.session?.role === 'child' ? checkContext(req) : null;
    await c.locked(async () => {
      if (childDevice) childDevice = checkContext(req);
      if (sleepIntent(c) && !activeSleep(c)) await stopContext(c);
      if (starting) {
        if (childDevice) c.store.set('playbackDeviceId', childDevice.id);
        const profileId = childDevice?.profile_id ?? activeProfile(c);
        if (
          command.action === 'start-sleep'
            ? !sleepSongs().some(
                (song) =>
                  song.id === command.songId &&
                  !profiles.blocked(profileId, song),
              )
            : !playableItem(c, command.collectionId, profileId)
        )
          throw new BackendError('Item not available for this profile', 403);
        contexts.allocate(c);
      } else if (options.independentPlayback && !c.target)
        throw new BackendError('Choose a song on this player first', 409);
      const s = c.store.settings();
      if (
        childDevice &&
        !starting &&
        activeProfile(c) !== childDevice.profile_id
      )
        throw new BackendError('Choose music for this child first', 409);
      if (
        c.backend instanceof MusicAssistantBackend &&
        s.playbackMode === 'local' &&
        res.locals.session?.role === 'child' &&
        (req.get('x-audio-client-id') !== c.store.get('audioClientId', '') ||
          c.store.get('audioOwner', '') !== hash(cookies(req).hub_child ?? ''))
      )
        throw new BackendError(
          'Sound belongs to another device. Choose a song here to move sound to this device.',
          409,
        );
      if (
        activeSleep(c) &&
        !['start-sleep', 'stop', 'volume'].includes(command.action)
      )
        throw new BackendError(
          'Stop Sleep Music before choosing other controls',
          409,
        );
      if (command.action === 'start-sleep') {
        const sleep = {
          songId: command.songId,
          endsAt: nextClockTime(s.sleepMusicEnd, s.timezone, now()),
        };
        c.store.set('playbackSession', hash(cookies(req).hub_child ?? ''));
        try {
          await start(
            c,
            sleepCollectionId,
            undefined,
            childDevice!.profile_id,
            undefined,
            c.store.get('activeCollection', null) !== null ||
              c.store.get('volumeChosen', false),
            sleep,
          );
        } catch (error) {
          const persisted = sleepIntent(c);
          if (
            persisted?.songId !== sleep.songId ||
            persisted.endsAt !== sleep.endsAt
          )
            throw error;
          await refresh(c);
          if (
            !activeSleep(c) ||
            !childTrackApproved(c) ||
            c.playback.status !== 'playing'
          ) {
            await stopContext(c);
            publish();
            throw error;
          }
        }
        if (!activeSleep(c)) await stopContext(c);
      } else if (command.action === 'stop' && sleepIntent(c)) {
        await stopContext(c);
        await refresh(c);
      } else if (command.action === 'start') {
        try {
          if (childDevice) c.store.set('playbackDeviceId', childDevice.id);
          c.store.set(
            'playbackSession',
            childDevice ? hash(cookies(req).hub_child ?? '') : '',
          );
          await start(
            c,
            command.collectionId,
            command.trackId,
            childDevice?.profile_id ?? activeProfile(c),
            undefined,
            // Startup volume applies on first play, not on each selection.
            c.store.get('activeCollection', null) !== null ||
              c.store.get('volumeChosen', false),
          );
        } catch (error) {
          await refresh(c);
          if (
            !(error instanceof BackendError) ||
            error.status < 500 ||
            !childTrackApproved(c) ||
            c.playback.status !== 'playing' ||
            c.store.get('activeCollection', null) !== command.collectionId
          )
            throw error;
          c.store.log(
            'Approved playback confirmed after delayed acknowledgement',
          );
        }
      } else {
        if (
          ['play', 'next', 'previous', 'shuffle', 'repeat'].includes(
            command.action,
          )
        ) {
          if (policy(s, now()).bedtime)
            throw new BackendError(
              'Playback is restricted during bedtime',
              403,
            );
          if (res.locals.session?.role === 'child' && !childTrackApproved(c))
            throw new BackendError('Select approved music first', 403);
          const current =
            c.store.get<string | null>('activeCollection', null) ??
            c.playback.collectionId;
          if (!current || !availableCollection(c, current))
            throw new BackendError('Select approved music first', 403);
        }
        if (
          (command.action === 'next' || command.action === 'previous') &&
          c.store.get('preferenceQueueDirty', false)
        )
          await nextEligible(c, command.action);
        else {
          await c.backend.command(command, s);
          if (command.action === 'volume') c.store.set('volumeChosen', true);
          if (command.action === 'shuffle' || command.action === 'repeat') {
            c.store.set('queueModes', {
              ...c.store.get('queueModes', {}),
              [command.action]: command.enabled,
            });
            if (
              command.action === 'shuffle' &&
              c.backend instanceof MusicAssistantBackend
            ) {
              try {
                const order = await c.backend.queueOrder(
                  s.playerId,
                  c.store.get<Track[]>('activeQueueTracks', []),
                );
                if (order.length) c.store.set('activeQueueTracks', order);
              } catch {
                /* Keep the validated fallback order if MA cannot return it. */
              }
            }
          }
        }
        if (command.action === 'next' || command.action === 'previous')
          c.itemVersion = secret();
        if (command.action === 'stop') {
          c.store.set('activeCollection', null);
          c.store.set('preferenceQueueDirty', false);
        }
      }
      c.playback = await c.backend.state(s.playerId);
      if (c.playback.track)
        c.playback.track = await imageItem(c.playback.track);
      publish();
    });
    res.json(
      snapshot(
        res.locals.session?.role,
        res.locals.session?.role === 'child'
          ? cookies(req).hub_child
          : undefined,
      ),
    );
  }
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', backend: backend.mode }),
  );
  app.get('/api/auth/session', (req, res) => {
    const s = parent(req);
    res.json(
      s?.role === 'parent'
        ? { authenticated: true, csrf: s.csrf }
        : {
            authenticated: false,
            setupRequired: !store.get('passwordHash', null),
          },
    );
  });
  const credentialSchema = z
    .object({
      password: z.string().min(12).max(200),
      setupCode: z.string().max(200).optional(),
    })
    .strict();
  app.post('/api/auth/setup', loginLimit, mutation, (req, res) => {
    if (store.get('passwordHash', null))
      throw new BackendError('Parent account already exists', 409);
    const data = credentialSchema.parse(req.body);
    if (!equal(data.setupCode ?? '', setupCode))
      throw new BackendError('Incorrect setup code', 403);
    store.set('passwordHash', passwordHash(data.password));
    const s = setSession(res, 'parent');
    store.log('Parent account created');
    res.json({ authenticated: true, csrf: s.csrf });
  });
  app.post('/api/auth/login', loginLimit, mutation, (req, res) => {
    const data = credentialSchema.parse(req.body),
      stored = store.get<string | null>('passwordHash', null);
    if (!stored || !verifyPassword(data.password, stored))
      throw new BackendError('Incorrect password', 401);
    const s = setSession(res, 'parent');
    res.json({ authenticated: true, csrf: s.csrf });
  });
  app.post('/api/auth/logout', auth('parent'), mutation, (req, res) => {
    store.revoke(cookies(req).hub_parent);
    res.clearCookie('hub_parent', { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/child/session', (req, res) => {
    const s = child(req);
    res.json(
      s?.role === 'child'
        ? {
            authenticated: true,
            csrf: s.csrf,
            personal: personal(cookies(req).hub_child ?? ''),
          }
        : { authenticated: false },
    );
  });
  app.post(
    '/api/child/pair',
    mutation,
    rateLimit({
      windowMs: 15 * 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => child(req)?.role === 'child',
    }),
    (req, res) => {
      if (!req.is('application/json'))
        throw new BackendError('Send player setup as JSON', 415);
      const data = z
        .object({ name: z.string().trim().min(1).max(60).optional() })
        .strict()
        .parse(req.body);
      const existing = child(req);
      if (existing?.role === 'child') {
        res.json({
          authenticated: true,
          csrf: existing.csrf,
          personal: personal(cookies(req).hub_child ?? ''),
        });
        return;
      }
      if (!store.get('passwordHash', null))
        throw new BackendError(
          'A parent needs to finish Music Hub setup first.',
          409,
        );
      if (!profiles.all().some((p) => p.kind !== 'adult'))
        throw new BackendError(
          'A parent needs to create a child profile first.',
          409,
        );
      const session = setSession(res, 'child');
      const device = profiles.device(session.token);
      if (data.name) profiles.assign(device.id, device.profile_id, data.name);
      store.log('Browser self-registered with child access');
      res.status(201).json({
        authenticated: true,
        csrf: session.csrf,
        personal: personal(session.token),
      });
      publish();
    },
  );
  app.post('/api/admin/pair', auth('parent'), mutation, (_req, res) => {
    const s = setSession(res, 'child');
    store.log('Child browser paired');
    res.json({ ok: true, csrf: s.csrf });
  });
  app.post(
    '/api/admin/revoke-devices',
    auth('parent'),
    mutation,
    async (_req, res) => {
      await Promise.all(
        contexts.active().map((c) =>
          c.locked(async () => {
            await stopContext(c);
            if (!c.store.get('pendingStop', false)) contexts.release(c);
          }),
        ),
      );
      store.db.prepare("DELETE FROM sessions WHERE role='child'").run();
      for (const l of listeners)
        if (l.role === 'child') {
          l.res.end();
          listeners.delete(l);
        }
      res.json({ ok: true });
    },
  );
  app.use('/api/admin', auth('parent'));
  app.get('/api/admin/profiles', (req, res) =>
    res.json({
      currentDeviceId:
        child(req)?.role === 'child'
          ? profiles.device(cookies(req).hub_child ?? '').id
          : null,
      profiles: profiles.all(),
      independentPlayback: !!options.independentPlayback,
      devices: profiles.devices().map((d) => {
        const c = contexts.forDevice(d.id);
        return {
          ...d,
          audioAssigned: !!c.target,
          online: Date.now() - c.lastSeen < 25000,
          playback: {
            status: c.playback.status,
            track: c.playback.track,
            volume: c.playback.volume,
          },
        };
      }),
      archivedProfiles: profiles.archived(),
    }),
  );
  app.post('/api/admin/profiles', mutation, (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        avatar: z.string().min(1).max(12),
        kind: z.enum(['child', 'adult']).default('child'),
      })
      .strict()
      .parse(req.body);
    res.json(profiles.create(data.name, data.avatar, data.kind));
    publish();
  });
  app.patch('/api/admin/profiles/:id', mutation, async (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        avatar: z.string().min(1).max(12),
        kind: z.enum(['child', 'adult']).optional(),
      })
      .strict()
      .parse(req.body);
    await locked(async () => {
      const before = profiles.get(String(req.params.id));
      if (!before) throw new BackendError('Profile not found', 404);
      profiles.update(before.id, data.name, data.avatar, data.kind);
      if (data.kind && data.kind !== before.kind)
        await releaseProfile(before.id);
      await refreshAll();
    });
    res.json({ ok: true });
  });
  app.delete('/api/admin/profiles/:id', mutation, async (req, res) => {
    await locked(async () => {
      await releaseProfile(String(req.params.id));
      profiles.archive(String(req.params.id));
      await refreshAll();
    });
    res.json({ ok: true });
  });
  app.patch('/api/admin/profile-devices/:id', mutation, async (req, res) => {
    const data = z
      .object({ profileId: z.string(), name: z.string().trim().min(1).max(60) })
      .strict()
      .parse(req.body);
    await locked(async () => {
      const device = profiles.devices().find((d) => d.id === req.params.id);
      if (!device) throw new BackendError('Player not found', 404);
      const old = profiles.assign(
        String(req.params.id),
        data.profileId,
        data.name,
      );
      if (isAdult(data.profileId) && !isAdult(old.profile_id))
        store.set(`playback:${old.id}:adultReturnProfile`, old.profile_id);
      if (old.profile_id !== data.profileId)
        await releaseProfile(old.profile_id, old.session_hash);
      await refreshAll();
    });
    res.json({ ok: true });
  });
  for (const action of ['stop', 'release-audio'] as const) {
    app.post(
      `/api/admin/profile-devices/:id/${action}`,
      mutation,
      async (req, res) => {
        if (!profiles.devices().some((d) => d.id === req.params.id))
          throw new BackendError('Player not found', 404);
        const c = contexts.forDevice(String(req.params.id));
        await c.locked(async () => {
          if (c.target || !options.independentPlayback) await stopContext(c);
          if (action === 'release-audio') {
            if (c.store.get('pendingStop', false))
              throw new BackendError(
                'The player could not be stopped. Retry when Music Assistant reconnects.',
                503,
              );
            contexts.release(c);
          }
          publish();
        });
        res.json({ ok: true });
      },
    );
  }
  app.post('/api/admin/profiles/:id/restore', mutation, (req, res) => {
    profiles.restore(String(req.params.id));
    publish();
    res.json({ ok: true });
  });
  app.post(
    '/api/admin/profiles/:id/preferences',
    mutation,
    async (req, res) => {
      const data = z
        .object({
          collectionId: z.string(),
          trackId: z.string(),
          reaction: z.enum(['favourite', 'blocked']),
        })
        .strict()
        .parse(req.body);
      await locked(async () => {
        const item = collection().find((i) => i.id === data.collectionId);
        if (!item) throw new BackendError('Choose approved music first', 403);
        const track = (await backend.tracks(item)).find(
          (t) => t.id === data.trackId,
        );
        if (
          !track ||
          (data.reaction === 'favourite' &&
            trackHidden(item.hiddenTrackIds, track))
        )
          throw new BackendError(
            'This song is not available in the approved collection',
            403,
          );
        profiles.set(
          String(req.params.id),
          await imageItem(track),
          data.reaction,
        );
        if (data.reaction === 'blocked') deferBlocks(String(req.params.id));
        publish();
      });
      res.json({ ok: true });
    },
  );
  app.get('/api/admin/profiles/:id/preferences', async (req, res) => {
    const profileId = String(req.params.id);
    if (!profiles.get(profileId))
      throw new BackendError('Child profile not found', 404);
    const adult = isAdult(profileId);
    const allowed = adult ? [] : await approvedTracks(profileId, true);
    res.json(
      profiles.list(profileId).map((p) => ({
        ...p,
        available:
          adult ||
          allowed.some((t) =>
            trackUris(t).some((uri) => trackUris(p.track).includes(uri)),
          ),
      })),
    );
  });
  app.put(
    '/api/admin/profiles/:id/preferences/:preferenceId',
    mutation,
    async (req, res) => {
      const data = z
        .object({
          reaction: z.enum(['favourite', 'blocked', 'neutral']),
          version: z.number().int().nonnegative(),
        })
        .strict()
        .parse(req.body);
      await locked(async () => {
        const profileId = String(req.params.id);
        profiles.changeById(
          profileId,
          String(req.params.preferenceId),
          data.reaction,
          data.version,
        );
        if (data.reaction === 'blocked') deferBlocks(profileId);
        publish();
      });
      res.json({ ok: true });
    },
  );
  app.get('/api/admin/state', (_req, res) => res.json(snapshot()));
  app.get('/api/admin/settings', (_req, res) => res.json(store.settings()));
  app.get('/api/admin/integration', async (_req, res) => {
    let connected = false,
      error: string | null = null,
      players: Awaited<ReturnType<MusicBackend['players']>> = [],
      providers: Awaited<ReturnType<MusicBackend['providers']>> = [];
    try {
      [players, providers] = await Promise.all([
        backend.players(),
        backend.providers(),
      ]);
      connected = true;
    } catch (e) {
      error =
        e instanceof BackendError ? e.message : 'Music backend is unavailable';
    }
    res.json({
      mode: backend.mode,
      connected,
      error,
      serverUrl:
        backend instanceof MusicAssistantBackend
          ? (options.musicAssistantUrl ?? null)
          : null,
      compatibility:
        backend instanceof MusicAssistantBackend ? backend.info : null,
      players,
      providers,
      playerId: store.settings().playerId,
      playbackMode: store.settings().playbackMode,
    });
  });

  app.put('/api/admin/settings', mutation, async (req, res) => {
    const s = SettingsSchema.parse(req.body);
    if (options.independentPlayback && s.playbackMode !== 'local')
      throw new BackendError(
        'The two-device trial uses each device’s own speakers. Disable the trial before selecting external speakers.',
        409,
      );
    await locked(async () => {
      const previous = store.settings();
      if (
        !options.independentPlayback &&
        (s.playerId !== previous.playerId ||
          s.playbackMode !== previous.playbackMode)
      ) {
        if (
          s.playerId &&
          !(await backend.players()).some((p) => p.id === s.playerId)
        )
          throw new BackendError('Unknown playback target', 422);
        await contexts.legacy.locked(() => stopContext(contexts.legacy));
      }
      store.set('settings', s);
      // An explicit parent mode change applies to all players. Saving unrelated
      // settings preserves each player's own shuffle/repeat choices.
      if (s.shuffle !== previous.shuffle || s.repeat !== previous.repeat) {
        const affected = options.independentPlayback
          ? profiles.devices().map((d) => contexts.forDevice(d.id))
          : contexts.all();
        for (const c of affected) {
          const modes = c.store.get<
            Partial<Pick<Settings, 'shuffle' | 'repeat'>>
          >('queueModes', {});
          if (s.shuffle !== previous.shuffle) delete modes.shuffle;
          if (s.repeat !== previous.repeat) delete modes.repeat;
          c.store.set('queueModes', modes);
        }
      }
      store.log('Parent settings updated');
      await Promise.all(
        contexts.active().map((c) =>
          c.locked(async () => {
            c.store.set('settingsDirty', true);
            try {
              await c.backend.configure(playbackSettings(c));
              c.store.set('settingsDirty', false);
              if (bedtimeBlocksAudio(c)) await stopContext(c);
            } catch {
              store.log(
                'Settings saved; playback configuration will retry on reconnection',
              );
            }
            await refresh(c);
          }),
        ),
      );
      publish();
    });
    res.json(s);
  });
  app.get('/api/admin/library', async (req, res) => {
    const search = z
        .string()
        .max(120)
        .parse(req.query.search ?? ''),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100_000)
        .parse(req.query.offset ?? 0);
    const items = await backend.library(search, offset);
    const result = await Promise.all(items.map(imageItem));
    result.forEach((i) => catalog.set(i.id, i));
    res.json(result);
  });
  app.get(
    '/api/admin/search',
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => hash(cookies(req).hub_parent ?? ''),
    }),
    async (req, res) => {
      const query = z.string().trim().min(1).max(120).parse(req.query.search);
      const items = await backend.searchCatalog(query);
      const result = await Promise.all(items.map(imageItem));
      result.forEach((item) => catalog.set(item.id, item));
      res.json(result);
    },
  );
  app.post('/api/admin/spotify/resolve', mutation, async (req, res) => {
    const { link } = z
      .object({ link: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(req.body);
    const uri = spotifyPlaylistUri(link);
    const item = await imageItem(await backend.resolvePlaylist(uri));
    catalog.set(item.id, item);
    res.json(item);
  });
  app.get('/api/admin/tracks', async (req, res) => {
    const id = z.string().min(1).max(500).parse(req.query.id);
    const item = catalog.get(id) ?? collection().find((i) => i.id === id);
    if (!item) throw new BackendError('Browse this item first', 404);
    res.json(await Promise.all((await backend.tracks(item)).map(imageItem)));
  });
  const sleepSelection = z
    .object({
      itemId: z.string().min(1).max(500),
      trackId: z.string().min(1).max(500),
    })
    .strict();
  async function resolveSleepTrack({
    itemId,
    trackId,
  }: z.infer<typeof sleepSelection>) {
    const item =
      catalog.get(itemId) ?? collection().find((entry) => entry.id === itemId);
    if (!item) throw new BackendError('Browse this item first', 404);
    const track = (await backend.tracks(item)).find(
      (entry) => entry.id === trackId,
    );
    if (!track) throw new BackendError('This song is no longer available', 404);
    return track;
  }
  app.post('/api/admin/sleep-music', mutation, async (req, res) => {
    const track = await imageItem(
      await resolveSleepTrack(sleepSelection.parse(req.body)),
    );
    await locked(async () => {
      const songs = store.get<Track[]>('sleepSongs', []);
      const identities = trackUris(track);
      if (
        !songs.some((song) =>
          trackUris(song).some((uri) => identities.includes(uri)),
        )
      ) {
        store.set('sleepSongs', [...songs, { ...track, id: hash(track.uri) }]);
        store.log('Added a Sleep Music song');
        publish();
      }
    });
    res.json(sleepSongs());
  });
  app.delete('/api/admin/sleep-music/:id', mutation, async (req, res) => {
    const id = String(req.params.id);
    await locked(async () => {
      const songs = store.get<Track[]>('sleepSongs', []);
      store.set(
        'sleepSongs',
        songs.filter((song) => song.id !== id),
      );
      for (const c of contexts.active())
        if (sleepIntent(c)?.songId === id) c.audio?.stop();
      await Promise.all(
        contexts.active().map((c) =>
          c.locked(async () => {
            if (sleepIntent(c)?.songId === id) await stopContext(c);
          }),
        ),
      );
      publish();
    });
    res.json(sleepSongs());
  });
  app.get(
    '/api/admin/sleep-music/sample',
    rateLimit({
      windowMs: 60_000,
      limit: 20,
      keyGenerator: (req) => hash(cookies(req).hub_parent ?? ''),
    }),
    async (req, res) => {
      if (!(backend instanceof MusicAssistantBackend))
        throw new BackendError('Audio samples require Music Assistant', 503);
      const track = req.query.songId
        ? sleepSongs().find((song) => song.id === req.query.songId)
        : await resolveSleepTrack(sleepSelection.parse(req.query));
      if (!track) throw new BackendError('Song not found', 404);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        const upstream = await backend.preview(
          track,
          AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        );
        if (upstream.status === 302) {
          res.redirect(upstream.headers.get('location')!);
          return;
        }
        const type = upstream.headers.get('content-type')?.split(';')[0];
        if (
          !upstream.ok ||
          !upstream.body ||
          !type ||
          !['audio/aac', 'audio/mpeg'].includes(type)
        )
          throw new BackendError(
            'No audio sample is available for this song',
            502,
          );
        res.set({ 'Content-Type': type, 'X-Accel-Buffering': 'no' });
        await pipeline(
          Readable.fromWeb(
            upstream.body as import('node:stream/web').ReadableStream,
          ),
          res,
          { signal: controller.signal },
        );
      } catch (error) {
        if (!controller.signal.aborted && !res.headersSent) throw error;
      } finally {
        res.off('close', cancel);
        controller.abort();
      }
    },
  );
  app.post('/api/admin/collection', mutation, async (req, res) => {
    const { id } = z
      .object({ id: z.string().min(1).max(500) })
      .strict()
      .parse(req.body);
    const item = catalog.get(id);
    if (!item)
      throw new BackendError(
        'Browse the library before approving this item',
        422,
      );
    await locked(async () => {
      if (!collection().some((i) => i.id === id)) {
        store.approve({
          ...item,
          displayName: item.name,
          artworkOverride: null,
          hiddenTrackIds: [],
          position: store.collection().length,
        });
        store.log('Music added to approved collection');
        publish();
      }
    });
    res.json(snapshot());
  });
  app.put('/api/admin/collection/order', mutation, async (req, res) => {
    const { ids } = z
      .object({ ids: z.array(z.string().max(500)).max(1000) })
      .strict()
      .parse(req.body);
    await locked(async () => {
      try {
        const current = collection().map((i) => i.id);
        if (
          ids.length !== current.length ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !current.includes(id))
        )
          throw new Error('Invalid order');
        store.reorder([
          ...ids,
          ...store
            .collection()
            .filter((i) => !current.includes(i.id))
            .map((i) => i.id),
        ]);
      } catch {
        throw new BackendError(
          'Order must contain every approved item exactly once',
          422,
        );
      }
      publish();
    });
    res.json(snapshot());
  });
  app.patch('/api/admin/collection/:id', mutation, async (req, res) => {
    const data = z
      .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        artworkOverride: z
          .string()
          .regex(/^\/artwork\/upload\/[a-f0-9]{64}$/)
          .nullable()
          .optional(),
        hiddenTrackIds: z
          .array(z.string().min(1).max(500))
          .max(5000)
          .optional(),
      })
      .strict()
      .parse(req.body);
    await locked(async () => {
      const item = collection().find((i) => i.id === req.params.id);
      if (!item) throw new BackendError('Approved item not found', 404);
      if (data.hiddenTrackIds) {
        const tracks = await backend.tracks(item);
        if (
          data.hiddenTrackIds.some(
            (id) => !tracks.some((t) => trackHidden([id], t)),
          )
        )
          throw new BackendError('Unknown hidden track', 422);
      }
      if (data.artworkOverride) {
        const id = data.artworkOverride.split('/').at(-1)!;
        if (!store.db.prepare('SELECT id FROM artwork WHERE id=?').get(id))
          throw new BackendError('Upload artwork first', 422);
      }
      store.approve({ ...item, ...data });
      if (data.hiddenTrackIds) await stopAffected(item.id);
      await refreshAll();
    });
    res.json(snapshot());
  });
  app.delete('/api/admin/collection/:id', mutation, async (req, res) => {
    await locked(async () => {
      const item = collection().find((i) => i.id === req.params.id);
      if (!item) throw new BackendError('Item not found', 404);
      store.remove(item.id);
      await stopAffected(item.id);
      store.log('Music removed from approved collection');
      await refreshAll();
    });
    res.json(snapshot());
  });
  app.post(
    '/api/admin/artwork',
    mutation,
    express.raw({
      type: ['image/png', 'image/jpeg', 'image/webp'],
      limit: '3mb',
    }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw new BackendError('Upload a PNG, JPEG or WebP image', 415);
      let bytes: Buffer;
      try {
        bytes = await sharp(req.body, { limitInputPixels: 16_000_000 })
          .rotate()
          .resize(640, 640, { fit: 'cover' })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        throw new BackendError('Artwork could not be decoded safely', 422);
      }
      const id = hash(bytes.toString('base64'));
      store.db
        .prepare('INSERT OR IGNORE INTO artwork VALUES(?,?,?)')
        .run(id, 'image/webp', bytes);
      res.json({ url: `/artwork/upload/${id}` });
    },
  );
  app.get('/api/admin/devices', async (_req, res) =>
    res.json({
      players: await backend.players(),
      providers: await backend.providers(),
      backend: backend.mode,
      compatibility:
        backend instanceof MusicAssistantBackend ? backend.info : null,
      screenAcknowledgement:
        contexts
          .all()
          .filter((c) => Date.now() - c.lastSeen < 25_000)
          .sort((a, b) => b.lastSeen - a.lastSeen)[0]?.heartbeatScreenOff ??
        null,
    }),
  );
  app.get('/api/admin/logs', (_req, res) => res.json(store.logs()));
  app.get('/api/admin/voice', async (_req, res) => {
    if (!options.voice) {
      res.json({ configured: false, enabled: false, ready: false });
      return;
    }
    try {
      res.json({
        configured: true,
        enabled: store.settings().voiceSearchEnabled,
        ...(await options.voice.ready()),
      });
    } catch {
      res.json({
        configured: true,
        enabled: store.settings().voiceSearchEnabled,
        ready: false,
        error:
          'Voice search is temporarily unavailable; music playback is unaffected.',
      });
    }
  });
  app.post('/api/admin/playback', mutation, play);
  app.post('/api/admin/mock/connection', mutation, async (req, res) => {
    if (!(backend instanceof MockBackend))
      throw new BackendError('Simulation is only available in mock mode', 404);
    const { available } = z
      .object({ available: z.boolean() })
      .strict()
      .parse(req.body);
    await locked(async () => {
      (backend as MockBackend).setAvailable(available);
      for (const c of contexts.all())
        if (c.backend instanceof MockBackend) c.backend.setAvailable(available);
      store.log(
        available
          ? 'Simulated player reconnected'
          : 'Simulated player disconnected',
      );
      await refreshAll();
    });
    res.json(snapshot());
  });
  app.post('/api/admin/screen', mutation, async (req, res) => {
    const { mode } = z
      .object({ mode: z.enum(['auto', 'on', 'off']) })
      .strict()
      .parse(req.body);
    store.set('settings', { ...store.settings(), screenOverride: mode });
    store.log(`Screen control set to ${mode}`);
    publish();
    res.json(snapshot());
  });
  app.post(
    '/api/automation/screen',
    rateLimit({ windowMs: 60_000, limit: 30 }),
    async (req, res) => {
      const token = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        !options.automationToken ||
        !equal(hash(token), hash(options.automationToken))
      )
        throw new BackendError('Automation token required', 401);
      const { mode } = z
        .object({ mode: z.enum(['auto', 'on', 'off']) })
        .strict()
        .parse(req.body);
      store.set('settings', { ...store.settings(), screenOverride: mode });
      store.log('Screen changed by home automation');
      publish();
      res.json({ ok: true, screenOff: snapshot().device.screenOff });
    },
  );
  app.use('/api/child', auth('child'));
  app.put('/api/child/profile', mutation, async (req, res) => {
    const data = z
      .object({ profileId: z.string(), revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    await locked(async () => {
      const device = profiles.device(cookies(req).hub_child ?? '');
      if (device.revision !== data.revision)
        throw new BackendError(
          'This profile selection changed. Try again.',
          409,
        );
      if (!profiles.get(data.profileId))
        throw new BackendError('Child profile not found', 404);
      if (isAdult(data.profileId))
        throw new BackendError(
          'Only a parent can assign an adult profile',
          403,
        );
      if (device.profile_id !== data.profileId) {
        await releaseProfile(device.profile_id, device.session_hash);
        profiles.assign(device.id, data.profileId);
      }
      await refreshAll();
    });
    res.json(snapshot('child', cookies(req).hub_child));
  });
  app.put('/api/child/reaction', mutation, async (req, res) => {
    const c = requestContext(req);
    const data = z
      .object({
        reaction: z.enum(['favourite', 'blocked', 'neutral']),
        trackVersion: z.string(),
        version: z.number().int().nonnegative(),
      })
      .strict()
      .parse(req.body);
    await c.locked(async () => {
      const device = checkContext(req);
      if (
        !c.playback.track ||
        !childTrackApproved(c) ||
        activeProfile(c) !== device.profile_id ||
        data.trackVersion !== currentTrackVersion(c)
      )
        throw new BackendError(
          'The song or child changed. Please try again.',
          409,
        );
      const owner = hash(cookies(req).hub_child ?? '');
      if (
        (c.audio && c.store.settings().playbackMode === 'local'
          ? c.store.get('audioOwner', '')
          : c.store.get('playbackSession', '')) !== owner
      )
        throw new BackendError('Choose a song on this player first', 409);
      profiles.set(
        device.profile_id,
        c.playback.track,
        data.reaction,
        data.version,
      );
      if (data.reaction === 'blocked') deferBlocks(device.profile_id);
      publish();
    });
    res.json(snapshot('child', cookies(req).hub_child));
  });
  app.get('/api/child/state', (req, res) =>
    res.json(snapshot('child', cookies(req).hub_child)),
  );
  app.get(
    '/api/child/catalogue/search',
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const query = z.string().trim().min(1).max(120).parse(req.query.search);
      res.json(await searchCatalogue(req, query));
    },
  );
  app.post('/api/child/adult/lock', mutation, async (req, res) => {
    adultBinding(req);
    const device = checkContext(req);
    const previous = profiles.get(
      store.get(`playback:${device.id}:adultReturnProfile`, ''),
    );
    const target =
      previous?.kind === 'child'
        ? previous
        : profiles.all().find((p) => p.kind !== 'adult');
    if (!target)
      throw new BackendError('Ask a parent to create a child profile', 409);
    await locked(async () => {
      await releaseProfile(device.profile_id, device.session_hash);
      profiles.assign(device.id, target.id);
      adultCatalogue.clear(device.id);
      await refreshAll();
    });
    res.json(snapshot('child', cookies(req).hub_child));
  });
  app.get('/api/child/collection/:id', async (req, res) => {
    const profileId = profileFor(req),
      c = requestContext(req),
      id = String(req.params.id);
    const before = profiles.device(cookies(req).hub_child ?? '');
    const selected = id.startsWith('adult:')
      ? (adultCatalogue.get(adultBinding(req), id) ??
        catalogueSelection(c, id, profileId))
      : undefined;
    const item =
      id === favouriteId
        ? favouriteItem(profileId)
        : (collection().find((i) => i.id === id) ?? selected?.item);
    if (!item)
      throw new BackendError('Item not available for this profile', 404);
    const tracks = (
      id === favouriteId
        ? await favouriteTracks(profileId)
        : await backend.tracks(selected?.source ?? item)
    ).filter(
      (t) =>
        !trackHidden(item.hiddenTrackIds, t) && !profiles.blocked(profileId, t),
    );
    if (selected && !sameBinding(selected, adultBinding(req)))
      throw new BackendError(
        'The player profile changed. Choose music again.',
        409,
      );
    const result = await Promise.all(tracks.map(imageItem));
    const after = profiles.device(cookies(req).hub_child ?? '');
    if (
      before.profile_id !== after.profile_id ||
      before.revision !== after.revision
    )
      throw new BackendError(
        'The player profile changed. Choose music again.',
        409,
      );
    res.json({ item, tracks: result });
  });
  app.post('/api/child/playback', mutation, play);
  const voiceLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  function voiceAllowed(req: Request, res: Response, next: NextFunction) {
    const device = checkContext(req);
    res.locals.voiceProfileId = device.profile_id;
    res.locals.voiceProfileRevision = device.revision;
    if (!options.voice || !store.settings().voiceSearchEnabled)
      return next(new BackendError('Voice search is disabled', 403));
    next();
  }
  let voiceBusy: symbol | null = null;
  app.post(
    '/api/child/voice/search',
    mutation,
    voiceAllowed,
    voiceLimit,
    (_req, res, next) => {
      if (voiceBusy) {
        res
          .set('Retry-After', '1')
          .status(429)
          .json({ error: 'Voice search is busy. Please try again shortly.' });
        return;
      }
      const owner = Symbol('voice-request');
      voiceBusy = owner;
      res.locals.voiceOwner = owner;
      res.once('close', () => {
        if (voiceBusy === owner) voiceBusy = null;
      });
      next();
    },
    express.raw({
      type: ['audio/webm', 'audio/wav', 'audio/x-wav'],
      limit: '5mb',
    }),
    async (req, res) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          throw new BackendError(
            'Send a WAV or WebM microphone recording',
            415,
          );
        const transcript = await options.voice!.transcribe(
          req.body,
          req.get('content-type')!.split(';')[0].trim(),
          controller.signal,
        );
        if (transcript.durationMs > recordingSeconds * 1000 + 500)
          throw new BackendError(
            'That recording is too long. Please try a shorter request.',
            422,
          );
        const result =
          transcript.noSpeech || !transcript.text
            ? { matches: [], partial: false }
            : await searchVoice(req, transcript.text, controller.signal);
        if (
          profileFor(req) !== res.locals.voiceProfileId ||
          profiles.device(cookies(req).hub_child ?? '').revision !==
            res.locals.voiceProfileRevision
        )
          throw new BackendError(
            'The child profile changed during voice search. Please try again.',
            409,
          );
        if (
          !store.settings().voiceSearchEnabled ||
          child(req)?.role !== 'child'
        )
          throw new BackendError(
            'Voice search is disabled or this browser is no longer paired',
            403,
          );
        if (!res.destroyed && !controller.signal.aborted)
          res.json({
            text: transcript.text,
            noSpeech: transcript.noSpeech,
            ...result,
          });
      } finally {
        res.off('close', cancel);
        if (voiceBusy === res.locals.voiceOwner) voiceBusy = null;
      }
    },
  );
  app.post(
    '/api/child/voice/matches',
    mutation,
    voiceAllowed,
    voiceLimit,
    async (req, res) => {
      const { text } = z
        .object({ text: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body);
      const result = await searchVoice(req, text);
      if (profileFor(req) !== res.locals.voiceProfileId)
        throw new BackendError(
          'The child profile changed during voice search. Please try again.',
          409,
        );
      res.json({ text, noSpeech: false, ...result });
    },
  );
  app.post('/api/child/audio/register', mutation, async (req, res) => {
    const c = requestContext(req);
    if (
      !contexts.gateways.some(Boolean) ||
      !(c.backend instanceof MusicAssistantBackend)
    )
      throw new BackendError(
        'Browser audio requires a configured Music Assistant server',
        503,
      );
    checkContext(req);
    const { clientId, claim } = z
      .object({
        clientId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        claim: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    if (!options.independentPlayback && !options.browserPlayerId)
      throw new BackendError(
        'The native Music Assistant renderer is not configured',
        503,
      );
    await c.locked(async () => {
      checkContext(req);
      if (claim) contexts.allocate(c);
      const settings = c.store.settings();
      if (settings.playbackMode !== 'local')
        throw new BackendError(
          'Local speakers are disabled in Parent settings',
          409,
        );
      const owner = hash(cookies(req).hub_child ?? '');
      if (
        !claim &&
        (c.store.get('audioClientId', '') !== clientId ||
          c.store.get('audioOwner', '') !== owner)
      )
        throw new BackendError(
          'Another device owns sound. Choose a song here to move sound to this device.',
          409,
        );
      await recovery?.ensure(settings.playerId || options.browserPlayerId);
      const nextSettings = {
        ...settings,
        playerId: options.independentPlayback
          ? c.target
          : options.browserPlayerId!,
      };
      // Prepare the new receiver before committing ownership. A failed setup
      // must leave the current target and approval metadata intact.
      await c.backend.configure(
        activeSleep(c)
          ? { ...nextSettings, repeat: true, shuffle: false }
          : nextSettings,
      );
      if (
        c.store.get('audioClientId', '') !== clientId ||
        c.store.get('audioOwner', '') !== owner ||
        settings.playerId !== nextSettings.playerId
      ) {
        if (c.store.get('activeCollection', null) && settings.playerId) {
          // Browser receivers disappear when a phone sleeps or closes the app.
          // An absent/idle target has nothing to stop and may have no MA queue.
          const previous = await c.backend.state(settings.playerId);
          if (
            previous.connected &&
            (previous.status === 'playing' || previous.status === 'paused')
          )
            await c.backend.command({ action: 'stop' }, settings);
        }
        c.store.set('activeCollection', null);
        c.store.set('activeTrackUris', []);
        if (!options.independentPlayback) store.set('settings', nextSettings);
        c.store.log('Local browser speakers connected');
      }
      c.audio!.claim(clientId, owner);
      c.store.set('audioProfileId', profileFor(req));
      c.store.set('audioClientId', clientId);
      c.store.set('audioOwner', owner);
      await refresh(c);
    });
    res.json({ playerId: clientId });
  });
  function audioAuthority(req: Request, clientId: string) {
    const c = requestContext(req);
    const s = c.store.settings();
    const owner = hash(cookies(req).hub_child ?? '');
    return (
      child(req)?.role === 'child' &&
      s.playbackMode === 'local' &&
      s.playerId ===
        (options.independentPlayback ? c.target : options.browserPlayerId) &&
      c.store.get('audioOwner', '') === owner &&
      c.store.get('audioClientId', '') === clientId &&
      c.store.get('audioProfileId', '') === profileFor(req) &&
      (!options.independentPlayback || !!c.target) &&
      !!c.audio?.owned(clientId, owner)
    );
  }
  app.get('/api/child/audio/state', auth('child'), (req, res) => {
    const c = requestContext(req);
    if (bedtimeBlocksAudio(c)) c.audio?.stop();
    const clientId = String(req.query.clientId ?? '');
    res.json(
      audioAuthority(req, clientId)
        ? c.audio!.view(clientId, hash(cookies(req).hub_child ?? ''))
        : null,
    );
  });
  app.get(
    '/api/child/audio/stream/:generation',
    auth('child'),
    async (req, res) => {
      const c = requestContext(req);
      if (req.get('sec-fetch-site') === 'cross-site')
        throw new BackendError('Same-origin audio required', 403);
      const clientId = String(req.query.clientId ?? '');
      const authorized = () =>
        audioAuthority(req, clientId) &&
        !!c.store.get('activeCollection', null) &&
        availableCollection(c, c.store.get('activeCollection', '')) &&
        !bedtimeBlocksAudio(c);
      if (!c.audio || !authorized())
        throw new BackendError(
          'Select approved music on this device first',
          403,
        );
      await c.audio.stream(
        String(req.params.generation),
        req.get('range'),
        res,
        authorized,
        req.method === 'HEAD',
      );
    },
  );
  app.post('/api/child/audio/report', mutation, async (req, res) => {
    const c = requestContext(req);
    const data = z
      .object({
        clientId: z.string(),
        generation: z.string(),
        event: z.enum(['progress', 'ended', 'error', 'boundary']),
        elapsed: z.number().finite().min(0).max(604800),
      })
      .strict()
      .parse(req.body);
    if (!audioAuthority(req, data.clientId))
      throw new BackendError('This browser no longer owns sound', 409);
    if (
      data.event === 'boundary' ||
      (data.event === 'ended' && c.store.get('preferenceQueueDirty', false))
    ) {
      await c.locked(async () => {
        if (
          !audioAuthority(req, data.clientId) ||
          c.audio!.view(data.clientId, hash(cookies(req).hub_child ?? ''))
            ?.generation !== data.generation
        )
          throw new BackendError('This audio stream has been replaced', 409);
        if (!c.store.get('preferenceQueueDirty', false))
          throw new BackendError('No deferred preference change', 409);
        c.audio!.stop();
        await nextEligible(
          c,
          'next',
          c.store.get('deferredFromUri', c.playback.track?.uri ?? ''),
        );
        await refresh(c);
      });
    } else
      c.audio!.report(
        data.generation,
        data.event as 'progress' | 'ended' | 'error',
        data.elapsed,
      );
    res.json({ ok: true });
  });
  app.post('/api/child/heartbeat', mutation, (req, res) => {
    const c = requestContext(req);
    const data = z.object({ screenOff: z.boolean() }).strict().parse(req.body);
    c.lastSeen = Date.now();
    c.heartbeatScreenOff = data.screenOff;
    res.json({ ok: true });
  });
  for (const role of ['parent', 'child'] as const) {
    app.get(
      `/api/${role === 'parent' ? 'admin' : 'child'}/events`,
      auth(role),
      (req, res) => {
        res.status(200).set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        const s = res.locals.session;
        const l = {
          res,
          role,
          expires: s.expires,
          token: cookies(req)[`hub_${role}`],
        };
        listeners.add(l);
        res.write(
          `retry: 2000\ndata: ${JSON.stringify(snapshot(role, role === 'child' ? cookies(req).hub_child : undefined))}\n\n`,
        );
        req.on('close', () => listeners.delete(l));
      },
    );
  }
  app.get('/artwork/:source/:id', async (req, res) => {
    if (parent(req)?.role !== 'parent' && child(req)?.role !== 'child')
      throw new BackendError('Pair this browser to view artwork', 401);
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.id);
    let row = store.db
      .prepare('SELECT mime,bytes FROM artwork WHERE id=?')
      .get(id) as { mime: string; bytes: Uint8Array } | undefined;
    if (
      !row &&
      req.params.source === 'ma' &&
      backend instanceof MusicAssistantBackend
    ) {
      const path = store.get<string | null>(`image:${id}`, null);
      if (!path) throw new BackendError('Artwork reference not found', 404);
      try {
        const raw = await backend.artwork(path);
        const bytes = await sharp(raw, { limitInputPixels: 16_000_000 })
          .resize(640, 640, { fit: 'cover' })
          .webp()
          .toBuffer();
        store.db
          .prepare('INSERT OR REPLACE INTO artwork VALUES(?,?,?)')
          .run(id, 'image/webp', bytes);
        row = { mime: 'image/webp', bytes };
      } catch {
        return res.redirect('/art/fallback.svg');
      }
    }
    if (!row) throw new BackendError('Artwork not found', 404);
    res
      .set({
        'Cache-Control': 'private, max-age=86400',
        'Content-Type': row.mime,
      })
      .send(Buffer.from(row.bytes));
  });
  app.use('/art', express.static(resolve('public/art'), { maxAge: '1d' }));
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: 'API operation not found' }),
  );
  const dist = resolve('dist/client');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) =>
      res.sendFile(resolve(dist, 'index.html')),
    );
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError)
        return res.status(422).json({
          error: 'Invalid request',
          details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      if (error instanceof MusicAssistantError)
        store.log(
          `Music Assistant ${error.operation} failed: HTTP ${error.upstreamStatus}`,
        );
      if (error instanceof BackendError)
        return res.status(error.status).json({ error: error.message });
      if (error && typeof error === 'object' && 'status' in error) {
        const status = Number(error.status);
        if (status >= 400 && status < 500)
          return res
            .status(status)
            .json({ error: 'Request body is invalid or too large' });
      }
      store.log(
        'Request failed; check application configuration and backend availability',
      );
      res.status(500).json({
        error: 'The request could not be completed. Please try again.',
      });
    },
  );
  let screenWasOff = policy(store.settings(), now()).screenOff;
  function loop() {
    if (closed) return;
    const screenOff = policy(store.settings(), now()).screenOff;
    if (screenOff !== screenWasOff) {
      screenWasOff = screenOff;
      publish();
    }
    if (audioListening && recovery && Date.now() >= nextRecovery) {
      nextRecovery = Date.now() + 10000;
      void recovery.ensure().catch(() => {});
    }
    for (const c of contexts.active()) {
      const sleep = sleepIntent(c);
      if (
        c.polling ||
        (Date.now() < c.nextPoll && (!sleep || sleep.endsAt > now().getTime()))
      )
        continue;
      c.polling = true;
      void c
        .locked(() => refresh(c))
        .finally(() => {
          c.polling = false;
          c.nextPoll =
            Date.now() +
            (options.tickMs ??
              Math.min(30000, 2000 * 2 ** Math.min(c.failures, 4)));
        });
    }
    timer = setTimeout(loop, options.tickMs ?? 1000);
    timer.unref();
  }
  loop();
  return {
    app,
    listenAudio: async (port: number) => {
      const addresses = [];
      for (const [i, audio] of contexts.gateways.entries()) {
        if (audio) {
          await audio.listen(port ? port + i : 0);
          addresses.push(audio.address());
        }
      }
      audioListening = true;
      await recovery
        ?.ensure()
        .catch(() =>
          store.log(
            'Renderer connections are recovering; playback will retry connection setup',
          ),
        );
      return addresses;
    },
    setupCode,
    snapshot,
    refresh: refreshAll,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const l of listeners) l.res.end();
      await serial;
      await recovery?.close();
      await contexts.close();
      backend.close();
      options.voice?.close?.();
    },
  };
}
