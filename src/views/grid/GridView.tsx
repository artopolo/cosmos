import { useEffect, useMemo, useRef, useState } from 'react';
import { layerDepthCount, useMapStore } from '../../store/mapStore';
import { optionColor, patchOfCellKey } from '../../lib/attrs';
import { cellColor, tint, LAYER_PALETTE } from '../../lib/colors';
import type { NodeData } from '../../types';

/** cell key: `${layer}|${depth}` ('' = unset); '!' = the "not needed" bin */
const cellOf = (n: NodeData) =>
  n.attrs._noalloc ? '!' : `${(n.attrs.layer as string) ?? ''}|${n.attrs.depth ?? ''}`;

interface DragState {
  ids: string[];
  label: string;
  count: number;
  x: number;
  y: number;
  started: boolean;
  over: string | null;
}

interface PressInfo {
  x: number;
  y: number;
  id: string;
  label: string;
  additive: boolean;
}

type MenuState =
  | { layer: string; mode: 'menu' | 'merge' | 'rename' | 'insert-above' | 'insert-below' | 'remove' }
  | null;

const ROW_CAP = 50;

export default function GridView() {
  const nodes = useMapStore((s) => s.nodes);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const selected = useMapStore((s) => s.selected);
  const gridOpen = useMapStore((s) => s.gridOpen);

  const statusDef = useMemo(() => attrDefs.find((d) => d.name === 'status'), [attrDefs]);
  const layerDef = useMemo(() => attrDefs.find((d) => d.name === 'layer'), [attrDefs]);

  const layerColor = (value: string) =>
    layerDef?.options.find((o) => o.value === value)?.color ?? '#8b97a3';

  const layers = useMemo(() => {
    const listed = (layerDef?.options ?? []).map((o) => o.value);
    const extra = new Set<string>();
    for (const n of Object.values(nodes)) {
      const v = n.attrs.layer as string | undefined;
      if (v && !listed.includes(v)) extra.add(v);
    }
    return [...listed, ...extra];
  }, [layerDef, nodes]);

  /** allocation-region roots per cell */
  const buckets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const n of Object.values(nodes)) {
      const cell = cellOf(n);
      const parent = n.parentId ? nodes[n.parentId] : null;
      if (parent && cellOf(parent) === cell) continue;
      const list = map.get(cell) ?? [];
      list.push(n.id);
      map.set(cell, list);
    }
    return map;
  }, [nodes]);

  const cellEmpty = (key: string) => (buckets.get(key)?.length ?? 0) === 0;

  /** same-cell children — the part of the branch living in this cell */
  const cellKids = (id: string, cellKey: string) =>
    (nodes[id]?.childIds ?? []).filter((c) => nodes[c] && cellOf(nodes[c]) === cellKey);

  const inCellCount = (id: string, cellKey: string): number => {
    let count = 0;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const m = nodes[cur];
      if (!m || cellOf(m) !== cellKey) continue;
      count++;
      stack.push(...m.childIds);
    }
    return count;
  };

  const isOpen = (id: string, isRegionRoot: boolean) => gridOpen[id] ?? isRegionRoot;

  // ---------- drag & drop (any row is draggable) ----------
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const downAt = useRef<PressInfo | null>(null);
  const [caps, setCaps] = useState<Record<string, number>>({});

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const down = downAt.current;
      if (!down) return;
      let d = dragRef.current;
      if (!d) {
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return;
        const st = useMapStore.getState();
        const ids = st.selected[down.id] ? Object.keys(st.selected) : [down.id];
        d = { ids, label: down.label, count: ids.length, x: e.clientX, y: e.clientY, started: true, over: null };
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el?.closest?.('[data-cell]') as HTMLElement | null;
      d = { ...d, x: e.clientX, y: e.clientY, over: cell?.dataset.cell ?? null };
      dragRef.current = d;
      setDrag(d);
    };
    const onUp = () => {
      const d = dragRef.current;
      const down = downAt.current;
      downAt.current = null;
      dragRef.current = null;
      setDrag(null);
      const st = useMapStore.getState();
      if (d?.started) {
        if (d.over != null) st.allocate(d.ids, patchOfCellKey(d.over));
      } else if (down) {
        // click: replace the selection; ⌘/⇧-click adds or removes
        if (down.additive) {
          const cur = { ...st.selected };
          if (cur[down.id]) delete cur[down.id];
          else cur[down.id] = true;
          st.setSelected(Object.keys(cur));
        } else {
          st.setSelected(st.selected[down.id] && Object.keys(st.selected).length === 1 ? [] : [down.id]);
        }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const jumpTo = (id: string) => {
    const st = useMapStore.getState();
    st.expandBranch(id);
    st.setSelected([id]);
    st.setFocusNode(id);
    st.setViewport(null);
    st.setOverview(false);
    st.setView('mindmap');
  };

  // ---------- mini tree rendering ----------
  const renderTree = (regionRoot: string, cellKey: string) => {
    const capKey = `${cellKey}:${regionRoot}`;
    const cap = caps[capKey] ?? ROW_CAP;
    const rows: React.ReactElement[] = [];
    let skipped = 0;
    let shown = 0;

    const walk = (id: string, depth: number) => {
      const n = nodes[id];
      if (!n) return;
      if (rows.length >= cap) {
        skipped += inCellCount(id, cellKey);
        return;
      }
      const kids = cellKids(id, cellKey);
      const opened = isOpen(id, id === regionRoot);
      const hidden = kids.length > 0 && !opened ? inCellCount(id, cellKey) - 1 : 0;
      shown++;
      rows.push(
        <div
          key={id}
          className={`mt-row${selected[id] ? ' sel' : ''}`}
          style={{ paddingLeft: depth * 15 }}
        >
          {kids.length > 0 ? (
            <button
              className="mt-arrow"
              title={opened ? 'Collapse (⌘←)' : `Open ${hidden} nodes (⌘→)`}
              onClick={(e) => {
                e.stopPropagation();
                useMapStore.getState().gridSetOpen(id, !opened);
              }}
            >
              {opened ? '▼' : '▶'}
            </button>
          ) : (
            <span className="mt-arrow-spacer" />
          )}
          <span
            className="mt-pill"
            title={`${n.label.replace(/\n/g, ' ')} · drag to another cell · double-click to locate`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest('.mt-open')) return;
              e.preventDefault();
              downAt.current = {
                x: e.clientX,
                y: e.clientY,
                id,
                label: n.label.replace(/\n/g, ' '),
                additive: e.metaKey || e.ctrlKey || e.shiftKey,
              };
            }}
            onDoubleClick={() => jumpTo(id)}
          >
            <span className="dot" style={{ background: optionColor(statusDef, n.attrs.status) }} />
            <span className="mt-label">{n.label.replace(/\n/g, ' ') || '…'}</span>
            {hidden > 0 && <span className="alloc-count">{hidden}</span>}
            <button
              className="mt-open"
              title="Notes, photos & attributes"
              onClick={(e) => {
                e.stopPropagation();
                useMapStore.getState().setEditingNode(id);
              }}
            >
              ≡
            </button>
          </span>
        </div>,
      );
      if (opened) for (const c of kids) walk(c, depth + 1);
    };
    walk(regionRoot, 0);
    const total = inCellCount(regionRoot, cellKey);

    return (
      <div key={regionRoot} className="mini-tree">
        <div className="mt-tools">
          <button
            className="mt-arrow"
            title="Open the whole tree (⌘→)"
            onClick={() => useMapStore.getState().gridOpenUnder([regionRoot], true)}
          >
            ⊞
          </button>
          <button
            className="mt-arrow"
            title="Close the whole tree (⌘←)"
            onClick={() => useMapStore.getState().gridOpenUnder([regionRoot], false)}
          >
            ⊟
          </button>
          <span className="mt-info" title="shown / total nodes in this cell">
            {shown}/{total}
          </span>
        </div>
        {rows}
        {skipped > 0 && (
          <button
            className="ghost mini mt-more"
            onClick={() => setCaps((c) => ({ ...c, [capKey]: cap + 300 }))}
          >
            … {skipped} more
          </button>
        )}
      </div>
    );
  };

  const cellContent = (key: string) => (buckets.get(key) ?? []).map((id) => renderTree(id, key));
  const hot = (key: string) => (drag?.over === key ? ' hot' : '');

  // ---------- layer row menu (inline editors — no browser dialogs) ----------
  const [menu, setMenu] = useState<MenuState>(null);
  const [addingLayer, setAddingLayer] = useState(false);

  const nextColor = () =>
    LAYER_PALETTE.find((c) => !(layerDef?.options ?? []).some((o) => o.color === c)) ?? '#8b97a3';

  const options = () => layerDef?.options ?? [];

  const layerOps = {
    rename: (value: string, name: string) => {
      if (!name || name === value || layers.includes(name)) return;
      const opts = options().map((o) => (o.value === value ? { ...o, value: name, label: undefined } : o));
      useMapStore.getState().setLayerOptions(opts, { [value]: name });
    },
    insert: (value: string, offset: 0 | 1, name: string) => {
      if (!name || layers.includes(name)) return;
      const opts = [...options()];
      const idx = opts.findIndex((o) => o.value === value);
      opts.splice((idx < 0 ? opts.length : idx) + offset, 0, { value: name, color: nextColor() });
      useMapStore.getState().setLayerOptions(opts);
    },
    merge: (from: string, into: string) => {
      useMapStore.getState().setLayerOptions(
        options().filter((o) => o.value !== from),
        { [from]: into },
      );
    },
    remove: (value: string) => {
      useMapStore.getState().setLayerOptions(
        options().filter((o) => o.value !== value),
        { [value]: null },
      );
    },
    add: (name: string) => {
      if (!name || layers.includes(name)) return;
      useMapStore.getState().setLayerOptions([...options(), { value: name, color: nextColor() }]);
    },
  };

  const nameInput = (placeholder: string, onCommit: (v: string) => void) => (
    <input
      autoFocus
      placeholder={placeholder}
      className="menu-input"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          onCommit((e.target as HTMLInputElement).value.trim());
          setMenu(null);
          setAddingLayer(false);
        }
        if (e.key === 'Escape') {
          setMenu(null);
          setAddingLayer(false);
        }
      }}
    />
  );

  const layerHeader = (value: string) => {
    const m = menu?.layer === value ? menu : null;
    const usedCount = Object.values(nodes).filter((n) => n.attrs.layer === value).length;
    return (
      <div className="layer-head">
        <span
          className="layer-name layer-chip"
          style={{ background: tint(layerColor(value), 0.18), borderColor: layerColor(value) }}
        >
          {value}
        </span>
        <button
          className="ghost mini"
          onClick={() => setMenu(m ? null : { layer: value, mode: 'menu' })}
        >
          ⋯
        </button>
        {m && (
          <div className="menu layer-menu">
            {m.mode === 'menu' && (
              <>
                <button
                  onClick={() => {
                    useMapStore.getState().moveLayer(value, -1);
                    setMenu(null);
                  }}
                >
                  ↑ Move up
                </button>
                <button
                  onClick={() => {
                    useMapStore.getState().moveLayer(value, 1);
                    setMenu(null);
                  }}
                >
                  ↓ Move down
                </button>
                <div className="menu-sep" />
                <button onClick={() => setMenu({ layer: value, mode: 'rename' })}>Rename</button>
                <button onClick={() => setMenu({ layer: value, mode: 'insert-above' })}>
                  Insert layer above
                </button>
                <button onClick={() => setMenu({ layer: value, mode: 'insert-below' })}>
                  Insert layer below
                </button>
                <button onClick={() => setMenu({ layer: value, mode: 'merge' })}>Merge into…</button>
                <div className="menu-sep" />
                <button
                  style={{ color: 'var(--status-red)' }}
                  onClick={() => {
                    if (usedCount === 0) {
                      layerOps.remove(value);
                      setMenu(null);
                    } else {
                      setMenu({ layer: value, mode: 'remove' });
                    }
                  }}
                >
                  Remove layer
                </button>
              </>
            )}
            {m.mode === 'rename' && nameInput(`rename “${value}”…`, (v) => layerOps.rename(value, v))}
            {m.mode === 'insert-above' && nameInput('new layer name…', (v) => layerOps.insert(value, 0, v))}
            {m.mode === 'insert-below' && nameInput('new layer name…', (v) => layerOps.insert(value, 1, v))}
            {m.mode === 'merge' && (
              <>
                <div className="menu-title">Merge “{value}” into…</div>
                {layers
                  .filter((l) => l !== value)
                  .map((l) => (
                    <button
                      key={l}
                      onClick={() => {
                        layerOps.merge(value, l);
                        setMenu(null);
                      }}
                    >
                      {l}
                    </button>
                  ))}
                <button onClick={() => setMenu({ layer: value, mode: 'menu' })}>← back</button>
              </>
            )}
            {m.mode === 'remove' && (
              <>
                <div className="menu-title">
                  {usedCount} node{usedCount === 1 ? '' : 's'} will be un-allocated.
                </div>
                <button
                  style={{ color: 'var(--status-red)' }}
                  onClick={() => {
                    layerOps.remove(value);
                    setMenu(null);
                  }}
                >
                  Remove anyway
                </button>
                <button onClick={() => setMenu({ layer: value, mode: 'menu' })}>← back</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const selCount = Object.keys(selected).length;
  const st = useMapStore.getState;

  return (
    <div
      className="grid-wrap"
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest('.layer-menu, .mini, .menu-input')) setMenu(null);
      }}
    >
      <div className="grid-hint">
        Live trees: ▶ opens branches (⌘←/⌘→ on a selection, ⌘↑/⌘↓ reorders) · drag any part into a
        cell or the allocator · click selects{selCount > 0 ? ` (${selCount})` : ''}, ⌘/⇧-click adds
        · double-click locates in the mind map
      </div>

      {/* ---- section 1: what's waiting + where to drop it ---- */}
      <div className="alloc-section">
        <section className="grid-section">
          <h3>Unallocated</h3>
          <div className={`cell tray${hot('|')}`} data-cell="|">
            {cellContent('|')}
          </div>
        </section>
        <section className="grid-section dock-col">
          <h3>Drop to allocate</h3>
          <div className="grid-dock">
            {layers.map((l) => {
              const cols = layerDepthCount(attrDefs, nodes, l);
              const color = layerColor(l);
              return (
                <div key={l} className="dock-layer">
                  <div
                    className={`dock-chip dock-layer-chip${hot(`${l}|`) ? ' hot' : ''}`}
                    data-cell={`${l}|`}
                    style={{ background: tint(color, 0.16), borderColor: color }}
                  >
                    {l}
                  </div>
                  <div className="dock-cells">
                    {Array.from({ length: cols }, (_, i) => i + 1).map((d) => (
                      <div
                        key={d}
                        className={`dock-chip dock-cell${hot(`${l}|${d}`) ? ' hot' : ''}`}
                        data-cell={`${l}|${d}`}
                        title={`${l} · depth ${d}`}
                        style={{ background: cellColor(color, d, cols), borderColor: color }}
                      >
                        {d}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className={`dock-chip dock-clear${hot('!') ? ' hot' : ''}`} data-cell="!">
              ∅ not needed
            </div>
          </div>
        </section>
      </div>

      {/* ---- section 2: the big map ---- */}
      <section className="grid-section">
        <h3>Layers × depth (1 = shallow, deeper right)</h3>
        <div className="layer-table">
          {layers.map((l) => {
            const cols = layerDepthCount(attrDefs, nodes, l);
            return (
              <div key={l} className="depth-cells">
                {/* layer label + controls live inside the first ("—") cell */}
                <div
                  className={`cell no-depth${hot(`${l}|`)}`}
                  data-cell={`${l}|`}
                  title={`${l} — has the layer, waiting for a depth`}
                  style={{ background: tint(layerColor(l), 0.07) }}
                >
                  <div className="cell-layer-head">{layerHeader(l)}</div>
                  {cellContent(`${l}|`)}
                </div>
                {Array.from({ length: cols }, (_, i) => i + 1).map((d) => {
                  const key = `${l}|${d}`;
                  return (
                    <div
                      key={key}
                      className={`cell${hot(key)}`}
                      data-cell={key}
                      style={{ background: tint(cellColor(layerColor(l), d, cols), 0.35) }}
                    >
                      <span className="cell-num">
                        <button
                          className="ghost micro"
                          title={`Insert an empty depth before ${d} in “${l}” (its ${d}+ shifts right)`}
                          onClick={() => st().insertLayerDepth(l, d)}
                        >
                          +
                        </button>
                        {d > 1 && (
                          <button
                            className="ghost micro"
                            title={`Swap with depth ${d - 1} (contents move)`}
                            onClick={() => st().swapLayerDepths(l, d - 1)}
                          >
                            ‹
                          </button>
                        )}
                        {d}
                        {d < cols && (
                          <button
                            className="ghost micro"
                            title={`Swap with depth ${d + 1} (contents move)`}
                            onClick={() => st().swapLayerDepths(l, d)}
                          >
                            ›
                          </button>
                        )}
                        {cellEmpty(key) && cols > 1 && (
                          <button
                            className="ghost micro"
                            title="Remove this empty depth"
                            onClick={() => st().removeLayerDepth(l, d)}
                          >
                            ×
                          </button>
                        )}
                      </span>
                      {cellContent(key)}
                    </div>
                  );
                })}
                <button
                  className="ghost add-depth"
                  title={`Add a depth column to “${l}”`}
                  onClick={() => st().insertLayerDepth(l, cols + 1)}
                >
                  +
                </button>
              </div>
            );
          })}

          {/* "not needed" is the lowest layer of the map */}
          <div className="depth-cells">
            <div
              className={`cell skip-tray${hot('!')}`}
              data-cell="!"
              style={{ flex: 1 }}
              title="Parked here — never asks for allocation. Already-allocated parts of a dropped branch keep their cells."
            >
              <div className="cell-layer-head">
                <span className="layer-name layer-chip skip-chip">∅ not needed</span>
              </div>
              {cellContent('!')}
            </div>
          </div>

          {addingLayer ? (
            <div className="add-layer-input">{nameInput('new layer name…', layerOps.add)}</div>
          ) : (
            <button className="ghost add-layer" onClick={() => setAddingLayer(true)}>
              + Add layer
            </button>
          )}
        </div>
      </section>

      {drag?.started && (
        <div className="drag-ghost" style={{ left: drag.x + 10, top: drag.y + 8 }}>
          {drag.label}
          {drag.count > 1 ? ` +${drag.count - 1}` : ''}
        </div>
      )}
    </div>
  );
}
