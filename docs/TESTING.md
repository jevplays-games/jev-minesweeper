# Executed validation and remaining gates

Run date: September22,2026. This records measurements, not promises of production readiness.

## Automated Node suite

**141 passed; 0 failed, canceled, skipped or TODO.** Actual runtime: Node22.16.0. Native SQLite was available and emitted its experimental-status warning. Commands: `npm test` and `npm run test:coverage`. Full outputs: `reports/tests.tap` and `reports/coverage.txt`.

Tests cover deterministic generation and protected openings; reveal, flag and chord legality; row/edge behavior; explosion/completion precedence; two-board outcome/tie/deadline logic; privacy projections; replay/hash/result tampering; candidate/probability/model validation; provider retry/timeout mocks; observation-equivalence; independent small-board exact-probability enumeration; OAuth-state/session behavior; cryptographically valid/invalid Discord signatures; launch bindings; SQLite transactions; actual HTTP ownership/CSRF/static boundaries; native SSE snapshots and owner rejection; analytics count/ratio/calibration/CSV semantics; profile/standing scope separation and provisional ranks. Recorded mocked provider decisions are re-verified without another inference request.

Selected instrumented module line coverage in the recorded coverage run: rules engine100%; JEV adapter100%; security100%; replay97.56%; analytics96.64%. These percentages are **line coverage**, not proof of all behaviors, branch coverage, correctness, security or service integration. The full report identifies unexecuted branches and excludes browser execution from its Node coverage. Its aggregate includes test/helper files and should not be relabeled application-only coverage.

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

## Benchmark evidence

`reports/benchmark/report.md` records100 board seeds×5 local policies=500 game runs, zero invalid moves and zero live provider calls. Paired independent-board races also swap seed assignments. Raw records and traces are included. Clear percentages describe that deterministic seed corpus and those local policies only. They are not measured remote JEV capability, human skill estimates, or a claim that difficulty labels produce statistically distinct remote strength. `--remote` is available only after explicit key configuration.

## Replay and backup checks

The synthetic two-scripted-player sample produced24 events and verified from its released seeds and journal. It is labeled synthetic and excluded from ranking. CSV/JSON/JSONL examples are included. The replay verifier returns a compact result and does not need external services.

The backup script ran successfully against the local live SQLite database and its destination passed integrity_check. The private database and backup are deliberately excluded from the deliverable. Full production restore, OS/service setup, TLS certificate issuance and Docker image build were not performed.

## Static footprint

`reports/static-footprint.json` sums separately gzip-compressed public/shared files. At measurement, all included static modules—including optional offline/replay/analytics modules—totaled41,434 gzip bytes. This is a reproducible asset-size measurement, not actual transfer size under every proxy or a measured first-contentful-paint result. No frontend framework or external font is loaded.

## Remaining deployment validation

Run on the target Node version and through normally navigating browsers. Supply authorized TypeSafe/Discord credentials and test real provider schema/latency, signed launch, exact OAuth callbacks, guild/channel grants, unavailable-provider outcomes, private exports, SSE reconnects and real secure cookies. Exercise worker/database/report load at the intended concurrency, validate expert boards and real mobile touch devices, review retention/licensing/security, and conduct a backup restore drill. None of these live gates should be represented as completed by the bundled mocks, screenshots or local benchmark.
