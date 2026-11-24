import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  Radio,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { Player, Provider, Settings } from '../shared/types';
import { api, send } from './api';
import { ErrorNotice } from './components';
interface Integration {
  mode: 'mock' | 'music-assistant';
  connected: boolean;
  error: string | null;
  serverUrl: string | null;
  compatibility: {
    server_version?: string;
    schema_version?: number;
    verifiedAt?: string;
  } | null;
  players: Player[];
  providers: Provider[];
  playerId: string;
  playbackMode: 'local' | 'remote';
}
export function MusicAssistantPanel() {
  const [data, setData] = useState<Integration | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [target, setTarget] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api<Integration>('/api/admin/integration');
      setData(result);
      setTarget(result.playbackMode === 'local' ? '@local' : result.playerId);
      setError(result.error ?? '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function saveTarget() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const settings = await api<Settings>('/api/admin/settings');
      await send(
        '/api/admin/settings',
        {
          ...settings,
          playbackMode: target === '@local' ? 'local' : 'remote',
          playerId:
            target === '@local'
              ? settings.playbackMode === 'local'
                ? settings.playerId
                : ''
              : target,
        },
        'PUT',
      );
      setMessage('Playback target saved');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorNotice message={error} />
      {message && (
        <div className="success" role="status">
          <Check size={17} />
          {message}
        </div>
      )}
      <section className="panel">
        <h2>
          <Radio size={22} /> Music Assistant connection
        </h2>
        <div className="integration-summary">
          <span
            className={`status-dot ${data?.connected ? '' : 'disconnected'}`}
          />
          <strong>
            {data?.connected
              ? data.mode === 'mock'
                ? 'Demo backend active'
                : 'Connected to Music Assistant'
              : data
                ? 'Connection unavailable'
                : busy
                  ? 'Checking connection…'
                  : 'Connection check failed'}
          </strong>
          {data?.mode === 'mock' && (
            <span className="demo-pill">SIMULATED · NO AUDIO</span>
          )}
        </div>
        <dl className="integration-meta">
          <dt>Backend</dt>
          <dd>{data?.mode ?? 'Loading'}</dd>
          <dt>Server</dt>
          <dd>
            {data?.serverUrl ??
              (data?.mode === 'mock'
                ? 'Set MUSIC_BACKEND=music-assistant in the protected server configuration'
                : 'Unavailable')}
          </dd>
          {data?.compatibility && (
            <>
              <dt>Version / schema</dt>
              <dd>
                {data.compatibility.server_version} /{' '}
                {data.compatibility.schema_version}
              </dd>
            </>
          )}
          <dt>Credentials</dt>
          <dd>Stored on the server; never sent to this browser</dd>
        </dl>
        <div className="integration-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={16} /> Check connection
          </button>
          {data?.serverUrl && (
            <a
              className="button"
              href={data.serverUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open Music Assistant <ExternalLink size={16} />
            </a>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>Playback target</h2>
        {data?.connected && data.playbackMode === 'local' && (
          <div className="notice" role="status">
            Music plays through the device running the child player. Open the
            player or simulator and tap Enable sound.
          </div>
        )}
        <p>
          Built-in speakers are the default. Other Music Assistant speakers are
          optional.
        </p>
        <label className="integration-target">
          Music Assistant player
          <select
            aria-label="Music Assistant player"
            value={target}
            disabled={busy || !data?.connected}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="@local">This device’s speakers (default)</option>
            <option value="">Choose a player…</option>
            {target &&
              target !== '@local' &&
              !data?.players.some((p) => p.id === target) && (
                <option value={target}>{target} (unavailable)</option>
              )}
            {data?.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.available ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={busy || !target || !data?.connected}
          onClick={() => void saveTarget()}
        >
          <Check size={16} /> Save playback target
        </button>
        <p className="muted">
          The child player includes its own audio receiver. Keep that player tab
          open for sound. Screen-off audio and physical backlight control still
          need testing on the Lenovo.
        </p>
      </section>
      <section className="panel">
        <h2>
          <ShieldCheck size={22} /> Music sources
        </h2>
        {data?.providers.map((p) => (
          <div className="integration-source" key={p.id}>
            <span
              className={`status-dot ${p.available ? '' : 'disconnected'}`}
            />
            <strong>{p.name}</strong>
            <span className="muted">
              {p.available ? 'Available' : 'Unavailable'}
            </span>
          </div>
        ))}
        <p className="muted">
          Browse the library or paste a Spotify playlist link to approve music.
          Only approved collections appear on the child player.
        </p>
      </section>
    </>
  );
}
