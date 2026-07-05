import type { NodeData, XY } from '../types';

export interface Size {
  w: number;
  h: number;
}

const VGAP = 12; // vertical breathing room between nodes
const HGAP = 56; // horizontal distance parent -> child
const TREE_GAP = 90; // gap between stacked trees

/**
 * Tidy left-to-right tree layout of the VISIBLE nodes only.
 * Leaves stack downward; parents center on their children; collapsing a
 * branch frees its space so the whole map compacts. Trees stack vertically.
 */
export function tidyLayout(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  expanded: Record<string, true>,
  sizeOf: (id: string) => Size,
  /** optional per-tree anchor: the root keeps this position, its tree follows */
  origins?: Record<string, XY>,
): Record<string, XY> {
  const pos: Record<string, XY> = {};
  let cursor = 0;

  const place = (id: string, x: number): { top: number; bottom: number } => {
    const n = nodes[id];
    if (!n) return { top: cursor, bottom: cursor };
    const { w, h } = sizeOf(id);
    const kids = expanded[id] ? n.childIds.filter((c) => nodes[c]) : [];

    if (kids.length === 0) {
      const y = cursor;
      pos[id] = { x, y };
      cursor = y + h + VGAP;
      return { top: y, bottom: y + h };
    }

    const childX = x + w + HGAP;
    const before = cursor;
    let top = Infinity;
    let bottom = -Infinity;
    for (const c of kids) {
      const span = place(c, childX);
      if (span.top < top) top = span.top;
      if (span.bottom > bottom) bottom = span.bottom;
    }
    let y = (top + bottom) / 2 - h / 2;
    if (y < before - (top - before)) {
      // parent taller than its children's span: push the subtree down
      const shift = before - y;
      if (shift > 0 && y < before) {
        y += shift / 2;
      }
    }
    if (y < 0) y = 0;
    pos[id] = { x, y };
    if (y + h + VGAP > cursor) cursor = y + h + VGAP;
    return { top: Math.min(y, top), bottom: Math.max(y + h, bottom) };
  };

  let autoY = 0;
  for (const r of rootIds) {
    const o = origins?.[r];
    cursor = o ? o.y : autoY;
    place(r, o ? o.x : 0);
    autoY = Math.max(autoY, cursor) + TREE_GAP;
  }
  return pos;
}

/**
 * Full-expansion layout with uniform node sizes — the galaxy's coordinate
 * space. Stable regardless of what's expanded in the detail view.
 */
export function fullLayout(
  nodes: Record<string, NodeData>,
  rootIds: string[],
): Record<string, XY> {
  const everything: Record<string, true> = {};
  for (const id of Object.keys(nodes)) everything[id] = true;
  return tidyLayout(nodes, rootIds, everything, () => ({ w: 150, h: 26 }));
}
