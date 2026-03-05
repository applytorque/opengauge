import { Queries, FileChunk } from '../../db/queries';
import { embed } from '../rag/embedder';
import { cosineSimilarity } from '../optimizer/dedup';
import { compressPrompt } from '../optimizer/compressor';

export interface RetrievedFileChunk extends FileChunk {
  similarity: number;
}

export async function retrieveRelevantFileChunks(
  query: string,
  conversationId: string,
  queries: Queries,
  k: number = 8
): Promise<RetrievedFileChunk[]> {
  const queryEmbedding = await embed(query);
  if (!queryEmbedding) return [];

  const chunks = queries.listFileChunksByConversation(conversationId);
  if (!chunks.length) return [];

  // Try vector search if sqlite-vec table is available.
  const vectorHits = queries.searchSimilarFileChunks(queryEmbedding, k * 2);
  if (vectorHits.length > 0) {
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const retrieved: RetrievedFileChunk[] = [];

    for (const hit of vectorHits) {
      const chunk = chunkMap.get(hit.chunk_id);
      if (!chunk) continue;
      retrieved.push({
        ...chunk,
        similarity: 1 - hit.distance,
      });
    }

    return retrieved
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  // Fallback in-memory similarity (bounded to latest chunks for efficiency)
  const recentChunks = chunks.slice(0, 160);
  const scored: RetrievedFileChunk[] = [];

  for (const chunk of recentChunks) {
    const chunkEmbedding = await embed(chunk.content);
    if (!chunkEmbedding) continue;

    scored.push({
      ...chunk,
      similarity: cosineSimilarity(queryEmbedding, chunkEmbedding),
    });
  }

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

export function buildFileContextBlock(chunks: RetrievedFileChunk[]): string {
  if (!chunks.length) return '';

  const lines = chunks.map((chunk, index) => {
    const compressed = compressPrompt(chunk.content, 0.72).compressed;
    return `${index + 1}. ${compressed}`;
  });

  return `[Retrieved File Knowledge]\n${lines.join('\n\n')}\n[End Retrieved File Knowledge]`;
}
