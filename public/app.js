/* HAXORDASH frontend */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 90) return s + 's';
  const m = Math.floor(s / 60); if (m < 90) return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
};

// ---------- low level api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.code = data.code; e.status = res.status;
    throw e;
  }
  return data;
}
const get = (p) => api(p);
const post = (p, body = {}) => api(p, { method: 'POST', body });
const put = (p, body) => api(p, { method: 'PUT', body });
const del = (p) => api(p, { method: 'DELETE' });

function toast(msg, kind = 'ok', ms = 4200) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const toastErr = (e) => toast(e.message || String(e), 'err', 6500);

async function withSpin(btn, fn, label) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label || 'run…';
  try { return await fn(); }
  catch (e) { toastErr(e); return undefined; }
  finally { btn.disabled = false; btn.textContent = old; renderHeader(); }
}

function openModal(title, node) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body'); body.innerHTML = ''; body.appendChild(node);
  $('#modal').showModal();
}
$('#modal-x').addEventListener('click', () => $('#modal').close());

// ---------- header / clock ----------
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString(); }, 1000);

let armState = { armed: false };
setInterval(() => {
  if (armState.armed && armState.expiresAt) {
    const left = Math.max(0, armState.expiresAt - Date.now());
    $('#arm-text').textContent = `ARMED ${armState.target} · ${fmtDur(left)}`;
  }
}, 1000);

async function renderHeader() {
  try {
    const h = await get('/health');
    $('#oc-pill').innerHTML = `<i class="dot ${h.ok ? 'on' : 'off'}"></i> opencode ${h.ok ? 'linked' : 'unreachable'}`;
  } catch { $('#oc-pill').innerHTML = '<i class="dot off"></i> opencode unreachable'; }
  try { armState = (await get('/ops/state')); } catch { armState = { armed: false }; }
  renderArmPill();
}
function setOcOff() { $('#oc-pill').innerHTML = '<i class="dot off"></i> opencode unreachable'; }
function renderArmPill() {
  const pill = $('#arm-pill');
  if (armState.armed) {
    pill.hidden = false;
    pill.innerHTML = '<i class="dot armed"></i><span id="arm-text">ARMED</span>';
    $('#arm-text').textContent = `ARMED ${armState.target} · ${fmtDur(armState.expiresIn)}`;
  } else pill.hidden = true;
}
renderHeader();

// ---------- event feed ----------
const feed = $('#feed-body');
const feedLines = [];
function feedLine(cls, text) {
  feedLines.push({ cls, text });
  if (feedLines.length > 300) feedLines.splice(0, feedLines.length - 300);
  if (feed.classList.contains('hidden')) return;
  feed.innerHTML = feedLines.map(l => `<div class="feed-line ${l.cls}">${esc(l.text).slice(0, 500)}</div>`).join('');
  feed.scrollTop = feed.scrollHeight;
}
$('#feed-clear').addEventListener('click', () => { feedLines.length = 0; feed.innerHTML = ''; });
$('#feed-toggle').addEventListener('click', () => {
  const f = $('#feed'); f.classList.toggle('min');
  $('#feed-toggle').textContent = f.classList.contains('min') ? '▴' : '▾';
});

// ops SSE
try {
  const opsEs = new EventSource('/ops/events');
  opsEs.onmessage = (m) => {
    let evt; try { evt = JSON.parse(m.data); } catch { return; }
    if (evt.type === 'line') {
      feedLine('fe-ops', `[${evt.tool}] ${evt.line}`);
      pushOpsLine(evt);
    } else if (evt.type === 'job') { feedLine('fe-ops', `[job:${evt.job.id}] ${evt.job.tool} → ${evt.job.state} ${evt.job.pipeline || ''}`); updateJobRow(evt.job); }
    else if (evt.type === 'pipeline') { feedLine('fe-warn', `pipeline ${evt.key}: ${evt.state} ${evt.tool ? '· ' + evt.tool : ''} ${evt.step ? '#' + evt.step : ''}`); pushPipelineStatus(evt); }
    else if (evt.type === 'cluster') {
      feedLine(evt.event === 'failed' || evt.event === 'task-fail' ? 'fe-warn' : 'fe-ops',
        `[cluster ${evt.name || evt.id}] ${evt.event}${evt.message ? ' — ' + evt.message : ''}${evt.tasks != null ? ' · ' + evt.tasks + ' tasks' : ''}`);
    }
    else if (evt.type === 'snapshot') { armState = evt.state; renderArmPill(); }
  };
  opsEs.onerror = () => feedLine('fe-warn', 'ops stream disconnected — retrying');
} catch { /* silent */ }

// opencode upstream SSE
try {
  const ocEs = new EventSource('/oc/events');
  ocEs.onmessage = (m) => {
    if (!m.data || !m.data.trim()) return;
    try {
      const d = JSON.parse(m.data);
      const name = d.type || d.event || d.name || 'event';
      const blob = m.data;
      const warn = /permission|approval|question/i.test(name);
      feedLine(warn ? 'fe-warn' : 'fe-op', `[oc] ${name} · ${blob.length > 220 ? blob.slice(0, 220) + '…' : blob}`);
      if (warn) feedLine('fe-warn', '     └ open SESSIONS tab to review requested permissions');
    } catch { feedLine('fe-op', '[oc] ' + m.data.slice(0, 200)); }
  };
  ocEs.onerror = () => feedLine('fe-op', '[oc] event stream disconnected — retrying');
} catch { /* silent */ }

// ---------- tabs ----------
const tabState = { sessionsSel: null, ops: { lines: [], jobs: new Map(), pipeLast: {} }, mcpCache: null, refreshTimers: [] };
let currentTab = null;

function switchTab(tab) {
  currentTab = tab;
  tabState.refreshTimers.forEach(clearInterval); tabState.refreshTimers = [];
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const main = $('#main'); main.innerHTML = '';
  const mains = {
    status: () => renderStatus(main),
    sessions: () => renderSessions(main),
    mcp: () => renderMcp(main),
    skills: () => renderSkills(main),
    vault: () => renderVault(main),
    cluster: () => renderCluster(main),
    plugins: () => renderPlugins(main),
    config: () => renderConfig(main),
    ops: () => renderOps(main),
    audit: () => renderAudit(main),
  };
  (mains[tab] || (() => {}))();
}
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function panel(title, actions) {
  const p = document.createElement('section'); p.className = 'panel';
  const h = document.createElement('div'); h.className = 'panel-head';
  h.innerHTML = `<span>▊ ${esc(title)}</span>`;
  const r = document.createElement('div'); h.appendChild(r);
  if (actions) actions(r);
  p.appendChild(h);
  return p;
}
const pad = (p) => { const d = document.createElement('div'); d.className = 'pad'; p.appendChild(d); return d; };

// ---------- STATUS ----------
async function renderStatus(main) {
  const wrap = pad(panel('vitals'));
  wrap.innerHTML = '<div class="blink muted">probing opencode…</div>';
  let info = null, agents = [], providers = [], mcps = [], proj = [], localSkills = [], modelDef = null;
  const errs = [];
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { errs.push(label + ': ' + e.message); return []; } };
  [info] = [await safe('api/info', () => get('/oc/api/info').then(r => r))];
  agents = await safe('agents', () => get('/oc/api/agent').then(r => r.data || []));
  providers = await safe('providers', () => get('/oc/api/provider').then(r => r.data || []));
  mcps = await safe('mcps', () => get('/oc/api/mcp').then(r => r.data || []));
  proj = await safe('projects', () => get('/oc/api/project').then(r => r.data || []));
  localSkills = await safe('skills', () => get('/skills').then(r => r.local || []));
  modelDef = await safe('model', () => get('/oc/api/model/default').then(r => r.data || r));

  const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  wrap.innerHTML = `
    <dl class="status-kv">
      ${kv('service', info ? `v${esc(info.version)} · pid ${esc(info.pid)} · <span class="muted">${esc(info.urls?.[0] || '')}</span>` : '<span class="muted">unreachable</span>')}
      ${kv('default model', modelDef ? esc(`${modelDef.providerID ?? modelDef.provider ?? ''} / ${modelDef.modelID ?? modelDef.model ?? modelDef.id ?? JSON.stringify(modelDef).slice(0, 60)}`) : '<span class="muted">—</span>')}
      ${kv('agents', agents.length + ' · ' + esc(agents.map(a => a.id).join(', ')))}
      ${kv('providers', providers.length + ' connected')}
      ${kv('mcp servers', mcps.length + ' ' + (mcps.map(m => esc(m.name) + ':' + esc(m.status?.status || '?')).join(', ') || '<span class=muted>none</span>'))}
      ${kv('local skills', String(localSkills.length))}
      ${kv('projects', String(proj.length))}
    </dl>
    ${errs.length ? `<div class="muted small" style="margin-top:8px">${errs.map(esc).join('<br>')}</div>` : ''}
  `;

  // agent roster
  const rosterP = panel('agent roster');
  const roster = pad(rosterP);
  roster.innerHTML = `<table><thead><tr><th>agent</th><th>mode</th><th>description</th></tr></thead><tbody>
    ${agents.map(a => `<tr><td><span class="accent">${esc(a.id)}</span></td><td><span class="badge ${a.mode === 'primary' ? 'ok' : 'idle'}">${esc(a.mode || '')}</span></td><td class="muted">${esc((a.description || '').slice(0, 110))}</td></tr>`).join('')}
  </tbody></table>`;
  main.appendChild(rosterP);

  // token ledger across all sessions
  const ledSess = await safe('token ledger', () => get('/oc/api/session?limit=200').then(r => r.data || []));
  const tot = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  for (const sx of ledSess) {
    tot.input += sx.tokens?.input || 0; tot.output += sx.tokens?.output || 0;
    tot.reasoning += sx.tokens?.reasoning || 0; tot.cacheRead += sx.tokens?.cache?.read || 0;
  }
  const kfmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const top5 = ledSess.slice().sort((a, b) => ((b.tokens?.input || 0) + (b.tokens?.output || 0)) - ((a.tokens?.input || 0) + (a.tokens?.output || 0))).slice(0, 5);
  const ledgerP = panel('token ledger · all sessions');
  const ledger = pad(ledgerP);
  ledger.innerHTML = `
    <div class="row" style="gap:18px;margin-bottom:6px">
      <span>in <b>${kfmt(tot.input)}</b></span><span>out <b>${kfmt(tot.output)}</b></span>
      <span>reasoning <b>${kfmt(tot.reasoning)}</b></span><span>cache-read <b>${kfmt(tot.cacheRead)}</b></span>
      <span class="muted small">· ${ledSess.length} session(s)</span>
    </div>
    <table><tbody>${top5.map(sx => `<tr>
      <td class="small">${esc((sx.title || sx.id || '?').slice(0, 52))}</td>
      <td class="muted small" style="text-align:right;white-space:nowrap">in ${kfmt(sx.tokens?.input || 0)} · out ${kfmt(sx.tokens?.output || 0)}</td>
    </tr>`).join('') || '<tr><td class="muted">no sessions yet</td></tr>'}</tbody></table>`;
  main.appendChild(ledgerP);

  // quick links
  const quickP = panel('quick actions');
  const quick = pad(quickP);
  quick.innerHTML = '';
  const row = document.createElement('div'); row.className = 'row';
  const bSess = document.createElement('button'); bSess.className = 'btn'; bSess.textContent = '⌨ open sessions'; bSess.addEventListener('click', () => switchTab('sessions'));
  const bOps = document.createElement('button'); bOps.className = 'btn warn'; bOps.textContent = '☠ ops console'; bOps.addEventListener('click', () => switchTab('ops'));
  const bVlt = document.createElement('button'); bVlt.className = 'btn'; bVlt.textContent = '★ intel vault'; bVlt.addEventListener('click', () => switchTab('vault'));
  const bCf = document.createElement('button'); bCf.className = 'btn'; bCf.textContent = '▤ edit config'; bCf.addEventListener('click', () => switchTab('config'));
  row.append(bSess, bOps, bVlt, bCf);
  quick.appendChild(row);
  main.appendChild(quickP);
}

