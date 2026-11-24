import { request as httpsRequest, Agent } from 'node:https';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BackendError } from '../adapters/backend.js';

export interface Transcript {
  text: string;
  noSpeech: boolean;
  durationMs: number;
}
export interface Transcriber {
  transcribe(
    bytes: Buffer,
    mime: string,
    signal?: AbortSignal,
  ): Promise<Transcript>;
  ready(): Promise<{ ready: boolean; model?: string; device?: string }>;
  close?(): void;
}
export class LocalTranscriber implements Transcriber {
  private url: URL;
  private agent: Agent;
  constructor(
    private config: {
      url: string;
      key: string;
      caFile?: string;
      timeoutMs?: number;
    },
  ) {
    this.url = new URL(config.url);
    if (
      (this.url.protocol !== 'https:' &&
        !(
          this.url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(this.url.hostname)
        )) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw Error(
        'VOICE_STT_URL must use HTTPS (HTTP is allowed only on loopback) without embedded credentials',
      );
    if (!config.key.trim() || /[\r\n]/.test(config.key))
      throw Error('A valid server-side voice API key is required');
    if (
      config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1000 ||
        config.timeoutMs > 60000)
    )
      throw Error('VOICE_STT_TIMEOUT_MS must be 1000–60000');
    this.agent = new Agent({
      ...(config.caFile ? { ca: readFileSync(config.caFile) } : {}),
      keepAlive: true,
    });
  }
  private async call(
    path: string,
    body?: Buffer,
    contentType?: string,
    signal?: AbortSignal,
    timeoutMs = this.config.timeoutMs ?? 35000,
  ): Promise<unknown> {
    const url = new URL(this.url.toString().replace(/\/$/, '') + path);
    const cancellation = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: body ? 'POST' : 'GET',
          ...(url.protocol === 'https:' ? { agent: this.agent } : {}),
          signal: cancellation,
          headers: {
            Authorization: `Bearer ${this.config.key}`,
            ...(body
              ? { 'Content-Type': contentType!, 'Content-Length': body.length }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) {
              response.destroy();
              reject(
                new BackendError(
                  'Voice service returned an invalid response',
                  502,
                ),
              );
            } else chunks.push(chunk);
          });
          response.on('error', () =>
            reject(
              new BackendError(
                'Voice service connection was interrupted. Please try again.',
                503,
              ),
            ),
          );
          response.on('end', () => {
            const status = response.statusCode ?? 503;
            if (status < 200 || status >= 300) {
              const messages: Record<number, string> = {
                401: 'Voice service authentication needs a parent’s attention.',
                413: 'That recording is too large. Please try a shorter request.',
                415: 'This recording format is not supported.',
                422: 'The recording could not be read. Please try again.',
                429: 'Voice search is busy. Please wait a moment and try again.',
                503: 'Voice search is temporarily unavailable. You can still choose music.',
                504: 'Voice search took too long. Please try again shortly.',
              };
              reject(
                new BackendError(
                  messages[status] ??
                    'Voice search is temporarily unavailable.',
                  status === 401
                    ? 502
                    : [413, 415, 422, 429, 503, 504].includes(status)
                      ? status
                      : 502,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(
                new BackendError(
                  'Voice service returned an invalid response',
                  502,
                ),
              );
            }
          });
        },
      );
      request.on('error', () =>
        reject(
          new BackendError(
            cancellation.aborted
              ? 'Voice search was cancelled or timed out. Please try again shortly.'
              : 'Voice search is temporarily unavailable. You can still choose music.',
            cancellation.aborted ? 504 : 503,
          ),
        ),
      );
      if (body) request.end(body);
      else request.end();
    });
  }
  async ready() {
    const result = z
      .object({
        status: z.string().optional(),
        model: z.string().optional(),
        device: z.string().optional(),
      })
      .passthrough()
      .parse(await this.call('/readyz', undefined, undefined, undefined, 5000));
    return { ready: true, model: result.model, device: result.device };
  }
  async transcribe(bytes: Buffer, mime: string, signal?: AbortSignal) {
    if (!['audio/wav', 'audio/x-wav', 'audio/webm'].includes(mime))
      throw new BackendError('Unsupported microphone recording', 415);
    const boundary = `hub-${randomBytes(16).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${mime.includes('wav') ? 'wav' : 'webm'}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const result = z
      .object({
        api_version: z.literal(1),
        text: z.string().max(4000),
        language: z.literal('en'),
        no_speech: z.boolean(),
        audio_duration_ms: z.number().int().min(100).max(15000),
      })
      .safeParse(
        await this.call(
          '/v1/transcribe',
          body,
          `multipart/form-data; boundary=${boundary}`,
          signal,
        ),
      );
    if (!result.success)
      throw new BackendError(
        'Voice service returned an invalid transcription',
        502,
      );
    return {
      text: result.data.no_speech ? '' : result.data.text.trim(),
      noSpeech: result.data.no_speech,
      durationMs: result.data.audio_duration_ms,
    };
  }
  close() {
    this.agent.destroy();
  }
}
