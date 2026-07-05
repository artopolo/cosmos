import { unzipSync } from 'fflate';
import { rgbToHex, suggestStatus } from '../lib/colors';
import type { StatusValue } from '../types';

export interface ParsedImagePlacement {
  /** content hash — file lives at images/<name>.png in the archive */
  name: string;
  thumb: string | null;
  x: number;
  y: number;
  scale: number;
}

export interface ParsedTopic {
  smmxId: string;
  parentSmmxId: string | null;
  label: string;
  note: string;
  /** attrs baked into the note's first line by a Cosmos export (round-trip) */
  baked: Record<string, string>;
  x: number;
  y: number;
  hasPosition: boolean;
  fill: string | null;
  stroke: string | null;
  icon: string | null;
  images: ParsedImagePlacement[];
}

export interface ParsedRelation {
  source: string;
  target: string;
  linkType: string | null;
}

export interface ColorGroup {
  /** group key = fill hex (or stroke when no fill) */
  color: string;
  stroke: string | null;
  count: number;
  suggested: StatusValue | null;
  samples: string[];
}

export interface ParsedMindmap {
  title: string;
  topics: ParsedTopic[];
  relations: ParsedRelation[];
  /** content hash -> png bytes */
  files: Record<string, Uint8Array>;
  colorGroups: ColorGroup[];
}

const BAKED_RE = /^\[cosmos:\s*([^\]]*)\]\s*\n*/;

/**
 * Cosmos exports bake attributes into the first note line
 * (`[cosmos: layer=semantics; depth=3; status=red]`) so allocations survive
 * a round-trip through SimpleMind. Reading strips the tag back out.
 */
export function extractBakedAttrs(note: string): { note: string; baked: Record<string, string> } {
  const m = note.match(BAKED_RE);
  if (!m) return { note, baked: {} };
  const baked: Record<string, string> = {};
  for (const pair of m[1].split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (k && v) baked[k] = v;
    }
  }
  return { note: note.slice(m[0].length), baked };
}

function childrenByTag(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.tagName === tag) out.push(c);
  }
  return out;
}

function num(el: Element, attr: string, fallback = 0): number {
  const v = Number(el.getAttribute(attr));
  return Number.isFinite(v) ? v : fallback;
}

function colorOf(topic: Element, tag: 'fillcolor' | 'strokecolor'): string | null {
  // SimpleMind duplicates these both as direct children and inside <style>
  let el = childrenByTag(topic, tag)[0];
  if (!el) {
    const style = childrenByTag(topic, 'style')[0];
    if (style) el = childrenByTag(style, tag)[0];
  }
  if (!el) return null;
  const r = Number(el.getAttribute('r'));
  const g = Number(el.getAttribute('g'));
  const b = Number(el.getAttribute('b'));
  if (![r, g, b].every(Number.isFinite)) return null;
  return rgbToHex(r, g, b);
}

/**
 * A topic's note content comes from two places: its own <note> child, and
 * floating text callouts (<children><text><note>). Both are user-authored
 * annotations, so they are concatenated into the node's notes field.
 */
