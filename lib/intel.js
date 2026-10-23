// Intel vault — structured findings with markdown report export.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDirs } from './config.js';
import { audit } from './ops.js';

ensureDirs();
const file = path.join(dataDir, 'intel.json');
function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { v: 1, items: [] }; }
}
function save(db) {
  fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
}

export function listIntel() {
  return load().items.slice().reverse(); // newest first
}

export function addIntel({ target, finding, severity = 'info', evidence = '', source = 'dashboard', tags = [] }) {
  if (!finding || typeof finding !== 'string' || finding.length > 400) throw Object.assign(new Error('finding required (<=400 chars)'), { code: 'EINVAL' });
  const sev = ['info', 'low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'info';
  const db = load();
  const item = {
    id: 'in_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    target: String(target || '').slice(0, 200),
    finding: finding.trim(),
    severity: sev,
    evidence: String(evidence || '').slice(0, 2000),
    source: String(source || 'dashboard').slice(0, 60),
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
  };
  db.items.push(item);
  save(db);
  audit('intel_add', { id: item.id, severity: sev, target: item.target });
  return item;
}

export function delIntel(id) {
  const db = load();
  const before = db.items.length;
  db.items = db.items.filter(x => x.id !== id);
  save(db);
  audit('intel_delete', { id, removed: before !== db.items.length });
  return { id, deleted: before !== db.items.length };
}

export function exportReport() {
  const db = load();
  const items = db.items;
  const lines = [];
  lines.push('# HAXORDASH findings report');
  lines.push(`_generated ${new Date().toISOString()} · ${items.length} finding(s)_`);
  lines.push('');
  lines.push('> Authorization note: all intel below was collected by the operator under explicit per-target authorization. Distribute accordingly.');
  lines.push('');
  if (items.length) {
    lines.push('| ts | target | severity | finding |');
    lines.push('|---|---|---|---|');
    for (const it of items) {
      lines.push(`| ${it.ts} | ${it.target || '—'} | **${it.severity}** | ${it.finding.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    lines.push('');
    lines.push('## Evidence');
    lines.push('');
    for (const it of items) {
      if (it.evidence) { lines.push(`- [${it.id}] (${it.severity}) ${it.finding}`); lines.push(`  - evidence: ${it.evidence.replace(/\n/g, '\n    - ')}`); }
    }
    lines.push('');
  } else {
    lines.push('_vault empty_');
  }
  return lines.join('\n');
}
