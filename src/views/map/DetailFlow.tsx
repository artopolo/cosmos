import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  MarkerType,
  type Edge,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { allocationState, subtreeIds, useMapStore, visibleIds } from '../../store/mapStore';
import { cellColor } from '../../lib/colors';
import { optionColor } from '../../lib/attrs';
import { imageUrl } from '../../lib/supabase';
import { tidyLayout, type Size } from '../../lib/layout';
import { STATUS_FILLS, type StatusValue, type XY } from '../../types';
import { CosmosNode, type CosmosFlowNode } from './CosmosNode';

const nodeTypes = { cosmos: CosmosNode };

export interface DropTarget {
  kind: 'sort' | 'cell';
  key: string;
}

export interface DropApi {
  /** hit-test + highlight; pass null to clear the highlight */
  hitAndHot: (pt: { x: number; y: number } | null) => DropTarget | null;
  /** a node (or the selection containing it) was dropped on a target */
  drop: (target: DropTarget, nodeId: string) => void;
}

interface Props {
  dropApi: DropApi | null;
}

export default function DetailFlow(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

function Flow({ dropApi }: Props) {
  const rf = useReactFlow();
  // NOTE: never push store.viewport back into React Flow while mounted —
  // during continuous zooming it snaps the camera to stale positions.
  // External centering goes through focusNodeId instead.

  const nodes = useMapStore((s) => s.nodes);
  const rootIds = useMapStore((s) => s.rootIds);
  const layouts = useMapStore((s) => s.layouts);
  const expanded = useMapStore((s) => s.expanded);
  const selected = useMapStore((s) => s.selected);
  const images = useMapStore((s) => s.images);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const crossLinks = useMapStore((s) => s.crossLinks);
  const sorting = useMapStore((s) => s.sorting);
  const focusNodeId = useMapStore((s) => s.focusNodeId);

  const statusDef = useMemo(() => attrDefs.find((d) => d.name === 'status'), [attrDefs]);
  const layerDef = useMemo(() => attrDefs.find((d) => d.name === 'layer'), [attrDefs]);
  const depthMax = useMemo(() => {
    let max = (attrDefs.find((d) => d.name === 'depth')?.config?.max as number) ?? 5;
    for (const n of Object.values(nodes)) {
      const v = Number(n.attrs.depth);
      if (Number.isFinite(v) && v > max) max = v;
    }
    return max;
  }, [attrDefs, nodes]);

  const visible = useMemo(() => visibleIds(nodes, rootIds, expanded), [nodes, rootIds, expanded]);

  // total descendant count per node (for collapsed badges)
  const descCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const walk = (id: string): number => {
      const n = nodes[id];
      if (!n) return 0;
      let c = 0;
      for (const k of n.childIds) c += 1 + walk(k);
      counts[id] = c;
      return c;
    };
    for (const r of rootIds) walk(r);
    return counts;
  }, [nodes, rootIds]);

  // ---------- auto layout: visible nodes, measured sizes ----------
  const sizesRef = useRef(new Map<string, Size>());
  const [sizesVersion, setSizesVersion] = useState(0);
  const fittedRef = useRef(false);
  // follow the focused node through the measure→relayout settle window
  const focusHold = useRef<{ id: string; until: number } | null>(null);

  useEffect(() => {
    const st = useMapStore.getState();
    const sizeOf = (id: string) => sizesRef.current.get(id) ?? { w: 160, h: 36 };
    // trees anchor at their root's stored position (drag the head, the
    // whole map moves); descendants lay out around it
    const origins: Record<string, XY> = {};
    for (const r of rootIds) {
      const p = st.layouts[r];
      if (p) origins[r] = p;
    }
    const pos = tidyLayout(nodes, rootIds, expanded, sizeOf, origins);
    const moves: { id: string; x: number; y: number }[] = [];
    for (const id of visible) {
      const p = pos[id];
      const cur = st.layouts[id];
      if (!p) continue;
      if (!cur || Math.abs(cur.x - p.x) > 0.5 || Math.abs(cur.y - p.y) > 0.5) {
        moves.push({ id, x: p.x, y: p.y });
      }
    }
    if (moves.length > 0) st.setPositions(moves, false);

    // center on a requested node — and keep re-centering while measured
    // sizes trickle in and shift the layout under it
    if (st.focusNodeId) {
      focusHold.current = { id: st.focusNodeId, until: Date.now() + 1500 };
      st.setFocusNode(null);
    }
    const hold = focusHold.current;
    if (hold && Date.now() >= hold.until) focusHold.current = null;
    if (hold && pos[hold.id] && Date.now() < hold.until) {
      const s = sizeOf(hold.id);
      const cur = rf.getViewport().zoom;
      // instant: an animated center races the measure→relayout settle.
      // keep the user's zoom unless they're too far out to read anything
      void rf.setCenter(pos[hold.id].x + s.w / 2, pos[hold.id].y + s.h / 2, {
        zoom: cur >= 0.4 ? Math.min(cur, 2) : 0.8,
        duration: 0,
      });
      fittedRef.current = true;
    } else if (!fittedRef.current && visible.length > 0) {
      fittedRef.current = true;
      if (!st.viewport) {
        setTimeout(() => void rf.fitView({ padding: 0.15, maxZoom: 1 }), 30);
      }
    }
  }, [visible, nodes, rootIds, expanded, sizesVersion, focusNodeId, rf]);

  const [rfNodes, setRfNodes] = useState<CosmosFlowNode[]>([]);
  // edge selection lives here (edges are derived, so RF can't own it)
  const [edgeSel, setEdgeSel] = useState<Set<string>>(new Set());
  // "holding label +N" chip while dragging a branch
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string; count: number } | null>(null);

  useEffect(() => {
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return visible.map((id) => {
        const n = nodes[id];
        // status → border + halo
        const status = n.attrs.status as StatusValue | undefined;
        const border = status ? optionColor(statusDef, status) : null;
        const halo = status ? (STATUS_FILLS[status] ?? null) : null;
        // allocation cell → fill (the node wears the cell it was dropped into)
        const a = allocationState(n);
        let fill: string | null = null;
        if (a !== 'none') {
          fill = cellColor(
            optionColor(layerDef, n.attrs.layer),
            a === 'xy' ? Number(n.attrs.depth) : null,
            depthMax,
          );
        } else if (n.attrs._noalloc) {
          fill = '#eceef0'; // parked in the "not needed" bin
        }
        const old = prevMap.get(id);
        const node: CosmosFlowNode = {
          id,
          type: 'cosmos',
          position: layouts[id] ?? { x: 0, y: 0 },
          selected: !!selected[id],
          data: {
            label: n.label,
            border,
            halo,
            fill,
            stripe: (n.attrs._smmx_fill as string) || null,
            hasNotes: n.notes.trim().length > 0,
            hasParent: n.parentId != null,
            link: (n.attrs.link as string) || null,
            isLabel: !!n.attrs._label,
            imgs: (images[id] ?? []).map((im) => ({
              url: imageUrl(im.thumbPath ?? im.storagePath),
              w: Math.round(Math.min((im.width ?? 160) * im.scale * 0.55, 230)),
            })),
            childCount: n.childIds.length,
            hiddenCount: descCounts[id] ?? 0,
            isExpanded: !!expanded[id],
          },
        };
        if (old?.measured) node.measured = old.measured;
        return node;
      });
    });
  }, [visible, nodes, layouts, selected, images, statusDef, layerDef, depthMax, expanded, descCounts]);

  const rfEdges = useMemo(() => {
    const vis = new Set(visible);
    const out: Edge[] = [];
    for (const id of visible) {
      const n = nodes[id];
      if (!n.parentId || !vis.has(n.parentId)) continue;
      out.push({
        id: `t-${id}`,
        source: n.parentId,
        target: id,
        sourceHandle: 'sr',
        targetHandle: 'tl',
        type: 'default',
        selected: edgeSel.has(`t-${id}`),
      });
    }
    for (const link of crossLinks) {
      if (!vis.has(link.source) || !vis.has(link.target)) continue;
      const s = layouts[link.source];
      const t = layouts[link.target];
      const rightward = !s || !t || t.x >= s.x;
      out.push({
        id: `c-${link.id}`,
        source: link.source,
        target: link.target,
        sourceHandle: rightward ? 'sr' : 'sl',
        targetHandle: rightward ? 'tl' : 'tr',
        type: 'default',
        className: 'cross-link',
        label: link.linkType ?? undefined,
        selected: edgeSel.has(`c-${link.id}`),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#a9aeb3' },
      });
    }
    return out;
  }, [visible, nodes, layouts, crossLinks, edgeSel]);

  const onNodesChange = useCallback((changes: NodeChange<CosmosFlowNode>[]) => {
    const dims = changes.filter((c) => c.type === 'dimensions');
    if (dims.length > 0) {
      setRfNodes((nds) => applyNodeChanges(dims, nds) as CosmosFlowNode[]);
      let touched = false;
      for (const c of dims) {
        if (c.type !== 'dimensions' || !c.dimensions) continue;
        const cur = sizesRef.current.get(c.id);
        if (!cur || Math.abs(cur.w - c.dimensions.width) > 1 || Math.abs(cur.h - c.dimensions.height) > 1) {
          sizesRef.current.set(c.id, { w: c.dimensions.width, h: c.dimensions.height });
          touched = true;
        }
      }
      if (touched) setSizesVersion((v) => v + 1);
    }
    const st = useMapStore.getState();

    // non-root drags never move the node — a ghost chip follows the pointer
    // instead (no snap-back shake); only tree heads move for real
    if (!dragAnchor.current || dragAnchor.current.isRoot) {
      const moves: { id: string; x: number; y: number }[] = [];
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          moves.push({ id: c.id, x: c.position.x, y: c.position.y });
        }
      }
      if (moves.length > 0) st.setPositions(moves, false);
    }

    const selChanges = changes.filter((c) => c.type === 'select');
    if (selChanges.length > 0) {
      const cur = { ...st.selected };
      for (const c of selChanges) {
        if (c.type !== 'select') continue;
        if (c.selected) cur[c.id] = true;
        else delete cur[c.id];
      }
      st.setSelected(Object.keys(cur));
    }
  }, []);

  // ----- dragging is a gesture: drop on a target, a node, or snap home -----
  // (except tree heads: dragging a root moves its whole tree, live)
  const dragOrigin = useRef<Map<string, XY>>(new Map());
  const dragAnchor = useRef<{ id: string; start: XY; isRoot: boolean } | null>(null);
  const armedNodeRef = useRef<HTMLElement | null>(null);

  const pointOf = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) => {
    const any = e as { clientX?: number; clientY?: number } & {
      touches?: TouchList;
      changedTouches?: TouchList;
    };
    if (typeof any.clientX === 'number' && typeof any.clientY === 'number') {
      return { x: any.clientX, y: any.clientY };
    }
    const t = any.touches?.[0] ?? any.changedTouches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  };

  /** node under the pointer that isn't part of the dragged set —
   *  geometric scan: RF turns node pointer-events off while dragging */
  const nodeUnderPoint = (pt: { x: number; y: number } | null): string | null => {
    if (!pt) return null;
    for (const el of document.querySelectorAll('.react-flow__node')) {
      const id = el.getAttribute('data-id');
      if (!id || dragOrigin.current.has(id)) continue;
      const r = el.getBoundingClientRect();
      if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) return id;
    }
    return null;
  };

  const armNode = (id: string | null) => {
    armedNodeRef.current?.classList.remove('drop-armed');
    armedNodeRef.current = null;
    if (id) {
      const el = document.querySelector(
        `.react-flow__node[data-id="${id}"] .cosmos-node`,
      ) as HTMLElement | null;
      if (el) {
        el.classList.add('drop-armed');
        armedNodeRef.current = el;
      }
    }
  };

  return (
    <>
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_e, node) => {
        const st = useMapStore.getState();
        dragOrigin.current = new Map();
        const isRoot = st.nodes[node.id]?.parentId == null;
        dragAnchor.current = {
          id: node.id,
          start: { ...(st.layouts[node.id] ?? node.position) },
          isRoot,
        };
        // roots carry their entire tree; everything else drags alone/with selection
        const ids = isRoot
          ? subtreeIds(st.nodes, node.id)
          : st.selected[node.id]
            ? Object.keys(st.selected)
            : [node.id];
        for (const id of ids) {
          const p = st.layouts[id];
          if (p) dragOrigin.current.set(id, { ...p });
        }
      }}
      onNodeDrag={(e, node) => {
        const pt = pointOf(e);
        const target = dropApi ? dropApi.hitAndHot(pt) : null;
        // dropping onto another node reparents (not in sorting mode)
        armNode(!target && !sorting ? nodeUnderPoint(pt) : null);
        const anchor = dragAnchor.current;
        // ghost chip: you're holding the node and everything under it
        if (anchor && !anchor.isRoot && pt) {
          const st = useMapStore.getState();
          setDragGhost({
            x: pt.x,
            y: pt.y,
            label: (st.nodes[node.id]?.label ?? '').replace(/\n/g, ' '),
            count: subtreeIds(st.nodes, node.id).length,
          });
        }
        // moving the head moves the whole map, live
        if (anchor?.isRoot && anchor.id === node.id && dragOrigin.current.size > 1) {
          const dx = node.position.x - anchor.start.x;
          const dy = node.position.y - anchor.start.y;
          const st = useMapStore.getState();
          const moves: { id: string; x: number; y: number }[] = [];
          for (const [id, o] of dragOrigin.current) {
            if (id === node.id) continue;
            moves.push({ id, x: o.x + dx, y: o.y + dy });
          }
          if (moves.length > 0) st.setPositions(moves, false);
        }
      }}
      onNodeDragStop={(e, node) => {
        const st = useMapStore.getState();
        const pt = pointOf(e);
        const target = dropApi ? dropApi.hitAndHot(pt) : null;
        dropApi?.hitAndHot(null);
        const nodeTarget = !target && !sorting ? nodeUnderPoint(pt) : null;
        armNode(null);
        setDragGhost(null);
        const anchor = dragAnchor.current;
        dragAnchor.current = null;

        if (anchor?.isRoot && anchor.id === node.id) {
          if (!target && !nodeTarget) {
            // whole tree already followed live — just commit the new anchor
            const to = st.layouts[node.id] ?? anchor.start;
            st.commitPositions([{ id: node.id, from: anchor.start, to }]);
            return;
          }
          // root dropped ON something: put the tree back first
          const restore = [...dragOrigin.current.entries()].map(([id, p]) => ({ id, ...p }));
          if (restore.length > 0) st.setPositions(restore, false);
        }
        // non-root drags never moved anything — nothing to snap back
        if (target) dropApi?.drop(target, node.id);
        else if (nodeTarget) st.reparent(node.id, nodeTarget);
      }}
      onEdgesChange={(changes) => {
        // edges are derived, so selection state is applied here by hand —
        // without this, clicking a link never selects it and Delete is a no-op
        setEdgeSel((prev) => {
          let next: Set<string> | null = null;
          for (const c of changes) {
            if (c.type !== 'select') continue;
            if (!next) next = new Set(prev);
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
          return next ?? prev;
        });
      }}
      onNodesDelete={(deleted) => {
        useMapStore.getState().deleteNodes(deleted.map((n) => n.id));
      }}
      onEdgesDelete={(edges) => {
        const st = useMapStore.getState();
        for (const e of edges) {
          if (e.id.startsWith('t-')) st.detachBranch(e.id.slice(2));
          else if (e.id.startsWith('c-')) st.deleteCrossLink(e.id.slice(2));
        }
      }}
      onMoveStart={(e) => {
        // only a real user gesture cancels auto-centering
        if (e) focusHold.current = null;
      }}
      onMoveEnd={(_e, vp: Viewport) => {
        // viewport is written to the store only when a move ENDS — writing
        // per-frame created a feedback loop that made scrolling jump.
        // No automatic galaxy flip: zooming never changes the view by itself.
        useMapStore.getState().setViewport(vp);
      }}
      defaultViewport={useMapStore.getState().viewport ?? undefined}
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.02}
      maxZoom={2.25}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      panOnDrag
      selectionKeyCode="Shift"
      multiSelectionKeyCode={['Meta', 'Control']}
      deleteKeyCode={sorting ? null : ['Backspace', 'Delete']}
      nodesConnectable
      // native focus scrolls even overflow:hidden containers — that was the
      // "view shifts to the top after dropping on the dock" bug
      nodesFocusable={false}
      edgesFocusable={false}
      connectionRadius={32}
      onConnect={(c) => {
        if (c.source && c.target) useMapStore.getState().addCrossLink(c.source, c.target);
      }}
      nodeDragThreshold={4}
      // cull only on huge expansions: with culling on, panning/zooming mounts
      // new nodes, re-measures them, and the layout shifts under the user
      onlyRenderVisibleElements={visible.length > 800}
      proOptions={{ hideAttribution: false }}
      onPaneClick={() => useMapStore.getState().setSelected([])}
    />
    {dragGhost && (
      <div className="drag-ghost" style={{ left: dragGhost.x + 12, top: dragGhost.y + 10 }}>
        {dragGhost.label}
        {dragGhost.count > 1 ? ` +${dragGhost.count - 1}` : ''}
      </div>
    )}
    </>
  );
}
