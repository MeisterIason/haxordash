// Quick probes — work with zero external tools installed (pure Node).
// Gate: the same consent rules as tool jobs; every probe is audited.
import net from 'node:net';
import dnsPromises from 'node:dns/promises';
import { assertArmed, audit } from './ops.js';

// Accepts only a bare hostname, dotted IPv4, or [bracketed] IPv6.
// Ports, paths, spaces and shell characters are rejected outright —
// nothing here ever reaches a shell anyway, but strict input is the posture.
function targetHost(raw) {
  const s = String(raw || '').trim().replace(/^https?:\/\//i, '');
  const m = s.match(/^\[([\da-fA-F:]+)\]$/) || s.match(/^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*)$/);
  if (!m) throw Object.assign(new Error('invalid target — use a bare host/IP (no ports, paths or special chars)'), { code: 'EINVAL' });
  const host = m[1];
  if (!net.isIP(host) && !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
    throw Object.assign(new Error('not a valid hostname'), { code: 'EINVAL' });
  }
  return { host, literal: net.isIP(host) };
}

export async function probeDNS({ target }) {
  const { host, literal } = targetHost(target);
  assertArmed(host);
  const res = { target: host, ts: new Date().toISOString(), ipLiteral: literal };
  const wrap = async (label, fn) => { try { res[label] = await fn(); } catch (e) { res[label] = { error: e.code || e.message }; } };
  if (!literal) {
    await Promise.all([
      wrap('a', () => dnsPromises.resolve4(host)),
      wrap('aaaa', () => dnsPromises.resolve6(host)),
      wrap('mx', () => dnsPromises.resolveMx(host)),
      wrap('ns', () => dnsPromises.resolveNs(host)),
      wrap('txt', () => dnsPromises.resolveTxt(host)),
      wrap('soa', () => dnsPromises.resolveSoa(host)),
      wrap('cname', () => dnsPromises.resolveCname(host)),
    ]);
  } else {
    res.note = 'target is an IP literal — no record lookups; doing reverse lookup only';
  }
  await wrap('reverse', () => dnsPromises.reverse(host));
  audit('probe_dns', { target: host, literal });
  return res;
}

export async function probeHTTP({ target }) {
  const { host } = targetHost(target);
  assertArmed(host);
  const result = { target: host, attempts: [], ts: new Date().toISOString() };
  for (const scheme of ['https', 'http']) {
    const full = `${scheme}://${host}/`;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(full, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'haxordash-probe/1.0' } });
      let title = null, bytes = 0;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('html')) {
        try {
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (buf.length < 65536) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            buf += dec.decode(value, { stream: true });
            if (/<\/title>/i.test(buf)) break;
          }
          try { await reader.cancel(); } catch { /* ignore */ }
          title = (buf.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
        } catch { /* ignore */ }
      } else {
        bytes = Number(r.headers.get('content-length') || 0);
      }
      clearTimeout(timer);
      result.attempts.push({
        url: full, status: r.status, ok: r.ok,
        elapsedMs: Date.now() - t0, bytes, title,
        server: r.headers.get('server'),
        powered: r.headers.get('x-powered-by'),
        security: Object.fromEntries(['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options'].map(h => [h, r.headers.get(h)])),
        finalUrl: r.url,
      });
      if (r.ok || r.status < 500) break; // got a http answer; no fallback needed
    } catch (e) {
      clearTimeout(timer);
      result.attempts.push({ url: full, error: e.name === 'AbortError' ? 'timeout 8s' : (e.cause?.code || e.message), elapsedMs: Date.now() - t0 });
    }
  }
  audit('probe_http', { target: host, status: result.attempts[0]?.status });
  return result;
}
