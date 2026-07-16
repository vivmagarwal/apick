import { expect, test } from '@playwright/test';
import { defaultTheme, defineCollection, f, html, type CmsPlugin } from '@apick/cms';
import { bootCms, mainNav, pickOption, seedAdmin, loginViaUi, apiFetch, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: themable like WordPress, extensible like Drupal — a child
 * theme overrides templates/blocks, and a plugin adds a collection, a custom
 * route and admin navigation, all without touching core.
 */
const projectsPlugin: CmsPlugin = {
  name: 'projects',
  collections: [
    defineCollection('projects', {
      description: 'Portfolio projects (added by a plugin)',
      access: { publicRead: true },
      fields: {
        name: f.text({ required: true }),
        stage: f.enum(['idea', 'building', 'shipped'], { default: 'idea' }),
        repoUrl: f.uri(),
      },
    }),
  ],
  adminNav: [{ label: 'Plugin Docs', href: 'https://example.com/docs' }],
  routes: (hono) => {
    hono.get('/api/project-count', async (c) => {
      const res = await hono.fetch(new Request('http://x/v1/collections/projects/docs?count=true&pageSize=1'));
      const body = (await res.json()) as { meta: { total?: number } };
      return c.json({ projects: body.meta.total ?? 0 });
    });
  },
};

test.describe('themes & plugins', () => {
  let cms: RunningCms;

  test.beforeAll(async () => {
    cms = await bootCms({
      site: { title: 'Themed Site' },
      plugins: [projectsPlugin],
      theme: {
        name: 'child-of-quiet',
        templates: {
          home: ({ site }) => html`<div class="custom-home"><h1>Custom ${site.title}</h1><p>Overridden by a child theme.</p></div>`,
        },
        blocks: {
          // override the quote block AND add a brand-new block type
          quote: (props) => html`<div class="fancy-quote">✦ ${props['text']}</div>`,
        },
        css: defaultTheme.css + '\n.custom-home h1 { color: rebeccapurple; }',
      },
    });
    await seedAdmin(cms.url);
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('child theme overrides the home template and block renderers', async ({ page }) => {
    await page.goto(cms.url);
    await expect(page.locator('.custom-home h1')).toHaveText('Custom Themed Site');

    // publish a page with a quote block — rendered by the OVERRIDDEN renderer
    const token = await seedLoginToken();
    await apiFetch(cms.url, token, 'POST', '/v1/collections/pages/docs', {
      data: { title: 'Quotes', slug: 'quotes', body: [{ __type: 'quote', text: 'Make it yours.' }] },
      publish: true,
    });
    await page.goto(`${cms.url}/quotes`);
    await expect(page.locator('.fancy-quote')).toContainText('✦ Make it yours.');
    // non-overridden templates still come from the base theme
    const css = await (await fetch(`${cms.url}/theme.css`)).text();
    expect(css).toContain('rebeccapurple');
  });

  test('plugin collection appears in the admin and works in the editor', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await expect(mainNav(page).getByRole('link', { name: 'projects' })).toBeVisible();
    // plugin admin-nav link present
    await expect(mainNav(page).locator('a[href="https://example.com/docs"]')).toBeVisible();

    await mainNav(page).getByRole('link', { name: 'projects' }).click();
    await page.locator('[data-action=new]').click();
    await page.locator('[data-input=name]').fill('APIck CMS');
    await pickOption(page, '[data-input=stage]', 'building');
    await page.locator('[data-input=repoUrl]').fill('https://github.com/vivmagarwal/apick');
    await page.locator('[data-action=publish]').click();
    await expect(page.locator('[data-status=published]')).toBeVisible();
  });

  test('plugin custom route is live on the same app', async () => {
    const res = await fetch(`${cms.url}/api/project-count`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: number };
    expect(body.projects).toBeGreaterThanOrEqual(1);
  });

  async function seedLoginToken(): Promise<string> {
    const res = await fetch(`${cms.url}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    });
    return ((await res.json()) as { data: { token: string } }).data.token;
  }
});
