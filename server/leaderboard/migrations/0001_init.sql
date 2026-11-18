-- Spechy leaderboard schema. Only data a player chose to share. Never dictated text.

CREATE TABLE players (
  id               TEXT PRIMARY KEY,               -- random public id, e.g. p_3f9a...
  token_hash       TEXT NOT NULL UNIQUE,           -- SHA-256 of the bearer token, the token itself is never stored
  name             TEXT NOT NULL,
  title_id         TEXT,                           -- equipped title, id from the app catalog
  tier             INTEGER NOT NULL DEFAULT 0,     -- 0 bronze .. 6 champion
  division         INTEGER NOT NULL DEFAULT 0,     -- 0..2 (I..III)
  rp               INTEGER NOT NULL DEFAULT 0,     -- 0..100
  best_tower       INTEGER NOT NULL DEFAULT 0,     -- all-time bests the player shared
  best_snake       INTEGER NOT NULL DEFAULT 0,
  best_comet       INTEGER NOT NULL DEFAULT 0,
  avatar_key       TEXT,                           -- R2 object key, NULL = no picture
  avatar_type      TEXT,
  avatar_version   INTEGER NOT NULL DEFAULT 0,
  avatar_hidden    INTEGER NOT NULL DEFAULT 0,     -- moderation: picture hidden and new uploads locked
  hidden           INTEGER NOT NULL DEFAULT 0,     -- moderation: player not shown to anyone else
  created_at       INTEGER NOT NULL,               -- unix ms
  updated_at       INTEGER NOT NULL,
  last_seen_day    TEXT NOT NULL                   -- YYYY-MM-DD, for deleting abandoned accounts
);
CREATE INDEX players_last_seen ON players(last_seen_day);

-- One row per player and ISO week (e.g. 2026-W47). History stays; the current week is just a new key.
-- *_at = unix ms when the value was last raised, used as tie-breaker (earlier wins).
CREATE TABLE weekly_scores (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  week       TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0, points_at INTEGER NOT NULL DEFAULT 0,
  words      INTEGER NOT NULL DEFAULT 0, words_at  INTEGER NOT NULL DEFAULT 0,
  tower      INTEGER NOT NULL DEFAULT 0, tower_at  INTEGER NOT NULL DEFAULT 0,
  snake      INTEGER NOT NULL DEFAULT 0, snake_at  INTEGER NOT NULL DEFAULT 0,
  comet      INTEGER NOT NULL DEFAULT 0, comet_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, week)
);
CREATE INDEX weekly_points ON weekly_scores(week, points DESC, points_at);
CREATE INDEX weekly_words  ON weekly_scores(week, words DESC, words_at);
CREATE INDEX weekly_tower  ON weekly_scores(week, tower DESC, tower_at);
CREATE INDEX weekly_snake  ON weekly_scores(week, snake DESC, snake_at);
CREATE INDEX weekly_comet  ON weekly_scores(week, comet DESC, comet_at);

-- Accepted amounts per UTC day, for the per-day sanity caps.
CREATE TABLE daily_usage (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  points    INTEGER NOT NULL DEFAULT 0,
  words     INTEGER NOT NULL DEFAULT 0,
  games     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);

-- Idempotency keys of POST /v1/scores, so a retried sync never counts twice.
CREATE TABLE score_batches (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  batch_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, batch_id)
);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('name', 'avatar', 'player')),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (reporter_id, target_id, kind)
);
CREATE INDEX reports_status ON reports(status, created_at);
CREATE INDEX reports_target ON reports(target_id, kind, status);

-- Fixed-window counters. Keys are "tok:<player id>:<bucket>" or "ip:<salted hash>:<bucket>", never raw IPs.
CREATE TABLE rate_limits (
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,  -- window start, unix seconds
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
