export interface CosmosMap {
  id: string;
  name: string;
  created_at: string;
}

/** Attribute values keyed by attribute_definitions.name. */
export type Attrs = Record<string, string | number>;

export interface NodeData {
  id: string;
  label: string;
  notes: string;
  attrs: Attrs;
  /** null for root(s). Derived from structural edges. */
  parentId: string | null;
  /** Ordered by edge sort_order. */
  childIds: string[];
}

export interface CrossLink {
  id: string;
  source: string;
  target: string;
  linkType: string | null;
}

export interface AttrOption {
  value: string;
  color?: string;
  label?: string;
  /** per-layer depth column count (layers can have different depths) */
  depths?: number;
}

export type AttrType = 'enum' | 'number' | 'text';

export interface AttributeDef {
  id: string;
  name: string;
  type: AttrType;
  options: AttrOption[];
  config: { min?: number; max?: number };
  sort_order: number;
}

export interface NodeImage {
  id: string;
  nodeId: string;
  storagePath: string;
  thumbPath: string | null;
  x: number;
  y: number;
  scale: number;
  width: number | null;
  height: number | null;
}

export interface XY {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type StatusValue = 'red' | 'yellow' | 'green';

export const STATUS_COLORS: Record<StatusValue, string> = {
  red: '#e5484d',
  yellow: '#edb200',
  green: '#2f9e44',
};

/** Soft fills used on nodes in the detail view. */
export const STATUS_FILLS: Record<StatusValue, string> = {
  red: '#fcebeb',
  yellow: '#fdf6dc',
  green: '#e9f6ec',
};

export const UNSET_DOT = '#c6cbd1';
