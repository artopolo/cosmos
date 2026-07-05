import { useEffect, useState, type RefObject } from 'react';
import type { AttributeDef } from '../../types';

interface Props {
  def: AttributeDef;
  hot: string | null;
  elsRef: RefObject<Map<string, HTMLElement>>;
}

/**
 * Drop zones for the active enum attribute, generated straight from
 * attribute_definitions — new attributes/values get sorting for free.
 * Chips are visual only (pointer-events: none); DetailFlow hit-tests
 * against the rects registered here.
 */
export default function SortZones({ def, hot, elsRef }: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const values = def.options.map((o) => ({
    v: o.value,
    label: o.label ?? o.value,
    color: o.color ?? '#8b97a3',
  }));

  const left = values.filter((_, i) => i % 2 === 0);
  const right = values.filter((_, i) => i % 2 === 1);

  const measure = (v: string) => (el: HTMLDivElement | null) => {
    if (el) elsRef.current?.set(v, el);
    else elsRef.current?.delete(v);
  };

  const chip = (z: { v: string; label: string; color: string }, style: React.CSSProperties) => (
    <div
      key={z.v}
      ref={measure(z.v)}
      className={`sort-zone${hot === z.v ? ' hot' : ''}`}
      style={style}
    >
      <span className="zone-dot" style={{ background: z.color }} />
      {z.label}
    </div>
  );

  const colStyle = (i: number, n: number, side: 'left' | 'right'): React.CSSProperties => ({
    [side]: 14,
    top: `calc(50% + ${(i - (n - 1) / 2) * 78 - 31}px)`,
    width: 158,
    height: 62,
  });

  return (
    <div className="sort-zones">
      {left.map((z, i) => chip(z, colStyle(i, left.length, 'left')))}
      {right.map((z, i) => chip(z, colStyle(i, right.length, 'right')))}
      {chip(
        { v: '__clear__', label: '✕ clear', color: '#c6cbd1' },
        { left: '50%', transform: 'translateX(-50%)', bottom: 14, width: 158, height: 54 },
      )}
    </div>
  );
}
