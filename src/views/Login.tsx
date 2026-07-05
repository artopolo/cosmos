import { useState } from 'react';
import { supabase } from '../lib/supabase';
import Logo from './Logo';

export default function Login() {
  const [email, setEmail] = useState('homoanimus@gmail.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError(err.message === 'Invalid login credentials' ? 'Wrong email or password.' : err.message);
    // on success onAuthStateChange in App takes over
  };

  return (
    <div className="home">
      <div className="home-card" style={{ width: 360 }}>
        <h1>
          <Logo size={30} /> Cosmos
        </h1>
        <p className="sub">Sign in to open your maps.</p>
        <input
          type="email"
          placeholder="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void signIn()}
        />
        {error && <p style={{ color: 'var(--status-red)', margin: 0 }}>{error}</p>}
        <button className="primary" disabled={busy || !password} onClick={() => void signIn()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
