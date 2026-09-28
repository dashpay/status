import { ago, navigate, useNow, useResource } from '../lib.js';
import { Empty, Err, Link, OpBadge, Section } from '../ui.jsx';

export default function Operations({ network }) {
  const now = useNow(1000);
  const { data, error } = useResource(`/api/networks/${network.name}/ops`, (t, d) => t === 'op' && d.network === network.name);
  if (error) return <div className="mt-4"><Err error={error} /></div>;
  if (!data) return <div className="mt-4 text-dim">Loading…</div>;
  return (
    <Section title={`Operations · ${data.ops.length}`} right={network.deployable && <Link className="btn btn-primary" to={`/n/${network.name}/deploy`}>New deployment…</Link>}>
      {!data.ops.length ? <Empty>No operations yet.</Empty> : (
        <div className="panel scroll-x">
          <table className="grid">
            <thead><tr><th>status</th><th>action</th><th>nodes</th><th>components / images</th><th>requested by</th><th className="num">created</th><th className="num">updated</th></tr></thead>
            <tbody>
              {data.ops.map((o) => (
                <tr key={o.id} onClick={() => navigate(`/n/${network.name}/ops/${o.id}`)}>
                  <td><OpBadge status={o.status} /></td>
                  <td><Link to={`/n/${network.name}/ops/${o.id}`} className="link">{o.request.action}</Link></td>
                  <td className="mono text-[11.5px] max-w-[320px] truncate">{o.request.nodes.length > 4 ? `${o.request.nodes.slice(0, 4).join(', ')} +${o.request.nodes.length - 4}` : o.request.nodes.join(', ')}</td>
                  <td className="mono text-[11.5px] max-w-[380px] truncate">{Object.values(o.request.images || {}).join(' ') || (o.request.components || []).join(', ') || '—'}</td>
                  <td>{o.actor.login}</td>
                  <td className="num text-dim">{ago(o.createdAt, now)}</td>
                  <td className="num text-dim">{ago(o.updatedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
