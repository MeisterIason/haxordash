// Ops engine — consent-gated execution of allowlisted security tools.
// Safety model:
//  - explicit, revocable consent ("armed" state) bound to ONE target
//  - allowlisted binaries only; spawned WITHOUT a shell => no injection
//  - args are string-validated (no pipes/redirects/continuation metacharacters)
//  - hard timeout + kill switch + append-only audit log
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, artifactsDir, ensureDirs } from './config.js';

ensureDirs();

const here = path.dirname(fileURLToPath(import.meta.url));
const auditFile = path.join(dataDir, 'audit.log');
const consentFile = path.join(dataDir, 'consent.json');

const CONSENT_TTL_MS = 12 * 60 * 60 * 1000; // auto-disarm after 12h
const ARG_BLACKLIST = /[&|;`<>\r\n^"]/;
const MAX_LINE = 4000;

export const TOOLS = {
  whoami:       { description: 'current identity (local, no network)' },
  nmap:         { description: 'port/service scanner' },
  rustscan:     { description: 'fast port scanner' },
  masscan:      { description: 'mass port scanner' },
  subfinder:    { description: 'passive subdomain discovery' },
  httpx:        { description: 'http alive/title/tech probing' },
  nuclei:       { description: 'vulnerability scanner (template-based)' },
  dig:          { description: 'DNS lookups' },
  nslookup:     { description: 'DNS lookups (Windows builtin)' },
  whatweb:      { description: 'web fingerprinting' },
  wafw00f:      { description: 'WAF detection' },
  gobuster:     { description: 'dir/DNS/vhost brute' },
  feroxbuster:  { description: 'content discovery' },
  testssl:      { description: 'TLS auditor' },
  'ssh-audit':  { description: 'ssh config audit' },
};

// Pipelines: {target} placeholder, @prev = file with previous step's stdout
export const PIPELINES = {
  recon: {
    label: 'Passive recon sweep',
    steps: [
      { tool: 'subfinder', args: '-d {target} -silent' },
      { tool: 'httpx', args: '-l @prev -silent -status-code -title -tech-detect' },
    ],
  },
  quickmap: {
    label: 'Quick port map (top 200)',
    steps: [
      { tool: 'nmap', args: '-T4 -Pn --top-ports 200 {target}' },
      { tool: 'whatweb', args: 'http://{target}' },
    ],
  },
  webscan: {
    label: 'Template web scan',
    steps: [
      { tool: 'nuclei', args: '-u http://{target} -severity low,medium,high,critical -silent' },
    ],
  },
  dnsmap: {
    label: 'DNS surface',
    steps: [
      { tool: 'dig', args: '+short {target} A' },
      { tool: 'dig', args: '+short {target} MX' },
      { tool: 'dig', args: '+short {target} NS' },
    ],
  },
};

let toolCache = { at: 0, map: {} };

export function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(consentFile, 'utf8'));
    if (s.armed && s.expiresAt && Date.now() > s.expiresAt) {
      s.armed = false;
      writeState(s);
      audit('disarm', { reason: 'ttl' });
    }
    return s;
  } catch {
    return { armed: false, target: '', scope: '', note: '', armedAt: null, expiresAt: null, pipelinesAuto: false };
  }
}

function writeState(s) {
  fs.writeFileSync(consentFile, JSON.stringify(s, null, 2), 'utf8');
}

export function arm({ target, scope, note, confirmText, pipelinesAuto }) {
  if (!target || typeof target !== 'string' || target.length > 200) {
    throw Object.assign(new Error('target required'), { code: 'EINVAL' });
  }
  const expected = `I am authorized to test ${target}`;
  if (String(confirmText || '').trim() !== expected) {
    throw Object.assign(new Error(`consent rejected: type exactly "${expected}"`), { code: 'ECONSENT' });
  }
  const fresh = loadState();
  const s = { ...fresh, armed: true, target: target.trim(), scope: scope || 'declared-scope', note: note || '', armedAt: Date.now(), expiresAt: Date.now() + CONSENT_TTL_MS };
  s.pipelinesAuto = !!pipelinesAuto;
  writeState(s);
  audit('arm', { target: s.target, scope: s.scope, note: s.note, ttlHours: 12 });
  return s;
}

export function disarm({ reason = 'manual' } = {}) {
  const cur = loadState();
  const s = { ...cur, armed: false };
  writeState(s);
  audit('disarm', { reason });
  return s;
}

export function assertArmed(target) {
  const s = loadState();
  if (!s.armed) throw Object.assign(new Error('ops are DISARMED — arm against an explicit target first'), { code: 'EDISARMED' });
  const t = String(target || '').trim();
  if (s.target && t && normalizeTarget(t) !== normalizeTarget(s.target)) {
    throw Object.assign(new Error(`target '${t}' is outside armed scope '${s.target}'`), { code: 'ESCOPED' });
  }
  return s;
}

function normalizeTarget(t) {
  return String(t).replace(/^https?:\/\//, '').replace(/\.$/, '').toLowerCase();
}

// ---- local passive sweeps (no consent gate needed — local-only intel, audited) --

export const LOCAL_TOOLS = {
  netstat: { cmd: 'netstat.exe', defaultArgs: ['-ano'], label: 'connections & listeners' },
  arp: { cmd: 'arp.exe', defaultArgs: ['-a'], label: 'arp cache' },
  tasklist: { cmd: 'tasklist.exe', defaultArgs: [], label: 'process table' },
};

const localCache = { at: 0, data: {} };

export async function localSweep(kind, { force = false } = {}) {
  const def = LOCAL_TOOLS[kind];
  if (!def) throw Object.assign(new Error('unknown local sweep kind'), { code: 'EINVAL' });
  if (!force && localCache.data[kind] && Date.now() - localCache.at < 7 * 1000) return localCache.data[kind];

  const rows = await new Promise((resolve) => {
    const out = [];
    const p = spawn(def.cmd, def.defaultArgs, { shell: false, windowsHide: true });
    let buf = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(out); }, 6000);
    p.stdout.on('data', d => { buf += d.toString(); });
    p.stderr.on('data', () => { /* ignore */ });
    p.on('close', () => {
      clearTimeout(timer);
      const lines = buf.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (/^(TCP|UDP)/i.test(t)) {
          const parts = t.split(/\s+/);
          if (parts[0].toUpperCase() === 'TCP' && parts.length >= 5) out.push({ proto: 'TCP', local: parts[1], remote: parts[2], state: parts[3], pid: Number(parts[4]) || null });
          else if (parts[0].toUpperCase() === 'UDP' && parts.length >= 4) out.push({ proto: 'UDP', local: parts[1], remote: parts[2], state: 'UDP', pid: Number(parts[3]) || null });
        } else if (kind === 'arp' && /\d+\.\d+\.\d+\.\d+/.test(line) && !/^interface/i.test(t)) {
          const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+(\S+)$/);
          if (m) out.push({ ip: m[1], mac: m[2], type: m[3] });
        } else if (kind === 'tasklist') {
          const m = line.trim().match(/^(.+?)\s{2,}(\d+)\s+(\w+)\s+(\d+)\s+(.+)?$/);
          if (m && !/^image name/i.test(m[1])) out.push({ name: m[1].trim(), pid: Number(m[2]), session: m[3], mem: (m[5] || '').trim() });
        }
      }
      resolve(out.slice(0, 500));
    });
    p.on('error', () => { clearTimeout(timer); resolve([]); });
  });

  audit('local_sweep', { kind, rows: rows.length });
  localCache.data[kind] = { kind, rows, ts: Date.now() };
  localCache.at = Date.now();
  return localCache.data[kind];
}

export function listArtifacts() {
  if (!fs.existsSync(artifactsDir)) return [];
  return fs.readdirSync(artifactsDir).filter(f => f.endsWith('.out')).map(f => {
    const st = fs.statSync(path.join(artifactsDir, f));
    return { id: f.replace(/\.out$/, ''), bytes: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 60);
}

export function readArtifact(id) {
  const safe = path.basename(String(id || ''));
  if (!/^j\d+_[\w-]+$/.test(safe)) throw Object.assign(new Error('bad artifact id'), { code: 'EINVAL' });
  const f = path.join(artifactsDir, safe + '.out');
  if (!fs.existsSync(f)) throw Object.assign(new Error('artifact not found'), { code: 'ENOENT' });
  const text = fs.readFileSync(f, 'utf8');
  return { id: safe, bytes: text.length, text: text.slice(0, 200000) };
}

export async function detectTools({ force = false } = {}) {
  if (!force && Date.now() - toolCache.at < 5 * 60 * 1000) return toolCache.map;
  const items = await Promise.all(Object.keys(TOOLS).map(async (name) => {
    try {
      const r = spawn('where.exe', [name], { shell: false, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => r.kill(), 4000);
      r.stdout.on('data', d => { out += d.toString(); });
      await new Promise((resolve) => {
        r.on('close', () => { clearTimeout(timer); resolve(); });
        r.on('error', () => { clearTimeout(timer); resolve(); });
      });
      const first = out.split(/\r?\n/).map(x => x.trim()).find(Boolean) || null;
      return [name, first];
    } catch {
      return [name, null];
    }
  }));
  toolCache = { at: Date.now(), map: Object.fromEntries(items.map(([k, exe]) => [k, { exe, ...TOOLS[k] }])) };
  return toolCache.map;
}

// ---- jobs ------------------------------------------------------------------

const jobs = new Map();
const listeners = new Set();
let seq = 0;

export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(evt) { for (const fn of listeners) { try { fn(evt); } catch { /* ignore */ } } }
// passthrough for sibling engines (cluster swarms) that emit onto the same SSE bus
export function emitExternal(evt) { emit(evt); }

export function listJobs() {
  return [...jobs.values()].map(stripJob).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
}

function stripJob(j) {
  return { id: j.id, tool: j.tool, target: j.target, args: j.args, startedAt: j.startedAt, state: j.state, exit: j.exit, pipeline: j.pipeline, step: j.step, lines: j.pipeline ? j.lines.slice(-5) : undefined };
}

export function jobOutput(id) {
  const j = jobs.get(id);
  if (!j) throw Object.assign(new Error('job not found'), { code: 'ENOENT' });
  return { ...stripJob(j), lines: j.lines };
}

export function killJob(id) {
  const j = jobs.get(id);
  if (!j || j.state !== 'running') return { id, stopped: false };
  try { j.proc && j.proc.kill(); } catch { /* ignore */ }
  j.state = 'killed';
  audit('kill', { id, tool: j.tool, target: j.target });
  emit({ type: 'job', job: stripJob(j) });
  return { id, stopped: true };
}

export function killAll() {
  let n = 0;
  for (const j of jobs.values()) if (j.state === 'running') { killJob(j.id); n++; }
  return { killed: n };
}

function emitLine(j, stream, line) {
  j.lines.push({ t: Date.now(), stream, line });
  if (j.lines.length > 5000) j.lines.splice(0, j.lines.length - 5000);
  emit({ type: 'line', id: j.id, tool: j.tool, stream, line, pipeline: j.pipeline, step: j.step });
}

function runOne({ tool, exe, argsString, target, meta = {} }) {
  if (!exe) throw Object.assign(new Error(`tool '${tool}' not installed (or not on PATH)`), { code: 'ENOENT' });
  if (ARG_BLACKLIST.test(argsString)) throw Object.assign(new Error('args contain forbidden characters (&|;`<>^ newline quote)'), { code: 'EINVAL' });

  assertArmed(target);          // same-target gate from arm(); whoami passes '' target check
  const s = loadState();
  if (tool !== 'whoami' && !s.armed) throw Object.assign(new Error('DISARMED'), { code: 'EDISARMED' });

  const argv = tokenArgs(argsString);
  const id = `j${++seq}_${Date.now().toString(36)}`;
  const j = {
    id, tool, exe, args: argv, target: target || '(local)', argv,
    argsString: argsString || '', startedAt: Date.now(), state: 'running', exit: null,
    pipeline: meta.pipeline, step: meta.step,
    lines: [], stdoutFile: path.join(artifactsDir, `${id}.out`),
    startedBy: 'dashboard', consentStamp: s.armedAt,
  };
  jobs.set(id, j);

  const proc = spawn(j.exe, argv, { shell: false, windowsHide: true, cwd: artifactsDir });
  j.proc = proc;

  let waiters;
  const done = new Promise(resolve => { waiters = resolve; });

  const piped = (stream, tag) => {
    let buf = '';
    const emitBuf = () => { if (buf.trim()) { emitLine(j, tag, buf.slice(0, MAX_LINE)); } buf = ''; };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length) emitLine(j, tag, line.slice(0, MAX_LINE));
      }
    });
    stream.on('end', emitBuf);
    stream.on('close', emitBuf);
    return stream;
  };
  piped(proc.stdout, 'stdout');
  piped(proc.stderr, 'stderr');

  const timeoutMs = Math.min(30 * 60 * 1000, 15 * 1000 + argv.length * 0); // hard cap 30min
  const timer = setTimeout(() => {
    if (j.state === 'running') {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: false }); } catch { try { proc.kill(); } catch {} }
      j.state = 'timeout';
      emitLine(j, 'sys', '⚠ hard timeout — killed by ops engine');
      audit('timeout', { id, tool: j.tool, target: j.target });
      emit({ type: 'job', job: stripJob(j) });
      waiters();
    }
  }, timeoutMs);

  proc.on('close', (code, signal) => {
    if (j.state === 'running') j.state = code === 0 ? 'done' : 'failed';
    else if (j.state === 'killed') j.state = 'killed';
    j.exit = { code, signal };
    clearTimeout(timer);
    try { fs.writeFileSync(j.stdoutFile, j.lines.filter(l => l.stream === 'stdout').map(l => l.line).join('\n'), 'utf8'); } catch { /* ignore */ }
    audit('job_end', { id, tool: j.tool, target: j.target, state: j.state, exit: j.exit });
    emit({ type: 'job', job: stripJob(j) });
    waiters();
  });

  audit('job_start', { id, tool: j.tool, target: j.target, args: argv, pipeline: meta.pipeline, step: meta.step });
  emit({ type: 'job', job: stripJob(j) });
  return { job: j, done };
}

