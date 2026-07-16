import { defineCollection, f } from '@apick/cms';

export const recipes = defineCollection('recipes', {
  description: 'Cooking recipes',
  admin: { label: 'Recipes', icon: '🍳', titleField: 'name' },
  access: { publicRead: true },
  fields: {
    name: f.text({ required: true }),
    slug: f.slug({ required: true, unique: true }),
    difficulty: f.enum(['easy', 'medium', 'hard'], { default: 'easy' }),
    minutes: f.integer({ min: 1 }),
    ingredients: f.list(f.text()),
    instructions: f.markdown({ required: true }),
  },
});
