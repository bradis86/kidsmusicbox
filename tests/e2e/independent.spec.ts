import { test, expect } from '@playwright/test';
test('independent devices keep their own music, controls and likes across reload', async ({
  browser,
}) => {
  test.skip(
    process.env.E2E_INDEPENDENT_PLAYBACK !== 'true',
    'Run with npm run test:e2e:independent',
  );
  const a = await browser.newContext(),
    b = await browser.newContext(),
    watcher = await browser.newContext();
  try {
    await a.request.post('/api/auth/setup', {
      data: {
        setupCode: 'playwright-one-time-code',
        password: 'a secure e2e password',
      },
    });
    const auth = await (await a.request.get('/api/auth/session')).json();
    await a.request.post('/api/admin/pair', {
      headers: { 'X-CSRF-Token': auth.csrf },
      data: {},
    });
    await a.request.get('/api/admin/library');
    for (const id of ['mock-sunshine', 'mock-space'])
      await a.request.post('/api/admin/collection', {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: { id },
      });
    const other = await (
      await a.request.post('/api/admin/profiles', {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: { name: 'Ben', avatar: '🦊' },
      })
    ).json();
    await b.request.post('/api/auth/login', {
      data: { password: 'a secure e2e password' },
    });
    const bAuth = await (await b.request.get('/api/auth/session')).json();
    await b.request.post('/api/admin/pair', {
      headers: { 'X-CSRF-Token': bAuth.csrf },
      data: {},
    });
    const personal = await (await b.request.get('/api/child/session')).json();
    const firstPlayer = await (
      await a.request.get('/api/child/session')
    ).json();
    await a.request.patch(
      `/api/admin/profile-devices/${firstPlayer.personal.deviceId}`,
      {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: {
          profileId: firstPlayer.personal.profile.id,
          name: 'Lounge tablet',
        },
      },
    );
    await a.request.patch(
      `/api/admin/profile-devices/${personal.personal.deviceId}`,
      {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: { profileId: other.id, name: 'Ben tablet' },
      },
    );
    const one = await a.newPage(),
      two = await b.newPage();
    await one.setViewportSize({ width: 1280, height: 800 });
    await two.setViewportSize({ width: 390, height: 844 });
    await Promise.all([one.goto('/child'), two.goto('/child')]);
    await one
      .getByRole('button', { name: 'Open Sunbeams', exact: true })
      .click();
    await one
      .getByRole('button', { name: 'Play Sunspun', exact: true })
      .click();
    await two
      .getByRole('button', {
        name: 'Open Orbit Lanterns essentials',
        exact: true,
      })
      .click();
    await two
      .getByRole('button', { name: 'Play Comet Parade', exact: true })
      .click();
    await expect(one.locator('.now-playing-info h1')).toHaveText('Sunspun');
    await expect(
      two.getByLabel('Display: Ben tablet', { exact: true }),
    ).toBeVisible();
    await expect(
      one.getByLabel('Display: Lounge tablet', { exact: true }),
    ).toBeVisible();
    await expect(two.locator('.now-playing-info h1')).toHaveText(
      'Comet Parade',
    );
    await one
      .locator('.big-controls')
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    await two
      .locator('.big-controls')
      .getByRole('button', { name: 'Next track', exact: true })
      .click();
    await expect(
      one
        .locator('.big-controls')
        .getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(two.locator('.now-playing-info h1')).toHaveText(
      'Window Lights',
    );
    await one.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await one
      .getByRole('button', { name: 'Repeat playlist', exact: true })
      .click();
    await expect(
      one.getByRole('button', { name: 'Shuffle', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      one.getByRole('button', { name: 'Repeat playlist', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      one
        .locator('.big-controls')
        .getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(
      two.getByRole('button', { name: 'Shuffle', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      two.getByRole('button', { name: 'Repeat playlist', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    const longDisplay =
      'Ben’s Samsung Galaxy Tab A7 music player in the bedroom';
    await a.request.patch(
      `/api/admin/profile-devices/${personal.personal.deviceId}`,
      {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: { profileId: other.id, name: longDisplay },
      },
    );
    await expect(
      two.getByLabel(`Display: ${longDisplay}`, { exact: true }),
    ).toBeVisible();
    expect(
      await two.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const controls = two.locator('.big-controls');
    await expect(controls.getByRole('button')).toHaveCount(5);
    const bounds = await controls.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { center: r.y + r.height / 2, width: r.width, height: r.height };
      }),
    );
    expect(
      Math.max(...bounds.map((b) => b.center)) -
        Math.min(...bounds.map((b) => b.center)),
    ).toBeLessThan(2);
    for (const b of bounds) {
      expect(b.width).toBeGreaterThanOrEqual(48);
      expect(b.height).toBeGreaterThanOrEqual(48);
    }
    await two.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await expect(
      two.getByRole('button', { name: 'Shuffle', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await two.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await expect(
      two.getByRole('button', { name: 'Shuffle', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await a.request.patch(
      `/api/admin/profile-devices/${personal.personal.deviceId}`,
      {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: { profileId: other.id, name: 'Ben tablet' },
      },
    );
    await expect(
      two.getByLabel('Display: Ben tablet', { exact: true }),
    ).toBeVisible();
    // A third, passive player for the same child watches the favourites shelf.
    await watcher.addCookies(
      (await a.cookies()).filter((c) => c.name === 'hub_parent'),
    );
    await watcher.request.post('/api/admin/pair', {
      headers: { 'X-CSRF-Token': auth.csrf },
      data: {},
    });
    const shelf = await watcher.newPage();
    await shelf.goto('/child');
    await shelf
      .getByRole('button', { name: 'Open My favourites', exact: true })
      .click();
    await expect(
      shelf.getByRole('button', { name: 'Play all', exact: true }),
    ).toBeDisabled();
    await one
      .getByRole('button', { name: 'Add to my favourites', exact: true })
      .click();
    await expect(
      shelf.getByRole('button', { name: 'Play Sunspun', exact: true }),
    ).toBeVisible();
    await one.reload();
    await one
      .getByRole('button', { name: 'Open now playing', exact: true })
      .click();
    await expect(
      one.getByRole('button', {
        name: 'Remove from my favourites',
        exact: true,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      one.getByRole('button', { name: 'Shuffle', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      one.getByRole('button', { name: 'Repeat playlist', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      two.getByRole('button', { name: 'Add to my favourites', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      two
        .locator('.big-controls')
        .getByRole('button', { name: 'Pause', exact: true }),
    ).toBeVisible();
    await one.screenshot({ path: 'test-results/independent-player-a.png' });
    await two.screenshot({ path: 'test-results/independent-player-b.png' });
    const admin = await a.newPage();
    await admin.goto('/admin');
    await admin
      .getByRole('button', { name: 'Children & preferences', exact: true })
      .click();
    await expect(
      admin.getByText('Online · Audio assigned', { exact: true }),
    ).toHaveCount(2);
    const row = admin
      .locator('form.profile-device')
      .filter({ has: admin.getByLabel('Name Ben tablet', { exact: true }) });
    await row.getByRole('button', { name: 'Stop player', exact: true }).click();
    await expect(two.locator('.mini-player strong')).not.toHaveText(
      'Window Lights',
    );
    await expect(
      one.getByRole('button', {
        name: 'Remove from my favourites',
        exact: true,
      }),
    ).toBeVisible();
    const sleepTracks = await (
      await a.request.get('/api/admin/tracks?id=mock-sunshine')
    ).json();
    const sleepAdded = await a.request.post('/api/admin/sleep-music', {
      headers: { 'X-CSRF-Token': auth.csrf },
      data: { itemId: 'mock-sunshine', trackId: sleepTracks[0].id },
    });
    expect(sleepAdded.ok()).toBe(true);
    await two.getByRole('button', { name: 'Music Hub home' }).click();
    await two.getByRole('button', { name: 'Sleep Music', exact: true }).click();
    await two
      .getByRole('button', { name: 'Play Sunspun until morning' })
      .click();
    await expect(
      two.getByRole('button', { name: 'Stop Sleep Music' }),
    ).toBeVisible();
    expect(
      (await (await one.request.get('/api/child/state')).json()).sleepSession,
    ).toBeUndefined();
    await row.getByRole('button', { name: 'Stop player', exact: true }).click();
    await expect(
      two.getByRole('button', { name: 'Stop Sleep Music' }),
    ).toHaveCount(0);
    await expect(one.locator('.mini-player strong')).toHaveText('Sunspun');
  } finally {
    await a.close();
    await b.close();
    await watcher.close();
  }
});
