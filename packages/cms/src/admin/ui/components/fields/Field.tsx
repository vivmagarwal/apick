/**
 * The schema-driven form engine: every APIck field type gets an editor,
 * derived entirely from the FieldDef the server publishes. `Field` renders the
 * label / badges / description / inline-error chrome; `FieldInput` dispatches
 * to the concrete editor. Ported from ui-legacy/fields.ts onto the new
 * component kit.
 */
import * as React from 'react';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { useFormContext } from './context';
import { fieldLabel } from './utils';
import { TextInput, NumberInput, BooleanInput, DateInput, EnumInput, JsonInput } from './scalars';
import { MarkdownField } from './MarkdownField';
import { ImageField } from './ImageField';
import { ListField, ObjectField } from './composite';
import { BlocksField } from './BlocksField';
import { RelationPicker } from '../RelationPicker';
import type { FieldDef } from '../../types';

export interface FieldProps {
  name: string;
  /** Dotted path into the document body (also the test selector). */
  path: string;
  def: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}

export function Field(props: FieldProps) {
  const { errors } = useFormContext();
  const { name, path, def } = props;
  const error = errors[path];
  return (
    <div className="grid gap-1.5" data-field={path}>
      <Label htmlFor={path} className="flex items-center gap-1.5">
        {fieldLabel(name)}
        {def.required && <span className="text-destructive" aria-hidden>*</span>}
        {def.private && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal" title="Write-only: never returned by the API">
            write-only
          </Badge>
        )}
        {def.unique && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
            unique
          </Badge>
        )}
      </Label>
      {def.description && <p className="text-xs text-muted-foreground">{def.description}</p>}
      <FieldInput {...props} />
      {error && (
        <p className="text-xs font-medium text-destructive" data-field-error={path}>
          {error}
        </p>
      )}
    </div>
  );
}

export function FieldInput(props: FieldProps) {
  const { def, path, value, onChange } = props;
  switch (def.type) {
    case 'text':
      if (def.format === 'markdown') return <MarkdownField path={path} value={value} onChange={onChange} />;
      if (def.format === 'image') return <ImageField path={path} value={value} onChange={onChange} />;
      return <TextInput path={path} def={def} value={value} onChange={onChange} />;
    case 'integer':
    case 'number':
      return <NumberInput path={path} def={def} value={value} onChange={onChange} />;
    case 'boolean':
      return <BooleanInput path={path} def={def} value={value} onChange={onChange} />;
    case 'datetime':
    case 'date':
      return <DateInput path={path} def={def} value={value} onChange={onChange} />;
    case 'enum':
      return <EnumInput path={path} def={def} value={value} onChange={onChange} />;
    case 'json':
      return <JsonInput path={path} def={def} value={value} onChange={onChange} />;
    case 'object':
      return <ObjectField path={path} def={def} value={value} onChange={onChange} />;
    case 'list':
      return <ListField path={path} def={def} value={value} onChange={onChange} />;
    case 'relation':
      return <RelationPicker path={path} def={def} value={value} onChange={onChange} />;
    case 'blocks':
      return <BlocksField path={path} def={def} value={value} onChange={onChange} />;
    default:
      return <p className="text-xs text-muted-foreground">Unsupported field type: {def.type}</p>;
  }
}
