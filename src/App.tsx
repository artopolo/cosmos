import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { useMapStore } from './store/mapStore';
import { persister } from './store/persistence';
import Toolbar from './views/Toolbar';
import Home from './views/Home';
import Login from './views/Login';
import MapView from './views/map/MapView';
import GridView from './views/grid/GridView';
import NotesDrawer from './views/NotesDrawer';
import ImportDialog from './views/ImportDialog';

/** Everything is behind sign-in: the data itself requires it (RLS). */
export default function App() {
  // undefined = still checking, null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="home">
        <p style={{ color: 'var(--muted)' }}>…</p>
      </div>
    );
  }
  if (!session) return <Login />;
  return <MainApp />;
}

function MainApp() {
  const mapId = useMapStore((s) => s.mapId);
  const view = useMapStore((s) => s.view);
  const loading = useMapStore((s) => s.loading);
  const saveState = useMapStore((s) => s.saveState);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    const last = localStorage.getItem('cosmos:lastMap');
    if (last) void useMapStore.getState().loadMap(last);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      // inside a text field the browser's own shortcuts win
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = useMapStore.getState();

      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }

      // ⌘← collapse all under · ⌘→ expand all under · ⌘↑/↓ reorder siblings
      if (!st.mapId) return;
      const ids = Object.keys(st.selected);
      if (ids.length === 0) return;
      const inGrid = st.view === 'map';
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (inGrid) st.gridOpenUnder(ids, false);
        else {
          st.collapseAllUnder(ids);
          st.setFocusNode(ids[0]); // keep the node in view after the map compacts
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (inGrid) st.gridOpenUnder(ids, true);
        else {
          st.expandAllUnder(ids);
          st.setFocusNode(ids[0]);
        }
      } else if (e.key === 'ArrowUp' && ids.length === 1) {
        e.preventDefault();
        st.reorderSibling(ids[0], -1);
        if (!inGrid) st.setFocusNode(ids[0]);
      } else if (e.key === 'ArrowDown' && ids.length === 1) {
        e.preventDefault();
        st.reorderSibling(ids[0], 1);
        if (!inGrid) st.setFocusNode(ids[0]);
      }
    };

    // Tab = child, Enter = sibling, plain arrows = jump between nodes
    const onCreateKey = (e: KeyboardEvent) => {
      const isArrow = e.key.startsWith('Arrow');
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'Tab' && e.key !== 'Enter' && !isArrow)) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.tagName === 'BUTTON' ||
          t.isContentEditable)
      ) {
        return;
      }
      const st = useMapStore.getState();
      if (!st.mapId || st.view !== 'mindmap' || st.overview) return;
      const ids = Object.keys(st.selected);
      if (ids.length !== 1) return;

      if (isArrow) {
        const n = st.nodes[ids[0]];
        if (!n) return;
        let next: string | undefined;
        if (e.key === 'ArrowLeft') {
          next = n.parentId ?? undefined;
        } else if (e.key === 'ArrowRight') {
          if (n.childIds.length > 0) {
            if (!st.expanded[n.id]) st.toggleExpanded(n.id); // reveal, then enter
            next = n.childIds[0];
          }
        } else {
          const siblings = n.parentId ? st.nodes[n.parentId].childIds : st.rootIds;
          const i = siblings.indexOf(n.id);
          const j = i + (e.key === 'ArrowDown' ? 1 : -1);
          if (j >= 0 && j < siblings.length) next = siblings[j];
        }
        if (next) {
          e.preventDefault();
          st.setSelected([next]);
          st.setFocusNode(next);
        }
        return;
      }
      e.preventDefault();
      let newId = '';
      if (e.key === 'Tab') {
        newId = st.addChild(ids[0]);
      } else {
        const parent = st.nodes[ids[0]]?.parentId;
        if (!parent) return;
        newId = st.addChild(parent);
      }
      if (newId) {
        st.setSelected([newId]);
        st.setFocusNode(newId);
        st.setEditingLabel(newId);
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onCreateKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onCreateKey);
    };
  }, []);

  return (
    <div className="app">
      <Toolbar onImport={() => setImportOpen(true)} />
      <div className="app-body">
        {loading ? (
          <div className="home">
            <p style={{ color: 'var(--muted)' }}>Loading map…</p>
          </div>
        ) : !mapId ? (
          <Home onImport={() => setImportOpen(true)} />
        ) : view === 'map' ? (
          <GridView />
        ) : (
          <MapView />
        )}
        <NotesDrawer />
      </div>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      {saveState === 'error' && (
        <div className="error-toast">
          Saving failed — will retry automatically.
          <button onClick={() => void persister.flush()}>Retry now</button>
        </div>
      )}
    </div>
  );
}
