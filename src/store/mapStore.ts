import { create } from 'zustand';
import { supabase, IMAGE_BUCKET } from '../lib/supabase';
import { LAYER_PALETTE, LEGACY_LAYER_GRAYS } from '../lib/colors';
import { persister, type SaveState } from './persistence';
import type {
  AttributeDef,
  Attrs,
  CosmosMap,
  CrossLink,
  NodeData,
  NodeImage,
  Viewport,
  XY,
} from '../types';

export type ViewKind = 'mindmap' | 'map' | 'table' | 'split';
export type ColorMode = 'status' | 'allocation';

interface UndoEntry {
  label: string;
  /** coalescing key: consecutive entries with the same key merge (typing) */
  key: string | null;
  at: number;
  undo: () => void;
  redo: () => void;
}

/** set while replaying undo/redo so mutators don't record new entries */
let restoring = false;

export interface MapState {
  // data
  maps: CosmosMap[];
  mapId: string | null;
  mapName: string;
  nodes: Record<string, NodeData>;
  rootIds: string[];
  crossLinks: CrossLink[];
  layouts: Record<string, XY>;
  attrDefs: AttributeDef[];
  images: Record<string, NodeImage[]>;

  // ui
  view: ViewKind;
  overview: boolean;
  viewport: Viewport | null;
  expanded: Record<string, true>;
  selected: Record<string, true>;
  editingNodeId: string | null;
  sorting: boolean;
  sortingAttr: string;
  sortingBranch: boolean;
  colorMode: ColorMode;
  /** node to center on once the detail view has laid out */
  focusNodeId: string | null;
  loading: boolean;
  loadError: string | null;
  saveState: SaveState;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // lifecycle
  loadMaps: () => Promise<void>;
  loadMap: (id: string) => Promise<void>;
  closeMap: () => void;
  renameMap: (name: string) => void;
  deleteMap: (id: string) => Promise<void>;

  // node edits (every view goes through these — that's the sync)
  setAttr: (ids: string[], name: string, value: string | number | null) => void;
  allocate: (ids: string[], patch: { layer?: string | null; depth?: number | null }) => void;
  setLabel: (id: string, label: string) => void;
  setNotes: (id: string, notes: string) => void;
  setPositions: (moves: { id: string; x: number; y: number }[], commit: boolean) => void;
  commitPositions: (entries: { id: string; from: XY; to: XY }[]) => void;
  addChild: (parentId: string) => string;
  deleteNodes: (ids: string[]) => void;
  detachBranch: (childId: string) => void;
  /** drop a node onto another: it becomes that node's child (branch moves along) */
  reparent: (childId: string, newParentId: string) => void;
  deleteCrossLink: (id: string) => void;
  /** draw a dashed relation between two unrelated nodes */
  addCrossLink: (source: string, target: string) => void;
  /** free-floating text callout (a parentless label node) */
  addLabel: (pos: XY) => string;
  addEnumOption: (attrName: string, value: string, color?: string) => void;
  setLayerOptions: (
    options: { value: string; color?: string; label?: string; depths?: number }[],
    remap?: Record<string, string | null>,
  ) => void;
  insertLayerDepth: (layer: string, pos: number) => void;
  removeLayerDepth: (layer: string, pos: number) => boolean;
  addImage: (nodeId: string, file: File) => Promise<void>;
  deleteImage: (nodeId: string, imageId: string) => void;

  // undo
  undo: () => void;
  redo: () => void;

  // expansion / selection
  toggleExpanded: (id: string) => void;
  expandPathTo: (id: string) => void;
  expandBranch: (id: string, budget?: number) => void;
  expandAllUnder: (ids: string[]) => void;
  collapseAllUnder: (ids: string[]) => void;
  collapseAll: () => void;
  reorderSibling: (id: string, dir: -1 | 1) => void;
  setSelected: (ids: string[]) => void;

  // view state
  setView: (v: ViewKind) => void;
  setOverview: (v: boolean) => void;
  setViewport: (vp: Viewport | null) => void;
  setEditingNode: (id: string | null) => void;
  setSorting: (on: boolean) => void;
  setSortingAttr: (name: string) => void;
  setSortingBranch: (on: boolean) => void;
  setColorMode: (m: ColorMode) => void;
  setFocusNode: (id: string | null) => void;

  /** Map (grid) view expansion state + label-edit request */
  gridOpen: Record<string, boolean>;
  gridSetOpen: (id: string, open: boolean) => void;
  gridOpenUnder: (ids: string[], open: boolean) => void;
  editingLabelId: string | null;
  setEditingLabel: (id: string | null) => void;
}

const PAGE = 1000;
const UNDO_CAP = 100;
const COALESCE_MS = 1200;

async function fetchAll<T>(table: string, mapId: string, pk = 'id'): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('map_id', mapId)
      .order(pk) // stable order so pagination never skips rows
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** All ids in the subtree rooted at `id` (including `id`). */
export function subtreeIds(nodes: Record<string, NodeData>, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const n = nodes[cur];
    if (!n) continue;
    out.push(cur);
    for (let i = n.childIds.length - 1; i >= 0; i--) stack.push(n.childIds[i]);
  }
  return out;
}

/** Root of the tree containing `id`. */
export function treeRootOf(nodes: Record<string, NodeData>, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (nodes[cur]?.parentId && !seen.has(cur)) {
    seen.add(cur);
    cur = nodes[cur].parentId!;
  }
  return cur;
}

/** DFS order of nodes visible under the current expansion state. */
export function visibleIds(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  expanded: Record<string, true>,
): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    out.push(id);
    if (expanded[id]) for (const c of n.childIds) walk(c);
  };
  for (const r of rootIds) walk(r);
  return out;
}

