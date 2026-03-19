/**
 * @opengauge/core — Cost Calculator
 *
 * Seeded model pricing profiles and a pure calculateCost() function.
 * Prices are per 1M tokens (input/output) in USD.
 */

export interface ModelProfile {
  provider: string;
  model: string;
  inputPricePer1M: number;   // USD per 1M input tokens
  outputPricePer1M: number;  // USD per 1M output tokens
  contextWindow?: number;    // max tokens
}

export interface CostEstimate {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

// ---- Seeded model pricing profiles ----
// Prices as of early 2025. Ollama models are local (zero cost).

const MODEL_PROFILES: ModelProfile[] = [
  // Anthropic
  { provider: 'anthropic', model: 'claude-opus-4-6',               inputPricePer1M: 15,    outputPricePer1M: 75,    contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-opus-4-20250514',        inputPricePer1M: 15,    outputPricePer1M: 75,    contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6',             inputPricePer1M: 3,     outputPricePer1M: 15,    contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514',      inputPricePer1M: 3,     outputPricePer1M: 15,    contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-haiku-4-5',              inputPricePer1M: 0.80,  outputPricePer1M: 4,     contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022',    inputPricePer1M: 3,     outputPricePer1M: 15,    contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-3-5-haiku-20241022',     inputPricePer1M: 0.80,  outputPricePer1M: 4,     contextWindow: 200_000 },
  { provider: 'anthropic', model: 'claude-3-haiku-20240307',       inputPricePer1M: 0.25,  outputPricePer1M: 1.25,  contextWindow: 200_000 },

  // OpenAI
  { provider: 'openai', model: 'gpt-4o',                          inputPricePer1M: 2.50,  outputPricePer1M: 10,    contextWindow: 128_000 },
  { provider: 'openai', model: 'gpt-4o-mini',                     inputPricePer1M: 0.15,  outputPricePer1M: 0.60,  contextWindow: 128_000 },
  { provider: 'openai', model: 'gpt-4-turbo',                     inputPricePer1M: 10,    outputPricePer1M: 30,    contextWindow: 128_000 },
  { provider: 'openai', model: 'gpt-4',                           inputPricePer1M: 30,    outputPricePer1M: 60,    contextWindow: 8_192 },
  { provider: 'openai', model: 'gpt-3.5-turbo',                   inputPricePer1M: 0.50,  outputPricePer1M: 1.50,  contextWindow: 16_385 },
  { provider: 'openai', model: 'o1',                              inputPricePer1M: 15,    outputPricePer1M: 60,    contextWindow: 200_000 },
  { provider: 'openai', model: 'o1-mini',                         inputPricePer1M: 3,     outputPricePer1M: 12,    contextWindow: 128_000 },
  { provider: 'openai', model: 'o3-mini',                         inputPricePer1M: 1.10,  outputPricePer1M: 4.40,  contextWindow: 200_000 },

  // Google Gemini
  { provider: 'gemini', model: 'gemini-2.0-flash',                inputPricePer1M: 0.10,  outputPricePer1M: 0.40,  contextWindow: 1_000_000 },
  { provider: 'gemini', model: 'gemini-2.0-flash-lite',           inputPricePer1M: 0.075, outputPricePer1M: 0.30,  contextWindow: 1_000_000 },
  { provider: 'gemini', model: 'gemini-1.5-pro',                  inputPricePer1M: 1.25,  outputPricePer1M: 5,     contextWindow: 2_000_000 },
  { provider: 'gemini', model: 'gemini-1.5-flash',                inputPricePer1M: 0.075, outputPricePer1M: 0.30,  contextWindow: 1_000_000 },

  // Ollama (local — free)
  { provider: 'ollama', model: 'llama3',                          inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 8_192 },
  { provider: 'ollama', model: 'llama3:70b',                      inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 8_192 },
  { provider: 'ollama', model: 'mistral',                         inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 32_768 },
  { provider: 'ollama', model: 'codellama',                       inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 16_384 },
  { provider: 'ollama', model: 'phi3',                            inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 128_000 },
  { provider: 'ollama', model: 'gemma2',                          inputPricePer1M: 0, outputPricePer1M: 0, contextWindow: 8_192 },
];

// Index for O(1) lookup: "provider:model" → ModelProfile
const profileIndex = new Map<string, ModelProfile>();
for (const p of MODEL_PROFILES) {
  profileIndex.set(`${p.provider}:${p.model}`, p);
}

/**
 * Look up a model profile by provider and model name.
 * Falls back to fuzzy prefix match (e.g. "claude-3-5-sonnet" matches "claude-3-5-sonnet-20241022").
 */
export function getModelProfile(provider: string, model: string): ModelProfile | undefined {
  // Exact match first
  const exact = profileIndex.get(`${provider}:${model}`);
  if (exact) return exact;

  // Prefix match: user may omit date suffix
  const prefix = `${provider}:${model}`;
  for (const [key, profile] of profileIndex) {
    if (key.startsWith(prefix)) return profile;
  }

  // Reverse prefix: profile model may be a prefix of user's model
  for (const [, profile] of profileIndex) {
    if (profile.provider === provider && model.startsWith(profile.model)) {
      return profile;
    }
  }

  return undefined;
}

/**
 * Calculate cost for a given model and token counts.
 * Returns zero cost if the model is not found (treat as local/free).
 */
export function calculateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number
): CostEstimate {
  const profile = getModelProfile(provider, model);

  const inputCost = profile ? (tokensIn / 1_000_000) * profile.inputPricePer1M : 0;
  const outputCost = profile ? (tokensOut / 1_000_000) * profile.outputPricePer1M : 0;

  return {
    provider,
    model,
    tokensIn,
    tokensOut,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * Register or update a custom model profile at runtime.
 */
export function registerModelProfile(profile: ModelProfile): void {
  const key = `${profile.provider}:${profile.model}`;
  profileIndex.set(key, profile);
  // Also add to the array for iteration
  const existingIdx = MODEL_PROFILES.findIndex(
    (p) => p.provider === profile.provider && p.model === profile.model
  );
  if (existingIdx >= 0) {
    MODEL_PROFILES[existingIdx] = profile;
  } else {
    MODEL_PROFILES.push(profile);
  }
}

/**
 * List all known model profiles.
 */
export function listModelProfiles(): readonly ModelProfile[] {
  return MODEL_PROFILES;
}
