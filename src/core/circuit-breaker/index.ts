/**
 * @opengauge/core — Circuit Breaker
 *
 * Detects runaway loops in LLM agent interactions using trigram Jaccard similarity.
 * Pure functions — takes an array of recent interactions and returns a verdict.
 * No DB dependency at call time.
 */

export interface Interaction {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;  // epoch ms, optional but useful for time-window checks
}

export type Verdict = 'ok' | 'warning' | 'trip';

export interface CircuitBreakerResult {
  verdict: Verdict;
  reason: string;
  /** Highest pairwise similarity found among recent interactions */
  peakSimilarity: number;
  /** Number of near-duplicate pairs detected */
  duplicatePairCount: number;
  /** Cluster size of the largest group of similar messages */
  largestClusterSize: number;
}

export interface CircuitBreakerConfig {
  /** Similarity threshold to consider two messages near-duplicates (0-1). Default: 0.85 */
  similarityThreshold?: number;
  /** Number of duplicate pairs that triggers a warning. Default: 3 */
  warningPairCount?: number;
  /** Number of duplicate pairs that trips the breaker. Default: 6 */
  tripPairCount?: number;
  /** Minimum cluster size to trip. Default: 4 */
  tripClusterSize?: number;
  /** Only consider messages within this time window (ms). 0 = no limit. Default: 0 */
  timeWindowMs?: number;
  /** Only analyze assistant messages (typical for runaway agent detection). Default: false */
  assistantOnly?: boolean;
}

const DEFAULTS: Required<CircuitBreakerConfig> = {
  similarityThreshold: 0.85,
  warningPairCount: 3,
  tripPairCount: 6,
  tripClusterSize: 4,
  timeWindowMs: 0,
  assistantOnly: false,
};

// ---- Trigram utilities ----

function extractTrigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const trigrams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Jaccard similarity between two trigram sets: |A ∩ B| / |A ∪ B|
 */
function trigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;

  const setA = extractTrigrams(a);
  const setB = extractTrigrams(b);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const trigram of setA) {
    if (setB.has(trigram)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---- Union-Find for clustering ----

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
  }

  largestCluster(): number {
    const counts = new Map<number, number>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      counts.set(root, (counts.get(root) || 0) + 1);
    }
    let max = 0;
    for (const count of counts.values()) {
      if (count > max) max = count;
    }
    return max;
  }
}

// ---- Core detection ----

/**
 * Check a sequence of recent interactions for runaway loop patterns.
 *
 * Pure function — no side effects, no DB access.
 * Pass in the most recent N interactions (e.g. last 20-50 messages from an agent session).
 */
export function checkRunawayLoop(
  recentInteractions: Interaction[],
  config?: CircuitBreakerConfig
): CircuitBreakerResult {
  const cfg = { ...DEFAULTS, ...config };

  // Filter by time window if configured
  let interactions = recentInteractions;
  if (cfg.timeWindowMs > 0) {
    const cutoff = Date.now() - cfg.timeWindowMs;
    interactions = interactions.filter((i) => !i.timestamp || i.timestamp >= cutoff);
  }

  // Optionally filter to assistant-only
  if (cfg.assistantOnly) {
    interactions = interactions.filter((i) => i.role === 'assistant');
  }

  // Skip trivially small content
  const contents = interactions
    .map((i) => i.content)
    .filter((c) => c.trim().length > 10);

  if (contents.length < 2) {
    return {
      verdict: 'ok',
      reason: 'Too few interactions to evaluate',
      peakSimilarity: 0,
      duplicatePairCount: 0,
      largestClusterSize: contents.length,
    };
  }

  // Pairwise similarity — O(n²) but n is capped (recent interactions only)
  const uf = new UnionFind(contents.length);
  let peakSimilarity = 0;
  let duplicatePairCount = 0;

  for (let i = 0; i < contents.length; i++) {
    for (let j = i + 1; j < contents.length; j++) {
      const sim = trigramJaccard(contents[i], contents[j]);
      if (sim > peakSimilarity) peakSimilarity = sim;

      if (sim >= cfg.similarityThreshold) {
        duplicatePairCount++;
        uf.union(i, j);
      }
    }
  }

  const largestClusterSize = uf.largestCluster();

  // Determine verdict
  let verdict: Verdict = 'ok';
  let reason = 'No runaway pattern detected';

  if (
    duplicatePairCount >= cfg.tripPairCount ||
    largestClusterSize >= cfg.tripClusterSize
  ) {
    verdict = 'trip';
    reason =
      `Runaway loop detected: ${duplicatePairCount} duplicate pairs, ` +
      `largest cluster of ${largestClusterSize} similar messages ` +
      `(peak similarity: ${peakSimilarity.toFixed(3)})`;
  } else if (duplicatePairCount >= cfg.warningPairCount) {
    verdict = 'warning';
    reason =
      `Potential loop forming: ${duplicatePairCount} duplicate pairs ` +
      `(peak similarity: ${peakSimilarity.toFixed(3)})`;
  }

  return {
    verdict,
    reason,
    peakSimilarity: Number(peakSimilarity.toFixed(4)),
    duplicatePairCount,
    largestClusterSize,
  };
}

// Re-export trigram Jaccard for external use (testing, custom analysis)
export { trigramJaccard };
