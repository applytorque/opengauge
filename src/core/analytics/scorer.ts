import { compressPrompt } from '../optimizer/compressor';

export interface PromptScoreBreakdown {
  specificity: number;
  goal_clarity: number;
  constraints: number;
  context_completeness: number;
  structure: number;
  penalties: number;
  total: number;
}

export interface DuplicateSignal {
  clusterId: string | null;
  similarity: number;
  isDuplicate: boolean;
  repeatCount: number;
}

export interface PromptAnalyticsResult {
  scores: PromptScoreBreakdown;
  duplicate: DuplicateSignal;
  promptTokensRaw: number;
  promptTokensSent: number;
  retryTurn: boolean;
  repairTurn: boolean;
}

export interface PromptImprovementResult {
  originalPrompt: string;
  improvedPrompt: string;
  before: PromptAnalyticsResult;
  after: PromptAnalyticsResult;
  benefit: {
    clarityDelta: number;
    duplicateRiskDelta: number;
    tokenSentDelta: number;
    scoreDelta: number;
  };
}

function estimateTokens(text: string): number {
  return Math.ceil((text || '').split(/\s+/).filter(Boolean).length * 1.3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text: string): Set<string> {
  const normalized = normalize(text);
  const set = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aSet = bigrams(a);
  const bSet = bigrams(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection++;
  }

  return (2 * intersection) / (aSet.size + bSet.size);
}

function includesAny(text: string, words: string[]): boolean {
  const normalized = normalize(text);
  return words.some((word) => normalized.includes(word));
}

function scoreSpecificity(prompt: string): number {
  const wordCount = normalize(prompt).split(' ').filter(Boolean).length;
  const longTerms = (prompt.match(/\b[A-Za-z0-9]{7,}\b/g) || []).length;
  const score = Math.min(18, Math.floor(wordCount / 3)) + Math.min(7, longTerms);
  return clamp(score, 0, 25);
}

function scoreGoalClarity(prompt: string): number {
  const verbs = [
    'summarize', 'explain', 'compare', 'draft', 'write', 'analyze', 'review',
    'create', 'generate', 'fix', 'debug', 'refactor', 'list', 'translate', 'plan'
  ];
  const hasVerb = includesAny(prompt, verbs);
  const hasQuestion = prompt.includes('?');
  const hasTarget = includesAny(prompt, ['for ', 'to ', 'about ', 'using ', 'from ']);
  return clamp((hasVerb ? 10 : 3) + (hasQuestion ? 5 : 2) + (hasTarget ? 5 : 2), 0, 20);
}

function scoreConstraints(prompt: string): number {
  const constraints = [
    'bullet', 'table', 'json', 'steps', 'short', 'concise', 'detailed', 'tone',
    'max', 'min', 'words', 'lines', 'deadline', 'audience', 'format', 'example'
  ];
  const hits = constraints.reduce((count, key) => count + (normalize(prompt).includes(key) ? 1 : 0), 0);
  return clamp(hits * 4, 0, 20);
}

function scoreContextCompleteness(prompt: string, hasAttachments: boolean, attachmentTextExtracted: boolean): number {
  const hasBackground = includesAny(prompt, ['because', 'context', 'background', 'project', 'repo', 'file']);
  const hasReference = includesAny(prompt, ['this', 'that', 'attached', 'screenshot', 'pdf', 'image']);

  let score = 6;
  if (hasBackground) score += 7;
  if (hasReference) score += 3;
  if (hasAttachments && attachmentTextExtracted) score += 4;

  return clamp(score, 0, 20);
}

function scoreStructure(prompt: string): number {
  const hasNewLines = (prompt.match(/\n/g) || []).length >= 2;
  const hasOrdered = /(^|\n)\s*(\d+\.|-|\*)\s+/.test(prompt);
  const hasSections = /[:\n]/.test(prompt);
  const compactnessPenalty = prompt.length > 1800 ? 3 : 0;

  const base = (hasNewLines ? 6 : 3) + (hasOrdered ? 5 : 2) + (hasSections ? 4 : 2) - compactnessPenalty;
  return clamp(base, 0, 15);
}

function computePenalties(prompt: string, duplicateSim: number, hasReference: boolean, hasAttachments: boolean, attachmentTextExtracted: boolean): number {
  let penalties = 0;
  const normalized = normalize(prompt);

  if (normalized.length < 16 || ['hey', 'ok', 'nothing else', 'do it', 'continue'].includes(normalized)) {
    penalties += 12;
  }

  if (duplicateSim >= 0.92) {
    penalties += 15;
  }

  const hasConflict = includesAny(prompt, ['short and detailed', 'brief and exhaustive', 'do not explain and explain']);
  if (hasConflict) {
    penalties += 10;
  }

  if (hasReference && hasAttachments && !attachmentTextExtracted) {
    penalties += 15;
  }

  return clamp(penalties, 0, 35);
}

export function analyzePrompt(
  prompt: string,
  previousUserPrompts: Array<{ content: string; clusterId?: string | null }>,
  opts?: {
    hasAttachments?: boolean;
    attachmentTextExtracted?: boolean;
    suggestedClusterId?: string | null;
  }
): PromptAnalyticsResult {
  const hasAttachments = Boolean(opts?.hasAttachments);
  const attachmentTextExtracted = Boolean(opts?.attachmentTextExtracted);

  let bestSimilarity = 0;
  let bestClusterId: string | null = opts?.suggestedClusterId || null;
  let repeatCount = 0;

  for (const previous of previousUserPrompts) {
    const sim = similarity(prompt, previous.content);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestClusterId = previous.clusterId || bestClusterId;
    }
    if (sim >= 0.92) repeatCount += 1;
  }

  const isDuplicate = bestSimilarity >= 0.92;
  const duplicateSignal: DuplicateSignal = {
    clusterId: isDuplicate ? bestClusterId : null,
    similarity: Number(bestSimilarity.toFixed(4)),
    isDuplicate,
    repeatCount,
  };

  const specificity = scoreSpecificity(prompt);
  const goalClarity = scoreGoalClarity(prompt);
  const constraints = scoreConstraints(prompt);
  const contextCompleteness = scoreContextCompleteness(prompt, hasAttachments, attachmentTextExtracted);
  const structure = scoreStructure(prompt);

  const hasReference = includesAny(prompt, ['attached', 'this image', 'this screenshot', 'this pdf', 'what is this', 'explain this']);
  const penalties = computePenalties(prompt, bestSimilarity, hasReference, hasAttachments, attachmentTextExtracted);

  const total = clamp(
    specificity + goalClarity + constraints + contextCompleteness + structure - penalties,
    0,
    100
  );

  const compressed = compressPrompt(prompt, 0.55).compressed;
  const promptTokensRaw = estimateTokens(prompt);
  const promptTokensSent = estimateTokens(compressed);

  const retryTurn = bestSimilarity >= 0.72;
  const repairTurn = includesAny(prompt, ['not this', 'wrong', 'again', 'retry', 'fix', "didn't", 'doesnt', "doesn't"]);

  return {
    scores: {
      specificity,
      goal_clarity: goalClarity,
      constraints,
      context_completeness: contextCompleteness,
      structure,
      penalties,
      total,
    },
    duplicate: duplicateSignal,
    promptTokensRaw,
    promptTokensSent,
    retryTurn,
    repairTurn,
  };
}

