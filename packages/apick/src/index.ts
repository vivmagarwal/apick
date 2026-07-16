// APIck — API Construction Kit. Pure-headless, AI-first application platform.

// app
export { createApp, type ApickApp, type ApickConfig, type UserJobHandler } from './app/createApp.js';
export type { AppCore } from './app/core.js';

// schema DSL
export { f, type Field, type FieldDef, type InferShape } from './schema/fields.js';
export { defineCollection, type Collection, type CollectionOptions, type InferDoc } from './schema/collection.js';

// saved queries
export { defineQuery, type SavedQuery, type SavedQueryParam } from './query/saved.js';

// webhooks (consumer-side verification helper)
export { verifyWebhookSignature } from './webhooks/index.js';

// kernel building blocks (for extensions & advanced use)
export { uuidv7 } from './kernel/ids.js';
export { ApickError, errors, type ErrorCode } from './kernel/errors.js';
export { sql, SqlFragment } from './kernel/sql.js';
export { openDb, type Db, type Queryable, type DatabaseConfig } from './kernel/db.js';
export { migrate, migrationStatus } from './kernel/migrate.js';
export { createLogger, silentLogger, type Logger, type LogLevel } from './kernel/log.js';
export type { CronDefinition } from './kernel/cron.js';
export type { EnqueueJobInput, JobRow } from './kernel/jobs.js';
export type { PermissionRule, AccessContext, TenantRow, ExternalIdentity, VerifyTokenHook, RoleDefinition } from './auth/rbac.js';
// server-side administration (trusted code embedding apick, e.g. @apick/cms)
export { createPrincipal, grantRole, createApiKey, revokeApiKey, hashToken, resolveTenantBySlugOrId, can, assertCan } from './auth/rbac.js';
export { putBlob, getBlob, deleteBlob, type BlobMeta } from './kernel/blobs.js';
export type { HonoEnv } from './http/app.js';
export type { RetentionConfig } from './app/retention.js';
export { runWithDraftPreview, draftPreviewDocId } from './kernel/preview.js';
export type { AdminHints } from './schema/collection.js';
export { VERSION } from './version.js';
