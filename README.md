# Cosmos

Personal language-acquisition mapping app: one data model, three synchronized
views — mind map (galaxy + detail), table, and sorting mode. Maps what you
know, what you don't, and your learning zone (red / yellow / green).

## Run

```bash
npm run dev      # dev server, reachable on your LAN (open from the iPad)
npm test         # parser + export tests against the real Test.smmx fixture
npm run build    # production build into dist/
```

On the iPad: open `http://<your-mac-ip>:5173` in Safari while `npm run dev`
is running. For the installable PWA (Add to Home Screen with offline shell),
deploy `dist/` to any static host with HTTPS (Netlify / Vercel / Cloudflare
Pages) — the backend is Supabase, so the frontend is pure static files.

## Architecture

One Zustand store ([src/store/mapStore.ts](src/store/mapStore.ts)) is the
single source of truth; every view renders from it and edits through its
actions, so editing anywhere updates everywhere. A write-behind queue
([src/store/persistence.ts](src/store/persistence.ts)) batches mutations and
flushes them to Supabase after a debounce; every attribute change is also
logged to `status_history`.

- **Galaxy** ([src/views/map/OverviewCanvas.tsx](src/views/map/OverviewCanvas.tsx)) —
  canvas 2D dot-field of the whole map, colored by status. Handles 3,600+
  nodes at 100+ fps. Click a dot (or zoom in past the threshold) to dive.
- **Detail** ([src/views/map/DetailFlow.tsx](src/views/map/DetailFlow.tsx)) —
  React Flow, collapse-by-default, renders only the expanded branch
  (~200-node budget). Inline label editing, notes drawer, images, cross-links.
- **Table** ([src/views/table/TableView.tsx](src/views/table/TableView.tsx)) —
  TanStack Table, virtualized, columns generated from `attribute_definitions`,
  inline + bulk editing.
- **Sorting mode** ([src/views/map/SortZones.tsx](src/views/map/SortZones.tsx)) —
  drop zones generated from any enum attribute's values; dragging a node (or
  branch) onto a zone tags it and snaps the node back. Never reparents.
- **Map view** ([src/views/grid/GridView.tsx](src/views/grid/GridView.tsx)) —
  the categorization grid: Unallocated tray → layer-only column → layers ×
  depth grid. Cards are allocation-region roots; dragging a card re-allocates
  its whole branch; click selects, double-click locates the node in the mind
  map. Layer rows can be renamed / inserted / merged / removed; depth columns
  insert anywhere with positional renumbering (contents shift right intact).
- **Undo/redo** — ⌘Z / ⇧⌘Z (or toolbar ↶↷) across attribute edits, labels,
  notes, deletes, detaches, allocations, reorders and category edits. Inverse
  actions replay through the store, so persistence stays consistent.
- **Auto-layout** ([src/lib/layout.ts](src/lib/layout.ts)) — the mind map
  arranges VISIBLE nodes hierarchically from measured sizes; collapsing frees
  the space and the map compacts. Nothing is positioned by hand: dragging a
  node is a gesture (drop it on the dock or a sorting zone, or it snaps
  home). The galaxy uses a stable fully-expanded layout of the same shape.
- **Keyboard** — ⌘← collapse everything under the selection, ⌘→ expand
  everything under it, ⌘↑/⌘↓ reorder a node among its siblings (persisted via
  edge sort_order). The focused node stays centered through relayout.
- **Allocation dock** ([src/views/map/AllocDock.tsx](src/views/map/AllocDock.tsx)) —
  right side of the mind map: every layer with its depth cells, colored by
  layer hue (deeper = stronger). Drop a node there → its branch allocates and
  the node snaps back. Grid cells in the Map view carry the same colors, and
  the mind map's "Cells" color mode tints allocated nodes with their cell's
  color. Deleting a connection (click edge, press Delete) detaches the branch
  into its own central theme — maps hold multiple trees.

### Editing (v4)

Drop a node onto another node to make it that node's child; drag a tree's
head to move the whole tree. Tab adds a child, Enter a sibling, the + / ✂ / ≡
strip appears on the selected node. Status/cell colors live in the border and
a halo — fills stay white so SimpleMind's own colors are never confused with
Cosmos meaning. Labels support `**bold**` / `*italic*`; nodes can carry a
hyperlink (drawer) and floating text labels (+ Label). Cross-links are drawn
by dragging from the small side handles. Depth columns are per-layer.
Exports bake attributes into the first note line (`[cosmos: layer=…; depth=…]`)
and imports strip them back — allocations survive SimpleMind round-trips.

## Data model (Supabase)

`maps` → `nodes` (attrs JSONB, no fixed columns) → `edges` (structural tree +
typed cross-links), `attribute_definitions` (layer / depth / group / status
are rows, not schema), `status_history` (every change logged), `layouts`
(positions apart from semantics), `images` (placements; files live in the
`cosmos-images` storage bucket). Adding a new dimension = inserting an
`attribute_definitions` row. No migration, no plugin system.

Supabase project: `dtwnowpclxnzlrkmwbri` (Cosmos). The client uses the
publishable key with permissive RLS — fine for a single-user personal tool,
but anyone with the URL+key pair could read/write; don't reuse this project
for anything sensitive.

## Import / export

- **.smmx import** ([src/import/smmx.ts](src/import/smmx.ts)) — zip + XML
  parse in the browser; preserves hierarchy, positions, notes (including
  floating text callouts), colors, cross-links, and embedded images (uploaded
  to storage). Offers mapping of SimpleMind topic colors → status at import.
  One-way, one-time per map.
- **OPML import** — basic tree fallback with generated layout.
- **Export** — OPML (text/notes/hierarchy, for the road back to SimpleMind)
  and Excel (flat table of all nodes with all attribute columns).

## Notes for future work

- PostgREST batch inserts fill missing keys with NULL (not column defaults) —
  keep row shapes uniform per insert.
- iPadOS Safari sends trackpad pinch as ctrl+wheel; macOS Safari sends
  proprietary gesture events; touch pinch arrives as pointer pairs. The
  overview canvas handles all three.
- `<canvas>` is a replaced element: `position:absolute; inset:0` does not
  stretch it — explicit width/height 100% required.