function deriveGoal(prompt: string): string {
  const trimmed = (prompt || '').trim();
  if (!trimmed) return 'Help with the request';

  if (/\?$/.test(trimmed) || trimmed.toLowerCase().startsWith('what') || trimmed.toLowerCase().startsWith('how')) {
    return `Answer this clearly: ${trimmed}`;
  }

  return `Complete this request: ${trimmed}`;
}

function refinePromptHeuristically(prompt: string): string {
  const trimmed = (prompt || '').trim();
  if (!trimmed) return '';

  const normalized = normalize(trimmed);
  const shortAmbiguous = normalized.length < 24 || ['ok', 'hey', 'do it', 'continue', 'nothing else'].includes(normalized);

  const keepClean = (text: string) => text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (shortAmbiguous) {
    return keepClean([
      deriveGoal(trimmed),
      'Focus on practical examples and keep the answer concise.',
      'Output as 3-5 bullet points with key takeaways only.',
    ].join('\n'));
  }

  const hasConstraints = includesAny(trimmed, ['format', 'bullet', 'json', 'short', 'concise', 'steps', 'table']);
  const hasContextMarker = includesAny(trimmed, ['context', 'background', 'attached', 'file', 'screenshot', 'pdf']);

  const lines: string[] = [deriveGoal(trimmed)];
  if (!hasContextMarker) {
    lines.push('Include relevant context from earlier discussion when useful.');
  }
  if (!hasConstraints) {
    lines.push('Constraints: keep it concise, avoid fluff, and focus on practical output');
  }
  lines.push('Output format: short bullet list + next steps');

  return keepClean(lines.join('\n'));
}

export function buildPromptImprovementResult(
  originalPrompt: string,
  improvedPrompt: string,
  previousUserPrompts: Array<{ content: string; clusterId?: string | null }>,
  opts?: {
    hasAttachments?: boolean;
    attachmentTextExtracted?: boolean;
  }
): PromptImprovementResult {
  const before = analyzePrompt(originalPrompt, previousUserPrompts, opts);
  const after = analyzePrompt(improvedPrompt, previousUserPrompts, opts);

  return {
    originalPrompt,
    improvedPrompt,
    before,
    after,
    benefit: {
      clarityDelta: (after.scores.goal_clarity + after.scores.context_completeness) -
        (before.scores.goal_clarity + before.scores.context_completeness),
      duplicateRiskDelta: before.duplicate.similarity - after.duplicate.similarity,
      tokenSentDelta: before.promptTokensSent - after.promptTokensSent,
      scoreDelta: after.scores.total - before.scores.total,
    },
  };
}

export function improvePrompt(
  prompt: string,
  previousUserPrompts: Array<{ content: string; clusterId?: string | null }>,
  opts?: {
    hasAttachments?: boolean;
    attachmentTextExtracted?: boolean;
  }
): PromptImprovementResult {
  const improvedPrompt = refinePromptHeuristically(prompt);
  return buildPromptImprovementResult(prompt, improvedPrompt, previousUserPrompts, opts);
}