// ---------- SESSIONS ----------
async function renderSessions(main) {
  const g = document.createElement('div'); g.className = 'sess-grid'; main.appendChild(g);
  const left = panel('sessions');
  const right = panel('session viewer');

  const listWrap = pad(left);

  async function refreshList() {
    let rows = [];
    try { rows = (await get('/oc/api/session?limit=60&order=desc')).data || []; }
    catch (e) { listWrap.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    const q = (listWrap.querySelector('#sess-filter')?.value || '').toLowerCase();
    const el = listWrap.querySelector('#sess-list') || document.createElement('div');
    el.id = 'sess-list'; el.className = 'sess-list';
    el.innerHTML = rows.filter(s => !q || JSON.stringify(s).toLowerCase().includes(q)).map(s => {
      const t = esc(s.title || s.id);
      const upd = s.time?.updated ? fmtTime(s.time.updated) : '';
      const tk = s.tokens ? ` · ~${Math.round(s.tokens.input / 1000)}k in / ${Math.round(s.tokens.output / 1000)}k out` : '';
      return `<div class="sess-item ${tabState.sessionsSel === s.id ? 'sel' : ''}" data-id="${esc(s.id)}">
        <div>${t}${s.agent ? ` <span class="badge idle">${esc(s.agent || '')}</span>` : ''}</div>
        <div class="sid">${esc(s.id)} · ${upd}${tk}</div>
      </div>`;
    }).join('');
    if (!el.isConnected) { listWrap.innerHTML = `<div class="row"><input id="sess-filter" placeholder="filter sessions…" style="flex:1"></div>`; listWrap.appendChild(el); listWrap.querySelector('#sess-filter').addEventListener('input', refreshList); }
    el.querySelectorAll('.sess-item').forEach(x => x.addEventListener('click', () => { tabState.sessionsSel = x.dataset.id; openSession(x.dataset.id); }));
  }
  listWrap.addEventListener('click', async (e) => {
    if (e.target.dataset?.act === 'refresh') await refreshList();
    if (e.target.dataset?.act === 'new') await withSpin(e.target, async () => {
      const r = await post('/oc/api/session', { title: 'haxordash session' });
      await refreshList(); toast('session created ' + (r.data?.id || r.id || '(refresh failed)'));
    });
  });
  listWrap.innerHTML = `<div class="row" style="margin-bottom:8px"><button class="btn tiny" data-act="new">＋ new</button><button class="btn tiny" data-act="refresh">⟳ refresh</button></div><div id="sess-list"><div class="muted">loading…</div></div>`;
  refreshList();
  if (tabState.sessionsSel) openSession(tabState.sessionsSel).catch(() => {}); // e.g. after deploy from OPS tab

  const rwrap = document.createElement('div'); rwrap.appendChild(right); g.append(left, rwrap);
  const rbody = document.createElement('div'); rbody.className = 'pad'; right.appendChild(rbody);
  rbody.innerHTML = '<div class="muted">select a session</div>';

  async function openSession(id) {
    tabState.sessionsSel = id;
    listWrap.querySelectorAll('.sess-item').forEach(x => x.classList.toggle('sel', x.dataset.id === id));
    if (rbody.dataset.session !== id) { rbody.innerHTML = '<div class="blink muted">loading messages…</div>'; rbody.dataset.session = id; }

    let items = [];
    try { const r = await get(`/oc/api/session/${id}/message`); items = Array.isArray(r) ? r : (r.data || []); }
    catch (e) { rbody.innerHTML = `<div class="muted">viewer: ${esc(e.message)}</div>`; return; }
    items = (items || []).filter(Boolean);

    // v2 shape: {id, type: 'user'|'assistant', time:{created}, content:[{type:'text'|'reasoning'|'tool', ...}]}
    const fmtParts = (parts = []) => parts.map(p => {
      if (!p) return '';
      if (p.type === 'text' && p.text) return p.text;
      if (p.type === 'reasoning' && p.text) return '◌ reasoning ' + '·'.repeat(4) + '\n' + String(p.text).slice(0, 1200);
      if (p.type === 'tool') {
        const cmd = p.state?.input?.command ?? p.input;
        return `[${p.name || 'tool'}${p.state?.status ? ':' + p.state.status : ''}] ${typeof cmd === 'string' ? cmd : JSON.stringify(cmd || {}).slice(0, 200)}`;
      }
      if (p.text) return String(p.text).slice(0, 400);
      return JSON.stringify(p).slice(0, 160);
    }).filter(Boolean);

    const html = items.map(m => {
      const role = m.type || m.role || '?';
      const who = ({ assistant: 'agent', user: 'operator', tool: 'tool' })[role] || role;
      const body = fmtParts(m.content || m.parts || []).join('\n');
      if (!body.trim()) return '';
      const t = m.time?.created ?? m.time;
      const when = t ? new Date(t).toLocaleString() : '';
      const roleCls = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'tool';
      return `<div class="msg ${roleCls}"><div class="msg-head">${esc(who)} · ${esc(when)}${m.agent ? ' · ' + esc(m.agent) : ''}</div><div class="msg-body">${esc(body).slice(0, 14000)}</div></div>`;
    }).join('') || '<div class="muted">no visible messages</div>';

    const sig = items.length + ':' + html.replace(/\s+/g, ' ').length;
    if (rbody.dataset.sig === sig) return;      // poll: skip identical re-render
    rbody.dataset.sig = sig;
    rbody.innerHTML = html;

    // port permissions requests for this session
    try {
      const perms = (await get(`/oc/api/permission/request`)).data || [];
      const mine = perms.filter(p => p.sessionID === id);
      if (mine.length) {
        const box = document.createElement('div'); box.className = 'panel'; box.style.padding = '8px';
        box.innerHTML = `<div class="small" style="color:var(--amb)">⚠ pending permission requests</div>` + mine.map(p =>
          `<div class="row" style="margin-top:6px"><span class="badge auto">${esc(p.action || '')}</span><code>${esc((p.resources || []).join(', ').slice(0, 120))}</code></div>`).join('');
        rbody.prepend(box);
        const tr = document.createElement('div'); tr.className = 'row'; tr.style.marginTop = '6px';
        const yes = document.createElement('button'); yes.className = 'btn tiny'; yes.textContent = 'allow (once)';
        yes.addEventListener('click', async () => { try { await post(`/oc/api/session/${id}/permission/${mine[0].id}/reply`, { decision: 'once' }); toast('permission granted'); openSession(id); } catch (e) { toastErr(e); } });
        const no = document.createElement('button'); no.className = 'btn kill tiny'; no.textContent = 'reject';
        no.addEventListener('click', async () => { try { await post(`/oc/api/session/${id}/permission/${mine[0].id}/reply`, { decision: 'reject' }); toast('permission rejected'); openSession(id); } catch (e) { toastErr(e); } });
        tr.append(yes, no); box.appendChild(tr);
      }
    } catch { /* optional */ }
  }

  // composer
  const composer = document.createElement('div'); composer.className = 'row'; composer.style.marginTop = '8px';
  const ta = document.createElement('textarea'); ta.id = 'sess-input'; ta.rows = 2; ta.placeholder = 'prompt the selected session… (Enter = send, Shift+Enter = newline)';
  ta.style.flex = '1';
  const send = document.createElement('button'); send.className = 'btn'; send.textContent = 'send ▸';
  const interrupt = document.createElement('button'); interrupt.className = 'btn kill tiny'; interrupt.textContent = '⏹ interrupt';
  const delBtn = document.createElement('button'); delBtn.className = 'btn kill tiny'; delBtn.textContent = '🗑 delete session';
  const fork = document.createElement('button'); fork.className = 'btn tiny';
  fork.textContent = '⑂ fork';
  composer.append(ta, send, interrupt, fork, delBtn);
  rbody.after(composer);

  send.addEventListener('click', async () => {
    const id = tabState.sessionsSel; if (!id) return toast('select a session first', 'warn');
    const text = ta.value.trim(); if (!text) return;
    ta.value = '';
    try { await post(`/oc/api/session/${id}/prompt`, typeof text === 'string' ? { text } : text); feedLine('fe-op', '[oc] prompt sent → ' + id); }
    catch (e) { toastErr(e); }
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } });
  interrupt.addEventListener('click', async () => {
    const id = tabState.sessionsSel; if (!id) return;
    await withSpin(interrupt, async () => { await post(`/oc/api/session/${id}/interrupt`); toast('interrupted'); });
  });
  fork.addEventListener('click', async () => {
    const id = tabState.sessionsSel; if (!id) return;
    await withSpin(fork, async () => { const r = await post(`/oc/api/session/${id}/fork`); toast('forked → ' + (r.data?.id || r.id || '(?)')); refreshList(); });
  });
  delBtn.addEventListener('click', async () => {
    const id = tabState.sessionsSel; if (!id) return;
    if (!confirm('delete session ' + id + '?')) return;
    try { await del(`/oc/api/session/${id}`); toast('session deleted'); rbody.innerHTML = 'select a session'; tabState.sessionsSel = null; refreshList(); } catch (e) { toastErr(e); }
  });

  // mission presets + agent/model switching
  const ctrlRow = document.createElement('div'); ctrlRow.className = 'row'; ctrlRow.style.marginTop = '8px';
  const preset = document.createElement('select'); preset.id = 'sess-preset'; preset.style.flex = '0 0 auto';
  preset.innerHTML = `<option value="">mission preset…</option>
    <option value="recon">◉ passive recon brief</option>
    <option value="summarize">▤ summarize this session</option>
    <option value="harden">⛨ hardening checklist</option>
    <option value="explain">◌ explain last output</option>`;
  const agSel = document.createElement('select'); agSel.id = 'sess-agent'; agSel.style.flex = '0 0 auto'; agSel.innerHTML = '<option value="">agent…</option>';
  const mdSel = document.createElement('select'); mdSel.id = 'sess-model'; mdSel.style.flex = '1'; mdSel.innerHTML = '<option value="">model…</option>';
  const applyBtn = document.createElement('button'); applyBtn.className = 'btn tiny'; applyBtn.textContent = '↧ apply to session';
  ctrlRow.append(preset, agSel, mdSel, applyBtn);
  composer.after(ctrlRow);

  const PRESETS = {
    recon: 'You are doing PASSIVE recon on {target}. No active scanning, no brute force, no exploitation. Summarize: dns surface, anything already visible in this session, and your top 3 passive observations. Mark uncertainties clearly.',
    summarize: 'Summarize this session so far: goals, actions taken, findings, and open questions. Keep it under 15 lines.',
    harden: 'Produce a prioritized hardening checklist for {target} based only on what is known in this session. Mark quick wins with [QW].',
    explain: 'Explain the most recent tool output in this session in plain language. Define any jargon you use. Max 10 lines.',
  };
  preset.addEventListener('change', () => {
    const p = PRESETS[preset.value]; if (!p) return;
    ta.value = p.replaceAll('{target}', armState.target || '');
    preset.value = ''; ta.focus();
  });

  (async () => {
    try {
      const agents = (await get('/oc/api/agent')).data || [];
      agSel.innerHTML = '<option value="">agent…</option>' + agents.map(a =>
        `<option value="${esc(a.id)}">${esc(a.name || a.id)}${a.mode === 'primary' ? ' ★' : ''}</option>`).join('');
    } catch { /* list unavailable */ }
    try {
      const models = (await get('/oc/api/model')).data || [];
      const byProv = {};
      for (const m of models) (byProv[m.providerID] = byProv[m.providerID] || []).push(m);
      mdSel.innerHTML = '<option value="">model…</option>' + Object.entries(byProv).map(([prov, list]) =>
        `<optgroup label="${esc(prov)}">` + list.map(m => `<option value="${esc(prov + '/' + (m.id || ''))}">${esc(m.name || m.id)}</option>`).join('') + '</optgroup>').join('');
    } catch { /* list unavailable */ }
  })();

  applyBtn.addEventListener('click', () => withSpin(applyBtn, async () => {
    const id = tabState.sessionsSel;
    if (!id) return toast('select a session first', 'warn');
    const parts = [];
    if (agSel.value) { await post(`/oc/api/session/${id}/agent`, { agent: agSel.value }); parts.push('agent→' + agSel.value); }
    if (mdSel.value) {
      const i = mdSel.value.indexOf('/');
      const providerID = mdSel.value.slice(0, i), mid = mdSel.value.slice(i + 1);
      await post(`/oc/api/session/${id}/model`, { model: { id: mid, providerID } });
      parts.push('model→' + mdSel.value);
    }
    if (!parts.length) return toast('pick an agent and/or model first', 'warn');
    toast('applied: ' + parts.join(' · '));
    openSession(id);
  }, 'applying…'));

  const t = setInterval(() => { if (tabState.sessionsSel && !$('#modal').open) openSession(tabState.sessionsSel).catch(() => {}); }, 4000);
  tabState.refreshTimers.push(t);
}

