import { createCms, silentLogger, type CmsApp, type CmsConfig } from '@apick/cms';
import type { Page } from '@playwright/test';

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
    ...config,
  });
  const { url } = await app.listen();
  return { app, url, stop: () => app.stop() };
}

export const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'correct-horse-battery' };

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

export async function loginViaUi(page: Page, url: string, email: string, password: string): Promise<void> {
  await page.goto(`${url}/admin/login`);
  await page.locator('[data-input=email]').fill(email);
  await page.locator('[data-input=password]').fill(password);
  await page.locator('[data-action=login]').click();
  await page.waitForSelector('[data-view=dashboard]');
}
