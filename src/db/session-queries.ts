import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

// ---- Interfaces ----

export interface SessionRecord {
  id: string;
  source: 'chat' | 'openclaw' | 'proxy' | 'log_ingest';
  model: string;
  provider: string;
  project_dir: string | null;
  started_at: number;
  ended_at: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  tokens_saved: number;
  cost_saved_usd: number;
  interaction_count: number;
  metadata: string | null;
}

export interface InteractionRecord {
  id: string;
  session_id: string;
  sequence_num: number;
  timestamp: number;
  original_prompt: string | null;
  optimized_prompt: string | null;
  response_text: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number | null;
  optimization_delta: number;
  context_depth_tokens: number;
  model: string;
  metadata: string | null;
}

export interface AlertRecord {
  id: string;
  session_id: string;
  interaction_id: string | null;
  alert_type: 'degradation' | 'runaway_loop' | 'cost_spike' | 'stale_context' | 'budget_breach';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data: string | null;
  created_at: number;
  dismissed: number;
}

export interface ModelProfileRecord {
  model_id: string;
  provider: string;
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  max_context: number | null;
  preferred_format: string | null;
  optimization_rules: string | null;
  updated_at: number;
}

export interface SessionFilters {
  source?: string;
  provider?: string;
  model?: string;
  since?: number;     // epoch ms
  until?: number;     // epoch ms
  limit?: number;
}

export interface AlertFilters {
  alertType?: string;
  severity?: string;
  dismissed?: boolean;
  since?: number;
  limit?: number;
}

export interface SpendSummary {
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_saved: number;
  total_cost_saved_usd: number;
  session_count: number;
  interaction_count: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  session_count: number;
  interaction_count: number;
}

// ---- Session Queries class ----

export class SessionQueries {
  private db: Database.Database;

  private stmtInsertSession: Database.Statement;
  private stmtUpdateSession: Database.Statement;
  private stmtFinalizeSession: Database.Statement;
  private stmtGetSession: Database.Statement;

  private stmtInsertInteraction: Database.Statement;
  private stmtGetInteractions: Database.Statement;
  private stmtGetRecentInteractions: Database.Statement;

  private stmtInsertAlert: Database.Statement;
  private stmtDismissAlert: Database.Statement;

  private stmtUpsertModelProfile: Database.Statement;
  private stmtGetModelProfile: Database.Statement;
  private stmtListModelProfiles: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Session statements
    this.stmtInsertSession = db.prepare(`
      INSERT INTO sessions (id, source, model, provider, project_dir, started_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpdateSession = db.prepare(`
      UPDATE sessions SET
        total_tokens_in = total_tokens_in + ?,
        total_tokens_out = total_tokens_out + ?,
        total_cost_usd = total_cost_usd + ?,
        tokens_saved = tokens_saved + ?,
        cost_saved_usd = cost_saved_usd + ?,
        interaction_count = interaction_count + 1
      WHERE id = ?
    `);

    this.stmtFinalizeSession = db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `);

