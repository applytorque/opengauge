/**
 * Conversation Checkpointing — Stage 3 of the Token Optimizer Pipeline
 *
 * At configurable intervals, older conversation history is summarized
 * into a compressed checkpoint using the active LLM. Recent turns remain
 * verbatim. The checkpoint replaces raw history in the context window.
 * Original messages are preserved in the database.
 */

import { LLMProvider, ChatMessage } from '../providers/adapter';

export interface CheckpointConfig {
  /** Number of turns between checkpoints. Default: 20 */
  interval: number;
  /** Number of recent turns to keep verbatim. Default: 10 */
  keepRecent: number;
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  interval: 20,
  keepRecent: 10,
};

/**
 * Determine if a checkpoint should be generated.
 */
export function shouldCheckpoint(
  messageCount: number,
  lastCheckpointMessageCount: number,
  config: CheckpointConfig = DEFAULT_CHECKPOINT_CONFIG
): boolean {
  return messageCount - lastCheckpointMessageCount >= config.interval;
}

/**
 * Generate a checkpoint summary using the LLM.
 *
 * @param messages - The messages to summarize.
 * @param provider - The LLM provider to use for summarization.
 * @param model - The model to use.
 * @returns Summary text.
 */
export async function generateCheckpointSummary(
  messages: ChatMessage[],
  provider: LLMProvider,
  model: string
): Promise<string> {
  const conversationText = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const summaryRequest: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a conversation summarizer. Create a concise but comprehensive summary of the following conversation. Preserve key facts, decisions, code snippets, and context that would be important for continuing the conversation. Focus on:
1. Main topics discussed
2. Key decisions made
3. Important code or technical details
4. Any unresolved questions or pending tasks
5. The user's goals and preferences

Keep the summary under 500 words. Use bullet points for clarity.`,
    },
    {
      role: 'user',
      content: `Summarize this conversation:\n\n${conversationText}`,
    },
  ];

  const response = await provider.chat({
    messages: summaryRequest,
    model,
    maxTokens: 1024,
    temperature: 0.3,
  });

  return response.content;
}

/**
 * Apply checkpointing to a message list for context assembly.
 *
 * Returns a modified message list where older messages are replaced
 * with the checkpoint summary, and recent messages are kept verbatim.
 */
export function applyCheckpoint(
  allMessages: ChatMessage[],
  checkpointSummary: string | null,
  keepRecent: number = DEFAULT_CHECKPOINT_CONFIG.keepRecent
): ChatMessage[] {
  if (!checkpointSummary || allMessages.length <= keepRecent) {
    return allMessages;
  }

  const systemMessages = allMessages.filter((m) => m.role === 'system');
  const nonSystemMessages = allMessages.filter((m) => m.role !== 'system');

  const recentMessages = nonSystemMessages.slice(-keepRecent);

  const checkpointMessage: ChatMessage = {
    role: 'system',
    content: `[Conversation Summary]\nThe following is a summary of the earlier part of this conversation:\n\n${checkpointSummary}\n\n[End of Summary — Recent messages follow]`,
  };

  return [...systemMessages, checkpointMessage, ...recentMessages];
}
