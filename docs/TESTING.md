# Executed validation and remaining gates

Run date: September22,2026. This records measurements, not promises of production readiness.

## Automated Node suite (Workers port)

`npm test` (`node --test`, Node 22.16+) runs the whole suite on real SQLite through the D1-compatible wrapper; `tests/helpers.js` `direct()` drives the real Worker `handle()` with a controllable clock and provider stub, and `tests/api.test.js` / `activity.test.js` go over real HTTP through the local shim. Recorded output: `reports/tests.tap`, `reports/coverage.txt` (regenerated for this change).

Beyond the original rules, solver, replay, analytics, OAuth, Discord signature (now Web Crypto Ed25519) and HTTP ownership/CSRF/static coverage, the port adds: lazy scheduling (opponent moves stamped at their due instants however late the poll, steady cadence without scheduling misses, lazy abandonment/ready expiry freeing the slot); compare-and-swap (simultaneous commands cannot both apply); idempotency; resumable verification (persisted cursor, several steps, tamper rejection, database failures retried rather than rejected); the `cpu_guard` degradation path (flagged, unranked, still verifies); stale queued decisions; the model request carries only public observation and candidates; durable quotas and daily provider reservation; rank eligibility only for verified, live, signed-in matches; lazy housekeeping and retention; paged replay reassembling into a document the shared verifier accepts; and `workers-compat.test.js` (the Worker's import graph has no `node:` module or Node global, `wrangler.jsonc` has the Free-plan shape, the migration applies).

The Chromium checks below, the coverage percentages and the historical benchmark commentary describe the 1.0.0 standalone build; the browser suite was **not** re-run for the Workers port (Python Playwright is not installed in the environment that made this change; the script was updated for the new paths and polling).

## Chromium UI checks

Five workflows passed with no uncaught JavaScript errors in the recorded run:

| Workflow | Checked |
|---|---|
| Desktop play | Both boards, protected opening, opponent progress, explicit flag/unflag, keyboard focus |
| Post-game analysis | Sealed dashboard, detailed action data, JSON download, replay slider |
| History and standings | Own-history panel and public standings empty state |
| Mobile layout | 390px viewport; no document-level horizontal overflow |
| Offline practice | Explicit local-only race and local analytic report |

Actual browser executable was Chromium144. Viewports1440×1100 and390×844. Screenshots and structured results are in `reports/browser/`.

**Important environment limitation:** this runner's administrator Chromium policy blocked URL navigation, including localhost. The test did not change that policy. Instead it loaded the actual app DOM/CSS and modules using a documented test bridge, routing its requests to the real local HTTP server and replacing browser EventSource transport with polling. This exercised rendering and interactions, but did **not** certify browser-native cookie/CSP enforcement, normal navigation, OAuth redirects, browser-native SSE reconnection, or public HTTPS. Separate Node integration tests did exercise real HTTP/SSE server responses, authentication ownership, CSRF and security headers.

The script normally uses direct navigation on a machine without that environment restriction:

```sh
python -m pip install playwright
python -m playwright install chromium
# Start npm start in a separate terminal.
python tests/browser_smoke.py --base http://localhost:3000
```

The special runner fallback is explicit:

```sh
python tests/browser_smoke.py --base http://localhost:3000 --dom-bridge
```

Playwright/Python are development-only and are unnecessary to run the game. The test script uses an available system Chromium when present. Screenshots are observations of the implementation, not independently certified accessibility results. Keyboard/touch primitives and contrast choices were checked visually/functionally; no screen-reader-user study was performed.

## CPU budget evidence

`npm run bench:cpu` writes `reports/cpu/report.md` and `cpu.json`: per-request CPU of every hot path (start, polls that apply or prepare opponent moves, commands, verification steps, replay pages, leaderboard, Discord interaction) per preset and level, plus first-invocation samples from fresh processes. Read its caveats: it is Node's V8 not workerd, local SQLite time is included, and Workers clocks do not advance during CPU work, so production cannot self-time and uses static budgets instead.

## Benchmark evidence

`reports/benchmark/report.md` (regenerated under policy `ms-policy-1.1.0`; beginner clear rates are unchanged from 1.0.0) records 100 board seeds×5 local policies=500 game runs. `reports/benchmark-expert/` adds 40 expert boards, zero invalid moves and zero live provider calls. Paired independent-board races also swap seed assignments. Raw records and traces are included. Clear percentages describe that deterministic seed corpus and those local policies only. They are not measured remote JEV capability, human skill estimates, or a claim that difficulty labels produce statistically distinct remote strength. `--remote` is available only after explicit key configuration.

## Replay and backup checks

The synthetic two-scripted-player sample produced24 events and verified from its released seeds and journal. It is labeled synthetic and excluded from ranking. CSV/JSON/JSONL examples are included. The replay verifier returns a compact result and does not need external services.

The backup script ran successfully against the local live SQLite database and its destination passed integrity_check. The private database and backup are deliberately excluded from the deliverable. Full production restore, OS/service setup, TLS certificate issuance and Docker image build were not performed.

## Static footprint

`reports/static-footprint.json` sums separately gzip-compressed public/shared files. At measurement, all included static modules—including optional offline/replay/analytics modules—totaled41,434 gzip bytes. This is a reproducible asset-size measurement, not actual transfer size under every proxy or a measured first-contentful-paint result. No frontend framework or external font is loaded.

## Remaining deployment validation

Run on the target Node version and through normally navigating browsers. Supply authorized TypeSafe/Discord credentials and test real provider schema/latency, signed launch, exact OAuth callbacks, guild/channel grants, unavailable-provider outcomes, private exports, SSE reconnects and real secure cookies. Exercise worker/database/report load at the intended concurrency, validate expert boards and real mobile touch devices, review retention/licensing/security, and conduct a backup restore drill. None of these live gates should be represented as completed by the bundled mocks, screenshots or local benchmark.
