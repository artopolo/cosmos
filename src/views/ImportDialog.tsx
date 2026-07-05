import { useRef, useState } from 'react';
import { parseSmmx, type ParsedMindmap } from '../import/smmx';
import { parseOpml } from '../import/opml';
import { importParsed } from '../import/importer';
import { useMapStore } from '../store/mapStore';
import { STATUS_COLORS, type StatusValue } from '../types';

type Stage =
  | { kind: 'pick' }
  | { kind: 'parsing' }
  | { kind: 'preview'; parsed: ParsedMindmap; name: string; mapping: Record<string, StatusValue | ''> }
  | { kind: 'importing'; phase: string; done: number; total: number }
  | { kind: 'error'; message: string };

export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setStage({ kind: 'parsing' });
    try {
      let parsed: ParsedMindmap;
      if (/\.smmx$/i.test(file.name)) {
        parsed = parseSmmx(new Uint8Array(await file.arrayBuffer()));
      } else {
        parsed = parseOpml(await file.text());
      }
      const mapping: Record<string, StatusValue | ''> = {};
      for (const g of parsed.colorGroups) mapping[g.color] = g.suggested ?? '';
      setStage({ kind: 'preview', parsed, name: parsed.title, mapping });
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const runImport = async (parsed: ParsedMindmap, name: string, mapping: Record<string, StatusValue | ''>) => {
    setStage({ kind: 'importing', phase: 'Starting…', done: 0, total: 1 });
    try {
      const mapId = await importParsed(
        parsed,
        { mapName: name || 'Imported map', colorToStatus: mapping },
        (phase, done, total) => setStage({ kind: 'importing', phase, done, total }),
      );
      const st = useMapStore.getState();
      await st.loadMaps();
      await st.loadMap(mapId);
      onClose();
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const imgCount = (p: ParsedMindmap) =>
    p.topics.reduce((n, t) => n + t.images.length, 0);

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>Import a map</header>

        {stage.kind === 'pick' && (
          <div className="modal-body">
            <div
              className={`drop-hint${dragOver ? ' over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) void handleFile(f);
              }}
            >
              Drop a SimpleMind <b>.smmx</b> or <b>.opml</b> file here,
              <br />
              or click to choose
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".smmx,.opml,.xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
              Import is a one-time transfer: hierarchy, positions, notes, images and
              cross-links are preserved. Topic colors can be mapped to status.
            </p>
          </div>
        )}

        {stage.kind === 'parsing' && (
          <div className="modal-body">
            <p>Reading file…</p>
          </div>
        )}

        {stage.kind === 'preview' && (
          <>
            <div className="modal-body">
              <label>
                Map name
                <input
                  style={{ width: '100%', marginTop: 4 }}
                  value={stage.name}
                  onChange={(e) => setStage({ ...stage, name: e.target.value })}
                />
              </label>
              <div style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                <b>{stage.parsed.topics.length.toLocaleString()}</b> nodes ·{' '}
                <b>{stage.parsed.topics.filter((t) => t.note).length}</b> with notes ·{' '}
                <b>{imgCount(stage.parsed)}</b> images ·{' '}
                <b>{stage.parsed.relations.length}</b> cross-links
              </div>

              {stage.parsed.colorGroups.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Map topic colors → status
                  </div>
                  {stage.parsed.colorGroups.map((g) => (
                    <div key={g.color} className="color-map-row">
                      <span className="swatch" style={{ background: g.color }} />
                      <span className="cnt">
                        {g.count} node{g.count === 1 ? '' : 's'}
                      </span>
                      <select
                        value={stage.mapping[g.color] ?? ''}
                        onChange={(e) =>
                          setStage({
                            ...stage,
                            mapping: {
                              ...stage.mapping,
                              [g.color]: e.target.value as StatusValue | '',
                            },
                          })
                        }
                      >
                        <option value="">keep uncolored</option>
                        {(['red', 'yellow', 'green'] as const).map((sv) => (
                          <option key={sv} value={sv}>
                            {sv}
                          </option>
                        ))}
                      </select>
                      <span
                        className="swatch"
                        style={{
                          background: stage.mapping[g.color]
                            ? STATUS_COLORS[stage.mapping[g.color] as StatusValue]
                            : 'transparent',
                          borderStyle: stage.mapping[g.color] ? 'solid' : 'dashed',
                          width: 16,
                          height: 16,
                        }}
                      />
                      <span
                        style={{
                          color: 'var(--muted)',
                          fontSize: 11.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {g.samples.join(' · ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <footer>
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                onClick={() => void runImport(stage.parsed, stage.name, stage.mapping)}
              >
                Import {stage.parsed.topics.length.toLocaleString()} nodes
              </button>
            </footer>
          </>
        )}

        {stage.kind === 'importing' && (
          <div className="modal-body" style={{ paddingBottom: 22 }}>
            <p style={{ margin: '4px 0' }}>
              {stage.phase} {stage.total > 1 ? `${stage.done} / ${stage.total}` : ''}
            </p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${stage.total ? (stage.done / stage.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {stage.kind === 'error' && (
          <>
            <div className="modal-body">
              <p style={{ color: 'var(--status-red)' }}>{stage.message}</p>
            </div>
            <footer>
              <button onClick={() => setStage({ kind: 'pick' })}>Try again</button>
              <button onClick={onClose}>Close</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
