import { Check, Mic, Moon, Music2, ShieldCheck, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Player, Settings } from '../shared/types';
import { api } from './api';
import { ErrorNotice } from './components';
export function SettingsForm({
  settings: s,
  onChange,
  onSave,
  onPair,
  onRevoke,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onSave: () => void;
  onPair: () => void;
  onRevoke: () => void;
}) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState('');
  const [voice, setVoice] = useState<{
    configured: boolean;
    ready: boolean;
    model?: string;
    device?: string;
    error?: string;
  } | null>(null);
  async function checkVoice() {
    try {
      setVoice(await api('/api/admin/voice'));
    } catch {
      setVoice({
        configured: false,
        ready: false,
        error: 'Voice status could not be checked.',
      });
    }
  }
  useEffect(() => {
    void checkVoice();
    void api<{ players: Player[] }>('/api/admin/devices')
      .then((r) => setPlayers(r.players))
      .catch((e) => setError(e.message));
  }, []);
  function field<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...s, [key]: value });
  }
  const toggle = (
    key:
      | 'repeat'
      | 'shuffle'
      | 'bedtimeEnabled'
      | 'screenScheduleEnabled'
      | 'sleepMusicTapToWake'
      | 'resumeAfterRestart'
      | 'voiceSearchEnabled',
    label: string,
    desc: string,
  ) => (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{desc}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={s[key]}
        onChange={(e) => field(key, e.target.checked)}
      />
    </label>
  );
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <ErrorNotice message={error} />
      <section className="panel">
        <h2>
          <Music2 size={22} /> Her player
        </h2>
        <div className="form-grid">
          <label>
            Device name
            <input
              value={s.deviceName}
              aria-label="Device name"
              maxLength={80}
              required
              onChange={(e) => field('deviceName', e.target.value)}
            />
          </label>
          <label>
            Playback target
            <select
              aria-label="Playback target"
              value={s.playbackMode === 'local' ? '@local' : s.playerId}
              onChange={(e) =>
                onChange({
                  ...s,
                  playbackMode:
                    e.target.value === '@local' ? 'local' : 'remote',
                  playerId:
                    e.target.value === '@local'
                      ? s.playbackMode === 'local'
                        ? s.playerId
                        : ''
                      : e.target.value,
                })
              }
            >
              <option value="@local">This device’s speakers (default)</option>
              <option value="">Choose a player…</option>
              {!players.some((p) => p.id === s.playerId) && s.playerId && (
                <option value={s.playerId}>
                  {s.playerId} (currently unavailable)
                </option>
              )}
              {players.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                  {p.available ? '' : ' (offline)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maximum requested volume · {s.maxVolume}%
            <input
              type="range"
              aria-label="Maximum volume"
              value={s.maxVolume}
              min="0"
              max="100"
              onChange={(e) =>
                onChange({
                  ...s,
                  maxVolume: Number(e.target.value),
                  startupVolume: Math.min(
                    s.startupVolume,
                    Number(e.target.value),
                  ),
                })
              }
            />
          </label>
          <label>
            Startup volume · {s.startupVolume}%
            <input
              type="range"
              aria-label="Startup volume"
              value={s.startupVolume}
              min="0"
              max={s.maxVolume}
              onChange={(e) => field('startupVolume', Number(e.target.value))}
            />
          </label>
        </div>
        <p className="muted">
          The cap limits volume requests through this hub. Device hardware and
          other controllers can change physical speaker volume independently.
        </p>
        {toggle(
          'repeat',
          'Play it again',
          'Repeat the approved queue when it reaches the end.',
        )}
        {toggle('shuffle', 'Shuffle tracks', 'Shuffle the approved tracks.')}
        {toggle(
          'resumeAfterRestart',
          'Resume after a hub restart',
          'Restart the last approved collection from its beginning, outside bedtime.',
        )}
      </section>
      <section className="panel">
        <h2>
          <Mic size={22} /> Voice search
        </h2>
        <p>
          {voice?.ready
            ? `Local transcription is ready${voice.model ? ` · ${voice.model}` : ''}${voice.device ? ` · ${voice.device}` : ''}.`
            : voice?.configured
              ? 'Local transcription is currently unavailable.'
              : 'Voice service is not configured on this hub.'}
        </p>
        <ErrorNotice message={voice?.error ?? ''} />
        {toggle(
          'voiceSearchEnabled',
          'Allow microphone search',
          'Tap to speak, then choose a result from her approved music. Recordings and transcripts are not saved.',
        )}
        <button
          type="button"
          className="button"
          onClick={() => void checkVoice()}
        >
          Check voice service
        </button>
      </section>
      <section className="panel">
        <h2>
          <Moon size={22} /> Bedtime & a dark bedroom
        </h2>
        <label>
          Schedule time zone
          <input
            aria-label="Schedule time zone"
            value={s.timezone}
            onChange={(e) => field('timezone', e.target.value)}
            placeholder="Australia/Perth"
          />
        </label>
        {toggle(
          'bedtimeEnabled',
          'Bedtime for music',
          'Stop ordinary music during this window. Children can still choose Sleep Music.',
        )}
        <div className="form-grid">
          <label>
            Music rests at
            <input
              aria-label="Bedtime start"
              type="time"
              value={s.bedtimeStart}
              onChange={(e) => field('bedtimeStart', e.target.value)}
            />
          </label>
          <label>
            Normal music resumes at
            <input
              aria-label="Bedtime end"
              type="time"
              value={s.bedtimeEnd}
              onChange={(e) => field('bedtimeEnd', e.target.value)}
            />
          </label>
        </div>
      </section>
      <section className="panel" id="sleep-music-settings">
        <h2>
          <Moon size={22} /> Sleep Music
        </h2>
        <label>
          Sleep Music stops at
          <input
            aria-label="Sleep Music stops at"
            type="time"
            value={s.sleepMusicEnd}
            onChange={(e) => field('sleepMusicEnd', e.target.value)}
          />
        </label>
      </section>
      <section className="panel">
        <h2>
          <Sun size={22} /> Bedroom screen
        </h2>
        {toggle(
          'screenScheduleEnabled',
          'Blank the display at night',
          'Blank the display on its own schedule.',
        )}
        {toggle(
          'sleepMusicTapToWake',
          'Tap to wake for Sleep Music',
          'Keep touch active at minimum brightness during scheduled blanking when Sleep Music is available.',
        )}
        <div className="form-grid">
          <label>
            Screen goes dark
            <input
              aria-label="Screen off at"
              type="time"
              value={s.screenOffAt}
              onChange={(e) => field('screenOffAt', e.target.value)}
            />
          </label>
          <label>
            Screen wakes at
            <input
              aria-label="Screen on at"
              type="time"
              value={s.screenOnAt}
              onChange={(e) => field('screenOnAt', e.target.value)}
            />
          </label>
        </div>
        <p className="muted">
          Current screen override: {s.screenOverride}. Use Device & diagnostics
          to blank, wake or restore the schedule. Browser blanking does not
          guarantee the physical backlight is off.
        </p>
      </section>
      <section className="panel">
        <h2>
          <Sun size={22} /> Display inactivity
        </h2>
        <div className="form-grid">
          <label>
            After inactivity (seconds)
            <input
              type="number"
              min="10"
              max="3600"
              aria-label="Inactivity seconds"
              value={s.inactivitySeconds}
              onChange={(e) =>
                field('inactivitySeconds', Number(e.target.value))
              }
            />
          </label>
          <label>
            Screen behaviour
            <select
              value={s.inactivityMode}
              aria-label="Inactivity behaviour"
              onChange={(e) =>
                field(
                  'inactivityMode',
                  e.target.value as Settings['inactivityMode'],
                )
              }
            >
              <option value="dim">Dim now-playing screen</option>
              <option value="library">Return to the music shelf</option>
              <option value="none">Keep the current screen</option>
            </select>
          </label>
        </div>
      </section>
      <section className="panel">
        <h2>
          <ShieldCheck size={22} /> Pair this browser
        </h2>
        <p>
          The simulator and child player need a paired browser. Sign into Parent
          controls on the future device to pair it, then log out of Parent
          controls.
        </p>
        <div className="screen-buttons">
          <button type="button" className="button" onClick={onPair}>
            Pair this browser
          </button>
          <button type="button" className="button danger" onClick={onRevoke}>
            Revoke all child browsers
          </button>
        </div>
      </section>
      <div className="settings-save">
        <span>All settings stay on your own server.</span>
        <button className="button primary" type="submit">
          <Check size={18} /> Save settings
        </button>
      </div>
    </form>
  );
}
