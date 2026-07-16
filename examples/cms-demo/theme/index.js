import { html } from '@apick/cms';

// Child theme: override one block renderer, inherit everything else.
export const theme = {
  name: 'test-kitchen',
  blocks: {
    quote: (props) => html`<aside class="pull-quote">🍳 ${props.text}</aside>`,
  },
};
