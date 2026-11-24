import { describe, it, expect, vi } from 'vitest';
import { MusicAssistantBackend } from '../src/server/adapters/music-assistant';
import { defaultSettings, type ApprovedItem } from '../src/shared/types';
function fixture() {
  const calls: { path: string; command?: string; args?: any; auth?: string }[] =
    [];
  let fail = false;
  let schema = 101;
  const transport = vi.fn(async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({
      path,
      command: body?.command,
      args: body?.args,
      auth: init?.headers?.Authorization,
    });
    if (fail) throw new Error('Network failed');
    let result: any = null;
    const track = {
      item_id: 't1',
      uri: 'library://track/t1',
      name: 'A local lullaby',
      duration: 120,
      artists: [{ name: 'Example Artist' }],
      metadata: { images: [{ type: 'thumb', proxy_id: 'cover-id' }] },
    };
    if (path === '/preview')
      return new Response('aac clip', {
        headers: { 'Content-Type': 'audio/aac' },
      });
    if (path === '/info')
      result = { server_version: 'test-contract', schema_version: schema };
    else
      switch (body?.command) {
        case 'music/tracks/preview':
          result = '/preview?token=short-lived-token';
          break;
        case 'music/item_by_uri':
          result = {
            media_type: 'playlist',
            uri: body.args.uri,
            name: 'Shared Spotify playlist',
            provider: 'spotify',
          };
          break;
        case 'providers':
          result = [
            {
              instance_id: 'filesystem--one',
              name: 'NAS music',
              available: true,
            },
          ];
          break;
        case 'players/all':
          result = [
            {
              player_id: 'real-speaker',
              display_name: 'Bedroom speaker',
              available: true,
              playback_state: 'playing',
              volume_level: 28,
            },
          ];
          break;
        case 'music/playlists/library_items':
          result = [
            {
              item_id: '1',
              uri: 'library://playlist/1',
              name: 'Bedtime',
              provider: 'library',
              metadata: { images: [{ type: 'thumb', proxy_id: 'cover-id' }] },
            },
          ];
          break;
        case 'music/albums/library_items':
          result = [];
          break;
        case 'music/search':
          result = {
            albums: [],
            playlists: [],
            tracks: [
              {
                ...track,
                uri: 'spotify--MiXeD://track/outside',
                media_type: 'track',
                provider: 'spotify--MiXeD',
                name: 'Outside saved library',
              },
            ],
          };
          break;
        case 'music/tracks/get':
          result = {
            ...track,
            media_type: 'track',
            provider_mappings: [
              {
                provider_domain: 'spotify',
                provider_instance: 'spotify--MiXeD',
                item_id: 'outside',
              },
            ],
          };
          break;
        case 'music/playlists/playlist_tracks':
        case 'music/albums/album_tracks':
          result = [track];
          break;
        case 'player_queues/get_active_queue':
          result = {
            queue_id: 'active-queue',
            state: 'playing',
            elapsed_time: 12,
            current_item: { media_item: track },
            repeat_mode: 'off',
            shuffle_enabled: false,
          };
          break;
      }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    calls,
    transport,
    setFail: (v: boolean) => {
      fail = v;
    },
    setSchema: (v: number) => {
      schema = v;
    },
  };
}
describe('Music Assistant HTTP API contract', () => {
  it('searches provider catalogues and resolves a standalone song through its canonical MA alias', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      f.transport,
    );
    const items = await b.searchCatalog('Outside');
    expect(items).toMatchObject([
      {
        id: 'spotify--MiXeD://track/outside',
        kind: 'track',
        name: 'Outside saved library',
      },
    ]);
    expect(f.calls.find((c) => c.command === 'music/search')?.args).toEqual({
      search_query: 'Outside',
      media_types: ['album', 'playlist', 'track'],
      limit: 10,
      library_only: false,
    });
    const tracks = await b.tracks(items[0]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].sourceUris).toContain(items[0].uri);
    expect(tracks[0].uri).toBe('library://track/t1');
    await expect(
      b.tracks({ ...items[0], uri: 'spotify--MiXeD://track/different' }),
    ).rejects.toThrow('different song');
    expect(f.calls.find((c) => c.command === 'music/tracks/get')?.args).toEqual(
      { item_id: 'outside', provider_instance_id_or_domain: 'spotify--MiXeD' },
    );
    await b.tracks({
      ...items[0],
      kind: 'album',
      uri: 'spotify--MiXeD://album/CaseSensitiveAlbum',
    });
    expect(
      f.calls.find((c) => c.command === 'music/albums/album_tracks')?.args,
    ).toMatchObject({
      item_id: 'CaseSensitiveAlbum',
      provider_instance_id_or_domain: 'spotify--MiXeD',
    });
  });
  it('uses authenticated raw-result JSON RPC and documented library, provider, and queue commands', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example:8095', token: 'server-only-token' },
      f.transport,
    );
    const items = await b.library('Bed', 50);
    expect(items[0].name).toBe('Bedtime');
    expect(items[0].artwork).toBe('/imageproxy/cover-id?size=512');
    expect((await b.providers())[0].available).toBe(true);
    expect((await b.players())[0].type).toBe('music-assistant');
    const state = await b.state('real-speaker');
    expect(state).toMatchObject({
      status: 'playing',
      simulated: false,
      elapsed: 12,
      volume: 28,
    });
    expect(state.track?.name).toBe('A local lullaby');
    expect(f.calls.every((c) => c.auth === 'Bearer server-only-token')).toBe(
      true,
    );
    expect(
      f.calls.find((c) => c.command === 'music/playlists/library_items')?.args,
    ).toEqual({ search: 'Bed', limit: 50, offset: 50 });
  });
  it('expands only approved tracks, uses active queue, and clamps volume', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      f.transport,
    );
    const item = {
      ...(await b.library())[0],
      displayName: 'Bedtime',
      position: 0,
      artworkOverride: null,
      hiddenTrackIds: [],
    } as ApprovedItem;
    const tracks = await b.tracks(item);
    expect(
      f.calls.find((c) => c.command === 'music/playlists/playlist_tracks')
        ?.args,
    ).toEqual({
      item_id: '1',
      provider_instance_id_or_domain: 'library',
      force_refresh: false,
    });
    const s = { ...defaultSettings, playerId: 'real-speaker', maxVolume: 30 };
    await b.start(item, tracks, s);
    expect(
      f.calls.find((c) => c.command === 'player_queues/play_media')?.args,
    ).toEqual({
      queue_id: 'active-queue',
      media: ['library://track/t1'],
      option: 'replace',
    });
    await b.command({ action: 'volume', volume: 100 }, s);
    expect(f.calls.at(-1)?.args).toEqual({
      player_id: 'real-speaker',
      volume_level: 30,
    });
    for (const action of [
      'play',
      'pause',
      'stop',
      'next',
      'previous',
    ] as const) {
      await b.command({ action }, s);
      expect(f.calls.at(-1)?.command).toBe(`player_queues/${action}`);
      expect(f.calls.at(-1)?.args.queue_id).toBe('active-queue');
    }
  });
  it('reports compatibility mismatch and recovers after transient network failures', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private', expectedSchema: 101 },
      f.transport,
    );
    await b.providers();
    f.setFail(true);
    await expect(b.players()).rejects.toThrow('unreachable');
    f.setFail(false);
    await expect(b.players()).resolves.toHaveLength(1);
    expect(f.calls.filter((c) => c.path === '/info')).toHaveLength(2);
    const wrong = fixture();
    wrong.setSchema(102);
    await expect(
      new MusicAssistantBackend(
        { url: 'http://ma.example', token: 'private', expectedSchema: 101 },
        wrong.transport,
      ).verify(),
    ).rejects.toThrow('schema differs');
  });
  it('sanitises upstream authentication errors and never retries mutation commands', async () => {
    const transport = vi.fn(async (url: any) =>
      new URL(String(url)).pathname === '/info'
        ? new Response(JSON.stringify({ schema_version: 101 }))
        : new Response('secret-token-in-upstream-error', { status: 403 }),
    ) as unknown as typeof fetch;
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      transport,
    );
    await expect(b.players()).rejects.toThrow('authentication or permissions');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('Music Assistant selected songs and shared playlists', () => {
  it('resolves a playlist with the documented item_by_uri command', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      f.transport,
    );
    const uri = 'spotify://playlist/37i9dQZF1DXcBWIGoYBM5M';
    const item = await b.resolvePlaylist(uri);
    expect(item.name).toBe('Shared Spotify playlist');
    expect(f.calls.at(-1)).toMatchObject({
      command: 'music/item_by_uri',
      args: { uri },
    });
  });
  it('uses start_item to choose a song without removing the approved queue', async () => {
    const f = fixture();
    const b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      f.transport,
    );
    const item = {
      ...(await b.library())[0],
      displayName: 'Music',
      position: 0,
      artworkOverride: null,
      hiddenTrackIds: [],
    } as ApprovedItem;
    const tracks = await b.tracks(item);
    await b.start(
      item,
      tracks,
      { ...defaultSettings, playerId: 'real-speaker' },
      tracks[0].id,
    );
    expect(
      f.calls.find((c) => c.command === 'player_queues/play_media')?.args,
    ).toMatchObject({
      media: [tracks[0].uri],
      start_item: tracks[0].uri,
      option: 'replace',
    });
  });
});

