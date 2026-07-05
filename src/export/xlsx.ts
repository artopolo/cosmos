import * as XLSX from 'xlsx';
import { treeOrder } from '../store/mapStore';
import type { AttributeDef, NodeData } from '../types';

/** Flat table of all nodes with all attribute columns (pure, testable). */
export function buildWorkbook(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  attrDefs: AttributeDef[],
): XLSX.WorkBook {
  const order = treeOrder(nodes, rootIds);
  const header = ['Label', ...attrDefs.map((d) => d.name), 'Notes', 'Path'];
  const rows = order.map(({ id, path }) => {
    const n = nodes[id];
    return [
      n.label.replace(/\n/g, ' '),
      ...attrDefs.map((d) => n.attrs[d.name] ?? ''),
      n.notes,
      path,
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [
    { wch: 42 },
    ...attrDefs.map(() => ({ wch: 12 })),
    { wch: 60 },
    { wch: 50 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Nodes');
  return wb;
}

export function exportXlsx(
  nodes: Record<string, NodeData>,
  rootIds: string[],
  attrDefs: AttributeDef[],
  mapName: string,
) {
  const wb = buildWorkbook(nodes, rootIds, attrDefs);
  const safe = (mapName || 'cosmos').replace(/[/\\?%*:|"<>]/g, '-');
  XLSX.writeFile(wb, `${safe}.xlsx`);
}
