import Dashboard from './components/Dashboard';
import NetworkConsole from './components/NetworkConsole';
import { useEffect, useState } from 'react';

export default function App() {
  const [mode, setMode] = useState(null);
  useEffect(() => {
    // /api/health belongs to the original collector, including when the console
    // is installed alongside it. Detect the additive API, never its replacement.
    fetch('/api/networks', { cache: 'no-store' }).then(async (response) => {
      if (response.status === 404) return setMode('legacy');
      if (!response.ok) return setMode('console');
      if (!response.headers.get('content-type')?.includes('application/json')) return setMode('legacy');
      const body = await response.json();
      setMode(Array.isArray(body.networks) ? 'console' : 'legacy');
    }).catch(() => setMode('console'));
  }, []);
  if (!mode) return <div style={{ padding: 16, fontFamily: 'system-ui', minHeight: '100vh', background: '#030712', color: '#9ca3af' }}>Loading nodes…</div>;
  return mode === 'console' ? <NetworkConsole /> : <Dashboard />;
}
