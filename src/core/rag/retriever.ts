/**
 * Retriever — sqlite-vec similarity search for relevant context
 *
 * Queries the embeddings virtual table to find messages most similar
 * to the current query.
 */

import { Queries, Message } from '../../db/queries';
import { embed } from './embedder';
import { cosineSimilarity } from '../optimizer/dedup';

export interface RetrievedMessage extends Message {
  similarity: number;
}

/**
 * Retrieve the top-K most relevant past messages for a query.
 *
 * @param query - The user's current message text.
 * @param conversationId - Limit search to a specific conversation, or null for all.
 * @param queries - Database queries instance.
 * @param k - Number of results to return. Default 15.
 */
export async function retrieveSimilar(
  query: string,
  conversationId: string | null,
  queries: Queries,
  k: number = 15
): Promise<RetrievedMessage[]> {
  const queryEmbedding = await embed(query);
  if (!queryEmbedding) return [];

  // Try sqlite-vec search first
  const vecResults = queries.searchSimilar(queryEmbedding, k * 2);

  if (vecResults.length > 0) {
    // Get full message data for each result
    const allMessages = conversationId
      ? queries.getMessages(conversationId)
      : [];

    const messageMap = new Map<string, Message>();
    for (const msg of allMessages) {
      messageMap.set(msg.id, msg);
    }

    const retrieved: RetrievedMessage[] = [];
    for (const result of vecResults) {
      const msg = messageMap.get(result.message_id);
      if (msg) {
        // sqlite-vec returns distance, convert to similarity (1 - distance for cosine)
        retrieved.push({
          ...msg,
          similarity: 1 - result.distance,
        });
      }
    }

    // Filter to conversation if specified and sort by similarity
    return retrieved
      .filter((m) => !conversationId || m.conversation_id === conversationId)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  // Fallback: in-memory similarity search using cached fallback embeddings
  if (!conversationId) return [];

  const messages = queries.getMessages(conversationId);

  // For short conversations, skip RAG — all messages will be in the recent window
  if (messages.length <= 15) return [];

  const scored: RetrievedMessage[] = [];

  for (const msg of messages) {
    const msgEmbedding = await embed(msg.content);
    if (!msgEmbedding) continue;

    const similarity = cosineSimilarity(queryEmbedding, msgEmbedding);
    scored.push({ ...msg, similarity });
  }

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}
