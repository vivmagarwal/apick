/**
 * Markdown editing via edodo-write (Notion/Medium-style, Markdown IS the
 * value) — ported from ui-legacy/fields.ts. The editor is created ONCE per
 * mount (its registries resolve at construction); external value changes after
 * mount are pushed with setMarkdown(silent). Pasted/dropped images upload to
 * the media library. A synchronous getter registers in the form's flush
 * registry so saves capture text still inside edodo's ~120ms change debounce.
 */
import * as React from 'react';
import { useEffect, useRef } from 'react';
import { EdodoWrite } from 'edodo-write';
import * as api from '../../api';
import { useFormContext } from './context';

export function MarkdownField({ path, value, onChange }: { path: string; value: unknown; onChange: (v: unknown) => void }) {
  const { flush } = useFormContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InstanceType<typeof EdodoWrite> | null>(null);
  const valueRef = useRef<string>(typeof value === 'string' ? value : '');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = new EdodoWrite(hostRef.current, {
      value: valueRef.current,
      // "fill" = full-width embedded composer (vs the centered document look).
      layout: 'fill',
      placeholder: 'Write… type “/” for blocks',
      onChange: (md: string) => {
        valueRef.current = md;
        onChangeRef.current(md);
      },
      uploadImage: async (file: File) => {
        const item = await api.uploadMedia(file, file.name);
        return { src: item.url, alt: item.alt || item.filename };
      },
    });
    editorRef.current = editor;
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  // Register the synchronous getter under the CURRENT path; re-registers when
  // the path changes (e.g. a markdown block reordered).
  useEffect(() => flush.register(path, () => editorRef.current?.getMarkdown() ?? ''), [flush, path]);

  // Reflect external resets (load, version restore) without clobbering typing.
  useEffect(() => {
    const incoming = typeof value === 'string' ? value : '';
    if (editorRef.current && incoming !== valueRef.current) {
      valueRef.current = incoming;
      editorRef.current.setMarkdown(incoming, { silent: true });
    }
  }, [value]);

  return (
    <div
      className="min-h-40 rounded-md border border-input bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring [&_.edodo-write]:min-h-40"
      data-input={path}
      data-markdown={path}
      ref={hostRef}
    />
  );
}
