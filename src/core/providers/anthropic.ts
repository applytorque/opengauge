import {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter';

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  defaultModel: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.api_key || '';
    this.baseUrl = config.base_url || 'https://api.anthropic.com';
    this.defaultModel = config.default_model || 'claude-sonnet-4-20250514';
  }

  private mergeSystemMessages(messages: ChatRequest['messages']): string {
    return messages
      .filter((m) => m.role === 'system' && m.content?.trim())
      .map((m) => m.content.trim())
      .join('\n\n');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    const systemContent = this.mergeSystemMessages(request.messages);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    const body: any = {
      model,
      max_tokens: request.maxTokens || 4096,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (systemContent) {
      // Use prompt caching for system prompts
      body.system = [
        {
          type: 'text',
          text: systemContent,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;
    const content = data.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');

    return {
      content,
      tokensIn: data.usage?.input_tokens || 0,
      tokensOut: data.usage?.output_tokens || 0,
      model,
      provider: this.name,
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = request.model || this.defaultModel;
    const systemContent = this.mergeSystemMessages(request.messages);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    const body: any = {
      model,
      max_tokens: request.maxTokens || 4096,
      stream: true,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (systemContent) {
      body.system = [
        {
          type: 'text',
          text: systemContent,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
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

            if (event.type === 'content_block_delta' && event.delta?.text) {
              yield { content: event.delta.text, done: false };
            }

            if (event.type === 'message_start' && event.message?.usage) {
              tokensIn = event.message.usage.input_tokens || 0;
            }

            if (event.type === 'message_delta' && event.usage) {
              tokensOut = event.usage.output_tokens || 0;
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
    // Rough estimation: ~4 chars per token for Claude
    return Math.ceil(text.length / 4);
  }
}
