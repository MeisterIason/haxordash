// feature smoke: local sweeps, artifacts, probes (consent-gated), intel vault
const B = 'http://127.0.0.1:3969';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓', name, extra); } else { fail++; console.log('  ✗ FAIL', name, extra); } };
const P = async (label, path, opts = {}) => {
  const r = await fetch(B + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.bodystring ?? (opts.body ? JSON.stringify(opts.body) : undefined) });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* raw */ }
  return { status: r.status, j, txt, hdr: r.headers.get('content-disposition') };
};

console.log('== local sweeps (must work DISARMED) ==');
const ns = await P('netstat', '/ops/local/netstat');
ok('netstat 200', ns.status === 200, `rows=${ns.j?.rows?.length}`);
const tcpRow = ns.j?.rows?.find(x => x.proto === 'TCP' && x.local && x.state && x.pid != null);
ok('netstat TCP rows parsed (local/state/pid)', !!tcpRow, tcpRow ? `${tcpRow.local} ${tcpRow.state} pid${tcpRow.pid}` : '');
const udpRow = ns.j?.rows?.find(x => x.proto === 'UDP');
ok('netstat UDP rows parsed', !!udpRow, udpRow ? `pid=${udpRow.pid} state=${udpRow.state}` : '');
const cache1 = await P('netstat-cached', '/ops/local/netstat');
ok('netstat cache hit same ts', cache1.j?.ts === ns.j?.ts);

const arp = await P('arp', '/ops/local/arp');
ok('arp 200', arp.status === 200, `rows=${arp.j?.rows?.length}`);
const tl = await P('tasklist', '/ops/local/tasklist');
ok('tasklist 200', tl.status === 200, `rows=${tl.j?.rows?.length}`);
const tlRow = tl.j?.rows?.find(x => x.name && x.pid && x.mem);
ok('tasklist rows have name/pid/mem', !!tlRow, tlRow ? tlRow.name : '');
const kinds = await P('kinds', '/ops/local');
ok('/ops/local lists 3 kinds', kinds.status === 200 && Object.keys(kinds.j || {}).length === 3, JSON.stringify(Object.keys(kinds.j || {})));

console.log('== artifacts ==');
const arts = await P('artifacts', '/ops/artifacts');
ok('artifacts 200 list', arts.status === 200, `count=${arts.j?.artifacts?.length}`);
if (arts.j?.artifacts?.length) {
  const a0 = arts.j.artifacts[0];
  const read = await P('read first', '/ops/artifacts/' + encodeURIComponent(a0.id));
  ok('artifact read 200 + has text', read.status === 200 && typeof read.j?.text === 'string', `bytes=${read.j?.bytes}`);
} else ok('(no artifacts yet — will appear after first job)', false, 'note');
const badArt = await P('bad id', '/ops/artifacts/../evil');
ok('bad artifact id rejected (4xx or sanitized)', badArt.status >= 400 || badArt.status === 200 && !!badArt.j?.error, 'status=' + badArt.status);

console.log('== probes (consent gate) ==');
const probeDis = await P('dns-probe disarmed', '/ops/probe/dns', { method: 'POST', body: { target: '127.0.0.1' } });
ok('probe disarmed → 403 EDISARMED', probeDis.status === 403 && probeDis.j?.code === 'EDISARMED', JSON.stringify(probeDis.j));

// arm for 127.0.0.1
const arm = await P('arm', '/ops/arm', { method: 'POST', body: { target: '127.0.0.1', confirmText: 'I am authorized to test 127.0.0.1', scope: 'feature-smoke' } });
ok('arm 200', arm.status === 200 && arm.j?.armed === true);

const probeOther = await P('dns-probe other host', '/ops/probe/dns', { method: 'POST', body: { target: 'example.com' } });
ok('probe out-of-scope → 403 ESCOPED', probeOther.status === 403 && probeOther.j?.code === 'ESCOPED', JSON.stringify(probeOther.j));

const dns = await P('dns-probe 127.0.0.1', '/ops/probe/dns', { method: 'POST', body: { target: '127.0.0.1' } });
ok('dns probe 200', dns.status === 200, dns.j ? `ipLiteral=${dns.j.ipLiteral}` : dns.txt.slice(0, 80));
ok('dns probe reverse lookup present', dns.j && 'reverse' in dns.j, JSON.stringify(dns.j?.reverse));
ok('dns probe shape has target+ts', dns.j?.target === '127.0.0.1' && !!dns.j?.ts);

const http = await P('http-probe 127.0.0.1', '/ops/probe/http', { method: 'POST', body: { target: '127.0.0.1' } });
ok('http probe 200 with attempts', http.status === 200 && Array.isArray(http.j?.attempts), `attempts=${http.j?.attempts?.length} first=${JSON.stringify(http.j?.attempts?.[0])?.slice(0, 90)}`);

const probeBad = await P('probe injection', '/ops/probe/dns', { method: 'POST', body: { target: '127.0.0.1 | dir' } });
ok('probe injection → 400 EINVAL', probeBad.status === 400 && probeBad.j?.code === 'EINVAL', JSON.stringify(probeBad.j));
const probePort = await P('probe with port', '/ops/probe/dns', { method: 'POST', body: { target: 'example.com:443' } });
ok('probe port suffix → 400 EINVAL', probePort.status === 400 && probePort.j?.code === 'EINVAL', JSON.stringify(probePort.j));

const disarm = await P('disarm', '/ops/disarm', { method: 'POST', body: {} });
ok('disarm 200', disarm.status === 200);

console.log('== intel vault ==');
const add1 = await P('add finding', '/intel', { method: 'POST', body: { target: '127.0.0.1', finding: 'smoke finding A', severity: 'medium', evidence: 'pid 4242 listening', tags: ['smoke'] } });
ok('intel add 200 + id', add1.status === 200 && /^in_/.test(add1.j?.id || ''), add1.j?.id);
const add2 = await P('add finding2', '/intel', { method: 'POST', body: { target: '127.0.0.1', finding: 'smoke finding B (critical)', severity: 'critical' } });
ok('intel add2 200', add2.status === 200);
const list = await P('list', '/intel');
ok('intel list newest first', list.j?.items?.[0]?.finding?.includes('B') === true, `items=${list.j?.items?.length}`);
const invalidAdd = await P('add invalid', '/intel', { method: 'POST', body: {} });
ok('intel add invalid → 400', invalidAdd.status === 400, JSON.stringify(invalidAdd.j));
const exp = await P('export', '/intel/export');
ok('export markdown + attachment header', exp.status === 200 && exp.hdr?.includes('attachment') && exp.txt.startsWith('# HAXORDASH'), `bytes=${exp.txt.length}`);
ok('export contains both findings', exp.txt.includes('smoke finding A') && exp.txt.includes('smoke finding B'));
const del1 = await P('del1', '/intel/' + add1.j.id, { method: 'DELETE' });
const del2 = await P('del2', '/intel/' + add2.j.id, { method: 'DELETE' });
ok('intel deletes 200 deleted:true', del1.j?.deleted === true && del2.j?.deleted === true);
const listEmpty = await P('list after del', '/intel');
ok('vault empty again', (listEmpty.j?.items || []).length === 0, `items=${listEmpty.j?.items?.length}`);

console.log('== static assets ==');
for (const p of ['/', '/app.js', '/style.css']) {
  const r = await fetch(B + p);
  ok('GET ' + p + ' 200', r.status === 200);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
