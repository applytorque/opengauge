/**
 * @opengauge/core — Passive Insights Engine
 *
 * Analyzes logged sessions to surface actionable alerts:
 *   - Context degradation detection
 *   - Runaway loop detection (post-hoc, complements real-time circuit breaker)
 *   - Cost anomaly detection
 *   - Stale context detection
 *
 * All functions are pure — they take data and return insights.
 */

import { type InteractionRecord, type SessionRecord } from '../../db/session-queries';
import { trigramJaccard } from '../circuit-breaker';

// ---- Types ----

export interface InsightResult {
  type: 'degradation' | 'runaway_loop' | 'cost_spike' | 'stale_context';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data: Record<string, any>;
}

export interface DegradationScore {
  score: number;          // 0-1, higher = more degraded
  fillRatio: number;      // context fill ratio
  entropyDecline: number; // response diversity trend (negative = declining)
  repetitionRate: number; // fraction of repeated content
  recommendation: 'OK' | 'SUMMARIZE' | 'RESET_CONTEXT';
}

// ---- Context Degradation Detection ----

/**
 * Measure lexical diversity of a text: unique words / total words.
 */
function lexicalDiversity(text: string): number {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return new Set(words).size / words.length;
}

/**
 * Simple linear regression slope on an array of values.
 */
function linearSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

/**
 * Detect context degradation in a session based on interaction history.
 */
export function detectDegradation(
  interactions: InteractionRecord[],
  maxContextTokens: number = 128000
): DegradationScore {
  if (interactions.length < 3) {
    return { score: 0, fillRatio: 0, entropyDecline: 0, repetitionRate: 0, recommendation: 'OK' };
  }

  // Context fill ratio (use the latest interaction's depth)
  const latest = interactions[interactions.length - 1];
  const fillRatio = maxContextTokens > 0 ? latest.context_depth_tokens / maxContextTokens : 0;

  // Response entropy trend: lexical diversity of assistant responses
  const assistantResponses = interactions
    .filter(i => i.response_text && i.response_text.length > 50)
    .map(i => i.response_text!);

  const diversities = assistantResponses.map(lexicalDiversity);
  const entropySlope = linearSlope(diversities);

  // Repetition rate: how many consecutive response pairs are highly similar
  let similarPairs = 0;
  for (let i = 1; i < assistantResponses.length; i++) {
    if (trigramJaccard(assistantResponses[i - 1], assistantResponses[i]) > 0.7) {
      similarPairs++;
    }
  }
  const repetitionRate = assistantResponses.length > 1
    ? similarPairs / (assistantResponses.length - 1)
    : 0;

  // Composite score
  const score = Math.min(1, (fillRatio * 0.5) + (Math.max(0, -entropySlope * 5) * 0.3) + (repetitionRate * 0.2));

  let recommendation: DegradationScore['recommendation'] = 'OK';
  if (score > 0.7) recommendation = 'RESET_CONTEXT';
  else if (score > 0.4 || fillRatio > 0.7) recommendation = 'SUMMARIZE';

  return {
    score: Number(score.toFixed(4)),
    fillRatio: Number(fillRatio.toFixed(4)),
    entropyDecline: Number(entropySlope.toFixed(6)),
    repetitionRate: Number(repetitionRate.toFixed(4)),
    recommendation,
  };
}

// ---- Cost Anomaly Detection ----

/**
 * Detect cost anomalies by comparing current spend to rolling averages.
 */
export function detectCostAnomaly(
  dailySpend: Array<{ day: string; cost_usd: number }>,
  currentSession?: SessionRecord,
  allSessions?: SessionRecord[]
): InsightResult[] {
  const insights: InsightResult[] = [];

  if (dailySpend.length >= 3) {
    // Rolling 7-day average
    const recentDays = dailySpend.slice(0, Math.min(7, dailySpend.length));
    const avg = recentDays.reduce((s, d) => s + d.cost_usd, 0) / recentDays.length;
    const today = dailySpend[0];

    if (today && avg > 0 && today.cost_usd > avg * 2) {
      insights.push({
        type: 'cost_spike',
        severity: today.cost_usd > avg * 3 ? 'critical' : 'warning',
        message: `Today's spend ($${today.cost_usd.toFixed(2)}) is ${(today.cost_usd / avg).toFixed(1)}x the 7-day average ($${avg.toFixed(2)})`,
        data: { todaySpend: today.cost_usd, avgSpend: avg, multiplier: today.cost_usd / avg },
      });
    }
  }

  // Per-session anomaly: check if current session is unusually expensive
  if (currentSession && allSessions && allSessions.length >= 5) {
    const costs = allSessions.map(s => s.total_cost_usd).sort((a, b) => a - b);
    const p95Idx = Math.floor(costs.length * 0.95);
    const p95 = costs[p95Idx] || 0;

    if (currentSession.total_cost_usd > p95 && p95 > 0) {
      insights.push({
        type: 'cost_spike',
        severity: 'warning',
        message: `Session cost ($${currentSession.total_cost_usd.toFixed(2)}) exceeds the 95th percentile ($${p95.toFixed(2)}) of historical sessions`,
        data: { sessionCost: currentSession.total_cost_usd, p95 },
      });
    }
  }

  return insights;
}

