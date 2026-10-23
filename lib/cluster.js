// CLUSTER MODE — spawn N clones of the same model (worker nodes) plus one
// orchestrator session that decomposes a mission and digests their reports.
// The dashboard is the wiring: plan → dispatch → collect → synthesize.
// Every state transition is audited and emitted onto the shared SSE bus.
//
// Safety rails: node/concurrency/task caps, per-step timeouts, abort + kill
// switch, permission policy per cluster. Never touches targets directly.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDirs } from './config.js';
import { ocJson } from './opencode.js';
import { audit, emitExternal } from './ops.js';

ensureDirs();
const file = path.join(dataDir, 'cluster.json');

export const CAPS = {
  nodes: 8, concurrency: 3, tasks: 12,
  taskText: 4000, mission: 4000,
  stepTimeoutMs: 10 * 60 * 1000,   // per node task
  planTimeoutMs: 10 * 60 * 1000,  // orchestrator planning / synthesis
  pollMs: 3000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = new Map(); // clusterId → { stop: boolean }

// ---------------------------------------------------------------- storage
function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { v: 1, clusters: [] }; }
}
function save(db) { fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8'); }
function upd(id, patch) {
  const db = load();
  const c = db.clusters.find((x) => x.id === id);
  if (!c) return null;
  Object.assign(c, patch);
  save(db);
  return c;
}

// recovery: a dashboard restart kills any running orchestration loop
(function recover() {
  try {
    const db = load();
    let changed = false;
    for (const c of db.clusters) {
      if (['planning', 'running', 'synthesizing'].includes(c.status)) {
        c.status = 'stalled';
        c.note = 'dashboard restarted mid-run — abort or delete this cluster';
        changed = true;
      }
    }
    if (changed) save(db);
  } catch { /* first boot */ }
})();

function summary(c) {
  return {
    id: c.id, name: c.name, status: c.status, note: c.note,
    model: c.model, agent: c.agent, nodes: c.nodes, concurrency: c.concurrency, policy: c.policy,
    tasksTotal: c.tasks.length,
    tasksDone: c.tasks.filter((t) => t.state === 'done').length,
    tasksFailed: c.tasks.filter((t) => t.state === 'failed').length,
    orchestratorId: c.orchestratorId,
    mission: (c.mission || '').slice(0, 180),
    createdAt: c.createdAt, launchedAt: c.launchedAt, finishedAt: c.finishedAt,
  };
}

export function listClusters() { return load().clusters.map(summary).reverse(); }
export function getCluster(id) { return load().clusters.find((x) => x.id === id) || null; }

// ---------------------------------------------------------------- oc helpers
async function msgList(sessionId) {
  const r = await ocJson(`/api/session/${sessionId}/message`);
  return Array.isArray(r) ? r : (r?.data || []);
}
const textOf = (m) => (m.content || []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');

async function mkSession(title, { agent, model }) {
  const s = await ocJson('/api/session', { method: 'POST', body: { title } });
  const id = s?.data?.id || s?.id;
  if (!id) throw new Error('session create returned no id');
  if (agent && agent !== 'build') {
    await ocJson(`/api/session/${id}/agent`, { method: 'POST', body: { agent } });
  }
  if (model) await ocJson(`/api/session/${id}/model`, { method: 'POST', body: { model } });
  return id;
}

async function sendPrompt(sessionId, text) {
  return await ocJson(`/api/session/${sessionId}/prompt`, { method: 'POST', body: { text } });
}

// returns the real timestamp of the queued user message — the marker that any
// reply from this turn must be newer than (no clock-skew offsets needed)
async function sendPromptMarked(sessionId, text) {
  const r = await sendPrompt(sessionId, text);
  return r?.data?.time?.created || (Date.now() - 1000);
}

// resolves with the final assistant text once the node goes idle past sentMs,
// with a text-stability fallback in case the idle stamp is missing
async function waitReply(sessionId, markerMs, timeoutMs, isStopped) {
  const t0 = Date.now();
  let prevKey = '', stable = 0;
  for (;;) {
    if (isStopped?.()) throw Object.assign(new Error('cluster aborted'), { code: 'EABORTED' });
    if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error('node did not finish in time'), { code: 'ETIMEOUT' });
    await sleep(CAPS.pollMs);
    let idle = 0;
    try { const s = await ocJson(`/api/session/${sessionId}`); idle = s?.data?.time?.idle || 0; } catch { /* ignore */ }
    let msgs = [];
    try { msgs = await msgList(sessionId); } catch (e) { if (e.status === 404) throw new Error('session deleted mid-run'); }
    const replies = msgs.filter((m) => m.type === 'assistant' && (m.time?.created ?? 0) >= markerMs && textOf(m).trim());
    if (!replies.length) continue;
    const text = textOf(replies[replies.length - 1]);
    if (idle >= markerMs) return text;
    const key = text.length + '|' + text.slice(0, 64);
    if (key === prevKey) { stable++; if (stable >= 2) return text; } else stable = 0;
    prevKey = key;
  }
}

// ---------------------------------------------------------------- permissions
export async function pendingPermissionsFor(c) {
  try {
    const r = await ocJson('/api/permission/request');
    const all = r?.data || [];
    const ids = new Set([c.orchestratorId, ...c.nodeIds]);
    return all.filter((p) => ids.has(p.sessionID)).map((p) => ({
      id: p.id, sessionID: p.sessionID, action: p.action, resources: p.resources || [],
    }));
  } catch { return []; }
}

async function enforcePolicy(c) {
  if (c.policy === 'manual') return;
  const pending = await pendingPermissionsFor(c);
  for (const p of pending) {
    const decision = c.policy === 'autoOnce' ? 'once' : 'reject';
    try {
      await ocJson(`/api/session/${p.sessionID}/permission/${p.id}/reply`, { method: 'POST', body: { decision } });
      audit('cluster_perm_reply', { cluster: c.id, session: p.sessionID, decision, action: p.action });
    } catch (e) { /* raced / already answered */ }
  }
}

// ---------------------------------------------------------------- planning
function extractJSON(text) {
  const s = text.indexOf('{');
  if (s < 0) return null;
  let depth = 0, inS = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inS) { if (ch === '"' && text[i - 1] !== '\\') inS = false; continue; }
    if (ch === '"') { inS = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  return null;
}

function parsePlan(text, n) {
  const cleaned = (text || '').trim();
  const js = extractJSON(cleaned);
  if (js) {
    try {
      const p = JSON.parse(js);
      const arr = Array.isArray(p) ? p : p.tasks;
      if (Array.isArray(arr) && arr.length) {
        return arr.slice(0, CAPS.tasks).map((t, i) => ({
          id: 't' + (i + 1),
          title: String(t?.title || t?.name || 'task ' + (i + 1)).slice(0, 80),
          text: String(t?.task ?? t?.description ?? t?.prompt ?? '').trim().slice(0, CAPS.taskText),
        })).filter((t) => t.text);
      }
    } catch { /* fall through */ }
  }
  // fallback: numbered list lines
  const lines = cleaned.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^\d+\s*[.):]/.test(x) && x.length > 8);
  if (lines.length >= 2) {
    return lines.slice(0, CAPS.tasks).map((x, i) => ({
      id: 't' + (i + 1), title: x.replace(/^\d+\s*[.):]\s*/, '').slice(0, 60), text: x.slice(0, CAPS.taskText),
    }));
  }
  return null;
}

