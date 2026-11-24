import {
  AudioLines,
  ArrowLeft,
  Disc3,
  Heart,
  Hourglass,
  ThumbsDown,
  ListMusic,
  LockKeyhole,
  Moon,
  Music2,
  Pause,
  Play,
  Repeat,
  ShieldCheck,
  Shuffle,
  SkipBack,
  SkipForward,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HubState,
  SessionInfo,
  ApprovedItem,
  PlaybackCommand,
  Track,
  TrackReaction,
} from '../shared/types';
import { api, ApiError, send } from './api';
import {
  art,
  Brand,
  Clock,
  Cover,
  ErrorNotice,
  IconButton,
  time,
} from './components';
import { useLive, useSession } from './hooks';
import { VolumeControl } from './VolumeControl';
import { useBrowserAudio } from './useBrowserAudio';
import { useFullyDevice } from './useFullyDevice';
import { VoiceSearch } from './VoiceSearch';
import { AdultSearch } from './AdultSearch';
import { trackHidden } from '../shared/music';

const daytimeBrightness = 255;
const sleepWakeDurationMs = 60_000;

export function Child() {
  const auth = useSession('child');
  const reloadAuth = auth.reload;
  const {
    state,
    online,
    error: liveError,
    update: updateState,
  } = useLive(
    'child',
    !!auth.session?.authenticated,
    auth.session?.personal?.deviceId,
  );
  const localAudio =
    state?.backend === 'music-assistant' &&
    state.settings.playbackMode === 'local';
  const audio = useBrowserAudio(
    !!auth.session?.authenticated && localAudio,
    state?.device.name ?? 'Music Hub',
    state?.settings.maxVolume ?? 60,
    state?.personal
      ? `${state.personal.profile.id}:${state.personal.profile.kind ?? 'child'}`
      : undefined,
  );
  const [playerName, setPlayerName] = useState('');
  const [view, setView] = useState<'library' | 'tracks' | 'playing' | 'sleep'>(
    'library',
  );
  const [visualizerOpen, setVisualizerOpen] = useState(false);
  const [visualizerStyle, setVisualizerStyle] =
    useState<import('./Visualizer').VisualizerStyle>('aurora');
  const visualizerButton = useRef<HTMLButtonElement>(null);
  const [Visualizer, setVisualizer] = useState<
    (typeof import('./Visualizer'))['default'] | null
  >(null);
  const adult = state?.personal?.profile.kind === 'adult';
  const [catalogueItem, setCatalogueItem] = useState<ApprovedItem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<{
    id: string;
    tracks: Track[];
  } | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const selected =
    state?.collection.find((i) => i.id === selectedId) ??
    (adult && catalogueItem?.id === selectedId ? catalogueItem : undefined);
  const selectedApproved = !!selected;
  const exclusions = selected?.hiddenTrackIds.join('\n') ?? '';
  useEffect(() => {
    if (
      !selectedId ||
      !selectedApproved ||
      !auth.session?.authenticated ||
      view !== 'tracks' ||
      !online
    ) {
      setLoadingTracks(false);
      return;
    }
    let active = true;
    setLoadingTracks(true);
    setError('');
    void api<{ tracks: Track[] }>(
      `/api/child/collection/${encodeURIComponent(selectedId)}`,
    )
      .then((result) => {
        if (active) setDetails({ id: selectedId, tracks: result.tracks });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoadingTracks(false);
      });
    return () => {
      active = false;
    };
  }, [
    selectedId,
    selectedApproved,
    exclusions,
    state?.personal?.preferencesVersion,
    auth.session?.authenticated,
    view,
    online,
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [reactionBusy, setReactionBusy] = useState(false),
    [preferenceMessage, setPreferenceMessage] = useState('');
  const [undo, setUndo] = useState<{
    reaction: TrackReaction;
    version: number;
    trackVersion: string;
  } | null>(null);
  useEffect(() => {
    setView('library');
    setSelectedId(null);
    setCatalogueItem(null);
    setDetails(null);
    setUndo(null);
    setPreferenceMessage('');
  }, [state?.personal?.profile.id, state?.personal?.profile.kind]);
  useEffect(() => {
    setUndo(null);
    setPreferenceMessage('');
  }, [state?.personal?.trackVersion]);
  async function reactToTrack(reaction: TrackReaction, undoChange = false) {
    const personal = state?.personal;
    if (!personal) return;
    setReactionBusy(true);
    setError('');
    try {
      const previous = personal.preference?.reaction ?? 'neutral';
      const response = await send<HubState>(
        '/api/child/reaction',
        {
          reaction,
          version: undoChange
            ? undo!.version
            : (personal.preference?.version ?? 0),
          trackVersion: undoChange ? undo!.trackVersion : personal.trackVersion,
        },
        'PUT',
      );
      updateState(response);
      setUndo(
        !undoChange && reaction === 'blocked'
          ? {
              reaction: previous,
              version: response.personal!.preference!.version,
              trackVersion: personal.trackVersion,
            }
          : null,
      );
      setPreferenceMessage(
        undoChange
          ? 'Previous choice restored.'
          : reaction === 'blocked'
            ? `Blocked for ${personal.profile.name}. This song can finish.`
            : reaction === 'favourite'
              ? 'Added to My favourites.'
              : 'Preference removed.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReactionBusy(false);
    }
  }
  const requestedCollection = useRef<string | null>(null);
  useEffect(() => {
    if (
      requestedCollection.current &&
      state?.playback.track &&
      state.playback.collectionId === requestedCollection.current
    ) {
      requestedCollection.current = null;
      setView('playing');
      setError('');
    }
  }, [state]);
  const [inactive, setInactive] = useState(false);
  const dim = inactive && state?.settings.inactivityMode === 'dim';
  const lastInteraction = useRef(Date.now());
  const screenRef = useRef({ blanked: false, touchActive: false });
  const hardwareVolume = useRef<((delta: number) => void) | null>(null);
  const screenWakeAt = state?.device.screenWakeAt;
  const [elapsedWake, setElapsedWake] = useState<number>();
  const [sleepPickerWake, setSleepPickerWake] = useState<{
    morning: number;
    expires: number;
  } | null>(null);
  const screenShouldBlank =
    !!state?.device.screenOff &&
    (screenWakeAt === undefined || elapsedWake !== screenWakeAt);
  const tapToWake =
    screenShouldBlank &&
    screenWakeAt !== undefined &&
    !!state?.device.sleepMusicTapToWake &&
    (!window.fully || typeof window.fully.setScreenBrightness === 'function');
  const sleepWakeOpen = tapToWake && sleepPickerWake?.morning === screenWakeAt;
  const locked = screenShouldBlank && !sleepWakeOpen;
  const canShowVisualizer =
    view === 'playing' &&
    localAudio &&
    (audio.status === 'connected' ||
      (visualizerOpen && audio.status === 'connecting')) &&
    state?.playback.playerId === audio.clientId &&
    !!state.playback.track &&
    !screenShouldBlank;
  useEffect(() => {
    if (!visualizerOpen) return;
    const close = () => setVisualizerOpen(false);
    if (!canShowVisualizer || document.hidden) {
      close();
      return;
    }
    const visibility = () => {
      if (document.hidden) close();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', close);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', close);
    };
  }, [visualizerOpen, canShowVisualizer]);
  screenRef.current = { blanked: locked, touchActive: tapToWake };
  useEffect(() => {
    if (!sleepPickerWake) return;
    if (!sleepWakeOpen) {
      setSleepPickerWake(null);
      return;
    }
    const timer = setTimeout(
      () => setSleepPickerWake(null),
      Math.max(0, sleepPickerWake.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [sleepWakeOpen, sleepPickerWake]);
  useEffect(() => {
    if (screenWakeAt === undefined) return;
    const wakeIfDue = () => {
      if (Date.now() >= screenWakeAt) setElapsedWake(screenWakeAt);
    };
    const timer = setTimeout(wakeIfDue, Math.max(0, screenWakeAt - Date.now()));
    document.addEventListener('visibilitychange', wakeIfDue);
    window.addEventListener('focus', wakeIfDue);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wakeIfDue);
      window.removeEventListener('focus', wakeIfDue);
    };
  }, [screenWakeAt]);
  useEffect(() => {
    if (!locked) {
      lastInteraction.current = Date.now();
      setInactive(false);
    }
  }, [locked]);
  const nativeVolume = useFullyDevice(
    state && auth.session?.authenticated
      ? {
          screenOff: locked,
          keepTouchActive: tapToWake,
          screenOnBrightness:
            !screenShouldBlank && !state.device.bedtime && !inactive
              ? daytimeBrightness
              : undefined,
          volume: state.playback.volume,
          maxVolume: state.settings.maxVolume,
          canControlVolume:
            online &&
            (!localAudio || state.playback.playerId === audio.clientId),
        }
      : null,
    (delta) => hardwareVolume.current?.(delta),
    setError,
  );
  useEffect(() => {
    if (!auth.session?.authenticated) return;
    const beat = () => {
      if (navigator.onLine)
        void send('/api/child/heartbeat', {
          screenOff: actualScreenOff(),
        }).catch((error) => {
          if (error instanceof ApiError && error.status === 401)
            void reloadAuth();
        });
    };
    function actualScreenOff() {
      if (screenRef.current.blanked && screenRef.current.touchActive)
        return true;
      try {
        const on = window.fully?.getScreenOn();
        if (typeof on === 'boolean') return !on;
      } catch {
        // Browsers and unavailable native bridges report the page overlay.
      }
      return screenRef.current.blanked;
    }
    beat();
    const t = setInterval(beat, 10_000);
    return () => clearInterval(t);
  }, [auth.session?.authenticated, reloadAuth]);
  useEffect(() => {
    const t = setInterval(() => {
      if (!state) return;
      const idle =
        Date.now() - lastInteraction.current >
        state.settings.inactivitySeconds * 1000;
      setInactive(idle);
      if (
        idle &&
        !state.sleepSession &&
        state.settings.inactivityMode === 'library'
      ) {
        setView('library');
      }
    }, 1000);
    return () => clearInterval(t);
  }, [state]);
  const command = useCallback(
    async (command: PlaybackCommand) => {
      const previousGeneration = audio.generation();
      setBusy(true);
      setError('');
      setLoadingNext(command.action === 'next');
      if (command.action === 'start') {
        requestedCollection.current = command.collectionId;
      }
      if (
        ['start', 'start-sleep', 'play', 'next', 'previous'].includes(
          command.action,
        )
      )
        setStarting(true);
      try {
        if (
          localAudio &&
          command.action !== 'start' &&
          command.action !== 'start-sleep' &&
          state?.playback.playerId !== audio.clientId
        )
          throw new Error(
            'Music is playing on another device. Choose a song to play here.',
          );
        // Transport controls operate the existing receiver, including a sibling
        // tab's receiver. Only starting/resuming music needs audio activation.
        if (
          localAudio &&
          ['start', 'start-sleep', 'play'].includes(command.action)
        )
          await audio.enable();
        const response = await send<HubState>('/api/child/playback', command);
        updateState(response);
        if (localAudio && command.action === 'next')
          await audio.waitForReplacement(previousGeneration);
        if (command.action === 'start') setView('playing');
        if (command.action === 'start-sleep') {
          setView('sleep');
        }
        if (command.action === 'start-sleep' || command.action === 'stop') {
          setSleepPickerWake(null);
        }
      } catch (e) {
        audio.cancelPending();
        if (e instanceof ApiError && e.status === 401) void auth.reload();
        setError((e as Error).message);
      } finally {
        setBusy(false);
        setStarting(false);
        setLoadingNext(false);
      }
    },
    [auth, audio, localAudio, state?.playback.playerId, updateState],
  );
  const wake = () => {
    lastInteraction.current = Date.now();
    setInactive(false);
  };
  function openVisualizer() {
    setVisualizerOpen(true);
    if (Visualizer) return;
    void import('./Visualizer')
      .then(({ default: component }) => setVisualizer(() => component))
      .catch(() => {
        setVisualizerOpen(false);
        setError('Could not load the visualizer. Try again.');
      });
  }
  if (!auth.session)
    return (
      <div className="center-page">
        <Brand />
        <p>{auth.error || 'Finding your music…'}</p>
        {auth.error && (
          <button onClick={() => void auth.reload()}>Try again</button>
        )}
      </div>
    );
  if (!auth.session.authenticated)
    return (
      <div className="center-page pairing">
        <span className="large-symbol">
          <ShieldCheck />
        </span>
        <Brand />
        <h1>Connect your player</h1>
        <p>Set up this browser to open your approved music.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void send<SessionInfo>(
              '/api/child/pair',
              playerName.trim() ? { name: playerName.trim() } : {},
            )
              .then(auth.accept)
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Player name <span className="muted">(optional)</span>
            <input
              aria-label="Player name"
              placeholder="e.g. Bedroom tablet"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={60}
              disabled={busy}
            />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? 'Setting up…' : 'Set up this player'}
          </button>
          <ErrorNotice message={error} />
        </form>
        <p className="muted">
          You’ll start with child access. A parent can change the profile later.
        </p>
      </div>
    );
  if (!state)
    return (
      <div className="center-page">
        <Brand />
        <p>{liveError || 'Getting your music ready…'}</p>
      </div>
    );
  const sleep = state.sleepSession;
  const sleepSongs = state.sleepSongs ?? [];
  const p = state.playback,
    track = p.track,
    offline =
      !online || (localAudio ? audio.status === 'connecting' : !p.connected);
  const showVisualizer =
    canShowVisualizer && visualizerOpen && !document.hidden;
  const playingAlbum = showVisualizer
    ? state.collection.find(
        (item) => item.id === p.collectionId && item.kind === 'album',
      )
    : undefined;
  const connectionLost = !online || (!localAudio && !p.connected);
  const controlsDisabled =
    offline || (localAudio && p.playerId !== audio.clientId);
  const visibleTracks =
    details?.id === selected?.id
      ? (details?.tracks.filter(
          (t) => !trackHidden(selected?.hiddenTrackIds ?? [], t),
        ) ?? [])
      : [];
  return (
    <main
      className={`child ${dim ? 'is-dim' : ''}`}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      <header className="child-header" inert={locked || sleepWakeOpen}>
        <button
          type="button"
          className="child-home"
          aria-label="Music Hub home"
          onClick={() => {
            setView('library');
            setSelectedId(null);
            setCatalogueItem(null);
          }}
        >
          <Brand />
        </button>
        <div className="child-header-right">
          {state.personal && (
            <div
              className="child-profile-badge"
              aria-label={`${adult ? 'Adult' : 'Child'} profile: ${state.personal.profile.name}`}
            >
              <span className="child-profile-avatar">
                {state.personal.profile.avatar}
              </span>
              <span className="child-identity">
                <span className="child-profile-name">
                  {state.personal.profile.name}
                  {adult ? ' · Adult' : ''}
                </span>
                <span
                  className="child-display-name"
                  aria-label={`Display: ${state.device.name}`}
                  title={state.device.name}
                >
                  {state.device.name}
                </span>
              </span>
            </div>
          )}

          {adult && (
            <IconButton
              icon={LockKeyhole}
              label="Lock adult profile"
              className="adult-lock"
              disabled={busy || !online}
              onClick={() => {
                setBusy(true);
                setError('');
                void send<HubState>('/api/child/adult/lock', {})
                  .then(updateState)
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false));
              }}
            />
          )}
          {!!sleepSongs.length && (
            <IconButton
              type="button"
              icon={Moon}
              label="Sleep Music"
              className="sleep-picker-button"
              aria-pressed={view === 'sleep'}
              onClick={() => setView('sleep')}
            />
          )}
          {state.voice?.enabled && (
            <VoiceSearch
              catalogue={adult}
              disabled={!online || locked || !!sleep}
              maxSeconds={state.voice.maxRecordingSeconds}
              duck={localAudio ? audio.duck : undefined}
              onChoose={(match) => {
                setSelectedId(match.collectionId);
                void command({
                  action: 'start',
                  collectionId: match.collectionId,
                  ...(match.trackId ? { trackId: match.trackId } : {}),
                });
              }}
            />
          )}
          <span className={`connection ${connectionLost ? 'offline' : ''}`}>
            {connectionLost ? <WifiOff size={16} /> : <Wifi size={16} />}{' '}
            {!online
              ? 'Reconnecting'
              : localAudio && audio.status !== 'connected'
                ? audio.status === 'connecting'
                  ? 'Connecting sound…'
                  : 'Ready to play here'
                : !p.playerId
                  ? 'Player setup needed'
                  : !p.connected
                    ? 'Player unavailable'
                    : state.backend === 'mock'
                      ? 'Demo player'
                      : 'Connected'}
          </span>
          <Clock />
        </div>
      </header>
      {state.backend === 'mock' && (
        <div className="mock-label">
          <span /> MOCK PLAYER · SIMULATED PLAYBACK · NO AUDIO
        </div>
      )}
      <ErrorNotice message={error} onClose={() => setError('')} />
      {preferenceMessage && (
        <div className="preference-feedback" role="status">
          {preferenceMessage}
          {undo && (
            <button
              onClick={() => void reactToTrack(undo.reaction, true)}
              disabled={reactionBusy}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {starting && !locked && (
        <div
          className="playback-starting"
          role="status"
          aria-label="Loading music"
        >
          <div className="music-loading-card">
            <div className="music-loading-symbol" aria-hidden="true">
              <span className="music-loading-ring" />
              <Hourglass className="music-loading-hourglass" />
              <span className="music-loading-note">
                <Music2 />
              </span>
            </div>
            <div className="music-loading-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>
              {loadingNext ? 'Loading next song…' : 'Getting your music ready'}
            </p>
          </div>
        </div>
      )}
      {!online && (
        <div className="offline-banner">
          You’re offline. Your music shelf is saved here. We’ll reconnect
          automatically.
        </div>
      )}
      <ErrorNotice message={audio.error} />
      {online && !localAudio && !p.playerId && (
        <div className="offline-banner">
          Your music is here. Ask a parent to connect an audio player.
        </div>
      )}
      {state.device.bedtime && !sleep && (
        <div className="bedtime-banner">
          <Moon size={20} />{' '}
          {sleepSongs.length
            ? 'Only Sleep Music is available at bedtime.'
            : 'Playback is paused for bedtime.'}
        </div>
      )}
      {view === 'sleep' || sleepWakeOpen ? (
        <section className="library-view" inert={locked}>
          {sleepWakeOpen ? (
            <button
              className="back-library"
              onClick={() => setSleepPickerWake(null)}
            >
              <Moon size={21} /> Darken screen
            </button>
          ) : (
            <button className="back-library" onClick={() => setView('library')}>
              <ArrowLeft size={21} /> My music
            </button>
          )}
          <div className="section-intro">
            <h1>Sleep Music</h1>
          </div>
          <p>
            {sleep
              ? 'Your chosen song repeats until morning.'
              : 'Choose one song to play until morning.'}
          </p>
          <div className="music-grid">
            {sleepSongs.map((song) => (
              <button
                key={song.id}
                className={`music-card ${sleep?.songId === song.id ? 'is-playing' : ''}`}
                aria-label={`Play ${song.name} until morning`}
                aria-pressed={sleep?.songId === song.id}
                disabled={busy || !online || sleep?.songId === song.id}
                onClick={() =>
                  void command({ action: 'start-sleep', songId: song.id })
                }
              >
                <div className="cover-wrap">
                  <Cover src={song.artwork} />
                  <span className="card-play">
                    <Moon size={25} />
                  </span>
                </div>
                <span className="card-name">{song.name}</span>
                <span className="card-kind">{song.artist}</span>
              </button>
            ))}
          </div>
          {!sleepSongs.length && (
            <p>Ask a parent to add songs to Sleep Music.</p>
          )}
        </section>
      ) : view === 'library' || (view === 'tracks' && !selected) ? (
        <section className="library-view" inert={locked}>
          <div className="section-intro">
            <h1>Your music</h1>
            <span className="shelf-label">
              <ShieldCheck size={16} /> Your albums & playlists
            </span>
          </div>
          {adult && (
            <AdultSearch
              disabled={busy || !online}
              onSelect={(item) => {
                setCatalogueItem(item);
                setSelectedId(item.id);
                setDetails(null);
                setView('tracks');
                setError('');
              }}
            />
          )}
          {state.collection.length ? (
            <div className="music-grid">
              {state.collection.map((item) => (
                <button
                  key={item.id}
                  className={`music-card ${p.collectionId === item.id && p.status === 'playing' ? 'is-playing' : ''}`}
                  disabled={busy || !online || !!sleep}
                  onClick={() => {
                    setSelectedId(item.id);
                    setView('tracks');
                    setError('');
                  }}
                  aria-label={`Open ${item.displayName}`}
                >
                  <div className="cover-wrap">
                    <Cover src={art(item)} />
                    <span className="card-play">
                      <ListMusic size={25} />
                    </span>
                    {p.collectionId === item.id && p.status === 'playing' && (
                      <span className="equalizer">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                  <span className="card-name">{item.displayName}</span>
                  <span className="card-kind">
                    {item.kind === 'album'
                      ? 'Album'
                      : item.kind === 'track'
                        ? 'Song'
                        : 'Playlist'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-shelf">
              <Disc3 size={50} />
              <h2>Your music shelf is ready</h2>
              <p>Add albums or playlists in Parent controls to get started.</p>
            </div>
          )}
        </section>
      ) : view === 'tracks' && selected ? (
        <section className="track-browser" inert={locked}>
          <button className="back-library" onClick={() => setView('library')}>
            <ArrowLeft size={21} /> My music
          </button>
          <div className="collection-heading">
            <Cover src={art(selected)} alt={selected.displayName} />
            <div>
              <p className="eyebrow">
                {selected.kind === 'album'
                  ? 'ALBUM'
                  : selected.kind === 'track'
                    ? 'SONG'
                    : 'PLAYLIST'}
              </p>
              <h1>{selected.displayName}</h1>
              <p>{selected.artist}</p>
              <span>
                {loadingTracks
                  ? 'Loading tracks…'
                  : `${visibleTracks.length} ${visibleTracks.length === 1 ? 'song' : 'songs'}`}
              </span>
              <button
                className="button primary"
                disabled={
                  busy ||
                  offline ||
                  state.device.bedtime ||
                  loadingTracks ||
                  !visibleTracks.length
                }
                onClick={() =>
                  void command({ action: 'start', collectionId: selected.id })
                }
              >
                <Play size={19} fill="currentColor" />{' '}
                {selected.kind === 'track' ? 'Play song' : 'Play all'}
              </button>
            </div>
          </div>
          <div className="song-list" aria-label="Songs">
            {!loadingTracks && !visibleTracks.length && (
              <p className="muted">
                {selected.id === '__favourites__'
                  ? 'Tap the heart on a song in Now Playing to add it to My favourites.'
                  : 'No tracks available in this collection.'}
              </p>
            )}
            {visibleTracks.map((song, index) => (
              <button
                className={`song-row ${p.track?.id === song.id ? 'current-song' : ''}`}
                key={`${song.id}-${index}`}
                aria-label={`Play ${song.name}`}
                disabled={busy || offline || state.device.bedtime}
                onClick={() =>
                  void command({
                    action: 'start',
                    collectionId: selected.id,
                    trackId: song.id,
                  })
                }
              >
                <span className="song-number">
                  {p.track?.id === song.id && p.status === 'playing' ? (
                    <span className="song-playing">♫</span>
                  ) : (
                    String(index + 1).padStart(2, '0')
                  )}
                </span>
                <Cover
                  className="song-artwork"
                  src={song.artwork}
                  alt={`${song.name} album artwork`}
                  loading="lazy"
                />
                <span className="song-title">
                  <strong>{song.name}</strong>
                  <small>{song.artist}</small>
                </span>
                <span className="song-duration">{time(song.duration)}</span>
                <Play size={20} />
              </button>
            ))}
          </div>
        </section>
      ) : showVisualizer && Visualizer && track && !starting ? (
        <Visualizer
          artwork={playingAlbum ? art(playingAlbum) : track.artwork}
          playing={p.status === 'playing'}
          watchAnalyser={audio.watchAnalyser}
          style={visualizerStyle}
          onStyleChange={setVisualizerStyle}
          onClose={() => {
            setVisualizerOpen(false);
            requestAnimationFrame(() => visualizerButton.current?.focus());
          }}
        />
      ) : (
        <section className="playing-view" inert={locked}>
          <div className="playing-view-toolbar">
            <button
              className="back-library"
              onClick={() => setView(selected ? 'tracks' : 'library')}
            >
              <ArrowLeft size={21} /> {selected ? 'Track list' : 'My music'}
            </button>
            {canShowVisualizer && (
              <button
                ref={visualizerButton}
                type="button"
                className="back-library"
                disabled={showVisualizer}
                onClick={openVisualizer}
              >
                <AudioLines size={21} aria-hidden="true" />
                {showVisualizer ? 'Opening visualizer…' : 'Visualizer'}
              </button>
            )}
          </div>
          <div className="now-playing-layout">
            <div className="large-cover">
              <Cover src={track?.artwork} />
              <span
                className={`record-badge ${p.status === 'playing' ? 'spinning' : ''}`}
              >
                <Disc3 />
              </span>
            </div>
            <div className="now-playing-info">
              <p className="eyebrow">
                {p.status === 'playing' ? 'NOW PLAYING' : 'PAUSED'}
              </p>
              <h1>{track?.name ?? 'Choose some music'}</h1>
              <p className="artist">
                {track?.artist ?? 'Pick something from your library'}
              </p>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Track progress"
                aria-valuenow={Math.round(p.elapsed)}
                aria-valuemax={track?.duration || 1}
              >
                <span
                  style={{
                    width: `${Math.min(100, (p.elapsed / (track?.duration || 1)) * 100)}%`,
                  }}
                />
              </div>
              <div className="track-times">
                <span>{time(p.elapsed)}</span>
                <span>{time(track?.duration ?? 0)}</span>
              </div>
              <div
                className="big-controls"
                role="group"
                aria-label="Playback controls"
              >
                <button
                  type="button"
                  aria-label="Shuffle"
                  aria-pressed={p.shuffle}
                  className={`mode-toggle ${p.shuffle ? 'is-active' : ''}`}
                  disabled={
                    !track || busy || controlsDisabled || state.device.bedtime
                  }
                  onClick={() =>
                    void command({ action: 'shuffle', enabled: !p.shuffle })
                  }
                >
                  <Shuffle size={23} aria-hidden="true" />
                </button>

                <IconButton
                  icon={SkipBack}
                  label="Previous track"
                  disabled={busy || controlsDisabled}
                  onClick={() => void command({ action: 'previous' })}
                />
                <IconButton
                  className="primary-play"
                  icon={p.status === 'playing' ? Pause : Play}
                  label={p.status === 'playing' ? 'Pause' : 'Resume'}
                  disabled={busy || controlsDisabled || state.device.bedtime}
                  onClick={() =>
                    void command({
                      action: p.status === 'playing' ? 'pause' : 'play',
                    })
                  }
                />
                <IconButton
                  icon={SkipForward}
                  label="Next track"
                  disabled={busy || controlsDisabled || state.device.bedtime}
                  onClick={() => void command({ action: 'next' })}
                />
                <button
                  type="button"
                  aria-label="Repeat playlist"
                  aria-pressed={p.repeat}
                  className={`mode-toggle ${p.repeat ? 'is-active' : ''}`}
                  disabled={
                    !track || busy || controlsDisabled || state.device.bedtime
                  }
                  onClick={() =>
                    void command({ action: 'repeat', enabled: !p.repeat })
                  }
                >
                  <Repeat size={23} aria-hidden="true" />
                </button>
              </div>
              {state.personal && (
                <div
                  className="track-reactions"
                  role="group"
                  aria-label="Song preferences"
                >
                  <IconButton
                    icon={Heart}
                    label={
                      state.personal.preference?.reaction === 'favourite'
                        ? 'Remove from my favourites'
                        : 'Add to my favourites'
                    }
                    aria-pressed={
                      state.personal.preference?.reaction === 'favourite'
                    }
                    className={
                      state.personal.preference?.reaction === 'favourite'
                        ? 'is-favourite'
                        : ''
                    }
                    disabled={
                      !track || busy || reactionBusy || controlsDisabled
                    }
                    onClick={() =>
                      void reactToTrack(
                        state.personal?.preference?.reaction === 'favourite'
                          ? 'neutral'
                          : 'favourite',
                      )
                    }
                  />
                  <IconButton
                    icon={ThumbsDown}
                    label={
                      state.personal.preference?.reaction === 'blocked'
                        ? 'Unblock this song'
                        : 'Block this song for me'
                    }
                    aria-pressed={
                      state.personal.preference?.reaction === 'blocked'
                    }
                    className={
                      state.personal.preference?.reaction === 'blocked'
                        ? 'is-blocked'
                        : ''
                    }
                    disabled={
                      !track || busy || reactionBusy || controlsDisabled
                    }
                    onClick={() =>
                      void reactToTrack(
                        state.personal?.preference?.reaction === 'blocked'
                          ? 'neutral'
                          : 'blocked',
                      )
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </section>
      )}
      <footer
        className="child-footer"
        inert={locked || (sleepWakeOpen && !sleep)}
      >
        <button
          className="mini-player"
          aria-label="Open now playing"
          inert={sleepWakeOpen}
          disabled={!track}
          onClick={() => setView(sleep ? 'sleep' : 'playing')}
        >
          <Cover src={track?.artwork} />
          <span>
            <strong>{track?.name ?? 'Choose something to play'}</strong>
            <small>{track?.artist ?? 'Pick a cover to get started'}</small>
          </span>
        </button>
        <div
          className="footer-controls"
          role="group"
          aria-label="Playback controls"
        >
          {sleep ? (
            <IconButton
              type="button"
              icon={Moon}
              label="Stop Sleep Music"
              className="footer-stop-sleep"
              disabled={busy || controlsDisabled}
              onClick={() => void command({ action: 'stop' })}
            />
          ) : (
            <>
              <IconButton
                icon={SkipBack}
                label="Previous song"
                disabled={
                  !track || busy || controlsDisabled || state.device.bedtime
                }
                onClick={() => void command({ action: 'previous' })}
              />
              <IconButton
                className="footer-play"
                icon={p.status === 'playing' ? Pause : Play}
                label={
                  p.status === 'playing' ? 'Pause playback' : 'Resume playback'
                }
                disabled={
                  !track || busy || controlsDisabled || state.device.bedtime
                }
                onClick={() =>
                  void command({
                    action: p.status === 'playing' ? 'pause' : 'play',
                  })
                }
              />
              <IconButton
                icon={SkipForward}
                label="Next song"
                disabled={
                  !track || busy || controlsDisabled || state.device.bedtime
                }
                onClick={() => void command({ action: 'next' })}
              />
            </>
          )}
        </div>
        <VolumeControl
          hardwareKeys={hardwareVolume}
          onShownVolume={nativeVolume}
          value={p.volume}
          max={state.settings.maxVolume}
          disabled={controlsDisabled}
          inert={sleepWakeOpen}
          onVolume={async (volume) => {
            const result = await send<HubState>('/api/child/playback', {
              action: 'volume',
              volume,
            });
            updateState(result);
            return result.playback.volume;
          }}
          onError={setError}
        />
      </footer>
      {locked && (
        <div
          className="screen-blank"
          aria-label="Screen blanked by parent"
          role="status"
        >
          {tapToWake && screenWakeAt !== undefined && (
            <button
              type="button"
              className="screen-wake-button"
              aria-label="Wake for Sleep Music"
              onClick={() =>
                setSleepPickerWake({
                  morning: screenWakeAt,
                  expires: Date.now() + sleepWakeDurationMs,
                })
              }
            />
          )}
        </div>
      )}
    </main>
  );
}
