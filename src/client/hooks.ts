import { useState, useEffect, useCallback, useRef } from 'react';
import { api, setSession, setChildContext } from './api';
import type { SessionInfo, HubState } from '../shared/types';
import type { LiveMessage } from './live-worker';
export function useSession(role: 'parent' | 'child') {
  const [session, update] = useState<SessionInfo | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const s = await api<SessionInfo>(
        role === 'parent' ? '/api/auth/session' : '/api/child/session',
      );
      setSession(role, s);
      update(s);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [role]);
  useEffect(() => {
    void load();
  }, [load]);
  return {
    session,
    error,
    reload: load,
    accept: (s: SessionInfo) => {
      setSession(role, s);
      update(s);
    },
  };
}
export function useLive(
  role: 'parent' | 'child',
  enabled: boolean,
  deviceId?: string,
) {
  // Profile-specific data is always loaded from the authenticated server;
  // the former shared last-state cache must not display another child's taste.
  const [state, setState] = useState<HubState | null>(null);
  const seen = useRef<{ deviceId: string; revision: number } | null>(null);
  const adopt = useCallback(
    (next: HubState) => {
      if (role === 'child' && next.personal) {
        if (
          seen.current?.deviceId === next.personal.deviceId &&
          seen.current.revision > next.personal.revision
        )
          return;
        seen.current = {
          deviceId: next.personal.deviceId,
          revision: next.personal.revision,
        };
        setChildContext(next.personal);
      }
      setState(next);
    },
    [role],
  );
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) {
      setState(null);
      seen.current = null;
      setOnline(false);
      setError('');
      return;
    }
    let active = true;
    const path = role === 'parent' ? 'admin' : 'child';
    let worker: SharedWorker | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    const accept = (s: HubState) => {
      if (!active || !navigator.onLine) return;
      adopt(s);
      setOnline(true);
      setError('');
    };
    const stop = () => {
      generation++;
      worker?.port.postMessage({ type: 'unsubscribe' });
      worker?.port.close();
      worker = null;
      if (poll) clearTimeout(poll);
      if (readyTimer) clearTimeout(readyTimer);
      poll = readyTimer = null;
    };
    const disconnect = () => {
      stop();
      setOnline(false);
      setError('Connection interrupted. Reconnecting…');
    };
    // Older kiosk browsers use finite, serialized reads rather than one persistent
    // HTTP/1 connection per tab. Reads use the server's existing shared snapshot.
    const polling = () => {
      stop();
      const current = generation;
      const read = async () => {
        try {
          const result = await api<HubState>(`/api/${path}/state`);
          if (active && current === generation) accept(result);
        } catch (e) {
          if (active && current === generation) {
            setOnline(false);
            setError((e as Error).message);
          }
        }
        if (active && current === generation)
          poll = setTimeout(() => void read(), 3000);
      };
      void read();
    };
    const connect = () => {
      stop();
      if (!navigator.onLine) {
        disconnect();
        return;
      }
      if (typeof SharedWorker === 'undefined') {
        polling();
        return;
      }
      try {
        const current = generation;
        worker = new SharedWorker(
          new URL('./live-worker.ts', import.meta.url),
          {
            type: 'module',
            name: `music-hub-live-${role}${deviceId ? '-' + deviceId : ''}`,
          },
        );
        worker.onerror = () => {
          if (active && current === generation) polling();
        };
        worker.port.onmessage = (event: MessageEvent<LiveMessage>) => {
          if (!active || current !== generation) return;
          if (event.data.type === 'ready') {
            if (readyTimer) clearTimeout(readyTimer);
            readyTimer = null;
          } else if (event.data.type === 'state') {
            accept(event.data.state);
          } else {
            setOnline(false);
            setError('Live updates interrupted. Reconnecting…');
          }
        };
        worker.port.start();
        worker.port.postMessage({ type: 'subscribe', role });
        readyTimer = setTimeout(polling, 5000);
      } catch {
        polling();
      }
    };
    window.addEventListener('offline', disconnect);
    window.addEventListener('online', connect);
    window.addEventListener('pagehide', disconnect);
    window.addEventListener('pageshow', connect);
    connect();
    return () => {
      active = false;
      stop();
      window.removeEventListener('offline', disconnect);
      window.removeEventListener('online', connect);
      window.removeEventListener('pagehide', disconnect);
      window.removeEventListener('pageshow', connect);
    };
  }, [role, enabled, deviceId, adopt]);
  return {
    state,
    online,
    error,
    update: adopt,
  };
}
