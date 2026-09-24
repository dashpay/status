import Dashboard from './components/Dashboard';
import NetworkConsole from './components/NetworkConsole';
import { useEffect, useState } from 'react';

export default function App() {
  const [mode, setMode] = useState(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((v) => setMode(v.service === 'dash-network-console' ? 'console' : 'legacy')).catch(() => setMode('console'));
  }, []);
  if (!mode) return <div style={{ padding: 40, fontFamily: 'system-ui' }}>Connecting to Dash networks…</div>;
  return mode === 'console' ? <NetworkConsole /> : <Dashboard />;
}
