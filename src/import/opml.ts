import type { ParsedMindmap, ParsedTopic } from './smmx';
import { autoLayout, extractBakedAttrs } from './smmx';

/**
 * Basic OPML tree import: text + notes + hierarchy. Positions are generated
 * with the tidy-tree fallback since OPML carries none.
 */
export function parseOpml(text: string): ParsedMindmap {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Not well-formed OPML');
  }
  const body = doc.getElementsByTagName('body')[0];
  if (!body) throw new Error('OPML has no <body>');

  const title =
    doc.querySelector('head > title')?.textContent?.trim() || 'Imported outline';

  const topics: ParsedTopic[] = [];
  let seq = 0;

  const walk = (el: Element, parentId: string | null) => {
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child.tagName !== 'outline') continue;
      const id = String(seq++);
      const { note, baked } = extractBakedAttrs(
        child.getAttribute('_note') ?? child.getAttribute('note') ?? '',
      );
      topics.push({
        smmxId: id,
        parentSmmxId: parentId,
        label: child.getAttribute('text') ?? '',
        note,
        baked,
        x: 0,
        y: 0,
        hasPosition: false,
        fill: null,
        stroke: null,
        icon: null,
        images: [],
      });
      walk(child, id);
    }
  };
  walk(body, null);

  if (topics.length === 0) throw new Error('OPML contains no outline entries');
  autoLayout(topics);

  return { title, topics, relations: [], files: {}, colorGroups: [] };
}
