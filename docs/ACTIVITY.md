# Discord Activity mode

The game can run as a Discord Activity (Embedded App SDK). Normal browser play, the `/jev play` launch link and the OAuth login are unchanged; Activity mode is used only when Discord opens the page with a `frame_id` query parameter.

## Why it needs its own path

Inside Discord the game runs in an iframe on `https://<DISCORD_CLIENT_ID>.discordsays.com`, which Discord proxies to `https://minesweeper.jevplay.games`. There the browser does not send the game's `SameSite=Lax` cookie, requests carry the discordsays `Origin`, and the page would otherwise be sent with `frame-ancestors 'none'`.

## What changes in Activity mode

1. **Sign-in.** `public/activity.js` loads the vendored SDK (`/vendor/discord-embedded-app-sdk.js`, `@discord/embedded-app-sdk` 2.5.0), calls `sdk.commands.authorize` (scope `identify`) and posts the code to `POST /api/activity/session`. The server exchanges it **without a `redirect_uri`** using the existing `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`, upserts the user exactly as the OAuth callback does, creates a normal session (hashed at rest, 24 h absolute) and returns `{token, csrfToken, accessToken, user}`. The Discord access token is passed back once for `sdk.commands.authenticate` and is never stored. No cookie is set.
2. **Bearer sessions.** `Authorization: Bearer <token>` is accepted in place of the cookie (`server/security.js`). The client keeps the token in memory only. The match event stream uses `fetch` instead of `EventSource` in this mode, because `EventSource` cannot send headers.
3. **Origin.** `Origin == https://<DISCORD_CLIENT_ID>.discordsays.com` is accepted for mutations **only when the request is bearer-authenticated**. Cookie sessions, other origins, another application's discordsays origin and missing CSRF tokens are still rejected (`csrf_rejected`). `POST /api/activity/session` accepts only that origin or the game's own `APP_ORIGIN`. The server has no Host check; Origin plus the CSRF token remain the gate.
4. **Framing.** Only the HTML document requested with `frame_id` gets `frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com` in place of `frame-ancestors 'none'`; the rest of the CSP is unchanged. API responses, scripts and every other path stay unframeable.

Ranked/leaderboard rules, idempotency, CAS revisions, leases and the JEV adapter are untouched. Session-creation attempts are rate limited by a durable D1 quota (60 per 10 minutes per client address; behind the tunnel with `TRUST_PROXY=0` that address is shared).

## Developer Portal settings

- **Activities**: enable Activities for the application.
- **URL Mappings**: prefix `/` -> target `minesweeper.jevplay.games`.
- OAuth2 needs no new redirect for Activity mode; the code is exchanged without one. Keep the existing redirect for browser login.
- No new environment variables. `DISCORD_CLIENT_ID` must be the numeric application id.

## Slash commands and the Entry Point command

Enabling Activities makes Discord create a primary **Entry Point** command for the application. `npm run discord:register` upserts only `/jev` (a single `POST`, not a bulk overwrite), so the Entry Point command is preserved. If registration is ever changed to a bulk overwrite (`PUT`), include the existing Entry Point command in the payload or Discord will reject or remove it.
