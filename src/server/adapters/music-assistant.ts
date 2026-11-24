import { randomUUID } from 'node:crypto';
import { BackendError, type MusicBackend } from './backend.js';
import type {
  MusicItem,
  Track,
  PlaybackState,
  PlaybackCommand,
  Settings,
  ApprovedItem,
  Player,
  Provider,
  MediaKind,
} from '../../shared/types.js';
// Command names and arguments are taken from the official music-assistant/client.
// HTTP /api returns the raw JSON result, unlike WebSocket result envelopes.
type Raw = Record<string, any>;
export interface MaConfig {
  url: string;
  token: string;
  expectedSchema?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}
export class MusicAssistantError extends BackendError {
  constructor(
    message: string,
    public upstreamStatus: number,
    public operation: string,
  ) {
    super(
      message,
      upstreamStatus === 401 || upstreamStatus === 403 ? 502 : 503,
    );
  }
}
export class MusicAssistantBackend implements MusicBackend {
  readonly mode = 'music-assistant' as const;
  private origin: string;
  private collectionId: string | null = null;
  private verified = false;
  private checking: Promise<void> | null = null;
  info: {
    server_version?: string;
    schema_version?: number;
    verifiedAt?: string;
  } = {};
  constructor(
    private config: MaConfig,
    private request: typeof fetch = fetch,
  ) {
    const u = new URL(config.url);
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error(
        'MA_URL must be an HTTP(S) base URL without credentials, query or fragment',
      );
    if (
      config.expectedSchema !== undefined &&
      (!Number.isInteger(config.expectedSchema) || config.expectedSchema < 28)
    )
      throw new Error('MA_EXPECTED_SCHEMA must be an integer of at least 28');
    this.origin = config.url.replace(/\/$/, '');
    if (!config.token)
      throw new Error('MA_TOKEN is required in music-assistant mode');
    if (
      config.commandTimeoutMs !== undefined &&
      (!Number.isInteger(config.commandTimeoutMs) ||
        config.commandTimeoutMs < 1000 ||
        config.commandTimeoutMs > 35000)
    )
      throw new Error(
        'MA_COMMAND_TIMEOUT_MS must be an integer from 1000 to 35000',
      );
  }
  fork() {
    return new MusicAssistantBackend(this.config, this.request);
  }
  private async http(
    path: string,
    body?: unknown,
    timeoutMs = this.config.timeoutMs ?? 5000,
  ): Promise<any> {
    let res: Response;
    try {
      res = await this.request(this.origin + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.verified = false;
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new BackendError(
          'Music Assistant did not confirm the request in time. Playback may already have started; its status will update automatically.',
          504,
        );
      throw new BackendError(
        'Music Assistant is unreachable. Check the server and network.',
      );
    }
    if (!res.ok) {
      this.verified = false;
      const operation =
        body &&
        typeof body === 'object' &&
        'command' in body &&
        typeof body.command === 'string'
          ? body.command
          : path;
      throw new MusicAssistantError(
        res.status === 401 || res.status === 403
          ? 'Music Assistant authentication or permissions failed. Check Parent settings.'
          : operation.startsWith('players/') ||
              operation.startsWith('player_queues/')
            ? 'The music player couldn’t complete that action. Please try Play again in a moment.'
            : 'The music service is temporarily unavailable. Please try again in a moment.',
        res.status,
        operation,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new BackendError('Music Assistant returned invalid JSON', 502);
    }
  }
  async verify() {
    if (this.verified) return;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const info = await this.http('/info');
      if (!Number.isInteger(info.schema_version) || info.schema_version < 28)
        throw new BackendError(
          'Unsupported Music Assistant schema; authenticated HTTP API schema 28+ required',
          502,
        );
      if (
        this.config.expectedSchema &&
        info.schema_version !== this.config.expectedSchema
      )
        throw new BackendError(
          'Music Assistant schema differs from MA_EXPECTED_SCHEMA. Verify /api-docs before changing the pin.',
          502,
        );
      this.info = {
        server_version: String(info.server_version ?? 'unknown'),
        schema_version: info.schema_version,
        verifiedAt: new Date().toISOString(),
      };
      this.verified = true;
    })();
    try {
      await this.checking;
    } finally {
      this.checking = null;
    }
  }
  async rpc(command: string, args: Raw = {}, timeoutMs?: number) {
    await this.verify();
    return this.http(
      '/api',
      { message_id: randomUUID(), command, args },
      timeoutMs,
    );
  }
  private artist(raw: Raw) {
    return (
      (raw.artists ?? []).map((a: Raw) => a.name).join(', ') ||
      raw.artist ||
      raw.owner ||
      'Music Assistant'
    );
  }
  private art(raw: Raw) {
    const candidates = [
      ...(raw.metadata?.images ?? []),
      raw.image,
      ...(raw.album?.metadata?.images ?? []),
      raw.album?.image,
    ].filter(Boolean);
    const image =
      candidates.find((i: Raw) => i.type === 'thumb') ?? candidates[0];
    if (!image) return '/art/fallback.svg'; // Never relay arbitrary external URLs; always use MA's image resolver on the server.
    if (image.proxy_id)
      return `/imageproxy/${encodeURIComponent(image.proxy_id)}?size=512`;
    if (image.path && image.provider)
      return `/imageproxy?path=${encodeURIComponent(encodeURIComponent(image.path))}&provider=${encodeURIComponent(image.provider)}&size=512`;
    return '/art/fallback.svg';
  }
  private item(raw: Raw, kind: MediaKind): MusicItem {
    return {
      id: raw.uri,
      uri: raw.uri,
      name: raw.name,
      kind,
      artist: this.artist(raw),
      artwork: this.art(raw),
      provider: raw.provider ?? 'library',
    };
  }
  private track(raw: Raw): Track {
    return {
      id: raw.uri ?? raw.item_id,
      uri: raw.uri,
      name: raw.name ?? 'Unknown track',
      artist: this.artist(raw),
      duration: Number(raw.duration) || 0,
      artwork: this.art(raw),
      albumId: raw.album?.uri,
      sourceUris: [
        ...new Set<string>(
          [
            raw.uri,
            ...(raw.provider_mappings ?? []).flatMap((mapping: Raw) =>
              [mapping.provider_domain, mapping.provider_instance]
                .filter(Boolean)
                .map((provider) => `${provider}://track/${mapping.item_id}`),
            ),
          ].filter(Boolean),
        ),
      ],
    };
  }
  async library(search = '', offset = 0) {
    const result = await Promise.all(
      (['playlist', 'album'] as const).map(async (kind) => {
        const rows = await this.rpc(`music/${kind}s/library_items`, {
          search: search || null,
          limit: 50,
          offset,
        });
        if (!Array.isArray(rows))
          throw new BackendError(
            'Unexpected library response. Verify the running /api-docs.',
            502,
          );
        return rows.map((raw) => this.item(raw, kind));
      }),
    );
    return result.flat();
  }
  async searchCatalog(query: string): Promise<MusicItem[]> {
    const result = await this.rpc(
      'music/search',
      {
        search_query: query,
        media_types: ['album', 'playlist', 'track'],
        limit: 10,
        library_only: false,
      },
      15000,
    );
    if (
      !result ||
      !['albums', 'playlists', 'tracks'].every((key) =>
        Array.isArray(result[key]),
      )
    )
      throw new BackendError(
        'Unexpected catalogue search response. Verify the running /api-docs.',
        502,
      );
    const items = (['album', 'playlist', 'track'] as const).flatMap((kind) =>
      result[`${kind}s`]
        .filter(
          (raw: Raw) =>
            raw.available !== false &&
            typeof raw.uri === 'string' &&
            typeof raw.name === 'string',
        )
        .map((raw: Raw) => this.item(raw, kind)),
    );
    return [...new Map(items.map((item) => [item.id, item])).values()];
  }
  async preview(track: Track, signal: AbortSignal): Promise<Response> {
    const uri = new URL(track.uri);
    const path = await this.rpc(
      'music/tracks/preview',
      {
        provider_instance_id_or_domain: track.uri.slice(
          0,
          track.uri.indexOf(':'),
        ),
        item_id: decodeURIComponent(uri.pathname.replace(/^\//, '')),
      },
      15000,
    );
    if (typeof path === 'string' && /^\/preview\?token=[\w-]+$/.test(path))
      return this.request(this.origin + path, { signal, redirect: 'error' });
    if (typeof path === 'string' && URL.canParse(path)) {
      const url = new URL(path);
      if (url.protocol === 'https:' && !url.username && !url.password)
        return Response.redirect(url);
    }
    throw new BackendError('No audio sample is available for this song', 502);
  }
  async tracks(item: MusicItem) {
    const u = new URL(item.uri),
      // URL.protocol normalizes case, but MA provider instance IDs do not.
      provider = item.uri.slice(0, item.uri.indexOf(':')),
      id = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const args: Raw = { item_id: id, provider_instance_id_or_domain: provider };
    if (item.kind === 'track') {
      const raw = await this.rpc('music/tracks/get', args, 15000);
      if (!raw || raw.media_type !== 'track' || typeof raw.uri !== 'string')
        throw new BackendError(
          'Music Assistant could not resolve this song',
          502,
        );
      const track = this.track(raw);
      if (!track.sourceUris?.includes(item.uri))
        throw new BackendError(
          'Music Assistant returned a different song',
          502,
        );
      return [track];
    }
    if (item.kind === 'album') args.in_library_only = false;
    else args.force_refresh = false;
    const rows = await this.rpc(
      `music/${item.kind}s/${item.kind}_tracks`,
      args,
    );
    if (!Array.isArray(rows))
      throw new BackendError('Unexpected track listing response', 502);
    return rows
      .filter((r: Raw) => !r.media_type || r.media_type === 'track')
      .map((raw) => this.track(raw));
  }
  async resolvePlaylist(uri: string): Promise<MusicItem> {
    const raw = await this.rpc('music/item_by_uri', { uri });
    if (
      !raw ||
      raw.media_type !== 'playlist' ||
      typeof raw.uri !== 'string' ||
      typeof raw.name !== 'string'
    )
      throw new BackendError(
        'Music Assistant could not resolve this Spotify playlist. Check the Spotify provider and playlist access.',
        422,
      );
    return this.item(raw, 'playlist');
  }
  async providers(): Promise<Provider[]> {
    const rows = await this.rpc('providers');
    return rows
      .filter((r: Raw) => !r.type || r.type === 'music')
      .map((r: Raw) => ({
        id: r.instance_id,
        name: r.name ?? r.domain,
        available: !!r.available,
      }));
  }
  async players(): Promise<Player[]> {
    const rows = await this.rpc('players/all');
    return rows.map((r: Raw) => ({
      id: r.player_id,
      name: r.display_name ?? r.name ?? r.player_id,
      available: !!r.available,
      type: 'music-assistant',
    }));
  }
  private async queue(playerId: string) {
    const queue = await this.rpc('player_queues/get_active_queue', {
      player_id: playerId,
    });
    if (!queue?.queue_id)
      throw new BackendError(
        'No active Music Assistant queue is available for this player',
      );
    return String(queue.queue_id);
  }
  async state(playerId: string): Promise<PlaybackState> {
    const players = await this.rpc('players/all');
    const p = players.find((r: Raw) => r.player_id === playerId);
    if (!p?.available)
      return {
        status: 'unavailable',
        connected: false,
        playerId,
        track: null,
        elapsed: 0,
        volume: 0,
        shuffle: false,
        repeat: false,
        collectionId: this.collectionId,
        simulated: false,
      };
    const q = await this.rpc('player_queues/get_active_queue', {
      player_id: playerId,
    });
    const current = q?.current_item;
    const raw = current?.media_item;
    const media = p.current_media;
    let track = raw ? this.track(raw) : null;
    if (!track && media?.title)
      track = {
        id: media.uri ?? 'current',
        uri: media.uri ?? '',
        name: media.title,
        artist: media.artist ?? '',
        duration: Number(media.duration) || 0,
        artwork: '/art/fallback.svg',
      };
    if (track && current?.image) {
      const queueArt = this.art({ image: current.image });
      if (!queueArt.startsWith('/art/')) track.artwork = queueArt;
    }
    const status = p.playback_state ?? p.state ?? q?.state;
    return {
      status:
        status === 'playing'
          ? 'playing'
          : status === 'paused'
            ? 'paused'
            : 'idle',
      connected: true,
      playerId,
      track,
      elapsed: Number(q?.elapsed_time ?? p.elapsed_time) || 0,
      volume: Number(p.volume_level) || 0,
      shuffle: !!q?.shuffle_enabled,
      repeat: q?.repeat_mode === 'all' || q?.repeat_mode === 'one',
      collectionId: this.collectionId,
      simulated: false,
    };
  }
  async queueOrder(playerId: string, tracks: Track[]) {
    const queueId = await this.queue(playerId);
    const rows = await this.rpc('player_queues/items', {
      queue_id: queueId,
      limit: 5000,
      offset: 0,
    });
    if (!Array.isArray(rows)) return tracks;
    return rows.flatMap((row: Raw) => {
      const raw = row.media_item;
      if (!raw) return [];
      const resolved = this.track(raw);
      const found = tracks.find((t) =>
        [t.uri, ...(t.sourceUris ?? [])].some((uri) =>
          resolved.sourceUris?.includes(uri),
        ),
      );
      return found ? [found] : [];
    });
  }
  async configure(s: Settings) {
    if (!s.playerId) return;
    const id = await this.queue(s.playerId);
    await this.rpc('player_queues/shuffle', {
      queue_id: id,
      shuffle_enabled: s.shuffle,
    });
    await this.rpc('player_queues/repeat', {
      queue_id: id,
      repeat_mode: s.repeat ? 'all' : 'off',
    });
    const state = await this.state(s.playerId);
    if (state.volume > s.maxVolume)
      await this.rpc('players/cmd/volume_set', {
        player_id: s.playerId,
        volume_level: s.maxVolume,
      });
  }
  async start(
    item: ApprovedItem,
    tracks: Track[],
    s: Settings,
    startTrackId?: string,
  ) {
    const players = await this.players();
    if (!players.some((p) => p.id === s.playerId && p.available))
      throw new BackendError('Selected playback target is unavailable');
    if (!tracks.length)
      throw new BackendError('No approved playable tracks are available', 422);
    const selected = startTrackId
      ? tracks.find((t) => t.id === startTrackId)
      : undefined;
    if (startTrackId && !selected)
      throw new BackendError('Track is not available in this collection', 403);
    const selectedIndex = selected ? tracks.indexOf(selected) : 0;
    const ordered = [
      ...tracks.slice(selectedIndex),
      ...tracks.slice(0, selectedIndex),
    ];
    const id = await this.queue(s.playerId);
    await this.configure(s);
    await this.rpc('players/cmd/volume_set', {
      player_id: s.playerId,
      volume_level: Math.min(s.startupVolume, s.maxVolume),
    }); // Expand to an explicit approved track list so MA cannot reintroduce hidden tracks.
    await this.rpc(
      'player_queues/play_media',
      {
        queue_id: id,
        media: ordered.map((t) => t.uri),
        option: 'replace',
        ...(selected ? { start_item: selected.uri } : {}),
      },
      this.config.commandTimeoutMs ?? 30_000,
    );
    this.collectionId = item.id;
  }
  async command(
    command: Exclude<PlaybackCommand, { action: 'start' | 'start-sleep' }>,
    s: Settings,
  ) {
    if (command.action === 'volume') {
      await this.rpc('players/cmd/volume_set', {
        player_id: s.playerId,
        volume_level: Math.min(command.volume, s.maxVolume),
      });
      return;
    }
    const id = await this.queue(s.playerId);
    await this.rpc(
      `player_queues/${command.action}`,
      {
        queue_id: id,
        ...(command.action === 'shuffle'
          ? { shuffle_enabled: command.enabled }
          : {}),
        ...(command.action === 'repeat'
          ? { repeat_mode: command.enabled ? 'all' : 'off' }
          : {}),
      },
      this.config.commandTimeoutMs ?? 30_000,
    );
  }
  async artwork(path: string) {
    if (
      !/^\/imageproxy(?:\/[^?#]+\?size=512|\?path=[^&]+&provider=[^&]+&size=512)$/.test(
        path,
      )
    )
      throw new BackendError('Invalid artwork reference', 400);
    let res: Response;
    try {
      res = await this.request(this.origin + path, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new BackendError('Artwork is unavailable');
    }
    if (!res.ok) throw new BackendError('Artwork is unavailable');
    const length = Number(res.headers.get('content-length'));
    if (length > 5_000_000) throw new BackendError('Artwork is too large', 413);
    if (!res.body) throw new BackendError('Empty artwork');
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_000_000) {
        await reader.cancel();
        throw new BackendError('Artwork is too large', 413);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  close() {}
}
