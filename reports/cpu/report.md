# CPU cost of the hot request paths (Workers Free budget: 10 ms per invocation)

Generated 2026-09-30T13:33:37.318Z on Node v24.18.0 (win32 x64). High-resolution elapsed time (single thread, no I/O waits) around a full Worker invocation (request + waitUntil work) against real SQLite via the D1-compatible wrapper, Node V8 (not workerd).

- Not workerd: absolute numbers differ on Cloudflare hardware; treat the 10 ms budget comparison as indicative with about 1.5x margin needed.
- Local SQLite time is counted here; on Cloudflare D1 time is I/O and not CPU, so DB-heavy numbers are conservative.
- A cold isolate runs unoptimised code; the cold rows fresh-process each sample.
- Workers clocks do not advance during CPU, so the production code uses static budgets, not timers.

Engine ms-race-1.0.0, policy ms-policy-1.1.0, verification step budget 20 units.

## Match play, by board and opponent level (warm)

### beginner / jev (10 matches, 338 events, 10/10 verified, replay 54016 bytes)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start (POST actions) | 10 | 0.97 | 2.98 | 4.42 | 0 |
| poll that applies due opponent move(s) | 225 | 0.89 | 2.46 | 5.52 | 0 |
| poll that computes the next opponent decision | 132 | 1 | 1.46 | 4.47 | 0 |
| poll with nothing to do | 8 | 0.32 | 0.46 | 0.49 | 0 |
| human command (with schedule catch-up) | 93 | 0.57 | 0.97 | 1.76 | 0 |
| verification step (20 units) | 47 | 2.87 | 4.29 | 5.05 | 0 |
| replay export | 1 | 1.04 | 1.04 | 1.04 | 0 |
| compute one decision in isolation (solver + request + D1) | 5 | 0.75 | 1.06 | 1.07 | 0 |

Verification steps per match: p50 4, max 9.

### intermediate / jev (10 matches, 1181 events, 10/10 verified, replay 163036 bytes)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start (POST actions) | 10 | 2.22 | 2.76 | 2.93 | 0 |
| poll that applies due opponent move(s) | 827 | 1.34 | 3.6 | 6.86 | 0 |
| poll that computes the next opponent decision | 501 | 1.85 | 3.03 | 5.65 | 0 |
| poll with nothing to do | 2 | 0.53 | 0.61 | 0.62 | 0 |
| human command (with schedule catch-up) | 334 | 0.75 | 1.11 | 4.58 | 0 |
| verification step (20 units) | 312 | 4.13 | 6.54 | 9.53 | 0 |
| replay export | 1 | 1.79 | 1.79 | 1.79 | 0 |
| compute one decision in isolation (solver + request + D1) | 5 | 1.67 | 2.18 | 2.24 | 0 |

Verification steps per match: p50 34, max 38.

### expert / normal (10 matches, 1188 events, 10/10 verified, replay 157798 bytes)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start (POST actions) | 10 | 3.08 | 3.79 | 3.9 | 0 |
| poll that applies due opponent move(s) | 830 | 1.35 | 4.8 | 8.58 | 0 |
| poll that computes the next opponent decision | 508 | 3.14 | 4.31 | 7.12 | 0 |
| poll with nothing to do | 0 | null | null | null | 0 |
| human command (with schedule catch-up) | 338 | 0.88 | 1.17 | 2.82 | 0 |
| verification step (20 units) | 616 | 3.02 | 6.41 | 7.76 | 0 |
| replay export | 1 | 1.44 | 1.44 | 1.44 | 0 |
| compute one decision in isolation (solver + request + D1) | 5 | 1.55 | 2.26 | 2.27 | 0 |

Verification steps per match: p50 65, max 82.

### expert / hard (10 matches, 1082 events, 10/10 verified, replay 222674 bytes)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start (POST actions) | 10 | 3.31 | 3.81 | 3.86 | 0 |
| poll that applies due opponent move(s) | 754 | 1.51 | 5.54 | 13.27 | 1 |
| poll that computes the next opponent decision | 462 | 3.68 | 5.25 | 7.91 | 0 |
| poll with nothing to do | 0 | null | null | null | 0 |
| human command (with schedule catch-up) | 308 | 0.91 | 1.17 | 1.74 | 0 |
| verification step (20 units) | 600 | 3.83 | 7.57 | 9.55 | 0 |
| replay export | 1 | 2.8 | 2.8 | 2.8 | 0 |
| compute one decision in isolation (solver + request + D1) | 5 | 1.62 | 2.18 | 2.23 | 0 |

Verification steps per match: p50 69.5, max 85.

### expert / jev (10 matches, 1077 events, 10/10 verified, replay 127086 bytes)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start (POST actions) | 10 | 3.25 | 4.06 | 4.49 | 0 |
| poll that applies due opponent move(s) | 750 | 1.54 | 5.93 | 12.04 | 1 |
| poll that computes the next opponent decision | 459 | 3.65 | 5.36 | 9.08 | 0 |
| poll with nothing to do | 2 | 0.45 | 0.53 | 0.54 | 0 |
| human command (with schedule catch-up) | 307 | 0.87 | 1.12 | 1.67 | 0 |
| verification step (20 units) | 643 | 3.74 | 7.28 | 9.68 | 0 |
| replay export | 1 | 1.82 | 1.82 | 1.82 | 0 |
| compute one decision in isolation (solver + request + D1) | 5 | 2.06 | 2.66 | 2.79 | 0 |

Verification steps per match: p50 71.5, max 94.

## Other paths (warm)

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| session create (GET /api/me, new guest) | 30 | 0.27 | 0.37 | 0.69 | 0 |
| match create (POST /api/matches) beginner | 20 | 0.99 | 1.36 | 1.81 | 0 |
| match create (POST /api/matches) expert | 20 | 0.95 | 1.18 | 1.18 | 0 |
| start (POST actions: two board generations) beginner | 20 | 1.04 | 1.21 | 1.32 | 0 |
| start (POST actions: two board generations) expert | 20 | 0.19 | 3.02 | 3.39 | 0 |
| Discord slash-command interaction (Ed25519 verify + ticket insert) | 30 | 0.45 | 1.07 | 1.93 | 0 |
| leaderboard (200 verified rows, 200 players) | 8 | 1.34 | 2.51 | 3.07 | 0 |
| leaderboard (2200 verified rows, 200 players) | 8 | 7.07 | 14.37 | 18.08 | 1 |
| maintenance job (one of three, rotating) | 6 | 0.01 | 0.06 | 0.07 | 0 |

## First invocation in a fresh process (cold JIT), expert / jev

| Operation | n | p50 ms | p95 ms | max ms | over 10 ms |
|---|---:|---:|---:|---:|---:|
| start | 6 | 6.28 | 6.87 | 6.96 | 0 |
| pollApply | 6 | 5.28 | 5.63 | 5.65 | 0 |
| pollPrepare | 6 | 8.68 | 9.12 | 9.2 | 0 |
| verifyStep | 6 | 5.75 | 6.49 | 6.65 | 0 |
