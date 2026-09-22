# Setup, deployment, and recovery

## 1. Local start

Install a compatible Node runtime. The package was exercised on Node22.16.0, including native SQLite. Node24 LTS is the recommended target for a new deployment based on the official release schedule consulted September22,2026; the Docker/systemd templates have not themselves been deployed here. See SOURCES.md. No `npm install` or bundler is necessary.

Run `npm start` from the project directory and use `http://localhost:3000`. On macOS/Linux copy `.env.example` with `cp`; on PowerShell use `Copy-Item`. Hostname consistency matters: cookies and Origin checks distinguish localhost from127.0.0.1. Set APP_ORIGIN to the exact origin you actually open, without a path.

## 2. TypeSafe

Place an authorized API key in TYPESAFE_API_KEY. Keep it on the server. The pinned JEV_MODEL is initially `jev-1.13.0`; pinning records the actual competition configuration but does not guarantee the provider will retain a model indefinitely. No key produces a fully playable, clearly labeled local opponent. A key is required for actual TypeSafe calls.

JEV_TIMEOUT_MS defaults3000; MAX_JEV_CALLS_PER_MATCH250; MAX_ACTIVE_MATCHES8. Ranked cadence remains one second; a miss beyond100ms tolerance marks the game unofficial. These defaults require live latency and load validation. A per-match counter is not a global provider spend limit. Use the provider account's own controls as appropriate and monitor measured usage. Keep JEV_INPUT_PRICE_PER_MILLION blank unless a reviewed input-token price is intentionally configured; the UI is an estimate, not a bill.

## 3. Discord application

Create/configure the operator's Discord application. Copy its application ID, client secret, and public verification key to DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_PUBLIC_KEY. Do not confuse the public key with a bot token.

For an origin `https://games.example.com`, register:

```text
OAuth redirect: https://games.example.com/api/auth/discord/callback
Interactions:  https://games.example.com/api/discord/interactions
```

The application must be reachable by Discord over public HTTPS for interaction verification. Login requests only `identify`. Enable guild installation with `applications.commands`; no bot message permissions or Gateway are needed by this implementation. Keep ordinary guild text channels as the supported context; DMs and threads deliberately return explanatory messages.

Set DISCORD_TEST_GUILD_ID during staging to register only in a test guild, or leave blank for global registration. Run:

```sh
npm run discord:register
```

The operator-run script exchanges client credentials with scope `applications.commands.update`, then POST-upserts only `/jev`. It does not bulk-delete the application's other commands. A preexisting `/jev` in the same scope is updated, so review application ownership before running. Neither the temporary credential token nor a bot token is stored by the game.

Install the application into the authorized guild. Run `/jev play`, open the private link within ten minutes, sign in as the invoking user, and create the game. The capability is consumed by authenticated POST, not preview GET. Context lasts thirty minutes. Test a copied link under another account: it must fail. Test a new launch after expiry. Test Channel/Server access while World remains publicly readable.

Live Discord setup was not completed for this delivery; the integration was tested with controlled OAuth responses and cryptographically signed fixture interactions.

## 4. Single-host production

Use a dedicated non-root service account. Copy the project to `/opt/jev-arcade`; create a writable private `/var/lib/jev-arcade` owned by that account. Keep code read-only to the service where feasible. Put environment values in `/etc/jev-arcade.env`, readable only by the service/admin, for example:

```text
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://games.example.com
NODE_ENV=production
DATABASE_PATH=/var/lib/jev-arcade/minesweeper.sqlite
TRUST_PROXY=1
```

Add the actual provider/application secrets privately. Install/adapt `deploy/jev-arcade.service`; confirm the real Node binary path and service user exist. Install/adapt `deploy/Caddyfile` with the same domain; point DNS to the host and allow the required HTTPS certificate/network paths. Caddy terminates HTTPS and proxies same-origin API and static assets to Node. Do not publicly expose the native3000 port. Do not log OAuth callback query strings or raw bodies.

The systemd template assumes Linux, paths and a `jev` account prepared by the operator. It is a template, not an executed provisioning script. Validate permissions, restart behavior, certificate renewal, and reverse-proxy streaming on the destination host.

## 5. Optional container

Dockerfile uses Node24-slim with a non-root runtime and no package installation. Before production, review/pin the image digest and run the tests against the chosen image. This environment did not pull/build the image.

```sh
docker build -t minesweeper-jev .
docker volume create minesweeper-jev-data
docker run --name minesweeper-jev --restart unless-stopped \
  --env-file .env \
  -e HOST=0.0.0.0 -e DATABASE_PATH=/app/data/minesweeper.sqlite \
  -p 127.0.0.1:3000:3000 \
  -v minesweeper-jev-data:/app/data \
  minesweeper-jev
```

Keep APP_ORIGIN/NODE_ENV consistent with the external HTTPS proxy. Do not mount `.env` or backups under public/. A host bind mount requires appropriate UID/write permissions; a named volume avoids many first-run ownership mistakes. Container networking differs from a loopback native proxy: leave TRUST_PROXY=0 unless the peer/trusted-proxy logic has been validated for the specific container topology. Incorrect forwarded-IP trust must not be enabled just to silence a rate limit.

## 6. Backup and restore

Run from the project directory with DATABASE_PATH pointing at the live database:

```sh
npm run backup -- /restricted/backups/minesweeper-2026-09-22.sqlite
```

The script uses SQLite VACUUM INTO for a consistent snapshot, refuses overwrite, restricts output permissions, and checks `PRAGMA integrity_check`. It supports the tested Node22 runtime without relying on a newer native backup helper. The local backup/integrity operation passed. Store backups away from public files and protect them as private game/session data.

To restore, stop the service, retain a separate safety copy of the existing database and WAL/SHM sidecars, then replace the database with the integrity-checked snapshot. Do not combine an unrelated old WAL with a restored database. Restore ownership/permissions, start the service, and inspect health/standings/private replay. Active matches in a recovered database are voided rather than resumed with invented timing. Revoke sessions if the recovery event warrants it. An actual production disaster-recovery drill was not performed here.

## 7. Monitoring and retention

Optional ANALYTICS_ADMIN_TOKEN unlocks a read-only JSON aggregate endpoint. Use a long random secret, never a client-side setting. Measure queue pressure, scheduling misses, error/fallback rates, HTTP rejections, disk size, worker failures and backups. The default audit retention is thirty days; match/replay/profile retention is not automatically thirty days. Decide and publish operator policies before public access.

Live drafts of decisions that never apply are not an exhaustive billing ledger. TypeSafe invoice reconciliation is outside this package. Retention can remove older audit evidence; first-generated analytics caches reflect available audit coverage at that time.

## 8. Pre-launch gates

Run all automated tests on the target runtime. Through a normally navigating desktop/mobile browser, exercise login, signed launch, one complete real JEV race, unavailable-provider behavior, reconnect, unknown-owner denial, full private export/replay, and scoped standings. Measure real one-second scheduling viability at the intended concurrency, SQLite/worker load and long expert-board report latency. Confirm public HTTPS and secure cookies. Review security/retention and decide licensing. The included tests and templates do not substitute for these live checks.
