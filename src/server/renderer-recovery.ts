import { BackendError } from './adapters/backend.js';
import type { MusicAssistantBackend } from './adapters/music-assistant.js';
interface Link {
  playerId: string;
  connected(): boolean;
  active(): boolean;
}
/** MA 2.10 can retain disconnected MPD clients after a renderer restart.
 * Recover only the dedicated hub provider, never an active or shared provider. */
export class RendererRecovery {
  private pending: Promise<void> | null = null;
  private attemptedAt = -Infinity;
  constructor(
    private backend: Pick<MusicAssistantBackend, 'rpc'>,
    private links: Link[],
    private log: (message: string) => void,
    private clock = () => Date.now(),
    private pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  ensure(playerId?: string): Promise<void> {
    if (this.pending) return this.pending;
    const selected = playerId
      ? this.links.filter((l) => l.playerId === playerId)
      : this.links;
    if (!selected.length || selected.every((l) => l.connected()))
      return Promise.resolve();
    if (this.links.some((l) => l.active()))
      return Promise.reject(
        new BackendError(
          'This player’s music connection is unavailable. Try again when the other player has stopped.',
        ),
      );
    if (this.clock() - this.attemptedAt < 30000)
      return Promise.reject(
        new BackendError(
          'The music connection is recovering. Please try Play again in a moment.',
        ),
      );
    this.attemptedAt = this.clock();
    this.pending = this.reconnect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async reconnect() {
    const providers = await this.backend.rpc('providers');
    const mpd = Array.isArray(providers)
      ? providers.filter((p) => p.domain === 'mpd')
      : [];
    if (mpd.length !== 1 || typeof mpd[0].instance_id !== 'string')
      throw new BackendError(
        'The music player connection needs attention in Parent settings.',
      );
    const instance = mpd[0].instance_id;
    const config = await this.backend.rpc('config/providers/get', {
      instance_id: instance,
    });
    const hosts = config?.values?.manual_discovery_ip_addresses?.value;
    const ids = Array.isArray(hosts)
      ? hosts.map((host: unknown) => {
          if (typeof host !== 'string') return '';
          const [address, port = '6600'] = host.trim().split(':');
          return `mpd_${address}_${port}`;
        })
      : [];
    const expected = this.links.map((l) => l.playerId);
    if (
      ids.length !== expected.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !expected.includes(id))
    )
      throw new BackendError(
        'The music player connection needs attention in Parent settings.',
      );
    // A source lookup can take time: never disrupt audio started meanwhile.
    if (this.links.some((l) => l.active()))
      throw new BackendError(
        'Another player started music. Please try again later.',
      );
    if (this.links.every((l) => l.connected())) return;
    this.log('Reconnecting dedicated Music Assistant renderer connections');
    await this.backend.rpc('config/providers/reload', {
      instance_id: instance,
    });
    const deadline = this.clock() + 8000;
    while (!this.links.every((l) => l.connected()) && this.clock() < deadline)
      await this.pause(200);
    if (!this.links.every((l) => l.connected())) {
      this.log('Music Assistant renderer reconnection did not finish');
      throw new BackendError(
        'The music connection is recovering. Please try Play again in a moment.',
      );
    }
    this.log('Music Assistant renderer connections restored');
  }
  async close() {
    await this.pending?.catch(() => {});
  }
}
