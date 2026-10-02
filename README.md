<p align="center"><img src="assets/banner.jpg" alt="Pixel-art robot Jev at a neon Minesweeper grid with red flags and a glowing mine in a purple arcade" width="100%"></p>

# Minesweeper vs JEV

A runnable, server-authoritative two-board Minesweeper race with a vanilla JavaScript interface, TypeSafe/JEV adapter, Discord identity and community context, verified leaderboards, deterministic replays, and detailed replay-derived analytics.

**Delivery status:** implemented and locally tested; hosted on Cloudflare Workers (Free plan) + D1 at `minesweeper.jevplay.games` per `docs/DEPLOYMENT.md`. Real TypeSafe credentials, Discord authorization, and the Cloudflare deployment itself were not exercised in this environment. Without credentials, the application works against an explicitly labeled local solver; those games are unofficial.

## Run locally

Use Node.js **22.16.0 or later** (built-in SQLite; Node prints an experimental warning). `npm start` is a local development shim over the same Worker code production runs (`server/worker.js`), with SQLite standing in for D1. There are **no npm runtime dependencies and no frontend build step**.

```sh
cd jev-minesweeper
npm start
```

Open `http://localhost:3000`. Select **New game**, then click your starting square. The same coordinate opens on JEV's independently generated board. `npm start` tolerates a missing `.env` and creates a private SQLite database under `data/`. To deploy, follow `docs/DEPLOYMENT.md` (`npm run deploy`, `npm run db:remote`).

For configuration, copy `.env.example` to `.env`, edit the relevant values, and restart. On Windows PowerShell, use `Copy-Item .env.example .env`; on macOS/Linux, use `cp .env.example .env`.

## Included application

The browser offers beginner (9×9/10), intermediate (16×16/40), and expert (30×16/99) boards. Easy, Normal, Hard, and JEV reasoning levels change deduction and enumeration budgets rather than introducing deliberate random mistakes. Both boards use the same preset but independent hidden layouts. The protected first opening, reveal, flag/unflag, zero expansion, and safe/unsafe chording are implemented.

First to reveal every safe cell wins. A single explosion does not award the other player a win: the surviving player still has to clear. Two explosions or an uncleared deadline draw. Clears in the same 100-ms interval draw. Resignation or abandonment after starting loses. Rankings use wins divided by eligible completed matches, with twenty matches needed to qualify.

The interface includes touch reveal/flag modes, keyboard navigation, standard and 44-pixel large-cell modes, visible focus, reduced-motion support, readable status, accessible data tables, a replay slider, and an explicitly selected local offline-practice mode for an already loaded page. It does not promise a cold offline load or local JEV inference.

## Analytics included

| Area | Examples |
|---|---|
| Action-level performance | Reveal/flag/unflag/chord counts, safe-cell yield, flood expansion, per-command timing, idle gaps, command rate, first/last action |
| Decision quality | Proven-safe versus unresolved reveals, known-mine selections, available safe alternatives, exact-risk coverage, known-alternative regret, constraint/frontier complexity |
| Flags and board structure | Post-game precision/recall/F1, incorrect flags, churn, zero regions, opening-size distribution, adjacency histogram, static 3BV, edge/corner mines |
| Race dynamics | Progress timeline, time ahead/tied, lead changes, largest leads, integrated lead area, clear-only timing |
| JEV behavior | Candidate and legal-action counts, evidence, selected action, risk source, selection confidence, solver nodes/cutoffs, latency distributions, HTTP attempts/retries, errors and fallbacks |
| Probability calibration | Selected and all-evaluated safety forecasts, Brier score, log loss, ten reliability bins, expected calibration error, sample counts |
| Operations and integrity | Rejected requests, idempotent retries, reconnects, scheduling misses, verification state, rank eligibility and reasons |
| History and rankings | W/L/D, clear-win rate, Wilson intervals, actual clear times, streaks, size/difficulty/period/mode filters, Channel/Server/World views |
| Export | Analytics JSON, action CSV, timeline CSV (derived in your browser from the verified replay), event JSONL, replay JSON, history CSV, own-profile JSON |

**Truth-derived data is sealed until the match is over.** No active mine bitmap, unrevealed adjacency, correct-flag signal, or hindsight evaluation is sent to the player or opponent. Undefined ratios and missing usage produce `null`, not fabricated zeros. A full metric dictionary and a generated field catalog are included.