export function runJob({ tool, args, target, artifactAccepted }) {
  const map = toolCache.at ? toolCache.map : {};
  const entry = map[tool] || TOOLS[tool];
  if (!entry) throw Object.assign(new Error(`tool '${tool}' not allowlisted`), { code: 'EINVAL' });
  const exe = (map[tool] || {}).exe || (tool === 'whoami' ? 'whoami' : null);
  if (!exe) throw Object.assign(new Error(`tool '${tool}' not detected on PATH — rescan tools`), { code: 'ENOENT' });
  const { job, done } = runOne({ tool, exe, argsString: args || '', target, meta: {} });
  return { id: job.id };
}

export async function runPipeline(key, { target }) {
  const def = PIPELINES[key];
  if (!def) throw Object.assign(new Error('unknown pipeline'), { code: 'EINVAL' });
  assertArmed(target);
  const map = toolCache.at ? toolCache.map : {};
  const missing = def.steps.filter(st => !(map[st.tool] || {}).exe);
  if (missing.length) throw Object.assign(new Error(`pipeline needs these tools on PATH: ${missing.map(m => m.tool).join(', ')}`), { code: 'ENOENT' });

  audit('pipeline_start', { key, target, steps: def.steps.length });
  emit({ type: 'pipeline', state: 'start', key, label: def.label, target });

  let prevFile = null;
  let stepIdx = 0;
  for (const step of def.steps) {
    stepIdx += 1;
    const args = interpolate(step.args, { target, prev: prevFile });
    emit({ type: 'pipeline', state: 'step', key, step: stepIdx, tool: step.tool });
    const s = loadState();
    if (!s.armed) { emit({ type: 'pipeline', state: 'aborted', key, why: 'disarmed mid-pipeline' }); audit('pipeline_abort', { key, why: 'disarmed' }); return { aborted: true }; }
    let exe = map[step.tool].exe;
    let { job, done } = runOne({ tool: step.tool, exe, argsString: args, target, meta: { pipeline: key, step: stepIdx } });
    await done;
    prevFile = job.stdoutFile;
  }
  emit({ type: 'pipeline', state: 'done', key, target });
  audit('pipeline_done', { key, target });
  return { done: true };
}

function interpolate(tpl, { target, prev }) {
  return String(tpl).replaceAll('{target}', target).replaceAll('@prev', prev ? String(prev) : '');
}

function tokenArgs(s) {
  // conservative tokenizer: split on whitespace, honor double quotes
  const out = [];
  let cur = '', inQ = false;
  for (const ch of s) {
    if (ch === ' ' && !inQ) { if (cur) out.push(cur); cur = ''; }
    else if (ch === '"') inQ = !inQ;
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ---- audit -----------------------------------------------------------------

export function audit(kind, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...data });
  try { fs.appendFileSync(auditFile, line + '\n', 'utf8'); } catch { /* ignore */ }
}

export function readAudit({ tail = 200 } = {}) {
  if (!fs.existsSync(auditFile)) return [];
  const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(-tail).reverse();
  return lines.map(l => { try { return JSON.parse(l); } catch { return { ts: '?', kind: 'corrupt', raw: l }; } });
}

export function state() {
  const s = loadState();
  return {
    ...s,
    now: Date.now(),
    expiresIn: s.armed && s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) : 0,
    jobsRunning: [...jobs.values()].filter(j => j.state === 'running').length,
  };
}