// ---------- MCP ----------
async function renderMcp(main) {
  const head = panel('mcp servers');
  const body = pad(head);
  main.appendChild(head);
  await refreshMcp();

  const editors = panel('add / edit');
  const ebody = pad(editors);
  ebody.innerHTML = `
    <div class="grid2">
      <div>
        <div class="small muted" style="margin-bottom:6px">adds into <code>~/.config/opencode/opencode.json</code> → mcp.servers. Remote servers use OAuth by default; only set headers if required.</div>
        <label>server name</label><input id="mcp-name" placeholder="my-server">
        <label>type</label>
        <select id="mcp-type"><option value="local">local (spawn command)</option><option value="remote">remote (url)</option></select>
        <div id="mcp-local-fields">
          <label>command (spaces separate args)</label><input id="mcp-cmd" placeholder="npx -y some-mcp-server">
          <label>cwd (optional)</label><input id="mcp-cwd" placeholder="">
          <label>environment JSON (optional)</label><textarea id="mcp-env" rows="2" placeholder='{"API_KEY": "{env:API_KEY}"}'></textarea>
        </div>
        <div id="mcp-remote-fields" style="display:none">
          <label>url</label><input id="mcp-url" placeholder="https://mcp.example.com/mcp">
          <label>headers JSON (optional)</label><textarea id="mcp-headers" rows="2" placeholder='{"Authorization": "Bearer {env:TOKEN}"}'></textarea>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn" id="mcp-add">▸ install server</button></div>
      </div>
      <div>
        <div class="small muted" style="margin-bottom:6px">live status + connection control. disconnect works during a run without config surgery.</div>
        <div id="mcp-live"></div>
      </div>
    </div>`;
  main.appendChild(editors);

  $('#mcp-type').addEventListener('change', () => {
    const t = $('#mcp-type').value;
    $('#mcp-local-fields').style.display = t === 'local' ? '' : 'none';
    $('#mcp-remote-fields').style.display = t === 'remote' ? '' : 'none';
  });

  $('#mcp-add').addEventListener('click', async () => {
    const name = ($('#mcp-name').value || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name)) return toast('bad server name', 'err');
    const type = $('#mcp-type').value;
    let conf;
    if (type === 'local') {
      conf = { type: 'local', command: splitArgs($('#mcp-cmd').value), disabled: false };
      const cwd = $('#mcp-cwd').value.trim(); if (cwd) conf.cwd = cwd;
      const env = maybeJson($('#mcp-env').value); if (env) conf.environment = env;
      if (!conf.command?.length) return toast('command required', 'err');
    } else {
      const url = $('#mcp-url').value.trim(); if (!/^https?:\/\//.test(url)) return toast('url required', 'err');
      conf = { type: 'remote', url, disabled: false };
      const hh = maybeJson($('#mcp-headers').value); if (hh) conf.headers = hh;
    }
    // write into config file — match whatever mcp shape the file already uses
    try {
      const parsed = await loadEditableConfig('mcp add');
      if (!parsed) return;
      if (parsed.mcp && parsed.mcp.servers !== undefined) {
        parsed.mcp.servers[name] = conf; // shape: mcp.servers.<name>
      } else if (parsed.mcp) {
        parsed.mcp[name] = conf;         // legacy shape: mcp.<name>
      } else {
        parsed.mcp = { servers: { [name]: conf } }; // new file: docs shape
      }
      await post('/config/save', { content: JSON.stringify(parsed, null, 2) });
      toast('mcp inserted · config reloaded'); refreshMcp();
    } catch (e) { toastErr(e); }
  });

  async function refreshMcp() {
    let rows = [];
    try { rows = (await get('/oc/api/mcp')).data || []; } catch (e) { body.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    const live = $('#mcp-live'); if (live) {
      live.innerHTML = `<table><thead><tr><th>server</th><th>status</th></tr></thead><tbody>` + rows.map(r =>
        `<tr><td>${esc(r.name)}</td><td><span class="badge ${r.status?.status === 'connected' ? 'ok' : 'idle'}">${esc(r.status?.status || 'unknown')}</span></td></tr>`).join('') + `</tbody></table>`;
    }
    body.innerHTML = rows.length ? `<table><thead><tr><th>server</th><th>status</th><th></th></tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td><span class="accent">${esc(r.name)}</span></td>
        <td><span class="badge ${r.status?.status === 'connected' ? 'ok' : 'idle'}">${esc(r.status?.status || 'unknown')}</span></td>
        <td class="row">
          ${r.status?.status === 'connected'
        ? `<button class="btn tiny" data-act="disc" data-n="${esc(r.name)}">disconnect</button>`
        : `<button class="btn tiny" data-act="conn" data-n="${esc(r.name)}">connect</button>`}
          <button class="btn kill tiny" data-act="rm" data-n="${esc(r.name)}">remove</button>
        </td></tr>`).join('') + `</tbody></table>` : '<div class="muted">no servers configured</div>';
    body.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', async () => {
      const n = b.dataset.n;
      if (b.dataset.act === 'conn') await withSpin(b, async () => { await post(`/oc/api/experimental/mcp/${n}/connect`); toast('connect requested'); refreshMcp(); });
      if (b.dataset.act === 'disc') await withSpin(b, async () => { await post(`/oc/api/experimental/mcp/${n}/disconnect`); toast('disconnect requested'); refreshMcp(); });
      if (b.dataset.act === 'rm') {
        if (!confirm('remove MCP server "' + n + '" from global config?')) return;
        try {
          const parsed = await loadEditableConfig('mcp remove');
          if (!parsed) return;
          if (parsed.mcp?.servers !== undefined) {
            delete parsed.mcp.servers[n];
            if (!Object.keys(parsed.mcp.servers).length) delete parsed.mcp;
          } else if (parsed.mcp) {
            delete parsed.mcp[n];
            if (!Object.keys(parsed.mcp).length) delete parsed.mcp;
          }
          await post('/config/save', { content: JSON.stringify(parsed, null, 2) });
          toast('server removed'); refreshMcp();
        } catch (e) { toastErr(e); }
      }
    }));
  }
  const t = setInterval(() => { if (currentTab === 'mcp') refreshMcp().catch(() => {}); }, 8000);
  tabState.refreshTimers.push(t);
}

