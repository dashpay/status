// Probes every discovered host on a fixed cadence and writes one state file per
// network. Each host result carries its own timestamp and the exact error when
// a source could not be read.
import { readFileSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { writeAtomic } from '../shared/settings.js';

const PROBE = readFileSync(new URL('./probe.py', import.meta.url), 'utf8');
const SKIP_PROBE = new Set(['vpn']);

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function tcpCheck(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = tcpConnect({ host, port, timeout: timeoutMs });
    const done = (ok, error) => { socket.destroy(); resolve({ port, ok, ms: Date.now() - start, error }); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (e) => done(false, e.code || e.message));
  });
}

export async function httpCheck(url, timeoutMs = 8000) {
  const start = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return { url, status: r.status, ok: r.status < 500, ms: Date.now() - start };
  } catch (e) {
    return { url, status: null, ok: false, ms: Date.now() - start, error: e.cause?.code || e.name || e.message };
  }
}

// Public port of the dashmate gateway (DAPI), e.g. "0.0.0.0:1443->10000/tcp".
export function gatewayPublicPort(data) {
  const gw = (data?.containers || []).find((c) => c.repo === 'dashpay/envoy' && c.running);
  if (gw?.network === 'host') return 1443; // dash-network-go gateway
  for (const p of gw?.ports || []) {
    const m = /^(0\.0\.0\.0|):(\d+)->(10000|443)\/tcp$/.exec(p);
    if (m) return Number(m[2]);
  }
  return null;
}

function protobuf(buf) {
  const fields = {};
  let i = 0;
  const varint = () => { let shift = 0n, v = 0n; for (;;) { const b = buf[i++]; v |= BigInt(b & 0x7f) << shift; if (b < 0x80) return v; shift += 7n; } };
  while (i < buf.length) {
    const key = Number(varint()), n = key >> 3, wire = key & 7;
    if (wire === 0) fields[n] = varint();
    else if (wire === 2) { const len = Number(varint()); fields[n] = buf.subarray(i, i + len); i += len; }
    else if (wire === 1) { fields[n] = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { fields[n] = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('protobuf wire type');
  }
  return fields;
}

// DAPI Platform.getStatus over gRPC-Web, as a browser SDK would call it.
export async function dapiCheck(url, timeoutMs = 8000) {
  const start = Date.now();
  try {
    const r = await fetch(new URL('/org.dash.platform.dapi.v0.Platform/getStatus', url), {
      method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: Buffer.from([0, 0, 0, 0, 2, 0x0a, 0]), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || body.length < 5 || body[0] !== 0) return { url, status: r.status, ok: false, ms: Date.now() - start, error: r.headers.get('grpc-message') || 'no gRPC message' };
    const v0 = protobuf(protobuf(body.subarray(5, 5 + body.readUInt32BE(1)))[1]);
    const version = protobuf(v0[1] || Buffer.alloc(0)), software = protobuf(version[1] || Buffer.alloc(0));
    const chain = protobuf(v0[3] || Buffer.alloc(0)), net = protobuf(v0[4] || Buffer.alloc(0));
    return { url, status: 200, ok: true, ms: Date.now() - start, height: chain[4] != null ? Number(chain[4]) : null,
      version: software[1] ? software[1].toString() : null, chainId: net[1] ? net[1].toString() : null };
  } catch (e) {
    return { url, status: null, ok: false, ms: Date.now() - start, error: e.cause?.code || e.name || e.message };
  }
}

export function createCollector({ pool, stateDir, log = console.log }) {
  const previous = new Map();

  async function probeHost(network, host) {
    const at = new Date().toISOString(), start = Date.now();
    const result = { at, ms: 0, ok: false };
    if (host.state !== 'running' || !host.publicIp) return { ...result, skipped: host.state || 'no address' };
    if (SKIP_PROBE.has(host.role)) return { ...result, skipped: 'not probed' };
    try {
      const raw = await pool.exec(host, `sudo -n python3 - ${host.role} ${host.publicIp}`, PROBE, 45_000);
      result.data = JSON.parse(raw.trim().split('\n').pop());
      result.ok = true;
    } catch (e) {
      result.error = e.message.slice(0, 300);
    }
    result.ms = Date.now() - start;
    return result;
  }

  async function collectNetwork(network, hosts, meta) {
    const results = await mapLimit(hosts, 16, async (host) => {
      const probe = await probeHost(network, host);
      const port = probe.data?.core?.masternode?.service?.split(':').pop();
      const p2p = host.state === 'running' && host.publicIp && ['validator', 'masternode', 'seed'].includes(host.role)
        ? await tcpCheck(host.publicIp, Number(port) || network.p2pPort) : null;
      const gatewayPort = gatewayPublicPort(probe.data || previous.get(`${network.name}/${host.instanceId}`)?.data);
      const dapiPublic = host.role === 'validator' && host.state === 'running' && host.publicIp && gatewayPort ? await tcpCheck(host.publicIp, gatewayPort) : null;
      const key = `${network.name}/${host.instanceId}`;
      // Keep the last successful data next to a failed attempt: the failure is
      // still the host's current status, the old values are labelled with their time.
      if (probe.ok) previous.set(key, probe);
      const last = probe.ok ? null : previous.get(key) || null;
      return { ...host, probe, lastGood: last ? { at: last.at, data: last.data } : null, p2p, dapiPublic };
    });
    const endpoints = await Promise.all((network.endpoints || []).map(async (e) => ({ label: e.label, kind: e.kind || 'http', ...(await (e.kind === 'dapi' ? dapiCheck(e.url) : httpCheck(e.url))) })));
    const state = { network: network.name, generatedAt: new Date().toISOString(), ...meta, endpoints, hosts: results };
    writeAtomic(join(stateDir, `${network.name}.json`), JSON.stringify(state));
    const failed = results.filter((h) => h.probe.error).length;
    log(`collect ${network.name}: ${results.length} hosts, ${failed} unreachable, ${Math.round(results.reduce((a, h) => Math.max(a, h.probe.ms), 0) / 100) / 10}s max`);
    return state;
  }
  return { collectNetwork };
}
