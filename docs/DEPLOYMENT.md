# Setup, deployment, and recovery

Production is **Cloudflare Workers (Free plan) + D1 + Static Assets** at `https://minesweeper.jevplay.games`. There is no container, no long-lived process and no cron trigger. Local development uses a small Node shim over the same Worker code.

## 1. Local start

Node.js **22.16 or later** (built-in `node:sqlite`; Node prints an experimental-SQLite warning). No `npm install` is needed.

```sh
npm start        # http://localhost:3000 ; SQLite file under data/
npm test         # real SQLite through the D1-compatible wrapper
```

`server/main.js` adapts Node's `http` to the Worker's `handle(request, env, ctx)` and builds the same `env` the Worker gets: `DB` (node:sqlite behind `prepare().bind().first()/all()/run()` and `batch()`, in `server/local-db.js`, applying `migrations/*.sql`) and `ASSETS` (`public/` only). It binds loopback and refuses a non-loopback `APP_ORIGIN`. Browse at exactly the host in `APP_ORIGIN` (`localhost` and `127.0.0.1` are different origins for cookies and CSRF). `DEV_LOCAL=1` is set by the shim; it relaxes `RATE_LIMIT_SALT` and allows an http origin.

A `data/minesweeper.sqlite` from the earlier standalone build is refused with an explanatory error; move it aside.

## 2. Cloudflare resources (operator steps)

Nothing here has been run from this repository; `database_id` in `wrangler.jsonc` is the placeholder `REPLACE_WITH_D1_ID`.

```sh
npx wrangler d1 create jev-minesweeper          # paste the returned id into wrangler.jsonc
npm run db:remote                               # applies migrations/0001_init.sql
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put RATE_LIMIT_SALT         # 32+ random bytes; required in production
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put ANALYTICS_ADMIN_TOKEN   # optional; blank disables /api/admin/analytics
npm run deploy
```

`routes` attaches the custom domain `minesweeper.jevplay.games`, which requires the `jevplay.games` zone to be on the same Cloudflare account. The Worker refuses `/api/*` requests whose host is not `APP_ORIGIN` (a `*.workers.dev` URL will answer 400 for API calls unless `APP_ORIGIN` is changed to match).

Non-secret settings are `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `APP_ORIGIN` | `https://minesweeper.jevplay.games` | Exact origin: CSRF, cookies (`__Host-`), OAuth redirect, Activity origin |
| `JEV_MODEL`, `JEV_TIMEOUT_MS` | `jev-1.13.0`, `3000` | Pinned model id and provider deadline |
| `JEV_PIPELINE_DEPTH` | `3` | Opponent decisions computed ahead of the one-move-per-second schedule |
| `MAX_ACTIVE_MATCHES` | `8` | Live matches admitted at once |
| `MAX_JEV_CALLS_PER_MATCH` / `_PER_DAY` | `250` / `5000` | Provider ceilings; reserved before each call, then the opponent falls back visibly (unranked) |
| `MAX_MATCHES_PER_DAY`, `MATCHES_PER_HOUR`, `SESSIONS_PER_10_MIN` | `300`, `30`, `60` | Durable (D1) quotas that keep one client from spending the free allowance |
| `API_REQUESTS_PER_MINUTE` | `3000` | Per-isolate best-effort burst limit |
| `RETENTION_DAYS`, `EVENT_RETENTION_DAYS` | `30`, `30` | Audit rows; event journals and queued decisions (result rows stay) |
| `JEV_INPUT_PRICE_PER_MILLION` | blank | Optional cost estimate shown in analytics |

Nothing else is needed: no `nodejs_compat` flag (the Worker imports no `node:` module; `tests/workers-compat.test.js` enforces this), no `limits.cpu_ms` (not allowed on Free), no `triggers`.

`run_worker_first` is `["/api/*", "/", "/index.html"]`: only the API and the HTML document (CSP, Discord Activity framing) invoke the Worker. Every other file is served straight from `public/` and does not count as a Worker request; `public/_headers` sets baseline headers for those.

## 3. TypeSafe

`TYPESAFE_API_KEY` stays a Worker secret. No key gives a fully playable, clearly labeled local opponent (unofficial). The model is asked only to choose among solver-supplied candidates from the opponent's own public observation; it never receives a layout, seed, or the human's history or result. Per-match and per-day call ceilings are durable D1 counters reserved before each call (two attempts) and refunded when unused; they are not a substitute for the provider's own spend controls.

## 4. Discord application

