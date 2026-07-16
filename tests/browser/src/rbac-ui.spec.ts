import { expect, test } from '@playwright/test';
import { bootCms, mainNav, pickOption, seedAdmin, loginViaUi, typeMarkdown, ADMIN, TOKEN_KEY, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: roles are real in the UI because they're real in the API —
 * an editor manages content but never sees user management; escalation paths
 * are structurally closed.
 */
test.describe('roles in the admin UI', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms();
    await seedAdmin(cms.url);
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('admin creates users through the UI; editor gets a content-only admin', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);

    // create an editor via Users page
    await mainNav(page).getByRole('link', { name: 'Users' }).click();
    await page.locator('[data-action=new-user]').click();
    await page.locator('[data-input=user-name]').fill('Eddie Editor');
    await page.locator('[data-input=user-email]').fill('eddie@example.com');
    await pickOption(page, '[data-input=user-role]', /^editor/);
    await page.locator('[data-input=user-password]').fill('editor-pass-123');
    await page.locator('[data-action=save-user]').click();
    await expect(page.locator('[data-user="eddie@example.com"]')).toBeVisible();

    // switch to the editor account
    await page.getByRole('button', { name: 'Sign out' }).click();
    await loginViaUi(page, cms.url, 'eddie@example.com', 'editor-pass-123');

    // content nav is there; settings are not
    await expect(mainNav(page).getByRole('link', { name: 'posts' })).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(mainNav(page).getByRole('link', { name: 'API keys' })).toHaveCount(0);
    await expect(mainNav(page).getByRole('link', { name: 'Webhooks' })).toHaveCount(0);
    // cms-users never appears as a content collection
    await expect(mainNav(page).getByRole('link', { name: 'cms-users' })).toHaveCount(0);

    // editors can write content
    await mainNav(page).getByRole('link', { name: 'posts' }).click();
    await page.locator('[data-action=new]').click();
    await page.locator('[data-input=title]').fill('Editor post');
    await page.locator('[data-input=slug]').fill('editor-post');
    await typeMarkdown(page, 'body', 'words');
    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();

    // …but the users API is closed to them (defense in depth beyond hidden nav)
    const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
    const usersRes = await fetch(`${cms.url}/admin/api/users`, { headers: { authorization: `Bearer ${token}` } });
    expect(usersRes.status).toBe(403);
    // and the raw collection is closed too — no self-promotion to admin
    const escalate = await fetch(`${cms.url}/v1/collections/cms-users/docs?status=draft`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(escalate.status).toBe(403);
  });

  test('viewer is read-only: no new/publish actions succeed', async ({ page }) => {
    // admin creates a viewer via API for speed
    const adminToken = await (async () => {
      const res = await fetch(`${cms.url}/admin/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
      });
      return ((await res.json()) as { data: { token: string } }).data.token;
    })();
    await fetch(`${cms.url}/admin/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Vera Viewer', email: 'vera@example.com', role: 'viewer', password: 'viewer-pass-123' }),
    });

    await loginViaUi(page, cms.url, 'vera@example.com', 'viewer-pass-123');
    await mainNav(page).getByRole('link', { name: 'posts' }).click();
    // listing renders (readDraft allowed)…
    await expect(page.locator('[data-view=listing]')).toBeVisible();
    // …but writes are rejected by the API
    const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
    const write = await fetch(`${cms.url}/v1/collections/posts/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { title: 'nope', slug: 'nope', body: 'x' } }),
    });
    expect(write.status).toBe(403);
  });

  test('password change invalidates existing sessions', async ({ page }) => {
    const login = async (password: string) =>
      fetch(`${cms.url}/admin/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'eddie@example.com', password }),
      });
    const old = (await (await login('editor-pass-123')).json()) as { data: { token: string } };

    // admin changes eddie's password in the UI
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await mainNav(page).getByRole('link', { name: 'Users' }).click();
    await page.locator('[data-user="eddie@example.com"] [data-action=edit-user]').click();
    await page.locator('[data-input=user-password]').fill('brand-new-pass-456');
    await page.locator('[data-action=save-user]').click();
    await expect(page.locator('[data-view=user-form]')).toHaveCount(0);

    // the old session token is dead
    const probe = await fetch(`${cms.url}/admin/api/me`, { headers: { authorization: `Bearer ${old.data.token}` } });
    expect(probe.status).toBe(401);
  });
});