function splitArgs(s) {
  const out = []; let cur = '', inQ = false;
  for (const ch of String(s)) {
    if (ch === ' ' && !inQ) { if (cur) out.push(cur); cur = ''; }
    else if (ch === '"') { inQ = !inQ; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function maybeJson(s) {
  s = (s || '').trim(); if (!s) return null;
  try { return JSON.parse(s); } catch { toast('invalid JSON — ignored', 'warn'); return null; }
}
// JSONC-tolerant parse for client-side section edits
function parseCfgSmart(cf) {
  try { return JSON.parse(cf.text); }
  catch {
    const stripped = String(cf.text)
      .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  }
}
async function loadEditableConfig(what) {
  const cf = await get('/config');
  if (cf.jsonc) {
    const ok = confirm(`${what}: your opencode.json contains JSONC comments.\nUI edits rewrite the file as plain JSON — comments are dropped (a backup is kept). Continue?`);
    if (!ok) return null;
  }
  return parseCfgSmart(cf);
}

// ---------- SKILLS ----------
async function renderSkills(main) {
  const tools = panel('skills · ~/.config/opencode/skills');
  const body = pad(tools);
  main.appendChild(tools);
  const createBar = document.createElement('div'); createBar.className = 'row'; createBar.style.marginBottom = '10px';
  createBar.innerHTML = `
    <input id="sk-name" placeholder="skill-id (lowercase)" style="width:200px">
    <input id="sk-desc" placeholder="description" style="flex:1">
    <button class="btn" id="sk-create">＋ create skill</button>`;
  body.appendChild(createBar);
  const grid = document.createElement('div'); grid.className = 'skill-grid'; grid.id = 'skill-grid'; body.appendChild(grid);

  async function refresh() {
    let list = []; try { list = (await get('/skills')).local || []; } catch (e) { grid.innerHTML = esc(e.message); return; }
    grid.innerHTML = list.map(s => `<div class="skill-card" data-id="${esc(s.id)}">
      <h4>✦ ${esc(s.name)}</h4>
      <div class="muted small">${esc(s.description.slice(0, 120)) || '—'}</div>
      <div class="small muted" style="margin-top:6px">${s.lines} lines · ${esc(s.id)}</div>
      <div class="row" style="margin-top:8px"><button class="btn tiny" data-ed="${esc(s.id)}">open</button><button class="btn kill tiny" data-rm="${esc(s.id)}">delete</button></div>
    </div>`).join('') || '<div class="muted">no local skills found</div>';
    grid.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => openSkill(b.dataset.ed)));
    grid.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('delete skill "' + b.dataset.rm + '" (folder removed)?')) return;
      try { await del('/skills/' + encodeURIComponent(b.dataset.rm)); toast('skill deleted'); refresh(); } catch (e) { toastErr(e); }
    }));
  }
  $('#sk-create').addEventListener('click', async () => {
    const id = $('#sk-name').value.trim(), desc = $('#sk-desc').value.trim();
    try { await post('/skills', { id, description: desc }); toast('skill created'); refresh(); openSkill(id); } catch (e) { toastErr(e); }
  });

  async function openSkill(id) {
    try {
      const s = await get('/skills/' + encodeURIComponent(id));
      const box = document.createElement('div');
      box.innerHTML = `<label class="small">${esc(s.file)}</label><textarea id="sk-editor" rows="18" style="width:100%">${esc(s.content)}</textarea>
       <div class="row" style="margin-top:8px"><button class="btn" id="sk-save">save</button></div>`;
      openModal('skill ' + id, box);
      $('#sk-save', box).addEventListener('click', async () => {
        try { await put('/skills/' + encodeURIComponent(id), { content: $('#sk-editor', box).value }); toast('skill saved'); $('#modal').close(); if (currentTab === 'skills') refresh(); } catch (e) { toastErr(e); }
      });
    } catch (e) { toastErr(e); }
  }
  await refresh();
}

// ---------- PLUGINS ----------
async function renderPlugins(main) {
  const p1 = panel('loaded plugins');
  const b1 = pad(p1); main.appendChild(p1);
  const p2 = panel('user plugin packages');
  const b2 = pad(p2); main.appendChild(p2);

  let rows = [];
  try { rows = (await get('/oc/api/plugin')).data || []; } catch (e) { b1.innerHTML = esc(e.message); }
  b1.innerHTML = `<table><thead><tr><th>plugin</th><th>source</th><th>state</th></tr></thead><tbody>` + rows.map(r => `
    <tr><td><span class="accent">${esc(r.id)}</span></td>
    <td class="muted small">${esc(r.source?.type === 'builtin' ? 'builtin' : (r.source?.module || JSON.stringify(r.source || {})).slice(0, 60))}</td>
    <td><span class="badge ${r.state?.status === 'active' ? 'ok' : 'idle'}">${esc(r.state?.status || '?')}</span></td></tr>`).join('') + '</tbody></table>';

  function renderUserPlugins(cfg) {
    const list = (cfg.plugins || []);
    b2.innerHTML = `
      <div class="small muted" style="margin-bottom:6px">the <code>plugins</code> array in your global config (npm package names or paths)</div>
      <div class="row" style="margin-bottom:8px"><input id="pl-add" placeholder="npm:opencode-plugin-xyz or C:\\path\\plugin.js" style="flex:1"><button class="btn" id="pl-addbtn">＋ add plugin</button></div>
      <table><tbody>${list.map((x, i) => `<tr><td><code>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</code></td><td class="row"><button class="btn kill tiny" data-i="${i}">remove</button></td></tr>`).join('') || '<tr><td class="muted">no user plugins configured</td></tr>'}</tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn tiny" id="pl-check">⟳ check plugin updates</button></div>`;
    $('#pl-addbtn', b2).addEventListener('click', async () => {
      const v = $('#pl-add', b2).value.trim(); if (!v) return;
      try { const parsed = await loadEditableConfig('plugin add'); if (!parsed) return; parsed.plugins = [...(parsed.plugins || []), v]; await post('/config/save', { content: JSON.stringify(parsed, null, 2) }); toast('plugin added'); switchTab('plugins'); } catch (e) { toastErr(e); }
    });
    b2.querySelectorAll('button[data-i]').forEach(btn => btn.addEventListener('click', async () => {
      try { const parsed = await loadEditableConfig('plugin remove'); if (!parsed) return; parsed.plugins = (parsed.plugins || []).filter((_, i) => i !== Number(btn.dataset.i)); await post('/config/save', { content: JSON.stringify(parsed, null, 2) }); toast('removed'); switchTab('plugins'); } catch (e) { toastErr(e); }
    }));
    $('#pl-check', b2).addEventListener('click', () => withSpin($('#pl-check', b2), async () => { const r = await post('/oc/api/plugin/check'); toast('update check: ' + JSON.stringify(r).slice(0, 120)); }));
  }
  try { const cf = await get('/config'); renderUserPlugins(parseCfgSmart(cf)); } catch (e) { b2.innerHTML = esc(e.message); }
}

