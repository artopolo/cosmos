import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSmmx } from './smmx';
import { parseOpml } from './opml';

// The real SimpleMind file this app is built against (vitest cwd = project root).
const fixture = join(process.cwd(), 'test-fixtures/Test.smmx');
const bytes = new Uint8Array(readFileSync(fixture));
const parsed = parseSmmx(bytes);
const byId = new Map(parsed.topics.map((t) => [t.smmxId, t]));

describe('parseSmmx on real SimpleMind file', () => {
  it('reads the map title from meta', () => {
    expect(parsed.title).toBe('Архитектура');
  });

  it('parses all 124 topics with hierarchy intact', () => {
    expect(parsed.topics).toHaveLength(124);
    const root = byId.get('0')!;
    expect(root.parentSmmxId).toBeNull();
    expect(root.label).toBe('Архитектура');
    // every non-root parent must exist
    for (const t of parsed.topics) {
      if (t.parentSmmxId != null) expect(byId.has(t.parentSmmxId)).toBe(true);
    }
  });

  it('converts \\N label line breaks to newlines', () => {
    expect(byId.get('10')!.label).toBe('Схлопываем в\nузлы смысла');
  });

  it('preserves positions', () => {
    const t = byId.get('33')!;
    expect(t.x).toBeCloseTo(841.05);
    expect(t.y).toBeCloseTo(-557.17);
    expect(parsed.topics.every((x) => x.hasPosition)).toBe(true);
  });

  it('captures direct <note> children', () => {
    expect(byId.get('46')!.note).toContain('personalized emails');
    expect(byId.get('71')!.note).toContain('вытягивания');
  });

  it('captures floating text callouts as notes', () => {
    expect(byId.get('0')!.note).toContain('The mistake we make');
    expect(byId.get('10')!.note).toContain('Смотрим какие гипотезы');
  });

  it('parses image placements with thumbnails and dedupes children/images blocks', () => {
    const t11 = byId.get('11')!;
    expect(t11.images).toHaveLength(2);
    expect(t11.images[0].name).toBe('a3d9148db1041b4327f727dc3c00a81d31856391');
    expect(t11.images[0].thumb).toBe('0b02b32c34ca59df1b0f2a9be1ab0f2611c59e3b');
    expect(t11.images[0].scale).toBeCloseTo(1.67);

    const t10 = byId.get('10')!;
    expect(t10.images).toHaveLength(1); // duplicated in children + images blocks

    const total = parsed.topics.reduce((n, t) => n + t.images.length, 0);
    expect(total).toBe(16);
  });

  it('extracts all embedded PNG files', () => {
    expect(Object.keys(parsed.files)).toHaveLength(20);
    // every referenced image + thumbnail resolves to a file in the archive
    for (const t of parsed.topics) {
      for (const img of t.images) {
        expect(parsed.files[img.name]).toBeDefined();
        if (img.thumb) expect(parsed.files[img.thumb]).toBeDefined();
      }
    }
  });

  it('reads topic colors and suggests statuses', () => {
    const t33 = byId.get('33')!; // salmon red fill
    expect(t33.fill).toBe('#ed6c59');
    expect(t33.stroke).toBe('#000000');

    const g33 = parsed.colorGroups.find((g) => g.color === '#ed6c59')!;
    expect(g33.suggested).toBe('red');

    const g93 = parsed.colorGroups.find((g) => g.color === '#badc94')!;
    expect(g93.suggested).toBe('green');

    const g103 = parsed.colorGroups.find((g) => g.color === '#ffffc5')!;
    expect(g103.suggested).toBe('yellow');

    // pale green fill with saturated green stroke -> falls back to stroke
    const g102 = parsed.colorGroups.find((g) => g.color === '#ccfdd4')!;
    expect(g102.suggested).toBe('green');
  });

  it('finds no cross-links in this file (relations block is empty)', () => {
    expect(parsed.relations).toHaveLength(0);
  });
});

describe('parseOpml', () => {
  it('imports a basic outline with notes and generates a layout', () => {
    const opml = `<?xml version="1.0"?>
      <opml version="2.0">
        <head><title>Test</title></head>
        <body>
          <outline text="Root">
            <outline text="A" _note="note a"/>
            <outline text="B"><outline text="B1"/></outline>
          </outline>
        </body>
      </opml>`;
    const p = parseOpml(opml);
    expect(p.title).toBe('Test');
    expect(p.topics).toHaveLength(4);
    expect(p.topics[1].note).toBe('note a');
    expect(p.topics[3].parentSmmxId).toBe(p.topics[2].smmxId);
    // layout generated: children sit to the right of parents
    expect(p.topics[3].x).toBeGreaterThan(p.topics[2].x);
  });
});
