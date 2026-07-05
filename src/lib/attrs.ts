import type { AttributeDef } from '../types';
import { UNSET_DOT } from '../types';

export function optionColor(def: AttributeDef | undefined, value: unknown): string {
  if (!def || value == null || value === '') return UNSET_DOT;
  const opt = def.options.find((o) => o.value === value);
  return opt?.color ?? UNSET_DOT;
}

export function optionLabel(def: AttributeDef | undefined, value: unknown): string {
  if (value == null || value === '') return '';
  const opt = def?.options.find((o) => o.value === value);
  return opt?.label ?? String(value);
}

/** Allocation cell keys: `${layer}|${depth}` ('' = unset), '!' = "not needed". */
export function patchOfCellKey(key: string): {
  layer?: string | null;
  depth?: number | null;
  noalloc?: boolean | null;
} {
  // the bin only flags nodes — allocations of already-allocated parts survive
  if (key === '!' || key === '!|') return { noalloc: true };
  const [layer, depth] = key.split('|');
  return {
    layer: layer === '' ? null : layer,
    depth: depth === '' ? null : Number(depth),
    noalloc: null, // dropping into any real cell (or the unallocated tray) clears the bin flag
  };
}
