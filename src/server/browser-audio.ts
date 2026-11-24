import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { BackendError } from './adapters/backend.js';

/** A single conventional MPD renderer for MA's supported MPD player provider.
 * MA owns the queue; the explicitly selected child browser renders its HTTP URL.
 * No PCM, audio scheduling or synchronization protocol runs in the browser.
 */
export class BrowserAudioGateway {
  private server: Server;
  private peers = new Map<Socket, { idle: boolean; changed: Set<string> }>();
  private transfers = new Set<AbortController>();
  private url = '';
  private generation = this.newGeneration();
  private state: 'play' | 'pause' | 'stop' = 'stop';
  private elapsed = 0;
  private volume = 25;
  private finishAt: number | null = null;
  finishAfter(seconds: number) {
    this.finishAt = this.elapsed + Math.max(0, seconds);
  }
  hasBoundary() {
    return this.finishAt !== null;
  }
  private owner = '';
  private client = '';
  private version = 0;
  private connectedAt = 0;
  constructor(
    private options: { url: string; token: string; allowedAddress?: string },
  ) {
    this.server = createServer((socket) => this.accept(socket));
    this.server.on('error', () => {});
  }
  private newGeneration() {
    return randomBytes(24).toString('base64url');
  }
  listen(port: number, host = '0.0.0.0') {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }
  connected() {
    return this.peers.size >= 2;
  }
  activeReceiver() {
    return (
      this.state === 'play' &&
      !!this.owner &&
      Date.now() - this.connectedAt < 90000
    );
  }
  address() {
    return this.server.address();
  }
  claim(client: string, owner: string) {
    if (client !== this.client || owner !== this.owner) {
      this.stop();
      this.client = client;
      this.owner = owner;
    }
    this.connectedAt = Date.now();
  }
  owned(client: string, owner: string) {
    return this.client === client && this.owner === owner;
  }
  view(client: string, owner: string) {
    if (!this.owned(client, owner)) return null;
    this.connectedAt = Date.now();
    return {
      generation: this.generation,
      status: this.state,
      volume: this.volume,
      elapsed: this.elapsed,
      finishAt: this.finishAt,
      src:
        this.url && this.state !== 'stop'
          ? `/api/child/audio/stream/${this.generation}?clientId=${client}`
          : null,
    };
  }
  private replace() {
    this.generation = this.newGeneration();
    for (const transfer of this.transfers) transfer.abort();
    this.transfers.clear();
  }
  stop() {
    this.replace();
    this.url = '';
    this.state = 'stop';
    this.finishAt = null;
    this.elapsed = 0;
    this.changed('player');
  }
  report(
    generation: string,
    event: 'progress' | 'ended' | 'error',
    elapsed: number,
  ) {
    if (generation !== this.generation)
      throw new BackendError('This audio stream has been replaced', 409);
    this.connectedAt = Date.now();
    if (event === 'progress') {
      this.elapsed = elapsed;
      this.changed('player');
    } else {
      this.state = event === 'ended' ? 'stop' : 'pause';
      this.changed('player');
    }
  }
  async stream(
    generation: string,
    range: string | undefined,
    res: Response,
    authorized: () => boolean,
    head = false,
  ) {
    if (generation !== this.generation || !this.url || !authorized())
      throw new BackendError('Audio stream is no longer available', 403);
    if (range && !/^bytes=\d+-\d*$/.test(range))
      throw new BackendError('Unsupported audio range', 416);
    const controller = new AbortController();
    this.transfers.add(controller);
    const cancel = () => controller.abort();
    res.once('close', cancel);
    const guard = setInterval(() => {
      if (!authorized() || generation !== this.generation) cancel();
    }, 500);
    try {
      const upstream = await fetch(this.url, {
        method: head ? 'HEAD' : 'GET',
        headers: {
          ...(range ? { Range: range } : {}),
          Authorization: `Bearer ${this.options.token}`,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!authorized() || generation !== this.generation)
        throw new BackendError('Audio stream has been replaced', 403);
      if (![200, 206, 416].includes(upstream.status))
        throw new BackendError('Music Assistant audio is unavailable', 502);
      const mime = upstream.headers.get('content-type')?.split(';')[0];
      if (
        upstream.status !== 416 &&
        ![
          'audio/mpeg',
          'audio/mp3',
          'audio/aac',
          'audio/aacp',
          'audio/mp4',
        ].includes(mime ?? '')
      )
        throw new BackendError(
          'Music Assistant must deliver MP3 or AAC audio',
          502,
        );
      res.status(upstream.status).set({
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'Content-Type': mime ?? 'audio/mpeg',
      });
      for (const header of [
        'content-length',
        'content-range',
        'accept-ranges',
      ]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (head || !upstream.body) {
        res.end();
        return;
      }
      await pipeline(
        Readable.fromWeb(
          upstream.body as import('node:stream/web').ReadableStream,
        ),
        res,
        { signal: controller.signal },
      );
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) throw error;
      res.destroy();
    } finally {
      clearInterval(guard);
      res.off('close', cancel);
      this.transfers.delete(controller);
      controller.abort();
    }
  }
  private validUrl(value: string) {
    const url = new URL(value);
    const ma = new URL(this.options.url);
    // MA resolves these URLs. Accept only this MA host's queue stream service,
    // never arbitrary media, redirects, userinfo or a browser-supplied URL.
    if (
      url.protocol !== ma.protocol ||
      url.hostname !== ma.hostname ||
      url.port !== '8097' ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/(?:single|flow)\/[^/]+\/[^/]+\/[^/]+\/[^/]+\.(mp3|aac)$/.test(
        url.pathname,
      )
    )
      throw Error('Invalid MA queue stream');
    return url.toString();
  }
  private changed(subsystem: string) {
    for (const [socket, peer] of this.peers) {
      peer.changed.add(subsystem);
      if (peer.idle) {
        peer.idle = false;
        socket.write(
          [...peer.changed].map((s) => `changed: ${s}\n`).join('') + 'OK\n',
        );
        peer.changed.clear();
      }
    }
  }
  private accept(socket: Socket) {
    const address = socket.remoteAddress?.replace(/^::ffff:/, '');
    if (
      this.options.allowedAddress &&
      address !== this.options.allowedAddress
    ) {
      socket.destroy();
      return;
    }
    if (this.peers.size >= 8) {
      socket.destroy();
      return;
    }
    const peer = { idle: false, changed: new Set<string>() };
    this.peers.set(socket, peer);
    socket.setEncoding('utf8');
    socket.write('OK MPD 0.23.0\n');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.length > 16384) {
        socket.destroy();
        return;
      }
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n');
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        const [command, ...args] = (
          line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []
        ).map((v) =>
          v.startsWith('"') ? v.slice(1, -1).replace(/\\(["\\])/g, '$1') : v,
        );
        try {
          let output = '';
          switch (command) {
            case 'idle':
              if (peer.changed.size) {
                output = [...peer.changed]
                  .map((s) => `changed: ${s}\n`)
                  .join('');
                peer.changed.clear();
              } else {
                peer.idle = true;
                continue;
              }
              break;
            case 'noidle':
              // A change may already have completed idle while noidle was in
              // flight. MPD ignores that late cancellation; another OK would
              // shift the client's next response into its idle parser.
              if (!peer.idle) continue;
              peer.idle = false;
              break;
            case 'ping':
              break;
            case 'status':
              // A closed browser cannot remain an audible renderer indefinitely.
              if (
                this.state === 'play' &&
                Date.now() - this.connectedAt > 90000
              )
                this.state = 'pause';
              output = `volume: ${this.volume}\nrepeat: 0\nrandom: 0\nsingle: 1\nconsume: 0\nplaylist: ${this.version}\nplaylistlength: ${this.url ? 1 : 0}\nstate: ${this.state}\nsong: 0\nsongid: ${this.version}\nelapsed: ${this.elapsed.toFixed(3)}\n`;
              break;
            case 'currentsong':
            case 'playlistinfo':
              output = this.url
                ? `file: ${this.url}\nPos: 0\nId: ${this.version}\n`
                : '';
              break;
            case 'clear':
              this.stop();
              this.version++;
              this.changed('playlist');
              break;
            case 'add':
              this.url = this.validUrl(args[0]);
              this.elapsed = 0;
              this.replace();
              this.version++;
              this.changed('playlist');
              break;
            case 'play':
              if (!this.url || !this.owner) throw Error('No selected browser');
              this.state = 'play';
              this.changed('player');
              break;
            case 'pause':
              this.state = args[0] === '0' ? 'play' : 'pause';
              this.changed('player');
              break;
            case 'stop':
              this.stop();
              break;
            case 'setvol':
              this.volume = Math.max(0, Math.min(100, Number(args[0]) || 0));
              this.changed('mixer');
              break;
            case 'seekcur':
              if (Number(args[0]) !== 0 || !this.url)
                throw Error('Only restart is supported');
              this.elapsed = 0;
              this.replace();
              this.changed('player');
              break;
            default:
              socket.write(`ACK [5@0] {${command}} unsupported command\n`);
              continue;
          }
          socket.write(output + 'OK\n');
        } catch {
          socket.write(`ACK [2@0] {${command}} invalid renderer request\n`);
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.peers.delete(socket));
  }
  close() {
    this.stop();
    for (const peer of this.peers.keys()) peer.destroy();
    this.server.close();
  }
}