const PLAN_PROMPT = (c) =>
`You are the ORCHESTRATOR of a worker swarm. You have ${c.nodes} identical worker nodes (same model as you), dispatched by an external scheduler — you cannot message them yourself.

MISSION: ${c.mission}

Decompose the mission into EXACTLY ${c.nodes} independent subtasks (one per node). Subtasks must not depend on each other's output, must each be fully self-contained (a worker knows nothing except the subtask text), and must stay strictly within the mission scope.

Reply with ONLY this JSON object and nothing else — no prose, no code fences:
{"tasks":[{"title":"<short label>","task":"<complete self-contained instructions for one worker>"}]}`;

function taskPrompt(c, t, nodeIdx) {
  return `You are node-${nodeIdx + 1} of worker swarm "${c.name}" (cluster mode).
Mission context: ${(c.mission || '').slice(0, 1500)}

YOUR SUBTASK: ${t.text}

Rules:
- Work independently; do not wait for or reference other nodes.
- Stay strictly inside the subtask scope; if a tool is needed, use it, but do not exceed the subtask.
- If genuinely blocked, say so plainly instead of guessing.
- Finish with a section '## RESULT' holding your concise final answer.`;
}

const SYNTH_PROMPT = (c) =>
`All worker nodes of your swarm for the mission below have reported back.

MISSION: ${c.mission}

NODE REPORTS:
${c.tasks.map((t, i) => `[node-${(i % c.nodes) + 1} · ${t.id}${t.state !== 'done' ? ' · ' + t.state.toUpperCase() : ''}] ${(t.result || t.error || '(no report)').slice(0, 4000)}`).join('\n\n')}

Produce the final cluster synthesis as markdown: a tight executive summary, merged findings grouped by theme, contradictions between nodes (if any), and recommended next steps. No preamble.`;

