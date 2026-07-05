import { useEffect, useRef, useState } from 'react';
import { useMapStore } from '../store/mapStore';
import { buildOpml, downloadFile } from '../export/opml';
import { exportXlsx } from '../export/xlsx';
import { exportSmmx } from '../export/smmx';
import Logo from './Logo';

const UndoIcon = ({ flip = false }: { flip?: boolean }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    style={flip ? { transform: 'scaleX(-1)' } : undefined}
  >
    <path
      d="M6.7 2.8 3.2 6l3.5 3.2M3.6 6h6a3.4 3.4 0 0 1 0 6.8H7.2"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const VIEW_LABEL = { mindmap: 'Mind map', map: 'Map' } as const;

const SAVE_LABEL: Record<string, string> = {
  idle: '',
  pending: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

export default function Toolbar({ onImport }: { onImport: () => void }) {
  const mapId = useMapStore((s) => s.mapId);
  const mapName = useMapStore((s) => s.mapName);
  const view = useMapStore((s) => s.view);
  const sorting = useMapStore((s) => s.sorting);
  const sortingAttr = useMapStore((s) => s.sortingAttr);
  const sortingBranch = useMapStore((s) => s.sortingBranch);
  const attrDefs = useMapStore((s) => s.attrDefs);
  const saveState = useMapStore((s) => s.saveState);
  const canUndo = useMapStore((s) => s.undoStack.length > 0);
  const canRedo = useMapStore((s) => s.redoStack.length > 0);

  const [exportOpen, setExportOpen] = useState(false);
  const [addingValue, setAddingValue] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [exportOpen]);

  const st = useMapStore.getState;
  const enumDefs = attrDefs.filter((d) => d.type === 'enum');
  const mindmapVisible = view === 'mindmap';

  return (
    <div className="toolbar">
      <span className="brand" onClick={() => st().closeMap()} title="All maps">
        <Logo /> Cosmos
      </span>

      {mapId && (
        <>
          <input
            className="map-name"
            value={mapName}
            onChange={(e) => st().renameMap(e.target.value)}
          />
          <div className="seg">
            {(['mindmap', 'map'] as const).map((v) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => st().setView(v)}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <button
            className="ghost icon-btn"
            disabled={!canUndo}
            title="Undo (⌘Z)"
            onClick={() => st().undo()}
          >
            <UndoIcon />
          </button>
          <button
            className="ghost icon-btn"
            disabled={!canRedo}
            title="Redo (⇧⌘Z)"
            onClick={() => st().redo()}
          >
            <UndoIcon flip />
          </button>
          {mindmapVisible && (
            <button
              className={sorting ? 'active-toggle' : ''}
              onClick={() => st().setSorting(!sorting)}
              title="Drag nodes onto zones to tag them"
            >
              ⇄ Sorting
            </button>
          )}
          {mindmapVisible && sorting && (
            <>
              <select value={sortingAttr} onChange={(e) => st().setSortingAttr(e.target.value)}>
                {enumDefs.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <label className="filter-label" title="Apply to the dragged node's whole subtree">
                <input
                  type="checkbox"
                  checked={sortingBranch}
                  onChange={(e) => st().setSortingBranch(e.target.checked)}
                />
                branch
              </label>
              {addingValue ? (
                <input
                  autoFocus
                  placeholder={`new ${sortingAttr} value`}
                  style={{ width: 130 }}
                  onBlur={() => setAddingValue(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = (e.target as HTMLInputElement).value.trim();
                      if (v) st().addEnumOption(sortingAttr, v);
                      setAddingValue(false);
                    }
                    if (e.key === 'Escape') setAddingValue(false);
                  }}
                />
              ) : (
                <button
                  className="ghost"
                  title="Add a value to this attribute"
                  onClick={() => setAddingValue(true)}
                >
                  + value
                </button>
              )}
            </>
          )}
        </>
      )}

      <span className="spacer" />

      {mapId && (
        <>
          <span
            className={`save-dot ${saveState}`}
            title={SAVE_LABEL[saveState] || 'No changes'}
          />
          <div className="menu-wrap" ref={menuRef}>
            <button onClick={() => setExportOpen((o) => !o)}>Export ▾</button>
            {exportOpen && (
              <div className="menu">
                <button
                  onClick={() => {
                    const s = useMapStore.getState();
                    setExportOpen(false);
                    void exportSmmx(s.nodes, s.rootIds, s.layouts, s.images, s.crossLinks, s.mapName);
                  }}
                >
                  SimpleMind (.smmx)
                </button>
                <button
                  onClick={() => {
                    const s = useMapStore.getState();
                    downloadFile(
                      `${s.mapName || 'cosmos'}.opml`,
                      buildOpml(s.nodes, s.rootIds, s.mapName),
                      'text/x-opml',
                    );
                    setExportOpen(false);
                  }}
                >
                  OPML
                </button>
                <button
                  onClick={() => {
                    const s = useMapStore.getState();
                    exportXlsx(s.nodes, s.rootIds, s.attrDefs, s.mapName);
                    setExportOpen(false);
                  }}
                >
                  Excel (.xlsx)
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <button className={mapId ? '' : 'primary'} onClick={onImport}>
        Import
      </button>
    </div>
  );
}
