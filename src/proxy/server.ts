/**
 * opengauge watch — Local HTTP proxy for observing LLM API traffic.
 *
 * Accepts LLM API requests, logs them to @opengauge/core, optionally optimizes
 * them, and forwards to the actual provider endpoint. Supports SSE streaming.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4000 claude
 *   OPENAI_BASE_URL=http://localhost:4000/v1 your-tool
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { getDb } from '../db';
import { initSchema } from '../db/schema';
import { SessionQueries } from '../db/session-queries';
import { calculateCost } from '../core/cost';
import { initPricing } from '../core/cost/pricing-loader';
import { checkRunawayLoop, type Interaction } from '../core/circuit-breaker';
import { detectProvider, extractModel, extractUsage, extractResponseText } from './providers';
import { ProxySessionManager } from './session-manager';

export interface WatchOptions {
  port: number;
  optimize?: boolean;
  aggressiveness?: 'conservative' | 'medium' | 'aggressive';
}

export function startWatchProxy(options: WatchOptions): http.Server {
  const db = getDb();
  initSchema(db);
  initPricing(db);
  const sq = new SessionQueries(db);
  const sessionMgr = new ProxySessionManager();

  // Per-session recent interactions for circuit breaker
  const recentBySession = new Map<string, Interaction[]>();

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();

    // Health check
    if (req.url === '/health' || req.url === '/__opengauge/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'watch', port: options.port }));
      return;
    }

    // Stats endpoint
    if (req.url === '/__opengauge/stats') {
      try {
        const summary = sq.getSpendSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
      } catch {
        res.writeHead(500);
        res.end('{"error":"Failed to fetch stats"}');
      }
      return;
    }

    // Detect provider from request path
    const provider = detectProvider(req.url || '/', req.headers as any);
    if (!provider) {
      // Unknown path — return 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown API path. Supported: /v1/messages (Anthropic), /v1/chat/completions (OpenAI), /v1beta/ (Gemini)' }));
      return;
    }

    // Read request body
    let body = '';
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"Failed to read request body"}');
      return;
    }

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = {};
    }

    const model = extractModel(parsedBody);
    const isStreaming = parsedBody.stream === true;

    // Get/create session
    const { session } = sessionMgr.getSession(req.headers as any, provider.name, model);

    // Extract original prompt
    let originalPrompt = '';
    if (parsedBody.messages && Array.isArray(parsedBody.messages)) {
      const lastUser = [...parsedBody.messages].reverse().find((m: any) => m.role === 'user');
      originalPrompt = lastUser?.content || '';
      if (typeof originalPrompt !== 'string') {
        originalPrompt = JSON.stringify(originalPrompt);
      }
    }

    // Circuit breaker check
    const recent = recentBySession.get(session.id) || [];
    const cbResult = checkRunawayLoop(recent, {
      similarityThreshold: 0.8,
      tripPairCount: 6,
      warningPairCount: 3,
    });

    if (cbResult.verdict === 'warning' || cbResult.verdict === 'trip') {
      try {
        sq.writeAlert(
          session.id,
          'runaway_loop',
          cbResult.verdict === 'trip' ? 'critical' : 'warning',
          cbResult.reason,
          cbResult
        );
      } catch { /* ignore */ }
    }

    // Forward to upstream
    const upstreamUrl = new URL(req.url || '/', provider.upstreamBase);

    // Build upstream headers (pass through, removing host and accept-encoding)
    // We strip accept-encoding so the upstream returns uncompressed responses
    // that we can parse for usage/cost logging before forwarding to the client.
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (key === 'host' || key === 'connection' || key === 'accept-encoding') continue;
      if (key.startsWith('x-opengauge-')) continue; // Strip our custom headers
      if (val) upstreamHeaders[key] = Array.isArray(val) ? val[0] : val;
    }
    upstreamHeaders['host'] = upstreamUrl.hostname;

    try {
      if (isStreaming) {
        await handleStreamingRequest(
          upstreamUrl, upstreamHeaders, body, req.method || 'POST',
          res, sq, sessionMgr, session.id, model, provider.name,
          originalPrompt, startTime, recent, recentBySession
        );
      } else {
        await handleStandardRequest(
          upstreamUrl, upstreamHeaders, body, req.method || 'POST',
          res, sq, sessionMgr, session.id, model, provider.name,
          originalPrompt, startTime, recent, recentBySession
        );
      }
    } catch (error) {
      // Try to return a meaningful error
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: String(error) }));
      }
    }
  });

  // Graceful shutdown
  const cleanup = () => {
    sessionMgr.shutdown();
    server.close();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  server.listen(options.port, '127.0.0.1', () => {
    console.log(`\nOpenGauge watch mode listening on http://127.0.0.1:${options.port}`);
    console.log(`\nConfigure your tools:`);
    console.log(`  ANTHROPIC_BASE_URL=http://localhost:${options.port} claude`);
    console.log(`  OPENAI_BASE_URL=http://localhost:${options.port}/v1 your-tool`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });

  return server;
}

// ---- Helpers ----

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function makeUpstreamRequest(
  url: URL,
  headers: Record<string, string>,
  body: string,
  method: string
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body).toString(),
      },
    }, resolve);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleStandardRequest(
  upstreamUrl: URL,
  headers: Record<string, string>,
  body: string,
  method: string,
  clientRes: http.ServerResponse,
  sq: SessionQueries,
  sessionMgr: ProxySessionManager,
  sessionId: string,
  model: string,
  providerName: string,
  originalPrompt: string,
  startTime: number,
  recent: Interaction[],
  recentBySession: Map<string, Interaction[]>
): Promise<void> {
  const upstreamRes = await makeUpstreamRequest(upstreamUrl, headers, body, method);
  const statusCode = upstreamRes.statusCode || 200;

  const chunks: Buffer[] = [];
  upstreamRes.on('data', (chunk) => chunks.push(chunk));

  await new Promise<void>((resolve) => upstreamRes.on('end', resolve));

  const responseBody = Buffer.concat(chunks).toString('utf-8');
  const latencyMs = Date.now() - startTime;

  // Forward response to client
  const responseHeaders = { ...upstreamRes.headers };
  clientRes.writeHead(statusCode, responseHeaders);
  clientRes.end(responseBody);

  // Log the interaction
  try {
    let parsed: any;
    try { parsed = JSON.parse(responseBody); } catch { parsed = {}; }

    const usage = extractUsage(providerName, parsed);
    const responseText = extractResponseText(providerName, parsed);
    const cost = calculateCost(providerName, model, usage.tokensIn, usage.tokensOut);
    const upstreamError = extractUpstreamError(statusCode, parsed, responseBody);

    const seqNum = sessionMgr.recordInteraction(
      { 'x-opengauge-session': sessionId } as any,
      usage.tokensIn
    );

    sq.writeInteraction(sessionId, seqNum, model, {
      originalPrompt,
      responseText,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: cost.totalCost,
      upstreamStatusCode: statusCode,
      upstreamError,
      latencyMs,
    });

    sq.updateSessionAggregates(sessionId, usage.tokensIn, usage.tokensOut, cost.totalCost);

    // Update circuit breaker history
    recent.push(
      { role: 'user', content: originalPrompt, timestamp: startTime },
      { role: 'assistant', content: responseText, timestamp: Date.now() }
    );
    if (recent.length > 40) recent.splice(0, recent.length - 40);
    recentBySession.set(sessionId, recent);
  } catch { /* non-blocking logging */ }
}