// ---------------------------------------------------------------- runner
async function runCluster(id) {
  let c = getCluster(id);
  if (!c) throw new Error('cluster vanished');
  const meta = { stop: false };
  live.set(id, meta);
  const isStopped = () => meta.stop;
  const emitC = (event, extra = {}) => emitExternal({ type: 'cluster', id, name: c.name, event, ...extra });

  try {
    // ---- planning -------------------------------------------------------
    c = upd(id, { status: 'planning' });
    emitC('planning');
    audit('cluster_plan_sent', { id, name: c.name });
    const marker = await sendPromptMarked(c.orchestratorId, PLAN_PROMPT(c));
    let planText;
    try {
      planText = await waitReply(c.orchestratorId, marker, CAPS.planTimeoutMs, isStopped);
    } catch (e) {
      if (e.code === 'EABORTED') throw e;
      // one reformulation retry
      emitC('planning-retry');
      const retryOk = await (async () => {
        try {
          const m2 = await sendPromptMarked(c.orchestratorId, 'Your last message was not a valid JSON plan object. Reply again with ONLY the JSON object: {"tasks":[{"title":"...","task":"..."}]} — one entry per worker, nothing else.');
          planText = await waitReply(c.orchestratorId, m2, CAPS.planTimeoutMs, isStopped);
          return true;
        } catch { return false; }
      })();
      if (!retryOk) throw new Error('orchestrator failed to produce a plan');
    }
    const tasks = parsePlan(planText, c.nodes);
    if (!tasks || !tasks.length) throw new Error('could not parse orchestrator plan');
    for (const t of tasks) { t.state = 'pending'; t.nodeId = null; t.result = ''; t.error = ''; }
    c = upd(id, { status: 'running', tasks });
    audit('cluster_plan', { id, tasks: tasks.length, titles: tasks.map((t) => t.title).slice(0, 12) });
    emitC('plan', { tasks: tasks.length });

    // ---- dispatch (worker pool) ----------------------------------------
    const pendingQ = [...tasks];
    const busy = new Map(); // nodeId → task
    let rr = 0;
    let dispatchErr = null;

    const runTask = async (t, nodeId) => {
      const idx = c.nodeIds.indexOf(nodeId);
      t.nodeId = nodeId;
      t.state = 'running'; t.startedAt = Date.now();
      upd(id, { tasks }); // mutation-by-reference; save() snapshot
      emitC('task-start', { taskId: t.id, node: idx + 1, title: t.title });
      audit('cluster_task_start', { id, task: t.id, node: idx + 1 });
      try {
        let marker = 0, sent = false, lastErr = null;
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          try { marker = await sendPromptMarked(nodeId, taskPrompt(c, t, idx)); sent = true; }
          catch (e) {
            lastErr = e;
            if (e.status === 409) { await sleep(4000); continue; } // node still busy — wait for it
            throw e;
          }
        }
        if (!sent) throw lastErr || new Error('dispatch failed');
        const text = await waitReply(nodeId, marker, CAPS.stepTimeoutMs, isStopped);
        t.state = 'done'; t.result = String(text).slice(0, 24000);
        audit('cluster_task_done', { id, task: t.id, node: idx + 1, chars: t.result.length });
        emitC('task-done', { taskId: t.id, node: idx + 1 });
      } catch (e) {
        t.state = 'failed';
        t.error = (e.code === 'EABORTED' ? 'aborted' : (e.message || String(e))).slice(0, 300);
        if (e.code === 'EABORTED') dispatchErr = dispatchErr || e;
        audit('cluster_task_fail', { id, task: t.id, node: idx + 1, error: t.error });
        emitC('task-fail', { taskId: t.id, node: idx + 1, error: t.error });
      } finally {
        t.endedAt = Date.now();
        busy.delete(nodeId);
        upd(id, { tasks });
      }
    };

    for (;;) {
      if (isStopped()) break;
      if (!pendingQ.length && busy.size === 0) break;
      while (busy.size < c.concurrency && pendingQ.length && !isStopped()) {
        // pick a free node, round-robin
        let nodeId = null;
        for (let k = 0; k < c.nodeIds.length; k++) {
          const cand = c.nodeIds[(rr + k) % c.nodeIds.length];
          if (!busy.has(cand)) { nodeId = cand; rr = (rr + k + 1) % c.nodeIds.length; break; }
        }
        if (!nodeId) break;
        const t = pendingQ.shift();
        busy.set(nodeId, t);
        runTask(t, nodeId).catch(() => { /* handled in finally */ });
      }
      await enforcePolicy(c);
      await sleep(1500);
    }
    c = getCluster(id);
    if (isStopped()) throw Object.assign(new Error('cluster aborted'), { code: 'EABORTED' });

    // ---- synthesis ------------------------------------------------------
    const doneCount = c.tasks.filter((t) => t.state === 'done').length;
    if (!doneCount) throw new Error('no worker produced a result');
    c = upd(id, { status: 'synthesizing' });
    emitC('synthesizing');
    try {
      const sMarker = await sendPromptMarked(c.orchestratorId, SYNTH_PROMPT(c));
      const syn = await waitReply(c.orchestratorId, sMarker, CAPS.planTimeoutMs, isStopped);
      upd(id, { synthesis: String(syn).slice(0, 40000) });
      emitC('synthesis-done');
      audit('cluster_synthesis', { id, chars: String(syn).length });
    } catch (e) {
      if (e.code === 'EABORTED') throw e;
      upd(id, { note: 'synthesis step failed: ' + (e.message || '').slice(0, 160) });
      emitC('synthesis-fail', { message: e.message });
    }

    c = upd(id, { status: 'done', finishedAt: new Date().toISOString() });
    emitC('done');
    audit('cluster_done', { id, tasks: c.tasks.length, done: doneCount });
  } catch (e) {
    const stopped = e.code === 'EABORTED';
    upd(id, stopped
      ? { status: 'aborted', finishedAt: new Date().toISOString(), note: (c?.note || '') }
      : { status: 'failed', finishedAt: new Date().toISOString(), note: (e.message || String(e)).slice(0, 300) });
    emitC(stopped ? 'aborted' : 'failed', { message: e.message });
    if (!stopped) audit('cluster_fail', { id, error: (e.message || '').slice(0, 200) });
    else audit('cluster_abort', { id });
  } finally {
    live.delete(id);
  }
}

