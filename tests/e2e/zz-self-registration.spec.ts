import { test, expect } from '@playwright/test';
test('an unpaired browser registers itself without parent login and remains paired after refresh', async ({
  browser,
}) => {
  const parent = await browser.newContext(),
    child = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const status = await (await parent.request.get('/api/auth/session')).json();
    await parent.request.post(
      status.setupRequired ? '/api/auth/setup' : '/api/auth/login',
      {
        data: {
          password: 'a secure e2e password',
          ...(status.setupRequired
            ? { setupCode: 'playwright-one-time-code' }
            : {}),
        },
      },
    );
    const auth = await (await parent.request.get('/api/auth/session')).json();
    const page = await child.newPage(),
      commands: string[] = [];
    page.on('request', (r) => {
      if (
        r.url().endsWith('/api/child/audio/register') ||
        r.url().endsWith('/api/child/playback')
      )
        commands.push(r.url());
    });
    await page.goto('/child');
    await expect(
      page.getByRole('heading', { name: 'Connect your player', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Player name', exact: true })
      .fill('Kitchen tablet');
    await page.screenshot({ path: 'test-results/self-register-phone.png' });
    await page
      .getByRole('button', { name: 'Set up this player', exact: true })
      .click();
    await expect(
      page.getByLabel('Display: Kitchen tablet', { exact: true }),
    ).toBeVisible();
    const initial = await (
      await child.request.get('/api/child/session')
    ).json();
    expect(initial.personal.profile.kind).toBe('child');
    expect(initial.authenticated).toBe(true);
    expect((await child.request.get('/api/admin/profiles')).status()).toBe(401);
    const data = await (await parent.request.get('/api/admin/profiles')).json();
    const device = data.devices.find(
      (d: { id: string }) => d.id === initial.personal.deviceId,
    );
    expect(device.name).toBe('Kitchen tablet');
    expect(device.audioAssigned).toBe(false);
    await page.reload();
    await expect(
      page.getByLabel('Display: Kitchen tablet', { exact: true }),
    ).toBeVisible();
    expect(
      (await (await child.request.get('/api/child/session')).json()).personal
        .deviceId,
    ).toBe(initial.personal.deviceId);
    expect(commands).toEqual([]);
    expect((await child.cookies()).some((c) => c.name === 'hub_parent')).toBe(
      false,
    );
    await parent.request.post('/api/admin/revoke-devices', {
      headers: { 'X-CSRF-Token': auth.csrf },
      data: {},
    });
    await expect(
      page.getByRole('heading', { name: 'Connect your player', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByRole('button', { name: 'Set up this player', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Your music', exact: true }),
    ).toBeVisible();
    const fresh = await (await child.request.get('/api/child/session')).json();
    expect(fresh.personal.deviceId).not.toBe(initial.personal.deviceId);
    expect(fresh.personal.profile.kind).toBe('child');
    // Keep the parent auth fixture checked without requiring it in the player context.
    expect(auth.authenticated).toBe(true);
  } finally {
    await child.close();
    await parent.close();
  }
});
