import type { Db } from '../kernel/db.js';
import type { Logger } from '../kernel/log.js';
import type { AccessContext, TenantRow } from '../auth/rbac.js';
import type { Registry } from '../content/registry.js';
import type { StoreContext } from '../content/store.js';
import type { SavedQuery } from '../query/saved.js';
import { fanoutEvent, type WebhookRetryPolicy } from '../webhooks/index.js';

export interface ResolvedConfig {
  defaultLocale: string;
  defaultTenantSlug: string;
  /** 'mutations' logs every write as an interaction event; 'all' adds reads; 'off' disables. */
  interactionLog: 'off' | 'mutations' | 'all';
  /** Map a request to a tenant slug/id; default reads the x-apick-tenant header. */
  resolveTenant: ((request: Request) => string | null | Promise<string | null>) | null;
  webhookRetry: WebhookRetryPolicy;
}

/** Shared plumbing handed to the HTTP router, MCP server and CLI. */
export interface AppCore {
  db: Db;
  registry: Registry;
  queries: Map<string, SavedQuery>;
  config: ResolvedConfig;
  log: Logger;
  defaultTenant: TenantRow;
  version: string;
}

export function storeContextFor(ctx: AccessContext, core: AppCore): StoreContext {
  return {
    tenantId: ctx.tenantId,
    actor: {
      principalId: ctx.principalId,
      via: ctx.via,
      ...(ctx.keyId ? { keyId: ctx.keyId } : {}),
    },
    onEvent: (tx, event) => fanoutEvent(tx, event, core.config.webhookRetry),
  };
}