// ---------------------------------------------------------------- public ops
export async function createCluster({ name, mission, model, agent = 'build', nodes = 3, concurrency = 1, policy = 'manual' }) {
  const slug = String(name || 'swarm').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'swarm';
  const n = Math.max(1, Math.min(CAPS.nodes, Number(nodes) || 3));
  const cc = Math.max(1, Math.min(CAPS.concurrency, Number(concurrency) || 1));
  const pol = ['manual', 'autoOnce', 'strict'].includes(policy) ? policy : 'manual';
  if (!mission || typeof mission !== 'string' || !mission.trim()) throw Object.assign(new Error('mission required'), { code: 'EINVAL' });
  const msn = String(mission).trim().slice(0, CAPS.mission);
  let mdl = null;
  if (model && (model.id || model.modelID)) {
    mdl = { id: String(model.id || model.modelID).slice(0, 140), providerID: String(model.providerID || '').slice(0, 60) };
    if (!mdl.providerID || !mdl.id) throw Object.assign(new Error('model needs id + providerID'), { code: 'EINVAL' });
  }
  if (agent && typeof agent !== 'string') throw Object.assign(new Error('bad agent'), { code: 'EINVAL' });
  const ag = String(agent || 'build').slice(0, 40);

  const id = 'cl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const orchestratorId = await mkSession(`⌬ cluster ${slug} → orchestrator`, { agent: ag, model: mdl });
  const nodeIds = [];
  for (let i = 1; i <= n; i++) nodeIds.push(await mkSession(`⌬ cluster ${slug} → node-${i}`, { agent: ag, model: mdl }));

  const rec = {
    id, name: slug, mission: msn, model: mdl, agent: ag, nodes: n, concurrency: cc, policy: pol,
    orchestratorId, nodeIds, tasks: [], synthesis: '',
    status: 'draft', note: '', createdAt: new Date().toISOString(), launchedAt: null, finishedAt: null,
  };
  const db = load(); db.clusters.push(rec); save(db);
  audit('cluster_create', { id, name: slug, nodes: n, agent: ag, model: mdl?.id || '(service default)', policy: pol });
  emitExternal({ type: 'cluster', id, event: 'created', name: slug, nodes: n });
  return rec;
}

