// Haxor Dashboard — local control panel for OpenCode + consent-gated ops.
// Binds to 127.0.0.1 only. No npm dependencies (Node >= 20).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oc, ocJson, authHeader, discover, invalidate } from './lib/opencode.js';
import { sessSearch } from './lib/sesssearch.js';
import * as cfg from './lib/config.js';
import * as skills from './lib/skills.js';
import * as ops from './lib/ops.js';
import { agentInstalled, installAgent, deployReconOp } from './lib/agent.js';
import * as probe from './lib/probe.js';
import * as intel from './lib/intel.js';
import * as cluster from './lib/cluster.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(here, 'public');
cfg.ensureDirs();

const PORT = Number(process.env.HAXOR_PORT || 3969);
const HOST = '127.0.0.1';

// ---------- helpers ---------------------------------------------------------

function json(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(res, e, code = 500) {
  let status = e.status || code;
  if (['ECONSENT', 'EDISARMED', 'ESCOPED'].includes(e.code)) status = 403;
  else if (['EINVAL', 'EBADJSON', 'CONFIG_PARSE'].includes(e.code)) status = 400;
  else if (e.code === 'ENOENT') status = 404;
  else if (e.code === 'EEXIST') status = 409;
  json(res, status, {
    error: e.message || String(e),
    code: e.code || undefined,
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

function static_file(res, rel) {
  const safe = path.normalize(rel).replace(/^([.][.][\/\\])+/, '');
  const full = path.join(PUB, safe);
  if (!full.startsWith(PUB)) { json(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function guard(req, res) {
  // DNS-rebinding / same-origin hardening for a localhost service (IPv4 + IPv6 loopback)
  const host = (req.headers.host || '').split(':')[0].replace(/[\[\]]/g, '');
  if (!(host === '127.0.0.1' || host === 'localhost' || host === '::1')) { json(res, 403, { error: 'localhost only' }); return false; }
  return true;
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { code: 'ETOOLARGE' });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid JSON body'), { code: 'EBADJSON' }); }
}

async function afterConfigWrite(res) {
  let reloaded = null;
  try { reloaded = await ocJson('/api/location/reload', { method: 'POST', timeoutMs: 20000 }); }
  catch (e) { reloaded = { error: String(e.message) }; }
  json(res, 200, { ok: true, reloaded });
}

// SSE open rain: shared writer
function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ping\n\n');
  const iv = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
  return () => clearInterval(iv);
}

// ---------- server ----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = u.pathname;
  try {
    if (!guard(req, res)) return;

    // CORS-style safety: state mutations need same-origin
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      const o = new URL(req.headers.origin);
      const host = (req.headers.host || '').split(':')[0];
      if (o.host.split(':')[0] !== host) { json(res, 403, { error: 'cross-origin state change refused' }); return; }
    }

    // --- static
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') return static_file(res, 'index.html');
      if (p === '/style.css') return static_file(res, 'style.css');
      if (p === '/app.js') return static_file(res, 'app.js');
      if (p.startsWith('/static/')) return static_file(res, p.slice('/static/'.length));
    }

    if (p === '/health') {
      let ok = false;
      try { await discover(); ok = true; } catch { /* not reachable */ }
      return json(res, 200, { ok, port: PORT, agents: 'v1' });
    }

    // ================= OpenCode passthrough =================
    if (p === '/oc/events') { // SSE relay of OpenCode event feed
      const close = openSse(res);
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      try {
        const upstream = await oc('/api/event', { timeoutMs: 0, signal: ac.signal });
        if (!upstream.ok) { throw new Error('upstream ' + upstream.status + ': ' + (await upstream.text()).slice(0, 200)); }
        const dec = new TextDecoder();
        for await (const chunk of upstream.body) {
          res.write(dec.decode(chunk, { stream: true }));
          if (res.socket.destroyed || ac.signal.aborted) break;
        }
      } catch (e) {
        if (!ac.signal.aborted) { try { res.write(`event: upstream-error\ndata: ${JSON.stringify({ message: e.message })}\n\n`); } catch {} }
      } finally { try { res.end(); } catch {} close(); }
      return;
    }

    if (p === '/ops/events') { // SSE of the ops engine (jobs, pipeline, lines)
      const close = openSse(res);
      const fn = (evt) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* ignore */ } };
      const off = ops.onEvent(fn);
      try {
        res.write(`data: ${JSON.stringify({ type: 'snapshot', jobs: ops.listJobs(), state: ops.state() })}\n\n`);
      } catch { /* ignore */ }
      req.on('close', () => { off(); close(); });
      return;
    }

    if (p.startsWith('/oc/')) {
      const target = p.replace(/^\/oc/, '') || '/';
      const method = req.method;
      let bodyOpts = {};
      if (!['GET', 'HEAD'].includes(method)) {
        const raw = await readBody(req);
        if (raw) bodyOpts = { rawBody: raw, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' } };
      }
      const passthroughQS = u.search || '';
      try {
        const upstreamRes = await oc(target + passthroughQS, { method, ...bodyOpts, timeoutMs: 90000 });
        const headers = {};
        for (const k of ['content-type']) if (upstreamRes.headers.get(k)) headers[k] = upstreamRes.headers.get(k);
        res.writeHead(upstreamRes.status, headers);
        if (upstreamRes.body) {
          const dec = new TextDecoder();
          for await (const chunk of upstreamRes.body) {
            res.write(dec.decode(chunk, { stream: true }));
            if (res.socket.destroyed) break;
          }
        }
        res.end();
        if (p.startsWith('/oc/config') || p.includes('/location/reload')) invalidate();
      } catch (e) {
        if (!res.headersSent) fail(res, e); else { try { res.end(`\n[upstream] ${e.message}`); } catch {} }
      }
      return;
    }

    // ================= dashboard services =================
    if (p === '/config') { // read global config file as text + parsed
      const { path: cp, text, jsonc } = cfg.readConfig();
      return json(res, 200, { path: cp, text, jsonc, backups: cfg.listBackups().slice(0, 8) });
    }
    if (p === '/config/validate') {
      const b = await readJsonBody(req);
      try { cfg.parseConfig(b.content ?? ''); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/config/save' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const result = cfg.writeConfig(String(b.content ?? ''));
      req.on('close', () => { /* nothing */ });
      await afterConfigWrite(res);
      ops.audit('config_write', { path: result.path, backup: result.backup });
      return;
    }
    if (p === '/config/restore' && req.method === 'POST') {
      const b = await readJsonBody(req);
      cfg.restoreBackup(b.file);
      await afterConfigWrite(res);
      ops.audit('config_restore', { file: b.file });
      return;
    }

    if (p === '/skills' && req.method === 'GET') return json(res, 200, { local: skills.listSkills() });
    if (p === '/skills' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const created = skills.createSkill(String(b.id || ''), b);
      ops.audit('skill_create', { id: created.id });
      return json(res, 200, created);
    }
    if (p.startsWith('/skills/')) {
      const id = decodeURIComponent(p.slice('/skills/'.length));
      if (req.method === 'GET') return json(res, 200, skills.readSkill(id));
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        const w = skills.writeSkill(id, String(b.content ?? ''));
        ops.audit('skill_write', { id });
        return json(res, 200, w);
      }
      if (req.method === 'DELETE') {
        const d = skills.deleteSkill(id);
        ops.audit('skill_delete', { id });
        return json(res, 200, d);
      }
    }

    // ================= ops =================
    if (p === '/ops/state' && req.method === 'GET') return json(res, 200, ops.state());
    if (p === '/ops/arm' && req.method === 'POST') return json(res, 200, ops.arm(await readJsonBody(req)));
    if (p === '/ops/disarm' && req.method === 'POST') return json(res, 200, ops.disarm(await readJsonBody(req)));
    if (p === '/ops/tools' && req.method === 'GET') return json(res, 200, { tools: await ops.detectTools({ force: u.searchParams.get('force') === '1' }) });
    if (p === '/ops/run' && req.method === 'POST') return json(res, 200, ops.runJob(await readJsonBody(req)));
    if (p === '/ops/pipeline' && req.method === 'POST') {
      const b = await readJsonBody(req);
      // run async; client watches /ops/events SSE
      ops.runPipeline(String(b.key || ''), { target: b.target }).catch(e => {
        ops.audit('pipeline_error', { key: b.key, error: e.message });
      });
      return json(res, 202, { started: true, key: b.key });
    }
    if (p === '/ops/jobs' && req.method === 'GET') return json(res, 200, { jobs: ops.listJobs() });
    if (p.match(/^\/ops\/jobs\/[\w-]+$/) && req.method === 'GET') return json(res, 200, ops.jobOutput(p.split('/').pop()));
    if (p.match(/^\/ops\/jobs\/[\w-]+\/kill$/) && req.method === 'POST') return json(res, 200, ops.killJob(p.split('/')[3]));
    if (p === '/ops/killall' && req.method === 'POST') { const r = ops.killAll(); ops.audit('kill_all', r); return json(res, 200, r); }
    if (p === '/ops/pipelines' && req.method === 'GET') return json(res, 200, { pipelines: ops.PIPELINES });
    if (p === '/audit' && req.method === 'GET') return json(res, 200, { lines: ops.readAudit({ tail: 300 }) });

    // ================= local sweeps / artifacts / quick probes =================
    if (p.startsWith('/ops/local/') && req.method === 'GET') {
      const kind = p.slice('/ops/local/'.length);
      const force = u.searchParams.get('force') === '1';
      return json(res, 200, await ops.localSweep(kind, { force }));
    }
    if (p === '/ops/local' && req.method === 'GET') return json(res, 200, Object.fromEntries(Object.entries(ops.LOCAL_TOOLS).map(([k, v]) => [k, { label: v.label }])));

    if (p === '/ops/artifacts' && req.method === 'GET') return json(res, 200, { artifacts: ops.listArtifacts() });
    if ((p.match(/^\/ops\/artifacts\/[\w-]+$/)) && req.method === 'GET') return json(res, 200, ops.readArtifact(p.split('/').pop()));

    if (p === '/ops/probe/dns' && req.method === 'POST') return json(res, 200, await probe.probeDNS(await readJsonBody(req)));
    if (p === '/ops/probe/http' && req.method === 'POST') return json(res, 200, await probe.probeHTTP(await readJsonBody(req)));

    // ================= sessions content search =================
    if (p === '/api/sess-search' && req.method === 'GET') return json(res, 200, await sessSearch(u.searchParams.get('q')));

    // ================= intel vault =================
    if (p === '/intel' && req.method === 'GET') return json(res, 200, { items: intel.listIntel() });
    if (p === '/intel' && req.method === 'POST') return json(res, 200, intel.addIntel(await readJsonBody(req)));
    if (p === '/intel/export' && req.method === 'GET') {
      const md = intel.exportReport();
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="haxordash-findings.md"', 'Cache-Control': 'no-store' });
      return void res.end(md);
    }
    if (p.startsWith('/intel/') && req.method === 'DELETE') {
      return json(res, 200, intel.delIntel(decodeURIComponent(p.slice('/intel/'.length).split('?')[0])));
    }

    // ================= agent deploy =================
    if (p === '/agent/state' && req.method === 'GET') return json(res, 200, await agentInstalled());
    if (p === '/agent/install' && req.method === 'POST') return json(res, 200, await installAgent());
    if (p === '/agent/deploy' && req.method === 'POST') {
      const b = await readJsonBody(req);
      return json(res, 200, await deployReconOp({ target: b.target }));
    }

    // ================= cluster mode (swarms) =================
    if (p === '/cluster/caps' && req.method === 'GET') return json(res, 200, { caps: cluster.CAPS });
    if (p === '/clusters' && req.method === 'GET') return json(res, 200, { clusters: cluster.listClusters() });
    if (p === '/cluster' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const rec = await cluster.createCluster(b);
      return json(res, 200, rec);
    }
    if (p.startsWith('/cluster/') && req.method === 'GET' && p.endsWith('/transcript')) {
      const id = p.slice('/cluster/'.length, -'/transcript'.length);
      const md = cluster.clusterTranscript(id);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + (cluster.getCluster(id)?.name || 'cluster') + '-transcript.md"', 'Cache-Control': 'no-store' });
      return void res.end(md);
    }
    if (p.startsWith('/cluster/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/cluster/'.length).split('?')[0]);
      const c = cluster.getCluster(id);
      if (!c) return json(res, 404, { error: 'cluster not found', code: 'ENOENT' });
      return json(res, 200, { ...c, pendingPermissions: await cluster.pendingPermissionsFor(c) });
    }
    if (p.startsWith('/cluster/') && p.endsWith('/launch') && req.method === 'POST') {
      const id = decodeURIComponent(p.slice('/cluster/'.length, -'/launch'.length).split('?')[0]);
      return json(res, 200, await cluster.launchCluster(id));
    }
    if (p.startsWith('/cluster/') && p.endsWith('/abort') && req.method === 'POST') {
      const id = decodeURIComponent(p.slice('/cluster/'.length, -'/abort'.length).split('?')[0]);
      return json(res, 200, cluster.abortCluster(id));
    }
    if (p.startsWith('/cluster/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/cluster/'.length).split('?')[0]);
      return json(res, 200, await cluster.deleteCluster(id));
    }

    json(res, 404, { error: 'no route', path: p });
  } catch (e) {
    if (!res.headersSent) fail(res, e);
    else { try { res.end(`\n[server error] ${e.message}`); } catch {} }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`
  ███ HAXOR DASH listening on http://${HOST}:${PORT}
  binding: loopback only · OpenCode bridge: discovered on demand
  ops engine: consent-gated · audit.log at ${path.join(here, 'data', 'audit.log') || 'data/audit.log'}
`);
});
