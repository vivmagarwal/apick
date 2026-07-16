import { AsyncLocalStorage } from 'node:async_hooks';
import { errors } from './errors.js';

/**
 * Draft preview scope. Server-side code (e.g. @apick/cms after validating a
 * signed preview token) wraps a render in `runWithDraftPreview(docId, …)`;
 * every published-status read INSIDE that scope treats that ONE document's
 * draft head as if it were published — so any theme, including fully custom
 * routes, renders the draft with zero changes. Nothing else is widened:
 * other documents, RBAC, tenancy and field rules all apply unchanged.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const als = new AsyncLocalStorage<{ docId: string }>();

export function runWithDraftPreview<T>(docId: string, fn: () => T): T {
  // The doc id is inlined into a SQL CASE expression by the planner — accept
  // strict UUIDs only, everything else is rejected here.
  if (!UUID_RE.test(docId)) throw errors.badRequest('Invalid preview document id');
  return als.run({ docId: docId.toLowerCase() }, fn);
}

export function draftPreviewDocId(): string | null {
  return als.getStore()?.docId ?? null;
}
