/**
 * Image URL field: url input + Media-library picker + thumbnail preview.
 * Ported from ui-legacy/fields.ts ImageField.
 */
import * as React from 'react';
import { useState } from 'react';
import { ImageIcon, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MediaPicker } from '../MediaPicker';

export function ImageField({ path, value, onChange }: { path: string; value: unknown; onChange: (v: unknown) => void }) {
  const [picking, setPicking] = useState(false);
  const url = typeof value === 'string' ? value : '';
  return (
    <div className="grid gap-2" data-input={path}>
      <div className="flex gap-2">
        <Input
          id={path}
          data-input={`${path}.url`}
          type="text"
          value={url}
          placeholder="/media/… or https://…"
          onChange={(e) => onChange(e.target.value || null)}
        />
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 gap-1.5" data-action="pick-media" onClick={() => setPicking(true)}>
          <ImageIcon /> Media…
        </Button>
        {url && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="Clear" onClick={() => onChange(null)}>
            <X />
          </Button>
        )}
      </div>
      {url && (
        <div className="overflow-hidden rounded-md border bg-muted/40 p-2">
          <img src={url} alt="" className="max-h-44 rounded object-contain" />
        </div>
      )}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        accept="image/*"
        onPick={(item) => {
          onChange(item.url);
          setPicking(false);
        }}
      />
    </div>
  );
}
