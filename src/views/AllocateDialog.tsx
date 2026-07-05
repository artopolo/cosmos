import { useState } from 'react';
import { depthColumnCount, layerDepthCount, useMapStore } from '../store/mapStore';

/** Bulk allocation: pick a layer and/or depth for everything selected
 *  (each selected node's whole subtree comes along). */
export default function AllocateDialog({ onClose }: { onClose: () => void }) {
  const selected = useMapStore((s) => s.selected);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const nodes = useMapStore((s) => s.nodes);

  const layerDef = attrDefs.find((d) => d.name === 'layer');
  const ids = Object.keys(selected);

  // undefined = keep as is, null = clear, value = set
  const [layer, setLayer] = useState<string | null | undefined>(undefined);
  const [depth, setDepth] = useState<number | null | undefined>(undefined);

  // depth range follows the chosen layer (layers can have different depths)
  const cols =
    typeof layer === 'string'
      ? layerDepthCount(attrDefs, nodes, layer)
      : depthColumnCount(attrDefs, nodes);

  const chip = (
    active: boolean,
    label: string,
    onClick: () => void,
    key?: string | number,
  ) => (
    <button key={key ?? label} className={`chip${active ? ' on' : ''}`} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 480 }}>
        <header>Allocate {ids.length} selected (with their branches)</header>
        <div className="modal-body">
          <div>
            <div className="alloc-axis">Layer</div>
            <div className="chip-row">
              {chip(layer === undefined, 'keep as is', () => setLayer(undefined))}
              {chip(layer === null, '— none', () => setLayer(null))}
              {(layerDef?.options ?? []).map((o) =>
                chip(layer === o.value, o.label ?? o.value, () => setLayer(o.value), o.value),
              )}
            </div>
          </div>
          <div>
            <div className="alloc-axis">Depth (1 = shallow … {cols} = deepest)</div>
            <div className="chip-row">
              {chip(depth === undefined, 'keep as is', () => setDepth(undefined))}
              {chip(depth === null, '— none', () => setDepth(null))}
              {Array.from({ length: cols }, (_, i) => i + 1).map((d) =>
                chip(depth === d, String(d), () => setDepth(d), d),
              )}
            </div>
          </div>
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={layer === undefined && depth === undefined}
            onClick={() => {
              const patch: { layer?: string | null; depth?: number | null } = {};
              if (layer !== undefined) patch.layer = layer;
              if (depth !== undefined) patch.depth = depth;
              useMapStore.getState().allocate(ids, patch);
              onClose();
            }}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
