import { request } from 'node:http';
export function requestDevnetKeys(socketPath, network, user) {
  return new Promise((resolve, reject) => {
    if (!socketPath) return reject(Error('Devnet key access is not configured'));
    const req = request({ socketPath, path: '/keys', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(Error('size')); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw Error('unavailable'); resolve(JSON.parse(body)); } catch { reject(Error('Devnet keys unavailable; the network must be idle and its identities verified')); } });
      res.on('error', () => reject(Error('Devnet key service unavailable')));
    });
    req.setTimeout(180_000, () => req.destroy(Error('timeout')));
    req.on('error', () => reject(Error('Devnet key service unavailable')));
    req.end(JSON.stringify({ network, user }));
  });
}
