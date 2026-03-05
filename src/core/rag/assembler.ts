/**
 * Context Assembler — Builds the optimal context window for LLM requests
 *
 * Combines:
 * 1. System prompt
 * 2. Retrieved relevant context (RAG)
 * 3. Last N verbatim turns
 * 4. Compressed checkpoint (if exists)
 *
 * Applies token budget to ensure we fit within the model's context window.
 */

import { ChatMessage } from '../providers/adapter';
import { Queries } from '../../db/queries';
import { retrieveSimilar, RetrievedMessage } from './retriever';
import { compressPrompt, compressMessages } from '../optimizer/compressor';
import { deduplicateByText } from '../optimizer/dedup';

export interface AssemblerConfig {
  /** Maximum tokens for the context window. Default: 8000 */
  maxContextTokens: number;
  /** Tokens reserved for the model's response. Default: 2000 */
  responseReserve: number;
  /** Number of recent messages to keep verbatim. Default: 10 */
  recentMessageCount: number;
  /** Number of RAG results to retrieve. Default: 15 */
  ragTopK: number;
  /** Compression aggressiveness (0-1). Default: 0.3 */
  compressionLevel: number;
  /** Desired savings percentage against raw prompt tokens. Default: 50 */
  targetSavingsPercent: number;
  /** Minimum token budget to preserve quality/context intelligence. Default: 320 */
  qualityFloorTokens: number;
}

