/**
 * Blocks (dynamic zone) editor: variant cards with an add menu, HTML5
 * drag-reorder, per-card collapse and delete. Structural edits go through the
 * flush registry first so a markdown block mid-debounce never loses text
 * (ported from ui-legacy/fields.ts BlocksInput; drag + collapse are new UX per
 * the spec / Strapi study).
 */
import * as React from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useFormContext } from './context';
import { Field } from './Field';
import type { FieldDef } from '../../types';

export function BlocksField({ path, def, value, onChange }: { path: string; def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const { flush } = useFormContext();
  const blocks = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const variants = def.variants ?? {};
  const [collapsed, setCollapsed] = useState<boolean[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Reordering/removing a block can destroy a markdown editor whose latest
  // text is still inside edodo's change debounce; flush every editor's current
  // value into the block data FIRST, so structural edits never lose content.
  const currentBlocks = (): Array<Record<string, unknown>> => {
    const merged = flush.withFlushed({ [path]: blocks });
    const out = merged[path];
    return Array.isArray(out) ? (out as Array<Record<string, unknown>>) : blocks;
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = currentBlocks().slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
    setCollapsed((prev) => {
      const arr = blocks.map((_, i) => prev[i] ?? false);
      const [c] = arr.splice(from, 1);
      arr.splice(to, 0, c ?? false);
      return arr;
    });
  };

  const removeBlock = (i: number) => {
    onChange(currentBlocks().filter((_, j) => j !== i));
    setCollapsed((prev) => {
      const arr = blocks.map((_, j) => prev[j] ?? false);
      arr.splice(i, 1);
      return arr;
    });
  };

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const arr = blocks.map((_, j) => prev[j] ?? false);
      arr[i] = !arr[i];
      return arr;
    });

  return (
    <div className="grid gap-2" data-list={path}>
      {blocks.map((block, i) => {
        const type = typeof block['__type'] === 'string' ? block['__type'] : '?';
        const shape = variants[type] ?? {};
        const isCollapsed = collapsed[i] ?? false;
        return (
          <div
            key={i}
            data-block={`${path}.${i}`}
            className={cn(
              'rounded-md border bg-card shadow-sm transition-colors',
              dropIndex === i && dragIndex !== null && dragIndex !== i && 'border-ring border-dashed',
              dragIndex === i && 'opacity-60',
            )}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              setDropIndex(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) reorder(dragIndex, i);
              setDragIndex(null);
              setDropIndex(null);
            }}
          >
            <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2 py-1.5">
              <span
                draggable
                title="Drag to reorder"
                className="cursor-grab rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
                onDragStart={(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i));
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
              >
                <GripVertical className="size-4" />
              </span>
              <button
                type="button"
                className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm font-medium hover:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
                onClick={() => toggle(i)}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                {type}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                title="Remove block"
                onClick={() => removeBlock(i)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {!isCollapsed && (
              <div className="grid gap-4 p-4">
                {Object.entries(shape).map(([key, sub]) => (
                  <Field
                    key={key}
                    name={key}
                    path={`${path}.${i}.${key}`}
                    def={sub}
                    value={block[key]}
                    onChange={(v) => onChange(currentBlocks().map((b, j) => (j === i ? { ...b, [key]: v } : b)))}
                  />
                ))}
                {Object.keys(shape).length === 0 && <p className="text-xs text-muted-foreground">This block type has no fields.</p>}
              </div>
            )}
          </div>
        );
      })}
      <div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" data-add={path}>
              <Plus /> Add block
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {Object.keys(variants).map((v) => (
              <DropdownMenuItem key={v} onSelect={() => onChange([...currentBlocks(), { __type: v }])}>
                {v}
              </DropdownMenuItem>
            ))}
            {Object.keys(variants).length === 0 && <DropdownMenuItem disabled>No block types defined</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