Copy the application ID, client secret and public key into `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`. Register:

```text
OAuth redirect: https://minesweeper.jevplay.games/api/auth/discord/callback
Interactions:   https://minesweeper.jevplay.games/api/discord/interactions
Activity URL mapping: / -> minesweeper.jevplay.games
```

Interaction signatures are verified with Web Crypto Ed25519 over the exact raw bytes and timestamp (falling back to the older `NODE-ED25519` algorithm name if the runtime requires it). Login requests only `identify`. Run `npm run discord:register` locally with `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` in `.env` (optionally `DISCORD_TEST_GUILD_ID`); it upserts only `/jev`. Activity mode (`docs/ACTIVITY.md`) needs nothing extra on the Worker. Live Discord setup has not been exercised; the integration is tested with controlled OAuth responses and signed fixture interactions.

## 5. How it fits the Free plan

The limits assumed (Cloudflare documentation, checked 2026-09-30): 100,000 Worker requests/day, **10 ms CPU per invocation**, 128 MB memory, 50 subrequests and 50 D1 queries per invocation, `waitUntil` up to 30 s, five cron triggers per account (all used, so none are added), D1 500 MB per database and 2 MB per row. D1's daily read/write allowances (5 M rows read, 100 k rows written on Free) are from Cloudflare's pricing page and were not re-fetched.

Design consequences (details in `ARCHITECTURE.md` section F):

- **Polling, no push.** The browser polls its match every 600 ms while running. Each poll also advances the server-side schedule, so a running game costs about 100 requests a minute. 100 k requests/day is therefore roughly 16 hours of play per day in total. Static files do not count.
- **Lazy time.** Opponent moves, 100 ms adjudication, ready expiry and 30 s abandonment are applied at the instant they were due, by whichever request next touches the match; nothing runs in the background. Maintenance (session/audit pruning, settling idle matches, advancing verification of orphaned matches) runs one small job per 20 s from `/api/me`, `/api/health` and `/api/leaderboard`, guarded by a D1 counter.
- **Bounded CPU.** The solver was made about 10x cheaper without changing its output and given hard caps (policy `ms-policy-1.1.0`); verification runs as resumable steps; replays are paged; the leaderboard ranks in SQL; the analytics dashboard is derived in the browser from the verified replay. Measured costs are in `reports/cpu/report.md` (regenerate with `npm run bench:cpu`) and summarised in `ARCHITECTURE.md`.
- **Write budget.** A match costs on the order of 500 D1 row writes (each opponent decision is a queue row, an event row and a state update); the free 100 k/day therefore admits roughly 150-200 matches a day, and `MAX_MATCHES_PER_DAY` (300) is a ceiling, not a promise. Decision-bearing journals are large (about 25 KB per opponent event): a beginner match is a few hundred KB and an expert match a few MB, so `EVENT_RETENTION_DAYS` matters for the 500 MB database cap. Watch D1 usage in the dashboard.

## 6. Backup, restore and retention

Production data lives in D1. Export with `npx wrangler d1 export jev-minesweeper --remote --output backup.sql` and protect the file: it contains private game state and session hashes. Restore into a new database with `wrangler d1 execute ... --file`. `npm run backup` only backs up the **local** development SQLite file. A production restore drill has not been performed.

Sessions, launch tickets, quota counters and audit rows are pruned lazily. After `EVENT_RETENTION_DAYS` a match's journal and any queued decisions are deleted and the match is marked `events_pruned_at`; its result, public summary and leaderboard standing remain, but its replay/export return 410. Nothing deletes user profiles or results automatically. Publish the retention policy you actually run.

## 7. Monitoring

`ANALYTICS_ADMIN_TOKEN` unlocks `GET /api/admin/analytics` (aggregate JSON, including matches pending verification). Watch Workers CPU-limit errors (error 1102) and D1 usage in the Cloudflare dashboard. A match whose opponent computation repeatedly dies is degraded to the cheapest solver budget after two failed attempts (flagged `cpu_guard`, unranked); an `audit_events` row of type `jev_decision_ready` with `degraded: true` shows it happened.

## 8. Pre-launch gates (not run here)

`wrangler d1 create`, migrations, secrets, deploy and DNS; a real signed Discord launch and Activity session; a complete real JEV match on each preset, including an expert match, watching for 1102 errors (the CPU figures are from Node, not workerd); provider-failure behaviour; `wrangler tail` during a full match; D1 write usage after a day of play; browser test (`tests/browser_smoke.py`, needs Python Playwright) against the deployed origin.
