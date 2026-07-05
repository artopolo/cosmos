import { zipSync } from 'fflate';
import { supabase, IMAGE_BUCKET } from '../lib/supabase';
import { hexToRgb } from '../lib/colors';
import { STATUS_FILLS, type NodeData, type NodeImage, type StatusValue, type XY } from '../types';
import { bakeLine, downloadFile } from './opml';

const escAttr = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Write a real SimpleMind .smmx (zip with document/mindmap.xml + images/).
 * Attributes ride along baked into the notes, so importing back into Cosmos
 * loses nothing.
 */
export async function exportSmmx(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  layouts: Record<string, XY>,
  images: Record<string, NodeImage[]>,
  crossLinks: { source: string; target: string }[],
  mapName: string,
): Promise<void> {
  // sequential integer ids like SimpleMind writes
  const idOf = new Map<string, number>();
  let seq = 0;
  const order: string[] = [];
  const walk = (id: string) => {
    if (!nodes[id]) return;
    idOf.set(id, seq++);
    order.push(id);
    for (const c of nodes[id].childIds) walk(c);
  };
  for (const r of rootIds) walk(r);

  // gather image files referenced by exported nodes
  const files: Record<string, Uint8Array> = {};
  const nameOfPath = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '');
  const paths = new Set<string>();
  for (const id of order) for (const im of images[id] ?? []) paths.add(im.storagePath);
  for (const path of paths) {
    const { data } = await supabase.storage.from(IMAGE_BUCKET).download(path);
    if (data) files[`images/${nameOfPath(path)}.png`] = new Uint8Array(await data.arrayBuffer());
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE simplemind-mindmaps>');
  lines.push('<simplemind-mindmaps doc-version="3" generator="Cosmos" gen-version="1.0">');
  lines.push('  <mindmap>');
  lines.push('    <meta>');
  lines.push(`      <title text="${escAttr(mapName)}"></title>`);
  lines.push(`      <images containsImages="${paths.size > 0}"></images>`);
  lines.push('      <main-centraltheme id="0"></main-centraltheme>');
  lines.push('    </meta>');
  lines.push('    <topics>');
  for (const id of order) {
    const n = nodes[id];
    const p = layouts[id] ?? { x: 0, y: 0 };
    const parent = n.parentId ? (idOf.get(n.parentId) ?? -1) : -1;
    const label = escAttr(n.label.replace(/\n/g, '\\N'));
    // original SimpleMind color wins; otherwise the status shows as a pastel
    const fillHex =
      (n.attrs._smmx_fill as string) ||
      (n.attrs.status ? STATUS_FILLS[n.attrs.status as StatusValue] : null);
    const noteText = [bakeLine(n), n.notes.trim()].filter(Boolean).join('\n');
    const imgs = images[id] ?? [];
    const open = `      <topic id="${idOf.get(id)}" parent="${parent}" x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" text="${label}" textfmt="plain"`;
    if (!noteText && !fillHex && imgs.length === 0) {
      lines.push(`${open}></topic>`);
      continue;
    }
    lines.push(`${open}>`);
    if (noteText) lines.push(`        <note textfmt="plain">${escText(noteText)}</note>`);
    if (fillHex) {
      const [r, g, b] = hexToRgb(fillHex);
      lines.push('        <style>');
      lines.push(`          <fillcolor r="${r}" g="${g}" b="${b}"></fillcolor>`);
      lines.push('        </style>');
    }
    if (imgs.length > 0) {
      lines.push('        <images>');
      for (const im of imgs) {
        lines.push(
          `          <image name="${nameOfPath(im.storagePath)}" x="${im.x}" y="${im.y}" scale="${im.scale}"></image>`,
        );
      }
      lines.push('        </images>');
    }
    lines.push('      </topic>');
  }
  lines.push('    </topics>');
  lines.push('    <relations>');
  for (const c of crossLinks) {
    const s = idOf.get(c.source);
    const t = idOf.get(c.target);
    if (s != null && t != null) lines.push(`      <relation source="${s}" target="${t}"></relation>`);
  }
  lines.push('    </relations>');
  lines.push('  </mindmap>');
  lines.push('</simplemind-mindmaps>');

  files['document/mindmap.xml'] = new TextEncoder().encode('﻿' + lines.join('\n'));
  const zipped = zipSync(files, { level: 6 });
  const safe = (mapName || 'cosmos').replace(/[/\\?%*:|"<>]/g, '-');
  downloadFile(`${safe}.smmx`, new Blob([zipped as unknown as BlobPart]), 'application/octet-stream');
}
