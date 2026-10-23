<div align="center">

# ⛧ HAXORDASH

**A phosphor-CRT cockpit for [OpenCode](https://opencode.ai) — and a consent-gated, audited security-ops console.**

[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![deps](https://img.shields.io/badge/dependencies-zero-blueviolet?style=flat-square)](#install)
[![build](https://img.shields.io/badge/build-1024x768%20CRT%2020Hz-black?style=flat-square)](#preview)
[![license](https://img.shields.io/badge/license-MIT-red?style=flat-square)](LICENSE)
[![loopback](https://img.shields.io/badge/bind-127.0.0.1%20only-success?style=flat-square)](#security-model)

*opencode control · model swarms · recon ops · one audit trail*

</div>

```text
 ██╗  ██╗ █████╗ ██╗  ██╗ ██████╗ ██████╗  █████╗ ███████╗██╗  ██╗
 ██║  ██║██╔══██╗██║  ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝
 ███████║███████║███████║██║   ██║██████╔╝███████║███████╗ ╚███╔╝
 ██╔══██║██╔══██║██╔══██║██║   ██║██╔══██╗██╔══██║╚════██║ ██╔██╗
 ██║  ██║██║  ██║██║  ██║╚██████╔╝██║  ██║██║  ██║███████║██╔╝ ██╗
 ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝

  [ bios ] haxordash post · self-contained · zero deps ..... ok
  [ net  ] binding loopback only · 127.0.0.1:3969 .......... ok
  [ sec  ] consent gate · explicit authorization ........... locked
  [ audit] append-only trail · tail -f ..................... on
```

A single dashboard that fronts your local **OpenCode** service — sessions,
MCP servers, skills, plugins, config — and pairs it with a hacker-ops engine
where **every offensive action is behind an explicit, typed, audited
consent gate**. Plus ⌬ cluster mode: multiply one model into a worker swarm
led by an orchestrator session.

---

## Install

```bash
git clone https://github.com/YOURNAME/haxordash.git
cd haxordash
```

There is nothing to install. **Zero npm dependencies, no build step** —
One bootstrap brings OpenCode itself alongside the dashboard:

```bat
install.cmd      :: Windows - verifies Node 20+, installs the opencode CLI
                    (@opencode/cli via npm) when it is missing
./install.sh     :: POSIX equivalent
start.cmd        :: run the dashboard -> http://127.0.0.1:3969
```

> Already have `opencode` on PATH? Skip the bootstrap — `start.cmd` works as
> before. On first run the dashboard wants the OpenCode background service
> up: launch `opencode` once, or set `OPENCODE_BASE_URL`.
> Not a git person? Unzip the release archive and run the same three
> commands — archives are cut straight from the git tree (`git archive`),
> so they never contain runtime data or `.git`.

> Already using OpenCode? The dashboard auto-discovers the shared background
> service (url + credentials) from `opencode service status` /
> `~/.config/opencode/service.json`. Nothing is requested from the network
> except what OpenCode itself does as your agent.

## Run

```bat
start.cmd                 :: Windows — double-click or run
npm start                 :: anywhere
```

Then open **http://127.0.0.1:3969**

```powershell
# headless variant, if you prefer a bg process:
Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden
```

Stop: close the console window, or `Ctrl+C`, or:

```powershell
Get-NetTCPConnection -LocalPort 3969 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Preview

- 10 CRT tabs (`Alt+1…9`, `Alt+0`), phosphor / amber / glacier / blood themes,
  boot sequence, live SSE event feeds at the bottom of the screen.
- Ops console streams tool output live; job outputs auto-archive to artifacts.

## Tabs

| tab | what it does |
|---|---|
| `◉ STATUS` | service vitals, agent roster, providers, MCP status, **token ledger** across all sessions |
| `⌨ SESSIONS` | live chat viewer + composer (prompt / interrupt / fork / delete), mission presets, live agent & model switching, permission replies |
| `⛁ MCP` | live MCP status, connect/disconnect, add (local command / remote url), remove — shape-aware for both config layouts |
| `✦ SKILLS` | list / create / edit / delete skills in `~/.config/opencode/skills` |
| `★ VAULT` | structured findings (severity / target / evidence / source) + markdown report export |
| `⌬ CLUSTER` | model swarms — one orchestrator session decomposes, leads, and digests N cloned workers |
| `⚙ PLUGINS` | loaded plugins + `plugins` array editor + update check |
| `▤ CONFIG` | full `opencode.json` editor: JSONC-tolerant validate, timestamped backups, restore, live reload |
| `☠ OPS` | the ops engine — consent gate, tool detection, pipelines, zero-dep probes, artifact browser |
| `≡ AUDIT` | the append-only trail: every arm / run / probe / policy reply / config write / swarm step |

## How the ops consent works

1. Enter a **single target** + a scope label.
2. Type the exact phrase: `I am authorized to test <target>`
3. Ops stay armed for that target only, for **12 hours**.
4. Every invocation is audited (tool, target, args, stdout file, timestamps).

What this buys you:

| attempt | result |
|---|---|
| arm with wrong phrase | `403 ECONSENT` |
| run while disarmed | `403 EDISARMED` |
| run against another host | `403 ESCOPED` |
| shells built from user input | refused at construction — `400 EINVAL` |

**Ops engine details:** allowlist (nmap, nuclei, httpx, subfinder, arjun,
wafw00f, dig, ssh-audit, whoami, nslookup) spawned **without a shell**;
built-in pipelines `recon` (subfinder → httpx), `quickmap` (nmap → whatweb),
`webscan` (nuclei), `dnsmap` (dig ×3) with `@prev` piping between steps.
Works tool-less too: DNS + HTTP quick probes run on pure Node under the same
gate. Local passive sweeps (`netstat` / `arp` / `tasklist`) read only your own
machine — gate-exempt by design, still audited. Job stdout lands in
`data/artifacts/` and is browsable in the ☠ artifact locker. Find anything?
★ log it to the VAULT and export the markdown report.

## Cluster mode (⌬)

One orchestrator session + N clones of the same model:

```text
   mission → ORCHESTRATOR (plan: JSON, exactly N subtasks)
               │
      ┌────────┼────────┐
   node-1   node-2  … node-N     ← same model, same agent, real sessions
      └────────┼────────┘
   ORCHESTRATOR (synthesis) → done · transcript.md
```

1. Pick the mission, nodes (≤8), parallelism (≤3), agent, model, and a
   permission policy (`manual` — surface & wait / `autoOnce` — answer once /
   `strict` — reject all tool use).
2. The orchestrator is prompted for a strict JSON plan of N independent
   subtasks; a balanced-brace parser + numbered-list fallback handles
   chatty models, with one automatic reformulation retry.
3. HAXORDASH dispatches each subtask (round-robin, busy-aware, 409-tolerant),
   detects completion via the session-idle signal + text-stability check,
   then feeds all reports back to the orchestrator for synthesis.
4. Every swarm session is a real OpenCode session — open any node in
   SESSIONS and watch it work. Transcripts export as markdown.

Guardrails: hard caps, 10-min per-step timeout, interrupt-all abort,
delete-with-sessions, restart recovery (`stalled`), full audit coverage.

## Architecture

```
server.js          http server · routes · /oc/* passthrough · SSE relays
lib/opencode.js    service discovery + basic-auth fetch helper (oc/ocJson)
lib/config.js      opencode.json editor · JSONC parse · backups
lib/skills.js      folder CRUD under ~/.config/opencode/skills
lib/ops.js         consent engine · allowlist jobs · pipelines · probes gate
                     · local sweeps · artifacts · audit log · SSE bus
lib/probe.js       dns + http probes (pure node, gated, audited)
lib/intel.js       findings vault + markdown report
lib/cluster.js     swarm engine: plan → dispatch → synthesis → transcript
lib/agent.js       recon-agent installer + one-click session deployer
public/            vanilla js cockpit (index/app/style) — CRT + themes
test/              plain script smoke suites (no framework)
data/              runtime: audit.log · consent.json · intel · clusters · artifacts
```

## API quick reference (dashboard)

Everything below is loopback-bound JSON.

| method | route | what |
|---|---|---|
| `GET` | `/health` | dashboard liveness |
| `GET/POST` | `/config`, `/config/validate\|save\|restore` | global config editor + backups |
| `GET/POST/PUT/DELETE` | `/skills/:id` | skills CRUD |
| `GET/POST` | `/ops/arm` · `/ops/disarm` · `/ops/killall` | consent gate |
| `POST` | `/ops/run` · `/ops/pipeline` | tool job / pipeline |
| `GET` | `/ops/local/:kind` | netstat / arp / tasklist sweeps |
| `POST` | `/ops/probe/dns` · `/ops/probe/http` | zero-dep probes (gated) |
| `GET` | `/ops/artifacts` · `/ops/artifacts/:id` | artifact browser |
| `GET/POST/DELETE` | `/intel`, `/intel/export` | findings vault, md download |
| `POST` | `/cluster`, `/cluster/:id/launch\|abort` | swarms |
| `GET` | `/cluster/:id` · `/cluster/:id/transcript` | state / md transcript |
| `GET` | `/clusters`, `/cluster/caps` | list / limits |
| `GET/POST` | `/agent/state` · `/agent/install\|deploy` | recon agent |
| `GET` | `/audit` | audit tail |
| any | `/oc/*` | transparent OpenCode REST proxy (auth injected) |
| `GET` | `/ops/events`, `/oc/events` | SSE feeds |

## Configuration

| env | default | meaning |
|---|---|---|
| `HAXOR_PORT` | `3969` | dashboard port (host stays 127.0.0.1) |
| `OPENCODE_BASE_URL` | auto | pin the OpenCode service when discovery is not enough |

Runtime files (gitignored): `data/audit.log` (append-only),
`data/consent.json` (arm state), `data/intel.json`, `data/cluster.json`,
`data/artifacts/*.out`, `data/backups/`.

## Troubleshooting

| symptom | fix |
|---|---|
| double-clicking a `.js` file throws `800A03EA` (JScript syntax error) | that's Windows Script Host (a 2008-era engine), **not Node** — it can't parse `import`/`=>`. Launch with `start.cmd` / `npm start`; run scripts with `node <file>` |
| `opencode unreachable` | run `opencode` once so the shared service is up, or set `OPENCODE_BASE_URL` |
| `EADDRINUSE` on 3969 | kill the previous instance (command above) |
| cluster stuck in `planning` | check the model — a broken/free provider hangs sessions; pick a working model in the spawn panel |
| tool shows "missing" | it is not on PATH; `⟳ rescan` after installing |
| arm says target outside scope | one target per arm; disarm and re-arm |

## Test

```bat
npm run check         :: syntax-checks every entry
node test\haxor-smoke.mjs && node test\haxor-features.mjs && node test\haxor-verify.mjs
:: haxor-cluster-live.mjs runs REAL model sessions — see test\README.md
```

CI (`.github/workflows/ci.yml`) boots the dashboard on Node 20/22/24 and
asserts the health probe, the consent gate refusal, and static assets.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Short version: zero dependencies,
no build step, audited state changes, and the consent gates are sacred.
Security notes live in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — run it against systems you are authorized to test, with the
consent the dashboard insists on. The skull is decorative; the audit trail is not.
