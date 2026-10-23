// Sessions content search — grep across ALL OpenCode sessions:
// titles first (cheap), then message text (one /session/:id/message call per
// session), batched in small parallel groups. Designed as an explicit user
// action (Enter / button), not a per-keystroke query — a few hundred sessions
// scan in roughly a second over loopback.
import { ocJson } from './opencode.js';

const BATCH = 6;
const MATCH_LIMIT = 50;

// Flatten a v2 message into searchable text (text + reasoning parts; tool
// parts are noise for a content search).
function msgText(m) {
  const parts = m.content || m.parts || [];
  const out = [];
  for (const p of parts || []) {
    if (!p) continue;
    if ((p.type === 'text' || p.type === 'reasoning') && p.text) out.push(String(p.text));
  }
  return out.join('\n');
}

function roleOf(m) {
  const r = m.type || m.role || '?';
  return { assistant: 'agent', user: 'operator', tool: 'tool' }[r] || r;
}

function snippet(text, idx, qLen) {
  const a = Math.max(0, idx - 60);
  const b = Math.min(text.length, idx + qLen + 90);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}

export async function sessSearch(qRaw) {
  const q = String(qRaw || '').trim().toLowerCase();
  if (q.length < 2) throw Object.assign(new Error('search query must be 2+ characters'), { code: 'EINVAL' });
  const t0 = Date.now();
  const res = await ocJson('/api/session?limit=200');
  const sessions = (Array.isArray(res) ? res : res.data) || [];
  const matches = [];
  let scanned = 0;

  for (let i = 0; i < sessions.length; i += BATCH) {
    await Promise.all(sessions.slice(i, i + BATCH).map(async (s) => {
      try {
        const title = String(s.title || '');
        const titleHit = title.toLowerCase().includes(q);
        let msgHits = 0;
        let snip = null;
        if (titleHit) snip = { role: 'title', text: title.trim().slice(0, 160) };
        const r = await ocJson(`/api/session/${s.id}/message`);
        const msgs = (Array.isArray(r) ? r : r.data) || [];
        for (const m of msgs) {
          const text = msgText(m);
          if (!text) continue;
          const idx = text.toLowerCase().indexOf(q);
          if (idx >= 0) {
            msgHits++;
            if (!snip) snip = { role: roleOf(m), text: snippet(text, idx, q.length) };
          }
        }
        if (titleHit || msgHits) {
          matches.push({ id: s.id, title: title || s.id, updated: s.time?.updated ?? 0, titleHit, msgHits, snippet: snip });
        }
        scanned++;
      } catch { /* dead/unreadable session — skip, never abort the scan */ }
    }));
  }

  matches.sort((a, b) => b.updated - a.updated || (b.msgHits + b.titleHit) - (a.msgHits + a.titleHit));
  const capped = matches.length > MATCH_LIMIT;
  const out = matches.slice(0, MATCH_LIMIT).map((m) => ({ ...m, snippet: m.snippet ? { ...m.snippet, text: m.snippet.text.slice(0, 220) } : null }));
  return {
    q: String(qRaw).trim(),
    total: sessions.length,
    scanned,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    matches: out,
    truncated: capped,
  };
}
