/**
 * @opengauge/openclaw-plugin
 *
 * OpenClaw plugin that observes every LLM call via hooks (llm_input / llm_output),
 * logging every individual API call to @opengauge/core's SQLite database.
 *
 * Features:
 *   - Per-call cost tracking
 *   - Runaway loop detection (circuit breaker alerts)
 *   - Budget enforcement alerts (session/daily/monthly)
 *   - Fail-safe: never crashes the agent
 *
 * Install: openclaw plugins install @opengauge/openclaw-plugin
 */

import { getDb, initSchema, SessionQueries, calculateCost, checkRunawayLoop } from 'opengauge/core';
import type { Interaction } from 'opengauge/core';
import { loadPluginConfig, logError, type OpenClawPluginConfig } from './config';

/* ------------------------------------------------------------------ */
/*  OpenClaw Plugin API types (matches what register() actually gets) */
/* ------------------------------------------------------------------ */

interface HookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  [key: string]: any;
}

interface LlmInputEvent {
  runId: string;
  sessionId?: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages?: Array<{ role: string; content: string }>;
  imagesCount?: number;
}

interface LlmOutputEvent {
  runId: string;
  sessionId?: string;
  provider: string;
  model: string;
  assistantTexts?: string[];
  lastAssistant?: any;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    // fallback names used by other providers
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    [key: string]: any;
  };
}

interface OpenClawPluginAPI {
  on(hookName: string, handler: (...args: any[]) => void | Promise<void>, opts?: any): void;
  registerCommand?(command: any): void;
  registerProvider?(provider: any): void;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  [key: string]: any;
}

/* ------------------------------------------------------------------ */
/*  In-flight call tracking (correlate input → output by runId)       */
/* ------------------------------------------------------------------ */

interface InFlightCall {
  runId: string;
  provider: string;
  model: string;
  prompt: string;
  startTime: number;
}

/* ------------------------------------------------------------------ */
/*  Session state                                                     */
/* ------------------------------------------------------------------ */

interface SessionState {
  sessionId: string;
  interactionCount: number;
  runningCostUsd: number;
  lastCallTimestamp: number;
  recentInteractions: Interaction[];
  contextDepthTokens: number;
}

/* ------------------------------------------------------------------ */
/*  Plugin core                                                       */
/* ------------------------------------------------------------------ */

let queries: SessionQueries | null = null;
let config: OpenClawPluginConfig;
let session: SessionState | null = null;
const inFlight = new Map<string, InFlightCall>();

function ensureSession(model: string, provider: string): SessionState {
  const now = Date.now();

  if (session && (now - session.lastCallTimestamp) > config.session_timeout_ms) {
    try { queries?.finalizeSession(session.sessionId); } catch (e) { logError(e); }
    session = null;
  }

  if (!session) {
    try {
      const record = queries!.createSession('openclaw', model, provider);
      session = {
        sessionId: record.id,
        interactionCount: 0,
        runningCostUsd: 0,
        lastCallTimestamp: now,
        recentInteractions: [],
        contextDepthTokens: 0,
      };
    } catch (e) {
      logError(e);
      session = {
        sessionId: `fallback-${now}`,
        interactionCount: 0,
        runningCostUsd: 0,
        lastCallTimestamp: now,
        recentInteractions: [],
        contextDepthTokens: 0,
      };
    }
  }

  return session;
}

