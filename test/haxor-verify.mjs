// verify the fixed client paths + remaining flows end to end
const B = 'http://127.0.0.1:3969';
const pjson = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// 1) create → parse via FIXED client logic → delete
const created = await fetch(B + '/oc/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'haxordash verify' }) }).then(pjson);
const id = created?.data?.id || created?.id;
console.log('1. create→parse id:', id ? 'OK ' + id : 'FAIL ' + JSON.stringify(created));

// 2) messages of the real dashboard session render non-empty through the new renderer
const sid = 'ses_e9b7d07e9ffeiucPftby3Nx8mv';
const msg = await fetch(B + `/oc/api/session/${sid}/message`).then(pjson);
const items = (msg?.data || []).filter(Boolean);
const fmtParts = (parts = []) => parts.map(p => {
  if (!p) return '';
  if (p.type === 'text' && p.text) return p.text;
  if (p.type === 'reasoning' && p.text) return '◌ reasoning';
  if (p.type === 'tool') return `[${p.name || 'tool'}]`;
  if (p.text) return String(p.text).slice(0, 400);
  return JSON.stringify(p).slice(0, 160);
});
const rendered = items.map(m => ({ role: m.type, body: fmtParts(m.content).join('\n').trim() })).filter(x => x.body);
const roles = [...new Set(rendered.map(x => x.role))];
console.log('2. message render:', rendered.length, 'non-empty blocks · roles:', roles.join(','), rendered.length ? 'OK' : 'FAIL');

// 3) interrupt + delete round trip
const intr = await fetch(B + `/oc/api/session/${id}/interrupt`, { method: 'POST' }).then(pjson);
console.log('3a. interrupt:', JSON.stringify(intr));
const del = await fetch(B + `/oc/api/session/${id}`, { method: 'DELETE' });
console.log('3b. delete:', del.status === 204 ? 'OK 204' : 'status ' + del.status);

// 4) fork error surfaces cleanly (empty session)
const c2 = await fetch(B + '/oc/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'haxordash verify2' }) }).then(pjson);
const id2 = c2?.data?.id;
const fork = await fetch(B + `/oc/api/session/${id2}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const ftxt = await fork.text();
console.log('4. fork-empty message:', ftxt.slice(0, 120));
await fetch(B + `/oc/api/session/${id2}`, { method: 'DELETE' });

// 5) tool select + state + agent state
const tools = await fetch(B + '/ops/tools').then(pjson);
const detected = Object.entries(tools.tools).filter(([, t]) => t?.exe).map(([n]) => n);
console.log('5. detected tools:', detected.join(',') || '(only whoami expected)');
const ag = await fetch(B + '/agent/state').then(pjson);
console.log('6. agent installed?:', ag.installed);
const state = await fetch(B + '/ops/state').then(pjson);
console.log('7. armed?:', state.armed, '· jobsRunning:', state.jobsRunning);
