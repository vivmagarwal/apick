import { expect, test } from '@playwright/test';
import { bootCms, seedAdmin, loginViaUi, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: the media library — upload through the UI, pick an image
 * for a field, see it live on the site, delete it. A 1×1 PNG stands in for
 * real uploads (Playwright sets files on the hidden input).
 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('media library', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms();
    await seedAdmin(cms.url);
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('upload via the Media page, then delete', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.locator('[data-nav=media]').click();
    await expect(page.locator('[data-view=media]')).toBeVisible();

    await page.locator('[data-input="media-file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG_1x1 });
    const tile = page.locator('[data-media="pixel.png"]');
    await expect(tile).toBeVisible();

    // it's served publicly with the hardening headers
    const src = await tile.locator('img').getAttribute('src');
    const res = await fetch(`${cms.url}${src}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    // delete removes it
    await tile.hover();
    page.once('dialog', (d) => d.accept());
    await tile.locator('[data-action=delete-media]').click();
    await expect(page.locator('[data-media="pixel.png"]')).toHaveCount(0);
  });

  test('pick an image for a post cover through the media picker; it renders on the site', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/posts/new`);
    await page.locator('[data-input=title]').fill('Post with cover');
    await page.locator('[data-input=slug]').fill('with-cover');
    // body is required
    await page.locator('[data-markdown=body] [contenteditable="true"]').click();
    await page.locator('[data-markdown=body] [contenteditable="true"]').pressSequentially('Body text.');

    // open the media picker on the cover image field, upload from within it, pick it
    await page.locator('[data-input="coverImageUrl"] [data-action="pick-media"]').click();
    await expect(page.locator('[data-view=media-picker]')).toBeVisible();
    await page.locator('[data-view=media-picker] [data-input="media-file"]').setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    await page.locator('[data-view=media-picker] [data-media="cover.png"]').click();
    // picker closes; the field now has a /media/ URL and a preview
    await expect(page.locator('[data-view=media-picker]')).toHaveCount(0);
    await expect(page.locator('[data-input="coverImageUrl.url"]')).toHaveValue(/^\/media\//);
    await expect(page.locator('[data-input="coverImageUrl"] .image-preview img')).toBeVisible();

    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();

    // the cover appears on the published post
    const coverUrl = await page.locator('[data-input="coverImageUrl.url"]').inputValue();
    const html = await (await fetch(`${cms.url}/blog/with-cover`)).text();
    expect(html).toContain(coverUrl);
  });
});
