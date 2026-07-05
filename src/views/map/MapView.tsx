import { useMemo, useRef, useState } from 'react';
import { subtreeIds, useMapStore } from '../../store/mapStore';
import { patchOfCellKey } from '../../lib/attrs';
import DetailFlow, { type DropApi, type DropTarget } from './DetailFlow';
import OverviewCanvas from './OverviewCanvas';
import SortZones from './SortZones';
import AllocDock from './AllocDock';

export default function MapView({ compact = false }: { compact?: boolean }) {
  const mapId = useMapStore((s) => s.mapId);
  const overview = useMapStore((s) => s.overview);
  const sorting = useMapStore((s) => s.sorting);
  const sortingAttr = useMapStore((s) => s.sortingAttr);
  const attrDefs = useMapStore((s) => s.attrDefs);

  // registries hold elements; rects are measured live at hit-test time
  const zoneEls = useRef(new Map<string, HTMLElement>());
  const dockEls = useRef(new Map<string, HTMLElement>());
  const [hotZone, setHotZone] = useState<string | null>(null);
  const [hotCell, setHotCell] = useState<string | null>(null);

  const sortDef = attrDefs.find((d) => d.name === sortingAttr && d.type === 'enum');
  const sortActive = sorting && !overview && !!sortDef;
  const dockActive = !overview && !sorting && !compact;

  const dropApi = useMemo<DropApi | null>(() => {
    if (overview) return null;
    const inEl = (pt: { x: number; y: number }, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    };
    const hit = (pt: { x: number; y: number } | null): DropTarget | null => {
      if (!pt) return null;
      for (const [key, el] of zoneEls.current) {
        if (inEl(pt, el)) return { kind: 'sort', key };
      }
      for (const [key, el] of dockEls.current) {
        if (inEl(pt, el)) return { kind: 'cell', key };
      }
      return null;
    };
    return {
      hitAndHot: (pt) => {
        const t = hit(pt);
        setHotZone(t?.kind === 'sort' ? t.key : null);
        setHotCell(t?.kind === 'cell' ? t.key : null);
        return t;
      },
      drop: (target, nodeId) => {
        const st = useMapStore.getState();
        const base = st.selected[nodeId] ? Object.keys(st.selected) : [nodeId];
        if (target.kind === 'sort') {
          let ids = base;
          if (st.sortingBranch) {
            const all = new Set<string>();
            for (const id of base) for (const s of subtreeIds(st.nodes, id)) all.add(s);
            ids = [...all];
          }
          st.setAttr(ids, st.sortingAttr, target.key === '__clear__' ? null : target.key);
        } else {
          // allocation always carries the whole branch
          st.allocate(base, patchOfCellKey(target.key));
        }
      },
    };
  }, [overview]);

  return (
    <div className="map-wrap">
      {overview ? (
        <OverviewCanvas key={`ov-${mapId}`} />
      ) : (
        <DetailFlow key={`df-${mapId}`} dropApi={dropApi} />
      )}
      {sortActive && sortDef && <SortZones def={sortDef} hot={hotZone} elsRef={zoneEls} />}
      {dockActive && <AllocDock elsRef={dockEls} hot={hotCell} />}
      <div className="map-hud">
        {overview ? (
          <button
            onClick={() => {
              const st = useMapStore.getState();
              const root = st.rootIds[0];
              if (root) {
                st.expandBranch(root);
                st.setFocusNode(root);
              }
              st.setOverview(false);
            }}
          >
            ◉ Dive in
          </button>
        ) : (
          <>
            <button
              onClick={() => {
                const st = useMapStore.getState();
                st.setViewport(null);
                st.setOverview(true);
              }}
            >
              ✦ Galaxy
            </button>
            <button onClick={() => useMapStore.getState().collapseAll()}>Collapse all</button>
            <button
              title="Add a floating text label"
              onClick={() => {
                const st = useMapStore.getState();
                const vp = st.viewport ?? { x: 0, y: 0, zoom: 1 };
                const id = st.addLabel({
                  x: (window.innerWidth / 2 - vp.x) / vp.zoom,
                  y: (window.innerHeight / 2 - vp.y) / vp.zoom,
                });
                if (id) {
                  st.setSelected([id]);
                  st.setEditingLabel(id);
                }
              }}
            >
              + Label
            </button>
          </>
        )}
        <span className="hint">
          {overview
            ? 'Click a dot to dive in · pinch to zoom'
            : sortActive
              ? `Drag nodes onto a zone to set ${sortingAttr}`
              : '⌘←/→ collapse/expand all · ⌘↑/↓ reorder · drag onto the dock to allocate'}
        </span>
      </div>
    </div>
  );
}
