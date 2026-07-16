import { expect, test } from '@playwright/test';
import { bootCms, seedAdmin, loginViaUi, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: the schema-driven editor — a human writes, publishes,
 * edits and rolls back content in the UI, and the public themed site reflects
 * exactly the published state.
 */
test.describe('content editing end-to-end', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms();
    await seedAdmin(cms.url);
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('write → publish → live on the site; draft edits stay off until republished', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);

    // create a post through the generated form
    await page.locator('[data-nav=posts]').click();
    await page.locator('[data-action=new]').click();
    await page.locator('[data-input=title]').fill('Hello from the browser');
    await page.locator('[data-input=slug]').fill('hello-browser');
    await page.locator('[data-input=excerpt]').fill('Written by a real browser test.');
    await page.locator('[data-input=body]').fill('This is **bold** browser content.');
    // list field: tags
    await page.locator('[data-add=tags]').click();
    await page.locator('[data-input="tags.0"]').fill('testing');

    // save draft first — it must NOT appear on the site
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-status=draft]')).toBeVisible();
    const siteBefore = await (await fetch(`${cms.url}/blog/hello-browser`)).status;
    expect(siteBefore).toBe(404);

    // publish → live, with markdown rendered by the theme
    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();
    const live = await (await fetch(`${cms.url}/blog/hello-browser`)).text();
    expect(live).toContain('Hello from the browser');
    expect(live).toContain('<strong>bold</strong>');
    expect(live).toContain('testing'); // tag chip

    // edit the draft → status becomes modified, site still shows the old version
    await page.locator('[data-input=title]').fill('Hello v2');
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-status=modified]')).toBeVisible();
    const stillOld = await (await fetch(`${cms.url}/blog/hello-browser`)).text();
    expect(stillOld).toContain('Hello from the browser');
    expect(stillOld).not.toContain('Hello v2');

    // republish → site updates
    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();
    const updated = await (await fetch(`${cms.url}/blog/hello-browser`)).text();
    expect(updated).toContain('Hello v2');

    // history: restore v1 (the original title) as a new draft version
    await page.locator('[data-action=versions]').click();
    await page.waitForSelector('[data-view=versions]');
    await page.locator('[data-restore="1"]').click();
    await expect(page.locator('[data-notice]')).toContainText('Restored v1');
    await expect(page.locator('[data-input=title]')).toHaveValue('Hello from the browser');

    // unpublish → gone from the site with a themed 404
    await page.locator('[data-action=publish]').click(); // publish restored draft
    await expect(page.locator('[data-status=published]')).toBeVisible();
    await page.locator('[data-action=unpublish]').click();
    await expect(page.locator('[data-status=draft]')).toBeVisible();
    const gone = await fetch(`${cms.url}/blog/hello-browser`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('Not found');
  });

  test('blocks editor: compose a page from hero + prose + quote and see it themed', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.locator('[data-nav=pages]').click();
    await page.locator('[data-action=new]').click();
    await page.locator('[data-input=title]').fill('About');
    await page.locator('[data-input=slug]').fill('about');
    await page.locator('[data-input=showInNav]').check();

    // add a hero block
    await page.locator('[data-add=body]').selectOption('hero');
    await page.locator('[data-input="body.0.heading"]').fill('We build in the open');
    await page.locator('[data-input="body.0.subheading"]').fill('An APIck-powered page');
    // add a prose block
    await page.locator('[data-add=body]').selectOption('prose');
    await page.locator('[data-input="body.1.markdown"]').fill('## Our story\n\nIt began with an *idea*.');
    // add a quote, then move it up above the prose
    await page.locator('[data-add=body]').selectOption('quote');
    await page.locator('[data-input="body.2.text"]').fill('Ship it.');
    await page.locator('[data-block="body.2"] [title="Move up"]').click();
    await expect(page.locator('[data-input="body.1.text"]')).toHaveValue('Ship it.');

    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();

    // the theme renders the blocks in order: hero, quote, prose
    const html = await (await fetch(`${cms.url}/about`)).text();
    expect(html).toContain('We build in the open');
    expect(html).toContain('<h2>Our story</h2>');
    expect(html).toContain('<em>idea</em>');
    expect(html.indexOf('Ship it.')).toBeLessThan(html.indexOf('Our story'));
    // nav shows the page site-wide
    const home = await (await fetch(`${cms.url}/`)).text();
    expect(home).toContain('href="/about"');
  });

  test('validation errors surface on the exact field', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/posts/new`);
    // missing required title + bad slug
    await page.locator('[data-input=slug]').fill('Bad Slug!');
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-error]')).toBeVisible();
    await expect(page.locator('[data-field=title] .field-error, [data-field=slug] .field-error').first()).toBeVisible();
  });

  test('unique conflicts read as human errors', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/pages/new`);
    await page.locator('[data-input=title]').fill('Duplicate about');
    await page.locator('[data-input=slug]').fill('about'); // taken by the blocks test
    await page.locator('[data-action=save]').click();
    await expect(page.locator('[data-error]')).toContainText('unique');
  });
});
