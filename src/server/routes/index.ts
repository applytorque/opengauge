/**
 * API Route Handlers
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../../db';
import { Queries } from '../../db/queries';
import { createProvider, ProviderName, ChatMessage, LLMProvider } from '../../core/providers/adapter';
import { assembleContext, DEFAULT_ASSEMBLER_CONFIG, AssemblerConfig } from '../../core/rag/assembler';
import { embed } from '../../core/rag/embedder';
import {
  shouldCheckpoint,
  generateCheckpointSummary,
  DEFAULT_CHECKPOINT_CONFIG,
} from '../../core/optimizer/checkpoint';
import { loadConfig, saveConfig, getDefaultProvider, AppConfig } from '../config';
import { initSSE, sendSSE, endSSE } from '../sse';

function sanitizeAssistantText(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

export function registerRoutes(app: FastifyInstance): void {
  const db = getDb();
  const queries = new Queries(db);

  // ========== CHAT ==========

  app.post('/api/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      message: string;
      conversation_id?: string;
      provider?: ProviderName;
      model?: string;
      system_prompt?: string;
    };

    if (!body.message) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    const config = loadConfig();
    const providerName = body.provider || getDefaultProvider(config);

    if (!providerName) {
      return reply.status(400).send({
        error: 'No provider configured. Please set up a provider via /api/config or the UI.',
      });
    }

    const providerConfig = config.providers[providerName];
    if (!providerConfig && providerName !== 'ollama') {
      return reply
        .status(400)
        .send({ error: `Provider "${providerName}" is not configured` });
    }

    let provider: LLMProvider;
    try {
      provider = createProvider(providerName, providerConfig || {});
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to create provider: ${err.message}` });
    }

    const model = body.model || provider.defaultModel;

    // Get or create conversation
    let conversationId = body.conversation_id;
    if (!conversationId) {
      const conv = queries.createConversation(providerName, model, undefined);
      conversationId = conv.id;
    }

    // Store user message
    const userMsg = queries.insertMessage(conversationId, 'user', body.message);

    // Embed the user message (async, don't block)
    embed(body.message).then((embedding) => {
      if (embedding) {
        queries.insertEmbedding(userMsg.id, embedding);
      }
    }).catch(() => {});

    // Get the system prompt
    const systemPrompt =
      body.system_prompt ||
      config.defaults?.system_prompt ||
      'You are a helpful assistant.';

    // Get latest checkpoint
    const checkpoint = queries.getLatestCheckpoint(conversationId);

    // Assemble context
    const assemblerConfig: AssemblerConfig = {
      ...DEFAULT_ASSEMBLER_CONFIG,
      compressionLevel: config.optimizer?.compression_level ?? 0.85,
      ragTopK: config.optimizer?.rag_top_k ?? 15,
      recentMessageCount: config.optimizer?.keep_recent ?? 2,
      targetSavingsPercent: config.optimizer?.target_savings_percent ?? 90,
      qualityFloorTokens: config.optimizer?.quality_floor_tokens ?? 320,
    };

    let contextResult;
    try {
      contextResult = await assembleContext(
        body.message,
        conversationId,
        systemPrompt,
        queries,
        checkpoint?.summary || null,
        assemblerConfig
      );
    } catch (err: any) {
      return reply.status(500).send({ error: `Context assembly failed: ${err.message}` });
    }

    // SSE streaming response
    initSSE(reply);

    // Send metadata event
    sendSSE(reply, 'meta', {
      conversation_id: conversationId,
      model,
      provider: providerName,
      tokens_raw: contextResult.tokensRaw,
      tokens_sent: contextResult.tokensSent,
      rag_results: contextResult.ragResultCount,
      savings_percent:
        contextResult.tokensRaw > 0
          ? Math.round(
              ((contextResult.tokensRaw - contextResult.tokensSent) /
                contextResult.tokensRaw) *
                100
            )
          : 0,
    });

    // Stream from LLM
    let fullResponse = '';
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      const stream = provider.chatStream({
        messages: contextResult.messages,
        model,
        stream: true,
      });

      for await (const chunk of stream) {
        if (chunk.content) {
          const cleanedChunk = sanitizeAssistantText(chunk.content);
          fullResponse += cleanedChunk;
          sendSSE(reply, 'content', { text: cleanedChunk });
        }
        if (chunk.done) {
          tokensIn = chunk.tokensIn || 0;
          tokensOut = chunk.tokensOut || 0;
        }
      }

      fullResponse = sanitizeAssistantText(fullResponse);
    } catch (err: any) {
      sendSSE(reply, 'error', { message: err.message });
      endSSE(reply);
      return;
    }

    // Store assistant message
    const assistantMsg = queries.insertMessage(
      conversationId,
      'assistant',
      fullResponse,
      tokensIn,
      tokensOut
    );

    // Embed the assistant message (async)
    embed(fullResponse).then((embedding) => {
      if (embedding) {
        queries.insertEmbedding(assistantMsg.id, embedding);
      }
    }).catch(() => {});

    // Store token usage
    const tokensSaved = Math.max(0, contextResult.tokensRaw - contextResult.tokensSent);
    queries.insertTokenUsage(
      conversationId,
      providerName,
      model,
      tokensIn,
      tokensOut,
      tokensSaved
    );

    // Auto-generate title on first message
    const conv = queries.getConversation(conversationId);
    if (conv && !conv.title) {
      try {
        const titleResponse = await provider.chat({
          messages: [
            {
              role: 'system',
              content: 'Generate a short title (max 6 words) for this conversation. Reply with only the title, no quotes.',
            },
            { role: 'user', content: body.message },
          ],
          model,
          maxTokens: 20,
          temperature: 0.7,
        });
        queries.updateConversation(conversationId, titleResponse.content.trim());
      } catch {
        queries.updateConversation(conversationId, body.message.slice(0, 50));
      }
    }

    // Check if we should checkpoint
    const messageCount = queries.getMessageCount(conversationId);
    const checkpointConfig = {
      interval: config.optimizer?.checkpoint_interval ?? DEFAULT_CHECKPOINT_CONFIG.interval,
      keepRecent: config.optimizer?.keep_recent ?? DEFAULT_CHECKPOINT_CONFIG.keepRecent,
    };

    const lastCheckpointCount = checkpoint ? 0 : 0; // simplified
    if (shouldCheckpoint(messageCount, lastCheckpointCount, checkpointConfig)) {
      // Generate checkpoint in background
      const messages = queries.getMessages(conversationId);
      const chatMessages: ChatMessage[] = messages
        .slice(0, -checkpointConfig.keepRecent)
        .map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));

      if (chatMessages.length > 0) {
        generateCheckpointSummary(chatMessages, provider, model)
          .then((summary) => {
            const lastMsg = messages[messages.length - checkpointConfig.keepRecent - 1];
            queries.insertCheckpoint(
              conversationId!,
              summary,
              lastMsg?.created_at || Date.now()
            );
          })
          .catch((err) => console.warn('Checkpoint generation failed:', err));
      }
    }

    // Send final event with usage stats
    sendSSE(reply, 'done', {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_saved: tokensSaved,
    });

    endSSE(reply);
  });

  // ========== CONVERSATIONS ==========

  app.get('/api/conversations', async (_request: FastifyRequest, reply: FastifyReply) => {
    const conversations = queries.listConversations();
    return reply.send(conversations);
  });

  app.get('/api/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const conversation = queries.getConversation(id);

    if (!conversation) {
      return reply.status(404).send({ error: 'Conversation not found' });
    }

    const messages = queries.getMessages(id);
    return reply.send({ ...conversation, messages });
  });

  app.delete('/api/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    queries.deleteConversation(id);
    return reply.send({ success: true });
  });

  // ========== TOKEN USAGE ==========

  app.get('/api/token-usage', async (_request: FastifyRequest, reply: FastifyReply) => {
    const aggregated = queries.getAggregatedTokenUsage();
    return reply.send(aggregated);
  });

  // ========== CONFIG ==========

  app.post('/api/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<AppConfig>;

    const config = loadConfig();

    if (body.providers) {
      for (const [name, providerConfig] of Object.entries(body.providers)) {
        config.providers[name as ProviderName] = {
          ...config.providers[name as ProviderName],
          ...providerConfig,
        };
      }
    }

    if (body.defaults) {
      config.defaults = { ...config.defaults, ...body.defaults };
    }

    if (body.optimizer) {
      config.optimizer = { ...config.optimizer, ...body.optimizer };
    }

    saveConfig(config);
    return reply.send({ success: true, config });
  });

  app.get('/api/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = loadConfig();
    // Mask API keys for security
    const masked = { ...config, providers: {} as any };
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      masked.providers[name] = {
        ...providerConfig,
        api_key: providerConfig?.api_key
          ? `${providerConfig.api_key.slice(0, 8)}...${providerConfig.api_key.slice(-4)}`
          : undefined,
      };
    }
    return reply.send(masked);
  });

  // ========== HEALTH ==========

  app.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = loadConfig();
    const conversations = queries.listConversations();
    const tokenUsage = queries.getAggregatedTokenUsage();

    return reply.send({
      status: 'ok',
      conversations: conversations.length,
      configured_providers: Object.keys(config.providers),
      token_usage_summary: tokenUsage,
      timestamp: Date.now(),
    });
  });
}
