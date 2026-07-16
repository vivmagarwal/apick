import { chromium } from '@playwright/test';
import { bootCms, seedAdmin, loginViaUi, ADMIN } from './src/fixtures.js';

const SHOTS = '/private/tmp/claude-501/-Users-vivmagarwal-Work-opensource-apick/781eff13-5a73-46ce-8209-e2e2afe4798d/scratchpad/shots';
const cms = await bootCms({ site: { title: 'The Test Kitchen', description: 'Recipes & experiments' } });
const token = await seedAdmin(cms.url);
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
await fetch(`${cms.url}/v1/collections/posts/docs`, { method: 'POST', headers: H, body: JSON.stringify({ data: { title: 'Perfecting sourdough', slug: 'sourdough', excerpt: 'Three weeks of starter experiments, distilled.', body: '## The starter\n\nFeed it *daily*. Patience wins.\n\n> Bread is 80% waiting.', tags: ['baking', 'experiments'] }, publish: true } ) });
await fetch(`${cms.url}/v1/collections/posts/docs`, { method: 'POST', headers: H, body: JSON.stringify({ data: { title: 'Knife skills that matter', slug: 'knife-skills', excerpt: 'Five cuts cover 95% of home cooking.', body: 'Practice the **rock chop** first.', tags: ['basics'] }, publish: true } ) });
await fetch(`${cms.url}/v1/collections/pages/docs`, { method: 'POST', headers: H, body: JSON.stringify({ data: { title: 'About', slug: 'about', showInNav: true, body: [{ __type: 'hero', heading: 'We cook in the open', subheading: 'Every recipe tested three times' }, { __type: 'prose', markdown: 'This site runs on **APIck CMS**.' }] }, publish: true } ) });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } });
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

await page.goto(`${cms.url}/admin/login`); await page.waitForSelector('[data-view=login]'); await shot('01-login');
await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password); await page.waitForTimeout(700); await shot('02-dashboard');
await page.goto(`${cms.url}/admin/c/posts`); await page.waitForSelector('[data-table=posts]'); await page.waitForTimeout(400); await shot('03-listing');
const posts = await (await fetch(`${cms.url}/v1/collections/posts/docs?status=draft`, { headers: H })).json();
await page.goto(`${cms.url}/admin/c/posts/${posts.data[0].docId}`); await page.waitForSelector('[data-view=editor]'); await page.waitForTimeout(500); await shot('04-editor');
await page.goto(`${cms.url}/admin/users`); await page.waitForSelector('[data-view=users]'); await shot('05-users');
await page.goto(cms.url); await page.waitForTimeout(400); await shot('06-site-home');
await page.goto(`${cms.url}/blog/sourdough`); await page.waitForTimeout(400); await shot('07-site-post');
await browser.close();
await cms.stop();
console.log('screenshots done');