    this.stmtGetSession = db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    // Interaction statements
    this.stmtInsertInteraction = db.prepare(`
      INSERT INTO interactions (
        id, session_id, sequence_num, timestamp, original_prompt, optimized_prompt,
        response_text, tokens_in, tokens_out, cost_usd, latency_ms,
        optimization_delta, context_depth_tokens, model, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetInteractions = db.prepare(`
      SELECT * FROM interactions WHERE session_id = ? ORDER BY sequence_num ASC
    `);

    this.stmtGetRecentInteractions = db.prepare(`
      SELECT * FROM interactions WHERE session_id = ? ORDER BY sequence_num DESC LIMIT ?
    `);

    // Alert statements
    this.stmtInsertAlert = db.prepare(`
      INSERT INTO alerts (id, session_id, interaction_id, alert_type, severity, message, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtDismissAlert = db.prepare(`
      UPDATE alerts SET dismissed = 1 WHERE id = ?
    `);

    // Model profile statements
    this.stmtUpsertModelProfile = db.prepare(`
      INSERT INTO model_profiles (model_id, provider, cost_per_1m_in, cost_per_1m_out, max_context, preferred_format, optimization_rules, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        provider = excluded.provider,
        cost_per_1m_in = excluded.cost_per_1m_in,
        cost_per_1m_out = excluded.cost_per_1m_out,
        max_context = excluded.max_context,
        preferred_format = excluded.preferred_format,
        optimization_rules = excluded.optimization_rules,
        updated_at = excluded.updated_at
    `);

    this.stmtGetModelProfile = db.prepare(`
      SELECT * FROM model_profiles WHERE model_id = ?
    `);

    this.stmtListModelProfiles = db.prepare(`
      SELECT * FROM model_profiles ORDER BY provider, model_id
    `);
  }

  // ---- Sessions ----

  createSession(
    source: SessionRecord['source'],
    model: string,
    provider: string,
    projectDir?: string,
    metadata?: object
  ): SessionRecord {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertSession.run(
      id, source, model, provider, projectDir || null, now,
      metadata ? JSON.stringify(metadata) : null
    );
    return {
      id, source, model, provider,
      project_dir: projectDir || null,
      started_at: now, ended_at: null,
      total_tokens_in: 0, total_tokens_out: 0,
      total_cost_usd: 0, tokens_saved: 0, cost_saved_usd: 0,
      interaction_count: 0,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };
  }

  updateSessionAggregates(
    sessionId: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
    tokensSaved: number = 0,
    costSavedUsd: number = 0
  ): void {
    this.stmtUpdateSession.run(tokensIn, tokensOut, costUsd, tokensSaved, costSavedUsd, sessionId);
  }

  finalizeSession(sessionId: string): void {
    this.stmtFinalizeSession.run(Date.now(), sessionId);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.stmtGetSession.get(id) as SessionRecord | undefined;
  }

  querySessions(filters?: SessionFilters): SessionRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.source) {
      conditions.push('source = ?');
      params.push(filters.source);
    }
    if (filters?.provider) {
      conditions.push('provider = ?');
      params.push(filters.provider);
    }
    if (filters?.model) {
      conditions.push('model LIKE ?');
      params.push(`%${filters.model}%`);
    }
    if (filters?.since) {
      conditions.push('started_at >= ?');
      params.push(filters.since);
    }
    if (filters?.until) {
      conditions.push('started_at <= ?');
      params.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ? `LIMIT ${filters.limit}` : '';

    return this.db.prepare(
      `SELECT * FROM sessions ${where} ORDER BY started_at DESC ${limit}`
    ).all(...params) as SessionRecord[];
  }

  // ---- Interactions ----

  writeInteraction(
    sessionId: string,
    sequenceNum: number,
    model: string,
    opts: {
      originalPrompt?: string;
      optimizedPrompt?: string;
      responseText?: string;
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number;
      latencyMs?: number;
      optimizationDelta?: number;
      contextDepthTokens?: number;
      metadata?: object;
    }
  ): InteractionRecord {
    const id = uuidv4();
    const now = Date.now();
    const responseText = opts.responseText
      ? opts.responseText.slice(0, 2000)  // truncate per spec
      : null;

    this.stmtInsertInteraction.run(
      id, sessionId, sequenceNum, now,
      opts.originalPrompt || null,
      opts.optimizedPrompt || null,
      responseText,
      opts.tokensIn || 0,
      opts.tokensOut || 0,
      opts.costUsd || 0,
      opts.latencyMs || null,
      opts.optimizationDelta || 0,
      opts.contextDepthTokens || 0,
      model,
      opts.metadata ? JSON.stringify(opts.metadata) : null
    );

    return {
      id, session_id: sessionId, sequence_num: sequenceNum,
      timestamp: now,
      original_prompt: opts.originalPrompt || null,
      optimized_prompt: opts.optimizedPrompt || null,
      response_text: responseText,
      tokens_in: opts.tokensIn || 0,
      tokens_out: opts.tokensOut || 0,
      cost_usd: opts.costUsd || 0,
      latency_ms: opts.latencyMs || null,
      optimization_delta: opts.optimizationDelta || 0,
      context_depth_tokens: opts.contextDepthTokens || 0,
      model,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    };
  }

  queryInteractions(sessionId: string): InteractionRecord[] {
    return this.stmtGetInteractions.all(sessionId) as InteractionRecord[];
  }

  getRecentInteractions(sessionId: string, limit: number = 20): InteractionRecord[] {
    const rows = this.stmtGetRecentInteractions.all(sessionId, limit) as InteractionRecord[];
    return rows.reverse(); // return in chronological order
  }

  // ---- Alerts ----

  writeAlert(
    sessionId: string,
    alertType: AlertRecord['alert_type'],
    severity: AlertRecord['severity'],
    message: string,
    data?: object,
    interactionId?: string
  ): AlertRecord {
    const id = uuidv4();
    const now = Date.now();
    this.stmtInsertAlert.run(
      id, sessionId, interactionId || null,
      alertType, severity, message,
      data ? JSON.stringify(data) : null, now
    );
    return {
      id, session_id: sessionId,
      interaction_id: interactionId || null,
      alert_type: alertType, severity, message,
      data: data ? JSON.stringify(data) : null,
      created_at: now, dismissed: 0,
    };
  }

