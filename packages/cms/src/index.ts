// @apick/cms — a full, themable CMS on top of @apick/core.

export { createCms, type CmsApp, type CmsConfig, type CmsPlugin } from './createCms.js';
export { cmsUsers, pages, posts, media, CMS_USERS_KEY } from './content.js';
export { mediaUrl, MEDIA_COLLECTION, type MediaStorage } from './media/routes.js';

// theming
export { defineTheme, mergeTheme, md, configureMarkdown, type Theme, type PartialTheme, type BlockRenderer } from './site/theme.js';
export { renderMarkdown } from './site/sanitize.js';
export { defaultTheme } from './site/default-theme.js';
export { defaultPathFor, type PreviewConfig } from './site/preview.js';
export { html, raw, escapeHtml, RawHtml } from './site/html.js';

// re-export the core schema DSL so CMS apps need one import
export { defineCollection, defineQuery, f, silentLogger } from '@apick/core';
export type { Collection, InferDoc, SavedQuery } from '@apick/core';