function noteOf(topic: Element): string {
  const parts: string[] = [];
  const direct = childrenByTag(topic, 'note')[0];
  if (direct?.textContent) parts.push(direct.textContent.trim());
  const childrenEl = childrenByTag(topic, 'children')[0];
  if (childrenEl) {
    for (const textEl of childrenByTag(childrenEl, 'text')) {
      const n = childrenByTag(textEl, 'note')[0];
      if (n?.textContent) parts.push(n.textContent.trim());
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function imagesOf(topic: Element): ParsedImagePlacement[] {
  const seen = new Set<string>();
  const out: ParsedImagePlacement[] = [];
  const collect = (imgEl: Element) => {
    const name = imgEl.getAttribute('name');
    if (!name) return;
    const x = num(imgEl, 'x');
    const y = num(imgEl, 'y');
    const key = `${name}|${x}|${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, thumb: imgEl.getAttribute('thumbnail'), x, y, scale: num(imgEl, 'scale', 1) });
  };
  // <images> is the canonical list, <children> duplicates it — read both, dedupe.
  const imagesBlock = childrenByTag(topic, 'images')[0];
  if (imagesBlock) childrenByTag(imagesBlock, 'image').forEach(collect);
  const childrenEl = childrenByTag(topic, 'children')[0];
  if (childrenEl) childrenByTag(childrenEl, 'image').forEach(collect);
  return out;
}

export function parseSmmxXml(xml: string): Omit<ParsedMindmap, 'files'> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('mindmap.xml is not well-formed XML');
  }

  const titleEl = doc.querySelector('meta > title');
  const title = titleEl?.getAttribute('text')?.trim() || 'Imported map';

  const topics: ParsedTopic[] = [];
  for (const t of Array.from(doc.getElementsByTagName('topic'))) {
    const id = t.getAttribute('id');
    if (id == null) continue;
    const parent = t.getAttribute('parent');
    const rawText = t.getAttribute('text') ?? '';
    const { note, baked } = extractBakedAttrs(noteOf(t));
    topics.push({
      smmxId: id,
      parentSmmxId: parent == null || parent === '-1' ? null : parent,
      // SimpleMind encodes line breaks in labels as literal \N
      label: rawText.replace(/\\N/g, '\n'),
      note,
      baked,
      x: num(t, 'x'),
      y: num(t, 'y'),
      hasPosition: t.hasAttribute('x') && t.hasAttribute('y'),
      fill: colorOf(t, 'fillcolor'),
      stroke: colorOf(t, 'strokecolor'),
      icon: t.getAttribute('icon'),
      images: imagesOf(t),
    });
  }

  const relations: ParsedRelation[] = [];
  for (const r of Array.from(doc.getElementsByTagName('relation'))) {
    const source = r.getAttribute('source') ?? r.getAttribute('from');
    const target = r.getAttribute('target') ?? r.getAttribute('to');
    if (source == null || target == null) continue;
    relations.push({ source, target, linkType: r.getAttribute('text') || r.getAttribute('type') });
  }

  return { title, topics, relations, colorGroups: buildColorGroups(topics) };
}

function buildColorGroups(topics: ParsedTopic[]): ColorGroup[] {
  const groups = new Map<string, ColorGroup>();
  for (const t of topics) {
    const key = t.fill ?? t.stroke;
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        color: key,
        stroke: t.stroke,
        count: 0,
        suggested: suggestStatus(t.fill, t.stroke),
        samples: [],
      };
      groups.set(key, g);
    }
    g.count++;
    if (g.samples.length < 3 && t.label) g.samples.push(t.label.replace(/\n/g, ' '));
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

export function parseSmmx(bytes: Uint8Array): ParsedMindmap {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('Not a valid .smmx file (zip archive expected)');
  }

  const xmlPath = Object.keys(entries).find((p) => p.endsWith('mindmap.xml'));
  if (!xmlPath) throw new Error('Not a SimpleMind file: document/mindmap.xml missing');

  // TextDecoder with default options strips the UTF-8 BOM SimpleMind writes.
  const xml = new TextDecoder('utf-8').decode(entries[xmlPath]);
  const parsed = parseSmmxXml(xml);

  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    const m = path.match(/(?:^|\/)images\/([^/]+)\.png$/i);
    if (m) files[m[1]] = data;
  }

  return { ...parsed, files };
}

/**
 * Tidy-tree fallback layout for imports without positions (OPML).
 * Leaves get consecutive rows; internal nodes center on their children.
 */
export function autoLayout(topics: ParsedTopic[]): void {
  const byId = new Map(topics.map((t) => [t.smmxId, t]));
  const children = new Map<string, ParsedTopic[]>();
  const roots: ParsedTopic[] = [];
  for (const t of topics) {
    if (t.parentSmmxId != null && byId.has(t.parentSmmxId)) {
      const list = children.get(t.parentSmmxId) ?? [];
      list.push(t);
      children.set(t.parentSmmxId, list);
    } else {
      roots.push(t);
    }
  }
  const ROW = 52;
  const COL = 340;
  let nextRow = 0;
  const place = (t: ParsedTopic, depth: number): number => {
    const kids = children.get(t.smmxId) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = nextRow++ * ROW;
    } else {
      const ys = kids.map((k) => place(k, depth + 1));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    t.x = depth * COL;
    t.y = y;
    t.hasPosition = true;
    return y;
  };
  for (const r of roots) {
    place(r, 0);
    nextRow += 2; // gap between root clusters
  }
}
