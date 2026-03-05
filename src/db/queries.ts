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
}
