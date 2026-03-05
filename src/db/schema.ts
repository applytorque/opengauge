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

    -- Uploaded files metadata
    CREATE TABLE IF NOT EXISTS files (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      filename        TEXT NOT NULL,
      mimetype        TEXT,
      size_bytes      INTEGER NOT NULL,
      file_kind       TEXT NOT NULL,
      summary         TEXT,
      key_points      TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_conversation
      ON files(conversation_id, created_at);

    -- File chunks (for SQL + RAG)
    CREATE TABLE IF NOT EXISTS file_chunks (
      id              TEXT PRIMARY KEY,
      file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      content         TEXT NOT NULL,
      token_estimate  INTEGER,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_file_chunks_conversation
      ON file_chunks(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_file_chunks_file
      ON file_chunks(file_id, chunk_index);
  `);

  // Try creating the embeddings virtual table (requires sqlite-vec)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
        message_id TEXT PRIMARY KEY,
        vector     FLOAT[384]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS file_chunk_embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        vector   FLOAT[384]
      );
    `);
  } catch {
    // sqlite-vec not available — skip
  }
}
