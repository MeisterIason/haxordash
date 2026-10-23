# Security Policy — HAXORDASH itself

This is a dashboard for people who break things **with authorization**. That
means the dashboard's own posture matters more than usual.

## What HAXORDASH does to stay safe

- **Loopback-only.** The server binds `127.0.0.1` exclusively. There is no
  bind-all switch. Anyone on your LAN cannot reach it; a DNS-rebinding page
  cannot either (Host-header guard; IPv4 + IPv6 forms both handled).
- **No shell, ever.** Ops tools spawn via `child_process.spawn` with
  `shell: false`, from a fixed allowlist (`nmap`, `nuclei`, `httpx`,
  `subfinder`, `arjun`, `wafw00f`, `dig`, `ssh-audit`, `whoami`, `nslookup`).
- **Args denylist.** `& | ; < > ^` + backticks + quotes + CR/LF are rejected
  with `400 EINVAL` before the process is constructed.
- **Consent gate.** Offensive routes (`/ops/run`, pipelines, probes) require
  an *armed* state: one explicit target + the typed phrase
  `I am authorized to test <target>`. Out-of-scope targets → `403 ESCOPED`.
  Wrong phrase → `403 ECONSENT`. Stale arm (>12h) → expired automatically.
- **Audit everything.** `data/audit.log` is append-only, every arm / run /
  probe / policy reply / config write / cluster step. Deleting it manually is
  not prevented — that is a trust decision left to you, not to the tool.
- **Local passive sweeps** (`netstat`, `arp`, `tasklist`) read only the local
  machine; they bypass the arm gate on purpose and remain audited.
- **Your OpenCode service password** is read from `~/config/opencode/service.json`
  in-process and injected server-side. It is never exposed to the browser,
  never logged, never part of any download.
- **Cluster mode** runs real model sessions. It cannot touch your files
  beyond what OpenCode itself allows, and ships with node/count/parallelism
  caps plus interrupt-all. The `strict` permission policy rejects all tool
  calls from swarm sessions.

## Known limitations

- The dashboard trusts you, the local user, fully. It is single-session,
  unauthenticated by design: anything able to run JS in your browser on
  `http://127.0.0.1:3969` can call its API. That is exactly why the
  Origin/Host guard exists — but a malicious browser extension with
  `http://127.0.0.1:3969` in its granted list could still talk to it.
- Data files in `data/` (audit, intel, clusters, artifacts) are plain files
  readable by any local user/process on the same account.

## Reporting

- **Security-relevant bug in HAXORDASH** (gate bypass, injection, token
  leak): open a GitHub issue titled `[security] …` in detail, or email the
  owner privately if you prefer responsible disclosure. Please include the
  smallest `curl` reproduction that shows the refusal did not happen.
- **Bugs in the insanity cockpit** (rendering, ergonomics): normal issues.
- **How to report an OpenCode bug** the dashboard discovered: the UI surfaces
  the upstream error message verbatim — reproduce it with `curl` against
  `http://<opencode-host>/api/...` and file it upstream.

## What we will not help with

Requests to bypass the consent gate, un-arm remotely, or point HAXORDASH at
systems without authorization. The project exists to *make* authorization
auditable, not to make skid-scans easier.
