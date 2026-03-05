/**
 * API Route Handlers
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../../db';
import { Queries } from '../../db/queries';
import { createProvider, ProviderName, ChatMessage, LLMProvider } from '../../core/providers/adapter';
import { assembleContext, DEFAULT_ASSEMBLER_CONFIG, AssemblerConfig } from '../../core/rag/assembler';
import { embed, getEmbeddingMode } from '../../core/rag/embedder';
import {
  processAttachments,
  UploadedAttachment,
  retrieveRelevantFileChunks,
  buildFileContextBlock,
} from '../../core/attachments';
import { analyzePrompt, improvePrompt, buildPromptImprovementResult } from '../../core/analytics/scorer';
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

function tokenizePrompt(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isGreetingPrompt(text: string): boolean {
  const normalized = (text || '').trim().toLowerCase();
  const basic = new Set([
    'hey',
    'hi',
    'hello',
    'yo',
    'sup',
    'hola',
    'good morning',
    'good afternoon',
    'good evening',
  ]);

  if (basic.has(normalized)) return true;
  return /^(hey+|hi+|hello+|yo+|sup+|hola+)[!.?]*$/i.test((text || '').trim());
}

function isLowIntentPrompt(text: string): boolean {
  const normalized = (text || '').trim().toLowerCase();
  const lowIntent = new Set([
    'ok',
    'okay',
    'k',
    'kk',
    'sure',
    'yep',
    'yes',
    'yup',
    'cool',
    'great',
    'nice',
    'done',
    'thanks',
    'thank you',
    'thx',
  ]);

  if (lowIntent.has(normalized)) return true;
  return /^(ok(ay)?|k+|sure|yep|yes|yup|cool|great|nice|done|thx|thanks|thank\s+you)[!.?]*$/i.test(
    (text || '').trim()
  );
}

function shouldUseImprovedPrompt(originalPrompt: string, improvedPrompt: string): boolean {
  const original = (originalPrompt || '').trim();
  const improved = (improvedPrompt || '').trim();
  if (!original || !improved) return false;
  if (isGreetingPrompt(original)) return false;
  if (isLowIntentPrompt(original)) return false;

  const originalTokens = tokenizePrompt(original);
  const improvedTokens = tokenizePrompt(improved);
  if (!originalTokens.length || !improvedTokens.length) return false;

  const originalSet = new Set(originalTokens);
  let overlap = 0;
  for (const token of improvedTokens) {
    if (originalSet.has(token)) overlap += 1;
  }

  const overlapRatio = overlap / Math.max(1, originalSet.size);
  if (overlapRatio < 0.35 && originalTokens.length <= 8) return false;

  const assistantStylePattern = /\b(i can help|how can i help|what can i help you with|i'm here to assist)\b/i;
  if (assistantStylePattern.test(improved)) return false;

  return true;
}

export function registerRoutes(app: FastifyInstance): void {
  const db = getDb();
  const queries = new Queries(db);

  function estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  function isProviderUsable(config: AppConfig, providerName: ProviderName): boolean {
    if (providerName === 'ollama') return true;
    const providerConfig = config.providers?.[providerName];
    return Boolean(providerConfig?.api_key);
  }

  function findFallbackProvider(config: AppConfig, primary: ProviderName): ProviderName | null {
    const preference: ProviderName[] = ['anthropic', 'openai', 'ollama', 'gemini'];
    for (const candidate of preference) {
      if (candidate === primary) continue;
      if (isProviderUsable(config, candidate)) return candidate;
    }
    return null;
  }

  function isGeminiQuotaError(err: unknown): boolean {
    const msg = String((err as any)?.message || err || '').toLowerCase();
    return msg.includes('gemini') && (msg.includes('quota') || msg.includes('resource_exhausted') || msg.includes('(429)'));
  }

  function toWindowMs(window: string): number {
    if (window === '30d') return 30 * 24 * 60 * 60 * 1000;
    if (window === '1d') return 24 * 60 * 60 * 1000;
    return 7 * 24 * 60 * 60 * 1000;
  }

  // ========== CHAT ==========

  app.post('/api/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    let body = request.body as {
      message: string;
      conversation_id?: string;
      provider?: ProviderName;
      model?: string;
      system_prompt?: string;
    };

    let uploadedFiles: UploadedAttachment[] = [];

    if ((request as any).isMultipart?.()) {
      const fields: Record<string, string> = {};
      const files: UploadedAttachment[] = [];

      try {
        const parts = (request as any).parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            const buffer = Buffer.concat(chunks);
            files.push({
              filename: part.filename || 'unnamed-file',
              mimetype: part.mimetype || 'application/octet-stream',
              buffer,
              size: buffer.length,
            });
          } else {
            fields[part.fieldname] = String(part.value ?? '');
          }
        }
      } catch (err: any) {
        return reply.status(400).send({ error: `Failed to parse multipart request: ${err.message}` });
      }

      body = {
        message: fields.message || '',
        conversation_id: fields.conversation_id || undefined,
        provider: (fields.provider as ProviderName) || undefined,
        model: fields.model || undefined,
        system_prompt: fields.system_prompt || undefined,
      };
      uploadedFiles = files;
    }

    if (!body.message && uploadedFiles.length === 0) {
      return reply.status(400).send({ error: 'Message or attachment is required' });
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
    let activeProviderName: ProviderName = providerName;
    let activeProvider: LLMProvider = provider;
    let activeModel: string = model;

    // Get or create conversation
    let conversationId = body.conversation_id;
    if (!conversationId) {
      const conv = queries.createConversation(providerName, model, undefined);
      conversationId = conv.id;
    }

    const attachmentResult = await processAttachments(uploadedFiles);

    const previousMessages = queries.getMessages(conversationId);
    const previousUserMessages = previousMessages.filter((msg) => msg.role === 'user');
    const previousPromptAnalytics = queries.listPromptAnalytics(500, conversationId);
    const analyticsByMessageId = new Map(
      previousPromptAnalytics.map((item) => [item.message_id, item])
    );

    const previousPromptInputs = previousUserMessages.map((msg) => {
      const analytics = analyticsByMessageId.get(msg.id);
      return {
        content: msg.content,
        clusterId: analytics?.duplicate_cluster_id || msg.id,
      };
    });

    if (attachmentResult?.files?.length) {
      for (const file of attachmentResult.files) {
        const storedFile = queries.insertFile(
          conversationId,
          file.filename,
          file.mimetype || null,
          file.size,
          file.kind,
          file.summary || null,
          file.keyPoints.join('\n') || null
        );

        file.chunks.forEach((chunk: string, index: number) => {
          const chunkRecord = queries.insertFileChunk(
            storedFile.id,
            conversationId,
            index,
            chunk,
            estimateTokens(chunk)
          );

          embed(chunk)
            .then((embedding) => {
              if (embedding) {
                queries.insertFileChunkEmbedding(chunkRecord.id, embedding);
              }
            })
            .catch(() => {});
        });
      }
    }

    // Store user message
    const displayMessage = body.message || '[User sent attachments]';
    const userMsg = queries.insertMessage(conversationId, 'user', displayMessage);

    const promptAnalysis = analyzePrompt(displayMessage, previousPromptInputs, {
      hasAttachments: uploadedFiles.length > 0,
      attachmentTextExtracted: Boolean(attachmentResult?.inlineContext),
    });

    const duplicateClusterId = promptAnalysis.duplicate.isDuplicate
      ? promptAnalysis.duplicate.clusterId || previousUserMessages[previousUserMessages.length - 1]?.id || userMsg.id
      : userMsg.id;

    queries.insertPromptAnalytics({
      message_id: userMsg.id,
      conversation_id: conversationId,
      created_at: Date.now(),
      prompt_tokens_raw: promptAnalysis.promptTokensRaw,
      prompt_tokens_sent: promptAnalysis.promptTokensSent,
      score_specificity: promptAnalysis.scores.specificity,
      score_goal_clarity: promptAnalysis.scores.goal_clarity,
      score_constraints: promptAnalysis.scores.constraints,
      score_context_completeness: promptAnalysis.scores.context_completeness,
      score_structure: promptAnalysis.scores.structure,
      score_penalties: promptAnalysis.scores.penalties,
      score_total: promptAnalysis.scores.total,
      duplicate_cluster_id: duplicateClusterId,
      duplicate_similarity: promptAnalysis.duplicate.similarity,
      duplicate_is_duplicate: promptAnalysis.duplicate.isDuplicate ? 1 : 0,
      duplicate_repeat_count: promptAnalysis.duplicate.repeatCount,
      has_attachments: uploadedFiles.length > 0 ? 1 : 0,
      attachment_text_extracted: attachmentResult?.inlineContext ? 1 : 0,
      retry_turn: promptAnalysis.retryTurn ? 1 : 0,
      repair_turn: promptAnalysis.repairTurn ? 1 : 0,
    });

    // Embed the user message (async, don't block)
    embed(displayMessage).then((embedding) => {
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
        displayMessage,
        conversationId,
        systemPrompt,
        queries,
        checkpoint?.summary || null,
        assemblerConfig
      );

      if (attachmentResult?.inlineContext) {
        contextResult.messages.push({ role: 'system', content: attachmentResult.inlineContext });
        const attachmentTokens = estimateTokens(attachmentResult.inlineContext);
        contextResult.tokensRaw += attachmentTokens;
        contextResult.tokensSent += attachmentTokens;
      }

      const fileChunks = await retrieveRelevantFileChunks(displayMessage, conversationId, queries, 6);
      const fileContext = buildFileContextBlock(fileChunks);
      if (fileContext) {
        contextResult.messages.push({ role: 'system', content: fileContext });
        const fileContextTokens = estimateTokens(fileContext);
        contextResult.tokensRaw += fileContextTokens;
        contextResult.tokensSent += fileContextTokens;
      }
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
      attachments_processed: attachmentResult?.count || 0,
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

    const streamFromProvider = async (llmProvider: LLMProvider, llmModel: string) => {
      const stream = llmProvider.chatStream({
        messages: contextResult.messages,
        model: llmModel,
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
    };

    try {
      await streamFromProvider(activeProvider, activeModel);

      fullResponse = sanitizeAssistantText(fullResponse);
    } catch (err: any) {
      const canFallback =
        activeProviderName === 'gemini' &&
        !fullResponse &&
        isGeminiQuotaError(err);

      if (canFallback) {
        const fallbackName = findFallbackProvider(config, activeProviderName);
        if (fallbackName) {
          try {
            const fallbackConfig = config.providers[fallbackName] || {};
            const fallbackProvider = createProvider(fallbackName, fallbackConfig);
            const fallbackModel = fallbackProvider.defaultModel;

            activeProviderName = fallbackName;
            activeProvider = fallbackProvider;
            activeModel = fallbackModel;

            sendSSE(reply, 'meta', {
              conversation_id: conversationId,
              provider: activeProviderName,
              model: activeModel,
              fallback_from: providerName,
            });

            await streamFromProvider(activeProvider, activeModel);
            fullResponse = sanitizeAssistantText(fullResponse);
          } catch (fallbackErr: any) {
            sendSSE(reply, 'error', { message: fallbackErr.message || String(fallbackErr) });
            endSSE(reply);
            return;
          }
        } else {
          sendSSE(reply, 'error', { message: err.message });
          endSSE(reply);
          return;
        }
      } else {
        sendSSE(reply, 'error', { message: err.message });
        endSSE(reply);
        return;
      }
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
      activeProviderName,
      activeModel,
      tokensIn,
      tokensOut,
      tokensSaved
    );

    // Auto-generate title on first message
    const conv = queries.getConversation(conversationId);
    if (conv && !conv.title) {
      try {
        const titleResponse = await activeProvider.chat({
          messages: [
            {
              role: 'system',
              content: 'Generate a short title (max 6 words) for this conversation. Reply with only the title, no quotes.',
            },
            { role: 'user', content: displayMessage },
          ],
          model: activeModel,
          maxTokens: 20,
          temperature: 0.7,
        });
        queries.updateConversation(conversationId, titleResponse.content.trim());
      } catch {
        queries.updateConversation(conversationId, displayMessage.slice(0, 50));
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
        generateCheckpointSummary(chatMessages, activeProvider, activeModel)
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

  // ========== ANALYTICS ==========

  app.get('/api/analytics/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { conversation_id?: string; limit?: string };
    const limit = Math.max(1, Math.min(500, Number(query.limit || 100)));

    const rows = queries.listPromptAnalytics(limit, query.conversation_id);
    return reply.send(rows.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      created_at: row.created_at,
      prompt_tokens_raw: row.prompt_tokens_raw,
      prompt_tokens_sent: row.prompt_tokens_sent,
      scores: {
        specificity: row.score_specificity,
        goal_clarity: row.score_goal_clarity,
        constraints: row.score_constraints,
        context_completeness: row.score_context_completeness,
        structure: row.score_structure,
        penalties: row.score_penalties,
        total: row.score_total,
      },
      duplicate: {
        cluster_id: row.duplicate_cluster_id,
        similarity: row.duplicate_similarity || 0,
        is_duplicate: !!row.duplicate_is_duplicate,
        repeat_count: row.duplicate_repeat_count,
      },
      signals: {
        has_attachments: !!row.has_attachments,
        attachment_text_extracted: !!row.attachment_text_extracted,
        retry_turn: !!row.retry_turn,
        repair_turn: !!row.repair_turn,
      },
    })));
  });

  app.get('/api/analytics/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { window?: string };
    const window = query.window || '7d';
    const rows = queries.listPromptAnalyticsByWindow(toWindowMs(window));
    const improvements = queries.listPromptImprovementsByWindow(toWindowMs(window));

    const previousRows = queries.listPromptAnalyticsByWindow(toWindowMs(window) * 2)
      .filter((row) => row.created_at < Date.now() - toWindowMs(window));

    const avg = (values: number[]) => {
      if (!values.length) return 0;
      return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    };

    const currentScore = avg(rows.map((row) => row.score_total));
    const previousScore = avg(previousRows.map((row) => row.score_total));
    const currentDup = rows.filter((row) => row.duplicate_is_duplicate).length;
    const previousDup = previousRows.filter((row) => row.duplicate_is_duplicate).length;

    const avgRaw = avg(rows.map((row) => row.prompt_tokens_raw));
    const avgSent = avg(rows.map((row) => row.prompt_tokens_sent));
    const compressionRatio = avgRaw > 0 ? Number((avgSent / avgRaw).toFixed(3)) : 1;

    const clusters = new Map<string, number>();
    for (const row of rows) {
      if (!row.duplicate_cluster_id) continue;
      clusters.set(row.duplicate_cluster_id, (clusters.get(row.duplicate_cluster_id) || 0) + 1);
    }

    const topClusters = Array.from(clusters.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([clusterId, count]) => ({ cluster_id: clusterId, count }));

    const tips: Array<{ id: string; title: string; reason: string }> = [];
    if (currentScore < 60) {
      tips.push({
        id: 'add_constraints',
        title: 'Add clearer constraints',
        reason: 'Include format, length, and audience to improve answer precision.',
      });
    }
    if (currentDup >= 3) {
      tips.push({
        id: 'avoid_duplicates',
        title: 'Reduce duplicate prompts',
        reason: 'Reuse a previous good prompt and only update missing details.',
      });
    }
    if (rows.filter((row) => row.score_context_completeness < 10).length >= 3) {
      tips.push({
        id: 'add_context',
        title: 'Add context before asking',
        reason: 'Briefly include project background, desired output, and constraints.',
      });
    }

    const avgImproveScoreDelta = improvements.length
      ? Number((improvements.reduce((sum, item) => sum + item.score_delta, 0) / improvements.length).toFixed(2))
      : 0;
    const usedImprove = improvements.filter((item) => item.used_improved).length;
    const improveUsageRate = improvements.length
      ? Number(((usedImprove / improvements.length) * 100).toFixed(1))
      : 0;
    const llmImproveCount = improvements.filter((item) => item.source === 'llm').length;
    const heuristicImproveCount = improvements.filter((item) => item.source !== 'llm').length;

    return reply.send({
      window,
      health_score: currentScore,
      trend: {
        score_delta: currentScore - previousScore,
        duplicate_delta: currentDup - previousDup,
        efficiency_delta: avgRaw - avgSent,
      },
      efficiency: {
        avg_raw_tokens: avgRaw,
        avg_sent_tokens: avgSent,
        compression_ratio: compressionRatio,
      },
      duplicates: {
        count: currentDup,
        top_clusters: topClusters,
      },
      improvements: {
        total: improvements.length,
        used_count: usedImprove,
        usage_rate: improveUsageRate,
        avg_score_delta: avgImproveScoreDelta,
        source_mix: {
          llm: llmImproveCount,
          heuristic: heuristicImproveCount,
        },
      },
      tips,
    });
  });

  app.post('/api/analytics/improve', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      prompt?: string;
      conversation_id?: string;
      provider?: ProviderName;
      model?: string;
      has_attachments?: boolean;
      attachment_text_extracted?: boolean;
    };

    const prompt = (body.prompt || '').trim();
    if (!prompt) {
      return reply.status(400).send({ error: 'Prompt is required' });
    }

    const conversationId = body.conversation_id;
    const previousPromptInputs: Array<{ content: string; clusterId?: string | null }> = [];

    try {
      if (conversationId) {
        const previousMessages = queries.getMessages(conversationId).filter((msg) => msg.role === 'user');
        const previousPromptAnalytics = queries.listPromptAnalytics(500, conversationId);
        const analyticsByMessageId = new Map(
          previousPromptAnalytics.map((item) => [item.message_id, item])
        );

        for (const msg of previousMessages) {
          const analytics = analyticsByMessageId.get(msg.id);
          previousPromptInputs.push({
            content: msg.content,
            clusterId: analytics?.duplicate_cluster_id || msg.id,
          });
        }
      }

      const config = loadConfig();
      const selectedProvider = body.provider || getDefaultProvider(config);
      let improvedPrompt = '';
      let source: 'llm' | 'heuristic' = 'heuristic';

      if (selectedProvider) {
        try {
          const providerConfig = config.providers[selectedProvider] || {};
          const refiner = createProvider(selectedProvider, providerConfig);
          const activeModel = body.model || refiner.defaultModel;

          const recentContext = conversationId
            ? queries.getMessages(conversationId)
                .slice(-6)
                .map((msg) => `${msg.role}: ${msg.content}`)
                .join('\n')
            : '';

          const refineResponse = await refiner.chat({
            messages: [
              {
                role: 'system',
                content:
                  'You are OpenGauge Prompt Refiner. Rewrite the user prompt to improve clarity and usefulness while preserving intent. Do not add placeholders like [Add context]. Do not add greetings, markdown headers, emojis, or explanations. Output ONLY the improved prompt text.',
              },
              {
                role: 'user',
                content: `Original prompt:\n${prompt}\n\nRecent context (optional):\n${recentContext || 'none'}\n\nReturn only refined prompt. Keep it concise and actionable.`,
              },
            ],
            model: activeModel,
            maxTokens: 260,
            temperature: 0.2,
          });

          improvedPrompt = sanitizeAssistantText(refineResponse.content || '')
            .replace(/^['"`]|['"`]$/g, '')
            .trim();

          if (improvedPrompt) {
            source = 'llm';
          }
        } catch {
          // fall back to heuristic below
        }
      }

      if (!improvedPrompt) {
        improvedPrompt = improvePrompt(prompt, previousPromptInputs, {
          hasAttachments: Boolean(body.has_attachments),
          attachmentTextExtracted: Boolean(body.attachment_text_extracted),
        }).improvedPrompt;
        source = 'heuristic';
      }

      if (!shouldUseImprovedPrompt(prompt, improvedPrompt)) {
        improvedPrompt = prompt;
      }

      const result = buildPromptImprovementResult(prompt, improvedPrompt, previousPromptInputs, {
        hasAttachments: Boolean(body.has_attachments),
        attachmentTextExtracted: Boolean(body.attachment_text_extracted),
      });

      const saved = queries.insertPromptImprovement(
        source,
        result.originalPrompt,
        result.improvedPrompt,
        {
          scoreBefore: result.before.scores.total,
          scoreAfter: result.after.scores.total,
          clarityDelta: result.benefit.clarityDelta,
          duplicateRiskDelta: result.benefit.duplicateRiskDelta,
          tokenSentDelta: result.benefit.tokenSentDelta,
          scoreDelta: result.benefit.scoreDelta,
        },
        conversationId
      );

      return reply.send({
        improvement_id: saved.id,
        source,
        original_prompt: result.originalPrompt,
        improved_prompt: result.improvedPrompt,
        before: result.before,
        after: result.after,
        benefit: result.benefit,
      });
    } catch (err: any) {
      const fallback = improvePrompt(prompt, previousPromptInputs, {
        hasAttachments: Boolean(body.has_attachments),
        attachmentTextExtracted: Boolean(body.attachment_text_extracted),
      });

      const safeImprovedPrompt = shouldUseImprovedPrompt(prompt, fallback.improvedPrompt)
        ? fallback.improvedPrompt
        : prompt;

      const safeFallback = buildPromptImprovementResult(prompt, safeImprovedPrompt, previousPromptInputs, {
        hasAttachments: Boolean(body.has_attachments),
        attachmentTextExtracted: Boolean(body.attachment_text_extracted),
      });

      return reply.send({
        source: 'heuristic',
        warning: `Improve fallback used: ${err?.message || 'unknown error'}`,
        original_prompt: safeFallback.originalPrompt,
        improved_prompt: safeFallback.improvedPrompt,
        before: safeFallback.before,
        after: safeFallback.after,
        benefit: safeFallback.benefit,
      });
    }
  });

  app.post('/api/analytics/improve/use', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { improvement_id?: string };
    if (!body.improvement_id) {
      return reply.status(400).send({ error: 'improvement_id is required' });
    }

    queries.markPromptImprovementUsed(body.improvement_id);
    return reply.send({ success: true });
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
      embedding_mode: getEmbeddingMode(),
      token_usage_summary: tokenUsage,
      timestamp: Date.now(),
    });
  });
}
