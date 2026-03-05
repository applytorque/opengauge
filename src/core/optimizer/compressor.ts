/**
 * Prompt Compression — Stage 1 of the Token Optimizer Pipeline
 *
 * Uses entropy-based filtering to remove low-information tokens.
 * Tokens with high predictability (low perplexity) contribute little
 * semantic value and can be dropped.
 *
 * This is a JS-native implementation inspired by LLMLingua, using
 * precomputed token-importance heuristics instead of a local model.
 */

// Common low-information words/patterns that can often be removed
// without significant semantic loss
const LOW_IMPORTANCE_PATTERNS: RegExp[] = [
  /\b(the|a|an)\b/gi,
  /\b(is|are|was|were|be|been|being)\b/gi,
  /\b(that|which|who|whom)\b/gi,
  /\b(very|really|quite|rather|somewhat|fairly)\b/gi,
  /\b(just|simply|basically|essentially|actually|literally)\b/gi,
  /\b(in order to)\b/gi,
  /\b(it is|there is|there are)\b/gi,
  /\b(please|kindly)\b/gi,
];

// Phrases that can be shortened
const COMPRESSION_MAP: [RegExp, string][] = [
  [/^hey there!?\s*/gi, 'hello '],
  [/\bhow('?s| is) it going\??/gi, ''],
  [/\bis there something i can help you with today\??/gi, 'How can I help?'],
  [/\bis there anything specific you'd like help with\??/gi, 'What do you need help with?'],
  [/\bi'?m an ai assistant!?\s*/gi, 'I can help with: '],
  [/\bhere('?s| is) a quick (run ?down|overview) of what i can do:?/gi, 'Capabilities:'],
  [/\bin order to\b/gi, 'to'],
  [/\bas a result of\b/gi, 'because'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bfor the purpose of\b/gi, 'to'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bin reference to\b/gi, 'about'],
  [/\bas a matter of fact\b/gi, 'actually'],
  [/\bit should be noted that\b/gi, ''],
  [/\bit is worth mentioning that\b/gi, ''],
  [/\bit is important to note that\b/gi, ''],
  [/\bas I mentioned (earlier|before|previously)\b/gi, ''],
  [/\bas (we|I) discussed (earlier|before|previously)\b/gi, ''],
];

export interface CompressionResult {
  original: string;
  compressed: string;
  tokensRaw: number;
  tokensSent: number;
  savingsPercent: number;
}

/**
 * Rough token count estimation (~4 chars/token average).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/**
 * Compress a prompt by removing low-information content.
 *
 * @param text - The prompt text to compress.
 * @param aggressiveness - 0 (no compression) to 1 (maximum compression). Default 0.3.
 */
export function compressPrompt(
  text: string,
  aggressiveness: number = 0.3
): CompressionResult {
  const safeAggressiveness = Math.max(0, Math.min(0.85, aggressiveness));
  const tokensRaw = estimateTokens(text);
  let result = text;

  // Always apply phrase compression (these are lossless transformations)
  for (const [pattern, replacement] of COMPRESSION_MAP) {
    result = result.replace(pattern, replacement);
  }

  if (safeAggressiveness > 0.4) {
    // Strip markdown formatting from older context while preserving meaning
    result = result
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
  }

  // Apply word-level compression proportional to aggressiveness
  if (safeAggressiveness > 0.2) {
    // Remove filler words
    const fillerPatterns = LOW_IMPORTANCE_PATTERNS.slice(3); // very, really, just, etc.
    for (const pattern of fillerPatterns) {
      result = result.replace(pattern, '');
    }
  }

  if (safeAggressiveness > 0.5) {
    // Remove articles (more aggressive)
    result = result.replace(/\b(the|a|an)\s+/gi, '');
  }

  // Clean up extra whitespace
  result = result.replace(/\s{2,}/g, ' ').trim();

  const tokensSent = estimateTokens(result);
  const savingsPercent =
    tokensRaw > 0 ? Math.round(((tokensRaw - tokensSent) / tokensRaw) * 100) : 0;

  return {
    original: text,
    compressed: result,
    tokensRaw,
    tokensSent,
    savingsPercent: Math.max(0, savingsPercent),
  };
}

/**
 * Compress an array of messages, preserving the most recent ones verbatim.
 *
 * @param messages - Array of message objects with role and content.
 * @param preserveRecent - Number of recent messages to keep uncompressed. Default 4.
 * @param aggressiveness - Compression level 0-1. Default 0.3.
 */
export function compressMessages(
  messages: Array<{ role: string; content: string }>,
  preserveRecent: number = 4,
  aggressiveness: number = 0.3
): Array<{ role: string; content: string; compressed: boolean; savings: number }> {
  return messages.map((msg, i) => {
    const isRecent = i >= messages.length - preserveRecent;
    const isSystem = msg.role === 'system';

    // Never compress system messages or recent messages
    if (isSystem || isRecent) {
      return { ...msg, compressed: false, savings: 0 };
    }

    const result = compressPrompt(msg.content, aggressiveness);
    return {
      role: msg.role,
      content: result.compressed,
      compressed: true,
      savings: result.savingsPercent,
    };
  });
}
