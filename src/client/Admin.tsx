import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Disc3,
  ExternalLink,
  GripVertical,
  LayoutGrid,
  ListMusic,
  LogOut,
  Monitor,
  Moon,
  Music2,
  Pause,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SkipForward,
  Sun,
  Trash2,
  Upload,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovedItem,
  MusicItem,
  Player,
  Provider,
  Settings,
  Track,
  MediaKind,
} from '../shared/types';
import { api, send } from './api';
import { art, Brand, Cover, ErrorNotice, IconButton, time } from './components';
import { useLive, useSession } from './hooks';
import { ParentLogin } from './ParentLogin';
import { SettingsForm } from './SettingsForm';
import { SpotifyImport } from './SpotifyImport';
import { MusicAssistantPanel } from './MusicAssistantPanel';
import { ProfilesPanel } from './ProfilesPanel';
import { AudioSample } from './AudioSample';
import { LibraryPreview } from './LibraryPreview';
import { trackHidden } from '../shared/music';
type Tab =
  | 'collection'
  | 'library'
  | 'settings'
  | 'device'
  | 'integration'
  | 'profiles'
  | 'sleep';
export function Admin() {
  const auth = useSession('parent');
  const live = useLive('parent', !!auth.session?.authenticated);
  const [tab, setTab] = useState<Tab>('collection');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [searchScope, setSearchScope] = useState<'catalogue' | 'library'>(
    'catalogue',
  );
  const [mediaFilter, setMediaFilter] = useState<'all' | MediaKind>('all');
  const pendingBrowse = useRef<AbortController | null>(null);
  const [library, setLibrary] = useState<MusicItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const focusSleepSettings = useRef(false);
  const [devices, setDevices] = useState<{
    players: Player[];
    providers: Provider[];
    compatibility?: { server_version?: string; schema_version?: number };
    screenAcknowledgement: boolean | null;
  } | null>(null);
  const [logs, setLogs] = useState<{ time: string; message: string }[]>([]);
  const [edit, setEdit] = useState<ApprovedItem | null>(null);
  const [preview, setPreview] = useState<MusicItem | null>(null);
  const [sleepSample, setSleepSample] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const drag = useRef<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, success = '') => {
    setError('');
    setMessage('');
    try {
      await fn();
      if (success) setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const browse = useCallback(
    async (query: string, page = 0) => {
      pendingBrowse.current?.abort();
      const controller = new AbortController();
      pendingBrowse.current = controller;
      setLoading(true);
      try {
        const catalogue = query.trim() && searchScope === 'catalogue';
        const items = await api<MusicItem[]>(
          catalogue
            ? `/api/admin/search?search=${encodeURIComponent(query.trim())}`
            : `/api/admin/library?search=${encodeURIComponent(query)}&offset=${page}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20000),
            ]),
          },
        );
        if (controller.signal.aborted) return;
        setLibrary(items);
        setOffset(page);
        setError('');
      } catch (e) {
        if (controller.signal.aborted) return;
        setError((e as Error).message);
      } finally {
        if (pendingBrowse.current === controller) setLoading(false);
      }
    },
    [searchScope],
  );
  useEffect(() => () => pendingBrowse.current?.abort(), []);
  useEffect(() => {
    if (!auth.session?.authenticated) return;
    if (tab === 'library') {
      const t = setTimeout(() => void browse(search), 500);
      return () => {
        clearTimeout(t);
        pendingBrowse.current?.abort();
      };
    }
    if (tab === 'settings')
      void run(async () => setSettings(await api('/api/admin/settings')));
    if (tab === 'device')
      void run(async () => {
        const [d, l] = await Promise.all([
          api<typeof devices>('/api/admin/devices'),
          api<typeof logs>('/api/admin/logs'),
        ]);
        setDevices(d);
        setLogs(l);
      });
  }, [tab, search, auth.session?.authenticated, browse, run]);
  useEffect(() => {
    if (tab === 'settings' && settings && focusSleepSettings.current) {
      focusSleepSettings.current = false;
      document.getElementById('sleep-music-settings')?.scrollIntoView();
    }
  }, [tab, settings]);
  async function openEdit(item: ApprovedItem) {
    setEdit({ ...item });
    setTracks([]);
    await run(async () =>
      setTracks(
        await api(`/api/admin/tracks?id=${encodeURIComponent(item.id)}`),
      ),
    );
  }
  const collection = live.state?.collection ?? [];
  const sleepSongs = live.state?.sleepSongs ?? [];
  async function reorder(from: string, to: string) {
    const ids = collection.map((i) => i.id);
    const start = ids.indexOf(from),
      end = ids.indexOf(to);
    if (start < 0 || end < 0 || start === end) return;
    ids.splice(end, 0, ...ids.splice(start, 1));
    await run(() => send('/api/admin/collection/order', { ids }, 'PUT'));
  }
  if (!auth.session)
    return (
      <div className="center-page">
        <Brand />
        <p>{auth.error || 'Opening Parent controls…'}</p>
        {auth.error && (
          <button onClick={() => void auth.reload()}>Try again</button>
        )}
      </div>
    );
  if (!auth.session.authenticated)
    return (
      <ParentLogin
        setupRequired={!!auth.session.setupRequired}
        onLogin={auth.accept}
      />
    );
  const p = live.state?.playback;
  const catalogueSearch = !!search.trim() && searchScope === 'catalogue';
  const visibleLibrary =
    catalogueSearch && mediaFilter !== 'all'
      ? library.filter((item) => item.kind === mediaFilter)
      : library;
  return (
    <div className="admin-page">
      <aside className="admin-sidebar">
        <a className="brand-link" href="/simulator">
          <Brand small />
        </a>
        <div className="parent-badge">
          <ShieldCheck size={16} /> PARENT SPACE
        </div>
        <p className="sidebar-caption">
          A library you manage. Music they choose.
        </p>
        <nav>
          {(
            [
              [LayoutGrid, 'collection', 'Music library'],
              [Search, 'library', 'Browse library'],
              [Moon, 'sleep', 'Sleep Music'],
              [Users, 'profiles', 'Children & preferences'],
              [Radio, 'integration', 'Music Assistant'],
              [Settings2, 'settings', 'Settings & bedtime'],
              [Monitor, 'device', 'Device & diagnostics'],
            ] as [LucideIcon, Tab, string][]
          ).map(([Icon, key, label]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => {
                if (key !== tab) setSettings(null);
                setTab(key);
                setError('');
                setMessage('');
              }}
            >
              <Icon size={20} />
              {label}
              {key === 'collection' && <small>{collection.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="/simulator">
            <Monitor size={18} /> Open simulator <ExternalLink size={14} />
          </a>
          <a href="/child" target="_blank" rel="noreferrer">
            <Music2 size={18} /> Open child player <ExternalLink size={14} />
          </a>
          <button
            onClick={() =>
              void run(async () => {
                await send('/api/auth/logout', {});
                await auth.reload();
              })
            }
          >
            <LogOut size={18} /> Log out
          </button>
          <span>SELF-HOSTED. PARENT-APPROVED.</span>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-top">
          <span>{live.state?.device.name ?? 'Kids Music Hub'}</span>
          <span className={`connection ${!live.online ? 'offline' : ''}`}>
            {live.online ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
            {live.online ? 'Hub online' : 'Reconnecting'}
          </span>
        </header>
        <div className="admin-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR MUSIC. HER CHOICE.</p>
              <h1>
                {tab === 'sleep'
                  ? 'Sleep Music list'
                  : tab === 'collection'
                    ? 'The music library.'
                    : tab === 'library'
                      ? 'Find their next favourite.'
                      : tab === 'settings'
                        ? 'Playback & screen settings.'
                        : tab === 'integration'
                          ? 'Music Assistant.'
                          : tab === 'profiles'
                            ? 'Children & their music.'
                            : 'Meet the music hub.'}
              </h1>
              <p>
                {tab === 'sleep'
                  ? 'Children can choose one song to repeat until the Sleep Music stop time.'
                  : tab === 'collection'
                    ? 'Only the music you choose. Always within reach.'
                    : tab === 'library'
                      ? 'Browse your music backend, then choose what belongs on their shelf.'
                      : tab === 'settings'
                        ? 'Playback preferences, volume limits and screen schedules.'
                        : tab === 'integration'
                          ? 'Your music sources, server connection and playback target.'
                          : tab === 'profiles'
                            ? 'Profiles, favourites and blocked songs.'
                            : 'Playback, connections and a few helpful details.'}
              </p>
            </div>
            {tab === 'collection' && (
              <button
                className="button primary"
                onClick={() => setTab('library')}
              >
                <Plus size={18} /> Add music
              </button>
            )}
          </div>
          <ErrorNotice
            message={error || live.error}
            onClose={() => setError('')}
          />
          {message && (
            <div className="success" role="status">
              <Check size={17} />
              {message}
            </div>
          )}
          {tab === 'profiles' && <ProfilesPanel />}
          {tab === 'sleep' && (
            <section className="panel">
              <button
                className="button primary"
                onClick={() => setTab('library')}
              >
                <Plus size={17} /> Browse for songs
              </button>
              <button
                className="button"
                onClick={() => {
                  focusSleepSettings.current = true;
                  setTab('settings');
                }}
              >
                <Settings2 size={17} /> Morning stop time
              </button>
              {!sleepSongs.length && (
                <p>
                  Open a track preview in Browse library to listen and add
                  songs.
                </p>
              )}
              {!!sleepSongs.length && (
                <ul className="sleep-song-list">
                  {sleepSongs.map((song) => (
                    <li key={song.id}>
                      <Cover src={song.artwork} alt="" />
                      <div>
                        <strong>{song.name}</strong>
                        <p>{song.artist}</p>
                        <div className="sleep-track-actions">
                          {live.state?.backend === 'music-assistant' && (
                            <button
                              className="button"
                              onClick={() =>
                                setSleepSample(
                                  sleepSample === song.id ? null : song.id,
                                )
                              }
                            >
                              {sleepSample === song.id
                                ? 'Close sample'
                                : 'Listen to sample'}
                            </button>
                          )}
                          <button
                            className="button"
                            aria-label={`Remove ${song.name} from Sleep Music`}
                            onClick={() =>
                              void run(async () => {
                                const updated = await send<Track[]>(
                                  `/api/admin/sleep-music/${encodeURIComponent(song.id)}`,
                                  {},
                                  'DELETE',
                                );
                                if (live.state)
                                  live.update({
                                    ...live.state,
                                    sleepSongs: updated,
                                  });
                              }, 'Removed from Sleep Music')
                            }
                          >
                            <Trash2 size={16} /> Remove
                          </button>
                        </div>
                        {sleepSample === song.id && (
                          <AudioSample
                            query={new URLSearchParams({
                              songId: song.id,
                            }).toString()}
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {tab === 'collection' && (
            <>
              <div className="collection-summary">
                <div>
                  <span className="summary-icon">
                    <Disc3 />
                  </span>
                  <span>
                    <strong>{collection.length} collections</strong>
                    <small>Albums and playlists approved by you</small>
                  </span>
                </div>
                <span>
                  <GripVertical size={17} /> Drag to rearrange · or use the
                  arrows
                </span>
              </div>
              <div className="approved-list">
                {collection.map((item, index) => (
                  <article
                    key={item.id}
                    className="approved-row"
                    draggable
                    onDragStart={() => {
                      drag.current = item.id;
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag.current) void reorder(drag.current, item.id);
                      drag.current = null;
                    }}
                  >
                    <GripVertical className="drag-handle" size={19} />
                    <Cover src={art(item)} alt={item.displayName} />
                    <div className="approved-info">
                      <strong>{item.displayName}</strong>
                      <small>
                        {item.kind === 'album'
                          ? 'Album'
                          : item.kind === 'track'
                            ? 'Song'
                            : 'Playlist'}{' '}
                        <span>·</span> {item.artist}
                      </small>
                      <span className="approved-tag">
                        <ShieldCheck size={12} /> Approved for their shelf
                      </span>
                    </div>
                    <div className="order-buttons">
                      <IconButton
                        icon={ChevronUp}
                        label={`Move ${item.displayName} up`}
                        disabled={index === 0}
                        onClick={() =>
                          void reorder(item.id, collection[index - 1].id)
                        }
                      />
                      <IconButton
                        icon={ChevronDown}
                        label={`Move ${item.displayName} down`}
                        disabled={index === collection.length - 1}
                        onClick={() =>
                          void reorder(item.id, collection[index + 1].id)
                        }
                      />
                    </div>
                    <button
                      className="button subtle"
                      onClick={() => void openEdit(item)}
                    >
                      Edit
                    </button>
                    <IconButton
                      className="remove-button"
                      icon={Trash2}
                      label={`Remove ${item.displayName}`}
                      onClick={() =>
                        void run(
                          () =>
                            api(
                              `/api/admin/collection/${encodeURIComponent(item.id)}`,
                              { method: 'DELETE' },
                            ),
                          'Removed from their shelf',
                        )
                      }
                    />
                  </article>
                ))}
              </div>
              {!collection.length && (
                <div className="empty-shelf">
                  <Music2 size={42} />
                  <h2>Build their music library.</h2>
                  <p>Start by choosing a few songs, albums or playlists.</p>
                  <button
                    className="button primary"
                    onClick={() => setTab('library')}
                  >
                    Browse library <ArrowRight size={17} />
                  </button>
                </div>
              )}
              <div className="gentle-note">
                <ShieldCheck size={21} />
                <p>
                  Each player only shows this collection. Removing music here
                  also stops it if it’s currently playing.
                </p>
              </div>
            </>
          )}
          {tab === 'library' && (
            <>
              <SpotifyImport
                approvedIds={collection.map((i) => i.id)}
                onPreview={setPreview}
                onApproved={() => setMessage('Playlist added to their library')}
              />
              <div className="library-tools">
                <label className="search-field">
                  <Search size={20} />
                  <input
                    aria-label="Search songs, albums and playlists"
                    placeholder="Search songs, artists, albums, playlists…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <label>
                  Search in{' '}
                  <select
                    aria-label="Search source"
                    value={searchScope}
                    onChange={(event) =>
                      setSearchScope(
                        event.target.value as 'catalogue' | 'library',
                      )
                    }
                  >
                    <option value="catalogue">
                      Spotify & connected services
                    </option>
                    <option value="library">
                      Saved Music Assistant library
                    </option>
                  </select>
                </label>
                {catalogueSearch && (
                  <label>
                    Show{' '}
                    <select
                      aria-label="Result type"
                      value={mediaFilter}
                      onChange={(event) =>
                        setMediaFilter(event.target.value as 'all' | MediaKind)
                      }
                    >
                      <option value="all">All music</option>
                      <option value="track">Songs</option>
                      <option value="album">Albums</option>
                      <option value="playlist">Playlists</option>
                    </select>
                  </label>
                )}
                <span className="demo-pill">
                  {live.state?.backend === 'mock'
                    ? 'DEMO LIBRARY · NO AUDIO'
                    : catalogueSearch
                      ? 'MUSIC CATALOGUE'
                      : 'SAVED MUSIC LIBRARY'}
                </span>
              </div>
              {loading ? (
                <p className="muted">
                  {catalogueSearch
                    ? 'Searching music services…'
                    : 'Loading your library…'}
                </p>
              ) : (
                <div className="admin-music-grid">
                  {visibleLibrary.map((item) => {
                    const approved = collection.some((i) => i.id === item.id);
                    return (
                      <article className="browse-card" key={item.id}>
                        <Cover src={item.artwork} alt={item.name} />
                        <div>
                          <span className="eyebrow">
                            {item.kind === 'track' ? 'Song' : item.kind}
                          </span>
                          <h3>{item.name}</h3>
                          <p>{item.artist}</p>
                          <button
                            className="button preview-button"
                            aria-label={`View tracks in ${item.name}`}
                            onClick={() => setPreview(item)}
                          >
                            <ListMusic size={17} /> View tracks
                          </button>
                          <button
                            className={`button ${approved ? 'approved-button' : 'primary'}`}
                            disabled={approved}
                            onClick={() =>
                              void run(
                                () =>
                                  send('/api/admin/collection', {
                                    id: item.id,
                                  }),
                                'Added to their music shelf',
                              )
                            }
                          >
                            {approved ? (
                              <Check size={17} />
                            ) : (
                              <Plus size={17} />
                            )}{' '}
                            {approved
                              ? 'On their shelf'
                              : `Approve ${item.name}`}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {!loading && !visibleLibrary.length && (
                <div className="empty-shelf">
                  <Disc3 size={42} />
                  <h2>No music found here yet.</h2>
                  <p>
                    Try another search, or add music providers in Music
                    Assistant.
                  </p>
                </div>
              )}
              {catalogueSearch && (
                <p className="muted">
                  Searches the connected music catalogues, beyond your saved
                  library. Up to 10 results per type; refine your search for
                  more. Preview and approve music before it appears on her
                  shelf.
                </p>
              )}
              {!catalogueSearch &&
                live.state?.backend === 'music-assistant' && (
                  <div className="pagination">
                    <button
                      disabled={offset === 0 || loading}
                      onClick={() =>
                        void browse(search, Math.max(0, offset - 50))
                      }
                    >
                      Previous page
                    </button>
                    <span>Library offset {offset}</span>
                    <button
                      disabled={loading || library.length === 0}
                      onClick={() => void browse(search, offset + 50)}
                    >
                      Next page
                    </button>
                  </div>
                )}
            </>
          )}
          {tab === 'integration' && <MusicAssistantPanel />}
          {tab === 'settings' && settings && (
            <SettingsForm
              settings={settings}
              onChange={setSettings}
              onSave={() =>
                void run(
                  () => send('/api/admin/settings', settings, 'PUT'),
                  'Settings saved',
                )
              }
              onPair={() =>
                void run(
                  () => send('/api/admin/pair', {}),
                  'This browser is paired. Open the simulator or child player.',
                )
              }
              onRevoke={() =>
                void run(
                  () => send('/api/admin/revoke-devices', {}),
                  'All child browser pairings revoked',
                )
              }
            />
          )}
          {tab === 'device' && (
            <>
              <div className="device-cards">
                <section className="panel">
                  <h2>
                    <Monitor size={22} /> The player
                  </h2>
                  {live.state?.independentPlayback ? (
                    <>
                      <p>Each paired player has its own music and controls.</p>
                      <button
                        className="button"
                        onClick={() => setTab('profiles')}
                      >
                        Manage paired players
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="status-row">
                        <span
                          className={`status-dot ${live.state?.device.online ? '' : 'disconnected'}`}
                        />
                        {live.state?.device.online
                          ? 'Child browser online'
                          : 'No recent child heartbeat'}
                      </p>
                      <p className="muted">
                        {live.state?.device.lastSeen
                          ? `Last seen ${new Date(live.state.device.lastSeen).toLocaleString()}`
                          : 'Pair and open the child player to connect.'}
                      </p>
                      <p>
                        Target:{' '}
                        <strong>
                          {devices?.players.find((d) => d.id === p?.playerId)
                            ?.name ??
                            p?.playerId ??
                            'Not selected'}
                        </strong>
                      </p>
                      <p>
                        {p?.track?.name ?? 'Nothing playing'} ·{' '}
                        {p?.status ?? 'unavailable'}
                      </p>
                      <div className="remote-controls">
                        {(
                          [
                            ['play', Play, 'Resume'],
                            ['pause', Pause, 'Pause'],
                            ['stop', Power, 'Stop'],
                            ['next', SkipForward, 'Next'],
                          ] as [string, LucideIcon, string][]
                        ).map(([action, Icon, label]) => (
                          <IconButton
                            key={action}
                            icon={Icon}
                            label={`Remote ${label}`}
                            onClick={() =>
                              void run(() =>
                                send('/api/admin/playback', { action }),
                              )
                            }
                          />
                        ))}
                        <label>
                          Volume{' '}
                          <input
                            aria-label="Remote volume"
                            type="range"
                            min="0"
                            max={live.state?.settings.maxVolume ?? 60}
                            value={Math.min(
                              p?.volume ?? 0,
                              live.state?.settings.maxVolume ?? 60,
                            )}
                            onChange={(e) =>
                              void run(() =>
                                send('/api/admin/playback', {
                                  action: 'volume',
                                  volume: Number(e.target.value),
                                }),
                              )
                            }
                          />
                        </label>
                      </div>
                    </>
                  )}
                </section>
                <section className="panel">
                  <h2>
                    <Moon size={22} /> Bedroom screen
                  </h2>
                  <p>
                    {live.state?.device.screenOff
                      ? 'Display blanked'
                      : 'Display awake'}
                  </p>
                  <div className="screen-buttons">
                    <button
                      className="button primary"
                      onClick={() =>
                        void run(
                          () => send('/api/admin/screen', { mode: 'off' }),
                          'Screen blanking requested',
                        )
                      }
                    >
                      <Moon size={17} /> Blank screen
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        void run(
                          () => send('/api/admin/screen', { mode: 'on' }),
                          'Screen wake requested',
                        )
                      }
                    >
                      <Sun size={17} /> Wake screen
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        void run(
                          () => send('/api/admin/screen', { mode: 'auto' }),
                          'Night schedule restored',
                        )
                      }
                    >
                      Use schedule
                    </button>
                  </div>
                  <p className="muted">
                    The Lenovo controls its backlight through Fully. A manual
                    override stays active until you choose “Use schedule”.
                  </p>
                  <p className="muted">
                    Last display report:{' '}
                    {devices?.screenAcknowledgement === null
                      ? 'not reported'
                      : devices?.screenAcknowledgement
                        ? 'blanked'
                        : 'awake'}
                  </p>
                </section>
              </div>
              <section className="panel">
                <h2>
                  <Radio size={22} /> Music connections
                </h2>
                {devices?.providers.map((d) => (
                  <div className="provider-row" key={d.id}>
                    <span>{d.name}</span>
                    <span
                      className={`connection ${d.available ? '' : 'offline'}`}
                    >
                      {d.available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                ))}
                {devices?.compatibility && (
                  <p>
                    Music Assistant {devices.compatibility.server_version} ·
                    schema {devices.compatibility.schema_version}
                  </p>
                )}
                <p className="muted">
                  Choose This device’s speakers for browser playback. A song tap
                  moves sound to that device. External Music Assistant speakers
                  can be selected here.
                </p>
                <button
                  className="button"
                  onClick={() =>
                    void run(async () => {
                      setDevices(await api('/api/admin/devices'));
                      setLogs(await api('/api/admin/logs'));
                    })
                  }
                >
                  <RefreshCw size={16} /> Refresh connections
                </button>
              </section>
              <section className="panel">
                <h2>Recent activity</h2>
                <div className="diagnostic-log">
                  {logs.map((l, i) => (
                    <div key={i}>
                      <time>{new Date(l.time).toLocaleTimeString()}</time>
                      <span>{l.message}</span>
                    </div>
                  ))}
                  {!logs.length && <p>No diagnostic entries yet.</p>}
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      {preview && (
        <LibraryPreview
          key={preview.id}
          item={preview}
          approved={collection.some((i) => i.id === preview.id)}
          onClose={() => setPreview(null)}
          onApproved={() => setMessage('Added to their music shelf')}
          sleepSongs={sleepSongs}
          canSample={live.state?.backend === 'music-assistant'}
          onSleepAdded={(songs) => {
            if (live.state) live.update({ ...live.state, sleepSongs: songs });
            setMessage('Added to Sleep Music');
          }}
        />
      )}
      {edit && (
        <div className="modal-shade">
          <section
            className="edit-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit approved music"
          >
            <header>
              <h2>Edit music details</h2>
              <IconButton
                icon={X}
                label="Close editor"
                onClick={() => setEdit(null)}
              />
            </header>
            <Cover className="edit-cover" src={art(edit)} />
            <label>
              Display name
              <input
                aria-label="Display name"
                value={edit.displayName}
                maxLength={100}
                onChange={(e) =>
                  setEdit({ ...edit, displayName: e.target.value })
                }
              />
            </label>
            <label className="upload-button">
              <Upload size={18} /> Choose cover artwork
              <input
                type="file"
                aria-label="Upload cover artwork"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void run(async () => {
                      const result = await api<{ url: string }>(
                        '/api/admin/artwork',
                        {
                          method: 'POST',
                          body: file,
                          headers: { 'Content-Type': file.type },
                        },
                      );
                      setEdit({ ...edit, artworkOverride: result.url });
                    });
                }}
              />
            </label>
            {edit.artworkOverride && (
              <button
                className="text-button"
                onClick={() => setEdit({ ...edit, artworkOverride: null })}
              >
                Use original artwork
              </button>
            )}
            <h3>Tracks on their shelf</h3>
            <p className="muted">
              Untick tracks to hide them. Changing track approvals stops this
              collection if it is playing.
            </p>
            <div className="track-list">
              {tracks.map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={!trackHidden(edit.hiddenTrackIds, t)}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        hiddenTrackIds: e.target.checked
                          ? edit.hiddenTrackIds.filter(
                              (id) => !trackHidden([id], t),
                            )
                          : [...edit.hiddenTrackIds, t.id],
                      })
                    }
                  />
                  <span>
                    {t.name}
                    <small>{t.artist}</small>
                  </span>
                  <small>{time(t.duration)}</small>
                </label>
              ))}
            </div>
            <ErrorNotice message={error} />
            <button
              className="button primary full-width"
              onClick={() =>
                void run(async () => {
                  await send(
                    `/api/admin/collection/${encodeURIComponent(edit.id)}`,
                    {
                      displayName: edit.displayName,
                      artworkOverride: edit.artworkOverride,
                      hiddenTrackIds: edit.hiddenTrackIds,
                    },
                    'PATCH',
                  );
                  setEdit(null);
                }, 'Music details saved')
              }
            >
              Save changes
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