it('orders a selected middle song first because start_item does not reposition explicit track lists', async () => {
  const f = fixture();
  const b = new MusicAssistantBackend(
    { url: 'http://ma.example', token: 'private' },
    f.transport,
  );
  const item = {
    ...(await b.library())[0],
    displayName: 'Music',
    position: 0,
    artworkOverride: null,
    hiddenTrackIds: [],
  } as ApprovedItem;
  const base = (await b.tracks(item))[0];
  const tracks = [0, 1, 2].map((i) => ({
    ...base,
    id: `track-${i}`,
    uri: `library://track/${i}`,
  }));
  await b.start(
    item,
    tracks,
    { ...defaultSettings, playerId: 'real-speaker' },
    tracks[1].id,
  );
  expect(
    f.calls.find((c) => c.command === 'player_queues/play_media')?.args,
  ).toMatchObject({
    media: [tracks[1].uri, tracks[2].uri, tracks[0].uri],
    start_item: tracks[1].uri,
  });
});

it('uses album artwork when a track or its queue item has no own image', async () => {
  const transport = async (url: any, init: any) => {
    const command = init?.body ? JSON.parse(init.body).command : '';
    const raw = {
      uri: 'library://track/2',
      name: 'A song',
      duration: 200,
      metadata: { images: [] },
      album: {
        uri: 'library://album/1',
        image: { type: 'thumb', proxy_id: 'album-cover' },
      },
    };
    const result = String(url).endsWith('/info')
      ? { schema_version: 65 }
      : command === 'music/playlists/playlist_tracks'
        ? [raw]
        : command === 'players/all'
          ? [
              {
                player_id: 'speaker',
                available: true,
                playback_state: 'playing',
              },
            ]
          : command === 'player_queues/get_active_queue'
            ? { queue_id: 'queue', current_item: { media_item: raw } }
            : [];
    return new Response(JSON.stringify(result));
  };
  const b = new MusicAssistantBackend(
    { url: 'http://ma.example', token: 'private' },
    transport as typeof fetch,
  );
  const item = {
    id: 'list',
    uri: 'library://playlist/1',
    name: 'Playlist',
    kind: 'playlist' as const,
    artist: 'Various',
    artwork: '',
    provider: 'library',
  };
  expect((await b.tracks(item))[0].artwork).toBe(
    '/imageproxy/album-cover?size=512',
  );
  expect((await b.state('speaker')).track?.artwork).toBe(
    '/imageproxy/album-cover?size=512',
  );
});

