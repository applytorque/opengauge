import {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ProviderConfig,
} from './adapter';

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  defaultModel: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.api_key || '';
    this.baseUrl = config.base_url || 'https://generativelanguage.googleapis.com';
    this.defaultModel = config.default_model || 'gemini-2.0-flash';
  }

  private toGeminiMessages(messages: ChatRequest['messages']): { systemInstruction?: any; contents: any[] } {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const contents = nonSystem.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    return {
      systemInstruction: systemMsg
        ? { parts: [{ text: systemMsg.content }] }
        : undefined,
      contents,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    const { systemInstruction, contents } = this.toGeminiMessages(request.messages);

    const body: any = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 4096,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (request.temperature !== undefined) {
      body.generationConfig.temperature = request.temperature;
    }

    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;
    const content =
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';

    return {
      content,
      tokensIn: data.usageMetadata?.promptTokenCount || 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount || 0,
      model,
      provider: this.name,
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = request.model || this.defaultModel;
    const { systemInstruction, contents } = this.toGeminiMessages(request.messages);

    const body: any = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 4096,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (request.temperature !== undefined) {
      body.generationConfig.temperature = request.temperature;
    }

    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${err}`);
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

          try {
            const event = JSON.parse(data);
            const text = event.candidates?.[0]?.content?.parts
              ?.map((p: any) => p.text)
              .join('');

            if (text) {
              yield { content: text, done: false };
            }

            if (event.usageMetadata) {
              tokensIn = event.usageMetadata.promptTokenCount || 0;
              tokensOut = event.usageMetadata.candidatesTokenCount || 0;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: '', done: true, tokensIn, tokensOut };
  }

  async countTokens(text: string): Promise<number> {
    try {
      const model = this.defaultModel;
      const url = `${this.baseUrl}/v1beta/models/${model}:countTokens?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        return data.totalTokens || Math.ceil(text.length / 4);
      }
    } catch {
      // fallback
    }
    return Math.ceil(text.length / 4);
  }
}
