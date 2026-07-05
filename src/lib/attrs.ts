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

/** Allocation cell keys: `${layer}|${depth}`, '' meaning unset. */
export function patchOfCellKey(key: string): { layer: string | null; depth: number | null } {
  const [layer, depth] = key.split('|');
  return { layer: layer === '' ? null : layer, depth: depth === '' ? null : Number(depth) };
}
