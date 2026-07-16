import { expect, test } from '@playwright/test';
import { bootCms, futureLocalDatetime, seedAdmin, loginViaUi, typeMarkdown, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: publishing is a workflow, not a button — a publish can be
 * scheduled for later (and cancelled), and editors can preview the DRAFT
 * through the real site theme via a signed link before anything goes live.
 */
test.describe('scheduled publishing & draft preview', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms({
      preview: {
        // fixture-configured pathFor (the built-in default covers posts too,
        // but the spec exercises the config seam explicitly)
        pathFor: (collection, doc) =>
          collection === 'posts' && typeof doc.data['slug'] === 'string' ? `/blog/${doc.data['slug']}` : null,
      },
    });
    await seedAdmin(cms.url);
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('schedule a publish from the split-button menu, see the pill, cancel it', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/posts/new`);
    await page.locator('[data-input=title]').fill('Scheduled scoop');
    await page.locator('[data-input=slug]').fill('scheduled-scoop');
    await typeMarkdown(page, 'body', 'Coming soon.');
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-status=draft]')).toBeVisible();

    // Schedule… lives behind the Publish split-button chevron
    await page.getByRole('button', { name: 'Publish options' }).click();
    await page.locator('[data-action=schedule]').click();
    await expect(page.locator('[data-view=schedule]')).toBeVisible();
    await page.getByLabel('Publish at').fill(futureLocalDatetime(120));
    await page.locator('[data-action=confirm-schedule]').click();

    // the header pill flips to Scheduled and the publish button echoes the time
    await expect(page.locator('[data-status=scheduled]')).toBeVisible();
    await expect(page.locator('[data-action=publish]')).toContainText('Scheduled');
    // nothing is live yet
    expect((await fetch(`${cms.url}/blog/scheduled-scoop`)).status).toBe(404);

    // cancel the schedule from the same menu → back to a plain draft
    await page.getByRole('button', { name: 'Publish options' }).click();
    await page.locator('[data-action=cancel-schedule]').click();
    await expect(page.getByText('Schedule cancelled').first()).toBeVisible();
    await expect(page.locator('[data-status=draft]')).toBeVisible();
    await expect(page.locator('[data-action=publish]')).toHaveText('Publish');
    expect((await fetch(`${cms.url}/blog/scheduled-scoop`)).status).toBe(404);
  });

  test('Preview opens the DRAFT through the theme, with the draft banner', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/posts/new`);
    await page.locator('[data-input=title]').fill('Preview post');
    await page.locator('[data-input=slug]').fill('preview-post');
    await typeMarkdown(page, 'body', 'Published body.');
    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();

    // edit the draft so it differs from the published version
    await page.locator('[data-input=title]').fill('Preview post v2');
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-status=modified]')).toBeVisible();

    // Preview opens a new tab rendering the DRAFT through the real theme
    const previewButton = page.locator('[data-action=preview]');
    await expect(previewButton).toBeVisible();
    const popupPromise = page.context().waitForEvent('page');
    await previewButton.click();
    const preview = await popupPromise;
    await preview.waitForLoadState();
    await expect(preview.getByText('Draft preview')).toBeVisible();
    await expect(preview.locator('h1', { hasText: 'Preview post v2' })).toBeVisible();

    // the public page still shows only the published version
    const live = await (await fetch(`${cms.url}/blog/preview-post`)).text();
    expect(live).toContain('Preview post');
    expect(live).not.toContain('Preview post v2');
    await preview.close();
  });
});
