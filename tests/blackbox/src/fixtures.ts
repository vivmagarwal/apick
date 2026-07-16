import { defineCollection, defineQuery, f } from 'apick';

/** Shared content model used across the promise tests. */
export function blogCollections() {
  const authors = defineCollection('authors', {
    description: 'Article authors',
    fields: {
      name: f.text({ required: true }),
      email: f.email({ private: true }),
      bio: f.markdown(),
    },
  });

  const articles = defineCollection('articles', {
    description: 'Blog articles',
    access: { publicRead: true },
    fields: {
      title: f.text({ required: true, maxLength: 200, indexed: true }),
      slug: f.slug({ unique: true }),
      body: f.markdown(),
      category: f.enum(['tech', 'life', 'news'] as const),
      views: f.integer({ min: 0, default: 0 }),
      featured: f.boolean({ default: false }),
      publishDate: f.datetime(),
      secretNotes: f.text({ private: true }),
      seo: f.object({
        metaTitle: f.text(),
        metaKey: f.text({ unique: true }),
      }),
      tags: f.list(f.text()),
      author: f.relation('authors'),
      related: f.relations('articles'),
      blocks: f.blocks({
        hero: { heading: f.text({ required: true }), image: f.uri() },
        quote: { text: f.text({ required: true }), attribution: f.text() },
      }),
    },
  });

  return { articles, authors, collections: [authors, articles] };
}

export const recentArticles = defineQuery('recent-articles', {
  collection: 'articles',
  description: 'Latest published articles, optionally by category',
  filter: { category: { $eq: { $param: 'category' } } },
  sort: '-createdAt',
  pageSize: 10,
  params: { category: { type: 'text', required: true } },
});
