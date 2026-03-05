import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface Conversation {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens_raw: number | null;
  tokens_sent: number | null;
  created_at: number;
}

export interface TokenUsage {
  id: string;
  conversation_id: string;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_saved: number;
  cost_estimate: number | null;
  created_at: number;
}

export interface Checkpoint {
  id: string;
  conversation_id: string;
  summary: string;
  covers_until: number;
  created_at: number;
}

export interface StoredFile {
  id: string;
  conversation_id: string;
  filename: string;
  mimetype: string | null;
  size_bytes: number;
  file_kind: string;
  summary: string | null;
  key_points: string | null;
  created_at: number;
}

export interface FileChunk {
  id: string;
  file_id: string;
  conversation_id: string;
  chunk_index: number;
  content: string;
  token_estimate: number | null;
  created_at: number;
}

export interface PromptAnalyticsRecord {
  message_id: string;
  conversation_id: string;
  created_at: number;
  prompt_tokens_raw: number;
  prompt_tokens_sent: number;
  score_specificity: number;
  score_goal_clarity: number;
  score_constraints: number;
  score_context_completeness: number;
  score_structure: number;
  score_penalties: number;
  score_total: number;
  duplicate_cluster_id: string | null;
  duplicate_similarity: number | null;
  duplicate_is_duplicate: number;
  duplicate_repeat_count: number;
  has_attachments: number;
  attachment_text_extracted: number;
  retry_turn: number;
  repair_turn: number;
}

export interface PromptImprovementRecord {
  id: string;
  conversation_id: string | null;
  created_at: number;
  source: string;
  original_prompt: string;
  improved_prompt: string;
  score_before: number;
  score_after: number;
  clarity_delta: number;
  duplicate_risk_delta: number;
  token_sent_delta: number;
  score_delta: number;
  used_improved: number;
}

export class Queries {
  private db: Database.Database;

  // Prepared statements
  private stmtInsertConversation: Database.Statement;
  private stmtUpdateConversation: Database.Statement;
  private stmtGetConversation: Database.Statement;
  private stmtListConversations: Database.Statement;
  private stmtDeleteConversation: Database.Statement;

  private stmtInsertMessage: Database.Statement;
  private stmtGetMessages: Database.Statement;
  private stmtGetMessageCount: Database.Statement;

  private stmtInsertTokenUsage: Database.Statement;
  private stmtGetTokenUsageByConversation: Database.Statement;
  private stmtGetAggregatedTokenUsage: Database.Statement;

  private stmtInsertCheckpoint: Database.Statement;
  private stmtGetLatestCheckpoint: Database.Statement;

  private stmtInsertFile: Database.Statement;
  private stmtInsertFileChunk: Database.Statement;
  private stmtListFileChunksByConversation: Database.Statement;
  private stmtListFilesByConversation: Database.Statement;

  private stmtInsertPromptAnalytics: Database.Statement;
  private stmtListPromptAnalytics: Database.Statement;
  private stmtListPromptAnalyticsByConversation: Database.Statement;
  private stmtListPromptAnalyticsWindow: Database.Statement;

  private stmtInsertPromptImprovement: Database.Statement;
  private stmtMarkPromptImprovementUsed: Database.Statement;
  private stmtListPromptImprovementsWindow: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Conversation statements
    this.stmtInsertConversation = db.prepare(`
      INSERT INTO conversations (id, title, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpdateConversation = db.prepare(`
      UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtGetConversation = db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `);

    this.stmtListConversations = db.prepare(`
      SELECT * FROM conversations ORDER BY updated_at DESC
    `);

    this.stmtDeleteConversation = db.prepare(`
      DELETE FROM conversations WHERE id = ?
    `);

    // Message statements
    this.stmtInsertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tokens_raw, tokens_sent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetMessages = db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
    `);