async function handleStreamingRequest(
  upstreamUrl: URL,
  headers: Record<string, string>,
  body: string,
  method: string,
  clientRes: http.ServerResponse,
  sq: SessionQueries,
  sessionMgr: ProxySessionManager,
  sessionId: string,
  model: string,
  providerName: string,
  originalPrompt: string,
  startTime: number,
  recent: Interaction[],
  recentBySession: Map<string, Interaction[]>
): Promise<void> {
  const upstreamRes = await makeUpstreamRequest(upstreamUrl, headers, body, method);
  const statusCode = upstreamRes.statusCode || 200;

  // Forward headers immediately for streaming
  const responseHeaders = { ...upstreamRes.headers };
  clientRes.writeHead(statusCode, responseHeaders);

  // Buffer SSE data for logging while streaming through
  let fullContent = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let rawBuffer = '';
  let rawResponse = '';

  upstreamRes.on('data', (chunk: Buffer) => {
    // Forward to client immediately
    clientRes.write(chunk);

    rawResponse += chunk.toString('utf-8');

    // Buffer for parsing
    rawBuffer += chunk.toString('utf-8');

    // Parse SSE events to extract content and usage
    const lines = rawBuffer.split('\n');
    rawBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);

        // Anthropic streaming format
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullContent += event.delta.text;
        }
        if (event.type === 'message_delta' && event.usage) {
          tokensOut = event.usage.output_tokens || tokensOut;
        }
        if (event.type === 'message_start' && event.message?.usage) {
          tokensIn = event.message.usage.input_tokens || tokensIn;
        }

        // OpenAI streaming format
        if (event.choices?.[0]?.delta?.content) {
          fullContent += event.choices[0].delta.content;
        }
        if (event.usage) {
          tokensIn = event.usage.prompt_tokens || tokensIn;
          tokensOut = event.usage.completion_tokens || tokensOut;
        }
      } catch { /* ignore parse errors in stream */ }
    }
  });

  await new Promise<void>((resolve) => {
    upstreamRes.on('end', () => {
      clientRes.end();
      resolve();
    });
  });

  // Log the complete interaction
  try {
    const latencyMs = Date.now() - startTime;
    const cost = calculateCost(providerName, model, tokensIn, tokensOut);
    const parsedResponse = tryParseJson(rawResponse);
    const upstreamError = extractUpstreamError(statusCode, parsedResponse, rawResponse);

    const seqNum = sessionMgr.recordInteraction(
      { 'x-opengauge-session': sessionId } as any,
      tokensIn
    );

    sq.writeInteraction(sessionId, seqNum, model, {
      originalPrompt,
      responseText: fullContent,
      tokensIn,
      tokensOut,
      costUsd: cost.totalCost,
      upstreamStatusCode: statusCode,
      upstreamError,
      latencyMs,
    });

    sq.updateSessionAggregates(sessionId, tokensIn, tokensOut, cost.totalCost);

    recent.push(
      { role: 'user', content: originalPrompt, timestamp: startTime },
      { role: 'assistant', content: fullContent, timestamp: Date.now() }
    );
    if (recent.length > 40) recent.splice(0, recent.length - 40);
    recentBySession.set(sessionId, recent);
  } catch { /* non-blocking logging */ }
}

function tryParseJson(raw: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractUpstreamError(statusCode: number, parsedBody: any, rawBody: string): string | undefined {
  if (statusCode < 400) return undefined;

  if (typeof parsedBody?.error === 'string' && parsedBody.error.trim()) {
    return parsedBody.error.trim().slice(0, 2000);
  }
  if (typeof parsedBody?.error?.message === 'string' && parsedBody.error.message.trim()) {
    return parsedBody.error.message.trim().slice(0, 2000);
  }
  if (typeof parsedBody?.message === 'string' && parsedBody.message.trim()) {
    return parsedBody.message.trim().slice(0, 2000);
  }

  const compactRaw = rawBody.trim();
  if (compactRaw) return compactRaw.slice(0, 2000);

  return `Upstream returned HTTP ${statusCode}`;
}