export const DEFAULT_ASSEMBLER_CONFIG: AssemblerConfig = {
  maxContextTokens: 8000,
  responseReserve: 2000,
  recentMessageCount: 6,
  ragTopK: 15,
  compressionLevel: 0.3,
  targetSavingsPercent: 50,
  qualityFloorTokens: 320,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/**
 * Assemble the context window for an LLM request.
 *
 * @param userMessage - The current user message.
 * @param conversationId - The conversation ID.
 * @param systemPrompt - The system prompt.
 * @param queries - Database queries instance.
 * @param checkpointSummary - Latest checkpoint summary, if any.
 * @param config - Assembler configuration.
 */
export async function assembleContext(
  userMessage: string,
  conversationId: string,
  systemPrompt: string | null,
  queries: Queries,
  checkpointSummary: string | null,
  config: AssemblerConfig = DEFAULT_ASSEMBLER_CONFIG
): Promise<{
  messages: ChatMessage[];
  tokensRaw: number;
  tokensSent: number;
  ragResultCount: number;
}> {
  const tokenBudget = config.maxContextTokens - config.responseReserve;
  let tokensUsed = 0;
  let tokensRaw = 0;
  const assembled: ChatMessage[] = [];

  // 1. System prompt (always included)
  if (systemPrompt) {
    const sysTokens = estimateTokens(systemPrompt);
    assembled.push({ role: 'system', content: systemPrompt });
    tokensUsed += sysTokens;
    tokensRaw += sysTokens;
  }

  // 2. Checkpoint summary (if exists)
  if (checkpointSummary) {
    const cpTokens = estimateTokens(checkpointSummary);
    assembled.push({
      role: 'system',
      content: `[Conversation Summary]\n${checkpointSummary}\n[End Summary]`,
    });
    tokensUsed += cpTokens;
    tokensRaw += cpTokens;
  }

  // 3. Retrieve relevant past context via RAG
  let ragResults: RetrievedMessage[] = [];
  try {
    ragResults = await retrieveSimilar(
      userMessage,
      conversationId,
      queries,
      config.ragTopK
    );
  } catch {
    // RAG may not be available
  }

  // 4. Get all messages and calculate raw token count
  const allMessages = queries.getMessages(conversationId);
  for (const msg of allMessages) {
    tokensRaw += estimateTokens(msg.content);
  }

  const historyAlreadyHasCurrentUser =
    allMessages.length > 0 &&
    allMessages[allMessages.length - 1].role === 'user' &&
    allMessages[allMessages.length - 1].content.trim() === userMessage.trim();

  if (!historyAlreadyHasCurrentUser) {
    tokensRaw += estimateTokens(userMessage);
  }

  const targetSentBySavings = Math.floor(
    tokensRaw * (1 - Math.min(95, Math.max(0, config.targetSavingsPercent)) / 100)
  );

  const effectiveBudget = Math.min(
    tokenBudget,
    Math.max(config.qualityFloorTokens, targetSentBySavings)
  );

  // 5. Deduplicate messages (Stage 2 of optimizer pipeline)
  const dedupResult = deduplicateByText(
    allMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
    0.7
  );
  const dedupedMessages = dedupResult.kept;
  const latestHistoryMessage = dedupedMessages[dedupedMessages.length - 1];
  const hasCurrentUserInHistory =
    latestHistoryMessage?.role === 'user' &&
    latestHistoryMessage?.content.trim() === userMessage.trim();

  // Split into recent (verbatim) and older (compressible)
  const verbatimCount = Math.min(2, config.recentMessageCount);
  const recentMessages = dedupedMessages.slice(-verbatimCount);
  const olderMessages = dedupedMessages.slice(0, -verbatimCount || undefined);
  const recentIds = new Set(recentMessages.map((m) => m.id));

  // 6. Compress older messages (Stage 1 of optimizer pipeline)
  const compressedOlder = compressMessages(
    olderMessages.map((m) => ({ role: m.role, content: m.content })),
    0, // don't preserve any recent within this set — they're already separated
    config.compressionLevel
  );

  // 7. Add RAG results (that aren't already in recent or older messages)
  const ragTokenBudget = Math.floor((effectiveBudget - tokensUsed) * 0.2);
  let ragTokensUsed = 0;
  const allKeptIds = new Set([...recentIds, ...olderMessages.map((m) => m.id)]);

  if (ragResults.length > 0) {
    const relevantRag = ragResults.filter((r) => !allKeptIds.has(r.id));

    if (relevantRag.length > 0) {
      const ragContextParts: string[] = [];

      for (const rag of relevantRag) {
        const compressed = compressPrompt(rag.content, config.compressionLevel);
        const tokens = estimateTokens(compressed.compressed);

        if (ragTokensUsed + tokens <= ragTokenBudget) {
          ragContextParts.push(`[${rag.role}]: ${compressed.compressed}`);
          ragTokensUsed += tokens;
        }
      }

      if (ragContextParts.length > 0) {
        assembled.push({
          role: 'system',
          content: `[Relevant Earlier Context]\n${ragContextParts.join('\n')}\n[End Context]`,
        });
        tokensUsed += ragTokensUsed;
      }
    }
  }

  // 8. Add compressed older messages
  const olderBudget = Math.floor((effectiveBudget - tokensUsed) * 0.45);
  let olderTokensUsed = 0;

  for (const msg of compressedOlder) {
    const tokens = estimateTokens(msg.content);
    if (olderTokensUsed + tokens <= olderBudget) {
      assembled.push({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      });
      olderTokensUsed += tokens;
    }
  }
  tokensUsed += olderTokensUsed;

  // 9. Add recent messages (adaptive compression in aggressive mode)
  const remainingBudget = effectiveBudget - tokensUsed;
  let recentTokensUsed = 0;
  const aggressiveMode = config.targetSavingsPercent >= 70;

  for (let index = 0; index < recentMessages.length; index++) {
    const msg = recentMessages[index];
    const isNewestHistoryMessage = index === recentMessages.length - 1;

    // Preserve newest user message from history verbatim for intent fidelity.
    const shouldPreserveVerbatim =
      msg.role === 'system' || (isNewestHistoryMessage && msg.role === 'user');

    let candidateContent = msg.content;
    if (!shouldPreserveVerbatim && aggressiveMode && msg.role === 'assistant') {
      candidateContent = compressPrompt(
        msg.content,
        Math.min(0.95, config.compressionLevel + 0.1)
      ).compressed;
    }

    const tokens = estimateTokens(candidateContent);
    if (recentTokensUsed + tokens <= remainingBudget) {
      assembled.push({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: candidateContent,
      });
      recentTokensUsed += tokens;
    }
  }
  tokensUsed += recentTokensUsed;

  // 10. Add the current user message if not already included from history
  if (!hasCurrentUserInHistory) {
    assembled.push({ role: 'user', content: userMessage });
    tokensUsed += estimateTokens(userMessage);
    tokensRaw += estimateTokens(userMessage);
  }

  return {
    messages: assembled,
    tokensRaw,
    tokensSent: tokensUsed,
    ragResultCount: ragResults.filter((r) => !allKeptIds.has(r.id)).length,
  };
}
