import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildOpml } from './opml';
import { buildWorkbook } from './xlsx';
import type { AttributeDef, NodeData } from '../types';

const nodes: Record<string, NodeData> = {
  r: { id: 'r', label: 'Root & <map>', notes: '', attrs: {}, parentId: null, childIds: ['a', 'b'] },
  a: {
    id: 'a',
    label: 'Alpha',
    notes: 'line one\nline two',
    attrs: { status: 'red', depth: 3 },
    parentId: 'r',
    childIds: [],
  },
  b: { id: 'b', label: 'Beta "quoted"', notes: '', attrs: { status: 'green' }, parentId: 'r', childIds: [] },
};

const defs: AttributeDef[] = [
  { id: '1', name: 'status', type: 'enum', options: [], config: {}, sort_order: 0 },
  { id: '2', name: 'depth', type: 'number', options: [], config: {}, sort_order: 1 },
];

describe('buildOpml', () => {
  it('produces well-formed OPML with hierarchy, escaping and baked notes', () => {
    const xml = buildOpml(nodes, ['r'], 'My & Map');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const outlines = doc.getElementsByTagName('outline');
    expect(outlines).toHaveLength(3);
    expect(outlines[0].getAttribute('text')).toBe('Root & <map>');
    expect(outlines[0].children).toHaveLength(2);
    // attrs baked into the first note line, original note preserved below
    expect(outlines[1].getAttribute('_note')).toBe(
      '[cosmos: status=red; depth=3]\nline one\nline two',
    );
    expect(doc.querySelector('head > title')?.textContent).toBe('My & Map');
  });

  it('round-trips attributes through OPML import', async () => {
    const { parseOpml } = await import('../import/opml');
    const xml = buildOpml(nodes, ['r'], 'RT');
    const parsed = parseOpml(xml);
    const alpha = parsed.topics.find((t) => t.label === 'Alpha')!;
    expect(alpha.baked).toEqual({ status: 'red', depth: '3' });
    expect(alpha.note).toBe('line one\nline two'); // tag stripped back out
  });
});

describe('buildWorkbook', () => {
  it('builds a flat sheet with attribute columns in tree order', () => {
    const wb = buildWorkbook(nodes, ['r'], defs);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Nodes']);
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['Label', 'status', 'depth', 'Notes', 'Path']));
    expect(rows[1].Label).toBe('Alpha');
    expect(rows[1].status).toBe('red');
    expect(rows[1].depth).toBe(3);
    expect(rows[1].Path).toBe('Root & <map>');
    expect(rows[2].status).toBe('green');
  });
});
