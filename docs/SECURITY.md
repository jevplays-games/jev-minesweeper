# Security and privacy boundaries

## Protection provided

The server generates independently committed seeds with cryptographic randomness and retains active mine layouts. Public observation functions suppress unrevealed adjacency and hidden truth. Opponent solving is fed the public projection, not private state. The browser cannot submit a final score or choose the opponent's actions. Accepted moves pass phase/ownership/revision/rule validation and an idempotency check, then are written with state in a transaction. Sealed replay re-derives layouts, decisions, actions and outcomes before eligibility writes.

Sessions use random opaque tokens stored as hashes; production cookies are Secure, HttpOnly, host-only, SameSite=Lax. OAuth state is session-bound, short-lived and one-use. Login rotates the session. Mutations require Origin and synchronizer CSRF checks. Disconnect, ready expiry, match deadline, action limits, response/body limits, solver budgets, worker queue bounds, per-owner admission and rate limiting constrain abuse.

Discord interactions use exact-byte Ed25519 verification and freshness checks. Launch capabilities are short-lived, one-use, tied to the invoking account, and not consumed by GET/link preview. Guild/channel context comes from those verified events, not editable parameters. Only ordinary guild text channels are supported.

Static files are allowlisted; repository root, SQL, secrets and databases are not served. UI text is inserted without evaluating display names as HTML. CSP restricts scripts/styles/connections, framing and objects. CSV strings receive formula neutralization. No IP addresses or client fingerprint are persisted in analytics. Provider state omits user identity. No third-party browser analytics trackers are included.

## What this does not prove

A skilled automated client can use the same visible deductions as a human. The game does not certify unaided human play. Hash chains are tamper-evident within an anchored record; an operator who controls the entire host/database can rewrite unanchored history. The server does not accept uploaded replays as ranked results, so local replay reconstruction is not an authorization path.

Same board size does not imply identical logical difficulty. Solver labels depend on bounded search. Remote model behavior, latencies and platform authorization were not live-tested here. There has been no external penetration test, load certification, formal verification, tournament anti-cheat review, or accessibility certification. A context grant proves a recent launch, not continuously synchronized membership.

## Production configuration

Use HTTPS with an exact APP_ORIGIN; keep the native application bound to loopback behind a trusted ingress. Production mode refuses an HTTP origin. Set TRUST_PROXY=1 only for the documented trusted loopback proxy; never trust a public arbitrary X-Forwarded-For sender. Rate limits are in-memory and single-process. Use restrictive secret/database/backup permissions, a dedicated service user, OS patching, and a provider spending limit appropriate to the account. Per-match call limits are not an account-wide billing cap.

The native SQLite module was tested on Node22.16, where it emits an experimental warning. Review the target runtime and exercise its database behavior before launch. Do not weaken cookies/CSRF or expose the private state to make a failing integration test pass.

## Data and retention

Identity storage is Discord ID, display name, validated avatar reference and timestamps. OAuth bearer/refresh tokens are not retained. Session data includes necessary state/context capabilities. Private game records include seeds, actions, results and analytics. The optional operational endpoint avoids names and active layouts, but private exports still contain sensitive game/context identifiers.

Expired sessions/tickets are pruned. RETENTION_DAYS controls audit rows only (default30 days). Sealed matches/replays and user profiles are retained until explicit operator deletion; this is not a complete automated account-deletion implementation. Backups have their own retention and must be managed separately. Before public deployment, publish the retention/support policy that the operator actually implements. User-specific deletion requires a careful transaction and backup policy; no unauthenticated deletion endpoint is supplied.

Cached reports freeze observed operational aggregates at first generation, while gameplay evidence remains reconstructable. Token usage is limited to recorded applied decisions; canceled, unapplied or in-flight calls may incur costs without appearing in those aggregates. Do not present the dashboard as provider invoice reconciliation.

## Incident response

Stop ranked admission, preserve relevant restricted evidence, and rotate any exposed TypeSafe/Discord/admin secrets. Revoke affected sessions/context tickets in the database. Investigate the exact competition configuration and avoid silently changing historical result semantics. Restore only an integrity-checked backup with the service stopped; interrupted live games are voided on startup. Validate with normal HTTP/browser flows before reopening admission.