Read [ANALYTICS.md](docs/ANALYTICS.md) before interpreting probabilities, speed, 3BV, or estimated cost. An unresolved move is not proof that guessing was unavoidable. Choice confidence is not cell safety. Recorded commands are not physical mouse clicks. Provider usage is not a billing guarantee.

## Enable actual JEV

Set `TYPESAFE_API_KEY` in `.env`, keep or deliberately change the pinned `JEV_MODEL`, and restart. The server sends bounded visible-state questions directly to TypeSafe; the key never reaches the browser. The adapter validates typed Choice/Noul/Score answers and selected legal actions.

A forced single candidate is a deterministic deduction, not a remote request. Missing credentials, service failures, and local fallbacks are labeled. Ranked service delays beyond the allowed tolerance or fallback use permanently disqualify the match. Difficulty labels describe configured reasoning budgets; they are not measured claims about real JEV strength.

## Enable Discord and community rankings

Set the three Discord application values in `.env`. Configure the exact callback `APP_ORIGIN/api/auth/discord/callback` and interaction endpoint `APP_ORIGIN/api/discord/interactions`. Use the commands-only guild installation and register the launch command:

```sh
npm run discord:register
```

Run `/jev play` in a guild text channel, follow its private expiring launch link, and sign in with that same Discord account. OAuth establishes the user; a verified signed interaction establishes channel/server context. Raw URL guild IDs are never accepted. See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for the setup sequence and limitations.

## Tests, replay verification, and benchmarks

```sh
npm test
npm run test:coverage
npm run verify -- reports/sample/replay.json
npm run bench -- --boards 100
```

The included benchmark ran **100 matched boards across five local policies: 500 games**. It made **zero live JEV calls**. Raw game records, action traces, clear-rate intervals, and paired/swapped independent-board race results are in `reports/benchmark/`.

A separately requested live benchmark is supported and can incur provider charges:

```sh
npm run bench -- --boards 100 --remote --difficulty jev --out reports/live-jev
```

No missing-key substitution is allowed for `--remote`; failures in an authorized live run remain counted in its results. Do not present the bundled local baseline as JEV performance.

The optional browser test uses Python Playwright, a development-only tool, not an application dependency. This runner's Chromium navigation policy blocked normal URL navigation, so recorded UI checks used a documented DOM/API bridge. Native Node HTTP/SSE, ownership, CSRF, and server headers were tested separately. See [TESTING.md](docs/TESTING.md).

## Files to start with

| File | Purpose |
|---|---|
| `public/index.html`, `game.css`, `game.js` | Single-page interface and dashboards |
| `public/shared/engine.js` | Deterministic rules and safe observations |
| `public/shared/solver.js`, `decisions.js` | Public-state deductions and typed decisions |
| `public/shared/replay.js`, `analytics.js` | Verification and post-game analytics |
| `server/worker.js`, `matches.js` | Worker entry/routing and the lazy, compare-and-swap match lifecycle |
| `server/main.js`, `local-db.js` | Local development shim (Node http, SQLite behind the D1 interface) |
| `server/discord.js`, `security.js` | Login, session, launch-context boundaries |
| `migrations/`, `server/db.js`, `wrangler.jsonc` | D1 schema, async database layer, Cloudflare configuration |
| `docs/ARCHITECTURE.md` | A–Z design mapped to the implemented files |
| `docs/ANALYTICS.md` | Metric definitions, formulas, populations, caveats |
| `docs/API.md`, `SECURITY.md`, `DEPLOYMENT.md` | Integration and operations |
| `reports/` | Measured tests, screenshots, benchmarks, synthetic sample exports |

## Operational boundaries

This runs inside the Cloudflare Workers Free plan (10 ms CPU per request, 100 k requests/day, D1 write allowance) with durable daily caps; it is not a horizontally distributed tournament platform. CPU figures in `reports/cpu/` are from Node, not workerd. See `docs/DEPLOYMENT.md`.

Hidden-information and replay controls prevent straightforward score/state forgery. They do not prove that the human used no external assistance, prevent a trusted host operator from altering its own data, or constitute an independent security/accessibility certification. Real-provider smoke testing and a production load/security review remain deployment gates.

No external fonts, artwork, proprietary SDKs, credentials, runtime database, or third-party source bundles are included. `UNLICENSED` means no public redistribution license has been selected for this project; choose the appropriate terms before publishing.
