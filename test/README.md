# test/ — plain-terminal smoke suites

No test framework. Each file is a standalone `.mjs` that talks to a **running**
dashboard at `http://127.0.0.1:3969` (`HAXOR_PORT` changes that).

Prereqs:

```bat
cd <repo>
npm start           // or start.cmd, in another window
```

| file | covers | cost |
|---|---|---|
| `haxor-smoke.mjs` | routes 200, consent gate (bad phrase / disarmed / out-of-scope / injection), whoami job + audit, disarm | none — safe |
| `haxor-features.mjs` | local sweeps, artifacts, probes (gated), intel vault CRUD + export | none — safe (uses 127.0.0.1 targets) |
| `haxor-verify.mjs` | session create/interrupt/delete round-trip, message-shape render | none — creates + deletes probe sessions |
| `haxor-cluster-live.mjs` | full cluster lifecycle on the real model: plan → dispatch → synthesis, transcript | real model sessions — free-tier default OK; verify the model first |
| `haxor-prompttest.mjs` | REST prompt sanity for a fresh session + model switch | one tiny model call |

Run them one at a time (they arm/disarm and assert global state; parallel
runs race each other on the arm state window).