// ---------- CONFIG ----------
async function renderConfig(main) {
  const cf = panel('opencode.json (global)');
  const b = pad(cf); main.appendChild(cf);
  let data;
  try { data = await get('/config'); } catch (e) { b.innerHTML = esc(e.message); return; }
  b.innerHTML = `
    <div class="small muted" style="margin-bottom:6px">${esc(data.path)}${data.jsonc ? ' · <span style="color:var(--amb)">JSONC detected — saving rewrites the file as plain JSON (comments are dropped, a backup is kept)</span>' : ''} · edits get automatic timestamped backups and reload the OpenCode config.</div>
    <textarea id="cfg-editor" rows="20" style="width:100%">${esc(data.text)}</textarea>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="cfg-validate">⊙ validate</button>
      <button class="btn" id="cfg-save">▣ save + reload</button>
      <span class="muted small">backups:</span>
      <select id="cfg-backups" style="min-width:260px">${(data.backups || []).map(f => `<option>${esc(f)}</option>`).join('')}</select>
      <button class="btn warn tiny" id="cfg-restore">⟲ restore</button>
    </div>
    <pre id="cfg-note" class="muted small" style="margin-top:8px"></pre>`;
  $('#cfg-validate').addEventListener('click', async () => {
    const r = await post('/config/validate', { content: $('#cfg-editor').value });
    $('#cfg-note').textContent = r.ok ? '✓ valid JSON/JSONC' : '✗ ' + r.error;
  });
  $('#cfg-save').addEventListener('click', () => withSpin($('#cfg-save'), async () => {
    const content = $('#cfg-editor').value;
    const v = await post('/config/validate', { content });
    if (!v.ok) { toast('✗ ' + v.error, 'err', 6500); return; }
    await post('/config/save', { content });
    toast('saved · config reloaded'); feedLine('fe-warn', '[cfg] opencode.json written + reload issued');
  }, 'saving…'));
  $('#cfg-restore').addEventListener('click', async () => {
    const f = $('#cfg-backups').value; if (!f) return;
    if (!confirm('restore backup ' + f + '? current file is backed up first.')) return;
    await withSpin($('#cfg-restore'), async () => { await post('/config/restore', { file: f }); toast('restored + reloaded'); switchTab('config'); });
  });
}

