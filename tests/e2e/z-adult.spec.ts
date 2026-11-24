import { test, expect } from '@playwright/test';
test('adult profiles search and play outside approvals, then lock back to child access', async ({
  page,
  context,
}) => {
  const status = await (await context.request.get('/api/auth/session')).json();
  if (status.setupRequired)
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
  const auth = await (await context.request.get('/api/auth/session')).json();
  await context.request.post('/api/admin/pair', {
    headers: { 'X-CSRF-Token': auth.csrf },
    data: {},
  });
  const originalCollection = (
    await (await context.request.get('/api/admin/state')).json()
  ).collection;
  const originalProfile = (
    await (await context.request.get('/api/child/state')).json()
  ).personal.profile;
  const originalFavourites = (
    await (
      await context.request.get('/api/child/collection/__favourites__')
    ).json()
  ).tracks;
  await page.goto('/child');
  await expect(
    page.getByRole('heading', { name: 'Your music', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('searchbox', { name: 'Search all music', exact: true }),
  ).toHaveCount(0);
  const admin = await context.newPage();
  await admin.goto('/admin');
  await admin
    .getByRole('button', { name: 'Children & preferences', exact: true })
    .click();
  await admin
    .getByLabel('New profile type', { exact: true })
    .selectOption('adult');
  await admin.getByLabel('New adult name', { exact: true }).fill('Dad');
  await admin.getByRole('button', { name: 'Add adult', exact: true }).click();
  await expect(
    admin.getByRole('button', { name: '⭐ Dad', exact: true }),
  ).toBeVisible();
  const profiles = await (
      await context.request.get('/api/admin/profiles')
    ).json(),
    dad = profiles.profiles.find(
      (p: { name: string; kind: string }) =>
        p.name === 'Dad' && p.kind === 'adult',
    );
  const row = admin.locator('form.profile-device').filter({
    has: admin.getByText('Player name · This browser', { exact: false }),
  });
  await row.locator('select[name="profileId"]').selectOption(dad.id);
  await row.getByRole('button', { name: 'Save player', exact: true }).click();
  await expect(page.locator('.child-profile-name')).toHaveText('Dad · Adult');
  await page
    .getByRole('searchbox', { name: 'Search all music', exact: true })
    .fill('River Compass');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('list', { name: 'Music search results' })
    .getByRole('button', { name: 'Open River Compass', exact: true })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Play River Compass', exact: true })
    .click();
  await expect(page.locator('.now-playing-info h1')).toHaveText(
    'River Compass',
  );
  await page
    .getByRole('button', { name: 'Add to my favourites', exact: true })
    .click();
  await page.screenshot({ path: 'test-results/adult-now-playing.png' });
  expect(
    (await (await context.request.get('/api/admin/state')).json()).collection,
  ).toEqual(originalCollection);
  await page
    .getByRole('button', { name: 'Lock adult profile', exact: true })
    .click();
  await expect(page.locator('.child-profile-name')).toHaveText(
    originalProfile.name,
  );
  await expect(
    page.getByRole('searchbox', { name: 'Search all music', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Open My favourites', exact: true })
    .click();
  expect(
    (
      await (
        await context.request.get('/api/child/collection/__favourites__')
      ).json()
    ).tracks,
  ).toEqual(originalFavourites);
  expect(
    (
      await context.request.delete('/api/admin/profiles/' + dad.id, {
        headers: { 'X-CSRF-Token': auth.csrf },
        data: {},
      })
    ).status(),
  ).toBe(200);
  await admin.close();
});
