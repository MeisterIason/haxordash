// isolate: does REST prompting generate ANY output for a fresh session?
const B = 'http://127.0.0.1:3969';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jf = async (p, opts) => {
  const r = await fetch(B + p, { method: opts?.method || 'GET', headers: opts?.body ? { 'Content-Type': 'application/json' } : {}, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text();
  try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status, txt: t }; }
};

console.log('== providers ==');
const prov = await jf('/oc/api/provider');
for (const p of prov.j?.data || []) console.log('-', p.id, '| type:', p.type, '| connected keys:', Object.keys(p).join(','));
console.log('== auth/config providers in config ==');
const cfg = await jf('/config');
try {
  const parsed = JSON.parse(cfg.j.text.replace(/\/\/[^\n]*/g, ''));
  console.log('cfg top keys:', Object.keys(parsed).join(','));
  if (parsed.provider) console.log('cfg.provider:', JSON.stringify(Object.keys(parsed.provider)));
} catch (e) { console.log('cfg parse fail (jsonc?)'); }
const def = await jf('/oc/api/model/default');
console.log('default model:', JSON.stringify(def.j?.data));

// fresh session prompt test with the proven-working pair
console.log('\n== fresh prompt test (opencode/glm-5.3-flash-free) ==');
const s = await jf('/oc/api/session', { method: 'POST', body: { title: 'haxordash prompttest' } });
const sid = s.j?.data?.id;
console.log('session:', sid);
const mv = await jf(`/oc/api/session/${sid}/model`, { method: 'POST', body: { model: { id: 'glm-5.3-flash-free', providerID: 'opencode' } } });
console.log('set model:', mv.status, (mv.j ? JSON.stringify(mv.j).slice(0, 120) : mv.txt || '(empty)'));
const pr = await jf(`/oc/api/session/${sid}/prompt`, { method: 'POST', body: { text: 'Reply with exactly: OK-FRONTIER' } });
console.log('prompt:', pr.status, (pr.j ? JSON.stringify(pr.j).slice(0, 150) : pr.txt || '(empty)'));
if (pr.status === 409) console.log('(409 busy)');

const t0 = Date.now();
let got = false;
while (Date.now() - t0 < 90000) {
  await sleep(4000);
  const msgs = await jf(`/oc/api/session/${sid}/message`);
  const list = msgs.j?.data || [];
  const asst = list.filter(m => m.type === 'assistant');
  const texts = asst.map(m => (m.content || []).filter(p => p.type === 'text' && p.text).map(p => p.text).join('')).filter(Boolean);
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] msgs=${list.length} assistant=${asst.length} textLen=${texts.join('').length}`);
  if (texts.join('').length > 0) { console.log('GOT TEXT:', texts.join(' ').slice(0, 200)); got = true; break; }
}
if (!got) console.log('NO TEXT after 90s');
const info = await jf(`/oc/api/session/${sid}`);
console.log('session time:', JSON.stringify(info.j?.data?.time));
console.log('cleanup:', (await jf(`/oc/api/session/${sid}`, { method: 'DELETE' })).status, '(404 if body missing is fine)');
