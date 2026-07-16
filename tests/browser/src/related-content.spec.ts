import { expect, test } from '@playwright/test';
import { defineCollection, f } from '@apick/cms';
import { apiFetch, bootCms, seedAdmin, seedDoc, loginViaUi, ADMIN, type RunningCms } from './fixtures.js';

/**
 * BROWSER PROMISE: inverse relations are first-class in the editor — opening a
 * document shows a "Related content" panel for every collection that points at
 * it, and related documents can be added, edited (in a Sheet, without leaving
 * the page) and unlinked right there.
 */
const books = defineCollection('books', {
  description: 'Books (fixture): the TARGET of the relation',
  fields: {
    name: f.text({ required: true }),
  },
});

const chapters = defineCollection('chapters', {
  description: 'Chapters (fixture): each points at one book',
  fields: {
    title: f.text({ required: true }),
    book: f.relation('books'),
  },
});

test.describe('related-content panel (inverse relations)', () => {
  let cms: RunningCms;
  let token: string;
  let bookId: string;
  let ch1: string;
  let ch2: string;

  test.beforeAll(async () => {
    cms = await bootCms({ collections: [books, chapters] });
    token = await seedAdmin(cms.url);
    bookId = await seedDoc(cms.url, token, 'books', { name: 'The APIck Cookbook' });
    ch1 = await seedDoc(cms.url, token, 'chapters', { title: 'Getting started', book: bookId });
    ch2 = await seedDoc(cms.url, token, 'chapters', { title: 'Advanced recipes', book: bookId });
  });
  test.afterAll(async () => {
    await cms.stop();
  });

  test('a book lists its chapters; add / edit / unlink happen in the panel', async ({ page }) => {
    await loginViaUi(page, cms.url, ADMIN.email, ADMIN.password);
    await page.goto(`${cms.url}/admin/c/books/${bookId}`);

    // the panel lists every chapter whose relation points at this book
    await expect(page.getByText('Related content')).toBeVisible();
    const panel = page.locator('[data-related-panel="chapters.book"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-related-row]')).toHaveCount(2);
    await expect(panel).toContainText('Getting started');
    await expect(panel).toContainText('Advanced recipes');

    // ---- add: the panel's Add button opens a Sheet, relation pre-connected ----
    await panel.locator('[data-action="add-related:chapters"]').click();
    const sheet = page.locator('[data-doc-sheet=chapters]');
    await expect(sheet).toBeVisible();
    // the new chapter's book relation is prefilled with THIS book
    await expect(sheet.locator(`[data-relation-row="${bookId}"]`)).toContainText('The APIck Cookbook');
    await sheet.locator('[data-input=title]').fill('Chapter three');
    await sheet.locator('[data-action=sheet-save]').click();
    await expect(page.getByText('Draft created').first()).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(panel.locator('[data-related-row]')).toHaveCount(3);
    await expect(panel).toContainText('Chapter three');

    // ---- edit: the row's pencil opens the same Sheet on the existing doc ----
    await panel.locator(`[data-action="edit-related:${ch1}"]`).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-input=title]')).toHaveValue('Getting started');
    await sheet.locator('[data-input=title]').fill('Getting started, properly');
    await sheet.locator('[data-action=sheet-save]').click();
    await expect(page.getByText('Draft saved').first()).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(panel).toContainText('Getting started, properly');

    // ---- unlink: clears the relation but keeps the document ----
    page.once('dialog', (d) => d.accept());
    await panel.locator(`[data-action="unlink-related:${ch2}"]`).click();
    await expect(panel.locator('[data-related-row]')).toHaveCount(2);
    await expect(panel).not.toContainText('Advanced recipes');

    // the unlinked chapter still exists — only its relation was nulled
    const res = await apiFetch(cms.url, token, 'GET', `/v1/collections/chapters/docs/${ch2}?status=draft`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { data: { title: string; book?: string | null } } };
    expect(body.data.data.title).toBe('Advanced recipes');
    expect(body.data.data.book ?? null).toBeNull();
  });
});
