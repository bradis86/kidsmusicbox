import { ArrowRight, Power, Radio, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { send } from './api';
import { Brand, ErrorNotice } from './components';
import { useLive, useSession } from './hooks';
export function Simulator() {
  const auth = useSession('parent');
  const { state, online } = useLive('parent', !!auth.session?.authenticated);
  const [screen, setScreen] = useState(true);
  const [network, setNetwork] = useState(true);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.7);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setScale(Math.min(1, (entry.contentRect.width - 76) / 1280)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const run = async (path: string, body: unknown) => {
    try {
      await send(path, body);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="simulator-page">
      <nav className="sim-nav">
        <Brand small />
        <span>THE VIRTUAL LENOVO</span>
        <a href="/admin">
          Parent controls <ArrowRight size={16} />
        </a>
      </nav>
      <div className="sim-heading">
        <p className="eyebrow">NO HARDWARE NEEDED</p>
        <h1>Their music. Their player.</h1>
        <p>Explore the touchscreen player and test the device controls.</p>
      </div>
      <div className="sim-workspace">
        <div className="device-area" ref={container}>
          <div
            className="device-shell"
            style={{ width: 1280 * scale + 56, height: 800 * scale + 72 }}
          >
            <div className="camera" />
            <div
              className="device-display"
              style={{ width: 1280 * scale, height: 800 * scale }}
            >
              {network ? (
                <iframe
                  title="Virtual Lenovo child player"
                  src="/child?simulator=1"
                  style={{
                    width: 1280,
                    height: 800,
                    transform: `scale(${scale})`,
                    transformOrigin: '0 0',
                  }}
                />
              ) : (
                <div className="device-network">
                  <WifiOff />
                  <p>Device disconnected</p>
                  <small>Reconnect using the simulator controls.</small>
                </div>
              )}
              {!screen && (
                <div
                  className="screen-blank"
                  aria-label="Simulator screen off"
                />
              )}
            </div>
            <div className="speaker-dots" />
            <span className="lenovo-label">Lenovo</span>
          </div>
          <p className="device-caption">
            ThinkSmart View CD-18781Y <span>1280 × 800 · landscape</span>
          </p>
        </div>
        <aside className="sim-controls">
          <p className="eyebrow">DEVICE LAB</p>
          <h2>Make yourself at home.</h2>
          <div className="status-row">
            <span
              className={`status-dot ${online && state?.playback.connected ? '' : 'disconnected'}`}
            />
            <span>
              {state?.playback.connected
                ? 'Player connected'
                : 'Player unavailable'}
            </span>
          </div>
          <span className="demo-pill">
            {state?.backend === 'music-assistant'
              ? 'REAL TARGET CONTROL'
              : 'MOCK · NO AUDIO'}
          </span>
          <div className="control-block">
            <label>Physical volume buttons</label>
            <div className="button-pair">
              <button
                aria-label="Simulator volume down"
                disabled={!auth.session?.authenticated || !state}
                onClick={() =>
                  void run('/api/admin/playback', {
                    action: 'volume',
                    volume: Math.max(0, (state?.playback.volume ?? 0) - 5),
                  })
                }
              >
                −
              </button>
              <span>{state?.playback.volume ?? '—'}%</span>
              <button
                aria-label="Simulator volume up"
                disabled={!auth.session?.authenticated || !state}
                onClick={() =>
                  void run('/api/admin/playback', {
                    action: 'volume',
                    volume: Math.min(
                      state?.settings.maxVolume ?? 60,
                      (state?.playback.volume ?? 0) + 5,
                    ),
                  })
                }
              >
                +
              </button>
            </div>
          </div>
          <button className="lab-button" onClick={() => setScreen((v) => !v)}>
            <Power size={18} />
            {screen ? 'Switch screen off' : 'Switch screen on'}
          </button>
          <button className="lab-button" onClick={() => setNetwork((v) => !v)}>
            {network ? <WifiOff size={18} /> : <Wifi size={18} />}{' '}
            {network ? 'Disconnect device UI' : 'Reconnect device UI'}
          </button>
          {state?.backend === 'mock' && (
            <button
              className="lab-button"
              disabled={!auth.session?.authenticated}
              onClick={() =>
                void run('/api/admin/mock/connection', {
                  available: !state.playback.connected,
                })
              }
            >
              <Radio size={18} />
              {state.playback.connected
                ? 'Disconnect mock player'
                : 'Reconnect mock player'}
            </button>
          )}
          <div className="sim-track">
            <p className="eyebrow">ON THE JUKEBOX</p>
            <strong>{state?.playback.track?.name ?? 'Ready to play'}</strong>
            <span>
              {state?.playback.track?.artist ?? 'Tap a cover on the screen'}
            </span>
            <small>{state?.playback.status ?? 'Not paired'}</small>
          </div>
          {!auth.session?.authenticated ? (
            <p className="sim-note">
              Log in to <a href="/admin">Parent controls</a> and pair this
              browser to enable the player and lab controls.
            </p>
          ) : (
            <p className="sim-note">
              Screen buttons simulate the display. Parent screen controls and
              the night schedule also apply inside the device.
            </p>
          )}
          <ErrorNotice message={error} />
        </aside>
      </div>
      <footer className="sim-foot">
        Your library. Ready when you are.
        <span>
          Audio receiving clients are configured separately from this display.
        </span>
      </footer>
    </div>
  );
}
