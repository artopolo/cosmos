import type { NodeData } from '../types';

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

/** First note line carrying attrs through SimpleMind and back. */
function bakeLine(n: NodeData): string {
  const pairs = Object.entries(n.attrs)
    .filter(([k, v]) => !k.startsWith('_') && v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  return pairs.length > 0 ? `[cosmos: ${pairs.join('; ')}]` : '';
}

/**
 * OPML export for the road back to SimpleMind: text + notes + hierarchy,
 * with attributes baked into the notes so a re-import restores them.
 */
export function buildOpml(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  name: string,
): string {
  const lines: string[] = [];
  const walk = (id: string, ind: number) => {
    const n = nodes[id];
    if (!n) return;
    const pad = '  '.repeat(ind);
    const label = escAttr(n.label.replace(/\n/g, ' '));
    const noteText = [bakeLine(n), n.notes.trim()].filter(Boolean).join('\n');
    const note = noteText ? ` _note="${escAttr(noteText)}"` : '';
    if (n.childIds.length === 0) {
      lines.push(`${pad}<outline text="${label}"${note}/>`);
    } else {
      lines.push(`${pad}<outline text="${label}"${note}>`);
      for (const c of n.childIds) walk(c, ind + 1);
      lines.push(`${pad}</outline>`);
    }
  };
  for (const r of rootIds) walk(r, 2);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escAttr(name)}</title>`,
    '  </head>',
    '  <body>',
    ...lines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

export function downloadFile(filename: string, content: string | Blob, mime: string) {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
