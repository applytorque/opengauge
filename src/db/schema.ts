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

    -- Prompt improve events
    CREATE TABLE IF NOT EXISTS prompt_improvements (
      id                    TEXT PRIMARY KEY,
      conversation_id       TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      created_at            INTEGER NOT NULL,
      source                TEXT NOT NULL,
      original_prompt       TEXT NOT NULL,
      improved_prompt       TEXT NOT NULL,
      score_before          INTEGER NOT NULL,
      score_after           INTEGER NOT NULL,
      clarity_delta         INTEGER NOT NULL,
      duplicate_risk_delta  REAL NOT NULL,
      token_sent_delta      INTEGER NOT NULL,
      score_delta           INTEGER NOT NULL,
      used_improved         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_improvements_created
      ON prompt_improvements(created_at);

    CREATE INDEX IF NOT EXISTS idx_prompt_improvements_conversation
      ON prompt_improvements(conversation_id, created_at);

    -- ================================================================
    -- Phase 2-4 tables: multi-source sessions, interactions, alerts
    -- ================================================================

    -- Sessions (multi-source: chat, openclaw, proxy, log_ingest)
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      source            TEXT NOT NULL CHECK (source IN ('chat', 'openclaw', 'proxy', 'log_ingest')),
      model             TEXT NOT NULL,
      provider          TEXT NOT NULL,
      project_dir       TEXT,
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      total_tokens_in   INTEGER NOT NULL DEFAULT 0,
      total_tokens_out  INTEGER NOT NULL DEFAULT 0,
      total_cost_usd    REAL NOT NULL DEFAULT 0,
      tokens_saved      INTEGER NOT NULL DEFAULT 0,
      cost_saved_usd    REAL NOT NULL DEFAULT 0,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      metadata          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_source
      ON sessions(source, started_at);

    CREATE INDEX IF NOT EXISTS idx_sessions_started
      ON sessions(started_at);

    -- Interactions (individual API calls within a session)
    CREATE TABLE IF NOT EXISTS interactions (
      id                   TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence_num         INTEGER NOT NULL,
      timestamp            INTEGER NOT NULL,
      original_prompt      TEXT,
      optimized_prompt     TEXT,
      response_text        TEXT,
      tokens_in            INTEGER NOT NULL DEFAULT 0,
      tokens_out           INTEGER NOT NULL DEFAULT 0,
      cost_usd             REAL NOT NULL DEFAULT 0,
      upstream_status_code INTEGER,
      upstream_error       TEXT,
      latency_ms           INTEGER,
      optimization_delta   REAL NOT NULL DEFAULT 0,
      context_depth_tokens INTEGER NOT NULL DEFAULT 0,
      model                TEXT NOT NULL,
      metadata             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_session
      ON interactions(session_id, sequence_num);

    CREATE INDEX IF NOT EXISTS idx_interactions_timestamp
      ON interactions(timestamp);

    -- Alerts (circuit breaker, degradation, cost spikes)
    CREATE TABLE IF NOT EXISTS alerts (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      interaction_id  TEXT REFERENCES interactions(id) ON DELETE SET NULL,
      alert_type      TEXT NOT NULL CHECK (alert_type IN ('degradation', 'runaway_loop', 'cost_spike', 'stale_context', 'budget_breach')),
      severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
      message         TEXT NOT NULL,
      data            TEXT,
      created_at      INTEGER NOT NULL,
      dismissed       INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_session
      ON alerts(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_alerts_type
      ON alerts(alert_type, created_at);

    CREATE INDEX IF NOT EXISTS idx_alerts_dismissed
      ON alerts(dismissed, created_at);

    -- Model profiles (persisted pricing/config)
    CREATE TABLE IF NOT EXISTS model_profiles (
      model_id           TEXT PRIMARY KEY,
      provider           TEXT NOT NULL,
      cost_per_1m_in     REAL NOT NULL DEFAULT 0,
      cost_per_1m_out    REAL NOT NULL DEFAULT 0,
      max_context        INTEGER,
      preferred_format   TEXT,
      optimization_rules TEXT,
      updated_at         INTEGER NOT NULL
    );
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

  // Lightweight migrations for existing DBs.
  try {
    const columns = db.prepare(`PRAGMA table_info(interactions)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('upstream_status_code')) {
      db.exec(`ALTER TABLE interactions ADD COLUMN upstream_status_code INTEGER`);
    }
    if (!names.has('upstream_error')) {
      db.exec(`ALTER TABLE interactions ADD COLUMN upstream_error TEXT`);
    }
  } catch {
    // Ignore migration issues to avoid blocking startup.
  }
}
