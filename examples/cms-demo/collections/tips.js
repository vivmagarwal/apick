import { defineCollection, f } from '@apick/cms';

// Tips attach to a recipe — in the admin, a recipe's editor shows its tips as
// a related-content panel (add / reorder / edit in place).
export const tips = defineCollection('tips', {
  description: 'Chef tips attached to a recipe',
  access: { publicRead: true },
  admin: { label: 'Chef tips', icon: '💡', titleField: 'tip', orderField: 'order' },
  fields: {
    tip: f.text({ required: true, maxLength: 200 }),
    slug: f.slug({ required: true, unique: true }),
    detail: f.markdown(),
    order: f.integer({ default: 0 }),
    recipe: f.relation('recipes'),
  },
});
