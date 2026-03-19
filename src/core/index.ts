/**
 * @opengauge/core
 *
 * Standalone SDK for PromptOps observability and optimization.
 * Three modules that work without a server running:
 *
 *   1. Database layer — write/read interactions via SQLite
 *   2. Cost calculator — model pricing profiles and dollar estimates
 *   3. Circuit breaker — detect runaway agent loops via trigram Jaccard similarity
 *   4. Insights engine — context degradation, cost anomaly, stale context detection
 */

// ---- Database layer ----
export { getDb, getDbPath, closeDb } from '../db';
export { initSchema } from '../db/schema';
export {
  Queries,
  type Conversation,
  type Message,
  type TokenUsage,
  type Checkpoint,
  type StoredFile,
  type FileChunk,
  type PromptAnalyticsRecord,
  type PromptImprovementRecord,
} from '../db/queries';
export {
  SessionQueries,
  type SessionRecord,
  type InteractionRecord,
  type AlertRecord,
  type ModelProfileRecord,
  type SessionFilters,
  type AlertFilters,
  type SpendSummary,
  type ModelUsage,
} from '../db/session-queries';

// ---- Cost calculator ----
export {
  calculateCost,
  getModelProfile,
  registerModelProfile,
  listModelProfiles,
  type ModelProfile,
  type CostEstimate,
} from './cost';

// ---- Circuit breaker ----
export {
  checkRunawayLoop,
  trigramJaccard,
  type Interaction,
  type Verdict,
  type CircuitBreakerResult,
  type CircuitBreakerConfig,
} from './circuit-breaker';

// ---- Insights engine ----
export {
  analyzeSession,
  detectDegradation,
  detectCostAnomaly,
  detectStaleContext,
  detectRunawayLoop,
  type InsightResult,
  type DegradationScore,
} from './insights';
