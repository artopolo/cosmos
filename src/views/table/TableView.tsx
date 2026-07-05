import { useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type Row as TRow,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { treeOrder, useMapStore } from '../../store/mapStore';
import { optionColor } from '../../lib/attrs';
import type { AttributeDef, Attrs } from '../../types';

interface Row {
  id: string;
  depth: number;
  path: string;
  label: string;
  notes: string;
  attrs: Attrs;
}

const ROW_H = 38;

function LabelCell({ row, indent }: { row: Row; indent: number }) {
  return (
    <input
      key={`${row.id}:${row.label}`}
      className="cell-input cell-label"
      style={{ paddingLeft: 6 + indent }}
      defaultValue={row.label.replace(/\n/g, ' ')}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v && v !== row.label.replace(/\n/g, ' ')) {
          useMapStore.getState().setLabel(row.id, v);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          (e.target as HTMLInputElement).value = row.label.replace(/\n/g, ' ');
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function EnumCell({ row, def }: { row: Row; def: AttributeDef }) {
  const value = (row.attrs[def.name] as string) ?? '';
  return (
    <span className="enum-cell">
      <span className="dot" style={{ background: optionColor(def, value) }} />
      <select
        value={value}
        onChange={(e) => useMapStore.getState().setAttr([row.id], def.name, e.target.value || null)}
      >
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    </span>
  );
}

function NumberCell({ row, def }: { row: Row; def: AttributeDef }) {
  const value = row.attrs[def.name];
  return (
    <input
      type="number"
      className="cell-input"
      min={def.config?.min}
      max={def.config?.max}
      value={value == null ? '' : Number(value)}
      onChange={(e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        useMapStore.getState().setAttr([row.id], def.name, v);
      }}
    />
  );
}

function TextCell({ row, def }: { row: Row; def: AttributeDef }) {
  const value = (row.attrs[def.name] as string) ?? '';
  return (
    <input
      key={`${row.id}:${value}`}
      className="cell-input"
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== value) {
          useMapStore.getState().setAttr([row.id], def.name, e.target.value || null);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export default function TableView() {
  const nodes = useMapStore((s) => s.nodes);
  const rootIds = useMapStore((s) => s.rootIds);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const selected = useMapStore((s) => s.selected);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [bulkAttr, setBulkAttr] = useState('status');
  const [bulkValue, setBulkValue] = useState('');
  const lastClicked = useRef<number | null>(null);

  const data: Row[] = useMemo(
    () =>
      treeOrder(nodes, rootIds).map(({ id, depth, path }) => ({
        id,
        depth,
        path,
        label: nodes[id].label,
        notes: nodes[id].notes,
        attrs: nodes[id].attrs,
      })),
    [nodes, rootIds],
  );

  const treeOrdered = sorting.length === 0;

  const columns = useMemo(() => {
    const h = createColumnHelper<Row>();
    const cols = [
      h.accessor('label', {
        header: 'Label',
        cell: (info) => (
          <LabelCell row={info.row.original} indent={treeOrdered ? info.row.original.depth * 14 : 0} />
        ),
      }),
      ...attrDefs.map((def) =>
        h.accessor((r) => r.attrs[def.name] ?? undefined, {
          id: def.name,
          header: def.name,
          sortUndefined: 'last' as const,
          filterFn: (row: TRow<Row>, colId: string, filterValue: string) => {
            const v = row.original.attrs[colId];
            if (filterValue === '(unset)') return v == null || v === '';
            return String(v) === filterValue;
          },
          cell: (info) => {
            const row = info.row.original;
            if (def.type === 'enum') return <EnumCell row={row} def={def} />;
            if (def.type === 'number') return <NumberCell row={row} def={def} />;
            return <TextCell row={row} def={def} />;
          },
        }),
      ),
      h.accessor('notes', {
        header: 'Notes',
        cell: (info) => {
          const row = info.row.original;
          const preview = row.notes.replace(/\s+/g, ' ').trim();
          return (
            <button
              className="ghost notes-btn"
              title={preview ? 'Edit notes' : 'Add notes'}
              onClick={() => useMapStore.getState().setEditingNode(row.id)}
            >
              {preview ? (
                <span className="notes-preview">{preview}</span>
              ) : (
                <span className="notes-add">+ note</span>
              )}
            </button>
          );
        },
      }),
      h.accessor('path', {
        header: 'Path',
        cell: (info) => <span className="tree-path">{info.getValue()}</span>,
      }),
    ];
    return cols;
  }, [attrDefs, treeOrdered]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _colId, value: string) => {
      const q = value.toLowerCase();
      const r = row.original;
      return (
        r.label.toLowerCase().includes(q) ||
        r.notes.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  });

  const selectedIds = Object.keys(selected);
  const enumDefs = attrDefs.filter((d) => d.type === 'enum');
  const bulkDef = attrDefs.find((d) => d.name === bulkAttr);

  const toggleRow = (rowIndex: number, id: string, shift: boolean) => {
    const st = useMapStore.getState();
    const cur = { ...st.selected };
    if (shift && lastClicked.current != null) {
      const [a, b] = [Math.min(lastClicked.current, rowIndex), Math.max(lastClicked.current, rowIndex)];
      for (let i = a; i <= b; i++) cur[rows[i].original.id] = true;
    } else if (cur[id]) {
      delete cur[id];
    } else {
      cur[id] = true;
    }
    lastClicked.current = rowIndex;
    st.setSelected(Object.keys(cur));
  };

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected[r.original.id]);

  const colWidth = (colId: string): string => {
    if (colId === 'label') return 'minmax(260px, 1.4fr)';
    if (colId === 'notes') return 'minmax(150px, 1fr)';
    if (colId === 'path') return 'minmax(180px, 1fr)';
    return '128px';
  };
  const gridTemplate = `34px ${table
    .getFlatHeaders()
    .map((hd) => colWidth(hd.column.id))
    .join(' ')}`;

  return (
    <div className="table-wrap">
      <div className="table-controls">
        <input
          type="search"
          placeholder="Search label, notes, path…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />
        {enumDefs.map((def) => {
          const filter = (columnFilters.find((f) => f.id === def.name)?.value as string) ?? '';
          return (
            <label key={def.name} className="filter-label">
              {def.name}
              <select
                value={filter}
                onChange={(e) => {
                  const v = e.target.value;
                  setColumnFilters((prev) => {
                    const rest = prev.filter((f) => f.id !== def.name);
                    return v ? [...rest, { id: def.name, value: v }] : rest;
                  });
                }}
              >
                <option value="">all</option>
                <option value="(unset)">unset</option>
                {def.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label ?? o.value}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        <span className="spacer" />
        <span className="row-count">
          {rows.length} of {data.length} nodes
        </span>
      </div>

      {selectedIds.length > 0 && (
        <div className="bulk-bar">
          <b>{selectedIds.length} selected</b>
          <span>set</span>
          <select value={bulkAttr} onChange={(e) => { setBulkAttr(e.target.value); setBulkValue(''); }}>
            {attrDefs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          <span>to</span>
          {bulkDef?.type === 'enum' ? (
            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}>
              <option value="">— clear —</option>
              {bulkDef.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label ?? o.value}
                </option>
              ))}
            </select>
          ) : bulkDef?.type === 'number' ? (
            <input
              type="number"
              min={bulkDef.config?.min}
              max={bulkDef.config?.max}
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              style={{ width: 70 }}
            />
          ) : (
            <input value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} />
          )}
          <button
            onClick={() => {
              const v =
                bulkValue === ''
                  ? null
                  : bulkDef?.type === 'number'
                    ? Number(bulkValue)
                    : bulkValue;
              useMapStore.getState().setAttr(selectedIds, bulkAttr, v);
            }}
          >
            Apply
          </button>
          <button
            className="ghost"
            onClick={() => {
              if (confirm(`Delete ${selectedIds.length} node(s) and their subtrees?`)) {
                useMapStore.getState().deleteNodes(selectedIds);
              }
            }}
          >
            Delete
          </button>
          <button className="ghost" onClick={() => useMapStore.getState().setSelected([])}>
            Clear
          </button>
        </div>
      )}

      <div className="table-scroll" ref={scrollRef}>
        <div className="t-head" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="t-cell t-check">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() =>
                useMapStore
                  .getState()
                  .setSelected(allVisibleSelected ? [] : rows.map((r) => r.original.id))
              }
            />
          </div>
          {table.getFlatHeaders().map((header) => (
            <div
              key={header.id}
              className="t-cell t-head-cell"
              onClick={header.column.getToggleSortingHandler()}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
              {{ asc: ' ↑', desc: ' ↓' }[header.column.getIsSorted() as string] ?? ''}
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const r = row.original;
            return (
              <div
                key={r.id}
                className={`t-row${selected[r.id] ? ' row-selected' : ''}`}
                style={{
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${vi.start}px)`,
                  height: ROW_H,
                }}
              >
                <div className="t-cell t-check">
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onClick={(e) => toggleRow(vi.index, r.id, e.shiftKey)}
                    onChange={() => {}}
                  />
                </div>
                {row.getVisibleCells().map((cell) => (
                  <div key={cell.id} className="t-cell">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
