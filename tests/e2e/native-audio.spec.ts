import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { HubState } from '../../src/shared/types';

for (const {
  stuckContext,
  fallback,
  fully = false,
  failedNext = false,
  stalledNext = false,
} of [
  { stuckContext: false, fallback: false },
  { stuckContext: false, fallback: true },
  { stuckContext: true, fallback: false },
  { stuckContext: false, fallback: false, fully: true },
  { stuckContext: false, fallback: false, failedNext: true },
  { stuckContext: false, fallback: false, stalledNext: true },
])
  test(
    stalledNext
      ? 'next song loading times out when replacement audio never arrives'
      : failedNext
        ? 'next song loading survives acknowledgement and clears on decoder failure'
        : fully
          ? 'Fully uses native media volume above 40 percent without double gain'
          : stuckContext
            ? 'audio activation timeout clears Starting and leaves a retryable player'
            : fallback
              ? 'native MP3 starts without Web Locks and releases its kiosk lease'
              : 'native MP3 starts despite a pending Safari bootstrap promise and resumes a suspended context',
    async ({ page }) => {
      test.setTimeout(45000);
      const visualizerRequests: string[] = [];
      page.on('request', (request) => {
        if (/\/assets\/Visualizer-[\w-]+\.js$/.test(request.url()))
          visualizerRequests.push(request.url());
      });
      // A real compressed synthetic tone exercises the browser decoder and gain
      // graph; this fixture does not claim to exercise a live MA provider or speaker.
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        'data/e2e-microphone.wav',
        '-af',
        fully
          ? "aloop=loop=8:size=32000,volume='if(lt(t,5),0.35,if(lt(t,7),10,if(lt(t,8.5),0,1)))':eval=frame"
          : 'aloop=loop=8:size=32000',
        '-t',
        '15',
        '-codec:a',
        'libmp3lame',
        'data/e2e-native.mp3',
      ]);
      const mp3 = readFileSync('data/e2e-native.mp3');
      if (fully) {
        await page.setViewportSize({ width: 788, height: 492 });
        await page.addInitScript(() => {
          let volume = 40;
          const metrics = { connections: 0, samples: 0, signal: false };
          Object.assign(window, { visualizerMetrics: metrics });
          const createAnalyser = AudioContext.prototype.createAnalyser;
          AudioContext.prototype.createAnalyser = function () {
            const analyser = createAnalyser.call(this);
            metrics.connections++;
            const read = analyser.getByteFrequencyData.bind(analyser);
            analyser.getByteFrequencyData = (buffer) => {
              read(buffer);
              metrics.samples++;
              metrics.signal ||= buffer.some((value) => value > 0);
            };
            return analyser;
          };
          const disconnect = GainNode.prototype.disconnect;
          GainNode.prototype.disconnect = function (...args: unknown[]) {
            if (args[0] instanceof AnalyserNode) metrics.connections--;
            Reflect.apply(disconnect, this, args);
          };
          window.fully = {
            bind: () => {},
            getAudioVolume: () => volume,
            setAudioVolume: (level) => {
              volume = level;
            },
            getScreenOn: () => true,
            turnScreenOn: () => {},
            turnScreenOff: () => {},
          };
        });
      }
      if (fallback)
        await page.addInitScript(() =>
          Object.defineProperty(navigator, 'locks', { value: undefined }),
        );
      await page.addInitScript((stuck) => {
        if (stuck)
          AudioContext.prototype.resume = () => new Promise<void>(() => {});
        const createGain = AudioContext.prototype.createGain;
        AudioContext.prototype.createGain = function () {
          (window as unknown as { nativeContext: AudioContext }).nativeContext =
            this;
          const gain = createGain.call(this);
          (window as unknown as { nativeGain: GainNode }).nativeGain = gain;
          return gain;
        };
        Object.defineProperty(window, 'SharedWorker', { value: undefined });
        const original = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          (window as unknown as { nativeAudio: HTMLMediaElement }).nativeAudio =
            this;
          const played = original.call(this);
          if (this.src.startsWith('blob:')) {
            void played.catch(() => {});
            return new Promise<void>(() => {});
          }
          return played;
        };
      }, stuckContext);
      const track = {
        id: 'fixture-track',
        uri: 'fixture://track/song',
        name: 'Native tone',
        artist: 'Synthetic fixture',
        duration: 15,
        artwork: '/art/fallback.svg',
      };
      const item = {
        id: 'fixture',
        uri: 'fixture://playlist/test',
        name: 'Native fixture',
        kind: fully ? ('album' as const) : ('playlist' as const),
        artist: 'Test',
        artwork: '/art/fallback.svg',
        provider: 'fixture',
        displayName: 'Native fixture',
        position: 0,
        artworkOverride: fully ? '/art/forest.svg' : null,
        hiddenTrackIds: [],
      };
      const state: HubState = {
        backend: 'music-assistant',
        collection: [item],
        voice: { enabled: false, maxRecordingSeconds: 10 },
        playback: {
          status: 'idle',
          connected: true,
          playerId: '',
          track: null,
          elapsed: 0,
          volume: 25,
          shuffle: false,
          repeat: false,
          collectionId: null,
          simulated: false,
        },
        device: {
          name: 'Native test',
          screenOff: false,
          screenReason: '',
          bedtime: false,
          online: true,
          lastSeen: null,
        },
        settings: {
          maxVolume: 60,
          shuffle: false,
          repeat: false,
          inactivitySeconds: 120,
          inactivityMode: 'none',
          playbackMode: 'local',
        },
      };
      let native: {
        generation: string;
        status: string;
        src: string | null;
        volume: number;
        elapsed: number;
        finishAt?: number | null;
      } | null = null;
      let expired = false;
      let starts = 0,
        claims = 0;
      const reports: string[] = [];
      let releaseNextStream!: () => void;
      const nextStreamReady = new Promise<void>((resolve) => {
        releaseNextStream = resolve;
      });
      let nextStreamRequested = false;
      await page.context().route('**/api/child/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        let body: unknown = {};
        if (url.pathname === '/api/child/session')
          body = { authenticated: true, csrf: 'test' };
        else if (url.pathname === '/api/child/state') body = state;
        else if (url.pathname.includes('/collection/'))
          body = { tracks: [track] };
        else if (url.pathname === '/api/child/audio/register') {
          claims++;
          state.playback.playerId = req.postDataJSON().clientId;
          if (!native)
            native = {
              generation: 'warming',
              status: 'stop',
              src: null,
              volume: 25,
              elapsed: 0,
            };
        } else if (url.pathname === '/api/child/audio/state') {
          if (expired) {
            await route.fulfill({
              status: 401,
              json: { error: 'Pair this player first' },
            });
            return;
          }
          body = native;
        } else if (url.pathname.startsWith('/api/child/audio/stream/')) {
          if (url.pathname === '/api/child/audio/stream/3') {
            nextStreamRequested = true;
            await nextStreamReady;
            if (failedNext) {
              await route.fulfill({ status: 502, body: 'Audio unavailable' });
              return;
            }
          }
          await route.fulfill({
            status: 200,
            contentType: 'audio/mpeg',
            body: mp3,
          });
          return;
        } else if (url.pathname === '/api/child/audio/report') {
          const report = req.postDataJSON();
          reports.push(report.event);
          if (report.event === 'ended') native = null;
          if (report.event === 'boundary') {
            starts++;
            native = {
              generation: String(starts),
              status: 'play',
              src: `/api/child/audio/stream/${starts}`,
              volume: 25,
              elapsed: 0,
            };
          }
        } else if (url.pathname === '/api/child/playback') {
          const command = req.postDataJSON();
          if (command.action === 'start' || command.action === 'next') {
            if (command.action === 'start')
              await new Promise((resolve) => setTimeout(resolve, 1800));
            starts++;
            native = {
              generation: String(starts),
              status: 'play',
              src: `/api/child/audio/stream/${starts}`,
              volume: 25,
              elapsed: 0,
            };
            state.playback = {
              ...state.playback,
              track,
              status: 'playing',
              collectionId: item.id,
            };
          } else if (command.action === 'volume' && native) {
            state.playback.volume = native.volume = Math.min(
              60,
              command.volume,
            );
          } else if (command.action === 'pause' && native) {
            native.status = 'pause';
            state.playback.status = 'paused';
          } else if (command.action === 'play' && native) {
            native.status = 'play';
            state.playback.status = 'playing';
          }
          body = state;
        }
        await route.fulfill({ json: body });
      });
      const time = () =>
        page.evaluate(
          () =>
            (window as unknown as { nativeAudio?: HTMLAudioElement })
              .nativeAudio?.currentTime ?? 0,
        );
      await page.goto('/child');
      await page
        .getByRole('button', { name: 'Open Native fixture', exact: true })
        .click();
      expect(claims).toBe(0);
      await page.getByRole('button', { name: 'Play all', exact: true }).click();
      const loading = page.getByRole('status', { name: 'Loading music' });
      await expect(loading).toBeVisible();
      const symbol = await loading
        .locator('.music-loading-symbol')
        .boundingBox();
      expect(symbol!.width).toBeGreaterThanOrEqual(140);
      expect(symbol!.height).toBeGreaterThanOrEqual(140);
      if (stuckContext) {
        await expect(
          page
            .getByRole('alert')
            .filter({ hasText: 'could not activate sound' })
            .first(),
        ).toBeVisible({ timeout: 12000 });
        await expect(
          page.getByRole('button', { name: 'Play all', exact: true }),
        ).toBeEnabled();
        expect(claims).toBe(0);
        await expect(loading).toHaveCount(0);
        return;
      }
      await expect.poll(() => starts).toBe(0);
      await page.waitForTimeout(1100);
      expect(
        await page.evaluate(() => {
          const a = (window as unknown as { nativeAudio: HTMLAudioElement })
            .nativeAudio;
          return a.loop && !a.paused;
        }),
      ).toBe(true);
      await expect.poll(time).toBeGreaterThan(1);
      await expect(loading).toHaveCount(0);
      expect(starts).toBe(1);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { nativeAudio: HTMLAudioElement }).nativeAudio
              .readyState,
        ),
      ).toBeGreaterThanOrEqual(2);
      if (fully) {
        const gain = () =>
          page.evaluate(
            () =>
              (window as unknown as { nativeGain: GainNode }).nativeGain.gain
                .value,
          );
        await expect.poll(gain).toBe(1);
        const slider = page.getByRole('slider', {
          name: 'Volume',
          exact: true,
        });
        await slider.fill('55');
        await expect
          .poll(() => page.evaluate(() => window.fully!.getAudioVolume(3)))
          .toBe(55);
        await expect.poll(() => state.playback.volume).toBe(55);
        await page.evaluate(() => window.__musicHubFully!.key(5));
        await expect(slider).toHaveValue('60');
        await expect
          .poll(() => page.evaluate(() => window.fully!.getAudioVolume(3)))
          .toBe(60);
        await expect.poll(() => state.playback.volume).toBe(60);
        await expect.poll(gain).toBe(1);
        const metrics = () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  visualizerMetrics: {
                    connections: number;
                    samples: number;
                    signal: boolean;
                  };
                }
              ).visualizerMetrics,
          );
        expect(visualizerRequests).toHaveLength(0);
        expect(await metrics()).toEqual({
          connections: 0,
          samples: 0,
          signal: false,
        });
        const open = page.getByRole('button', {
          name: 'Visualizer',
          exact: true,
        });
        await open.click();
        const visualizer = page.getByRole('region', {
          name: 'Music visualizer',
        });
        await expect(visualizer).toBeVisible();
        await expect(visualizer.locator('img')).toHaveAttribute(
          'src',
          '/art/forest.svg',
        );
        expect(visualizerRequests).toHaveLength(1);
        await expect.poll(async () => (await metrics()).signal).toBe(true);
        expect((await metrics()).connections).toBe(1);
        const drawingStrength = () =>
          visualizer.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
            const { width, height } = canvas;
            const pixels = canvas
              .getContext('2d')!
              .getImageData(0, 0, width, height).data;
            let alpha = 0;
            for (let i = 3; i < pixels.length; i += 4) alpha += pixels[i];
            return alpha;
          });
        await expect.poll(time).toBeGreaterThan(4);
        const quiet = await drawingStrength();
        expect(quiet).toBeGreaterThan(0);
        await expect
          .poll(drawingStrength, { intervals: [50] })
          .toBeGreaterThan(quiet * 2);
        expect(await time()).toBeLessThan(6);
        const loud = await drawingStrength();
        await expect
          .poll(drawingStrength, { intervals: [50] })
          .toBeLessThan(loud * 0.55);
        expect(await time()).toBeLessThan(8);
        const styles = visualizer.getByLabel('Visualization style');
        await styles.selectOption('orbit');
        await styles.selectOption('horizon');
        await page
          .getByRole('button', { name: 'Pause playback', exact: true })
          .click();
        await expect.poll(async () => (await metrics()).connections).toBe(0);
        const paused = (await metrics()).samples;
        await page.waitForTimeout(160);
        expect((await metrics()).samples).toBe(paused);
        await page
          .getByRole('button', { name: 'Resume playback', exact: true })
          .click();
        await expect(visualizer).toBeVisible();
        await expect(styles).toHaveValue('horizon');
        await expect.poll(async () => (await metrics()).connections).toBe(1);
        await visualizer
          .getByRole('button', { name: 'Now Playing', exact: true })
          .click();
        await expect(visualizer).toHaveCount(0);
        await expect(open).toBeFocused();
        await expect.poll(async () => (await metrics()).connections).toBe(0);
        const closed = (await metrics()).samples;
        await page.waitForTimeout(180);
        expect((await metrics()).samples).toBe(closed);
        await open.click();
        await expect.poll(async () => (await metrics()).connections).toBe(1);
        state.device.screenOff = true;
        await expect(visualizer).toHaveCount(0);
        await expect.poll(async () => (await metrics()).connections).toBe(0);
        const blanked = (await metrics()).samples;
        await page.waitForTimeout(160);
        expect((await metrics()).samples).toBe(blanked);
        expect(await gain()).toBe(1);
        return;
      }
      // A second tab shares the pairing/renderer ID, but the first owns the
      // real Web Lock and MP3 receiver. Pause must not activate a new receiver.
      const sibling = await page.context().newPage();
      await sibling.addInitScript(() => {
        Object.defineProperty(window, 'SharedWorker', { value: undefined });
        AudioContext.prototype.resume = () => {
          throw new Error('Passive controls must not activate browser audio');
        };
      });
      await sibling.goto('/child');
      const claimsBeforePause = claims;
      await sibling.getByRole('button', { name: 'Pause playback' }).click();
      await expect(
        sibling.getByRole('button', { name: 'Resume playback' }),
      ).toBeVisible();
      await expect(sibling.getByRole('alert')).toHaveCount(0);
      expect(claims).toBe(claimsBeforePause);
      await sibling.close();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { nativeAudio: HTMLAudioElement })
                .nativeAudio.paused,
          ),
        )
        .toBe(true);
      const pausedAt = await time();
      await page.waitForTimeout(700);
      expect(await time()).toBe(pausedAt);
      await page.evaluate(async () => {
        window.dispatchEvent(
          new PageTransitionEvent('pagehide', { persisted: true }),
        );
        await (
          window as unknown as { nativeContext: AudioContext }
        ).nativeContext.suspend();
        window.dispatchEvent(
          new PageTransitionEvent('pageshow', { persisted: true }),
        );
      });
      await page.getByRole('button', { name: 'Resume playback' }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { nativeContext: AudioContext })
                .nativeContext.state,
          ),
        )
        .toBe('running');
      await expect.poll(time).toBeGreaterThan(0.2);
      native!.finishAt = (await time()) + 0.5;
      await expect.poll(() => reports).toContain('boundary');
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { nativeAudio: HTMLAudioElement })
                .nativeAudio.src,
          ),
        )
        .toContain('/stream/2');
      await expect.poll(time).toBeGreaterThan(0.2);
      await page.getByRole('button', { name: 'Next song' }).click();
      await expect(loading).toContainText('Loading next song…');
      await expect.poll(() => nextStreamRequested).toBe(true);
      // The command is acknowledged and the new HTTP stream is requested, but
      // no decodable audio has arrived. A server reply must not hide loading.
      await expect(loading).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Next song' }),
      ).toBeDisabled();
      if (stalledNext) {
        await expect(loading).toHaveCount(0, { timeout: 18000 });
        await expect(
          page
            .getByRole('alert')
            .filter({ hasText: /(?:Audio|next song) did not start/ })
            .first(),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Next song' }),
        ).toBeEnabled();
        expect(starts).toBe(3);
        releaseNextStream();
        return;
      }
      releaseNextStream();
      if (failedNext) {
        await expect(loading).toHaveCount(0);
        await expect(
          page
            .getByRole('alert')
            .filter({ hasText: /could not start|interrupted/ })
            .first(),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Next song' }),
        ).toBeEnabled();
        expect(starts).toBe(3); // A failed stream never retries the skip command.
        return;
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { nativeAudio: HTMLAudioElement })
                .nativeAudio.src,
          ),
        )
        .toContain('/stream/3');
      await expect(loading).toHaveCount(0);
      await expect.poll(time).toBeGreaterThan(0.2);
      await expect.poll(() => reports, { timeout: 20000 }).toContain('ended');
      // Losing server ownership (null state) releases the browser lock too.
      const ownsAudioLock = () =>
        page.evaluate(async () => {
          if (!navigator.locks) {
            const lease = JSON.parse(
              localStorage.getItem('music-hub-audio-lease') ?? 'null',
            );
            return !!lease && lease.expires > Date.now();
          }
          return (
            (await navigator.locks.query()).held?.some(
              (lock) => lock.name === 'music-hub-audio',
            ) ?? false
          );
        });
      await expect.poll(ownsAudioLock).toBe(false);
      const claimsBefore = claims;
      await page.reload();
      await page
        .getByRole('button', { name: 'Open Native fixture', exact: true })
        .waitFor();
      await page.waitForTimeout(1500);
      expect(claims).toBe(claimsBefore);
      expect(starts).toBe(3);
      await page
        .getByRole('button', { name: 'Open Native fixture', exact: true })
        .click();
      await page.getByRole('button', { name: 'Play all', exact: true }).click();
      await expect.poll(time).toBeGreaterThan(0.2);
      await expect.poll(ownsAudioLock).toBe(true);
      const claimsBeforeExpiry = claims;
      expired = true;
      await expect.poll(ownsAudioLock).toBe(false);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { nativeAudio: HTMLAudioElement }).nativeAudio
              .paused,
        ),
      ).toBe(true);
      expect(claims).toBe(claimsBeforeExpiry);
    },
  );
