import {
  getDb,
  SessionQueries,
  calculateCost,
  checkRunawayLoop,
  type Interaction,
} from 'opengauge/core';
import { OpenClawPluginConfig, logError } from './config';

/**
 * Session state kept in memory for the current plugin lifecycle.
 */
interface SessionState {
  sessionId: string;
  interactionCount: number;
  runningCostUsd: number;
  lastCallTimestamp: number;
  recentInteractions: Interaction[];
  contextDepthTokens: number;
}

/**
 * OpenClaw provider interface (minimal — matches what registerProvider expects).
 */
export interface OpenClawProviderRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: any;
}

export interface OpenClawProviderResponse {
  content: string;
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  [key: string]: any;
}

export interface OpenClawProvider {
  name: string;
  defaultModel?: string;
  chat(request: OpenClawProviderRequest): Promise<OpenClawProviderResponse>;
  chatStream?(request: OpenClawProviderRequest): AsyncIterable<any>;
}

export class WrappedProvider {
  private realProvider: OpenClawProvider;
  private config: OpenClawPluginConfig;
  private queries: SessionQueries;
  private session: SessionState | null = null;

  constructor(realProvider: OpenClawProvider, config: OpenClawPluginConfig) {
    this.realProvider = realProvider;
    this.config = config;
    this.queries = new SessionQueries(getDb());
  }

  get name(): string {
    return this.realProvider.name;
  }

  get defaultModel(): string | undefined {
    return this.realProvider.defaultModel;
  }

  /**
   * Ensure we have an active session, creating one if needed or if timed out.
   */
  private ensureSession(model: string): SessionState {
    const now = Date.now();

    if (this.session && (now - this.session.lastCallTimestamp) > this.config.session_timeout_ms) {
      try {
        this.queries.finalizeSession(this.session.sessionId);
      } catch (e) { logError(e); }
      this.session = null;
    }

    if (!this.session) {
      try {
        const record = this.queries.createSession(
          'openclaw',
          model,
          this.realProvider.name
        );
        this.session = {
          sessionId: record.id,
          interactionCount: 0,
          runningCostUsd: 0,
          lastCallTimestamp: now,
          recentInteractions: [],
          contextDepthTokens: 0,
        };
      } catch (e) {
        logError(e);
        this.session = {
          sessionId: `fallback-${now}`,
          interactionCount: 0,
          runningCostUsd: 0,
          lastCallTimestamp: now,
          recentInteractions: [],
          contextDepthTokens: 0,
        };
      }
    }

    return this.session;
  }

  /**
   * Run circuit breaker checks. Returns a block message if the call should be stopped.
   */
  private runCircuitBreaker(session: SessionState): string | null {
    if (!this.config.circuit_breaker.enabled) return null;

    const verdict = checkRunawayLoop(session.recentInteractions, {
      similarityThreshold: this.config.circuit_breaker.similarity_threshold,
      tripPairCount: this.config.circuit_breaker.max_similar_calls,
      warningPairCount: Math.max(2, this.config.circuit_breaker.max_similar_calls - 2),
    });

    if (verdict.verdict === 'trip') {
      const msg = `OpenGauge circuit breaker: ${verdict.reason}. Session cost: $${session.runningCostUsd.toFixed(2)}. Stopping to prevent runaway spend.`;

      try {
        this.queries.writeAlert(
          session.sessionId,
          'runaway_loop',
          'critical',
          msg,
          { ...verdict, sessionCost: session.runningCostUsd }
        );
      } catch (e) { logError(e); }

      if (this.config.circuit_breaker.action === 'block') {
        return msg;
      }
    } else if (verdict.verdict === 'warning') {
      try {
        this.queries.writeAlert(
          session.sessionId,
          'runaway_loop',
          'warning',
          verdict.reason,
          verdict
        );
      } catch (e) { logError(e); }
    }

    return null;
  }

  /**
   * Check budget thresholds. Returns a block message if budget is breached.
   */
  private checkBudget(session: SessionState): string | null {
    if (session.runningCostUsd >= this.config.budget.session_limit_usd) {
      const msg = `OpenGauge budget: Session cost ($${session.runningCostUsd.toFixed(2)}) exceeds limit ($${this.config.budget.session_limit_usd.toFixed(2)}).`;
      try {
        this.queries.writeAlert(session.sessionId, 'budget_breach', 'critical', msg, {
          sessionCost: session.runningCostUsd,
          limit: this.config.budget.session_limit_usd,
        });
      } catch (e) { logError(e); }

      if (this.config.circuit_breaker.action === 'block') return msg;
    }

    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const summary = this.queries.getSpendSummary(todayStart.getTime(), 'openclaw');
      if (summary.total_cost_usd >= this.config.budget.daily_limit_usd) {
        const msg = `OpenGauge budget: Daily spend ($${summary.total_cost_usd.toFixed(2)}) exceeds limit ($${this.config.budget.daily_limit_usd.toFixed(2)}).`;
        this.queries.writeAlert(session.sessionId, 'budget_breach', 'critical', msg, {
          dailyCost: summary.total_cost_usd,
          limit: this.config.budget.daily_limit_usd,
        });
        if (this.config.circuit_breaker.action === 'block') return msg;
      }
    } catch (e) { logError(e); }

