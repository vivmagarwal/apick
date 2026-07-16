import { expect, test } from '@playwright/test';
import { bootCms, mainNav, ADMIN, type RunningCms } from './fixtures.js';

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
    await page.getByLabel('Your name').fill(ADMIN.name);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('[data-error]')).toContainText('at least 10 characters');

    // proper setup lands on the dashboard, signed in
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForSelector('[data-view=dashboard]');
    await expect(page.locator('aside')).toContainText('Browser Test Site');
    await expect(mainNav(page).getByRole('link', { name: 'posts' })).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Users' })).toBeVisible(); // admin sees settings

    // sign out → login screen
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('[data-view=login]')).toBeVisible();

    // wrong password → same-shape error, no session
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('wrong-password-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('[data-error]')).toContainText('Invalid email or password');

    // right password → in
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('[data-view=dashboard]');

    // the setup wizard is gone forever — /admin/setup redirects to the dashboard
    await page.goto(`${cms.url}/admin/setup`);
    await expect(page.locator('[data-view=dashboard]')).toBeVisible();
  });
});
