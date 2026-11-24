import { test, expect } from '@playwright/test';
test('parent curates, child plays, settings persist, screen blanks, and approval removal propagates', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Make yourself at home.' }),
  ).toBeVisible();
  await page
    .getByLabel('Setup code', { exact: true })
    .fill('playwright-one-time-code');
  await page
    .getByLabel('Parent password', { exact: true })
    .fill('a secure e2e password');
  await page.getByRole('button', { name: 'Create parent account' }).click();
  await expect(
    page.getByRole('heading', { name: 'The music library.', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page
    .getByLabel('Parent password', { exact: true })
    .fill('a secure e2e password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'The music library.', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings & bedtime' }).click();
  await page
    .getByRole('button', { name: 'Pair this browser', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'This browser is paired',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Browse library', exact: true })
    .click();
  await page
    .getByLabel('Spotify playlist link', { exact: true })
    .fill('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  await page
    .getByRole('button', { name: 'Preview playlist', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Connect Music Assistant' }),
  ).toBeVisible();
  // Inspect an unapproved playlist, recover from a failed read, and approve from its preview.
  await page.route(
    '**/api/admin/tracks?*',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Playlist temporarily unavailable' }),
      }),
    { times: 1 },
  );
  await page
    .getByRole('button', { name: 'View tracks in Sunbeams', exact: true })
    .click();
  const preview = page.getByRole('dialog', {
    name: 'Preview Sunbeams',
    exact: true,
  });
  await expect(preview.getByRole('alert')).toContainText(
    'Playlist temporarily unavailable',
  );
  await preview.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(preview.getByText('4 tracks', { exact: true })).toBeVisible();
  await expect(
    preview
      .getByRole('list', { name: 'Playlist tracks' })
      .getByRole('listitem'),
  ).toHaveCount(4);
  await expect(preview.getByText('Sunspun', { exact: true })).toBeVisible();
  await expect(preview.getByText('3:14', { exact: true })).toBeVisible();
  expect(
    (await (await page.request.get('/api/admin/state')).json()).collection,
  ).toHaveLength(0);
  expect(
    (await (await page.request.get('/api/admin/state')).json()).playback.status,
  ).toBe('idle');
  await page.screenshot({ path: 'test-results/library-preview-desktop.png' });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'View tracks in Sunbeams', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'View tracks in Sunbeams', exact: true })
    .click();
  await expect(preview.getByText('Sunspun', { exact: true })).toBeVisible();
  expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/library-preview-mobile.png' });
  await preview
    .getByRole('button', { name: 'Approve playlist', exact: true })
    .click();
  await expect(
    preview.getByRole('button', { name: 'On their shelf', exact: true }),
  ).toBeDisabled();
  await preview
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole('button', {
      name: 'View tracks in Folded Maps',
      exact: true,
    })
    .click();
  const albumPreview = page.getByRole('dialog', {
    name: 'Preview Folded Maps',
    exact: true,
  });
  await expect(
    albumPreview.getByText('River Compass', { exact: true }),
  ).toBeVisible();
  await albumPreview
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'On their shelf' }),
  ).toHaveCount(1);
  const child = await context.newPage();
  await child.setViewportSize({ width: 1280, height: 800 });
  await child.goto('/child');
  await expect(
    child.getByRole('button', { name: 'Open Sunbeams', exact: true }),
  ).toBeVisible();
  await child
    .getByRole('button', { name: 'Open Sunbeams', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  await child
    .getByRole('button', { name: 'Play Paper Skies', exact: true })
    .click();
  await expect(
    child.getByRole('heading', { name: 'Paper Skies', exact: true }),
  ).toBeVisible();
  await expect(
    child.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible();
  await child.getByRole('button', { name: 'Pause', exact: true }).click();
  await child.getByRole('button', { name: 'Resume', exact: true }).click();
  await child.getByRole('button', { name: 'Next track', exact: true }).click();
  await expect(child.getByRole('heading', { name: 'Moon Kite' })).toBeVisible();
  const volumeResponse = child.waitForResponse(
    (r) =>
      r.url().endsWith('/api/child/playback') &&
      r.request().postDataJSON()?.action === 'volume',
  );
  await child.getByRole('slider', { name: 'Volume', exact: true }).fill('35');
  await volumeResponse;
  await expect
    .poll(async () =>
      child.getByRole('slider', { name: 'Volume', exact: true }).inputValue(),
    )
    .toBe('35');
  await child.reload();
  await expect(child.getByText('Moon Kite', { exact: true })).toBeVisible();
  const transport = child.getByRole('group', { name: 'Playback controls' });
  await transport
    .getByRole('button', { name: 'Pause playback', exact: true })
    .click();
  await expect(
    transport.getByRole('button', { name: 'Resume playback', exact: true }),
  ).toBeEnabled();
  await transport
    .getByRole('button', { name: 'Resume playback', exact: true })
    .click();
  await transport
    .getByRole('button', { name: 'Previous song', exact: true })
    .click();
  await expect(child.getByText('Paper Skies', { exact: true })).toBeVisible();
  await transport
    .getByRole('button', { name: 'Next song', exact: true })
    .click();
  await expect(child.getByText('Moon Kite', { exact: true })).toBeVisible();
  await child
    .getByRole('button', { name: 'Open now playing', exact: true })
    .click();
  await expect(
    child.getByRole('heading', { name: 'Moon Kite', exact: true }),
  ).toBeVisible();
  await expect(
    transport.getByRole('button', { name: 'Pause playback', exact: true }),
  ).toBeVisible();
  await child.screenshot({ path: 'test-results/now-playing-footer.png' });
  await child.getByRole('button', { name: 'My music', exact: true }).click();
  await page.getByRole('button', { name: 'Settings & bedtime' }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Ruby’s music');
  await page
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.reload();
  await page.getByRole('button', { name: 'Settings & bedtime' }).click();
  await expect(page.getByLabel('Device name', { exact: true })).toHaveValue(
    'Ruby’s music',
  );
  await page.getByRole('button', { name: 'Device & diagnostics' }).click();
  await page.getByRole('button', { name: 'Blank screen', exact: true }).click();
  await expect(
    child.getByLabel('Screen blanked by parent', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Wake screen', exact: true }).click();
  await expect(
    child.getByLabel('Screen blanked by parent', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Music library' }).click();
  await page
    .getByRole('button', { name: 'Remove Sunbeams', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Open Sunbeams', exact: true }),
  ).toHaveCount(0);
  await expect(
    child.getByRole('button', { name: 'Open My favourites', exact: true }),
  ).toBeVisible();
  // Add four demo covers for visual verification of the simulator at the target size.
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Browse library', exact: true })
    .click();
  for (const title of [
    'Sunbeams',
    'Orbit Lanterns essentials',
    'Folded Maps',
    'Classic rock',
  ])
    await page
      .getByRole('button', { name: `Approve ${title}`, exact: true })
      .click();
  await page.goto('/simulator');
  await page.setViewportSize({ width: 1600, height: 1100 });
  const device = page.frameLocator(
    'iframe[title="Virtual Lenovo child player"]',
  );
  await expect(
    device.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeVisible();
  await expect(
    device.getByRole('button', { name: 'Open Classic rock' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/simulator.png', fullPage: true });
  await page
    .getByRole('button', { name: 'Disconnect mock player', exact: true })
    .click();
  await expect(
    device.getByText('Player unavailable', { exact: true }),
  ).toBeVisible();
  await expect(
    device.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeEnabled();
  await device.getByRole('button', { name: 'Open Sunbeams' }).click();
  await expect(
    device.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeDisabled();
  await device.getByRole('button', { name: 'My music', exact: true }).click();
  await page
    .getByRole('button', { name: 'Reconnect mock player', exact: true })
    .click();
  await expect(
    device.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Switch screen off', exact: true })
    .click();
  await expect(page.getByLabel('Simulator screen off')).toBeVisible();
  await page
    .getByRole('button', { name: 'Switch screen on', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Disconnect device UI', exact: true })
    .click();
  await expect(
    page.getByText('Device disconnected', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reconnect device UI', exact: true })
    .click();
  await expect(
    device.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeVisible();
  await page.goto('/admin');
  await page.screenshot({ path: 'test-results/parent.png', fullPage: true });
  await child.goto('/child');
  await child.screenshot({
    path: 'test-results/child-1280x800.png',
    fullPage: true,
  });
  await expect(
    child.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    child.getByText('You’re offline.', { exact: false }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    child.getByRole('button', { name: 'Open Sunbeams' }),
  ).toBeEnabled();
  await child
    .getByRole('button', { name: 'Open Sunbeams', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  await expect(child.locator('.song-artwork')).toHaveCount(4);
  await expect
    .poll(() =>
      child
        .locator('.song-artwork')
        .first()
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  const slider = child.getByRole('slider', { name: 'Volume', exact: true });
  const sliderBox = (await slider.boundingBox())!;
  expect(sliderBox.width).toBeGreaterThan(100);
  expect(sliderBox.width).toBeLessThan(300);
  const nextBox = (await transport
    .getByRole('button', { name: 'Next song', exact: true })
    .boundingBox())!;
  expect(
    Math.abs(
      nextBox.y + nextBox.height / 2 - sliderBox.y - sliderBox.height / 2,
    ),
  ).toBeLessThan(10);
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect(slider).toBeEnabled();
  await expect
    .poll(async () => {
      const r = await child.request.get('/api/child/state');
      return (await r.json()).playback.volume;
    })
    .toBe(38);
  await child.screenshot({
    path: 'test-results/tracks-1280x800.png',
    fullPage: true,
  });
  await child
    .getByRole('button', { name: 'Play Sunspun', exact: true })
    .click();
  await expect(
    child.getByRole('heading', { name: 'Sunspun', exact: true }),
  ).toBeVisible();
  await child.getByRole('button', { name: 'Track list', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Play all', exact: true }),
  ).toBeVisible();
  await child.getByRole('button', { name: 'My music', exact: true }).click();
  await expect(
    child.getByRole('button', {
      name: 'Open Orbit Lanterns essentials',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Music Assistant', exact: true })
    .click();
  await expect(
    page.getByText('Demo backend active', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Music Assistant player', { exact: true }),
  ).toHaveValue('@local');
  await page.screenshot({
    path: 'test-results/music-assistant-panel.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Log out', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('many parent tabs and simulator frames keep API requests responsive', async ({
  context,
}) => {
  test.setTimeout(60000);
  const login = await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  expect(login.ok()).toBe(true);
  const { csrf } = await login.json();
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': csrf },
    data: {},
  });
  const tabs = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const tab = await context.newPage();
      await tab.goto(index === 7 ? '/simulator' : '/admin', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      return tab;
    }),
  );
  for (const tab of tabs.slice(0, 7))
    await expect(tab.getByText('Hub online', { exact: true })).toBeVisible();
  const control = tabs[0];
  expect(
    await control.evaluate(
      async () =>
        (await fetch('/api/health', { signal: AbortSignal.timeout(3000) }))
          .status,
    ),
  ).toBe(200);
  await control
    .getByRole('button', { name: 'Music Assistant', exact: true })
    .click();
  await expect(
    control.getByText('Demo backend active', { exact: true }),
  ).toBeVisible();
  await tabs[7].close();
  await control
    .getByRole('button', { name: 'Check connection', exact: true })
    .click();
  await expect(
    control.getByText('Demo backend active', { exact: true }),
  ).toBeVisible();
});

test('live state falls back to bounded reads when shared workers are unavailable', async ({
  context,
  page,
}) => {
  await context.addInitScript(() =>
    Object.defineProperty(window, 'SharedWorker', { value: undefined }),
  );
  await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  await page.goto('/admin');
  await expect(page.getByText('Hub online', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Hub online', { exact: true })).toBeVisible();
});

test('microphone search requires choosing an approved result, supports correction, cancellation and permission errors', async ({
  context,
  page,
}) => {
  // Reproduce WebKit's playback-only session rejection while retaining actual
  // Chromium microphone capture/MediaRecorder. The SDK sets this category after
  // music playback; a fresh standalone window can otherwise hide the defect.
  await page.addInitScript(() => {
    const session = { type: 'playback' };
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      value: session,
    });
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (session.type === 'playback')
        return Promise.reject(
          new DOMException(
            'AudioSession category is not compatible with audio capture',
            'InvalidStateError',
          ),
        );
      return capture(constraints);
    };
  });
  await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  const session = await (await context.request.get('/api/auth/session')).json();
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: {},
  });
  const playbackRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/child/playback'))
      playbackRequests.push(req.postData() ?? '');
  });
  await page.goto('/child');
  await page
    .getByRole('button', { name: 'Search by voice', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Voice search',
    exact: true,
  });
  await expect(dialog.getByText('Listening…', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (navigator as Navigator & { audioSession: { type: string } })
            .audioSession.type,
      ),
    )
    .toBe('play-and-record');
  await page.waitForTimeout(1000);
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(dialog.getByLabel('Voice search words')).toHaveValue(
    'Play Sunspun.',
  );
  expect(
    await page.evaluate(
      () =>
        (navigator as Navigator & { audioSession: { type: string } })
          .audioSession.type,
    ),
  ).toBe('playback');
  await expect(
    dialog.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  expect(playbackRequests).toHaveLength(0);
  await dialog.getByLabel('Voice search words').fill('Lunar Letters');
  await dialog
    .getByRole('button', { name: 'Search these words', exact: true })
    .click();
  await expect(
    dialog
      .getByRole('button', { name: 'Play Lunar Letters', exact: true })
      .first(),
  ).toBeVisible();
  await dialog
    .getByLabel('Voice search words')
    .fill('a completely unapproved song');
  await dialog
    .getByRole('button', { name: 'Search these words', exact: true })
    .click();
  await expect(
    dialog.getByText('No matches on your music shelf.', { exact: false }),
  ).toBeVisible();
  await dialog.getByLabel('Voice search words').fill('Sunspun');
  await dialog
    .getByRole('button', { name: 'Search these words', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/voice-results.png' });
  await dialog
    .getByRole('button', { name: 'Play Sunspun', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Sunspun', exact: true }),
  ).toBeVisible();
  expect(playbackRequests).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Search by voice', exact: true })
    .click();
  await expect(dialog.getByText('Listening…', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (navigator as Navigator & { audioSession: { type: string } })
          .audioSession.type,
    ),
  ).toBe('playback');
  await page.evaluate(() =>
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException('Denied', 'NotAllowedError')),
    }),
  );
  await page
    .getByRole('button', { name: 'Search by voice', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Microphone access was denied',
  );
  expect(
    await page.evaluate(
      () =>
        (navigator as Navigator & { audioSession: { type: string } })
          .audioSession.type,
    ),
  ).toBe('playback');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto('/admin');
  await page
    .getByRole('button', { name: 'Settings & bedtime', exact: true })
    .click();
  await expect(
    page.getByText('Local transcription is ready', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('switch', { name: 'Allow microphone search', exact: false })
    .uncheck();
  await page
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  const child = await context.newPage();
  await child.goto('/child');
  await expect(
    child.getByRole('button', { name: 'Search by voice', exact: true }),
  ).toHaveCount(0);
});

test('voice finishes on a pause, skips empty uploads and releases capture after cancel', async ({
  context,
  page,
}) => {
  await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  const session = await (await context.request.get('/api/auth/session')).json();
  const settings = await (
    await context.request.get('/api/admin/settings')
  ).json();
  await context.request.put('/api/admin/settings', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { ...settings, voiceSearchEnabled: true },
  });
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: {},
  });
  await page.addInitScript(() => {
    const state = { mode: 'speech', stopped: 0 };
    Object.defineProperty(window, 'voiceFixture', { value: state });
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      void audio.resume();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const output = audio.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(output);
      const now = audio.currentTime;
      gain.gain.setValueAtTime(0, now);
      if (state.mode === 'speech') {
        gain.gain.setValueAtTime(0.08, now + 0.25);
        gain.gain.setValueAtTime(0, now + 0.9);
        gain.gain.setValueAtTime(0.08, now + 1.15); // a brief gap between words
        gain.gain.setValueAtTime(0, now + 1.65);
      }
      oscillator.start();
      for (const track of output.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          oscillator.stop();
          void audio.close();
          state.stopped++;
        };
      }
      return output.stream;
    };
  });
  const uploads: string[] = [],
    playback: string[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/child/voice/search')) uploads.push(req.url());
    if (req.url().endsWith('/api/child/playback')) playback.push(req.url());
  });
  await page.goto('/child');
  const button = page.getByRole('button', {
    name: 'Search by voice',
    exact: true,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Voice search',
    exact: true,
  });
  await button.click();
  await expect(dialog.getByText('I hear you.', { exact: false })).toBeVisible();
  // No Stop/Search click: real AnalyserNode -> real MediaRecorder -> test STT.
  await expect(dialog.getByLabel('Voice search words')).toHaveValue(
    'Play Sunspun.',
    { timeout: 5000 },
  );
  expect(uploads).toHaveLength(1);
  expect(playback).toHaveLength(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { voiceFixture: { stopped: number } })
            .voiceFixture.stopped,
      ),
    )
    .toBe(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    (
      window as unknown as { voiceFixture: { mode: string } }
    ).voiceFixture.mode = 'silence';
  });
  await button.click();
  await expect(
    dialog.getByText('I didn’t hear a request.', { exact: false }),
  ).toBeVisible({ timeout: 7000 });
  expect(uploads).toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { voiceFixture: { stopped: number } })
            .voiceFixture.stopped,
      ),
    )
    .toBe(2);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await button.click();
  await expect(dialog.getByText('Listening…', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { voiceFixture: { stopped: number } })
            .voiceFixture.stopped,
      ),
    )
    .toBe(3);
  await page.waitForTimeout(1200);
  expect(uploads).toHaveLength(1);
  expect(playback).toHaveLength(0);
});

test('parent searches the catalogue, previews and approves one song, then child plays only that song', async ({
  context,
  page,
}) => {
  await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  const session = await (await context.request.get('/api/auth/session')).json();
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: {},
  });
  await page.goto('/admin');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Browse library', exact: true })
    .click();
  await page
    .getByRole('textbox', {
      name: 'Search songs, albums and playlists',
      exact: true,
    })
    .fill('Sunspun');
  await page
    .getByRole('combobox', { name: 'Result type', exact: true })
    .selectOption('track');
  const firstSong = page
    .locator('.browse-card')
    .filter({
      has: page.getByRole('heading', { name: 'Sunspun', exact: true }),
    })
    .first();
  await expect(
    firstSong.getByRole('button', { name: 'Approve Sunspun', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Search source', exact: true })
    .selectOption('library');
  await expect(
    page.getByRole('heading', {
      name: 'No music found here yet.',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Search source', exact: true })
    .selectOption('catalogue');
  await firstSong
    .getByRole('button', { name: 'View tracks in Sunspun', exact: true })
    .click();
  const preview = page.getByRole('dialog', {
    name: 'Preview Sunspun',
    exact: true,
  });
  await expect(preview.getByText('1 track', { exact: true })).toBeVisible();
  const before = (await (await context.request.get('/api/child/state')).json())
    .collection;
  const discovery = await (
    await context.request.get('/api/admin/search?search=Sunspun')
  ).json();
  const song = discovery.find(
    (item: { kind: string }) => item.kind === 'track',
  );
  expect(before.some((item: { id: string }) => item.id === song.id)).toBe(
    false,
  );
  await preview
    .getByRole('button', { name: 'Approve song', exact: true })
    .click();
  await expect(
    preview.getByRole('button', { name: 'On their shelf', exact: true }),
  ).toBeVisible();
  await preview
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/child');
  await page.getByRole('button', { name: 'Open Sunspun', exact: true }).click();
  await expect(page.getByText('1 song', { exact: true })).toBeVisible();
  const childTracks = await (
    await context.request.get(
      '/api/child/collection/' + encodeURIComponent(song.id),
    )
  ).json();
  expect(childTracks.tracks).toHaveLength(1);
  await page.getByRole('button', { name: 'Play song', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sunspun', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pause playback', exact: true }),
  ).toBeEnabled();
  const state = await (await context.request.get('/api/child/state')).json();
  expect(state.playback.collectionId).toBe(song.id);
  expect(state.playback.track.name).toBe('Sunspun');
  await context.request.delete(
    '/api/admin/collection/' + encodeURIComponent(song.id),
    { headers: { 'X-CSRF-Token': session.csrf } },
  );
  await expect(
    page.getByRole('button', { name: 'Pause playback', exact: true }),
  ).not.toBeVisible();
});

test('children keep separate favourites and blocks, and parents manage both lists', async ({
  context,
  page,
}) => {
  test.setTimeout(60000);
  const initialAuth = await (
    await context.request.get('/api/auth/session')
  ).json();
  if (initialAuth.setupRequired)
    await context.request.post('/api/auth/setup', {
      data: {
        setupCode: 'playwright-one-time-code',
        password: 'a secure e2e password',
      },
    });
  else
    await context.request.post('/api/auth/login', {
      data: { password: 'a secure e2e password' },
    });
  const session = await (await context.request.get('/api/auth/session')).json();
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: {},
  });
  await context.request.get('/api/admin/library');
  await context.request.post('/api/admin/collection', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { id: 'mock-sunshine' },
  });
  await page.goto('/admin');
  await page
    .getByRole('button', { name: 'Children & preferences', exact: true })
    .click();
  await page.getByLabel('New child name', { exact: true }).fill('Ada');
  await page.getByLabel('New child avatar', { exact: true }).selectOption('🚀');
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '🚀 Ada', exact: true }),
  ).toBeVisible();
  await page.getByLabel('New child name', { exact: true }).fill('Ben');
  await page.getByLabel('New child avatar', { exact: true }).selectOption('🦊');
  await page.getByRole('button', { name: 'Add child', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '🦊 Ben', exact: true }),
  ).toBeVisible();
  const child = await context.newPage();
  await child.setViewportSize({ width: 390, height: 844 });
  await child.goto('/child');
  await page
    .getByRole('button', { name: 'Children & preferences', exact: true })
    .click();
  const playerSelect = page
    .locator('form.profile-device select[name="profileId"]')
    .last();
  await playerSelect.selectOption({ label: '🚀 Ada' });
  await page
    .locator('form.profile-device button:has-text("Save player")')
    .last()
    .click();
  await expect(child.locator('.child-profile-name')).toHaveText('Ada');
  await expect(child.getByText('Music plays right here.')).toHaveCount(0);
  await child
    .getByRole('button', { name: 'Open My favourites', exact: true })
    .click();
  await expect(
    child.getByRole('heading', { name: 'My favourites', exact: true }),
  ).toBeVisible();
  await expect(
    child.getByText(
      'Tap the heart on a song in Now Playing to add it to My favourites.',
    ),
  ).toBeVisible();
  await expect(
    child.getByRole('button', { name: 'Play all', exact: true }),
  ).toBeDisabled();
  await child.getByRole('button', { name: 'My music', exact: true }).click();
  await child
    .getByRole('button', { name: 'Open Sunbeams', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Play Sunspun', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Add to my favourites', exact: true })
    .click();
  await expect(
    child.getByRole('button', {
      name: 'Remove from my favourites',
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await child
    .getByRole('button', { name: 'Block this song for me', exact: true })
    .click();
  await expect(child.locator('.preference-feedback')).toContainText(
    'Blocked for Ada. This song can finish.',
  );
  const playing = await (await context.request.get('/api/child/state')).json();
  expect(playing.playback.status).toBe('playing');
  expect(playing.playback.track.name).toBe('Sunspun');
  await child
    .getByRole('button', { name: /Next (track|song)/ })
    .last()
    .click();
  await expect(child.locator('.mini-player strong')).toHaveText('Ribbon Steps');

  // Switch player assignment to Ben via parent UI
  await page
    .getByRole('button', { name: 'Children & preferences', exact: true })
    .click();
  await playerSelect.selectOption({ label: '🦊 Ben' });
  await page
    .locator('form.profile-device button:has-text("Save player")')
    .last()
    .click();
  await expect(child.locator('.child-profile-name')).toHaveText('Ben');

  await child
    .getByRole('button', { name: 'Open Sunbeams', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Play Sunspun', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Add to my favourites', exact: true })
    .click();
  await expect(
    child.getByRole('button', {
      name: 'Remove from my favourites',
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await child.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const heart = await child
    .getByRole('button', { name: 'Remove from my favourites', exact: true })
    .boundingBox();
  expect(heart!.width).toBeGreaterThanOrEqual(44);

  // The heart survives reload, populates the playlist, and can be toggled off.
  await child.reload();
  await expect(child.locator('.child-profile-name')).toHaveText('Ben');
  await child
    .getByRole('button', { name: 'Open now playing', exact: true })
    .click();
  await expect(
    child.getByRole('button', {
      name: 'Remove from my favourites',
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await child.getByRole('button', { name: 'My music', exact: true }).click();
  await child
    .getByRole('button', { name: 'Open My favourites', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  await child
    .getByRole('button', { name: 'Open now playing', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Remove from my favourites', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Add to my favourites', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await child.getByRole('button', { name: 'Track list', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toHaveCount(0);
  await child
    .getByRole('button', { name: 'Open now playing', exact: true })
    .click();
  await child
    .getByRole('button', { name: 'Add to my favourites', exact: true })
    .click();

  // Switch player back to Ada via parent UI: Sunspun is blocked for Ada
  await playerSelect.selectOption({ label: '🚀 Ada' });
  await page
    .locator('form.profile-device button:has-text("Save player")')
    .last()
    .click();
  await expect(child.locator('.child-profile-name')).toHaveText('Ada');
  await child
    .getByRole('button', { name: 'Open Sunbeams', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toHaveCount(0);

  // Parent unblocks Sunspun for Ada
  await page.getByRole('button', { name: '🚀 Ada', exact: true }).click();
  await page
    .getByRole('button', { name: 'Blocked songs', exact: true })
    .click();
  const row = page
    .locator('.preference-row')
    .filter({ has: page.getByText('Sunspun', { exact: true }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();

  // Switch player to Ben via parent UI: Sunspun is in Ben's favourites
  await page
    .getByRole('button', { name: 'Children & preferences', exact: true })
    .click();
  await playerSelect.selectOption({ label: '🦊 Ben' });
  await page
    .locator('form.profile-device button:has-text("Save player")')
    .last()
    .click();
  await expect(child.locator('.child-profile-name')).toHaveText('Ben');
  await child
    .getByRole('button', { name: 'Open My favourites', exact: true })
    .click();
  await expect(
    child.getByRole('button', { name: 'Play Sunspun', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '🦊 Ben', exact: true }).click();
  await page.getByRole('button', { name: 'Favourites', exact: true }).click();
  await expect(
    page
      .locator('.preference-row')
      .filter({ has: page.getByText('Sunspun', { exact: true }) }),
  ).toBeVisible();
});

test('Fully hardware keys update the app volume and native screen follows parent policy', async ({
  page,
  context,
}) => {
  const initial = await (await context.request.get('/api/auth/session')).json();
  if (initial.setupRequired)
    await context.request.post('/api/auth/setup', {
      data: {
        setupCode: 'playwright-one-time-code',
        password: 'a secure e2e password',
      },
    });
  await context.request.post('/api/auth/login', {
    data: { password: 'a secure e2e password' },
  });
  const session = await (await context.request.get('/api/auth/session')).json();
  const settings = await (
    await context.request.get('/api/admin/settings')
  ).json();
  const headers = { 'X-CSRF-Token': session.csrf };
  await context.request.put('/api/admin/settings', {
    headers,
    data: { ...settings, maxVolume: 50, screenOverride: 'on' },
  });
  await context.request.post('/api/admin/pair', { headers, data: {} });
  await page.addInitScript(() => {
    let on = true,
      volume = 36;
    const handlers: Record<string, string> = {};
    window.fully = {
      bind: (event, code) => {
        handlers[event] = code;
      },
      getAudioVolume: () => volume,
      setAudioVolume: (v) => {
        volume = v;
      },
      getScreenOn: () => on,
      turnScreenOn: () => {
        on = true;
      },
      turnScreenOff: () => {
        on = false;
      },
    };
  });
  await page.goto('/child');
  const slider = page.getByRole('slider', { name: 'Volume', exact: true });
  await expect(slider).toBeEnabled();
  await slider.fill('20');
  await expect(page.getByLabel('Current volume', { exact: true })).toHaveText(
    '20%',
  );
  await page.evaluate(() => window.__musicHubFully!.key(5));
  await expect(slider).toHaveValue('25');
  await expect(page.getByLabel('Current volume', { exact: true })).toHaveText(
    '25%',
  );
  await expect
    .poll(() => page.evaluate(() => window.fully!.getAudioVolume(3)))
    .toBe(25);
  await slider.fill('50');
  await expect(page.getByLabel('Current volume', { exact: true })).toHaveText(
    '50%',
  );
  await page.evaluate(() => {
    window.fully!.setAudioVolume(60, 3); // OS action before the capped app key.
    window.__musicHubFully!.key(5);
  });
  await expect(slider).toHaveValue('50');
  await expect
    .poll(() => page.evaluate(() => window.fully!.getAudioVolume(3)))
    .toBe(50);
  await page.evaluate(() => window.__musicHubFully!.key(-5));
  await expect(slider).toHaveValue('45');
  await expect
    .poll(() => page.evaluate(() => window.fully!.getAudioVolume(3)))
    .toBe(45);
  await context.request.post('/api/admin/screen', {
    headers,
    data: { mode: 'off' },
  });
  await expect(page.getByLabel('Screen blanked by parent')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.fully!.getScreenOn()))
    .toBe(false);
  expect(
    await page.evaluate(() => {
      window.fully!.turnScreenOn();
      window.__musicHubFully!.screenChanged();
      return window.fully!.getScreenOn();
    }),
  ).toBe(false);
  await context.request.post('/api/admin/screen', {
    headers,
    data: { mode: 'on' },
  });
  await expect
    .poll(() => page.evaluate(() => window.fully!.getScreenOn()))
    .toBe(true);
  expect(
    await page.evaluate(() => {
      window.fully!.turnScreenOff(true);
      window.__musicHubFully!.screenChanged();
      return window.fully!.getScreenOn();
    }),
  ).toBe(true);
  await context.request.put('/api/admin/settings', { headers, data: settings });
  const state = await (await page.request.get('/api/child/state')).json();
  const now = Date.now();
  const wakeAt = now + 60_000;
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SharedWorker', { value: undefined });
  });
  await page.route('**/api/child/state', (route) =>
    route.fulfill({
      json: {
        ...state,
        device: { ...state.device, screenOff: true, screenWakeAt: wakeAt },
      },
    }),
  );
  await page.clock.install({ time: now });
  await page.reload();
  await expect(page.getByLabel('Screen blanked by parent')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.fully!.getScreenOn()))
    .toBe(false);
  await page.clock.fastForward(60_000);
  await expect(page.getByLabel('Screen blanked by parent')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.fully!.getScreenOn()))
    .toBe(true);
});

test('parents curate a separate Sleep Music list and children choose a song', async ({
  page,
  context,
}) => {
  await page.goto('/admin');
  await page
    .getByLabel('Parent password', { exact: true })
    .fill('a secure e2e password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Sleep Music', exact: true })
    .click();
  await page.getByRole('button', { name: 'Browse for songs' }).click();
  await page
    .getByRole('button', { name: 'View tracks in Sunbeams', exact: true })
    .click();
  const preview = page.getByRole('dialog', { name: 'Preview Sunbeams' });
  const song = preview.getByRole('listitem').filter({ hasText: 'Sunspun' });
  await song.getByRole('button', { name: 'Add to Sleep Music' }).click();
  await expect(
    song.getByRole('button', { name: 'In Sleep Music' }),
  ).toBeDisabled();
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Sleep Music', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Sleep Music list' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Morning stop time' }).click();
  await expect(
    page.getByLabel('Sleep Music stops at', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Pair this browser', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'This browser is paired',
  );

  const child = await context.newPage();
  await child.setViewportSize({ width: 788, height: 492 });
  await child.goto('/child');
  const header = child.locator('header.child-header');
  const moon = header.getByRole('button', { name: 'Sleep Music', exact: true });
  await expect(
    header.getByRole('button', { name: 'Search by voice' }),
  ).toBeVisible();
  await expect(moon).toHaveCSS('border-radius', '50%');
  await expect(moon).toHaveCSS('width', '44px');
  await moon.click();
  await expect(moon).toHaveAttribute('aria-pressed', 'true');
  const play = child.getByRole('button', {
    name: 'Play Sunspun until morning',
    exact: true,
  });
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  const footer = child.locator('.child-footer');
  const volume = footer.locator('.volume');
  const stop = footer.getByRole('button', {
    name: 'Stop Sleep Music',
    exact: true,
  });
  await expect(stop).toBeInViewport({ ratio: 1 });
  await expect(stop).toHaveCSS('border-radius', '50%');
  const stopBounds = (await stop.boundingBox())!;
  const volumeBounds = (await volume.boundingBox())!;
  expect(stopBounds.width).toBe(48);
  expect(stopBounds.height).toBe(48);
  expect(stopBounds.x + stopBounds.width).toBeLessThanOrEqual(volumeBounds.x);

  await stop.click();
  await expect(stop).toHaveCount(0);
  const settings = await (await page.request.get('/api/admin/settings')).json();
  const { csrf } = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'X-CSRF-Token': csrf };
  const clockTime = (offsetHours: number) =>
    new Date(Date.now() + offsetHours * 60 * 60_000)
      .toISOString()
      .slice(11, 16);
  await child.addInitScript(() => {
    let on = true;
    window.fully = {
      bind: () => {},
      getAudioVolume: () => 25,
      setAudioVolume: () => {},
      getScreenOn: () => on,
      turnScreenOn: () => {
        on = true;
      },
      turnScreenOff: () => {
        on = false;
      },
      setScreenBrightness: (level) => {
        document.documentElement.dataset.screenBrightness = String(level);
      },
    };
  });
  await child.clock.install({ time: Date.now() });
  const screen = child.locator('html');
  const daytime = await page.request.put('/api/admin/settings', {
    headers,
    data: {
      ...settings,
      bedtimeEnabled: false,
      screenOverride: 'on',
      inactivityMode: 'dim',
      inactivitySeconds: 10,
    },
  });
  expect(daytime.ok()).toBe(true);
  await child.reload();
  await expect(screen).toHaveAttribute('data-screen-brightness', '255');
  await child.clock.fastForward(11_000);
  await expect(screen).toHaveAttribute('data-screen-brightness', '-1');
  await moon.click();
  await expect(screen).toHaveAttribute('data-screen-brightness', '255');
  await page.request.put('/api/admin/settings', {
    headers,
    data: {
      ...settings,
      screenScheduleEnabled: true,
      timezone: 'UTC',
      screenOverride: 'auto',
      screenOffAt: clockTime(-2),
      screenOnAt: clockTime(2),
      bedtimeEnabled: true,
      bedtimeStart: clockTime(-2),
      bedtimeEnd: clockTime(2),
    },
  });
  await child.reload();
  const wakeButton = child.getByRole('button', {
    name: 'Wake for Sleep Music',
  });
  await expect(wakeButton).toBeVisible();
  await expect(child.locator('html')).toHaveAttribute(
    'data-screen-brightness',
    '0',
  );
  expect(await child.evaluate(() => window.fully?.getScreenOn())).toBe(true);
  await wakeButton.click();
  await expect(play).toBeVisible();
  await expect(header).toHaveAttribute('inert', '');
  await expect(child.locator('html')).toHaveAttribute(
    'data-screen-brightness',
    '-1',
  );
  await child.clock.fastForward(60_001);
  await expect(wakeButton).toBeVisible();
  await wakeButton.click();
  await play.click();
  await expect(wakeButton).toBeVisible();
  await expect(child.locator('html')).toHaveAttribute(
    'data-screen-brightness',
    '0',
  );
  await wakeButton.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(header).toHaveAttribute('inert', '');
  await expect(footer).not.toHaveAttribute('inert', '');
  await expect(footer.locator('.mini-player')).toHaveAttribute('inert', '');
  await expect(volume).toHaveAttribute('inert', '');
  await expect(stop).toBeEnabled();
  await expect(stop).toBeInViewport({ ratio: 1 });
  await child.setViewportSize({ width: 788, height: 360 });
  const songList = child.locator('.library-view');
  expect(
    await songList.evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      return list.scrollTop;
    }),
  ).toBeGreaterThan(0);
  await expect(stop).toBeInViewport({ ratio: 1 });
  await expect(screen).toHaveAttribute('data-screen-brightness', '-1');
  const stopped = child.waitForResponse(
    (response) =>
      response.url().endsWith('/api/child/playback') &&
      response.request().postDataJSON()?.action === 'stop',
  );
  await stop.click();
  const response = await stopped;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    device: { bedtime: true, screenOff: true },
    playback: { status: 'idle', track: null },
  });
  await expect(wakeButton).toBeVisible();
  await expect(child.locator('html')).toHaveAttribute(
    'data-screen-brightness',
    '0',
  );
  await child.setViewportSize({ width: 788, height: 492 });
  await wakeButton.click();
  await expect(stop).toHaveCount(0);
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await play.click();
  await expect(wakeButton).toBeVisible();
  await wakeButton.click();
  await child.getByRole('button', { name: 'Darken screen' }).click();
  await expect(wakeButton).toBeVisible();

  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Sleep Music', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove Sunspun from Sleep Music' })
    .click();
  await expect(wakeButton).toHaveCount(0);
  await expect
    .poll(() => child.evaluate(() => window.fully?.getScreenOn()))
    .toBe(false);
  await page.request.put('/api/admin/settings', { headers, data: settings });
  await expect(play).toHaveCount(0);
  await expect(
    child.getByRole('button', { name: 'Stop Sleep Music' }),
  ).toHaveCount(0);
});
