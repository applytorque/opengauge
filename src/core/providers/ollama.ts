import {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  defaultModel: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.base_url || 'http://localhost:11434';
    this.defaultModel = config.default_model || 'llama3';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;

    const body: any = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {} as any,
    };

    if (request.maxTokens) {
      body.options.num_predict = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      body.options.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;

    return {
      content: data.message?.content || '',
      tokensIn: data.prompt_eval_count || 0,
      tokensOut: data.eval_count || 0,
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
      stream: true,
      options: {} as any,
    };

    if (request.maxTokens) {
      body.options.num_predict = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      body.options.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${err}`);
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
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);

            if (event.message?.content) {
              yield { content: event.message.content, done: false };
            }

            if (event.done) {
              tokensIn = event.prompt_eval_count || 0;
              tokensOut = event.eval_count || 0;
            }
          } catch {
            // Skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: '', done: true, tokensIn, tokensOut };
  }

  async countTokens(text: string): Promise<number> {
    // Ollama doesn't have a dedicated token counting endpoint
    // Rough approximation: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
