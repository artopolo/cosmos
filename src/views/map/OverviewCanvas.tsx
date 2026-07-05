import { useEffect, useMemo, useRef, useState } from 'react';
import { allocationState, depthColumnCount, useMapStore } from '../../store/mapStore';
import { optionColor } from '../../lib/attrs';
import { cellColor } from '../../lib/colors';
import { fullLayout } from '../../lib/layout';
import { UNSET_DOT, type Viewport } from '../../types';

const DOT_SCREEN_PX = 3.1;

interface GestureEventLike extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export default function OverviewCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodes = useMapStore((s) => s.nodes);
  const rootIds = useMapStore((s) => s.rootIds);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const selected = useMapStore((s) => s.selected);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null);

  const layerDef = useMemo(() => attrDefs.find((d) => d.name === 'layer'), [attrDefs]);
  const depthMax = useMemo(() => depthColumnCount(attrDefs, nodes), [attrDefs, nodes]);

  // the galaxy has its own stable coordinate space: the fully-expanded tree
  const layouts = useMemo(() => fullLayout(nodes, rootIds), [nodes, rootIds]);

  // dots wear the same cell colors as the Map view
  const dots = useMemo(() => {
    return Object.values(nodes).map((n) => {
      const p = layouts[n.id] ?? { x: 0, y: 0 };
      const a = allocationState(n);
      const color =
        a !== 'none'
          ? cellColor(
              optionColor(layerDef, n.attrs.layer),
              a === 'xy' ? Number(n.attrs.depth) : null,
              depthMax,
            )
          : n.attrs._noalloc
            ? '#dfe2e5'
            : UNSET_DOT;
      return {
        id: n.id,
        x: p.x,
        y: p.y,
        color,
        label: n.label.replace(/\n/g, ' '),
      };
    });
  }, [nodes, layouts, layerDef, depthMax]);

  // head-node names drawn next to their dots
  const rootLabels = useMemo(
    () =>
      rootIds
        .filter((r) => nodes[r] && !nodes[r].attrs._label)
        .map((r) => ({
          x: layouts[r]?.x ?? 0,
          y: layouts[r]?.y ?? 0,
          text: nodes[r].label.replace(/\n/g, ' ').slice(0, 48),
        })),
    [rootIds, nodes, layouts],
  );

  const lines = useMemo(() => {
    const out: number[] = []; // x1,y1,x2,y2 quads
    for (const n of Object.values(nodes)) {
      if (!n.parentId) continue;
      const a = layouts[n.parentId];
      const b = layouts[n.id];
      if (!a || !b) continue;
      out.push(a.x, a.y, b.x, b.y);
    }
    return out;
  }, [nodes, layouts]);

  const byColor = useMemo(() => {
    const groups = new Map<string, typeof dots>();
    for (const d of dots) {
      const g = groups.get(d.color) ?? [];
      g.push(d);
      groups.set(d.color, g);
    }
    return groups;
  }, [dots]);

  // viewport lives in a ref so pan/zoom never re-renders React.
  // starts null: the galaxy always fits the whole map when it appears —
  // a stale camera here used to show a blank white screen
  const vpRef = useRef<Viewport | null>(null);
  const rafRef = useRef(0);
  const divingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;

    const fit = (): Viewport => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (dots.length === 0) return { x: w / 2, y: h / 2, zoom: 0.1 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const d of dots) {
        if (d.x < minX) minX = d.x;
        if (d.y < minY) minY = d.y;
        if (d.x > maxX) maxX = d.x;
        if (d.y > maxY) maxY = d.y;
      }
      const bw = Math.max(maxX - minX, 1);
      const bh = Math.max(maxY - minY, 1);
      const zoom = Math.min(w / bw, h / bh) * 0.88;
      return {
        x: w / 2 - ((minX + maxX) / 2) * zoom,
        y: h / 2 - ((minY + maxY) / 2) * zoom,
        zoom: Math.max(zoom, 0.015),
      };
    };

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return; // not laid out yet — resize observer will retry
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      if (!vpRef.current) {
        vpRef.current = fit();
        useMapStore.getState().setViewport(vpRef.current);
      }
      const vp = vpRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(vp.zoom * dpr, 0, 0, vp.zoom * dpr, vp.x * dpr, vp.y * dpr);

      // structural edges: faint texture that shows the tree's shape
      if (lines.length > 0) {
        ctx.beginPath();
        for (let i = 0; i < lines.length; i += 4) {
          ctx.moveTo(lines[i], lines[i + 1]);
          ctx.lineTo(lines[i + 2], lines[i + 3]);
        }
        ctx.strokeStyle = 'rgba(70, 76, 82, 0.11)';
        ctx.lineWidth = 1 / vp.zoom;
        ctx.stroke();
      }

      const r = DOT_SCREEN_PX / vp.zoom;
      for (const [color, group] of byColor) {
        ctx.beginPath();
        for (const d of group) {
          ctx.moveTo(d.x + r, d.y);
          ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = color;
        ctx.fill();
      }

      // head-node names (constant screen size)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '600 12.5px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#1c1e21';
      for (const rl of rootLabels) {
        ctx.fillText(rl.text, rl.x * vp.zoom + vp.x + 9, rl.y * vp.zoom + vp.y - 7);
      }
      ctx.setTransform(vp.zoom * dpr, 0, 0, vp.zoom * dpr, vp.x * dpr, vp.y * dpr);

      // selection rings
      const selIds = Object.keys(selected);
      if (selIds.length > 0) {
        ctx.beginPath();
        const rr = r + 2.5 / vp.zoom;
        for (const d of dots) {
          if (!selected[d.id]) continue;
          ctx.moveTo(d.x + rr, d.y);
          ctx.arc(d.x, d.y, rr, 0, Math.PI * 2);
        }
        ctx.strokeStyle = '#1c1e21';
        ctx.lineWidth = 1.6 / vp.zoom;
        ctx.stroke();
      }
    };

    const schedule = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    };

    schedule();

    const commitViewport = () => {
      if (vpRef.current) useMapStore.getState().setViewport({ ...vpRef.current });
    };

    const nearestDot = (sx: number, sy: number, maxScreenDist: number) => {
      if (!vpRef.current) return null;
      const vp = vpRef.current;
      const wx = (sx - vp.x) / vp.zoom;
      const wy = (sy - vp.y) / vp.zoom;
      const maxW = maxScreenDist / vp.zoom;
      let best: (typeof dots)[number] | null = null;
      let bestD = maxW * maxW;
      for (const d of dots) {
        const dx = d.x - wx;
        const dy = d.y - wy;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = d;
        }
      }
      return best;
    };

    const dive = (nodeId: string) => {
      if (divingRef.current) return;
      divingRef.current = true;
      const st = useMapStore.getState();
      st.expandBranch(nodeId);
      st.setFocusNode(nodeId); // detail view centers on it after layout
      st.setViewport(null);
      st.setOverview(false);
    };


    const zoomAt = (sx: number, sy: number, factor: number) => {
      if (!vpRef.current) return;
      const vp = vpRef.current;
      const zoom = Math.min(Math.max(vp.zoom * factor, 0.008), 1.4);
      const wx = (sx - vp.x) / vp.zoom;
      const wy = (sy - vp.y) / vp.zoom;
      vpRef.current = { zoom, x: sx - wx * zoom, y: sy - wy * zoom };
      schedule();
      commitViewport();
    };

    // ---- pointer pan + touch pinch ----
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch0: { dist: number; zoom: number } | null = null;
    let moved = false;
    let gestureActive = false;

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch0 = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: vpRef.current!.zoom };
      }
      canvas.classList.add('grabbing');
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!pointers.has(e.pointerId)) {
        // hover tooltip
        const hit = nearestDot(e.clientX - rect.left, e.clientY - rect.top, 12);
        setTooltip(
          hit
            ? {
                x: (hit.x * vpRef.current!.zoom + vpRef.current!.x),
                y: (hit.y * vpRef.current!.zoom + vpRef.current!.y),
                label: hit.label,
              }
            : null,
        );
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        return;
      }
      if (gestureActive || !vpRef.current) return;
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 1) moved = true;

      if (pointers.size === 1) {
        vpRef.current = {
          ...vpRef.current!,
          x: vpRef.current!.x + (e.clientX - prev.x),
          y: vpRef.current!.y + (e.clientY - prev.y),
        };
        schedule();
      } else if (pointers.size === 2 && pinch0) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        const factor = (pinch0.zoom * (dist / pinch0.dist)) / vpRef.current!.zoom;
        zoomAt(mid.x, mid.y, factor);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch0 = null;
      if (pointers.size === 0) {
        canvas.classList.remove('grabbing');
        commitViewport();
        if (!moved) {
          const hit = nearestDot(e.clientX - rect.left, e.clientY - rect.top, 14);
          if (hit) dive(hit.id);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!vpRef.current) return;
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // iPadOS/Chrome trackpad pinch arrives as ctrl+wheel
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0021));
      } else {
        vpRef.current = {
          ...vpRef.current!,
          x: vpRef.current!.x - e.deltaX,
          y: vpRef.current!.y - e.deltaY,
        };
        schedule();
        commitViewport();
      }
    };

    // macOS Safari trackpad pinch: proprietary gesture events
    let gestureZoom0 = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureActive = true;
      gestureZoom0 = vpRef.current?.zoom ?? 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!vpRef.current) return;
      const ge = e as GestureEventLike;
      const rect = canvas.getBoundingClientRect();
      const target = gestureZoom0 * ge.scale;
      zoomAt(ge.clientX - rect.left, ge.clientY - rect.top, target / vpRef.current!.zoom);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureActive = false;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGestureStart as EventListener);
    canvas.addEventListener('gesturechange', onGestureChange as EventListener);
    canvas.addEventListener('gestureend', onGestureEnd as EventListener);

    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGestureStart as EventListener);
      canvas.removeEventListener('gesturechange', onGestureChange as EventListener);
      canvas.removeEventListener('gestureend', onGestureEnd as EventListener);
      ro.disconnect();
    };
  }, [dots, lines, byColor, selected]);

  return (
    <>
      <canvas ref={canvasRef} className="overview-canvas" />
      {tooltip && (
        <div className="overview-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </>
  );
}