// ---------- OPS ----------
function pushOpsLine(evt) {
  const c = $('#ops-console');
  if (!c) { tabState.ops.lines.push(evt); return; }
  const cls = evt.stream === 'stderr' ? 'l-err' : evt.stream === 'sys' ? 'l-sys' : 'l-out';
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${evt.tool}] ${evt.line}`;
  c.appendChild(div);
  const t = c.dataset.follow === '0'; if (!t) c.scrollTop = c.scrollHeight;
}
function pushPipelineStatus(e) {
  tabState.ops.pipeLast[e.key] = { state: e.state, tool: e.tool, step: e.step };
  const bar = $('#pipe-status'); if (bar) renderPipeStatus(bar);
}
function renderPipeStatus(bar) {
  const entries = Object.entries(tabState.ops.pipeLast).slice(-6);
  bar.innerHTML = entries.map(([k, s]) => `<span class="badge ${s.state === 'done' ? 'ok' : s.state === 'aborted' ? 'no' : 'auto'}">${esc(k)}:${esc(s.state)}${s.tool ? '·' + esc(s.tool) : ''}</span>`).join(' ');
}
function updateJobRow(job) {
  tabState.ops.jobs.set(job.id, job);
  const tb = $('#jobs-tbody'); if (!tb) return;
  const exists = tb.querySelector(`tr[data-jid="${job.id}"]`);
  const html = jobRowHtml(job);
  if (exists) { exists.innerHTML = html; wireJobRow(exists); }
  else { const tr = document.createElement('tr'); tr.dataset.jid = job.id; tr.innerHTML = html; wireJobRow(tr); tb.prepend(tr); }
}
function jobRowHtml(job) {
  return `<td><span class="accent">${esc(job.tool)}</span>${job.pipeline ? ' <span class="badge auto">pipe</span>' : ''}</td>
    <td>${esc(job.target)}</td>
    <td class="muted small">${esc((job.args || []).join(' ').slice(0, 90))}</td>
    <td><span class="badge ${job.state === 'running' ? 'auto' : job.state === 'done' ? 'ok' : 'no'}">${esc(job.state)}</span></td>
    <td>${fmtTime(job.startedAt)}</td>
    <td><button class="btn kill tiny" data-kill="${esc(job.id)}">kill</button></td>`;
}
function wireJobRow(tr) {
  tr.querySelectorAll('[data-kill]').forEach(b => b.addEventListener('click', async () => { try { await post('/ops/jobs/' + b.dataset.kill + '/kill'); toast('kill requested'); } catch (e) { toastErr(e); } }));
}

async function renderOps(main) {
  // arm banner
  const s = await get('/ops/state').catch(() => ({ armed: false }));
  armState = s; renderArmPill();

  const banner = document.createElement('div'); banner.id = 'arm-banner'; banner.style.marginBottom = '12px';
  main.appendChild(banner);

  const grid = document.createElement('div'); grid.className = 'grid2'; main.appendChild(grid);

  // left column
  const consentP = panel('target + authorization');
  const cb = pad(consentP);
  const toolsP = panel('tool detection');
  const tb = pad(toolsP);

  // right column
  const runP = panel('run / console');
  const rb = pad(runP);
  const pipeP = panel('pipelines · agent deploy');
  const pb = pad(pipeP);

  // row 3
  const probesP = panel('quick probes · zero-dep');
  const qpb = pad(probesP);
  const artP = panel('proof locker · artifacts');
  const ab = pad(artP);

  grid.append(consentP, runP, toolsP, pipeP, probesP, artP);

  function renderBanner() {
    if (armState.armed) {
      banner.classList.add('on');
      banner.innerHTML = `☠ ARMED · target <span class="tgt">${esc(armState.target)}</span> · scope ${esc(armState.scope)} · expires in ${fmtDur(armState.expiresIn)}
        <div class="row" style="margin-top:6px">
        <button class="btn kill tiny" id="disarm-btn">✖ disarm</button>
        <button class="btn kill tiny" id="killall-btn">☢ kill all ops</button>
        <span class="small muted">${esc(armState.note || '')}</span></div>`;
      $('#disarm-btn').addEventListener('click', async () => { armState = await post('/ops/disarm'); renderBanner(); renderArmPill(); toast('ops disarmed', 'warn'); });
      $('#killall-btn').addEventListener('click', () => withSpin($('#killall-btn'), async () => { const r = await post('/ops/killall'); toast('killed ' + r.killed + ' running jobs', 'warn'); }));
    } else {
      banner.classList = 'panel'; banner.style.marginBottom = '12px';
      banner.innerHTML = `
        <div class="pad">
        <div style="color:var(--amb); letter-spacing:2px; margin-bottom:6px">◉ SYSTEM CHECK — ops are DISARMED</div>
        <div class="small muted" style="margin-bottom:4px">arm against one explicit target to enable the ops console. authorization is logged to the audit trail and auto-expires in 12h.</div>
        <div class="row">
          <input id="arm-target" placeholder="target (single host/domain — e.g. scanme.nmap.org)" style="flex:1">
          <input id="arm-scope" placeholder="engagement/scope label" style="width:220px">
          <input id="arm-note" placeholder="note (optional)" style="width:160px">
        </div>
        <div class="row" style="margin-top:8px">
          <input id="arm-confirm" placeholder='type:  I am authorized to test <target>' style="flex:1">
          <button class="btn warn" id="arm-btn">☠ ARM OPS</button>
        </div></div>`;
      $('#arm-btn').addEventListener('click', () => withSpin($('#arm-btn'), async () => {
        const target = $('#arm-target').value.trim();
        armState = await post('/ops/arm', { target, scope: $('#arm-scope').value.trim(), note: $('#arm-note').value.trim(), confirmText: $('#arm-confirm').value });
        renderBanner(); renderArmPill(); feedLine('fe-warn', '[ops] ARMED → ' + armState.target);
        toast('ops armed against ' + armState.target, 'warn', 6000);
      }));
    }
  }
  renderBanner();

  // tools
  async function renderTools() {
    tb.innerHTML = '<div class="blink muted">probing PATH…</div>';
    let tools; try { tools = (await get('/ops/tools')).tools; } catch (e) { tb.innerHTML = esc(e.message); return; }
    const found = Object.entries(tools).filter(([, t]) => t?.exe);
    tb.innerHTML = `<div class="small muted" style="margin-bottom:6px">${found.length}/${Object.keys(tools).length} on PATH</div>` +
      Object.entries(tools).map(([n, t]) => `<div class="tool-chip" style="margin-bottom:4px">
        <span><i class="dot ${t?.exe ? 'on' : ''}"></i><span>${esc(n)}</span> <span class="muted small">${esc(TOOLDESC[n] || t?.description || '')}</span></span>
        <span class="tp">${esc(t?.exe || 'missing')}</span></div>`).join('') +
      `<div class="row" style="margin-top:8px"><button class="btn tiny" id="tools-rescan">⟳ rescan</button></div>`;
    $('#tools-rescan', tb).addEventListener('click', () => withSpin($('#tools-rescan', tb), async () => { await get('/ops/tools?force=1'); renderTools(); }));
  }
  const TOOLDESC = {};
  renderTools();

  // console
  rb.innerHTML = `<div class="row" style="margin-bottom:6px">
      <select id="ops-tool" style="width:180px"><option>detecting…</option></select>
      <input id="ops-args" placeholder="args ({target} allowed; no pipes/redirects)" style="flex:1" value="{target}">
      <input id="ops-target" placeholder="target" style="width:200px">
      <button class="btn warn" id="ops-run">▸ run</button>
    </div>
    <div id="pipe-status"></div>
    <div class="term" id="ops-console" data-follow="1"><div class="l-meta">ops console — output appears here as jobs run. scroll lock: toggle follow by clicking.</div></div>
    <div class="small muted" style="margin-top:4px">click console to toggle auto-follow · every invocation is audited</div>`;
  $('#ops-console').addEventListener('click', () => { const c = $('#ops-console'); c.dataset.follow = c.dataset.follow === '1' ? '0' : '1'; c.appendChild(Object.assign(document.createElement('div'), { className: 'l-meta', textContent: `follow: ${c.dataset.follow}` })); });
  // drain lines buffered while the console wasn't mounted
  for (const e of tabState.ops.lines.splice(0)) pushOpsLine(e);
  renderPipeStatus($('#pipe-status'));

  async function fillToolSelect() {
    let tools; try { tools = (await get('/ops/tools')).tools; } catch { return; }
    const sel = $('#ops-tool'); if (!sel) return;
    const detected = Object.entries(tools).filter(([, t]) => t?.exe);
    sel.innerHTML = detected.map(([n]) => `<option>${esc(n)}</option>`).join('') || '<option value="">no tools on PATH</option>';
  }
  fillToolSelect();

  $('#ops-run').addEventListener('click', () => withSpin($('#ops-run'), async () => {
    const tool = $('#ops-tool').value; const args = $('#ops-args').value; const target = $('#ops-target').value.trim() || undefined;
    try { const r = await post('/ops/run', { tool, args, target }); toast('job ' + r.id + ' started'); return r; }
    catch (e) { toastErr(e); }
  }, 'spawn…'));

  // pipelines
  let pipelines = {}; try { pipelines = (await get('/ops/pipelines')).pipelines; } catch { /* none */ }
  pb.innerHTML = Object.entries(pipelines).map(([k, p]) => `
    <div class="tool-chip" style="margin-bottom:6px">
      <span><b>${esc(p.label)}</b> <span class="muted small">· ${esc(p.steps.map(s => s.tool).join(' → '))}</span></span>
      <button class="btn warn tiny" data-pipe="${esc(k)}">▶ run</button>
    </div>`).join('') || '<div class="muted">no pipelines</div>';
  pb.querySelectorAll('[data-pipe]').forEach(btn => btn.addEventListener('click', () => withSpin(btn, async () => {
    const target = ($('#ops-target')?.value || armState.target || '').trim();
    if (!target) return toast('target required (arm first)', 'warn');
    try { await post('/ops/pipeline', { key: btn.dataset.pipe, target }); toast('pipeline started — watch the console', 'warn'); } catch (e) { toastErr(e); }
  }, 'spawn…')));

  // deploy agent
  const ag = await get('/agent/state').catch(() => ({ installed: false, name: '?' }));
  const agRow = document.createElement('div'); agRow.className = 'row'; agRow.style.marginTop = '10px';
  agRow.innerHTML = `<span class="badge ${ag.installed ? 'ok' : 'idle'}">recon agent · ${ag.installed ? 'installed' : 'not installed'}</span>`;
  const deploy = document.createElement('button'); deploy.className = 'btn'; deploy.textContent = '⌁ deploy recon agent session';
  deploy.addEventListener('click', () => withSpin(deploy, async () => {
    const target = ($('#ops-target')?.value || armState.target || '').trim();
    if (!target) return toast('target required (arm first)', 'warn');
    const r = await post('/agent/deploy', { target });
    toast('recon session deployed: ' + r.sessionID);
    feedLine('fe-warn', '[deploy] recon agent session ' + r.sessionID + ' → ' + r.target);
    tabState.sessionsSel = r.sessionID;
    switchTab('sessions');
  }, 'deploying…'));
  const inst = document.createElement('button'); inst.className = 'btn tiny'; inst.textContent = 'install agent';
  inst.addEventListener('click', () => withSpin(inst, async () => {
    await post('/agent/install');
    toast('agent installed into global config');
    const badge = agRow.querySelector('.badge');
    if (badge) { badge.className = 'badge ok'; badge.textContent = 'recon agent · installed'; }
  }));
  agRow.append(deploy, inst);
  pb.appendChild(agRow);

  // quick probes — dns + passive http fetch, pure node, consent-gated by the server
  qpb.innerHTML = `
    <div class="small muted" style="margin-bottom:8px">dns + passive http header fetch using node only — no nmap required. consent-gated &amp; audited like tool runs.</div>
    <div class="row">
      <input id="probe-target" placeholder="target host" style="flex:1">
      <button class="btn tiny" id="probe-dns">⊙ dns</button>
      <button class="btn tiny" id="probe-http">⇄ http</button>
    </div>
    <div id="probe-out" class="term" style="min-height:100px;max-height:280px;margin-top:8px"><div class="l-meta">probe results land here (json) — can be copied into the vault.</div></div>
    <div class="row" style="margin-top:6px"><span class="muted small" id="probe-last">no probes yet</span></div>`;
  function probeLine(cls, txt) {
    const o = qpb.querySelector('#probe-out');
    const d = document.createElement('div'); d.className = cls; d.textContent = txt;
    o.appendChild(d); o.scrollTop = o.scrollHeight;
  }
  async function runProbe(kind) {
    const target = $('#probe-target', qpb).value.trim();
    if (!target) return toast('probe target required', 'warn');
    $('#probe-out', qpb).innerHTML = '';
    probeLine('l-sys', `[probe:${kind}] ${target} …`);
    try {
      const r = await post('/ops/probe/' + kind, { target });
      probeLine('l-out', JSON.stringify(r, null, 1).slice(0, 4000));
      const s0 = r.attempts?.[0];
      $('#probe-last', qpb).textContent = kind === 'http'
        ? `last: status ${s0?.status ?? 'n/a'}${s0?.title ? ' · "' + s0.title.slice(0, 47) + '"' : ''}`
        : `last: ${Object.keys(r).filter(k => !['target', 'ts'].includes(k)).length} record kinds`;
    } catch (e) { probeLine('l-err', (e.code ? e.code + ' · ' : '') + e.message); }
  }
  qpb.querySelector('#probe-dns').addEventListener('click', () => withSpin(qpb.querySelector('#probe-dns'), () => runProbe('dns')));
  qpb.querySelector('#probe-http').addEventListener('click', () => withSpin(qpb.querySelector('#probe-http'), () => runProbe('http')));

  // artifact browser — every job output saved under data/artifacts
  ab.innerHTML = '<div class="blink muted">indexing artifacts…</div>';
  async function renderArtifacts() {
    let arts = [];
    try { arts = (await get('/ops/artifacts')).artifacts || []; } catch (e) { ab.innerHTML = esc(e.message); return; }
    ab.innerHTML = `<table><thead><tr><th>artifact</th><th>bytes</th><th>captured</th><th></th></tr></thead><tbody>
      ${arts.map(a => `<tr>
        <td class="small"><span class="accent">${esc(a.id)}</span></td>
        <td class="muted small">${a.bytes}</td>
        <td class="muted small">${esc(new Date(a.mtime).toLocaleString())}</td>
        <td class="row"><button class="btn tiny" data-view="${esc(a.id)}">view</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">no artifacts yet — run a job and output is saved automatically</td></tr>'}
    </tbody></table><div class="row" style="margin-top:8px"><button class="btn tiny" id="art-refresh">⟳ refresh</button></div>`;
    ab.querySelector('#art-refresh').addEventListener('click', renderArtifacts);
    ab.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await get('/ops/artifacts/' + encodeURIComponent(b.dataset.view));
        const pre = document.createElement('pre');
        pre.className = 'term'; pre.style.cssText = 'max-height:64vh;min-height:200px'; pre.textContent = r.text;
        openModal('artifact ' + r.id, pre);
      } catch (e) { toastErr(e); }
    }));
  }
  renderArtifacts();

  // recent jobs
  const jobsP = panel('recent jobs');
  const jb = pad(jobsP); main.appendChild(jobsP);
  const jt = (await get('/ops/jobs').catch(() => ({ jobs: [] }))).jobs || [];
  jb.innerHTML = `<table><thead><tr><th>tool</th><th>target</th><th>args</th><th>state</th><th>started</th><th></th></tr></thead><tbody id="jobs-tbody">
    ${jt.map(j => `<tr data-jid="${esc(j.id)}">${jobRowHtml(j)}</tr>`).join('') || '<tr><td class="muted">no jobs yet</td></tr>'}</tbody></table>`;
  jb.querySelectorAll('[data-kill]').forEach(b => b.addEventListener('click', async () => { try { await post('/ops/jobs/' + b.dataset.kill + '/kill'); toast('kill requested'); } catch (e) { toastErr(e); } }));
}

// ---------- AUDIT ----------
async function renderAudit(main) {
  const cf = panel('audit trail · data/audit.log');
  const b = pad(cf); main.appendChild(cf);
  let lines = [];
  try { lines = (await get('/audit')).lines || []; } catch (e) { b.innerHTML = esc(e.message); return; }
  b.innerHTML = `<table><thead><tr><th>time</th><th>kind</th><th>detail</th></tr></thead><tbody>${lines.map(l => `
    <tr><td class="muted small">${esc((l.ts || '').replace('T', ' ').slice(0, 19))}</td>
    <td><span class="badge ${/arm$|run|job|pipeline/.test(l.kind) ? 'auto' : 'idle'}">${esc(l.kind)}</span></td>
    <td class="small">${esc(JSON.stringify({ ...l, ts: undefined, kind: undefined }).slice(1, 220))}</td></tr>`).join('') || '<tr><td class="muted">empty</td></tr>'}</tbody></table>`;
}

