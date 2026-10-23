// LIVE cluster test — 2-node swarm on the free default model, full lifecycle.
const B = 'http://127.0.0.1:3969';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const j = async (p, opts) => {
  const r = await fetch(B + p, { method: opts?.method || 'GET', headers: opts?.body ? { 'Content-Type': 'application/json' } : {}, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text();
  try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status, txt: t }; }
};

const created = await j('/cluster', {
  method: 'POST',
  body: {
    name: 'swarm-live-1',
    mission: 'Democracy test: each worker node invents ONE module name for a hacker dashboard (max 2 words) plus a single sentence justifying it. No tools. Keep it to name + one sentence.',
    nodes: 2, concurrency: 1, policy: 'strict',
    model: { providerID: 'opencode', id: 'glm-5.3-flash-free' },
  },
});
const id = created.j?.id;
console.log('created:', created.status, id, 'status:', created.j?.status);
if (!id) process.exit(1);

const launch = await j(`/cluster/${id}/launch`, { method: 'POST' });
console.log('launched:', launch.status, 'status:', launch.j?.status);

const t0 = Date.now();
let lastStatus = '';
let snapshot = null;
while (Date.now() - t0 < 7 * 60 * 1000) {
  await sleep(5000);
  const g = await j(`/cluster/${id}`);
  const s = g.j?.status;
  if (s !== lastStatus) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] status →`, s); lastStatus = s; }
  snapshot = g.j;
  if (s === 'running' || s === 'done' || s === 'failed') {
    for (const tk of g.j.tasks || []) {
      const tag = `${tk.id}·node-${(g.j.nodeIds || []).indexOf(tk.nodeId) + 1 || '?'}`;
      if (tk.state === 'done' && !tk.printed) { tk.printed = true; console.log('   ✓', tag, 'done ·', String(tk.result || '').replace(/\s+/g, ' ').slice(0, 140)); }
      if (tk.state === 'failed' && !tk.printed) { tk.printed = true; console.log('   ✗', tag, 'FAILED ·', tk.error); }
      if (tk.state === 'running' && !tk.printed) { console.log('   ⋯', tag, 'running'); tk.printed = true; }
    }
  }
  if (['done', 'failed', 'aborted'].includes(s)) break;
}

console.log('final synthesis:', String(snapshot?.synthesis || '(empty)').replace(/\s+/g, ' ').slice(0, 260));
console.log('final note:', snapshot?.note || '(none)');

const tr = await j(`/cluster/${id}/transcript`);
console.log('transcript:', tr.status, 'bytes', (tr.txt || '').length, 'has synthesis:', /## orchestrator synthesis/.test(tr.txt || ''));
console.log('--- transcript head ---\n' + String(tr.txt || '').slice(0, 400));

// leave it around for manual inspection but note removal commands
console.log('\ncluster id kept for inspection:', id);