it('retains provider identities used to match queued tracks to approved tracks', async () => {
  const transport: typeof fetch = async (url, init) => {
    const command = init?.body ? JSON.parse(String(init.body)).command : '';
    const raw = {
      uri: 'library://track/42',
      name: 'Approved song',
      provider_mappings: [
        {
          provider_domain: 'spotify',
          provider_instance: 'spotify--account',
          item_id: 'song-id',
        },
      ],
    };
    const result = String(url).endsWith('/info')
      ? { schema_version: 65 }
      : command === 'music/playlists/playlist_tracks'
        ? [raw]
        : [];
    return new Response(JSON.stringify(result));
  };
  const b = new MusicAssistantBackend(
    { url: 'http://ma.example', token: 'private' },
    transport,
  );
  const [track] = await b.tracks({
    id: 'list',
    uri: 'library://playlist/1',
    kind: 'playlist',
    name: 'List',
    artist: '',
    artwork: '',
    provider: 'library',
  });
  expect(track.sourceUris).toEqual([
    'library://track/42',
    'spotify://track/song-id',
    'spotify--account://track/song-id',
  ]);
});

it('allows slower playback starts and reports a lost acknowledgement without retrying', async () => {
  const fixtureData = fixture();
  let starts = 0;
  const transport: typeof fetch = async (url, init) => {
    const command = init?.body ? JSON.parse(String(init.body)).command : '';
    if (command === 'player_queues/play_media') {
      starts++;
      throw new DOMException('Timed out', 'TimeoutError');
    }
    return fixtureData.transport(url, init);
  };
  const b = new MusicAssistantBackend(
    { url: 'http://ma.example', token: 'private', commandTimeoutMs: 30000 },
    transport,
  );
  const item = {
    ...(await b.library())[0],
    displayName: 'List',
    position: 0,
    hiddenTrackIds: [],
    artworkOverride: null,
  };
  const tracks = await b.tracks(item);
  await expect(
    b.start(item, tracks, { ...defaultSettings, playerId: 'real-speaker' }),
  ).rejects.toThrow('Playback may already have started');
  expect(starts).toBe(1);
  expect(
    () =>
      new MusicAssistantBackend({
        url: 'http://ma.example',
        token: 'private',
        commandTimeoutMs: 50000,
      }),
  ).toThrow('MA_COMMAND_TIMEOUT_MS');
});
it('sends explicit shuffle and playlist-repeat changes to the selected queue without restarting media', async () => {
  const f = fixture(),
    b = new MusicAssistantBackend(
      { url: 'http://ma.example', token: 'private' },
      f.transport,
    );
  await b.command({ action: 'shuffle', enabled: true }, defaultSettings);
  await b.command({ action: 'repeat', enabled: true }, defaultSettings);
  await b.command({ action: 'repeat', enabled: false }, defaultSettings);
  expect(
    f.calls
      .filter((c) => c.command === 'player_queues/shuffle')
      .map((c) => c.args),
  ).toEqual([{ queue_id: 'active-queue', shuffle_enabled: true }]);
  expect(
    f.calls
      .filter((c) => c.command === 'player_queues/repeat')
      .map((c) => c.args),
  ).toEqual([
    { queue_id: 'active-queue', repeat_mode: 'all' },
    { queue_id: 'active-queue', repeat_mode: 'off' },
  ]);
  expect(f.calls.some((c) => c.command === 'player_queues/play_media')).toBe(
    false,
  );
});

