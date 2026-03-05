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

    -- Prompt analytics
    CREATE TABLE IF NOT EXISTS prompt_analytics (
      message_id                 TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id            TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at                 INTEGER NOT NULL,

      prompt_tokens_raw          INTEGER NOT NULL,
      prompt_tokens_sent         INTEGER NOT NULL,

      score_specificity          INTEGER NOT NULL,
      score_goal_clarity         INTEGER NOT NULL,
      score_constraints          INTEGER NOT NULL,
      score_context_completeness INTEGER NOT NULL,
      score_structure            INTEGER NOT NULL,
      score_penalties            INTEGER NOT NULL,
      score_total                INTEGER NOT NULL,

      duplicate_cluster_id       TEXT,
      duplicate_similarity       REAL,
      duplicate_is_duplicate     INTEGER NOT NULL DEFAULT 0,
      duplicate_repeat_count     INTEGER NOT NULL DEFAULT 0,

      has_attachments            INTEGER NOT NULL DEFAULT 0,
      attachment_text_extracted  INTEGER NOT NULL DEFAULT 0,
      retry_turn                 INTEGER NOT NULL DEFAULT 0,
      repair_turn                INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_analytics_conversation
      ON prompt_analytics(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_prompt_analytics_created
      ON prompt_analytics(created_at);
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