    return null;
  }

  /**
   * Main chat wrapper — intercepts every LLM call.
   */
  async chat(request: OpenClawProviderRequest): Promise<OpenClawProviderResponse> {
    const model = request.model || this.realProvider.defaultModel || 'unknown';
    const session = this.ensureSession(model);
    const startTime = Date.now();

    try {
      const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
      const originalPrompt = lastUserMsg?.content || '';

      const blockMsg = this.runCircuitBreaker(session);
      if (blockMsg) {
        return {
          content: blockMsg,
          model,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }

      const budgetMsg = this.checkBudget(session);
      if (budgetMsg) {
        return {
          content: budgetMsg,
          model,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }

      const response = await this.realProvider.chat(request);

      const latencyMs = Date.now() - startTime;
      const tokensIn = response.usage?.input_tokens || response.usage?.prompt_tokens || 0;
      const tokensOut = response.usage?.output_tokens || response.usage?.completion_tokens || 0;
      const costEstimate = calculateCost(this.realProvider.name, model, tokensIn, tokensOut);

      session.interactionCount++;
      session.runningCostUsd += costEstimate.totalCost;
      session.lastCallTimestamp = Date.now();
      session.contextDepthTokens += tokensIn;

      session.recentInteractions.push({
        role: 'user',
        content: originalPrompt,
        timestamp: startTime,
      });
      session.recentInteractions.push({
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
      });
      if (session.recentInteractions.length > 40) {
        session.recentInteractions = session.recentInteractions.slice(-40);
      }

      try {
        this.queries.writeInteraction(
          session.sessionId,
          session.interactionCount,
          model,
          {
            originalPrompt,
            responseText: this.config.log_response_text ? response.content : undefined,
            tokensIn,
            tokensOut,
            costUsd: costEstimate.totalCost,
            latencyMs,
            contextDepthTokens: session.contextDepthTokens,
            metadata: this.config.log_full_request ? { messages: request.messages } : undefined,
          }
        );
      } catch (e) { logError(e); }

      try {
        this.queries.updateSessionAggregates(
          session.sessionId,
          tokensIn,
          tokensOut,
          costEstimate.totalCost
        );
      } catch (e) { logError(e); }

      return response;

    } catch (error) {
      logError(error);
      try {
        return await this.realProvider.chat(request);
      } catch (providerError) {
        throw providerError;
      }
    }
  }

  /**
   * Stream wrapper — logs the complete interaction after stream completes.
   */
  async *chatStream(request: OpenClawProviderRequest): AsyncIterable<any> {
    if (!this.realProvider.chatStream) {
      const response = await this.chat(request);
      yield { content: response.content, done: true, ...response.usage };
      return;
    }

    const model = request.model || this.realProvider.defaultModel || 'unknown';
    const session = this.ensureSession(model);
    const startTime = Date.now();
    const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
    const originalPrompt = lastUserMsg?.content || '';

    try {
      const blockMsg = this.runCircuitBreaker(session);
      if (blockMsg) {
        yield { content: blockMsg, done: true };
        return;
      }
      const budgetMsg = this.checkBudget(session);
      if (budgetMsg) {
        yield { content: budgetMsg, done: true };
        return;
      }
    } catch (e) { logError(e); }

    let fullContent = '';
    let finalTokensIn = 0;
    let finalTokensOut = 0;

    try {
      for await (const chunk of this.realProvider.chatStream(request)) {
        if (chunk.content) fullContent += chunk.content;
        if (chunk.input_tokens || chunk.prompt_tokens) {
          finalTokensIn = chunk.input_tokens || chunk.prompt_tokens || finalTokensIn;
        }
        if (chunk.output_tokens || chunk.completion_tokens) {
          finalTokensOut = chunk.output_tokens || chunk.completion_tokens || finalTokensOut;
        }
        yield chunk;
      }
    } catch (error) {
      logError(error);
      throw error;
    }

    try {
      const latencyMs = Date.now() - startTime;
      const costEstimate = calculateCost(this.realProvider.name, model, finalTokensIn, finalTokensOut);

      session.interactionCount++;
      session.runningCostUsd += costEstimate.totalCost;
      session.lastCallTimestamp = Date.now();
      session.contextDepthTokens += finalTokensIn;

      session.recentInteractions.push(
        { role: 'user', content: originalPrompt, timestamp: startTime },
        { role: 'assistant', content: fullContent, timestamp: Date.now() }
      );
      if (session.recentInteractions.length > 40) {
        session.recentInteractions = session.recentInteractions.slice(-40);
      }

      this.queries.writeInteraction(session.sessionId, session.interactionCount, model, {
        originalPrompt,
        responseText: this.config.log_response_text ? fullContent : undefined,
        tokensIn: finalTokensIn,
        tokensOut: finalTokensOut,
        costUsd: costEstimate.totalCost,
        latencyMs,
        contextDepthTokens: session.contextDepthTokens,
      });

      this.queries.updateSessionAggregates(
        session.sessionId, finalTokensIn, finalTokensOut, costEstimate.totalCost
      );
    } catch (e) { logError(e); }
  }

  /**
   * Finalize the current session (called on plugin shutdown).
   */
  shutdown(): void {
    if (this.session) {
      try {
        this.queries.finalizeSession(this.session.sessionId);
      } catch (e) { logError(e); }
      this.session = null;
    }
  }
}
