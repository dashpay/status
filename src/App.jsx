import { useEffect } from 'react';
import { loadSession, logout, useResource, useRoute, useSession, useNow, ago } from './lib.js';
import { Dot, Link } from './ui.jsx';
import Overview from './pages/Overview.jsx';
import Network from './pages/Network.jsx';
import Deploy from './pages/Deploy.jsx';
import Operation from './pages/Operation.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const route = useRoute();
  const session = useSession();
  useEffect(() => { loadSession(); }, []);
  const overview = useResource('/api/overview', (t) => t === 'network' || t === 'settings');
  const path = route.split('?')[0];
  const parts = path.split('/').filter(Boolean);
  let page;
  if (parts[0] === 'n' && parts[1] && parts[2] === 'deploy') page = <Deploy name={parts[1]} />;
  else if (parts[0] === 'n' && parts[1] && parts[2] === 'ops' && parts[3]) page = <Operation name={parts[1]} id={parts[3]} />;
  else if (parts[0] === 'n' && parts[1]) page = <Network name={parts[1]} tab={parts[2] || 'hosts'} />;
  else if (parts[0] === 'settings') page = <Settings />;
  else page = <Overview overview={overview} />;
  return (
    <div className="min-h-screen">
      <Header networks={overview.data?.networks || []} active={parts[0] === 'n' ? parts[1] : parts[0] || 'overview'} session={session} />
      <main className="mx-auto max-w-[1680px] px-4 pb-16">{page}</main>
    </div>
  );
}

function Header({ networks, active, session }) {
  const now = useNow(1000);
  const newest = networks.map((n) => n.generatedAt).filter(Boolean).sort().pop();
  return (
    <header className="border-b border-line bg-[#0c1016]/95 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto max-w-[1680px] px-4 h-11 flex items-center gap-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight text-[13px] shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="4" fill="#1f6feb" /><path d="M7 8h7.5a2.5 2.5 0 0 1 0 5H9m-2 3h7.5" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
          dash status
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          <Link to="/" className={`px-2.5 py-1 rounded ${active === 'overview' ? 'bg-panel-2 text-fg' : 'text-dim hover:text-fg'}`}>Overview</Link>
          {networks.map((n) => (
            <Link key={n.name} to={`/n/${n.name}`} className={`px-2.5 py-1 rounded flex items-center gap-1.5 whitespace-nowrap ${active === n.name ? 'bg-panel-2 text-fg' : 'text-dim hover:text-fg'}`}>
              <Dot level={n.level} />{n.displayName}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[12px] shrink-0">
          {newest && <span className="text-dim mono hidden sm:inline" title={`agent state written ${newest}`}><span className={`dot mr-1.5 ${now - Date.parse(newest) < 120_000 ? 'bg-lv-ok live' : 'bg-lv-down'}`} />{ago(newest, now)}</span>}
          {session.user ? (
            <>
              {session.operatorOf?.length > 0 && <Link to="/settings" className={`hover:text-fg ${active === 'settings' ? 'text-fg' : 'text-dim'}`}>Settings</Link>}
              <span className="flex items-center gap-1.5 text-dim"><img src={`https://avatars.githubusercontent.com/u/${session.user.id}?s=40`} alt="" className="w-5 h-5 rounded-full" />{session.user.login}</span>
              <button className="text-dim hover:text-fg" onClick={logout}>Sign out</button>
            </>
          ) : session.loaded && session.loginAvailable ? (
            <a className="btn" href="/api/auth/github">Sign in with GitHub</a>
          ) : null}
        </div>
      </div>
    </header>
  );
}
