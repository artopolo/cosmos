import { supabase, IMAGE_BUCKET } from '../lib/supabase';
import { STATUS_COLORS, type Attrs, type StatusValue } from '../types';
import type { ParsedMindmap } from './smmx';

export interface ImportDecisions {
  mapName: string;
  /** color group key -> status value ('' = don't map) */
  colorToStatus: Record<string, StatusValue | ''>;
}

export type ProgressFn = (phase: string, done: number, total: number) => void;

const CHUNK = 400;

async function chunkInsert(
  table: string,
  rows: Record<string, unknown>[],
  phase: string,
  onProgress: ProgressFn,
) {
  onProgress(phase, 0, rows.length);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
    onProgress(phase, Math.min(i + CHUNK, rows.length), rows.length);
  }
}

/** Read dimensions from the PNG IHDR header without decoding the image. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) return null;
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function seedAttributeDefs(mapId: string) {
  return [
    {
      map_id: mapId,
      name: 'layer',
      type: 'enum',
      sort_order: 0,
      options: [
        { value: 'phonetics', color: '#aab4be' },
        { value: 'semantics', color: '#8b97a3' },
        { value: 'grammatics', color: '#6c7a87' },
        { value: 'pragmatics', color: '#4e5d6b' },
      ],
      config: {},
    },
    {
      map_id: mapId,
      name: 'depth',
      type: 'number',
      sort_order: 1,
      options: [],
      config: { min: 1, max: 5 },
    },
    { map_id: mapId, name: 'group', type: 'enum', sort_order: 2, options: [], config: {} },
    {
      map_id: mapId,
      name: 'status',
      type: 'enum',
      sort_order: 3,
      options: [
        { value: 'red', color: STATUS_COLORS.red, label: "Don't know" },
        { value: 'yellow', color: STATUS_COLORS.yellow, label: 'Learning zone' },
        { value: 'green', color: STATUS_COLORS.green, label: 'Know' },
      ],
      config: {},
    },
  ];
}

/**
 * One-way, one-time transfer: parsed mindmap -> new Cosmos map in Supabase.
 * Returns the new map id. On failure the partial map is deleted (cascades).
 */
export async function importParsed(
  parsed: ParsedMindmap,
  decisions: ImportDecisions,
  onProgress: ProgressFn,
): Promise<string> {
  const { data: mapRow, error: mapErr } = await supabase
    .from('maps')
    .insert({ name: decisions.mapName })
    .select()
    .single();
  if (mapErr) throw new Error(`Could not create map: ${mapErr.message}`);
  const mapId = mapRow.id as string;

  try {
    const { error: defErr } = await supabase
      .from('attribute_definitions')
      .insert(seedAttributeDefs(mapId));
    if (defErr) throw new Error(`attribute_definitions failed: ${defErr.message}`);

    // smmx topic id -> Cosmos node uuid
    const idOf = new Map<string, string>();
    for (const t of parsed.topics) idOf.set(t.smmxId, crypto.randomUUID());

    const nodeRows = parsed.topics.map((t) => {
      const attrs: Attrs = {};
      const colorKey = t.fill ?? t.stroke;
      const mapped = colorKey ? decisions.colorToStatus[colorKey] : '';
      if (mapped) attrs.status = mapped;
      // raw source styling kept for fidelity; underscore-prefixed keys are
      // invisible to views (they render attribute_definitions only)
      if (t.fill) attrs._smmx_fill = t.fill;
      if (t.stroke) attrs._smmx_stroke = t.stroke;
      if (t.icon) attrs._smmx_icon = t.icon;
      // attrs baked into notes by a Cosmos export win over color guessing
      for (const [k, v] of Object.entries(t.baked)) {
        if (k.startsWith('_')) continue;
        const num = Number(v);
        attrs[k] = Number.isFinite(num) && v.trim() !== '' && /^\d+(\.\d+)?$/.test(v.trim()) ? num : v;
      }
      return {
        id: idOf.get(t.smmxId),
        map_id: mapId,
        label: t.label,
        notes: t.note,
        attrs,
      };
    });
    await chunkInsert('nodes', nodeRows, 'Nodes', onProgress);

    const siblingIndex = new Map<string, number>();
    const edgeRows: Record<string, unknown>[] = [];
    for (const t of parsed.topics) {
      if (t.parentSmmxId == null) continue;
      const source = idOf.get(t.parentSmmxId);
      const target = idOf.get(t.smmxId);
      if (!source || !target) continue; // orphan: skip edge, node stays as extra root
      const n = siblingIndex.get(t.parentSmmxId) ?? 0;
      siblingIndex.set(t.parentSmmxId, n + 1);
      edgeRows.push({ map_id: mapId, source, target, kind: 'structural', sort_order: n });
    }
    for (const r of parsed.relations) {
      const source = idOf.get(r.source);
      const target = idOf.get(r.target);
      if (!source || !target) continue;
      // sort_order must be present: PostgREST batch inserts null (not the
      // column default) for keys missing from heterogeneous row sets
      edgeRows.push({
        map_id: mapId,
        source,
        target,
        kind: 'cross',
        link_type: r.linkType,
        sort_order: 0,
      });
    }
    await chunkInsert('edges', edgeRows, 'Edges', onProgress);

    const layoutRows = parsed.topics.map((t) => ({
      node_id: idOf.get(t.smmxId),
      map_id: mapId,
      x: t.x,
      y: t.y,
    }));
    await chunkInsert('layouts', layoutRows, 'Positions', onProgress);

    // Upload each distinct file once, then insert per-node placements.
    const usedHashes = new Set<string>();
    for (const t of parsed.topics) {
      for (const img of t.images) {
        if (parsed.files[img.name]) usedHashes.add(img.name);
        if (img.thumb && parsed.files[img.thumb]) usedHashes.add(img.thumb);
      }
    }
    let uploaded = 0;
    onProgress('Images', 0, usedHashes.size);
    for (const hash of usedHashes) {
      const bytes = parsed.files[hash];
      const path = `${mapId}/${hash}.png`;
      const { error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .upload(path, new Blob([bytes as BlobPart], { type: 'image/png' }), {
          contentType: 'image/png',
          upsert: true,
        });
      if (error) throw new Error(`image upload failed: ${error.message}`);
      onProgress('Images', ++uploaded, usedHashes.size);
    }

    const imageRows: Record<string, unknown>[] = [];
    for (const t of parsed.topics) {
      for (const img of t.images) {
        if (!parsed.files[img.name]) continue;
        const size = pngSize(parsed.files[img.name]);
        imageRows.push({
          map_id: mapId,
          node_id: idOf.get(t.smmxId),
          storage_path: `${mapId}/${img.name}.png`,
          thumb_path: img.thumb && parsed.files[img.thumb] ? `${mapId}/${img.thumb}.png` : null,
          x: img.x,
          y: img.y,
          scale: img.scale,
          width: size?.width ?? null,
          height: size?.height ?? null,
        });
      }
    }
    if (imageRows.length > 0) {
      await chunkInsert('images', imageRows, 'Image links', onProgress);
    }

    return mapId;
  } catch (e) {
    // don't leave a half-imported map behind (FK cascades clean up children;
    // storage files must be removed explicitly)
    try {
      const { data: files } = await supabase.storage.from(IMAGE_BUCKET).list(mapId, { limit: 1000 });
      if (files && files.length > 0) {
        await supabase.storage.from(IMAGE_BUCKET).remove(files.map((f) => `${mapId}/${f.name}`));
      }
    } catch {
      // orphaned files are harmless
    }
    await supabase.from('maps').delete().eq('id', mapId);
    throw e;
  }
}
