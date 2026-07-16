import { expect, test } from '@playwright/test';
import { bootCms, loginViaUi, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: the WordPress 5-minute install, beaten — a fresh install
 * walks a human from zero to a working admin session entirely in the UI.
 */
test.describe('first-run setup & login', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms();
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('fresh install → setup wizard → dashboard → logout → login', async ({ page }) => {
    // visiting /admin on a fresh install shows the setup screen
    await page.goto(`${cms.url}/admin`);
    await expect(page.locator('[data-view=setup]')).toBeVisible();

    // weak password is rejected with a readable error
    await page.locator('[data-input=name]').fill(ADMIN.name);
    await page.locator('[data-input=email]').fill(ADMIN.email);
    await page.locator('[data-input=password]').fill('short');
    await page.locator('[data-action=setup]').click();
    await expect(page.locator('[data-error]')).toContainText('at least 10 characters');

    // proper setup lands on the dashboard, signed in
    await page.locator('[data-input=password]').fill(ADMIN.password);
    await page.locator('[data-action=setup]').click();
    await page.waitForSelector('[data-view=dashboard]');
    await expect(page.locator('.sidebar')).toContainText('Browser Test Site');
    await expect(page.locator('[data-nav=posts]')).toBeVisible();
    await expect(page.locator('[data-nav=users]')).toBeVisible(); // admin sees settings

    // sign out → login screen
    await page.locator('[data-action=logout]').click();
    await expect(page.locator('[data-view=login]')).toBeVisible();

    // wrong password → same-shape error, no session
    await page.locator('[data-input=email]').fill(ADMIN.email);
    await page.locator('[data-input=password]').fill('wrong-password-123');
    await page.locator('[data-action=login]').click();
    await expect(page.locator('[data-error]')).toContainText('Invalid email or password');

    // right password → in
    await page.locator('[data-input=password]').fill(ADMIN.password);
    await page.locator('[data-action=login]').click();
    await page.waitForSelector('[data-view=dashboard]');

    // the setup wizard is gone forever
    await page.goto(`${cms.url}/admin/setup`);
    await expect(page.locator('[data-view=dashboard]')).toBeVisible();
  });
});