  dismissAlert(id: string): void {
    this.stmtDismissAlert.run(id);
  }

  queryAlerts(filters?: AlertFilters): AlertRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.alertType) {
      conditions.push('alert_type = ?');
      params.push(filters.alertType);
    }
    if (filters?.severity) {
      conditions.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters?.dismissed !== undefined) {
      conditions.push('dismissed = ?');
      params.push(filters.dismissed ? 1 : 0);
    }
    if (filters?.since) {
      conditions.push('created_at >= ?');
      params.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ? `LIMIT ${filters.limit}` : '';

    return this.db.prepare(
      `SELECT * FROM alerts ${where} ORDER BY created_at DESC ${limit}`
    ).all(...params) as AlertRecord[];
  }

  // ---- Model Profiles ----

  upsertModelProfile(profile: Omit<ModelProfileRecord, 'updated_at'>): void {
    this.stmtUpsertModelProfile.run(
      profile.model_id, profile.provider,
      profile.cost_per_1m_in, profile.cost_per_1m_out,
      profile.max_context || null,
      profile.preferred_format || null,
      profile.optimization_rules || null,
      Date.now()
    );
  }

  getModelProfile(modelId: string): ModelProfileRecord | undefined {
    return this.stmtGetModelProfile.get(modelId) as ModelProfileRecord | undefined;
  }

  listModelProfiles(): ModelProfileRecord[] {
    return this.stmtListModelProfiles.all() as ModelProfileRecord[];
  }

  // ---- Aggregated Analytics ----

  getSpendSummary(since?: number, source?: string): SpendSummary {
    const conditions: string[] = [];
    const params: any[] = [];
    if (since) {
      conditions.push('started_at >= ?');
      params.push(since);
    }
    if (source) {
      conditions.push('source = ?');
      params.push(source);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(total_tokens_out), 0) as total_tokens_out,
        COALESCE(SUM(tokens_saved), 0) as total_tokens_saved,
        COALESCE(SUM(cost_saved_usd), 0) as total_cost_saved_usd,
        COUNT(*) as session_count,
        COALESCE(SUM(interaction_count), 0) as interaction_count
      FROM sessions ${where}
    `).get(...params) as SpendSummary;

    return row;
  }

  getModelUsage(since?: number): ModelUsage[] {
    const params: any[] = [];
    const where = since ? 'WHERE started_at >= ?' : '';
    if (since) params.push(since);

    return this.db.prepare(`
      SELECT
        provider,
        model,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(total_tokens_out), 0) as total_tokens_out,
        COUNT(*) as session_count,
        COALESCE(SUM(interaction_count), 0) as interaction_count
      FROM sessions ${where}
      GROUP BY provider, model
      ORDER BY total_cost_usd DESC
    `).all(...params) as ModelUsage[];
  }

  getTopSessionsByCost(limit: number = 5, since?: number): SessionRecord[] {
    const params: any[] = [];
    const where = since ? 'WHERE started_at >= ?' : '';
    if (since) params.push(since);

    return this.db.prepare(`
      SELECT * FROM sessions ${where}
      ORDER BY total_cost_usd DESC
      LIMIT ?
    `).all(...params, limit) as SessionRecord[];
  }

  getDailySpend(days: number = 30): Array<{ day: string; cost_usd: number; tokens_in: number; tokens_out: number; sessions: number }> {
    const since = Date.now() - days * 86400000;
    return this.db.prepare(`
      SELECT
        date(started_at / 1000, 'unixepoch') as day,
        COALESCE(SUM(total_cost_usd), 0) as cost_usd,
        COALESCE(SUM(total_tokens_in), 0) as tokens_in,
        COALESCE(SUM(total_tokens_out), 0) as tokens_out,
        COUNT(*) as sessions
      FROM sessions
      WHERE started_at >= ?
      GROUP BY day
      ORDER BY day DESC
    `).all(since) as Array<{ day: string; cost_usd: number; tokens_in: number; tokens_out: number; sessions: number }>;
  }

  getAlertSummary(since?: number): Array<{ alert_type: string; severity: string; count: number }> {
    const params: any[] = [];
    const where = since ? 'WHERE created_at >= ?' : '';
    if (since) params.push(since);

    return this.db.prepare(`
      SELECT alert_type, severity, COUNT(*) as count
      FROM alerts ${where}
      GROUP BY alert_type, severity
      ORDER BY count DESC
    `).all(...params) as Array<{ alert_type: string; severity: string; count: number }>;
  }
}
