-- 002: p5-security (Phase 5 spec §3.4). Runs inside one transaction (api/src/migrate.ts).

-- S-p5-1 / AC-SEC-01: passwords are stored as scrypt hashes (api/src/passwords.ts). The hash goes in
-- its own column, so a value can never be mistaken for the other kind. `users.password` (plain text,
-- from 001) is no longer written. Rows written before this migration still hold plain text there:
-- SQL cannot compute scrypt, so the API hashes them when it starts (PgStore.hashPlainPasswords) and
-- empties the old column. The CHECK below cannot be added until that has run everywhere; see
-- spec/worklogs/p5-security.md.
ALTER TABLE users ADD COLUMN password_hash text;

-- DEV-p5-store-03: sessions expire after an idle lifetime (api/src/pgSessions.ts). Every request that
-- uses a session moves last_seen_at; the API deletes rows idle for longer than the lifetime.
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX sessions_last_seen_at ON sessions (last_seen_at);

-- S-p5-3 / AC-SEC-04: failed sign-ins per key ('account:<e-mail>' or 'ip:<address>') in a fixed window
-- (web/stub/throttle.ts explains the rule). In the database, not in memory, so that several API
-- containers share one count and a restart does not reset it.
CREATE TABLE login_throttle (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  failures     integer NOT NULL CHECK (failures > 0)
);
CREATE INDEX login_throttle_window_start ON login_throttle (window_start);
