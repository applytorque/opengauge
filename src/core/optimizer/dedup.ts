/**
 * Semantic Deduplication — Stage 2 of the Token Optimizer Pipeline
 *
 * Detects near-duplicate messages via cosine similarity on embeddings.
 * Redundant turns are merged or dropped, keeping only the most
 * recent/complete version.
 */

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

export interface DedupMessage {
  id: string;
  role: string;
  content: string;
  embedding?: Float32Array;
  created_at: number;
}

export interface DedupResult {
  kept: DedupMessage[];
  removed: DedupMessage[];
  duplicateGroups: Array<{ kept: string; removed: string[] }>;
}

/**
 * Deduplicate messages by semantic similarity.
 *
 * @param messages - Messages with optional embeddings.
 * @param threshold - Cosine similarity threshold (0-1). Above this = duplicate. Default 0.85.
 * @returns Deduplicated message list, preferring more recent/longer messages.
 */
export function deduplicateMessages(
  messages: DedupMessage[],
  threshold: number = 0.85
): DedupResult {
  const kept: DedupMessage[] = [];
  const removed: DedupMessage[] = [];
  const duplicateGroups: Array<{ kept: string; removed: string[] }> = [];

  // Process messages in reverse chronological order (newest first)
  const sorted = [...messages].sort((a, b) => b.created_at - a.created_at);

  for (const msg of sorted) {
    // System messages are never deduplicated
    if (msg.role === 'system') {
      kept.push(msg);
      continue;
    }

    // Without embeddings, check exact/near-exact text match
    if (!msg.embedding) {
      const isDuplicate = kept.some(
        (k) =>
          k.role === msg.role &&
          (k.content === msg.content ||
            normalizeText(k.content) === normalizeText(msg.content))
      );

      if (isDuplicate) {
        removed.push(msg);
      } else {
        kept.push(msg);
      }
      continue;
    }

    // With embeddings, use cosine similarity
    let bestMatch: DedupMessage | null = null;
    let bestSimilarity = 0;

    for (const k of kept) {
      if (k.role !== msg.role || !k.embedding) continue;

      const similarity = cosineSimilarity(msg.embedding, k.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = k;
      }
    }

    if (bestMatch && bestSimilarity >= threshold) {
      removed.push(msg);
      // Track the group
      const existingGroup = duplicateGroups.find((g) => g.kept === bestMatch!.id);
      if (existingGroup) {
        existingGroup.removed.push(msg.id);
      } else {
        duplicateGroups.push({ kept: bestMatch.id, removed: [msg.id] });
      }
    } else {
      kept.push(msg);
    }
  }

  // Restore chronological order for kept messages
  kept.sort((a, b) => a.created_at - b.created_at);

  return { kept, removed, duplicateGroups };
}

/**
 * Simple text normalization for near-exact matching.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

/**
 * Text-only deduplication without embeddings.
 * Uses normalized text comparison and Jaccard similarity.
 */
export function deduplicateByText(
  messages: Array<{ id: string; role: string; content: string; created_at: number }>,
  jaccardThreshold: number = 0.7
): { kept: typeof messages; removed: typeof messages } {
  const kept: typeof messages = [];
  const removed: typeof messages = [];

  // Process newest first
  const sorted = [...messages].sort((a, b) => b.created_at - a.created_at);

  for (const msg of sorted) {
    if (msg.role === 'system') {
      kept.push(msg);
      continue;
    }

    const isDuplicate = kept.some((k) => {
      if (k.role !== msg.role) return false;
      const sim = jaccardSimilarity(msg.content, k.content);
      return sim >= jaccardThreshold;
    });

    if (isDuplicate) {
      removed.push(msg);
    } else {
      kept.push(msg);
    }
  }

  kept.sort((a, b) => a.created_at - b.created_at);
  return { kept, removed };
}

/**
 * Compute Jaccard similarity between two texts based on word sets.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeText(a).split(' '));
  const setB = new Set(normalizeText(b).split(' '));

  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}
