// smoke test for hackerdash endpoints
const B = 'http://127.0.0.1:3969';
const out = [];
const t = async (label, path, opts) => {
  try {
    const r = await fetch(B + path, { method: opts?.method || 'GET', headers: opts?.body ? { 'Content-Type': 'application/json' } : {}, body: opts?.body ? JSON.stringify(opts.body) : undefined });
    const txt = await r.text();
    out.push(`${r.status} ${label} :: ${txt.slice(0, 180)}`);
    return { status: r.status, body: (() => { try { return JSON.parse(txt); } catch { return txt; } })() };
  } catch (e) { out.push(`ERR ${label} :: ${e.message}`); return {}; }
};

await t('GET /ops/tools', '/ops/tools');
await t('GET /config', '/config');
await t('GET /skills', '/skills');
await t('oc /api/mcp', '/oc/api/mcp');
await t('oc /api/info', '/oc/api/info');
await t('GET /ops/state', '/ops/state');

// consent must refuse wrong phrase
await t('ARM (bad phrase)', '/ops/arm', { method: 'POST', body: { target: '127.0.0.1', confirmText: 'nope' } });
await t('run while wrong-armed → expect job ok or refused', '/ops/run', { method: 'POST', body: { tool: 'whoami', args: '', target: '127.0.0.1' } });

// arm correctly
await t('ARM (good phrase)', '/ops/arm', { method: 'POST', body: { target: '127.0.0.1', scope: 'smoke-test', confirmText: 'I am authorized to test 127.0.0.1', note: 'local only' } });
await t('run scoped mismatch → expect scope refused', '/ops/run', { method: 'POST', body: { tool: 'whoami', args: '', target: 'example.com' } });

// forbidden chars
await t('run with pipe bomb char', '/ops/run', { method: 'POST', body: { tool: 'whoami', args: '/priv | this-should-fail', target: '127.0.0.1' } });

// legit local job
const start = await t('run whoami', '/ops/run', { method: 'POST', body: { tool: 'whoami', args: '', target: '127.0.0.1' } });
const jobId = start.body?.id;
if (jobId) {
  await new Promise(r => setTimeout(r, 1500));
  await t('job output', '/ops/jobs/' + jobId);
} else out.push('!! no job id returned');

await t('GET /ops/jobs', '/ops/jobs');
await t('GET /audit', '/audit');
await t('DISARM', '/ops/disarm', { method: 'POST', body: {} });
await t('state after', '/ops/state');

console.log(out.join('\n'));