it('keeps server HTTP failures actionable for users and retains safe operation diagnostics', async () => {
  const { MusicAssistantError } =
    await import('../src/server/adapters/music-assistant');
  const transport = vi.fn(
    async (url: any) =>
      new Response(
        new URL(String(url)).pathname === '/info'
          ? JSON.stringify({ schema_version: 65 })
          : 'private upstream traceback',
        { status: new URL(String(url)).pathname === '/info' ? 200 : 500 },
      ),
  ) as unknown as typeof fetch;
  const backend = new MusicAssistantBackend(
    { url: 'http://ma.example', token: 'private' },
    transport,
  );
  const error = await backend
    .rpc('players/cmd/volume_set', { player_id: 'native', volume_level: 25 })
    .catch((e) => e);
  expect(error).toBeInstanceOf(MusicAssistantError);
  expect(error).toMatchObject({
    upstreamStatus: 500,
    operation: 'players/cmd/volume_set',
    status: 503,
  });
  expect(error.message).toContain('try Play again');
  expect(error.message).not.toMatch(/HTTP|compatibility|traceback|private/);
});

it('requests a short hosted preview without touching a playback queue', async () => {
  const f = fixture();
  const backend = new MusicAssistantBackend(
    { url: 'http://ma.local:8095', token: 'fixture-token' },
    f.transport,
  );
  const sample = await backend.preview(
    {
      id: 'track',
      uri: 'filesystem--MiXeD://track/Quiet%20room.mp3',
      name: 'Quiet room',
      artist: '',
      artwork: '/art/fallback.svg',
      duration: 180,
    },
    AbortSignal.timeout(1000),
  );
  expect(sample.headers.get('content-type')).toBe('audio/aac');
  expect(await sample.text()).toBe('aac clip');
  expect(f.calls.slice(1)).toEqual([
    {
      path: '/api',
      auth: 'Bearer fixture-token',
      command: 'music/tracks/preview',
      args: {
        item_id: 'Quiet room.mp3',
        provider_instance_id_or_domain: 'filesystem--MiXeD',
      },
    },
    {
      path: '/preview',
      auth: undefined,
      command: undefined,
      args: undefined,
    },
  ]);
});