// ---- Stale Context Detection ----

/**
 * Detect stale context by analyzing how much of early context is still referenced.
 */
export function detectStaleContext(
  interactions: InteractionRecord[]
): InsightResult | null {
  if (interactions.length < 6) return null;

  // Split into early (first third) and recent (last third) interactions
  const third = Math.floor(interactions.length / 3);
  const early = interactions.slice(0, third);
  const recent = interactions.slice(-third);

  // Extract key terms from early prompts
  const earlyTerms = new Set<string>();
  for (const i of early) {
    const words = (i.original_prompt || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    for (const w of words) earlyTerms.add(w);
  }

  if (earlyTerms.size === 0) return null;

  // Check how many early terms appear in recent responses
  let referenced = 0;
  const recentText = recent.map(i => (i.response_text || '').toLowerCase()).join(' ');
  for (const term of earlyTerms) {
    if (recentText.includes(term)) referenced++;
  }

  const referenceRatio = referenced / earlyTerms.size;

  if (referenceRatio < 0.1) {
    return {
      type: 'stale_context',
      severity: 'warning',
      message: `Only ${(referenceRatio * 100).toFixed(0)}% of early context terms appear in recent responses. Session may benefit from a summarize-and-reset.`,
      data: { referenceRatio, earlyTermCount: earlyTerms.size, referencedCount: referenced },
    };
  }

  return null;
}

// ---- Post-hoc Runaway Loop Detection ----

/**
 * Analyze a session's interactions for runaway loop patterns (post-hoc analysis).
 */
export function detectRunawayLoop(
  interactions: InteractionRecord[]
): InsightResult | null {
  if (interactions.length < 4) return null;

  const prompts = interactions
    .filter(i => i.original_prompt && i.original_prompt.length > 10)
    .map(i => ({ text: i.original_prompt!, tokens: i.tokens_in }));

  if (prompts.length < 3) return null;

  // Check for consecutive similar prompts with escalating tokens
  let consecutiveSimilar = 0;
  let maxStreak = 0;
  let tokensEscalating = true;
  let streakStartIdx = 0;

  for (let i = 1; i < prompts.length; i++) {
    const sim = trigramJaccard(prompts[i - 1].text, prompts[i].text);
    if (sim > 0.8) {
      if (consecutiveSimilar === 0) streakStartIdx = i - 1;
      consecutiveSimilar++;
      if (prompts[i].tokens <= prompts[i - 1].tokens) {
        tokensEscalating = false;
      }
    } else {
      maxStreak = Math.max(maxStreak, consecutiveSimilar);
      consecutiveSimilar = 0;
      tokensEscalating = true;
    }
  }
  maxStreak = Math.max(maxStreak, consecutiveSimilar);

  if (maxStreak >= 3) {
    const costSinceLoop = interactions
      .slice(streakStartIdx)
      .reduce((sum, i) => sum + i.cost_usd, 0);

    return {
      type: 'runaway_loop',
      severity: maxStreak >= 5 ? 'critical' : 'warning',
      message: `Detected ${maxStreak + 1} consecutive similar prompts${tokensEscalating ? ' with escalating token usage' : ''}. Cost since loop start: $${costSinceLoop.toFixed(4)}`,
      data: { consecutiveCount: maxStreak + 1, tokensEscalating, costSinceLoop },
    };
  }

  return null;
}

// ---- Run All Insights ----

/**
 * Run all insight checks on a session and its interactions.
 */
export function analyzeSession(
  session: SessionRecord,
  interactions: InteractionRecord[],
  opts?: {
    maxContextTokens?: number;
    dailySpend?: Array<{ day: string; cost_usd: number }>;
    allSessions?: SessionRecord[];
  }
): InsightResult[] {
  const results: InsightResult[] = [];

  // Context degradation
  const degradation = detectDegradation(
    interactions,
    opts?.maxContextTokens
  );
  if (degradation.recommendation !== 'OK') {
    results.push({
      type: 'degradation',
      severity: degradation.recommendation === 'RESET_CONTEXT' ? 'critical' : 'warning',
      message: `Context degradation detected (score: ${degradation.score.toFixed(2)}). Recommendation: ${degradation.recommendation}`,
      data: degradation,
    });
  }

  // Runaway loop
  const loop = detectRunawayLoop(interactions);
  if (loop) results.push(loop);

  // Cost anomaly
  if (opts?.dailySpend) {
    results.push(...detectCostAnomaly(opts.dailySpend, session, opts.allSessions));
  }

  // Stale context
  const stale = detectStaleContext(interactions);
  if (stale) results.push(stale);

  return results;
}
