# Changelog

## 1.0.4 — 2026-10-23

Session viewer layout fix.

- The composer bar (prompt input, send / interrupt / fork / 🗑 delete) is
  now **pinned to the bottom of the viewer** — always visible, no scrolling
- The transcript scrolls independently inside the panel and auto-pins to
  the newest message on each render (chat-client behavior); the composer
  never moves out of reach
- Session-deletion state resets the poll signature so a re-render fires
  cleanly afterwards

## 1.0.3 — 2026-10-23

Sessions content search.

- New endpoint `GET /api/sess-search?q=…` — scans titles **and message text**
  across all sessions via the OpenCode API, batched 6-wide, returns one row
  per session with title/message hit counts and a first-match snippet
  (≤ 50 matches, newest first)
- `⌨ SESSIONS` tab gains a search box (Enter or ⌕ button): results show the
  matched role (`operator` / `agent` / `title`) with the snippet, and clicking
  a result opens that session in the viewer
- Quick filter stays for the 60 loaded titles; search reaches everything

## 1.0.2 — 2026-10-23

Linux port — verified live on Kali Linux (WSL2), 18-check suite green.

- Local sweeps are platform-aware: `netstat.exe`/`arp.exe`/`tasklist.exe` on
  Windows, `ss -tunap` / `ip neigh` / `ps auxww` on Linux — same row shape,
  no UI changes
- Tool detection uses `which` on POSIX (`where.exe` stays on Windows)
- Everything else was already portable: XDG config discovery, pure-Node
  DNS/HTTP probes, consent gate, audit trail, cluster mode, CRT cockpit
- Windows regression: ops/feature suite still 32/32

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
