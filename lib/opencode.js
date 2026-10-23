// OpenCode service bridge — discovers the background service, authenticates,
// and exposes a tiny fetch helper for the REST API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CACHE_TTL_MS = 8000;

let cache = null; // { baseUrl, password, pinnedAt }

export function ocConfigDir() {
  const cfgHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(cfgHome, 'opencode');
}

export function ocDataDir() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode');
}

function readPassword() {
  try {
    const file = path.join(ocConfigDir(), 'service.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof j.password === 'string' && j.password.length > 0) return j.password;
  } catch { /* service.json missing */ }
  return null;
}

function statusFromCli() {
  try {
    const r = spawnSync('opencode', ['service', 'status'], {
      encoding: 'utf8',
      shell: true,          // opencode is a .cmd shim on Windows
      timeout: 15000,
    });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const m = out.match(/https?:\/\/[^\s]+/i);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

export async function discover({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.pinnedAt < CACHE_TTL_MS) return cache;
  const password = readPassword();
  if (!password) {
    const err = new Error('OpenCode service credentials not found (service.json missing).');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  let baseUrl = process.env.OPENCODE_BASE_URL || null;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) baseUrl = statusFromCli();
  if (!baseUrl) {
    cache = null;
    const err = new Error('OpenCode background service not reachable (no URL from `opencode service status`).');
    err.code = 'NO_SERVICE';
    throw err;
  }
  cache = { baseUrl: baseUrl.replace(/\/+$/, ''), password, pinnedAt: Date.now() };
  return cache;
}

export function invalidate() { cache = null; }

export async function oc(reqPath, { method = 'GET', body, headers = {}, timeoutMs = 25000, rawBody, signal } = {}) {
  const { baseUrl, password } = await discover();
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null; // <=0 = no timeout (SSE relays)
  if (signal && signal.aborted) ctrl.abort();
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const h = {
      Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
      ...headers,
    };
    if (body !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + reqPath, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
      signal: ctrl.signal,
    });
    return res;
  } catch (e) {
    const err = new Error(e.message);
    err.name = e.name;
    err.cause = e;
    err.code = e.name === 'AbortError' ? 'OC_TIMEOUT' : 'OC_UNREACHABLE';
    invalidate();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ocJson(reqPath, opts = {}) {
  const res = await oc(reqPath, opts);
  const text = await res.text();
  let data = text;
  if (res.headers.get('content-type')?.includes('json')) {
    try { data = JSON.parse(text); } catch { /* keep text */ }
  }
  if (!res.ok) {
    const err = new Error(`OpenCode API ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function authHeader() {
  return { Authorization: 'Basic ' + Buffer.from('opencode:' + readPassword()).toString('base64') };
}
