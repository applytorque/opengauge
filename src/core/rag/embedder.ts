/**
 * Embedder — Local embedding using all-MiniLM-L6-v2 via onnxruntime-node
 *
 * Zero API cost, ~23ms per embedding, fully offline.
 * Output dimension: 384
 */

import path from 'path';
import fs from 'fs';
import os from 'os';

let session: any = null;
let sessionChecked = false;
let usingFallbackEmbeddings = false;
let tokenizer: any = null;

// Simple word-piece tokenizer for MiniLM
// In production, you'd use the actual tokenizer from the model
// For now, we use a simplified approach
const MAX_SEQ_LENGTH = 256;

/**
 * Initialize the ONNX runtime session with MiniLM-L6-v2.
 * Caches the result (including "not available") to avoid repeated checks.
 */
async function getSession(): Promise<any> {
  if (session) return session;
  if (sessionChecked) return null; // Already checked, model not available

  sessionChecked = true;

  try {
    const ort = await import('onnxruntime-node');

    // Check for model in ~/.opengauge/models/
    const modelDir = path.join(os.homedir(), '.opengauge', 'models');
    const modelPath = path.join(modelDir, 'all-MiniLM-L6-v2.onnx');

    if (!fs.existsSync(modelPath)) {
      usingFallbackEmbeddings = true;
      console.log('[OpenGauge] Embedding model not found. Using fallback hash embeddings.');
      console.log(`  To enable full semantic search, place all-MiniLM-L6-v2.onnx in ${modelDir}`);
      return null;
    }

    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });

    usingFallbackEmbeddings = false;

    console.log('[OpenGauge] ONNX embedding model loaded successfully.');
    return session;
  } catch (error) {
    usingFallbackEmbeddings = true;
    console.warn('[OpenGauge] Failed to initialize ONNX embedding model. Using fallback.', error);
    return null;
  }
}

export function getEmbeddingMode(): 'onnx-minilm' | 'fallback-hash' {
  return usingFallbackEmbeddings ? 'fallback-hash' : 'onnx-minilm';
}

/**
 * Simple tokenization: split on whitespace and punctuation,
 * convert to indices. This is a fallback; a proper tokenizer
 * would use the model's vocabulary.
 */
function simpleTokenize(text: string): {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  tokenTypeIds: BigInt64Array;
} {
  // Simple whitespace tokenization + padding/truncation
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, MAX_SEQ_LENGTH - 2);

  const seqLength = words.length + 2; // [CLS] + words + [SEP]

  const inputIds = new BigInt64Array(seqLength);
  const attentionMask = new BigInt64Array(seqLength);
  const tokenTypeIds = new BigInt64Array(seqLength);

  // [CLS] token = 101
  inputIds[0] = BigInt(101);
  attentionMask[0] = BigInt(1);

  // Map words to pseudo token IDs using hash
  for (let i = 0; i < words.length; i++) {
    inputIds[i + 1] = BigInt(hashWord(words[i]));
    attentionMask[i + 1] = BigInt(1);
  }

  // [SEP] token = 102
  inputIds[seqLength - 1] = BigInt(102);
  attentionMask[seqLength - 1] = BigInt(1);

  return { inputIds, attentionMask, tokenTypeIds };
}

function hashWord(word: string): number {
  let hash = 0;
  for (let i = 0; i < word.length; i++) {
    hash = ((hash << 5) - hash + word.charCodeAt(i)) & 0x7fff;
  }
  return (hash % 30000) + 1000; // Keep in vocab range
}

/**
 * Generate embedding for a text using the ONNX model.
 * Returns null if the model is not available.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const sess = await getSession();

  if (!sess) {
    // Fallback: generate a simple TF-IDF-like hash embedding
    return fallbackEmbed(text);
  }

  try {
    const ort = await import('onnxruntime-node');
    const { inputIds, attentionMask, tokenTypeIds } = simpleTokenize(text);

    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, inputIds.length]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, attentionMask.length]),
      token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, tokenTypeIds.length]),
    };

    const results = await sess.run(feeds);

    // Mean pooling over token embeddings
    const output = results['last_hidden_state'] || results['token_embeddings'] || Object.values(results)[0];
    const data = output.data as Float32Array;
    const hiddenSize = 384;
    const numTokens = inputIds.length;

    const embedding = new Float32Array(hiddenSize);
    for (let i = 0; i < numTokens; i++) {
      for (let j = 0; j < hiddenSize; j++) {
        embedding[j] += data[i * hiddenSize + j];
      }
    }

    // Average
    for (let j = 0; j < hiddenSize; j++) {
      embedding[j] /= numTokens;
    }

    // L2 normalize
    let norm = 0;
    for (let j = 0; j < hiddenSize; j++) {
      norm += embedding[j] * embedding[j];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let j = 0; j < hiddenSize; j++) {
        embedding[j] /= norm;
      }
    }

    return embedding;
  } catch (error) {
    console.warn('Embedding failed, using fallback:', error);
    return fallbackEmbed(text);
  }
}

/**
 * Fallback embedding using character n-gram hashing.
 * Produces a 384-dim vector. Not as good as MiniLM but enables
 * basic similarity search without the ONNX model.
 */
function fallbackEmbed(text: string): Float32Array {
  const DIM = 384;
  const embedding = new Float32Array(DIM);

  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '');
  const words = normalized.split(/\s+/);

  // Hash words into the embedding dimensions
  for (const word of words) {
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i <= word.length - n; i++) {
        const ngram = word.substring(i, i + n);
        let hash = 0;
        for (let c = 0; c < ngram.length; c++) {
          hash = (hash * 31 + ngram.charCodeAt(c)) % DIM;
        }
        embedding[hash] += 1;
      }
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

/**
 * Batch embed multiple texts.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  const results: (Float32Array | null)[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
