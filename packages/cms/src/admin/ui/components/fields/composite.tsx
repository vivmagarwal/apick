/**
 * Composite editors: list-of-scalars (add/remove rows) and object (fieldset of
 * nested fields). Ported from ui-legacy/fields.ts ListInput / object case.
 */
import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/button';
import { useFormContext } from './context';
import { Field, FieldInput } from './Field';
import type { FieldDef } from '../../types';

export interface CompositeProps {
  path: string;
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}

export function ObjectField({ path, def, value, onChange }: CompositeProps) {
  const obj = (value ?? {}) as Record<string, unknown>;
  return (
    <fieldset className="grid gap-4 rounded-md border bg-muted/20 p-4">
      {Object.entries(def.fields ?? {}).map(([key, sub]) => (
        <Field key={key} name={key} path={`${path}.${key}`} def={sub} value={obj[key]} onChange={(v) => onChange({ ...obj, [key]: v })} />
      ))}
    </fieldset>
  );
}

export function ListField({ path, def, value, onChange }: CompositeProps) {
  const { flush } = useFormContext();
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const itemDef: FieldDef = def.of ?? { type: 'text' };
  // Flush-before-structural-edit guard, same as blocks (markdown list items).
  const currentItems = (): unknown[] => {
    const merged = flush.withFlushed({ [path]: items });
    return Array.isArray(merged[path]) ? (merged[path] as unknown[]) : items;
  };
  const update = (i: number, v: unknown) => onChange(currentItems().map((item, j) => (j === i ? v : item)));
  const emptyItem = (): unknown => (itemDef.type === 'object' ? {} : '');
  return (
    <div className="grid gap-2" data-list={path}>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <FieldInput name={String(i)} path={`${path}.${i}`} def={itemDef} value={item} onChange={(v) => update(i, v)} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            title="Remove item"
            onClick={() => onChange(currentItems().filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" data-add={path} onClick={() => onChange([...currentItems(), emptyItem()])}>
          <Plus /> Add item
        </Button>
      </div>
    </div>
  );
}
