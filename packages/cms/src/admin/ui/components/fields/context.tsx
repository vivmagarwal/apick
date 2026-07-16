/**
 * Per-form context: validation errors keyed by dotted path, the markdown flush
 * registry, and the slug-regenerate hook. Provided by DocumentForm so deeply
 * nested field renderers never thread these through props.
 */
import * as React from 'react';
import { createFlushRegistry, type FlushRegistry } from './flush';

export interface FormContextValue {
  /** 422 issues mapped to dotted field paths. */
  errors: Record<string, string>;
  /** Markdown flush registry for THIS form instance. */
  flush: FlushRegistry;
  /** Dotted path of the top-level slug field that supports regeneration. */
  slugPath?: string;
  /** Regenerate that slug from the title (re-enables autogen). */
  regenerateSlug?: () => void;
}

const defaultValue: FormContextValue = { errors: {}, flush: createFlushRegistry() };

export const FormContext = React.createContext<FormContextValue>(defaultValue);

export function useFormContext(): FormContextValue {
  return React.useContext(FormContext);
}
