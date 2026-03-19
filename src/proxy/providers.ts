/**
 * Provider detection and upstream URL resolution.
 * Inspects request path and headers to determine the target API.
 */

export interface DetectedProvider {
  name: string;
  upstreamBase: string;
  model?: string;
}

const PROVIDER_MAP: Array<{
  pathPattern: RegExp;
  name: string;
  upstreamBase: string;
  headerHint?: string;
}> = [
  {
    pathPattern: /^\/v1\/messages/,
    name: 'anthropic',
    upstreamBase: 'https://api.anthropic.com',
    headerHint: 'x-api-key',
  },
  {
    pathPattern: /^\/v1\/chat\/completions/,
    name: 'openai',
    upstreamBase: 'https://api.openai.com',
  },
  {
    pathPattern: /^\/v1\/completions/,
    name: 'openai',
    upstreamBase: 'https://api.openai.com',
  },
  {
    pathPattern: /^\/v1\/models/,
    name: 'openai',
    upstreamBase: 'https://api.openai.com',
  },
  {
    pathPattern: /^\/v1beta\/models/,
    name: 'gemini',
    upstreamBase: 'https://generativelanguage.googleapis.com',
  },
  {
    pathPattern: /^\/v1beta\//,
    name: 'gemini',
    upstreamBase: 'https://generativelanguage.googleapis.com',
  },
];

export function detectProvider(
  path: string,
  headers: Record<string, string | string[] | undefined>
): DetectedProvider | null {
  for (const entry of PROVIDER_MAP) {
    if (entry.pathPattern.test(path)) {
      // Check for Anthropic-specific header to distinguish from OpenAI on /v1/ paths
      if (entry.name === 'openai' && headers['x-api-key'] && !headers['authorization']) {
        return { name: 'anthropic', upstreamBase: 'https://api.anthropic.com' };
      }
      return { name: entry.name, upstreamBase: entry.upstreamBase };
    }
  }
  return null;
}

/**
 * Extract model name from request body.
 */
export function extractModel(body: any): string {
  if (typeof body === 'object' && body !== null) {
    return body.model || 'unknown';
  }
  return 'unknown';
}

/**
 * Extract token usage from different provider response formats.
 */
export function extractUsage(provider: string, body: any): { tokensIn: number; tokensOut: number } {
  if (!body || typeof body !== 'object') return { tokensIn: 0, tokensOut: 0 };

  // Anthropic format
  if (body.usage) {
    return {
      tokensIn: body.usage.input_tokens || body.usage.prompt_tokens || 0,
      tokensOut: body.usage.output_tokens || body.usage.completion_tokens || 0,
    };
  }

  return { tokensIn: 0, tokensOut: 0 };
}

/**
 * Extract response text from different provider response formats.
 */
export function extractResponseText(provider: string, body: any): string {
  if (!body || typeof body !== 'object') return '';

  // Anthropic format
  if (body.content && Array.isArray(body.content)) {
    return body.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
  }

  // OpenAI format
  if (body.choices && Array.isArray(body.choices)) {
    return body.choices
      .map((c: any) => c.message?.content || c.text || '')
      .join('');
  }

  return '';
}
