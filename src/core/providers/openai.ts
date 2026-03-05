import {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  defaultModel: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.api_key || '';
    this.baseUrl = config.base_url || 'https://api.openai.com';
    this.defaultModel = config.default_model || 'gpt-4o';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;

    const body: any = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens || 4096,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';

    return {
      content,
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      model,
      provider: this.name,
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = request.model || this.defaultModel;

    const body: any = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta?.content;

            if (delta) {
              yield { content: delta, done: false };
            }

            if (event.usage) {
              tokensIn = event.usage.prompt_tokens || 0;
              tokensOut = event.usage.completion_tokens || 0;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: '', done: true, tokensIn, tokensOut };
  }

  async countTokens(text: string): Promise<number> {
    // Use tiktoken for accurate OpenAI token counting
    try {
      const { encoding_for_model } = await import('tiktoken');
      const enc = encoding_for_model('gpt-4o' as any);
      const tokens = enc.encode(text);
      const count = tokens.length;
      enc.free();
      return count;
    } catch {
      // Fallback: ~4 chars per token
      return Math.ceil(text.length / 4);
    }
  }
}
