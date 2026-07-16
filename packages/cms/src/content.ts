import { defineCollection, defineQuery, f } from '@apick/core';

/**
 * The CMS's opinionated default content model — WordPress's pages + posts,
 * done as ordinary APIck collections (delete them by passing
 * `defaultContent: false` and bringing your own).
 */

export const CMS_USERS_KEY = 'cms-users';

export const cmsUsers = defineCollection(CMS_USERS_KEY, {
  description: 'CMS admin users (managed under Settings → Users)',
  fields: {
    email: f.email({ required: true, unique: true }),
    name: f.text({ required: true, maxLength: 120 }),
    role: f.enum(['admin', 'editor', 'viewer'], { required: true, description: 'admin: everything · editor: content · viewer: read-only' }),
    // Write-only by the planner's guarantee: no API response, filter, sort or
    // populate can ever surface this — the CMS verifies it server-side only.
    passwordHash: f.text({ private: true, required: true }),
  },
});

export const media = defineCollection('media', {
  description: 'Uploaded files (managed under Media; served at /media/:id/:filename)',
  access: { publicRead: true },
  fields: {
    filename: f.text({ required: true, maxLength: 200 }),
    alt: f.text({ maxLength: 300, description: 'Alt text for accessibility' }),
    mime: f.text({ required: true, immutable: true }),
    size: f.integer({ required: true, immutable: true }),
    blobKey: f.text({ required: true, immutable: true, description: 'Storage key (managed by the CMS)' }),
  },
});

export const pages = defineCollection('pages', {
  description: 'Standalone pages (about, contact, …) rendered by the theme',
  access: { publicRead: true },
  fields: {
    title: f.text({ required: true, maxLength: 200 }),
    slug: f.slug({ required: true, unique: true, indexed: true }),
    showInNav: f.boolean({ default: false, description: 'Show in the site navigation' }),
    navOrder: f.integer({ default: 0 }),
    body: f.blocks({
      prose: { markdown: f.markdown({ required: true }) },
      hero: { heading: f.text({ required: true }), subheading: f.text(), imageUrl: f.image() },
      quote: { text: f.text({ required: true }), attribution: f.text() },
    }),
    seoDescription: f.text({ maxLength: 300 }),
  },
});

export const posts = defineCollection('posts', {
  description: 'Blog posts, newest first on the site',
  access: { publicRead: true },
  fields: {
    title: f.text({ required: true, maxLength: 200 }),
    slug: f.slug({ required: true, unique: true, indexed: true }),
    excerpt: f.text({ maxLength: 500 }),
    body: f.markdown({ required: true }),
    tags: f.list(f.text()),
    coverImageUrl: f.image(),
    publishDate: f.datetime({ description: 'Shown on the site; defaults to publish time' }),
  },
});

export const recentPosts = defineQuery('cms-recent-posts', {
  collection: 'posts',
  description: 'Published posts, newest first',
  sort: '-publishDate,-createdAt',
  pageSize: 10,
});
