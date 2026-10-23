# Contributing to HAXORDASH

Thanks for touching the cockpit. Rules of the hangar:

## Ground rules

- **Zero npm dependencies.** Everything runs on what Node ships. If you need
  a library, argue for it in the issue first — the default answer is a
  40-line hand-rolled version.
- **No build step.** Vanilla JS against `public/`. If it needs a bundler it
  does not belong.
- **Windows-first, POSIX-welcomed.** The primary target is Windows (local
  sweeps, tool resolution). Keep cross-platform code paths explicit and
  tolerant (`fs.existsSync` your surroundings before touching them).
- **Everything observable is audited.** Any new state-changing route must
  call `audit(kind, data)` and emit an SSE event, or it will not land.
- **Consent gates are sacred.** New offensive capabilities get wired through
  `assertArmed()` like the existing ones. Local-only additions must
  document why they are exempt.

## Dev loop

```bat
npm run check       // syntax-check server + libs + frontend
npm start           // http://127.0.0.1:3969
```

Then in `test/` (see `test/README.md`) — the suites are plain `.mjs` scripts
against a running dashboard, no test framework required:

```bat
node test\haxor-smoke.mjs        // consent gate + route sanity
node test\haxor-features.mjs     // sweeps, probes, artifacts, vault
node test\haxor-verify.mjs       // session lifecycle
// haxor-cluster-live.mjs runs REAL model sessions — read its header first
```

## Style

- Dark phosphor over cleverbright UIs. CSS vars in `:root`, theme overrides
  under `body[data-theme="…"]`.
- Errors: `Object.assign(new Error(msg), { code: 'E*' })`; the proxy turns
  them into honest HTTP statuses (403/400/404 — never 500 for a refusal).
- Strings visible in the UI get `esc()`-ed. No exceptions, no "it's fine".

## PR checklist

- [ ] `npm run check` passes
- [ ] Relevant `test/*.mjs` passes against your local instance
- [ ] New state-changing actions audit + emit
- [ ] No new dependencies, no build steps
- [ ] Windows behavior unchanged (or improved)
