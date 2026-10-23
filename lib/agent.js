// Deploy a hacker-operated OpenCode session.
// Installs the "sxrecon" agent into the global config (once), then creates a
// session assigned to it and fires the prompt with target + authorization text.
// Config shape: agents is a MAP keyed by name, instructions live in `system`
// (per opencode.ai/v2/docs/config — Agents).
import { readConfig, writeConfig, ensureDirs } from './config.js';
import { ocJson } from './opencode.js';
import { loadState, audit, assertArmed } from './ops.js';

const AGENT_NAME = 'sxrecon';

const AGENT_DEF = {
  description: 'Sandbox recon operator, spawned from the Haxor dashboard.',
  mode: 'primary',
  temperature: 0.2,
  system: `You are SX-RECON, a disciplined offensive-research operator.
You work EXCLUSIVELY against the target stated in the operator prompt of each session.
Session rules (non-negotiable):
- The operator must have armed this session with an authorization statement. Repeat the authorization at the top of your first reply.
- Passive recon first (DNS, HTTP headers, banners). Active scanning only if the operator asks.
- Never exfiltrate or destroy data. Findings are for the operator's report only.
- Prefer quiet, low-rate tools (subfinder, httpx -silent, nmap -T2/-T4 --top-ports, dig).
- Keep every conclusion evidence-linked (command -> observation -> inference).
- Maintain a findings ledger at the end of your final answer: [severity][finding][evidence][next step].`,
};

function agentsShaped(cfg) {
  const a = cfg?.agents;
  if (a === undefined) return { kind: 'none' };
  if (Array.isArray(a)) return { kind: 'array', value: a };
  if (typeof a === 'object' && a !== null) return { kind: 'map', value: a };
  return { kind: 'none' };
}

function hasAgent(shaped, name) {
  if (shaped.kind === 'array') return shaped.value.some(a => a && a.name === name);
  if (shaped.kind === 'map') return Object.prototype.hasOwnProperty.call(shaped.value, name);
  return false;
}

export async function agentInstalled() {
  const { text } = readConfig();
  try {
    const cfg = JSON.parse(text);
    return { installed: hasAgent(agentsShaped(cfg), AGENT_NAME), name: AGENT_NAME };
  } catch {
    return { installed: false, name: AGENT_NAME };
  }
}

export async function installAgent() {
  ensureDirs();
  const { path: p, text } = readConfig();
  const cfg = JSON.parse(text); // throws if invalid — refuse to clobber
  const shaped = agentsShaped(cfg);
  if (!hasAgent(shaped, AGENT_NAME)) {
    if (shaped.kind === 'array') shaped.value.push({ ...AGENT_DEF, name: AGENT_NAME });
    else cfg.agents = { ...(shaped.kind === 'map' ? shaped.value : {}), [AGENT_NAME]: { ...AGENT_DEF } };
    const backup = writeConfig(JSON.stringify(cfg, null, 2) + '\n');
    await ocJson('/api/location/reload', { method: 'POST' });
    audit('agent_install', { agent: AGENT_NAME, configBackup: backup.backup });
    return { installed: true, name: AGENT_NAME, backup: backup.backup, path: p };
  }
  return { installed: true, name: AGENT_NAME };
}

export async function deployReconOp({ target }) {
  const s = assertArmed(target); // also normalizes scope match
  await installAgent();
  const auth = `Authorization: ${s.armedAt ? new Date(s.armedAt).toISOString() : 'n/a'} — operator confirmed authorized testing of ${s.target}${s.note ? ' (' + s.note + ')' : ''}`;

  const session = await ocJson('/api/session', {
    method: 'POST',
    body: {
      title: `RECON ${s.target}`,
      agent: AGENT_NAME,
    },
  });
  const sid = session?.data?.id || session?.id || session?.info?.id;
  if (!sid) throw new Error('session create returned no id: ' + JSON.stringify(session).slice(0, 200));

  const prompt = [
    'MISSION BRIEF (from Haxor dashboard):',
    `- Target: ${s.target}`,
    `- Scope: ${s.scope}`,
    `- ${auth}`,
    s.note ? `- Operator note: ${s.note}` : '',
    '',
    'Begin with a MANDATORY pre-flight block: (1) restate the authorization, (2) passive recon plan, (3) the exact commands you will run first.',
    'Then execute the passive recon plan now: subfinder/httpx if present, else dig/nslookup and whatweb when available.',
    'End with a findings ledger.',
  ].filter(Boolean).join('\n');

  await ocJson(`/api/session/${sid}/prompt`, { method: 'POST', body: { text: prompt } });
  audit('recon_session', { target: s.target, sessionID: sid });
  return { sessionID: sid, target: s.target, agent: AGENT_NAME };
}

export const RECON_AGENT_NAME = AGENT_NAME;
