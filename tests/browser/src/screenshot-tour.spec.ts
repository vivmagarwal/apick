import { test } from '@playwright/test';
import { bootCms, seedAdmin, loginViaUi, ADMIN } from './fixtures.js';

/**
 * Not an assertion suite — a visual QA tour. Runs only when SHOTS_DIR is set:
 *   SHOTS_DIR=/tmp/shots npx playwright test screenshot-tour
 */
const SHOTS_DIR = process.env['SHOTS_DIR'];

test.describe('screenshot tour', () => {
  test.skip(!SHOTS_DIR, 'SHOTS_DIR not set');

  test('capture admin + site', async ({ page }) => {
    const cms = await bootCms({ site: { title: 'The Test Kitchen', description: 'Recipes & experiments' } });
    const token = await seedAdmin(cms.url);
    const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const seed = (path: string, body: unknown) =>
      fetch(`${cms.url}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

    await seed('/v1/collections/posts/docs', {
      data: {
        title: 'Perfecting sourdough',
        slug: 'sourdough',
        excerpt: 'Three weeks of starter experiments, distilled.',
        body: '## The starter\n\nFeed it *daily*. Patience wins.\n\n> Bread is 80% waiting.',
        tags: ['baking', 'experiments'],
      },
      publish: true,
    });
    await seed('/v1/collections/posts/docs', {
      data: { title: 'Knife skills that matter', slug: 'knife-skills', excerpt: 'Five cuts cover 95% of home cooking.', body: 'Practice the **rock chop** first.', tags: ['basics'] },
      publish: true,
    });
    await seed('/v1/collections/pages/docs', {
      data: {
        title: 'About',
        slug: 'about',
        showInNav: true,
        body: [
          { __type: 'hero', heading: 'We cook in the open', subheading: 'Every recipe tested three times' },
          { __type: 'prose', markdown: 'This site runs on **APIck CMS**.' },
        ],
      },
      publish: true,
    });

    const shot = (name: string) => page.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
    await page.goto(`${cms.url}/admin/login`);
    await page.waitForSelector('[data-view=login]');
    await shot('01-login');
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.waitForTimeout(700);
    await shot('02-dashboard');
    await page.goto(`${cms.url}/admin/c/posts`);
    await page.waitForSelector('[data-table=posts]');
    await page.waitForTimeout(400);
    await shot('03-listing');
    const posts = (await (await fetch(`${cms.url}/v1/collections/posts/docs?status=draft`, { headers: H })).json()) as {
      data: Array<{ docId: string }>;
    };
    await page.goto(`${cms.url}/admin/c/posts/${posts.data[0]!.docId}`);
    await page.waitForSelector('[data-view=editor]');
    await page.waitForTimeout(500);
    await shot('04-editor');
    await page.goto(`${cms.url}/admin/c/pages/new`);
    await page.waitForSelector('[data-view=editor]');
    await page.locator('[data-add=body]').selectOption('hero');
    await page.waitForTimeout(300);
    await shot('05-blocks');
    await page.goto(`${cms.url}/admin/users`);
    await page.waitForSelector('[data-view=users]');
    await shot('06-users');
    await page.goto(cms.url);
    await page.waitForTimeout(400);
    await shot('07-site-home');
    await page.goto(`${cms.url}/blog/sourdough`);
    await page.waitForTimeout(400);
    await shot('08-site-post');
    await cms.stop();
  });
});
