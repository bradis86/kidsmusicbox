import type { HubState } from '../shared/types';

export type LiveMessage =
  { type: 'ready' } | { type: 'state'; state: HubState } | { type: 'error' };

// A named shared worker owns one stream per role, across tabs and simulator frames.
// Parent and child workers have distinct names and never exchange snapshots.
const ports = new Set<MessagePort>();
let role: 'parent' | 'child' | null = null;
let stream: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
function broadcast(message: LiveMessage) {
  for (const port of ports) port.postMessage(message);
}
function stop() {
  stream?.close();
  stream = null;
  if (retry) clearTimeout(retry);
  retry = null;
}
function connect() {
  if (stream || !ports.size || !role) return;
  const source = new EventSource(
    `/api/${role === 'parent' ? 'admin' : 'child'}/events`,
  );
  stream = source;
  source.onmessage = (event) => {
    try {
      broadcast({ type: 'state', state: JSON.parse(event.data) });
    } catch {
      broadcast({ type: 'error' });
    }
  };
  source.onerror = () => {
    broadcast({ type: 'error' });
    if (source.readyState === EventSource.CLOSED) {
      stop();
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 3000);
    }
  };
}
const scope = globalThis as unknown as {
  onconnect: (event: MessageEvent) => void;
};
scope.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (event) => {
    const message = event.data;
    if (
      message.type === 'subscribe' &&
      ['parent', 'child'].includes(message.role)
    ) {
      if (role && role !== message.role) return;
      role = message.role;
      ports.add(port);
      port.postMessage({ type: 'ready' } satisfies LiveMessage);
      connect();
    } else if (message.type === 'unsubscribe') {
      ports.delete(port);
      port.close();
      if (!ports.size) stop();
    }
  };
  port.start();
};
