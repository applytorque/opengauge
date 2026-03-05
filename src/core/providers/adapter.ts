export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ProviderConfig {
  api_key?: string;
  base_url?: string;
  default_model?: string;
}

export interface LLMProvider {
  name: string;
  defaultModel: string;

  /**
   * Send a chat request and get a full response.
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Send a chat request and stream the response via an async generator.
   */
  chatStream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown>;

  /**
   * Count tokens for a given text (provider-specific).
   */
  countTokens(text: string): Promise<number>;
}

import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';

export function createProvider(name: ProviderName, config: ProviderConfig): LLMProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
