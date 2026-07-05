import { supabase } from '../lib/supabase';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface Row {
  [k: string]: unknown;
}

const DEBOUNCE_MS = 700;
const RETRY_MS = 6000;
const FLUSH_AT = 400; // don't let the queue grow unbounded during bulk edits

/** Primary key column per table (upserts conflict on it). */
const PK: Record<string, string> = {
  nodes: 'id',
  layouts: 'node_id',
  maps: 'id',
  edges: 'id',
  attribute_definitions: 'id',
};

/**
 * Write-behind queue: every store mutation enqueues here; batches are flushed
 * to Supabase after a debounce. Single user, no realtime — last write wins.
 */
/** Structural-edge replacement: client doesn't track edge row ids, so the
 *  parent edge of a child is addressed by (target, kind='structural'). */
interface EdgeOp {
  mapId: string;
  childId: string;
  parentId: string | null;
  sortOrder: number;
}

class Persister {
  private upserts = new Map<string, Row>(); // `${table}:${pk}` -> row
  private deletes = new Map<string, Set<string>>(); // table -> ids
  private inserts: { table: string; row: Row }[] = [];
  private edgeOps = new Map<string, EdgeOp>(); // childId -> latest op
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private dirtyWhileFlushing = false;

  onState: (s: SaveState) => void = () => {};

  private get pendingCount() {
    let n = this.upserts.size + this.inserts.length + this.edgeOps.size;
    for (const ids of this.deletes.values()) n += ids.size;
    return n;
  }

  upsert(table: string, row: Row) {
    const pk = PK[table] ?? 'id';
    this.upserts.set(`${table}:${row[pk]}`, { ...row });
    this.schedule();
  }

  delete(table: string, id: string) {
    this.upserts.delete(`${table}:${id}`); // edit-then-delete: delete wins
    let ids = this.deletes.get(table);
    if (!ids) this.deletes.set(table, (ids = new Set()));
    ids.add(id);
    this.schedule();
  }

  insert(table: string, row: Row) {
    this.inserts.push({ table, row });
    this.schedule();
  }

  /** Re-point (or remove, parentId=null) the structural edge into childId. */
  replaceParentEdge(mapId: string, childId: string, parentId: string | null, sortOrder = 0) {
    this.edgeOps.set(childId, { mapId, childId, parentId, sortOrder });
    this.schedule();
  }

  private schedule() {
    this.onState('pending');
    if (this.pendingCount >= FLUSH_AT) {
      void this.flush();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      this.dirtyWhileFlushing = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingCount === 0) return;

    this.flushing = true;
    this.onState('saving');

    // snapshot + clear, so new edits during the flush queue up separately
    const upserts = this.upserts;
    const deletes = this.deletes;
    const inserts = this.inserts;
    const edgeOps = this.edgeOps;
    this.upserts = new Map();
    this.deletes = new Map();
    this.inserts = [];
    this.edgeOps = new Map();

    try {
      const byTable = new Map<string, Row[]>();
      for (const [key, row] of upserts) {
        const table = key.slice(0, key.indexOf(':'));
        const list = byTable.get(table) ?? [];
        list.push(row);
        byTable.set(table, list);
      }
      for (const [table, rows] of byTable) {
        const { error } = await supabase
          .from(table)
          .upsert(rows, { onConflict: PK[table] ?? 'id' });
        if (error) throw new Error(`${table}: ${error.message}`);
      }
      // edge re-pointing runs after node upserts (FK) and before node deletes
      for (const op of edgeOps.values()) {
        const del = await supabase
          .from('edges')
          .delete()
          .eq('target', op.childId)
          .eq('kind', 'structural');
        if (del.error) throw new Error(`edges: ${del.error.message}`);
        if (op.parentId) {
          const ins = await supabase.from('edges').insert({
            map_id: op.mapId,
            source: op.parentId,
            target: op.childId,
            kind: 'structural',
            sort_order: op.sortOrder,
          });
          if (ins.error) throw new Error(`edges: ${ins.error.message}`);
        }
      }
      for (const [table, ids] of deletes) {
        const pk = PK[table] ?? 'id';
        const { error } = await supabase.from(table).delete().in(pk, [...ids]);
        if (error) throw new Error(`${table} delete: ${error.message}`);
      }
      const insByTable = new Map<string, Row[]>();
      for (const { table, row } of inserts) {
        const list = insByTable.get(table) ?? [];
        list.push(row);
        insByTable.set(table, list);
      }
      for (const [table, rows] of insByTable) {
        const { error } = await supabase.from(table).insert(rows);
        if (error) throw new Error(`${table} insert: ${error.message}`);
      }

      this.flushing = false;
      if (this.dirtyWhileFlushing || this.pendingCount > 0) {
        this.dirtyWhileFlushing = false;
        void this.flush();
      } else {
        this.onState('saved');
      }
    } catch (e) {
      console.error('[cosmos] save failed', e);
      // put the failed batch back without clobbering newer edits
      for (const [key, row] of upserts) {
        if (!this.upserts.has(key)) this.upserts.set(key, row);
      }
      for (const [table, ids] of deletes) {
        let cur = this.deletes.get(table);
        if (!cur) this.deletes.set(table, (cur = new Set()));
        for (const id of ids) cur.add(id);
      }
      this.inserts = [...inserts, ...this.inserts];
      for (const [k, v] of edgeOps) {
        if (!this.edgeOps.has(k)) this.edgeOps.set(k, v);
      }
      this.flushing = false;
      this.dirtyWhileFlushing = false;
      this.onState('error');
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => void this.flush(), RETRY_MS);
    }
  }
}

export const persister = new Persister();

// Best-effort flush when the tab goes to background / closes (iPad PWA switch).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void persister.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void persister.flush();
  });
}
