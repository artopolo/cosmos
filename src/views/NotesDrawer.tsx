import { useRef } from 'react';
import { useMapStore } from '../store/mapStore';
import { imageUrl } from '../lib/supabase';

/** Node inspector: notes, quick attribute edits, images. Shared by all views. */
export default function NotesDrawer() {
  const id = useMapStore((s) => s.editingNodeId);
  const node = useMapStore((s) => (s.editingNodeId ? s.nodes[s.editingNodeId] : undefined));
  const attrDefs = useMapStore((s) => s.attrDefs);
  const images = useMapStore((s) => (s.editingNodeId ? s.images[s.editingNodeId] : undefined));
  const fileRef = useRef<HTMLInputElement>(null);

  if (!id || !node) return null;
  const st = useMapStore.getState();

  return (
    <div className="drawer">
      <header>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {node.label.replace(/\n/g, ' ') || 'Node'}
        </span>
        <button className="ghost x" onClick={() => st.setEditingNode(null)}>
          ✕
        </button>
      </header>
      <div className="drawer-body">
        {attrDefs.map((def) => (
          <label key={def.name} className="drawer-attr">
            <span className="attr-name">{def.name}</span>
            {def.type === 'enum' && def.name === 'status' ? (
              <span className="status-pills">
                {def.options.map((o) => {
                  const active = node.attrs.status === o.value;
                  return (
                    <button
                      key={o.value}
                      className={`status-pill${active ? ' on' : ''}`}
                      style={{ background: o.color }}
                      title={o.label ?? o.value}
                      onClick={() => st.setAttr([id], 'status', active ? null : o.value)}
                    />
                  );
                })}
              </span>
            ) : def.type === 'enum' ? (
              <select
                value={(node.attrs[def.name] as string) ?? ''}
                onChange={(e) => st.setAttr([id], def.name, e.target.value || null)}
              >
                <option value="">—</option>
                {def.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label ?? o.value}
                  </option>
                ))}
              </select>
            ) : def.type === 'number' ? (
              <input
                type="number"
                min={def.config?.min}
                max={def.config?.max}
                value={node.attrs[def.name] == null ? '' : Number(node.attrs[def.name])}
                onChange={(e) =>
                  st.setAttr([id], def.name, e.target.value === '' ? null : Number(e.target.value))
                }
              />
            ) : (
              <input
                value={(node.attrs[def.name] as string) ?? ''}
                onChange={(e) => st.setAttr([id], def.name, e.target.value || null)}
              />
            )}
          </label>
        ))}
        <label className="drawer-attr">
          <span className="attr-name">link</span>
          <input
            type="url"
            placeholder="https://…"
            value={(node.attrs.link as string) ?? ''}
            onChange={(e) => st.setAttr([id], 'link', e.target.value || null)}
          />
        </label>
        <div className="drawer-section-head">
          <span>Notes</span>
          {node.notes.trim() && (
            <button className="ghost mini" title="Delete note" onClick={() => st.setNotes(id, '')}>
              ✕ clear
            </button>
          )}
        </div>
        <textarea
          placeholder="Notes…"
          value={node.notes}
          onChange={(e) => st.setNotes(id, e.target.value)}
        />
        <div className="drawer-section-head">
          <span>Images</span>
          <button className="ghost mini" onClick={() => fileRef.current?.click()}>
            + add
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void st.addImage(id, f);
              e.target.value = '';
            }}
          />
        </div>
        {(images ?? []).map((im) => (
          <div key={im.id} className="drawer-img">
            <img
              src={imageUrl(im.storagePath)}
              alt=""
              title="Double-click to open full size"
              style={{ cursor: 'zoom-in' }}
              onDoubleClick={() => window.open(imageUrl(im.storagePath), '_blank')}
            />
            <button
              className="ghost mini img-del"
              title="Delete image"
              onClick={() => st.deleteImage(id, im.id)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="ghost"
          style={{ color: 'var(--status-red)' }}
          onClick={() => {
            if (confirm('Delete this node and its subtree?')) {
              st.deleteNodes([id]);
            }
          }}
        >
          Delete node
        </button>
      </div>
    </div>
  );
}