    this.stmtGetMessageCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?
    `);

    // Token usage statements
    this.stmtInsertTokenUsage = db.prepare(`
      INSERT INTO token_usage (id, conversation_id, provider, model, tokens_in, tokens_out, tokens_saved, cost_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetTokenUsageByConversation = db.prepare(`
      SELECT * FROM token_usage WHERE conversation_id = ? ORDER BY created_at DESC
    `);

    this.stmtGetAggregatedTokenUsage = db.prepare(`
      SELECT
        provider,
        model,
        SUM(tokens_in) as total_tokens_in,
        SUM(tokens_out) as total_tokens_out,
        SUM(tokens_saved) as total_tokens_saved,
        SUM(cost_estimate) as total_cost,
        COUNT(*) as request_count
      FROM token_usage
      GROUP BY provider, model
    `);

    // Checkpoint statements
    this.stmtInsertCheckpoint = db.prepare(`
      INSERT INTO checkpoints (id, conversation_id, summary, covers_until, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetLatestCheckpoint = db.prepare(`
      SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1
    `);

    // File ingestion statements
    this.stmtInsertFile = db.prepare(`
      INSERT INTO files (id, conversation_id, filename, mimetype, size_bytes, file_kind, summary, key_points, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertFileChunk = db.prepare(`
      INSERT INTO file_chunks (id, file_id, conversation_id, chunk_index, content, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtListFileChunksByConversation = db.prepare(`
      SELECT * FROM file_chunks WHERE conversation_id = ? ORDER BY created_at DESC
    `);

    this.stmtListFilesByConversation = db.prepare(`
      SELECT * FROM files WHERE conversation_id = ? ORDER BY created_at DESC
    `);

    // Prompt analytics statements
    this.stmtInsertPromptAnalytics = db.prepare(`
      INSERT OR REPLACE INTO prompt_analytics (
        message_id,
        conversation_id,
        created_at,
        prompt_tokens_raw,
        prompt_tokens_sent,
        score_specificity,
        score_goal_clarity,
        score_constraints,
        score_context_completeness,
        score_structure,
        score_penalties,
        score_total,
        duplicate_cluster_id,
        duplicate_similarity,
        duplicate_is_duplicate,
        duplicate_repeat_count,
        has_attachments,
        attachment_text_extracted,
        retry_turn,
        repair_turn
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtListPromptAnalytics = db.prepare(`
      SELECT * FROM prompt_analytics ORDER BY created_at DESC LIMIT ?
    `);

    this.stmtListPromptAnalyticsByConversation = db.prepare(`
      SELECT * FROM prompt_analytics WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
    `);

    this.stmtListPromptAnalyticsWindow = db.prepare(`
      SELECT * FROM prompt_analytics WHERE created_at >= ? ORDER BY created_at DESC
    `);

    this.stmtInsertPromptImprovement = db.prepare(`
      INSERT INTO prompt_improvements (
        id,
        conversation_id,
        created_at,
        source,
        original_prompt,
        improved_prompt,
        score_before,
        score_after,
        clarity_delta,
        duplicate_risk_delta,
        token_sent_delta,
        score_delta,
        used_improved
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtMarkPromptImprovementUsed = db.prepare(`
      UPDATE prompt_improvements
      SET used_improved = 1
      WHERE id = ?
    `);

    this.stmtListPromptImprovementsWindow = db.prepare(`
      SELECT * FROM prompt_improvements
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `);
  }

  // ---- Conversations ----

  createConversation(provider: string, model: string, title?: string): Conversation {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertConversation.run(id, title || null, provider, model, now, now);
    return { id, title: title || null, provider, model, created_at: now, updated_at: now };
  }

  updateConversation(id: string, title: string): void {
    this.stmtUpdateConversation.run(title, Date.now(), id);
  }

  getConversation(id: string): Conversation | undefined {
    return this.stmtGetConversation.get(id) as Conversation | undefined;
  }

  listConversations(): Conversation[] {
    return this.stmtListConversations.all() as Conversation[];
  }

  deleteConversation(id: string): void {
    this.stmtDeleteConversation.run(id);
  }

  // ---- Messages ----

  insertMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    tokensRaw?: number,
    tokensSent?: number
  ): Message {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertMessage.run(id, conversationId, role, content, tokensRaw ?? null, tokensSent ?? null, now);
    // Update conversation updated_at
    this.stmtUpdateConversation.run(null, now, conversationId);
    // Re-read to keep title if it existed
    const conv = this.getConversation(conversationId);
    if (conv) {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    }
    return { id, conversation_id: conversationId, role, content, tokens_raw: tokensRaw ?? null, tokens_sent: tokensSent ?? null, created_at: now };
  }

  getMessages(conversationId: string): Message[] {
    return this.stmtGetMessages.all(conversationId) as Message[];
  }

  getMessageCount(conversationId: string): number {
    const row = this.stmtGetMessageCount.get(conversationId) as { count: number };
    return row.count;
  }

  // ---- Token Usage ----

  insertTokenUsage(
    conversationId: string,
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    tokensSaved: number = 0,
    costEstimate?: number
  ): TokenUsage {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertTokenUsage.run(id, conversationId, provider, model, tokensIn, tokensOut, tokensSaved, costEstimate ?? null, now);
    return { id, conversation_id: conversationId, provider, model, tokens_in: tokensIn, tokens_out: tokensOut, tokens_saved: tokensSaved, cost_estimate: costEstimate ?? null, created_at: now };
  }

  getTokenUsageByConversation(conversationId: string): TokenUsage[] {
    return this.stmtGetTokenUsageByConversation.all(conversationId) as TokenUsage[];
  }

  getAggregatedTokenUsage(): any[] {
    return this.stmtGetAggregatedTokenUsage.all();
  }

  // ---- Checkpoints ----

  insertCheckpoint(conversationId: string, summary: string, coversUntil: number): Checkpoint {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertCheckpoint.run(id, conversationId, summary, coversUntil, now);
    return { id, conversation_id: conversationId, summary, covers_until: coversUntil, created_at: now };
  }

  getLatestCheckpoint(conversationId: string): Checkpoint | undefined {
    return this.stmtGetLatestCheckpoint.get(conversationId) as Checkpoint | undefined;
  }

  // ---- Files / Chunks ----

  insertFile(
    conversationId: string,
    filename: string,
    mimetype: string | null,
    sizeBytes: number,
    fileKind: string,
    summary: string | null,
    keyPoints: string | null
  ): StoredFile {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertFile.run(
      id,
      conversationId,
      filename,
      mimetype,
      sizeBytes,
      fileKind,
      summary,
      keyPoints,
      now
    );
    return {
      id,
      conversation_id: conversationId,
      filename,
      mimetype,
      size_bytes: sizeBytes,
      file_kind: fileKind,
      summary,
      key_points: keyPoints,
      created_at: now,
    };
  }

  insertFileChunk(
    fileId: string,
    conversationId: string,
    chunkIndex: number,
    content: string,
    tokenEstimate?: number
  ): FileChunk {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertFileChunk.run(
      id,
      fileId,
      conversationId,
      chunkIndex,
      content,
      tokenEstimate ?? null,
      now
    );
    return {
      id,
      file_id: fileId,
      conversation_id: conversationId,
      chunk_index: chunkIndex,
      content,
      token_estimate: tokenEstimate ?? null,
      created_at: now,
    };
  }

  listFilesByConversation(conversationId: string): StoredFile[] {
    return this.stmtListFilesByConversation.all(conversationId) as StoredFile[];
  }

  listFileChunksByConversation(conversationId: string): FileChunk[] {
    return this.stmtListFileChunksByConversation.all(conversationId) as FileChunk[];
  }

  insertFileChunkEmbedding(chunkId: string, vector: Float32Array): void {
    try {
      this.db.prepare('INSERT INTO file_chunk_embeddings (chunk_id, vector) VALUES (?, ?)')
        .run(chunkId, Buffer.from(vector.buffer));
    } catch {
      // sqlite-vec not available
    }
  }

  searchSimilarFileChunks(
    queryVector: Float32Array,
    limit: number = 12
  ): Array<{ chunk_id: string; distance: number }> {
    try {
      return this.db.prepare(`
        SELECT chunk_id, distance
        FROM file_chunk_embeddings
        WHERE vector MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(Buffer.from(queryVector.buffer), limit) as Array<{ chunk_id: string; distance: number }>;
    } catch {
      return [];
    }
  }

  // ---- Embeddings ----

  insertEmbedding(messageId: string, vector: Float32Array): void {
    try {
      this.db.prepare(
        'INSERT INTO embeddings (message_id, vector) VALUES (?, ?)'
      ).run(messageId, Buffer.from(vector.buffer));
    } catch {
      // sqlite-vec not available
    }
  }

  searchSimilar(queryVector: Float32Array, limit: number = 15): Array<{ message_id: string; distance: number }> {
    try {
      const rows = this.db.prepare(`
        SELECT message_id, distance
        FROM embeddings
        WHERE vector MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(Buffer.from(queryVector.buffer), limit) as Array<{ message_id: string; distance: number }>;
      return rows;
    } catch {
      return [];
    }
  }

  // ---- Prompt Analytics ----

  insertPromptAnalytics(record: PromptAnalyticsRecord): void {
    this.stmtInsertPromptAnalytics.run(
      record.message_id,
      record.conversation_id,
      record.created_at,
      record.prompt_tokens_raw,
      record.prompt_tokens_sent,
      record.score_specificity,
      record.score_goal_clarity,
      record.score_constraints,
      record.score_context_completeness,
      record.score_structure,
      record.score_penalties,
      record.score_total,
      record.duplicate_cluster_id,
      record.duplicate_similarity,
      record.duplicate_is_duplicate,
      record.duplicate_repeat_count,
      record.has_attachments,
      record.attachment_text_extracted,
      record.retry_turn,
      record.repair_turn
    );
  }

  listPromptAnalytics(limit: number = 100, conversationId?: string): PromptAnalyticsRecord[] {
    if (conversationId) {
      return this.stmtListPromptAnalyticsByConversation.all(conversationId, limit) as PromptAnalyticsRecord[];
    }
    return this.stmtListPromptAnalytics.all(limit) as PromptAnalyticsRecord[];
  }

  listPromptAnalyticsByWindow(windowMs: number): PromptAnalyticsRecord[] {
    const since = Date.now() - windowMs;
    return this.stmtListPromptAnalyticsWindow.all(since) as PromptAnalyticsRecord[];
  }

  insertPromptImprovement(
    source: string,
    originalPrompt: string,
    improvedPrompt: string,
    benefit: {
      scoreBefore: number;
      scoreAfter: number;
      clarityDelta: number;
      duplicateRiskDelta: number;
      tokenSentDelta: number;
      scoreDelta: number;
    },
    conversationId?: string
  ): PromptImprovementRecord {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertPromptImprovement.run(
      id,
      conversationId || null,
      now,
      source,
      originalPrompt,
      improvedPrompt,
      benefit.scoreBefore,
      benefit.scoreAfter,
      benefit.clarityDelta,
      benefit.duplicateRiskDelta,
      benefit.tokenSentDelta,
      benefit.scoreDelta,
      0
    );

    return {
      id,
      conversation_id: conversationId || null,
      created_at: now,
      source,
      original_prompt: originalPrompt,
      improved_prompt: improvedPrompt,
      score_before: benefit.scoreBefore,
      score_after: benefit.scoreAfter,
      clarity_delta: benefit.clarityDelta,
      duplicate_risk_delta: benefit.duplicateRiskDelta,
      token_sent_delta: benefit.tokenSentDelta,
      score_delta: benefit.scoreDelta,
      used_improved: 0,
    };
  }

  markPromptImprovementUsed(id: string): void {
    this.stmtMarkPromptImprovementUsed.run(id);
  }

  listPromptImprovementsByWindow(windowMs: number): PromptImprovementRecord[] {
    const since = Date.now() - windowMs;
    return this.stmtListPromptImprovementsWindow.all(since) as PromptImprovementRecord[];
  }
}
