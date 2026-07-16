/**
 * Scalar field editors: text (plain / textarea / email / uri / slug), numbers,
 * boolean switch, date & datetime, enum select, json textarea with parse
 * feedback. Ported behaviors from ui-legacy/fields.ts.
 */
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useFormContext } from './context';
import { isoToLocal, localToIso } from './utils';
import type { FieldDef } from '../../types';

export interface ScalarProps {
  path: string;
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}

/** Long-form text renders a textarea; everything else a typed input. */
export function TextInput({ path, def, value, onChange }: ScalarProps) {
  const str = typeof value === 'string' ? value : '';
  const placeholder = def.private ? '(leave blank to keep the current value)' : undefined;
  // No cap or a generous cap (> 200 chars) reads as long-form — but obvious
  // title-ish fields (required text used as the doc title) stay single-line.
  const multiline = def.format === undefined && def.maxLength !== undefined && def.maxLength > 200;
  if (multiline) {
    return (
      <Textarea
        id={path}
        data-input={path}
        rows={4}
        value={str}
        {...(placeholder ? { placeholder } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (def.format === 'slug') return <SlugInput path={path} def={def} value={value} onChange={onChange} />;
  const type = def.format === 'email' ? 'email' : def.format === 'uri' ? 'url' : 'text';
  return (
    <Input
      id={path}
      data-input={path}
      type={type}
      value={str}
      {...(placeholder ? { placeholder } : {})}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Slug: monospace input + Regenerate-from-title button (top-level slugs only). */
function SlugInput({ path, value, onChange }: ScalarProps) {
  const { slugPath, regenerateSlug } = useFormContext();
  const str = typeof value === 'string' ? value : '';
  return (
    <div className="flex gap-2">
      <Input id={path} data-input={path} className="font-mono text-xs" value={str} onChange={(e) => onChange(e.target.value)} />
      {regenerateSlug && path === slugPath && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-1.5"
          title="Regenerate from title"
          data-action={`regenerate:${path}`}
          onClick={() => regenerateSlug()}
        >
          <RefreshCw /> Regenerate
        </Button>
      )}
    </div>
  );
}

export function NumberInput({ path, def, value, onChange }: ScalarProps) {
  return (
    <Input
      id={path}
      data-input={path}
      type="number"
      step={def.type === 'integer' ? 1 : 'any'}
      value={value === null || value === undefined ? '' : String(value)}
      {...(def.min !== undefined ? { min: def.min } : {})}
      {...(def.max !== undefined ? { max: def.max } : {})}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? null : def.type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw));
      }}
    />
  );
}

export function BooleanInput({ path, value, onChange }: ScalarProps) {
  const on = value === true;
  return (
    <div className="flex items-center gap-2.5">
      <Switch id={path} data-input={path} checked={on} onCheckedChange={(checked) => onChange(checked)} />
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </div>
  );
}

export function DateInput({ path, def, value, onChange }: ScalarProps) {
  if (def.type === 'datetime') {
    return (
      <Input
        id={path}
        data-input={path}
        type="datetime-local"
        className="max-w-64"
        value={isoToLocal(value)}
        onChange={(e) => onChange(localToIso(e.target.value))}
      />
    );
  }
  return (
    <Input
      id={path}
      data-input={path}
      type="date"
      className="max-w-48"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

/** Radix Select can't represent "" — use a sentinel for the empty option. */
const NONE = '__none__';

export function EnumInput({ path, def, value, onChange }: ScalarProps) {
  const current = typeof value === 'string' && value !== '' ? value : NONE;
  return (
    <Select value={current} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={path} data-input={path} className="max-w-72">
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        {!def.required && <SelectItem value={NONE}>—</SelectItem>}
        {(def.values ?? []).map((v) => (
          <SelectItem key={v} value={v}>
            {v}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function JsonInput({ path, value, onChange }: ScalarProps) {
  const [text, setText] = useState(value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  // Track what we last emitted so external resets (load/restore) re-seed the
  // textarea without clobbering in-progress typing.
  const lastEmitted = useRef<unknown>(value);
  useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(lastEmitted.current)) {
      lastEmitted.current = value;
      setText(value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
      setBad(false);
    }
  }, [value]);
  return (
    <div className="grid gap-1">
      <Textarea
        id={path}
        data-input={path}
        rows={6}
        className="font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (!raw.trim()) {
            setBad(false);
            lastEmitted.current = null;
            onChange(null);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            lastEmitted.current = parsed;
            onChange(parsed);
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? (
        <p className="text-xs font-medium text-destructive">Invalid JSON — not saved until fixed.</p>
      ) : (
        text.trim() !== '' && <p className="text-xs text-muted-foreground">Valid JSON ✓</p>
      )}
    </div>
  );
}
