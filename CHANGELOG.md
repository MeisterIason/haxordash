# Changelog

## 1.0.1 — 2026-10-23

Packaging release — ships together with OpenCode.

- `install.cmd` / `install.sh` bootstrap: verifies Node ≥ 20 and auto-installs
  the OpenCode CLI (`@opencode/cli@latest` via npm) when missing — the exact
  distribution this setup is battle-tested on (v2.1.2)
- `start.cmd` prints a one-time hint when `opencode` is not on PATH
- Distribution zip is cut straight from the git tree (`git archive`), so it
  never ships runtime `data/`, `.git`, or credentials; the dashboard keeps
  reading its OpenCode creds live from `~/.config/opencode/service.json`
  (nothing is vendored or embedded)

## 1.0.0 — 2026-10-23

First tagged release.

### Core (dashboard)
- OpenCode lifecycle: STATUS vitals, agent roster, providers, MCP status, token ledger
- SESSIONS: live viewer (v2 message shape), composer with mission presets, agent/model switching, interrupt/fork/delete, permission replies
- MCP: live status, connect/disconnect, add local / remote servers (shape-aware for legacy + servers-keyed configs)
- SKILLS: create / edit / delete `~/.config/opencode/skills`
- PLUGINS: loaded plugins + `plugins` array editor, update check
- CONFIG: `opencode.json` editor, JSONC-tolerant validate, timestamped backups + restore, live reload
- CRT chrome: phosphor/amber/glacier/blood themes, boot sequence, Alt+1..9(+0) tabs, SSE feeds

### Ops (consent-gated)
- Explicit per-target arming with typed authorization phrase, 12h TTL, scope lock, kill switch
- Tool detection, shell-free allowlisted execution, pipelines (`recon`, `quickmap`, `webscan`, `dnsmap`)
- DNS + HTTP quick probes (pure Node, zero external tools)
- Local passive sweeps (netstat / arp / tasklist) — gate-exempt, audited
- Artifact browser; auto-saved job output

### Intel + Cluster
- ★ VAULT findings store + markdown report export
- ⌬ CLUSTER mode: orchestrator + N cloned worker sessions, JSON plan → dispatch → synthesis, abort/delete, permission policies, restart recovery, transcript export

### Security
- Loopback-only bind + DNS-rebinding guard (IPv4/IPv6)
- OpenCode basic-auth stays server-side
- Args blacklist, allowlisted binaries, shell-less spawn
- Append-only audit log for every arm/run/probe/config-write/swarm
