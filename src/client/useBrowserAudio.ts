import { useCallback, useEffect, useRef, useState } from 'react';
import { api, send, ApiError } from './api';
import { audioClientId } from './audioIdentity';
import { audioDeadline, silentAudioSource } from './nativeAudio';
type NativeState = {
  generation: string;
  status: 'play' | 'pause' | 'stop';
  src: string | null;
  volume: number;
  elapsed: number;
  finishAt?: number | null;
};
export function useBrowserAudio(
  enabled: boolean,
  _name: string,
  maxVolume: number,
  profileKey = 'default',
) {
  const [status, setStatus] = useState<
    'off' | 'ready' | 'connecting' | 'connected' | 'other-tab' | 'error'
  >('off');
  const [error, setError] = useState('');
  const [clientId, setClientId] = useState('');
  const cap = useRef(maxVolume);
  cap.current = maxVolume;
  const player = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const gain = useRef<GainNode | null>(null);
  const release = useRef<(() => void) | null>(null);
  const claimed = useRef(false);
  const current = useRef<NativeState | null>(null);
  const ducked = useRef(false);
  const activatingUntil = useRef(0);
  const mounted = useRef(false);
  const refreshAudio = useRef<(() => void) | null>(null);
  const playingGeneration = useRef<string | null>(null);
  const replacement = useRef<{
    generation: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const generation = useCallback(() => current.current?.generation ?? null, []);
  const waitForReplacement = useCallback(async (previous: string | null) => {
    // A passive sibling tab does not own the audio element and cannot certify
    // playback. Never claim its sibling's receiver just to observe a skip.
    if (!claimed.current) return;
    const started = () =>
      current.current?.generation !== previous &&
      playingGeneration.current === current.current?.generation &&
      !player.current?.paused;
    if (started()) return;
    if (player.current?.error)
      throw new Error(
        'The next song could not start. Tap Resume to try again.',
      );
    try {
      await audioDeadline(
        new Promise<void>((resolve, reject) => {
          replacement.current = { generation: previous, resolve, reject };
          refreshAudio.current?.();
        }),
        'The next song did not start. Tap Resume to try again.',
        15000,
      );
    } finally {
      replacement.current = null;
    }
  }, []);
  const applyGain = useCallback(() => {
    if (gain.current)
      gain.current.gain.value =
        // Fully controls Android's media stream. Applying this percentage to
        // Web Audio too would attenuate twice. Keep only microphone ducking.
        (window.__musicHubFully?.usesNativeVolume
          ? 1
          : Math.min(current.current?.volume ?? 25, cap.current) / 100) *
        (ducked.current ? 0.2 : 1);
  }, []);
  useEffect(applyGain, [maxVolume, applyGain]);
  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    mounted.current = true;
    const id = audioClientId();
    setClientId(id);
    const element = new Audio();
    const silence = silentAudioSource();
    element.dataset.bootstrap = silence;
    element.preload = 'auto';
    player.current = element;
    setStatus('ready');
    let disposed = false;
    let polling = false;
    let refreshRequested = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastReport = 0;
    const report = (event: 'progress' | 'ended' | 'error' | 'boundary') => {
      const state = current.current;
      if (
        !claimed.current ||
        !state?.src ||
        element.src !== new URL(state.src, location.href).href
      )
        return;
      void send('/api/child/audio/report', {
        clientId: id,
        generation: state.generation,
        event,
        elapsed: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      }).catch(() => {});
    };
    element.onended = () => report('ended');
    element.onplaying = () => {
      const state = current.current;
      if (
        !state?.src ||
        element.src !== new URL(state.src, location.href).href ||
        element.paused ||
        element.readyState < 2
      )
        return;
      playingGeneration.current = state.generation;
      if (
        replacement.current &&
        replacement.current.generation !== state.generation
      )
        replacement.current.resolve();
    };
    element.onerror = () => {
      if (!current.current?.src) return;
      report('error');
      setError('Audio was interrupted. Tap Resume to try again.');
      setStatus('error');
      replacement.current?.reject(
        new Error('The next song could not start. Tap Resume to try again.'),
      );
    };
    let completedBoundary = '';
    element.ontimeupdate = () => {
      const state = current.current;
      if (
        state?.finishAt != null &&
        element.currentTime >= state.finishAt &&
        completedBoundary !== state.generation
      ) {
        completedBoundary = state.generation;
        element.pause();
        report('boundary');
        return;
      }
      if (Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        report('progress');
      }
    };
    async function poll() {
      if (polling) {
        refreshRequested = true;
        return;
      }
      polling = true;
      clearTimeout(timer);
      try {
        if (claimed.current) {
          const state = await api<NativeState | null>(
            `/api/child/audio/state?clientId=${id}`,
          );
          if (disposed) return;
          const previous = current.current;
          current.current = state;
          applyGain();
          if (!state || !state.src) {
            const warmingUp =
              state &&
              element.src === element.dataset.bootstrap &&
              Date.now() < activatingUntil.current;
            if (!warmingUp) {
              element.pause();
              if (element.getAttribute('src')) {
                element.removeAttribute('src');
                element.load();
              }
            }
            // A revoked/replaced receiver must release its browser lock too,
            // so a freshly paired kiosk tab can open sound.
            if (!state) stop();
          } else {
            if (
              previous?.generation !== state.generation ||
              element.src !== new URL(state.src, location.href).href ||
              (state.status === 'play' && !!element.error)
            ) {
              activatingUntil.current = 0;
              element.loop = false;
              element.src = state.src;
              element.load();
            }
            if (
              state.status === 'play' &&
              element.paused &&
              !element.ended &&
              completedBoundary !== state.generation
            ) {
              try {
                await audioDeadline(
                  element.play(),
                  'Audio did not start. Tap Resume to try again.',
                );
              } catch (e) {
                report('error');
                throw e;
              }
              if (!disposed) {
                setStatus('connected');
                setError('');
              }
            } else if (state.status === 'pause') element.pause();
          }
        }
      } catch (e) {
        // Buffered native audio can ride out a short network interruption. Never
        // re-register/claim or restart a queue automatically on reconnect.
        if (!disposed) {
          if (e instanceof ApiError && e.status === 401) stop();
          setError((e as Error).message);
          setStatus('error');
          replacement.current?.reject(e as Error);
        }
      } finally {
        polling = false;
        if (!disposed) {
          if (refreshRequested) {
            refreshRequested = false;
            void poll();
          } else timer = setTimeout(() => void poll(), 1000);
        }
      }
    }
    refreshAudio.current = () => void poll();
    void poll();
    const stop = () => {
      replacement.current?.reject(
        new Error(
          'The audio receiver disconnected. Choose a song to try again.',
        ),
      );
      playingGeneration.current = null;
      claimed.current = false;
      if (mounted.current) setStatus('ready');
      element.pause();
      element.removeAttribute('src');
      element.load();
      release.current?.();
      release.current = null;
      // Safari may restore this page from its back/forward cache. Keep the
      // existing media-element graph: an element cannot be attached twice.
      void context.current?.suspend().catch(() => {});
    };
    window.addEventListener('pagehide', stop);
    return () => {
      disposed = true;
      mounted.current = false;
      clearTimeout(timer);
      refreshAudio.current = null;
      window.removeEventListener('pagehide', stop);
      stop();
      element.onended =
        element.onerror =
        element.ontimeupdate =
        element.onplaying =
          null;
      void context.current?.close();
      context.current = null;
      gain.current = null;
      URL.revokeObjectURL(silence);
      player.current = null;
      current.current = null;
    };
  }, [enabled, applyGain, profileKey]);
  async function startReceiver() {
    const element = player.current;
    if (!element)
      throw new Error('This browser audio receiver is not ready yet.');
    setError('');
    setStatus('connecting');
    try {
      // Both native playback and the small gain graph are unlocked by this tap.
      // No JavaScript decoding, PCM buffers, worklet, clock or sync correction.
      if (!context.current) {
        const actual = new AudioContext();
        const volume = actual.createGain();
        actual.createMediaElementSource(element).connect(volume);
        volume.connect(actual.destination);
        context.current = actual;
        gain.current = volume;
        applyGain();
      }
      const resumed = context.current.resume();
      if (
        !element.getAttribute('src') ||
        element.src === element.dataset.bootstrap
      ) {
        activatingUntil.current = Date.now() + 45000;
        element.src = element.dataset.bootstrap!;
        element.loop = true;
        // Call play in the tap, but do not gate registration on Safari resolving
        // its bootstrap promise. Changing to the real stream may abort it.
        void element.play().catch(() => {});
      }
      await audioDeadline(
        resumed,
        'This browser could not activate sound. Tap a song to try again.',
      );
      const connect = async () => {
        await send('/api/child/audio/register', {
          clientId: audioClientId(),
          claim: true,
        });
        claimed.current = true;
        if (mounted.current) {
          setStatus('connected');
          setError('');
        }
      };
      if (release.current) {
        await connect();
        return;
      }
      if (navigator.locks) {
        let ready!: () => void;
        let failed!: (error: Error) => void;
        const connected = new Promise<void>((resolve, reject) => {
          ready = resolve;
          failed = reject;
        });
        void navigator.locks
          .request('music-hub-audio', { ifAvailable: true }, async (lock) => {
            if (!lock) {
              if (mounted.current) setStatus('other-tab');
              failed(
                new Error(
                  'Sound is open in another player tab. Close that tab first.',
                ),
              );
              return;
            }
            await new Promise<void>((resolve) => {
              release.current = resolve;
              void connect()
                .then(ready)
                .catch((e) => {
                  failed(e);
                  if (mounted.current) {
                    setStatus('error');
                    setError((e as Error).message);
                  }
                  resolve();
                  release.current = null;
                });
            });
          })
          .catch(failed);
        await audioDeadline(
          connected,
          'This browser could not open its audio tab. Close other player tabs and try again.',
          30000,
        );
      } else {
        // LAN HTTP browsers may lack Web Locks. A renewable local lease prevents
        // ordinary duplicate tabs from taking over the same persisted receiver.
        const key = 'music-hub-audio-lease';
        const previous = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (previous && previous.expires > Date.now()) {
          setStatus('other-tab');
          throw new Error(
            'Sound is open in another player tab. Close that tab first.',
          );
        }
        const owner = Array.from(
          crypto.getRandomValues(new Uint8Array(16)),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('');
        const renew = () =>
          localStorage.setItem(
            key,
            JSON.stringify({ owner, expires: Date.now() + 120000 }),
          );
        renew();
        const interval = setInterval(renew, 15000);
        release.current = () => {
          clearInterval(interval);
          if (JSON.parse(localStorage.getItem(key) ?? 'null')?.owner === owner)
            localStorage.removeItem(key);
        };
        await connect();
      }
    } catch (e) {
      if (mounted.current) {
        setStatus('error');
        setError((e as Error).message);
      }
      throw e;
    }
  }
  const duck = useCallback(() => {
    ducked.current = true;
    applyGain();
    return () => {
      ducked.current = false;
      applyGain();
    };
  }, [applyGain]);
  const cancelPending = useCallback(() => {
    activatingUntil.current = 0;
    const element = player.current;
    if (element && element.src === element.dataset.bootstrap) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
  }, []);
  const watchAnalyser = useCallback(
    (onChange: (analyser: AnalyserNode | null) => void) => {
      const element = player.current;
      const graph = context.current;
      const source = gain.current;
      if (!element || !graph || !source || !claimed.current) return;
      let analyser: AnalyserNode | null = null;
      const detach = () => {
        if (!analyser) return;
        source.disconnect(analyser);
        analyser = null;
        onChange(null);
      };
      const attach = () => {
        if (
          !claimed.current ||
          document.hidden ||
          graph.state !== 'running' ||
          element.paused ||
          element.ended ||
          element.seeking ||
          element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
          element.src === element.dataset.bootstrap
        ) {
          detach();
          return;
        }
        if (analyser) return;
        analyser = graph.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.25;
        // The meter is a side branch of the existing speaker path.
        source.connect(analyser);
        onChange(analyser);
      };
      const stopEvents = [
        'pause',
        'waiting',
        'seeking',
        'ended',
        'emptied',
        'error',
      ];
      for (const event of stopEvents) element.addEventListener(event, detach);
      element.addEventListener('playing', attach);
      graph.addEventListener('statechange', attach);
      document.addEventListener('visibilitychange', attach);
      attach();
      return () => {
        for (const event of stopEvents)
          element.removeEventListener(event, detach);
        element.removeEventListener('playing', attach);
        graph.removeEventListener('statechange', attach);
        document.removeEventListener('visibilitychange', attach);
        detach();
      };
    },
    [],
  );
  return {
    status,
    error,
    clientId,
    generation,
    waitForReplacement,
    enable: startReceiver,
    cancelPending,
    duck,
    watchAnalyser,
  };
}
