-- D1 schema for jev-minesweeper. Applied with `npm run db:remote` (or `db:local`); the local Node shim applies the same file to SQLite.
-- D1 manages PRAGMAs itself (foreign keys are always enforced), so none appear here.
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar_hash TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(discord_id), csrf_token TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS launch_tickets (
  token_hash TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE, discord_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, consumed_by TEXT
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, creation_request_id TEXT NOT NULL, creation_body_hash TEXT NOT NULL,
  user_id TEXT REFERENCES users(discord_id), game_id TEXT NOT NULL DEFAULT 'minesweeper', competition_key TEXT NOT NULL,
  board_preset TEXT NOT NULL, ai_difficulty TEXT NOT NULL, guild_id TEXT, channel_id TEXT,
  config_json TEXT NOT NULL, private_state_json TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('ready','running','complete')),
  ranked_requested INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
  eligibility_reasons_json TEXT NOT NULL DEFAULT '[]', verification TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT, outcome_reason TEXT, human_clear_ms INTEGER, result_json TEXT,
  sealed_head_hash TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  -- Compare-and-swap revision: every state change is `UPDATE ... WHERE id=? AND version=?`, so two Worker invocations cannot both win.
  version INTEGER NOT NULL DEFAULT 0, write_tag TEXT,
  -- Journal head, so appending an event never has to read the journal back.
  event_count INTEGER NOT NULL DEFAULT 0, head_hash TEXT,
  -- Owner contact (drives the 30 s abandonment rule, evaluated lazily on the next request) and the opponent's schedule/budget.
  last_seen_at INTEGER, jev_next_due_ms INTEGER NOT NULL DEFAULT 1000, provider_calls INTEGER NOT NULL DEFAULT 0,
  last_decision_json TEXT,
  -- Durable leases: at most one invocation prepares an opponent decision, and one verifies, at a time. They expire, so a killed
  -- invocation cannot wedge a match; prep_attempts counts consecutive failed attempts for one target revision.
  prep_lease_until INTEGER, prep_token TEXT, prep_rev INTEGER, prep_attempts INTEGER NOT NULL DEFAULT 0,
  verify_lease_until INTEGER, verify_token TEXT, verify_cursor_json TEXT,
  -- Set when retention removed the journal (the result row and public summary remain).
  events_pruned_at INTEGER,
  UNIQUE(owner_key, creation_request_id), CHECK(channel_id IS NULL OR guild_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, seq INTEGER NOT NULL, request_id TEXT,
  request_body_hash TEXT, event_json TEXT NOT NULL, PRIMARY KEY(match_id, seq), UNIQUE(match_id, request_id)
);
-- Opponent decisions computed ahead of the schedule (one per future board revision). Applied in order by the scheduler.
CREATE TABLE IF NOT EXISTS jev_decisions (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, revision INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL,
  action_json TEXT NOT NULL, decision_json TEXT NOT NULL, PRIMARY KEY(match_id, revision)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY, match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
  owner_key TEXT, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}'
);
-- Fixed-window quotas and maintenance ticks. Buckets are salted hashes, never raw addresses.
CREATE TABLE IF NOT EXISTS counters (
  bucket TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
  PRIMARY KEY(bucket, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_match ON matches(owner_key) WHERE phase IN ('ready','running');
CREATE INDEX IF NOT EXISTS leaderboard_world ON matches(competition_key, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_server ON matches(competition_key, guild_id, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_channel ON matches(competition_key, guild_id, channel_id, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS player_history ON matches(owner_key, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_verification ON matches(finished_at) WHERE verification='pending' AND phase='complete';
CREATE INDEX IF NOT EXISTS active_matches ON matches(last_seen_at) WHERE phase IN ('ready','running');
CREATE INDEX IF NOT EXISTS audits_match ON audit_events(match_id, at);
CREATE INDEX IF NOT EXISTS audits_retention ON audit_events(at);
CREATE INDEX IF NOT EXISTS counters_expiry ON counters(expires_at);
