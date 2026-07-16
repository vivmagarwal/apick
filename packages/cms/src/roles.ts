import type { Collection, RoleDefinition } from '@apick/core';
import { CMS_USERS_KEY } from './content.js';

/**
 * CMS roles, defined in code and synced through core's `roles` config.
 * The union-only RBAC model means "editors can touch everything EXCEPT
 * cms-users" must be expressed as explicit per-collection grants — which the
 * CMS can do, because it knows the full collection list at boot. This is what
 * blocks the classic escalation (an editor editing cms-users to make
 * themselves admin).
 */
export function cmsRoleDefinitions(collections: Collection[]): RoleDefinition[] {
  const contentKeys = collections.map((c) => c.key).filter((k) => k !== CMS_USERS_KEY);

  const editorPerms = contentKeys.flatMap((key) =>
    (['read', 'readDraft', 'create', 'update', 'delete', 'publish'] as const).map((action) => ({
      action,
      resource: `doc:${key}`,
      fields: null,
      condition: null,
    })),
  );
  const viewerPerms = contentKeys.flatMap((key) =>
    (['read', 'readDraft'] as const).map((action) => ({
      action,
      resource: `doc:${key}`,
      fields: null,
      condition: null,
    })),
  );

  return [
    {
      key: 'cms-admin',
      name: 'CMS admin',
      permissions: [
        { action: '*', resource: 'doc:*', fields: null, condition: null },
        { action: 'manage', resource: 'system:keys', fields: null, condition: null },
        { action: 'manage', resource: 'system:roles', fields: null, condition: null },
        { action: 'manage', resource: 'system:webhooks', fields: null, condition: null },
        { action: 'manage', resource: 'system:events', fields: null, condition: null },
        { action: 'manage', resource: 'system:export', fields: null, condition: null },
        { action: 'manage', resource: 'system:principals', fields: null, condition: null },
        { action: 'manage', resource: 'system:jobs', fields: null, condition: null },
      ],
    },
    { key: 'cms-editor', name: 'CMS editor', permissions: editorPerms },
    { key: 'cms-viewer', name: 'CMS viewer', permissions: viewerPerms },
  ];
}

export function coreRoleForCmsRole(role: string): string {
  switch (role) {
    case 'admin':
      return 'cms-admin';
    case 'editor':
      return 'cms-editor';
    default:
      return 'cms-viewer';
  }
}
