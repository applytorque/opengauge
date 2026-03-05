import Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content         TEXT NOT NULL,
      tokens_raw      INTEGER,
      tokens_sent     INTEGER,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at);

    -- Token usage analytics
    CREATE TABLE IF NOT EXISTS token_usage (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider        TEXT NOT NULL,
      model           TEXT NOT NULL,
      tokens_in       INTEGER NOT NULL,
      tokens_out      INTEGER NOT NULL,
      tokens_saved    INTEGER DEFAULT 0,
      cost_estimate   REAL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
      ON token_usage(conversation_id);

    -- Conversation checkpoints
    CREATE TABLE IF NOT EXISTS checkpoints (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      summary         TEXT NOT NULL,
      covers_until    INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation
      ON checkpoints(conversation_id);
  `);

  // Try creating the embeddings virtual table (requires sqlite-vec)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
        message_id TEXT PRIMARY KEY,
        vector     FLOAT[384]
      );
    `);
  } catch {
    // sqlite-vec not available — skip
  }
}