// ---------- VAULT (intel findings) ----------
async function renderVault(main) {
  const vaultP = panel('intel vault · data/intel.json');
  const st = pad(vaultP); main.appendChild(vaultP);

  st.innerHTML = `
    <div class="small muted" style="margin-bottom:8px">structured findings from ops + probe runs. export as deliverable-ready markdown. stored locally, never uploaded.</div>
    <div class="grid2">
      <div>
        <label>target</label><input id="in-target" placeholder="host / service">
        <label>severity</label><select id="in-sev"><option>info</option><option>low</option><option>medium</option><option>high</option><option>critical</option></select>
        <label>finding (one line)</label><input id="in-finding" placeholder="e.g. admin panel exposed without auth" style="width:100%">
        <label>evidence (paste artifact / output excerpt)</label><textarea id="in-evidence" rows="3" style="width:100%"></textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="in-add">＋ log finding</button>
          <button class="btn tiny" id="in-export">⇩ export report (md)</button>
          <span class="muted small" id="in-count"></span>
        </div>
      </div>
      <div id="in-list"><div class="muted blink">loading vault…</div></div>
    </div>`;

  $('#in-target', st).value = armState.target || '';
  const sevBadge = (s) => s === 'critical' || s === 'high' ? 'no' : s === 'medium' ? 'auto' : 'ok';

  $('#in-add', st).addEventListener('click', () => withSpin($('#in-add', st), async () => {
    await post('/intel', {
      target: $('#in-target', st).value.trim(),
      severity: $('#in-sev', st).value,
      finding: $('#in-finding', st).value.trim(),
      evidence: $('#in-evidence', st).value,
      source: 'dashboard',
    });
    $('#in-finding', st).value = ''; $('#in-evidence', st).value = '';
    toast('finding logged'); refreshVault();
  }, 'logging…'));

  $('#in-export', st).addEventListener('click', async () => {
    try {
      const r = await fetch('/intel/export');
      if (!r.ok) throw new Error('export failed HTTP ' + r.status);
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'haxordash-findings.md';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('report exported');
    } catch (e) { toastErr(e); }
  });

  async function refreshVault() {
    let items = [];
    try { items = (await get('/intel')).items || []; } catch (e) { $('#in-list', st).innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
    $('#in-count', st).textContent = items.length + ' finding(s)';
    $('#in-list', st).innerHTML = items.map(it => `
      <div class="vault-item sev-${esc(it.severity)}">
        <div class="row" style="justify-content:space-between">
          <span>
            <span class="badge ${sevBadge(it.severity)}">${esc(it.severity)}</span>
            <b class="accent">${esc(it.target || '—')}</b>
            <span class="muted small">${esc((it.ts || '').replace('T', ' ').slice(0, 16))}</span>
          </span>
          <button class="btn kill tiny" data-del="${esc(it.id)}" title="delete">✖</button>
        </div>
        <div style="margin-top:4px">${esc(it.finding)}</div>
        ${it.evidence ? `<div class="vault-ev">${esc(it.evidence)}</div>` : ''}
        <div class="small muted" style="margin-top:2px">src: ${esc(it.source || '—')}</div>
      </div>`).join('') || '<div class="muted">vault empty — log findings from your ops results</div>';
    st.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      try { await del('/intel/' + encodeURIComponent(b.dataset.del)); toast('finding deleted'); refreshVault(); } catch (e) { toastErr(e); }
    }));
  }
  await refreshVault();
}

// ---------- CLUSTER (model swarms) ----------
let clusterOpenId = null;

const CLUSTER_BADGE = (s) => ({ draft: 'idle', planning: 'auto', running: 'auto', synthesizing: 'auto', done: 'ok', failed: 'no', aborted: 'no', stalled: 'auto' }[s] || 'idle');

