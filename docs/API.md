# HTTP API

All browser routes are same-origin. JSON mutation bodies require `Content-Type: application/json`, the current HttpOnly session cookie, `Origin: APP_ORIGIN`, and `X-CSRF-Token` from `/api/me`. Never copy a session or CSRF token into a URL. UUID request IDs provide idempotency, not authentication.

## Session and community

| Method/path | Contract |
|---|---|
| GET `/api/health` | Non-secret liveness information |
| GET `/api/me` | Establish guest session if absent; returns profile, CSRF token, presets/features, active match and context |
| GET `/api/auth/discord` | Stores session-bound OAuth state and redirects to Discord |
| GET `/api/auth/discord/callback` | Validates code/state, exchanges server-side, rotates session, redirects home |
| POST `/api/logout` | Requires CSRF; invalidates session |
| POST `/api/discord/interactions` | Raw JSON body; Discord Ed25519 signature and timestamp headers, not browser session/CSRF |

Login identity and launch context are different. No route accepts browser assertions of Discord identity, guild membership, or channel association. `/jev play` returns a fragment-based opaque ticket, redeemed by the correct authenticated user's match-creation POST.

## Create a match

`POST /api/matches` accepts only:

```json
{
  "requestId": "a-generated-uuid",
  "boardPreset": "beginner",
  "aiDifficulty": "normal",
  "mode": "practice",
  "context": "world"
}
```

Presets: beginner/intermediate/expert. Difficulty: easy/normal/hard/jev. Mode: practice/ranked. Context: world/current. A new Discord launch can include `launchTicket`. The server resolves and consumes it transactionally. `current` uses an existing valid grant. The response is a covered public match snapshot with commitments, config, identity-derived eligibility, and ID. One active match per owner. First create is 201; identical retries return the original match without consuming another ticket. A changed body for the same request ID conflicts.

## Commands

`POST /api/matches/:id/actions`:

```json
{"requestId":"a-generated-uuid","action":{"type":"start","cell":40}}
```

```json
{
  "requestId":"another-generated-uuid",
  "expectedBoardRevision":1,
  "action":{"type":"reveal","cell":12}
}
```

Other board actions: `{"type":"setFlag","cell":12,"value":true}`, the same with false, and `{"type":"chord","cell":40}`. `{"type":"resign"}` is a lifecycle command. Board revisions apply to the **human board only**. The server determines actor and time. A valid mine reveal is accepted, then explodes; it is not filtered using private truth.

Accepted response contains `acceptedSeq`, `idempotent`, and `snapshot`. Identical retries return the original acceptance sequence with the current snapshot. Changed duplicate bodies conflict. Unknown fields, forged actor/score, invalid cells, stale revisions and actions after terminal are rejected.

## Snapshots and events

`GET /api/matches/:id` returns the owner's public current snapshot. `GET /api/matches/:id/events` returns `text/event-stream` events carrying snapshots plus heartbeat comments. The client reconnects and receives current state; this is snapshot synchronization, not guaranteed transport replay of every intermediate event. The private accepted-event journal remains complete for sealed replay. At most four streams per owned match. Cookie expiry ends authorized streaming. Another owner receives 404, not the match's existence/details.

## Analysis and exports

| GET path | Response / restrictions |
|---|---|
| `/api/matches/:id/analytics` | Complete cached analytics; sealed and verified; owner-only |
| `/api/matches/:id/replay` | Versioned replay with released seeds; sealed; owner-only |
| `/api/matches/:id/export?format=json` | Download analytics JSON |
| Same, `format=csv` | Accepted-action CSV |
| Same, `format=timeline` | Timeline CSV |
| Same, `format=jsonl` | Accepted event journal JSONL; sealed |
| `/api/analytics/profile` | Own history, aggregates, filter metadata and pagination |
| `/api/exports/history.csv` | Own retained non-secret match rows |
| `/api/exports/me.json` | Own profile/summary/matches, never tokens or active layouts |

Profile query values: `preset`, `difficulty`, `period=all|week`, `mode=all|ranked|practice`, and returned numeric cursor. Audit analytics is a cached snapshot; see ANALYTICS.md for coverage/retention. CSV uses formula-safe string escaping.

## Standings

`GET /api/leaderboard?scope=world&preset=beginner&difficulty=normal&period=all`

Scope world is public. Server/channel need a valid context grant and ignore browser-supplied alternative scope IDs. Results expose aggregate standings, qualification threshold, exact competition key, UTC week convention, total players, and `nextCursor`. Request subsequent pages only when a cursor is returned. Page size fifty. The current configuration's model/policy key is not silently combined with historical versions.

## Read-only operational endpoint

`GET /api/admin/analytics` requires `Authorization: Bearer ANALYTICS_ADMIN_TOKEN`. It is disabled when the token is blank. Output is aggregated JSON (result populations, queue, recent audits/rejections, applied decisions, successful applied usage), with no active layouts or user secrets. Do not expose this token in browser code, screenshots or query strings.

## Errors and limits

Errors are JSON with `error.code` and a safe message. Common statuses: 400 malformed request; 401 missing identity/signature; 403 CSRF/context/admin denial; 404 unowned/unknown resource; 409 stale or conflicting operation/active export; 413 oversized body; 422 invalid options/action; 429 rate/admission limit; 503 service/configuration unavailable. Only approved static paths are served.

Native HTTP tests exercise success and rejection paths. Discord/TypeSafe contracts were tested with controlled responses and signature fixtures; validate against live credentials before deployment. There is deliberately no endpoint to accept an authoritative client winning score, a mine bitmap, an arbitrary JEV inference request, or another player's actor ID.
