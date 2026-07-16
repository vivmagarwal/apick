import type { AppCore, Db, Logger } from '@apick/core';
import type { Theme } from './site/theme.js';

/**
 * Shared CMS runtime state. Routes are registered during core's extend()
 * (before the app finishes booting), so they read from this box which
 * createCms fills in immediately after createApp returns — strictly before
 * any request can arrive.
 */
export interface CmsContext {
  db: Db;
  core: AppCore;
  log: Logger;
  tenantId: string;
  secret: string;
  /** Deterministic internal service token (cms-admin scope) for server-side API calls. */
  internalToken: string;
  sessionTtlMs: number;
  site: { title: string; description: string };
  theme: Theme;
  adminNav: Array<{ label: string; href: string }>;
  /** In-process fetch against the app itself. */
  fetchApi: (path: string, init?: RequestInit & { token?: string | null }) => Promise<Response>;
}

/** Mutable holder wired up in createCms. */
export function createContextBox(): { ctx: CmsContext | null } {
  return { ctx: null };
}

export function requireCtx(box: { ctx: CmsContext | null }): CmsContext {
  if (!box.ctx) throw new Error('CMS context not initialized (request before createCms finished booting)');
  return box.ctx;
}
