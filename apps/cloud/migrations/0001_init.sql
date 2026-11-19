-- Teachers who have signed in with Google (only needed to publish).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bearer / cookie sessions. Only a SHA-256 hash of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Published Labs and web animations. The HTML lives in R2 at items/<id>/<version>.html
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lab', 'web')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  version INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX items_owner ON items(owner_id, updated_at DESC);
CREATE INDEX items_public ON items(visibility, updated_at DESC);
