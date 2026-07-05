import { useEffect, useState, type RefObject } from 'react';
import { layerDepthCount, useMapStore } from '../../store/mapStore';
import { cellColor, tint } from '../../lib/colors';

interface Props {
  elsRef: RefObject<Map<string, HTMLElement>>;
  hot: string | null;
}

/**
 * Right-side allocation dock in the mind map: every layer with its depth
 * cells. Drag a node onto a cell — the node (with its whole branch) is
 * allocated there and snaps back home. Chips register their rects; the
 * flow hit-tests them on drop.
 */
export default function AllocDock({ elsRef, hot }: Props) {
  const attrDefs = useMapStore((s) => s.attrDefs);
  const nodes = useMapStore((s) => s.nodes);
  const [collapsed, setCollapsed] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const layerDef = attrDefs.find((d) => d.name === 'layer');

  const measure = (key: string) => (el: HTMLElement | null) => {
    if (el) elsRef.current?.set(key, el);
    else elsRef.current?.delete(key);
  };

  useEffect(() => {
    // dock collapse changes what's registered
    if (collapsed) elsRef.current?.clear();
    setTick((t) => t + 1);
  }, [collapsed, elsRef]);

  if (collapsed) {
    return (
      <button className="dock-tab" onClick={() => setCollapsed(false)} title="Allocation dock">
        ◧
      </button>
    );
  }

  return (
    <div className="alloc-dock">
      <header>
        <span>Drop to allocate</span>
        <button className="ghost mini" onClick={() => setCollapsed(true)}>
          ✕
        </button>
      </header>
      {(layerDef?.options ?? []).map((o) => {
        const color = o.color ?? '#8b97a3';
        const layerKey = `${o.value}|`;
        const cols = layerDepthCount(attrDefs, nodes, o.value);
        return (
          <div key={o.value} className="dock-layer">
            <div
              ref={measure(layerKey)}
              className={`dock-chip dock-layer-chip${hot === layerKey ? ' hot' : ''}`}
              style={{ background: tint(color, 0.16), borderColor: color }}
            >
              {o.label ?? o.value}
            </div>
            <div className="dock-cells">
              {Array.from({ length: cols }, (_, i) => i + 1).map((d) => {
                const key = `${o.value}|${d}`;
                return (
                  <div
                    key={key}
                    ref={measure(key)}
                    className={`dock-chip dock-cell${hot === key ? ' hot' : ''}`}
                    style={{ background: cellColor(color, d, cols), borderColor: color }}
                    title={`${o.value} · depth ${d}`}
                  >
                    {d}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div
        ref={measure('|')}
        className={`dock-chip dock-clear${hot === '|' ? ' hot' : ''}`}
      >
        ✕ un-allocate
      </div>
    </div>
  );
}
