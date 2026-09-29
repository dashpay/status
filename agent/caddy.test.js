// The wallet host's Caddyfile from agent/services-remote.py. The script
// configures a wallet host at import, so only caddyfile() is extracted (ast).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./services-remote.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

const HARNESS = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
keep = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'caddyfile']
ns = {}
exec(compile(ast.Module(body=keep, type_ignores=[]), sys.argv[1], 'exec'), ns)
print(ns['caddyfile'](json.loads(sys.argv[2])))
`;

const caddyfile = (cfg) => {
  const r = spawnSync('python3', ['-c', HARNESS, SCRIPT, JSON.stringify(cfg)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const hosts = {
  insight: 'insight.x.networks.dash.org', quorums: 'quorums.x.networks.dash.org', explorer: 'explorer.x.networks.dash.org', faucet: 'faucet.x.networks.dash.org',
  quorums_sdk: 'quorums.x-g1.networks.dash.org', 'seed-1': 'seed-1.x.networks.dash.org', 'seed-2': 'seed-2.x.networks.dash.org',
};
const gateways = ['https://198.51.100.10:1443', 'https://198.51.100.11:1443'];

test('Caddy serves the quorum list under the Core devnet name too', { skip: !python }, () => {
  assert.match(caddyfile({ hosts, gateways, gatewayPort: 1443, trustedGateways: true }), /^quorums\.x\.networks\.dash\.org, quorums\.x-g1\.networks\.dash\.org \{\n {2}reverse_proxy 127\.0\.0\.1:8080$/m);
});

test('DAPI seeds on 443 and 1443 spread over every validator gateway', { skip: !python }, () => {
  const text = caddyfile({ hosts, gateways, gatewayPort: 1443, trustedGateways: true });
  assert.match(text, /^seed-1\.x\.networks\.dash\.org, seed-1\.x\.networks\.dash\.org:1443, seed-2\.x\.networks\.dash\.org, seed-2\.x\.networks\.dash\.org:1443 \{$/m);
  assert.match(text, /reverse_proxy https:\/\/198\.51\.100\.10:1443 https:\/\/198\.51\.100\.11:1443 \{/);
  assert.match(text, /flush_interval -1/, 'server streams pass through as they arrive');
  assert.doesNotMatch(text, /tls_insecure_skip_verify/, "Let's Encrypt gateway certificates are verified");
  assert.match(caddyfile({ hosts, gateways, gatewayPort: 1443, trustedGateways: false }), /tls_insecure_skip_verify/, 'self-signed gateways are not');
});

test('devnets registered before seeds keep their four sites', { skip: !python }, () => {
  const text = caddyfile({ hosts: { insight: 'i.x', quorums: 'q.x', explorer: 'e.x', faucet: 'f.x' } });
  assert.doesNotMatch(text, /seed-|reverse_proxy https:/);
  assert.match(text, /^q\.x \{$/m);
});