async function renderCluster(main) {
  const head = panel('cluster mode · model swarms');
  const hb = pad(head); main.appendChild(head);
  hb.innerHTML = `<div class="small muted">
    one orchestrator session decomposes the mission into exactly N subtasks → N cloned worker sessions (same model, selected agent) execute them
    → the orchestrator reads all reports and synthesizes. every session is a real OpenCode session (open them in SESSIONS). caps: ≤8 nodes · ≤3 parallel ·
    10 min/step timeout · abort anytime · everything audited. <span style="color:var(--amb)">spawning a swarm makes real model calls.</span></div>`;

  // ----- spawn panel -----
  const spawnP = panel('spawn swarm');
  const sb = pad(spawnP); main.appendChild(spawnP);
  sb.innerHTML = `
    <div class="grid2">
      <div>
        <label>swarm name</label><input id="cluster-name" placeholder="recon-swarm" style="width:220px">
        <label>mission (clear scope — workers only see the subtask, orchestrator sees the whole mission)</label>
        <textarea id="cluster-mission" rows="4" style="width:100%" placeholder="e.g. design the folder structure for a findings vault and draft the file templates"></textarea>
        <div class="row">
          <div><label>nodes</label><select id="cluster-nodes"></select></div>
          <div><label>parallel</label><select id="cluster-cc"></select></div>
          <div><label>permission policy</label><select id="cluster-policy">
            <option value="manual">manual — surface &amp; wait</option>
            <option value="autoOnce">auto-allow once (autonomous)</option>
            <option value="strict">strict — auto-reject all tools</option>
          </select></div>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn warn" id="cluster-spawn">⌬ spawn + launch swarm</button>
          <span class="muted small" id="cluster-spawn-note"></span>
        </div>
      </div>
      <div>
        <label>agent (all sessions)</label><select id="cluster-agent" style="width:100%"></select>
        <label>model (all sessions — clones share it)</label><select id="cluster-model" style="width:100%"></select>
        <div class="small muted" style="margin-top:8px">the orchestrator uses the same model and agent as the nodes — the swarm is ${'⎧same model⎭'} multiplied, led by one session pinned as orchestrator.</div>
      </div>
    </div>`;
  sb.querySelector('#cluster-nodes').innerHTML = Array.from({ length: 8 }, (_, i) => `<option ${i + 1 === 3 ? 'selected' : ''}>${i + 1}</option>`).join('');
  sb.querySelector('#cluster-cc').innerHTML = Array.from({ length: 3 }, (_, i) => `<option ${i === 0 ? 'selected' : ''}>${i + 1}</option>`).join('');
  (async () => {
    try {
      const agents = (await get('/oc/api/agent')).data || [];
      sb.querySelector('#cluster-agent').innerHTML = agents.map(a => `<option value="${esc(a.id)}" ${a.id === 'build' ? 'selected' : ''}>${esc(a.name || a.id)}${a.mode === 'primary' ? ' ★' : ''}</option>`).join('');
    } catch { sb.querySelector('#cluster-agent').innerHTML = '<option value="build">build</option>'; }
    try {
      const def = (await get('/oc/api/model/default').catch(() => ({ data: null }))).data || {};
      const models = (await get('/oc/api/model')).data || [];
      const byProv = {};
      for (const m of models) (byProv[m.providerID] = byProv[m.providerID] || []).push(m);
      const ref = (m) => m.providerID + '/' + m.id;
      sb.querySelector('#cluster-model').innerHTML = Object.entries(byProv).map(([prov, list]) =>
        `<optgroup label="${esc(prov)}">` + list.map(m =>
          `<option value="${esc(ref(m))}" ${def.providerID === prov && (def.modelID || def.id) === m.id ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('') + '</optgroup>').join('');
    } catch { /* default model is used when empty */ }
  })();

  sb.querySelector('#cluster-spawn').addEventListener('click', () => withSpin(sb.querySelector('#cluster-spawn'), async () => {
    const mission = sb.querySelector('#cluster-mission').value.trim();
    if (!mission) return toast('mission required', 'warn');
    const nodes = Number(sb.querySelector('#cluster-nodes').value);
    if (!confirm(`This spawns ${nodes + 1} REAL sessions (nodes + orchestrator) running the selected model, and prompts them autonomously.\n\nSupervise [LOOKS] — abort anytime. Continue?`)) return;
    const mi = sb.querySelector('#cluster-model').value.indexOf('/');
    const body = {
      name: sb.querySelector('#cluster-name').value,
      mission,
      nodes,
      concurrency: Number(sb.querySelector('#cluster-cc').value),
      policy: sb.querySelector('#cluster-policy').value,
      agent: sb.querySelector('#cluster-agent').value || undefined,
      model: sb.querySelector('#cluster-model').value && mi > 0
        ? { providerID: sb.querySelector('#cluster-model').value.slice(0, mi), id: sb.querySelector('#cluster-model').value.slice(mi + 1) }
        : undefined,
    };
    const rec = await post('/cluster', body);
    await post(`/cluster/${rec.id}/launch`);
    clusterOpenId = rec.id;
    toast(`swarm "${rec.name}" spawned + launched — ${nodes} nodes planning`);
    sb.querySelector('#cluster-mission').value = '';
    refreshClusters();
  }, 'spawning…'));

  // ----- swarms list -----
  const listP = panel('swarms · data/cluster.json');
  const lb = pad(listP); main.appendChild(listP);
  lb.innerHTML = '<div class="blink muted">loading swarms…</div>';

  async function refreshClusters() {
    let rows = [];
    try { rows = (await get('/clusters')).clusters || []; } catch (e) { lb.innerHTML = esc(e.message); return; }
    const sig = JSON.stringify(rows) + '|' + clusterOpenId;
    if (lb.dataset.sig === sig) return; // poll: skip identical
    lb.dataset.sig = sig;

    lb.innerHTML = rows.map(c => `
      <div class="cluster-card" data-id="${esc(c.id)}">
        <div class="row" style="justify-content:space-between">
          <span>
            <span class="badge ${CLUSTER_BADGE(c.status)}">${esc(c.status)}</span>
            <b>⌬ ${esc(c.name)}</b>
            <span class="muted small">${c.tasksDone}/${c.tasksTotal} tasks · ${c.nodes} nodes ×${c.concurrency} · ${esc(c.model ? c.model.providerID + '/' + c.model.id : 'default model')}</span>
          </span>
          <span class="row">
            <button class="btn tiny" data-act="detail" data-id="${esc(c.id)}">${clusterOpenId === c.id ? 'collapse' : 'detail'}</button>
            ${['planning', 'running', 'synthesizing'].includes(c.status) ? `<button class="btn kill tiny" data-act="abort" data-id="${esc(c.id)}">⏹ abort</button>` : ''}
            <button class="btn tiny" data-act="peek" data-id="${esc(c.orchestratorId)}" data-name="${esc(c.id)}">✎ orchestrator</button>
            <button class="btn tiny" data-act="transcript" data-id="${esc(c.id)}">⇩ md</button>
            <button class="btn kill tiny" data-act="delete" data-id="${esc(c.id)}">🗑</button>
          </span>
        </div>
        <div class="muted small" style="margin-top:3px">${esc(c.mission)}</div>
        ${c.note ? `<div class="small" style="color:var(--amb);margin-top:2px">${esc(c.note)}</div>` : ''}
      </div>`).join('') || '<div class="muted">no swarms yet — spawn one above</div>';

    lb.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'detail') { clusterOpenId = clusterOpenId === id ? null : id; refreshClusters(); }
      else if (act === 'abort') await withSpin(b, async () => { await post(`/cluster/${id}/abort`); toast('abort requested — nodes interrupted', 'warn'); refreshClusters(); });
      else if (act === 'peek') { tabState.sessionsSel = id; switchTab('sessions'); }
      else if (act === 'delete') {
        if (!confirm('delete swarm: interrupts + deletes ALL its sessions permanently?')) return;
        await withSpin(b, async () => { await del('/cluster/' + id); if (clusterOpenId === id) clusterOpenId = null; toast('swarm deleted + sessions removed'); refreshClusters(); });
      }
    }));

    // detail block under the open card
    if (clusterOpenId) {
      try {
        const c = await get('/cluster/' + clusterOpenId);
        const card = lb.querySelector(`.cluster-card[data-id="${clusterOpenId}"]`);
        const det = document.createElement('div'); det.className = 'cluster-detail';
        det.innerHTML = `
          <table><thead><tr><th>task</th><th>node</th><th>state</th><th>ms</th><th></th></tr></thead><tbody>
          ${(c.tasks || []).map(t => {
            const ni = t.nodeId ? (c.nodeIds || []).indexOf(t.nodeId) + 1 : '—';
            const ms = t.endedAt && t.startedAt ? Math.round((t.endedAt - t.startedAt)) : '';
            return `<tr><td class="small"><span class="accent">${esc(t.id)}</span> ${esc(t.title)}</td><td class="small">node-${esc(ni)}</td>
              <td><span class="badge ${t.state === 'done' ? 'ok' : t.state === 'running' ? 'auto' : t.state === 'failed' ? 'no' : 'idle'}">${esc(t.state)}</span></td>
              <td class="muted small">${ms}</td>
              <td><button class="btn tiny" data-peek-node="${esc(t.nodeId || '')}">${t.nodeId ? '✎' : ''}</button></td></tr>`;
          }).join('') || '<tr><td class="muted">planning…</td></tr>'}
          </tbody></table>
          ${(c.pendingPermissions || []).length ? `<div class="panel" style="padding:8px;margin-top:8px">
            <div class="small" style="color:var(--amb)">⚠ cluster sessions awaiting permission (policy: ${esc(c.policy)})</div>
            ${c.pendingPermissions.map(pp => `<div class="row" style="margin-top:4px"><span class="badge auto">${esc(pp.action || '')}</span><code class="small">${esc((pp.resources || []).join(', ').slice(0, 100))}</code>
              <button class="btn tiny" data-perm="${esc(pp.sessionID)}|${esc(pp.id)}">allow</button>
              <button class="btn kill tiny" data-nope="${esc(pp.sessionID)}|${esc(pp.id)}">reject</button></div>`).join('')}
          </div>` : ''}
          <div class="small muted" style="margin-top:8px">synthesis</div>
          <pre class="term" style="min-height:60px;max-height:300px">${esc(c.synthesis || 'pending…')}</pre>
          <div class="row" style="margin-top:8px"><span class="muted small">sessions kept open in SESSIONS tab while the swarm runs · transcript ⇩ exports plan + reports + synthesis</span></div>`;
        card.after(det);
        det.querySelectorAll('[data-peek-node]').forEach(pb => pb.addEventListener('click', () => {
          if (!pb.dataset.peekNode) return;
          tabState.sessionsSel = pb.dataset.peekNode;
          switchTab('sessions');
        }));
        det.querySelectorAll('[data-perm]').forEach(pb => pb.addEventListener('click', async () => {
          const [sid, pid] = pb.dataset.perm.split('|');
          try { await post(`/oc/api/session/${sid}/permission/${pid}/reply`, { decision: 'once' }); toast('allowed (once)'); refreshClusters(); } catch (e) { toastErr(e); }
        }));
        det.querySelectorAll('[data-nope]').forEach(pb => pb.addEventListener('click', async () => {
          const [sid, pid] = pb.dataset.nope.split('|');
          try { await post(`/oc/api/session/${sid}/permission/${pid}/reply`, { decision: 'reject' }); toast('rejected'); refreshClusters(); } catch (e) { toastErr(e); }
        }));
      } catch { /* cluster vanished */ }
    }
  }
  refreshClusters();
  const t = setInterval(() => { if (currentTab === 'cluster' && !$('#modal').open) refreshClusters().catch(() => {}); }, 3500);
  tabState.refreshTimers.push(t);
}

// ---------- boot sequence ----------
const boot = $('#boot'), bootPre = $('#boot-pre');
const LOGO = [
  '',
  '  ██╗  ██╗ █████╗ ██╗  ██╗ ██████╗ ██████╗  █████╗ ███████╗██╗  ██╗',
  '  ██║  ██║██╔══██╗██║  ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝',
  '  ███████║███████║███████║██║   ██║██████╔╝███████║███████╗ ╚███╔╝ ',
  '  ██╔══██║██╔══██║██╔══██║██║   ██║██╔══██╗██╔══██║╚════██║ ██╔██╗ ',
  '  ██║  ██║██║  ██║██║  ██║╚██████╔╝██║  ██║██║  ██║███████║██╔╝ ██╗',
  '  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝',
  '',
];
const BOOT_LINES = [
  ...LOGO,
  '  [ bios ] haxordash post · self-contained · zero deps ..... ok',
  '  [ net  ] binding loopback only · 127.0.0.1:3969 .......... ok',
  '  [ oc   ] opencode service link .......................... defer',
  '  [ sec  ] consent gate · explicit authorization ........... locked',
  '  [ audit] append-only trail · tail -f ..................... on',
  '  [ vault] intel vault + artifacts ......................... ready',
  '',
  '  click anywhere to skip ·',
];
let bootTick = null;
function endBoot() {
  if (bootTick) { clearInterval(bootTick); bootTick = null; }
  if (!boot || !boot.isConnected) return;
  boot.classList.add('off');
  setTimeout(() => boot.remove(), 420);
}
if (boot && bootPre) {
  boot.addEventListener('click', endBoot);
  let li = 0, ci = 0, out = '', done = false;
  bootTick = setInterval(() => {
    if (li >= BOOT_LINES.length) {
      clearInterval(bootTick); bootTick = null; done = true;
      setTimeout(endBoot, 350); return;
    }
    const line = BOOT_LINES[li];
    if (ci < line.length) { out += line[ci++]; }
    else { out += '\n'; li++; ci = 0; }
    bootPre.textContent = out;
  }, 3);
  setTimeout(() => { if (!done) endBoot(); }, 3200); // hard cap
}

// ---------- themes ----------
const THEMES = ['phosphor', 'amber', 'glacier', 'blood'];
function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'phosphor';
  document.body.dataset.theme = t;
  try { localStorage.setItem('haxordash.theme', t); } catch { /* ignore */ }
  document.querySelectorAll('#themes .swatch').forEach(s => s.classList.toggle('sel', s.dataset.theme === t));
}
document.querySelectorAll('#themes .swatch').forEach(s =>
  s.addEventListener('click', () => { applyTheme(s.dataset.theme); feedLine('fe-op', '[theme] ' + s.dataset.theme); }));
let savedTheme = null;
try { savedTheme = localStorage.getItem('haxordash.theme'); } catch { /* ignore */ }
applyTheme(savedTheme || 'phosphor');

// ---------- alt+1..9 = jump to tab ----------
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  let n = 0;
  const d = /^Digit([0-9])$/.exec(e.code);
  if (d) n = d[1] === '0' ? 10 : Number(d[1]);
  else n = 0;
  const btn = document.querySelectorAll('#nav .nav-btn')[n - 1];
  if (btn) { e.preventDefault(); switchTab(btn.dataset.tab); }
});

switchTab('status');