export async function launchCluster(id) {
  const c = getCluster(id);
  if (!c) throw Object.assign(new Error('cluster not found'), { code: 'ENOENT' });
  if (['planning', 'running', 'synthesizing'].includes(c.status)) throw Object.assign(new Error('cluster already running'), { code: 'ECONFLICT' });
  live.delete(id);
  upd(id, { status: 'planning', note: '', launchedAt: new Date().toISOString() });
  audit('cluster_launch', { id, name: c.name });
  runCluster(id).catch(() => { /* runCluster handles its own failures */ });
  return getCluster(id);
}

export function abortCluster(id) {
  const c = getCluster(id);
  if (!c) throw Object.assign(new Error('cluster not found'), { code: 'ENOENT' });
  const meta = live.get(id);
  if (meta) meta.stop = true;
  upd(id, { status: 'aborted', finishedAt: new Date().toISOString() });
  audit('cluster_abort_requested', { id, name: c.name });
  // interrupt any in-flight generation in the swarm (best effort)
  (async () => {
    for (const sid of [c.orchestratorId, ...c.nodeIds]) {
      try { await ocJson(`/api/session/${sid}/interrupt`, { method: 'POST' }); } catch { /* likely idle already */ }
    }
    emitExternal({ type: 'cluster', id, event: 'aborted', name: c.name });
  })();
  return getCluster(id);
}

export async function deleteCluster(id) {
  const c = getCluster(id);
  if (!c) throw Object.assign(new Error('cluster not found'), { code: 'ENOENT' });
  const meta = live.get(id);
  if (meta) meta.stop = true;
  audit('cluster_delete', { id, name: c.name });
  await sleep(250); // give the runner loop a tick to observe the stop flag
  for (const sid of [c.orchestratorId, ...c.nodeIds]) {
    try { await ocJson(`/api/session/${sid}/interrupt`, { method: 'POST' }); } catch { /* ignore */ }
  }
  for (const sid of [c.orchestratorId, ...c.nodeIds]) {
    try { await ocJson(`/api/session/${sid}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  const db = load();
  db.clusters = db.clusters.filter((x) => x.id !== id);
  save(db);
  emitExternal({ type: 'cluster', id, event: 'deleted', name: c.name });
  return { deleted: true };
}

export function clusterTranscript(id) {
  const c = getCluster(id);
  if (!c) throw Object.assign(new Error('cluster not found'), { code: 'ENOENT' });
  const out = [];
  out.push(`# cluster "${c.name}" — transcript`);
  out.push(`_cluster ${c.id} · model ${c.model ? c.model.providerID + '/' + c.model.id : '(service default)'} · agent ${c.agent} · policy ${c.policy} · ${c.nodes} node(s) · created ${c.createdAt}_`);
  out.push('');
  out.push('## mission');
  out.push(c.mission);
  out.push('');
  out.push('## plan + node reports');
  for (const t of c.tasks) {
    const node = t.nodeId ? 'node-' + (c.nodeIds.indexOf(t.nodeId) + 1) : 'unassigned';
    out.push(`### ${t.id} · ${t.title} · ${node} · ${t.state}`);
    if (t.result) { out.push(''); out.push(t.result); }
    else if (t.error) { out.push(''); out.push('> failed: ' + t.error); }
    out.push('');
  }
  if (c.synthesis) {
    out.push('## orchestrator synthesis');
    out.push('');
    out.push(c.synthesis);
    out.push('');
  }
  out.push('---');
  out.push('_generated by HAXORDASH cluster mode · report only what was explicitly authorized_');
  return out.join('\n');
}
