/**
 * DocumentForm — ONE schema-driven form component used by the page editor AND
 * the Sheet editor. Owns value state, dirty tracking, slug autogen (until the
 * slug is touched), markdown flushing, autosave (2s debounce, drafts only,
 * existing docs only — like legacy), 422 validation-error mapping, and an
 * imperative handle for save/publish. Ported from ui-legacy/editor.ts.
 */
import * as React from 'react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as api from '../api';
import type { AdminHints, Envelope, FieldDef } from '../types';
import { FormContext, type FormContextValue } from './fields/context';
import { createFlushRegistry } from './fields/flush';
import { Field } from './fields/Field';
import { cleanForWrite, errorMap, slugFieldFor, slugify, titleFieldFor } from './fields/utils';

const AUTOSAVE_DELAY_MS = 2000;

export type FormSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export const SAVE_STATE_LABEL: Record<FormSaveState, string> = {
  idle: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved · just now',
  error: 'Autosave failed',
};

export interface SaveOptions {
  publish?: boolean;
  /** ISO datetime — schedule a future publish (existing docs only). */
  publishAt?: string;
}

export interface DocumentFormHandle {
  /** Persist the draft (and optionally publish/schedule). Null on validation failure. */
  save(opts?: SaveOptions): Promise<Envelope | null>;
  isDirty(): boolean;
}

export interface DocumentFormProps {
  collection: string;
  fields: Record<string, FieldDef>;
  admin?: AdminHints;
  /** The existing draft envelope, or null for create mode. */
  doc: Envelope | null;
  /** Prefill values for create mode (e.g. a pre-connected relation). */
  initial?: Record<string, unknown>;
  /** Debounced draft autosave for existing docs. Default true. */
  autosave?: boolean;
  /** Bump to re-seed values from `doc` (e.g. after a version restore). */
  resetKey?: number;
  /** Fires after every successful persist — explicit saves AND autosaves. */
  onSaved?: (env: Envelope, info: { created: boolean; published: boolean }) => void;
  onState?: (state: FormSaveState) => void;
  onValues?: (values: Record<string, unknown>) => void;
}

export const DocumentForm = forwardRef<DocumentFormHandle, DocumentFormProps>(function DocumentForm(
  { collection, fields, admin, doc, initial, autosave = true, resetKey = 0, onSaved, onState, onValues },
  ref,
) {
  const docId = doc?.docId ?? null;
  const titleField = useMemo(() => titleFieldFor(fields, admin), [fields, admin]);
  const slugField = useMemo(() => slugFieldFor(fields), [fields]);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<FormSaveState>('idle');

  const flush = useMemo(() => createFlushRegistry(), []);
  const slugTouched = useRef(false);
  const savedSnapshot = useRef('');
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onValuesRef = useRef(onValues);
  onValuesRef.current = onValues;

  // Seed values from the loaded doc (or the create-mode prefill).
  useEffect(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const seed = doc ? doc.data : { ...(initial ?? {}) };
    setValues(seed);
    setFieldErrors({});
    savedSnapshot.current = JSON.stringify(seed);
    slugTouched.current = !!(slugField && seed[slugField]); // existing slug = leave it alone
    setSaveState('idle');
    onValuesRef.current?.(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, docId, resetKey]);

  useEffect(() => {
    onState?.(saveState);
  }, [saveState, onState]);

  /** Change a field; auto-derive the slug from the title until it is touched. */
  const changeField = (name: string, v: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [name]: v };
      if (name === slugField) slugTouched.current = true;
      if (name === titleField && slugField && !slugTouched.current && typeof v === 'string') {
        next[slugField] = slugify(v);
      }
      onValuesRef.current?.(next);
      return next;
    });
    setSaveState('dirty');
  };

  const regenerateSlug = () => {
    if (!slugField) return;
    const title = valuesRef.current[titleField ?? ''];
    setValues((prev) => {
      const next = { ...prev, [slugField]: typeof title === 'string' ? slugify(title) : '' };
      onValuesRef.current?.(next);
      return next;
    });
    slugTouched.current = false; // regenerated = back in sync with the title
    setSaveState('dirty');
  };

  // Debounced autosave (existing docs only; never publishes). New docs save on
  // the explicit button so required-field errors surface before anything persists.
  useEffect(() => {
    if (!docId || !autosave) return;
    if (saveState !== 'dirty') return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const flushed = flush.withFlushed(valuesRef.current);
      const body = cleanForWrite(fields, flushed, 'patch');
      const snapshot = JSON.stringify(flushed);
      setSaveState('saving');
      api
        .patchDoc(collection, docId, body)
        .then((env) => {
          savedSnapshot.current = snapshot;
          setSaveState((s) => (s === 'saving' ? 'saved' : s));
          setFieldErrors({});
          onSavedRef.current?.(env, { created: false, published: false });
        })
        .catch((err: unknown) => {
          const mapped = errorMap(err);
          setFieldErrors(mapped.fields);
          setSaveState('error');
        });
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState, values, docId, collection, autosave]);

  const save = async (opts: SaveOptions = {}): Promise<Envelope | null> => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const flushed = flush.withFlushed(valuesRef.current);
    setSaveState('saving');
    setFieldErrors({});
    try {
      let env: Envelope;
      let created = false;
      if (!docId) {
        const body = cleanForWrite(fields, flushed, 'create');
        env = await api.createDoc(collection, body, opts.publish ? { publish: true } : {});
        created = true;
        if (opts.publishAt) env = await api.publishDoc(collection, env.docId, opts.publishAt);
      } else {
        const body = cleanForWrite(fields, flushed, 'patch');
        env = await api.patchDoc(collection, docId, body);
        if (opts.publish) env = await api.publishDoc(collection, docId);
        else if (opts.publishAt) env = await api.publishDoc(collection, docId, opts.publishAt);
      }
      savedSnapshot.current = JSON.stringify(flushed);
      setSaveState('idle');
      onSavedRef.current?.(env, { created, published: opts.publish === true });
      return env;
    } catch (err) {
      const mapped = errorMap(err);
      setFieldErrors(mapped.fields);
      setSaveState('error');
      toast.error(mapped.message);
      return null;
    }
  };

  useImperativeHandle(ref, () => ({
    save,
    isDirty: () => saveState === 'dirty' || saveState === 'saving' || saveState === 'error',
  }));

  const ctx: FormContextValue = useMemo(
    () => ({
      errors: fieldErrors,
      flush,
      ...(slugField && titleField ? { slugPath: slugField, regenerateSlug } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldErrors, flush, slugField, titleField],
  );

  return (
    <FormContext.Provider value={ctx}>
      <form className="grid gap-5" data-doc-form={collection} onSubmit={(e) => e.preventDefault()}>
        {Object.entries(fields).map(([name, def]) => (
          <Field key={name} name={name} path={name} def={def} value={values[name]} onChange={(v) => changeField(name, v)} />
        ))}
        {Object.keys(fields).length === 0 && (
          <p className="text-sm text-muted-foreground">This collection has no writable fields for your role.</p>
        )}
      </form>
    </FormContext.Provider>
  );
});
