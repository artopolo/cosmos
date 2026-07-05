import { useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useMapStore } from '../store/mapStore';
import Logo from './Logo';

export default function Home({ onImport }: { onImport: () => void }) {
  const maps = useMapStore((s) => s.maps);
  const loadError = useMapStore((s) => s.loadError);

  useEffect(() => {
    void useMapStore.getState().loadMaps();
  }, []);

  return (
    <div className="home">
      <div className="home-card">
        <h1>
          <Logo size={30} /> Cosmos
        </h1>
        <p className="sub">Map what you know, what you don’t, and what to learn next.</p>
        {loadError && <p style={{ color: 'var(--status-red)' }}>{loadError}</p>}
        <div className="map-list">
          {maps.map((m) => (
            <button
              key={m.id}
              className="map-item"
              onClick={() => void useMapStore.getState().loadMap(m.id)}
            >
              <span className="name">{m.name}</span>
              <span className="meta">
                {new Date(m.created_at).toLocaleDateString()}
              </span>
              <span
                className="meta"
                title="Delete map"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete map “${m.name}” and all its nodes?`)) {
                    void useMapStore.getState().deleteMap(m.id);
                  }
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>
        <div className="drop-hint" onClick={onImport}>
          Import a SimpleMind .smmx or OPML file…
        </div>
        <button
          className="ghost"
          style={{ alignSelf: 'flex-start', color: 'var(--muted)' }}
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