function runChecks(sess: SessionState, logger?: OpenClawPluginAPI['logger']): void {
  // Circuit breaker (warn only — hooks can't block calls)
  if (config.circuit_breaker.enabled) {
    try {
      const verdict = checkRunawayLoop(sess.recentInteractions, {
        similarityThreshold: config.circuit_breaker.similarity_threshold,
        tripPairCount: config.circuit_breaker.max_similar_calls,
        warningPairCount: Math.max(2, config.circuit_breaker.max_similar_calls - 2),
      });

      if (verdict.verdict === 'trip' || verdict.verdict === 'warning') {
        const severity = verdict.verdict === 'trip' ? 'critical' : 'warning';
        const msg = verdict.verdict === 'trip'
          ? `OpenGauge circuit breaker: ${verdict.reason}. Session cost: $${sess.runningCostUsd.toFixed(2)}.`
          : `OpenGauge warning: ${verdict.reason}`;

        queries?.writeAlert(sess.sessionId, 'runaway_loop', severity as any, msg, {
          ...verdict,
          sessionCost: sess.runningCostUsd,
        });

        if (logger) logger.warn(msg);
      }
    } catch (e) { logError(e); }
  }

  // Budget checks
  try {
    if (sess.runningCostUsd >= config.budget.session_limit_usd) {
      const msg = `OpenGauge budget: Session cost ($${sess.runningCostUsd.toFixed(2)}) exceeds limit ($${config.budget.session_limit_usd.toFixed(2)}).`;
      queries?.writeAlert(sess.sessionId, 'budget_breach', 'critical', msg, {
        sessionCost: sess.runningCostUsd,
        limit: config.budget.session_limit_usd,
      });
      if (logger) logger.warn(msg);
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const summary = queries?.getSpendSummary(todayStart.getTime(), 'openclaw');
    if (summary && summary.total_cost_usd >= config.budget.daily_limit_usd) {
      const msg = `OpenGauge budget: Daily spend ($${summary.total_cost_usd.toFixed(2)}) exceeds limit ($${config.budget.daily_limit_usd.toFixed(2)}).`;
      queries?.writeAlert(sess.sessionId, 'budget_breach', 'critical', msg, {
        dailyCost: summary.total_cost_usd,
        limit: config.budget.daily_limit_usd,
      });
      if (logger) logger.warn(msg);
    }
  } catch (e) { logError(e); }
}

/* ------------------------------------------------------------------ */
/*  Plugin entry point                                                */
/* ------------------------------------------------------------------ */

export function register(api: OpenClawPluginAPI): void {
  try {
    const db = getDb();
    initSchema(db);
    queries = new SessionQueries(db);
    config = loadPluginConfig();

    // --- llm_input: track when a call starts ---
    api.on('llm_input', (event: LlmInputEvent, _ctx: HookContext) => {
      try {
        inFlight.set(event.runId, {
          runId: event.runId,
          provider: event.provider,
          model: event.model,
          prompt: event.prompt || '',
          startTime: Date.now(),
        });
      } catch (e) { logError(e); }
    });

    // --- llm_output: log the completed call ---
    api.on('llm_output', (event: LlmOutputEvent, _ctx: HookContext) => {
      try {

        const call = inFlight.get(event.runId);
        inFlight.delete(event.runId);

        const provider = event.provider || call?.provider || 'unknown';
        const model = event.model || call?.model || 'unknown';
        const prompt = call?.prompt || '';
        const startTime = call?.startTime || Date.now();
        const latencyMs = Date.now() - startTime;

        const u = event.usage;
        const tokensIn = (u?.input || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0)
          || u?.input_tokens || u?.prompt_tokens || 0;
        const tokensOut = u?.output || u?.output_tokens || u?.completion_tokens || 0;
        const costEstimate = calculateCost(provider, model, tokensIn, tokensOut);

        const sess = ensureSession(model, provider);
        sess.interactionCount++;
        sess.runningCostUsd += costEstimate.totalCost;
        sess.lastCallTimestamp = Date.now();
        sess.contextDepthTokens += tokensIn;

        const responseText = event.assistantTexts?.join('\n') || '';

        sess.recentInteractions.push(
          { role: 'user', content: prompt, timestamp: startTime },
          { role: 'assistant', content: responseText, timestamp: Date.now() },
        );
        if (sess.recentInteractions.length > 40) {
          sess.recentInteractions = sess.recentInteractions.slice(-40);
        }

        // Write interaction
        queries?.writeInteraction(
          sess.sessionId,
          sess.interactionCount,
          model,
          {
            originalPrompt: prompt,
            responseText: config.log_response_text ? responseText : undefined,
            tokensIn,
            tokensOut,
            costUsd: costEstimate.totalCost,
            latencyMs,
            contextDepthTokens: sess.contextDepthTokens,
          },
        );

        // Update session aggregates
        queries?.updateSessionAggregates(
          sess.sessionId, tokensIn, tokensOut, costEstimate.totalCost,
        );

        // Run circuit breaker + budget checks
        runChecks(sess, api.logger);

      } catch (e) { logError(e); }
    });

    // --- gateway_stop: finalize session ---
    api.on('gateway_stop', () => {
      if (session) {
        try { queries?.finalizeSession(session.sessionId); } catch (e) { logError(e); }
        session = null;
      }
    });

    api.logger?.info('OpenGauge plugin loaded — observing LLM calls');

    // Non-blocking update check
    checkForUpdate(api.logger).catch(() => {});

  } catch (error) {
    // Fail-safe: plugin must never crash OpenClaw
    logError(error);
  }
}

/**
 * Check npm registry for a newer version and log a message if available.
 */
async function checkForUpdate(logger?: OpenClawPluginAPI['logger']): Promise<void> {
  try {
    const https = await import('https');
    const data = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        'https://registry.npmjs.org/@opengauge/openclaw-plugin/latest',
        { headers: { 'accept': 'application/json' }, timeout: 5000 },
        (res) => {
          if (res.statusCode !== 200) { resolve(''); return; }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        }
      );
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });

    if (!data) return;
    const pkg = JSON.parse(data);
    const latest = pkg.version;
    if (!latest) return;

    const current = metadata.version;
    if (latest !== current && compareVersions(latest, current) > 0) {
      const msg = `OpenGauge update available: ${current} → ${latest}. Run: openclaw plugins install @opengauge/openclaw-plugin`;
      if (logger) {
        logger.warn(msg);
      } else {
        console.warn(`[opengauge] ${msg}`);
      }
    }
  } catch {
    // Non-blocking — never fail on update check
  }
}

/**
 * Simple semver comparison. Returns >0 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Plugin metadata for OpenClaw's plugin system.
 */
export const metadata = {
  name: '@opengauge/openclaw-plugin',
  npm: '@opengauge/openclaw-plugin',
  version: '0.1.6',
  description: 'Cost tracking, runaway loop detection, and budget enforcement for OpenClaw agents',
  author: 'OpenGauge',
};
