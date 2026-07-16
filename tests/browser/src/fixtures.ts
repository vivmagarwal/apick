import { createCms, silentLogger, type CmsApp, type CmsConfig } from '@apick/cms';
import type { Locator, Page } from '@playwright/test';

/** Boot a real CMS on an ephemeral port with an isolated in-memory Postgres. */
export interface RunningCms {
  app: CmsApp;
  url: string;
  stop: () => Promise<void>;
}

export async function bootCms(config: Partial<CmsConfig> = {}): Promise<RunningCms> {
  const app = await createCms({
    database: 'pglite://memory',
    logger: silentLogger,
    site: { title: 'Browser Test Site', description: 'A site under test' },
    // UI tests don't exercise background jobs/cron; keeping the worker off means
    // no lingering timers accumulate across the many boots in one test process.
    worker: false,
    ...config,
  });
  const { url } = await app.listen();
  return { app, url, stop: () => app.stop() };
}

export const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'correct-horse-battery' };

/** localStorage key the admin SPA keeps its session token under. */
export const TOKEN_KEY = 'apick-admin-token';

/** Create the first admin via the API (for specs not testing the setup UI). */
export async function seedAdmin(url: string, user = ADMIN): Promise<string> {
  const res = await fetch(`${url}/admin/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (!res.ok) throw new Error(`seedAdmin failed: ${res.status}`);
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

export async function apiFetch(url: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Create a document via the API; returns its docId. */
export async function seedDoc(
  url: string,
  token: string,
  collection: string,
  data: Record<string, unknown>,
  publish = false,
): Promise<string> {
  const res = await apiFetch(url, token, 'POST', `/v1/collections/${collection}/docs`, {
    data,
    ...(publish ? { publish: true } : {}),
  });
  if (!res.ok) throw new Error(`seedDoc(${collection}) failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { docId: string } };
  return body.data.docId;
}

/** Sign in through the real login form and land on the dashboard. */
export async function loginViaUi(page: Page, url: string, email: string, password: string): Promise<void> {
  await page.goto(`${url}/admin/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('[data-view=dashboard]');
}

/** The sidebar navigation — collections and system pages are plain links in here. */
export function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

/** Type into an edodo-write markdown field (real contenteditable typing). */
export async function typeMarkdown(page: Page, path: string, text: string): Promise<void> {
  const editable = page.locator(`[data-markdown="${path}"] [contenteditable="true"]`);
  await editable.click();
  await editable.pressSequentially(text);
}

/** Add a block variant through the blocks field's "+ Add block" dropdown menu. */
export async function addBlock(page: Page, path: string, variant: string): Promise<void> {
  await page.locator(`[data-add="${path}"]`).click();
  await page.getByRole('menuitem', { name: variant }).click();
}

/** Pick an option in a shadcn/Radix Select (combobox trigger + portaled listbox). */
export async function pickOption(page: Page, triggerSelector: string, option: string | RegExp): Promise<void> {
  await page.locator(triggerSelector).click();
  await page.getByRole('option', { name: option }).click();
}

/** HTML5 drag-and-drop from one element to another (drives React onDrag* handlers). */
export async function dragTo(page: Page, sourceSelector: string, targetSelector: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(sourceSelector).dispatchEvent('dragstart', { dataTransfer });
  await page.locator(targetSelector).dispatchEvent('dragover', { dataTransfer });
  await page.locator(targetSelector).dispatchEvent('drop', { dataTransfer });
}

/** A future timestamp formatted for `<input type="datetime-local">`. */
export function futureLocalDatetime(minutesAhead = 60): string {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
