import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useMapStore } from '../../store/mapStore';

export interface CosmosNodeData {
  label: string;
  border: string | null; // status color — null = default dark border
  halo: string | null; // soft status ring
  fill: string | null; // allocation cell color (the node wears its cell)
  stripe: string | null; // original SimpleMind color, kept as a left mark
  hasNotes: boolean;
  hasParent: boolean;
  link: string | null;
  isLabel: boolean; // floating text callout
  imgs: { url: string; w: number }[];
  childCount: number;
  hiddenCount: number;
  isExpanded: boolean;
  [key: string]: unknown;
}

/** minimal rich text: **bold** and *italic* inside labels */
export function renderRich(s: string): React.ReactNode {
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) parts.push(<b key={k++}>{t.slice(2, -2)}</b>);
    else parts.push(<i key={k++}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (parts.length === 0) return s;
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export type CosmosFlowNode = Node<CosmosNodeData, 'cosmos'>;

function CosmosNodeInner({ id, data, selected }: NodeProps<CosmosFlowNode>) {
  const [editing, setEditing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const editRequested = useMapStore((s) => s.editingLabelId === id);

  useEffect(() => {
    if (editRequested) {
      setEditing(true);
      useMapStore.getState().setEditingLabel(null);
    }
  }, [editRequested]);

  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      ta.select();
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [editing]);

  const commit = () => {
    const v = taRef.current?.value.trim();
    if (v && v !== data.label) useMapStore.getState().setLabel(id, v);
    setEditing(false);
  };

  // fill = allocation cell · left stripe = original SimpleMind color ·
  // border + halo = status. Three signals, no confusion.
  const shadows: string[] = [];
  if (data.halo) shadows.push(`0 0 0 4px ${data.halo}`);
  if (selected) shadows.push(`0 0 0 ${data.halo ? 6.5 : 2.5}px rgba(28, 30, 33, 0.4)`);

  return (
    <div
      className={`cosmos-node${data.isLabel ? ' label-node' : ''}`}
      style={{
        borderColor: data.border ?? undefined,
        background: data.fill ?? undefined,
        boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {data.stripe && <span className="smmx-stripe" style={{ background: data.stripe }} />}
      <Handle type="target" position={Position.Left} id="tl" className="invisible-handle" />
      {/* source handles double as grab points for drawing cross-links */}
      <Handle type="source" position={Position.Right} id="sr" className="conn-handle" />
      <Handle type="target" position={Position.Right} id="tr" className="invisible-handle" />
      <Handle type="source" position={Position.Left} id="sl" className="conn-handle" />

      {selected && !editing && (
        <div className="node-controls nodrag">
          <button
            title="Add child (Tab)"
            onClick={(e) => {
              e.stopPropagation();
              const st = useMapStore.getState();
              const newId = st.addChild(id);
              if (newId) {
                st.setSelected([newId]);
                st.setFocusNode(newId);
                st.setEditingLabel(newId);
              }
            }}
          >
            +
          </button>
          {data.hasParent && (
            <button
              title="Detach — becomes its own central theme"
              onClick={(e) => {
                e.stopPropagation();
                useMapStore.getState().detachBranch(id);
              }}
            >
              ✂
            </button>
          )}
          <button
            title="Notes & attributes"
            onClick={(e) => {
              e.stopPropagation();
              useMapStore.getState().setEditingNode(id);
            }}
          >
            ≡
          </button>
        </div>
      )}

      {editing ? (
        <textarea
          ref={taRef}
          className="label-input nodrag"
          defaultValue={data.label}
          rows={1}
          onBlur={commit}
          onInput={(e) => {
            const ta = e.currentTarget;
            ta.style.height = 'auto';
            ta.style.height = `${ta.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="label">
          {data.label ? renderRich(data.label) : <span style={{ opacity: 0.4 }}>…</span>}
          {data.link && (
            <span className="badges">
              <a
                className="node-link nodrag"
                href={data.link}
                target="_blank"
                rel="noreferrer"
                title={data.link}
                onClick={(e) => e.stopPropagation()}
              >
                🔗
              </a>
            </span>
          )}
          {data.hasNotes && (
            <span className="badges">
              <span
                className="note-ind"
                title="Notes"
                onClick={(e) => {
                  e.stopPropagation();
                  useMapStore.getState().setEditingNode(id);
                }}
              >
                <svg width="11" height="12" viewBox="0 0 11 12" fill="none">
                  <path
                    d="M1 1.5h9M1 4.5h9M1 7.5h6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </span>
          )}
        </span>
      )}

      {data.imgs.map((im) => (
        <img
          key={im.url}
          className="node-img"
          src={im.url}
          width={im.w}
          loading="lazy"
          draggable={false}
          alt=""
        />
      ))}

      {data.childCount > 0 && (
        <button
          className={`collapse-btn nodrag${data.isExpanded ? '' : ' count'}`}
          title={data.isExpanded ? 'Collapse' : `Expand ${data.hiddenCount} nodes`}
          onClick={(e) => {
            e.stopPropagation();
            useMapStore.getState().toggleExpanded(id);
          }}
        >
          {data.isExpanded ? '–' : data.hiddenCount}
        </button>
      )}
    </div>
  );
}

export const CosmosNode = memo(CosmosNodeInner);