/** Full-tree DFS with depth and breadcrumb path (table row order). */
export function treeOrder(
  nodes: Record<string, NodeData>,
  rootIds: string[],
): { id: string; depth: number; path: string }[] {
  const out: { id: string; depth: number; path: string }[] = [];
  const walk = (id: string, depth: number, path: string) => {
    const n = nodes[id];
    if (!n) return;
    out.push({ id, depth, path });
    const childPath = path ? `${path} › ${n.label.replace(/\n/g, ' ')}` : n.label.replace(/\n/g, ' ');
    for (const c of n.childIds) walk(c, depth + 1, childPath);
  };
  for (const r of rootIds) walk(r, 0, '');
  return out;
}

export type AllocState = 'none' | 'x' | 'xy';
export function allocationState(n: NodeData): AllocState {
  const hasLayer = n.attrs.layer != null && n.attrs.layer !== '';
  const hasDepth = n.attrs.depth != null && n.attrs.depth !== '';
  if (hasLayer && hasDepth) return 'xy';
  if (hasLayer) return 'x';
  return 'none';
}

/** Global depth ceiling (max across layers) — used where no layer is fixed. */
export function depthColumnCount(
  attrDefs: AttributeDef[],
  nodes: Record<string, NodeData>,
): number {
  const legacy = attrDefs.find((d) => d.name === 'depth')?.config?.max ?? 5;
  let max = legacy;
  for (const o of attrDefs.find((d) => d.name === 'layer')?.options ?? []) {
    if (o.depths && o.depths > max) max = o.depths;
  }
  for (const n of Object.values(nodes)) {
    const v = Number(n.attrs.depth);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return Math.max(1, Math.round(max));
}

/** Depth column count for ONE layer: its own setting stretched by use. */
export function layerDepthCount(
  attrDefs: AttributeDef[],
  nodes: Record<string, NodeData>,
  layer: string,
): number {
  const opt = attrDefs.find((d) => d.name === 'layer')?.options.find((o) => o.value === layer);
  let max = opt?.depths ?? (attrDefs.find((d) => d.name === 'depth')?.config?.max ?? 5);
  for (const n of Object.values(nodes)) {
    if (n.attrs.layer !== layer) continue;
    const v = Number(n.attrs.depth);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return Math.max(1, Math.round(max));
}

interface NodeRow {
  id: string;
  label: string;
  notes: string;
  attrs: Attrs | null;
}
interface EdgeRow {
  id: string;
  source: string;
  target: string;
  kind: 'structural' | 'cross';
  link_type: string | null;
  sort_order: number;
}

/** Everything needed to resurrect a deleted set of subtrees. */
interface RestorePayload {
  nodes: NodeData[];
  layouts: Record<string, XY>;
  images: Record<string, NodeImage[]>;
  crossLinks: CrossLink[];
  /** deleted subtree roots that hung off surviving parents */
  attachments: { childId: string; parentId: string; index: number }[];
  /** deleted subtree roots that were map roots */
  rootPositions: { id: string; index: number }[];
  mapId: string;
}

export const useMapStore = create<MapState>()((set, get) => {
  // ---------- undo plumbing ----------

  const pushUndo = (entry: Omit<UndoEntry, 'at'>) => {
    if (restoring) return;
    const { undoStack } = get();
    const top = undoStack[undoStack.length - 1];
    if (
      entry.key != null &&
      top &&
      top.key === entry.key &&
      Date.now() - top.at < COALESCE_MS
    ) {
      // typing burst: keep the original inverse, adopt the newest forward
      const merged: UndoEntry = { ...top, at: Date.now(), redo: entry.redo };
      set({ undoStack: [...undoStack.slice(0, -1), merged], redoStack: [] });
      return;
    }
    const next = [...undoStack, { ...entry, at: Date.now() }];
    if (next.length > UNDO_CAP) next.shift();
    set({ undoStack: next, redoStack: [] });
  };

  const runRestoring = (fn: () => void) => {
    restoring = true;
    try {
      fn();
    } finally {
      restoring = false;
    }
  };

  // ---------- shared internal mutations (used by actions and their undos) ----------

  /** Set one attribute to per-id values; returns the previous values. */
  const applyAttrEntries = (
    name: string,
    entries: [string, string | number | null][],
    log = true,
  ): [string, string | number | null][] => {
    const { nodes, mapId } = get();
    if (!mapId) return [];
    const next = { ...nodes };
    const old: [string, string | number | null][] = [];
    let changed = false;
    for (const [id, value] of entries) {
      const n = next[id];
      if (!n) continue;
      const prev = n.attrs[name];
      const same = prev === value || (value == null && prev === undefined);
      if (same) continue;
      old.push([id, prev === undefined ? null : prev]);
      const attrs = { ...n.attrs };
      if (value == null || value === '') delete attrs[name];
      else attrs[name] = value;
      next[id] = { ...n, attrs };
      changed = true;
      persister.upsert('nodes', { id, map_id: mapId, label: n.label, notes: n.notes, attrs });
      if (log) {
        persister.insert('status_history', {
          map_id: mapId,
          node_id: id,
          attribute: name,
          old_value: prev == null ? null : String(prev),
          new_value: value == null || value === '' ? null : String(value),
        });
      }
    }
    if (changed) set({ nodes: next });
    return old;
  };

  /** Set several attributes at once per node; returns previous values. */
  const applyAllocEntries = (
    entries: { id: string; layer?: string | null; depth?: number | null }[],
  ): { id: string; layer?: string | null; depth?: number | null }[] => {
    const { nodes, mapId } = get();
    if (!mapId) return [];
    const next = { ...nodes };
    const old: { id: string; layer?: string | null; depth?: number | null }[] = [];
    let changed = false;
    for (const e of entries) {
      const n = next[e.id];
      if (!n) continue;
      const attrs = { ...n.attrs };
      const prev: { id: string; layer?: string | null; depth?: number | null } = { id: e.id };
      let touched = false;
      for (const k of ['layer', 'depth'] as const) {
        if (e[k] === undefined) continue;
        const value = e[k];
        const cur = attrs[k];
        const same = cur === value || (value == null && cur === undefined);
        if (same) continue;
        prev[k] = (cur === undefined ? null : cur) as string & number;
        if (value == null || value === '') delete attrs[k];
        else attrs[k] = value;
        touched = true;
        persister.insert('status_history', {
          map_id: mapId,
          node_id: e.id,
          attribute: k,
          old_value: cur == null ? null : String(cur),
          new_value: value == null ? null : String(value),
        });
      }
      if (!touched) continue;
      old.push(prev);
      next[e.id] = { ...n, attrs };
      changed = true;
      persister.upsert('nodes', { id: e.id, map_id: mapId, label: n.label, notes: n.notes, attrs });
    }
    if (changed) set({ nodes: next });
    return old;
  };

  const applyLabel = (id: string, label: string) => {
    const { nodes, mapId } = get();
    const n = nodes[id];
    if (!n || !mapId || n.label === label) return;
    const upd = { ...n, label };
    set({ nodes: { ...nodes, [id]: upd } });
    persister.upsert('nodes', { id, map_id: mapId, label, notes: upd.notes, attrs: upd.attrs });
  };

  const applyNotes = (id: string, notes: string) => {
    const { nodes, mapId } = get();
    const n = nodes[id];
    if (!n || !mapId || n.notes === notes) return;
    const upd = { ...n, notes };
    set({ nodes: { ...nodes, [id]: upd } });
    persister.upsert('nodes', { id, map_id: mapId, label: upd.label, notes, attrs: upd.attrs });
  };

  const applyPositions = (moves: { id: string; x: number; y: number }[], commit: boolean) => {
    const { layouts, mapId } = get();
    if (!mapId || moves.length === 0) return;
    const next = { ...layouts };
    for (const m of moves) {
      next[m.id] = { x: m.x, y: m.y };
      if (commit) persister.upsert('layouts', { node_id: m.id, map_id: mapId, x: m.x, y: m.y });
    }
    set({ layouts: next });
  };

  const applyAddChild = (parentId: string, id: string) => {
    const { nodes, layouts, mapId, expanded } = get();
    const parent = nodes[parentId];
    if (!parent || !mapId) return;
    const node: NodeData = { id, label: 'New node', notes: '', attrs: {}, parentId, childIds: [] };
    const ppos = layouts[parentId] ?? { x: 0, y: 0 };
    const pos = { x: ppos.x + 280, y: ppos.y + parent.childIds.length * 52 };
    set({
      nodes: {
        ...nodes,
        [id]: node,
        [parentId]: { ...parent, childIds: [...parent.childIds, id] },
      },
      layouts: { ...layouts, [id]: pos },
      expanded: { ...expanded, [parentId]: true },
    });
    persister.upsert('nodes', { id, map_id: mapId, label: node.label, notes: '', attrs: {} });
    persister.replaceParentEdge(mapId, id, parentId, parent.childIds.length);
    persister.upsert('layouts', { node_id: id, map_id: mapId, x: pos.x, y: pos.y });
  };

  const applyDeleteNodes = (ids: string[]): RestorePayload | null => {
    const { nodes, layouts, images, crossLinks, selected, expanded, rootIds, mapId } = get();
    if (!mapId) return null;
    const doomed = new Set<string>();
    const roots: string[] = [];
    for (const id of ids) {
      if (!nodes[id] || doomed.has(id)) continue;
      roots.push(id);
      for (const s of subtreeIds(nodes, id)) doomed.add(s);
    }
    if (doomed.size === 0) return null;

    const payload: RestorePayload = {
      nodes: [],
      layouts: {},
      images: {},
      crossLinks: crossLinks.filter((c) => doomed.has(c.source) || doomed.has(c.target)),
      attachments: [],
      rootPositions: [],
      mapId,
    };
    for (const id of doomed) {
      payload.nodes.push(nodes[id]);
      if (layouts[id]) payload.layouts[id] = layouts[id];
      if (images[id]) payload.images[id] = images[id];
    }
    for (const id of roots) {
      const pid = nodes[id].parentId;
      if (pid && !doomed.has(pid)) {
        payload.attachments.push({ childId: id, parentId: pid, index: nodes[pid].childIds.indexOf(id) });
      } else if (!pid) {
        payload.rootPositions.push({ id, index: rootIds.indexOf(id) });
      }
    }

    const nextNodes: Record<string, NodeData> = {};
    for (const [id, n] of Object.entries(nodes)) {
      if (doomed.has(id)) continue;
      nextNodes[id] = n.childIds.some((c) => doomed.has(c))
        ? { ...n, childIds: n.childIds.filter((c) => !doomed.has(c)) }
        : n;
    }
    const nextLayouts = { ...layouts };
    const nextImages = { ...images };
    const nextSelected = { ...selected };
    const nextExpanded = { ...expanded };
    for (const id of doomed) {
      delete nextLayouts[id];
      delete nextImages[id];
      delete nextSelected[id];
      delete nextExpanded[id];
      persister.delete('nodes', id); // DB cascades edges/layouts/images/history
    }
    set({
      nodes: nextNodes,
      layouts: nextLayouts,
      images: nextImages,
      selected: nextSelected,
      expanded: nextExpanded,
      crossLinks: crossLinks.filter((c) => !doomed.has(c.source) && !doomed.has(c.target)),
      rootIds: rootIds.filter((r) => !doomed.has(r)),
      editingNodeId: doomed.has(get().editingNodeId ?? '') ? null : get().editingNodeId,
    });
    return payload;
  };

  const applyRestore = (p: RestorePayload) => {
    const { nodes, layouts, images, crossLinks, rootIds } = get();
    const nextNodes = { ...nodes };
    for (const n of p.nodes) nextNodes[n.id] = n;
    // re-attach subtree roots to surviving parents at their old position
    for (const a of p.attachments) {
      const parent = nextNodes[a.parentId];
      if (!parent) continue;
      const childIds = [...parent.childIds];
      childIds.splice(Math.min(a.index < 0 ? childIds.length : a.index, childIds.length), 0, a.childId);
      nextNodes[a.parentId] = { ...parent, childIds };
    }
    const nextRoots = [...rootIds];
    for (const r of p.rootPositions) {
      nextRoots.splice(Math.min(r.index < 0 ? nextRoots.length : r.index, nextRoots.length), 0, r.id);
    }
    set({
      nodes: nextNodes,
      layouts: { ...layouts, ...p.layouts },
      images: { ...images, ...p.images },
      crossLinks: [...crossLinks, ...p.crossLinks],
      rootIds: nextRoots,
    });
    // persistence: rows back, then edges (nodes must exist first)
    for (const n of p.nodes) {
      persister.upsert('nodes', {
        id: n.id,
        map_id: p.mapId,
        label: n.label,
        notes: n.notes,
        attrs: n.attrs,
      });
      const pos = p.layouts[n.id];
      if (pos) persister.upsert('layouts', { node_id: n.id, map_id: p.mapId, x: pos.x, y: pos.y });
    }
    const restored = new Set(p.nodes.map((n) => n.id));
    for (const n of p.nodes) {
      if (n.parentId && restored.has(n.parentId)) {
        const idx = nextNodes[n.parentId].childIds.indexOf(n.id);
        persister.replaceParentEdge(p.mapId, n.id, n.parentId, idx < 0 ? 0 : idx);
      }
    }
    for (const a of p.attachments) {
      persister.replaceParentEdge(p.mapId, a.childId, a.parentId, a.index < 0 ? 0 : a.index);
    }
    for (const c of p.crossLinks) {
      persister.insert('edges', {
        id: c.id,
        map_id: p.mapId,
        source: c.source,
        target: c.target,
        kind: 'cross',
        link_type: c.linkType,
        sort_order: 0,
      });
    }
    for (const list of Object.values(p.images)) {
      for (const im of list) {
        persister.insert('images', {
          id: im.id,
          map_id: p.mapId,
          node_id: im.nodeId,
          storage_path: im.storagePath,
          thumb_path: im.thumbPath,
          x: im.x,
          y: im.y,
          scale: im.scale,
          width: im.width,
          height: im.height,
        });
      }
    }
  };

  const applyDetach = (childId: string): { parentId: string; index: number } | null => {
    const { nodes, rootIds, mapId } = get();
    const child = nodes[childId];
    if (!child?.parentId || !mapId) return null;
    const parent = nodes[child.parentId];
    const index = parent ? parent.childIds.indexOf(childId) : -1;
    const prev = { parentId: child.parentId, index };
    const nextNodes = { ...nodes, [childId]: { ...child, parentId: null } };
    if (parent) {
      nextNodes[parent.id] = { ...parent, childIds: parent.childIds.filter((c) => c !== childId) };
    }
    set({ nodes: nextNodes, rootIds: [...rootIds, childId] });
    persister.replaceParentEdge(mapId, childId, null);
    return prev;
  };

  const applyAttach = (childId: string, parentId: string, index: number) => {
    const { nodes, rootIds, mapId } = get();
    const child = nodes[childId];
    const parent = nodes[parentId];
    if (!child || !parent || !mapId || child.parentId != null) return;
    // no cycles: parent must not live inside the branch being attached
    if (subtreeIds(nodes, childId).includes(parentId)) return;
    const childIds = [...parent.childIds];
    childIds.splice(Math.min(index < 0 ? childIds.length : index, childIds.length), 0, childId);
    set({
      nodes: {
        ...nodes,
        [childId]: { ...child, parentId },
        [parentId]: { ...parent, childIds },
      },
      rootIds: rootIds.filter((r) => r !== childId),
    });
    persister.replaceParentEdge(mapId, childId, parentId, index < 0 ? 0 : index);
  };

  const applyDeleteCrossLink = (id: string): CrossLink | null => {
    const { crossLinks } = get();
    const link = crossLinks.find((c) => c.id === id);
    if (!link) return null;
    set({ crossLinks: crossLinks.filter((c) => c.id !== id) });
    persister.delete('edges', id);
    return link;
  };

  const applyAddCrossLink = (link: CrossLink) => {
    const { crossLinks, mapId } = get();
    if (!mapId || crossLinks.some((c) => c.id === link.id)) return;
    set({ crossLinks: [...crossLinks, link] });
    persister.insert('edges', {
      id: link.id,
      map_id: mapId,
      source: link.source,
      target: link.target,
      kind: 'cross',
      link_type: link.linkType,
      sort_order: 0,
    });
  };

  const applyAddImage = (image: NodeImage) => {
    const { images, mapId } = get();
    if (!mapId) return;
    if ((images[image.nodeId] ?? []).some((i) => i.id === image.id)) return;
    set({ images: { ...images, [image.nodeId]: [...(images[image.nodeId] ?? []), image] } });
    persister.upsert('images', {
      id: image.id,
      map_id: mapId,
      node_id: image.nodeId,
      storage_path: image.storagePath,
      thumb_path: image.thumbPath,
      x: image.x,
      y: image.y,
      scale: image.scale,
      width: image.width,
      height: image.height,
    });
  };

  const applyRemoveImage = (image: NodeImage) => {
    const { images } = get();
    set({
      images: {
        ...images,
        [image.nodeId]: (images[image.nodeId] ?? []).filter((i) => i.id !== image.id),
      },
    });
    persister.delete('images', image.id);
  };

  const applyDefUpdate = (def: AttributeDef) => {
    const { attrDefs, mapId } = get();
    if (!mapId) return;
    set({ attrDefs: attrDefs.map((d) => (d.id === def.id ? def : d)) });
    persister.upsert('attribute_definitions', {
      id: def.id,
      map_id: mapId,
      name: def.name,
      type: def.type,
      options: def.options,
      config: def.config,
      sort_order: def.sort_order,
    });
  };

  return {
    maps: [],
    mapId: null,
    mapName: '',
    nodes: {},
    rootIds: [],
    crossLinks: [],
    layouts: {},
    attrDefs: [],
    images: {},

    view: 'mindmap',
    overview: false,
    viewport: null,
    expanded: {},
    selected: {},
    editingNodeId: null,
    sorting: false,
    sortingAttr: 'status',
    sortingBranch: false,
    colorMode: 'status',
    focusNodeId: null,
    loading: false,
    loadError: null,
    saveState: 'idle',
    undoStack: [],
    redoStack: [],

    loadMaps: async () => {
      const { data, error } = await supabase
        .from('maps')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        set({ loadError: error.message });
        return;
      }
      set({ maps: (data ?? []) as CosmosMap[] });
    },

    loadMap: async (id: string) => {
      set({ loading: true, loadError: null });
      try {
        const [mapRes, nodeRows, edgeRows, defRows, layoutRows, imageRows] = await Promise.all([
          supabase.from('maps').select('*').eq('id', id).single(),
          fetchAll<NodeRow>('nodes', id),
          fetchAll<EdgeRow>('edges', id),
          fetchAll<AttributeDef & { sort_order: number }>('attribute_definitions', id),
          fetchAll<{ node_id: string; x: number; y: number }>('layouts', id, 'node_id'),
          fetchAll<{
            id: string;
            node_id: string;
            storage_path: string;
            thumb_path: string | null;
            x: number;
            y: number;
            scale: number;
            width: number | null;
            height: number | null;
          }>('images', id),
        ]);
        if (mapRes.error) throw new Error(mapRes.error.message);

        const nodes: Record<string, NodeData> = {};
        for (const r of nodeRows) {
          nodes[r.id] = {
            id: r.id,
            label: r.label,
            notes: r.notes,
            attrs: r.attrs ?? {},
            parentId: null,
            childIds: [],
          };
        }

        const structural = edgeRows
          .filter((e) => e.kind === 'structural')
          .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
        for (const e of structural) {
          const parent = nodes[e.source];
          const child = nodes[e.target];
          if (!parent || !child || child.parentId != null || e.source === e.target) continue;
          child.parentId = e.source;
          parent.childIds.push(e.target);
        }

        const rootIds = Object.values(nodes)
          .filter((n) => n.parentId == null)
          .map((n) => n.id)
          .sort((a, b) => subtreeIds(nodes, b).length - subtreeIds(nodes, a).length);

        const crossLinks: CrossLink[] = edgeRows
          .filter((e) => e.kind === 'cross')
          .map((e) => ({ id: e.id, source: e.source, target: e.target, linkType: e.link_type }));

        const layouts: Record<string, XY> = {};
        for (const l of layoutRows) layouts[l.node_id] = { x: l.x, y: l.y };
        let missing = 0;
        for (const n of Object.values(nodes)) {
          if (!layouts[n.id]) {
            layouts[n.id] = { x: (missing % 40) * 60, y: 300 + Math.floor(missing / 40) * 60 };
            missing++;
          }
        }

        const images: Record<string, NodeImage[]> = {};
        for (const im of imageRows) {
          const list = images[im.node_id] ?? [];
          list.push({
            id: im.id,
            nodeId: im.node_id,
            storagePath: im.storage_path,
            thumbPath: im.thumb_path,
            x: im.x,
            y: im.y,
            scale: im.scale,
            width: im.width,
            height: im.height,
          });
          images[im.node_id] = list;
        }
        for (const list of Object.values(images)) list.sort((a, b) => a.y - b.y);

        const attrDefs = (defRows as AttributeDef[])
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order);

        // one-time migration: layers seeded with muted grays get real hues
        // so cells (and allocated nodes) are tellable apart at a glance
        const layerDef = attrDefs.find((d) => d.name === 'layer');
        if (
          layerDef &&
          layerDef.options.length > 0 &&
          layerDef.options.every((o) => !o.color || LEGACY_LAYER_GRAYS.has(o.color))
        ) {
          layerDef.options = layerDef.options.map((o, i) => ({
            ...o,
            color: LAYER_PALETTE[i % LAYER_PALETTE.length],
          }));
          persister.upsert('attribute_definitions', {
            id: layerDef.id,
            map_id: id,
            name: layerDef.name,
            type: layerDef.type,
            options: layerDef.options,
            config: layerDef.config,
            sort_order: layerDef.sort_order,
          });
        }

        const expanded: Record<string, true> = {};
        for (const r of rootIds) expanded[r] = true;

        const enumDefs = attrDefs.filter((d) => d.type === 'enum');
        const sortingAttr = enumDefs.some((d) => d.name === 'status')
          ? 'status'
          : (enumDefs[0]?.name ?? 'status');

        localStorage.setItem('cosmos:lastMap', id);
        set({
          mapId: id,
          mapName: (mapRes.data as CosmosMap).name,
          nodes,
          rootIds,
          crossLinks,
          layouts,
          attrDefs,
          images,
          expanded,
          selected: {},
          editingNodeId: null,
          loading: false,
          // the galaxy heatmap is the entry point; diving in is one click away
          overview: true,
          viewport: null,
          sorting: false,
          sortingAttr,
          undoStack: [],
          redoStack: [],
          gridOpen: {},
          editingLabelId: null,
        });
      } catch (e) {
        set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
      }
    },

    closeMap: () => {
      void persister.flush();
      localStorage.removeItem('cosmos:lastMap');
      set({
        mapId: null,
        mapName: '',
        nodes: {},
        rootIds: [],
        crossLinks: [],
        layouts: {},
        attrDefs: [],
        images: {},
        expanded: {},
        selected: {},
        viewport: null,
        editingNodeId: null,
        sorting: false,
        undoStack: [],
        redoStack: [],
      });
    },

    renameMap: (name: string) => {
      const { mapId, maps } = get();
      if (!mapId) return;
      set({
        mapName: name,
        maps: maps.map((m) => (m.id === mapId ? { ...m, name } : m)),
      });
      persister.upsert('maps', { id: mapId, name });
    },

    deleteMap: async (id: string) => {
      await persister.flush();
      try {
        const { data: files } = await supabase.storage.from(IMAGE_BUCKET).list(id, { limit: 1000 });
        if (files && files.length > 0) {
          await supabase.storage.from(IMAGE_BUCKET).remove(files.map((f) => `${id}/${f.name}`));
        }
      } catch {
        // orphaned files are harmless; don't block map deletion
      }
      const { error } = await supabase.from('maps').delete().eq('id', id);
      if (error) {
        set({ loadError: error.message });
        return;
      }
      set({ maps: get().maps.filter((m) => m.id !== id) });
      if (get().mapId === id) get().closeMap();
    },

    setAttr: (ids, name, value) => {
      const forward: [string, string | number | null][] = ids.map((id) => [id, value]);
      const old = applyAttrEntries(name, forward);
      if (old.length === 0) return;
      pushUndo({
        label: `Set ${name}`,
        key: ids.length === 1 ? `attr:${name}:${ids[0]}` : null,
        undo: () => runRestoring(() => applyAttrEntries(name, old)),
        redo: () => runRestoring(() => applyAttrEntries(name, forward)),
      });
    },

    // Allocation always applies to whole subtrees: allocating a parent
    // allocates its children with it.
    allocate: (ids, patch) => {
      const { nodes } = get();
      const all = new Set<string>();
      for (const id of ids) for (const s of subtreeIds(nodes, id)) all.add(s);
      const forward = [...all].map((id) => ({ id, ...patch }));
      const old = applyAllocEntries(forward);
      if (old.length === 0) return;
      pushUndo({
        label: 'Allocate',
        key: null,
        undo: () => runRestoring(() => applyAllocEntries(old)),
        redo: () => runRestoring(() => applyAllocEntries(forward)),
      });
    },

    setLabel: (id, label) => {
      const old = get().nodes[id]?.label;
      if (old === undefined || old === label) return;
      applyLabel(id, label);
      pushUndo({
        label: 'Edit label',
        key: `label:${id}`,
        undo: () => runRestoring(() => applyLabel(id, old)),
        redo: () => runRestoring(() => applyLabel(id, label)),
      });
    },

    setNotes: (id, notes) => {
      const old = get().nodes[id]?.notes;
      if (old === undefined || old === notes) return;
      applyNotes(id, notes);
      pushUndo({
        label: 'Edit notes',
        key: `notes:${id}`,
        undo: () => runRestoring(() => applyNotes(id, old)),
        redo: () => runRestoring(() => applyNotes(id, notes)),
      });
    },

    setPositions: (moves, commit) => applyPositions(moves, commit),

    commitPositions: (entries) => {
      const real = entries.filter(
        (e) => Math.abs(e.from.x - e.to.x) > 0.01 || Math.abs(e.from.y - e.to.y) > 0.01,
      );
      if (real.length === 0) return;
      const apply = (dir: 'from' | 'to') =>
        applyPositions(real.map((e) => ({ id: e.id, x: e[dir].x, y: e[dir].y })), true);
      apply('to');
      pushUndo({
        label: 'Move',
        key: null,
        undo: () => runRestoring(() => apply('from')),
        redo: () => runRestoring(() => apply('to')),
      });
    },

    addChild: (parentId) => {
      const id = crypto.randomUUID();
      applyAddChild(parentId, id);
      if (!get().nodes[id]) return '';
      pushUndo({
        label: 'Add node',
        key: null,
        undo: () => runRestoring(() => applyDeleteNodes([id])),
        redo: () => runRestoring(() => applyAddChild(parentId, id)),
      });
      return id;
    },

    deleteNodes: (ids) => {
      const payload = applyDeleteNodes(ids);
      if (!payload) return;
      pushUndo({
        label: 'Delete',
        key: null,
        undo: () => runRestoring(() => applyRestore(payload)),
        redo: () => runRestoring(() => applyDeleteNodes(ids)),
      });
    },

    detachBranch: (childId) => {
      const prev = applyDetach(childId);
      if (!prev) return;
      pushUndo({
        label: 'Detach branch',
        key: null,
        undo: () => runRestoring(() => applyAttach(childId, prev.parentId, prev.index)),
        redo: () => runRestoring(() => applyDetach(childId)),
      });
    },

    deleteCrossLink: (id) => {
      const link = applyDeleteCrossLink(id);
      if (!link) return;
      pushUndo({
        label: 'Delete link',
        key: null,
        undo: () => runRestoring(() => applyAddCrossLink(link)),
        redo: () => runRestoring(() => applyDeleteCrossLink(id)),
      });
    },

    addCrossLink: (source, target) => {
      const { nodes, crossLinks } = get();
      if (source === target || !nodes[source] || !nodes[target]) return;
      if (nodes[target].parentId === source || nodes[source].parentId === target) return;
      if (crossLinks.some((c) => (c.source === source && c.target === target) || (c.source === target && c.target === source))) return;
      const link: CrossLink = { id: crypto.randomUUID(), source, target, linkType: null };
      applyAddCrossLink(link);
      pushUndo({
        label: 'Add link',
        key: null,
        undo: () => runRestoring(() => applyDeleteCrossLink(link.id)),
        redo: () => runRestoring(() => applyAddCrossLink(link)),
      });
    },

    addLabel: (pos) => {
      const { mapId } = get();
      if (!mapId) return '';
      const id = crypto.randomUUID();
      const node: NodeData = {
        id,
        label: 'Label',
        notes: '',
        attrs: { _label: 1 },
        parentId: null,
        childIds: [],
      };
      const apply = () => {
        set({
          nodes: { ...get().nodes, [id]: node },
          rootIds: [...get().rootIds, id],
          layouts: { ...get().layouts, [id]: pos },
        });
        persister.upsert('nodes', { id, map_id: mapId, label: node.label, notes: '', attrs: node.attrs });
        persister.upsert('layouts', { node_id: id, map_id: mapId, x: pos.x, y: pos.y });
      };
      apply();
      pushUndo({
        label: 'Add label',
        key: null,
        undo: () => runRestoring(() => void applyDeleteNodes([id])),
        redo: () => runRestoring(apply),
      });
      return id;
    },

    addEnumOption: (attrName, value, color) => {
      const def = get().attrDefs.find((d) => d.name === attrName);
      if (!def || def.type !== 'enum') return;
      if (def.options.some((o) => o.value === value)) return;
      const next = { ...def, options: [...def.options, { value, color: color ?? '#8b97a3' }] };
      applyDefUpdate(next);
      pushUndo({
        label: 'Add value',
        key: null,
        undo: () => runRestoring(() => applyDefUpdate(def)),
        redo: () => runRestoring(() => applyDefUpdate(next)),
      });
    },

    /** Replace the layer option list; remap moves nodes between values
     *  (rename: old→new; merge: a→b; delete: x→null). One undo entry. */
    setLayerOptions: (options, remap) => {
      const def = get().attrDefs.find((d) => d.name === 'layer');
      if (!def) return;
      const nextDef = { ...def, options };
      const entries: [string, string | number | null][] = [];
      if (remap && Object.keys(remap).length > 0) {
        for (const n of Object.values(get().nodes)) {
          const cur = n.attrs.layer as string | undefined;
          if (cur != null && cur in remap) entries.push([n.id, remap[cur]]);
        }
      }
      const oldEntries = applyAttrEntries('layer', entries);
      applyDefUpdate(nextDef);
      pushUndo({
        label: 'Edit layers',
        key: null,
        undo: () =>
          runRestoring(() => {
            applyDefUpdate(def);
            applyAttrEntries('layer', oldEntries);
          }),
        redo: () =>
          runRestoring(() => {
            applyDefUpdate(nextDef);
            applyAttrEntries('layer', entries);
          }),
      });
    },

    /** Insert an empty depth column at `pos` in ONE layer: that layer's
     *  nodes at depth >= pos shift one step deeper, contents intact. */
    insertLayerDepth: (layer, pos) => {
      const def = get().attrDefs.find((d) => d.name === 'layer');
      if (!def || !def.options.some((o) => o.value === layer)) return;
      const count = layerDepthCount(get().attrDefs, get().nodes, layer);
      const entries: [string, string | number | null][] = [];
      for (const n of Object.values(get().nodes)) {
        if (n.attrs.layer !== layer) continue;
        const v = Number(n.attrs.depth);
        if (Number.isFinite(v) && v >= pos) entries.push([n.id, v + 1]);
      }
      const nextDef = {
        ...def,
        options: def.options.map((o) => (o.value === layer ? { ...o, depths: count + 1 } : o)),
      };
      const old = applyAttrEntries('depth', entries);
      applyDefUpdate(nextDef);
      pushUndo({
        label: 'Insert depth',
        key: null,
        undo: () =>
          runRestoring(() => {
            applyDefUpdate(def);
            applyAttrEntries('depth', old);
          }),
        redo: () =>
          runRestoring(() => {
            applyDefUpdate(nextDef);
            applyAttrEntries('depth', entries);
          }),
      });
    },

    /** Remove an EMPTY depth column from one layer; deeper ones shift left. */
    removeLayerDepth: (layer, pos) => {
      const def = get().attrDefs.find((d) => d.name === 'layer');
      if (!def || !def.options.some((o) => o.value === layer)) return false;
      const occupied = Object.values(get().nodes).some(
        (n) => n.attrs.layer === layer && Number(n.attrs.depth) === pos,
      );
      if (occupied) return false;
      const count = layerDepthCount(get().attrDefs, get().nodes, layer);
      if (count <= 1) return false;
      const entries: [string, string | number | null][] = [];
      for (const n of Object.values(get().nodes)) {
        if (n.attrs.layer !== layer) continue;
        const v = Number(n.attrs.depth);
        if (Number.isFinite(v) && v > pos) entries.push([n.id, v - 1]);
      }
      const nextDef = {
        ...def,
        options: def.options.map((o) => (o.value === layer ? { ...o, depths: count - 1 } : o)),
      };
      const old = applyAttrEntries('depth', entries);
      applyDefUpdate(nextDef);
      pushUndo({
        label: 'Remove depth',
        key: null,
        undo: () =>
          runRestoring(() => {
            applyDefUpdate(def);
            applyAttrEntries('depth', old);
          }),
        redo: () =>
          runRestoring(() => {
            applyDefUpdate(nextDef);
            applyAttrEntries('depth', entries);
          }),
      });
      return true;
    },

    reparent: (childId, newParentId) => {
      const { nodes } = get();
      const child = nodes[childId];
      if (!child || !nodes[newParentId] || childId === newParentId) return;
      if (child.parentId === newParentId) return;
      if (subtreeIds(nodes, childId).includes(newParentId)) return; // no cycles
      const prev = child.parentId
        ? { parentId: child.parentId, index: nodes[child.parentId].childIds.indexOf(childId) }
        : null;
      const moveTo = (target: string, index: number) => {
        if (get().nodes[childId]?.parentId) applyDetach(childId);
        applyAttach(childId, target, index);
        set({ expanded: { ...get().expanded, [target]: true } });
      };
      moveTo(newParentId, -1);
      pushUndo({
        label: 'Reparent',
        key: null,
        undo: () =>
          runRestoring(() => {
            if (prev) moveTo(prev.parentId, prev.index);
            else applyDetach(childId);
          }),
        redo: () => runRestoring(() => moveTo(newParentId, -1)),
      });
    },

    addImage: async (nodeId, file) => {
      const { mapId } = get();
      if (!mapId || !get().nodes[nodeId]) return;
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${mapId}/${crypto.randomUUID()}.${ext || 'png'}`;
      const { error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, file, { contentType: file.type || 'image/png' });
      if (error) {
        set({ loadError: `Image upload failed: ${error.message}` });
        return;
      }
      const dims = await new Promise<{ w: number; h: number } | null>((res) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          res({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => res(null);
        img.src = url;
      });
      const image: NodeImage = {
        id: crypto.randomUUID(),
        nodeId,
        storagePath: path,
        thumbPath: null,
        x: 0,
        y: 0,
        scale: 1,
        width: dims?.w ?? null,
        height: dims?.h ?? null,
      };
      applyAddImage(image);
      pushUndo({
        label: 'Add image',
        key: null,
        undo: () => runRestoring(() => applyRemoveImage(image)),
        redo: () => runRestoring(() => applyAddImage(image)),
      });
    },

    deleteImage: (nodeId, imageId) => {
      const image = (get().images[nodeId] ?? []).find((i) => i.id === imageId);
      if (!image) return;
      applyRemoveImage(image);
      pushUndo({
        label: 'Delete image',
        key: null,
        undo: () => runRestoring(() => applyAddImage(image)),
        redo: () => runRestoring(() => applyRemoveImage(image)),
      });
    },

    undo: () => {
      const { undoStack, redoStack } = get();
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return;
      set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, entry] });
      entry.undo();
    },

    redo: () => {
      const { undoStack, redoStack } = get();
      const entry = redoStack[redoStack.length - 1];
      if (!entry) return;
      set({ redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, entry] });
      entry.redo();
    },

    toggleExpanded: (id) => {
      const expanded = { ...get().expanded };
      if (expanded[id]) delete expanded[id];
      else expanded[id] = true;
      set({ expanded });
    },

    expandPathTo: (id) => {
      const { nodes } = get();
      const expanded = { ...get().expanded };
      let cur = nodes[id]?.parentId;
      while (cur) {
        expanded[cur] = true;
        cur = nodes[cur]?.parentId ?? null;
      }
      set({ expanded });
    },

    // Expand `id` and then descendants breadth-first until the branch would
    // show more than `budget` nodes — keeps the detail view at a sane size.
    expandBranch: (id, budget = 220) => {
      const { nodes } = get();
      const expanded = { ...get().expanded };
      let cur = nodes[id]?.parentId;
      while (cur) {
        expanded[cur] = true;
        cur = nodes[cur]?.parentId ?? null;
      }
      let visible = 1;
      const queue = [id];
      while (queue.length) {
        const nid = queue.shift()!;
        const n = nodes[nid];
        if (!n || n.childIds.length === 0) continue;
        if (visible + n.childIds.length > budget) break;
        expanded[nid] = true;
        visible += n.childIds.length;
        queue.push(...n.childIds);
      }
      set({ expanded });
    },

    collapseAll: () => {
      const expanded: Record<string, true> = {};
      for (const r of get().rootIds) expanded[r] = true;
      set({ expanded });
    },

    // ⌘→ : open every node underneath
    expandAllUnder: (ids) => {
      const { nodes } = get();
      const expanded = { ...get().expanded };
      for (const id of ids) {
        for (const s of subtreeIds(nodes, id)) {
          if (nodes[s].childIds.length > 0) expanded[s] = true;
        }
      }
      set({ expanded });
    },

    // ⌘← : close the node and everything underneath
    collapseAllUnder: (ids) => {
      const { nodes } = get();
      const expanded = { ...get().expanded };
      for (const id of ids) {
        for (const s of subtreeIds(nodes, id)) delete expanded[s];
      }
      set({ expanded });
    },

    // ⌘↑ / ⌘↓ : swap the node with its previous/next sibling
    reorderSibling: (id, dir) => {
      const applyReorder = (nid: string, d: -1 | 1): boolean => {
        const { nodes, mapId } = get();
        const n = nodes[nid];
        if (!n?.parentId || !mapId) return false; // root order isn't persisted
        const parent = nodes[n.parentId];
        const idx = parent.childIds.indexOf(nid);
        const j = idx + d;
        if (idx < 0 || j < 0 || j >= parent.childIds.length) return false;
        const childIds = [...parent.childIds];
        [childIds[idx], childIds[j]] = [childIds[j], childIds[idx]];
        set({ nodes: { ...nodes, [parent.id]: { ...parent, childIds } } });
        persister.replaceParentEdge(mapId, childIds[idx], parent.id, idx);
        persister.replaceParentEdge(mapId, childIds[j], parent.id, j);
        return true;
      };
      if (!applyReorder(id, dir)) return;
      pushUndo({
        label: 'Reorder',
        key: null,
        undo: () => runRestoring(() => void applyReorder(id, -dir as -1 | 1)),
        redo: () => runRestoring(() => void applyReorder(id, dir)),
      });
    },

    setSelected: (ids) => {
      const selected: Record<string, true> = {};
      for (const id of ids) selected[id] = true;
      set({ selected });
    },

    setView: (view) => set({ view }),
    setOverview: (overview) => set({ overview }),
    setViewport: (viewport) => set({ viewport }),
    setEditingNode: (editingNodeId) => set({ editingNodeId }),
    setSorting: (sorting) => set({ sorting }),
    setSortingAttr: (sortingAttr) => set({ sortingAttr }),
    setSortingBranch: (sortingBranch) => set({ sortingBranch }),
    setColorMode: (colorMode) => set({ colorMode }),
    setFocusNode: (focusNodeId) => set({ focusNodeId }),

    gridOpen: {},
    gridSetOpen: (id, open) => set({ gridOpen: { ...get().gridOpen, [id]: open } }),
    gridOpenUnder: (ids, open) => {
      const { nodes } = get();
      const gridOpen = { ...get().gridOpen };
      for (const id of ids) for (const s of subtreeIds(nodes, id)) gridOpen[s] = open;
      set({ gridOpen });
    },
    editingLabelId: null,
    setEditingLabel: (editingLabelId) => set({ editingLabelId }),
  };
});

persister.onState = (saveState) => useMapStore.setState({ saveState });

// dev-only handle for debugging and automated verification
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).cosmos = useMapStore;
}
