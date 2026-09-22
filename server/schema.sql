PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
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
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, creation_request_id TEXT NOT NULL, creation_body_hash TEXT NOT NULL,
  user_id TEXT REFERENCES users(discord_id), game_id TEXT NOT NULL DEFAULT 'minesweeper', competition_key TEXT NOT NULL,
  board_preset TEXT NOT NULL, ai_difficulty TEXT NOT NULL, guild_id TEXT, channel_id TEXT,
  config_json TEXT NOT NULL, private_state_json TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('ready','running','complete')),
  ranked_requested INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL DEFAULT 0,
  eligibility_reasons_json TEXT NOT NULL DEFAULT '[]', verification TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT, outcome_reason TEXT, human_clear_ms INTEGER, result_json TEXT, analytics_json TEXT,
  sealed_head_hash TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  UNIQUE(owner_key, creation_request_id), CHECK(channel_id IS NULL OR guild_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, seq INTEGER NOT NULL, request_id TEXT,
  request_body_hash TEXT, event_json TEXT NOT NULL, PRIMARY KEY(match_id, seq), UNIQUE(match_id, request_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY, match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
  owner_key TEXT, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_match ON matches(owner_key) WHERE phase IN ('ready','running');
CREATE INDEX IF NOT EXISTS leaderboard_world ON matches(competition_key, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_server ON matches(competition_key, guild_id, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS leaderboard_channel ON matches(competition_key, guild_id, channel_id, finished_at, user_id) WHERE eligible=1 AND verification='verified';
CREATE INDEX IF NOT EXISTS player_history ON matches(owner_key, created_at DESC);
CREATE INDEX IF NOT EXISTS audits_match ON audit_events(match_id, at);
CREATE INDEX IF NOT EXISTS audits_retention ON audit_events(at);
PRAGMA user_version = 1;
