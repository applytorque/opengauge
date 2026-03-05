import {
  html,
  render,
  useState,
  useEffect,
  useRef,
  useCallback,
} from './vendor.js';

// ============ API Helpers ============

const api = {
  async getConversations() {
    const res = await fetch('/api/conversations');
    return res.json();
  },

  async getConversation(id) {
    const res = await fetch(`/api/conversations/${id}`);
    return res.json();
  },

  async deleteConversation(id) {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  },

  async getTokenUsage() {
    const res = await fetch('/api/token-usage');
    return res.json();
  },

  async getConfig() {
    const res = await fetch('/api/config');
    return res.json();
  },

  async saveConfig(config) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  async getHealth() {
    const res = await fetch('/api/health');
    return res.json();
  },

  async getAnalyticsSummary(window = '7d') {
    const res = await fetch(`/api/analytics/summary?window=${encodeURIComponent(window)}`);
    return res.json();
  },

  async getAnalyticsMessages(limit = 100, conversationId = null) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (conversationId) params.set('conversation_id', conversationId);
    const res = await fetch(`/api/analytics/messages?${params.toString()}`);
    return res.json();
  },

  async improvePrompt(prompt, conversationId, provider, model, hasAttachments = false, attachmentTextExtracted = false) {
    const res = await fetch('/api/analytics/improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        conversation_id: conversationId,
        provider,
        model,
        has_attachments: hasAttachments,
        attachment_text_extracted: attachmentTextExtracted,
      }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const message = (data && (data.error || data.message || data.warning)) || `Request failed (${res.status})`;
      throw new Error(message);
    }

    if (!data || !data.improved_prompt) {
      throw new Error('Improve service returned an invalid response');
    }

    return data;
  },

  async markImproveUsed(improvementId) {
    if (!improvementId) return;
    await fetch('/api/analytics/improve/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ improvement_id: improvementId }),
    });
  },

  sendMessage(message, conversationId, provider, model) {
    return this.sendMessageWithFiles(message, conversationId, provider, model, []);
  },

  sendMessageWithFiles(message, conversationId, provider, model, files) {
    if (files && files.length > 0) {
      const form = new FormData();
      form.append('message', message || '');
      if (conversationId) form.append('conversation_id', conversationId);
      if (provider) form.append('provider', provider);
      if (model) form.append('model', model);
      for (const file of files) {
        form.append('attachments', file, file.name);
      }

      return fetch('/api/chat', {
        method: 'POST',
        body: form,
      });
    }

    return fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        conversation_id: conversationId,
        provider,
        model,
      }),
    });
  },
};

function tokenizePrompt(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isGreetingPrompt(text) {
  const normalized = (text || '').trim().toLowerCase();
  const basic = [
    'hey', 'hi', 'hello', 'yo', 'sup', 'hola',
    'good morning', 'good afternoon', 'good evening',
  ];
  if (basic.includes(normalized)) return true;

  const greetingPattern = /^(hey+|hi+|hello+|yo+|sup+|hola+)[!.?]*$/i;
  return greetingPattern.test((text || '').trim());
}

function isLowIntentPrompt(text) {
  const normalized = (text || '').trim().toLowerCase();
  const lowIntent = new Set([
    'ok', 'okay', 'k', 'kk', 'sure', 'yep', 'yes', 'yup', 'cool', 'great',
    'nice', 'done', 'thanks', 'thank you', 'thx',
  ]);

  if (lowIntent.has(normalized)) return true;
  return /^(ok(ay)?|k+|sure|yep|yes|yup|cool|great|nice|done|thx|thanks|thank\s+you)[!.?]*$/i.test((text || '').trim());
}

function shouldUseAutoImprovedPrompt(originalPrompt, improvedPrompt) {
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

// ============ SSE Parser ============

async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            yield { event: currentEvent || 'data', data: JSON.parse(data) };
          } catch {
            // skip
          }
          currentEvent = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============ Components ============

function SetupWizard({ onComplete, onSkip }) {
  const [provider, setProvider] = useState('ollama');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const defaults = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    gemini: 'gemini-2.0-flash',
    ollama: 'llama3',
  };

  const handleSave = async () => {
    const config = {
      providers: {
        [provider]: {
          ...(apiKey ? { api_key: apiKey } : {}),
          default_model: model || defaults[provider],
        },
      },
      defaults: { provider },
    };
    await api.saveConfig(config);
    onComplete();
  };

  return html`
    <div class="wizard-overlay">
      <div class="wizard">
        <h2>⚡ Welcome to OpenGauge</h2>
        <p>Configure your LLM provider to get started. You can change this later in settings.</p>

        <div class="form-group">
          <label>Provider</label>
          <select value=${provider} onChange=${(e) => { setProvider(e.target.value); setModel(''); }}>
            <option value="ollama">Ollama (Local)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </div>

        ${provider !== 'ollama' ? html`
          <div class="form-group">
            <label>API Key</label>
            <input
              type="password"
              placeholder="Enter your API key"
              value=${apiKey}
              onInput=${(e) => setApiKey(e.target.value)}
            />
          </div>
        ` : html`
          <div class="form-group">
            <label>Base URL</label>
            <input
              type="text"
              placeholder="http://localhost:11434"
              value="http://localhost:11434"
              disabled
            />
          </div>
        `}

        <div class="form-group">
          <label>Model</label>
          <input
            type="text"
            placeholder=${defaults[provider]}
            value=${model}
            onInput=${(e) => setModel(e.target.value)}
          />
        </div>

        <div class="actions">
          <button class="btn-secondary" onClick=${onSkip}>Skip</button>
          <button class="btn-primary" onClick=${handleSave}>Save & Start</button>
        </div>
      </div>
    </div>
  `;
}

function Sidebar({ conversations, activeId, onSelect, onNew, onDelete, onSettings, onAnalytics, analyticsActive }) {
  return html`
    <div class="sidebar">
      <div class="sidebar-header">
        <h1>
          <img class="brand-logo" src="/assets/opengauge-logo.png" alt="OpenGauge" />
          <span>OpenGauge</span>
        </h1>
        <button class="new-chat-btn" onClick=${onNew}>+ New</button>
      </div>

      <div class="conversation-list">
        ${conversations.map((conv) => html`
          <div
            key=${conv.id}
            class="conversation-item ${conv.id === activeId ? 'active' : ''}"
            onClick=${() => onSelect(conv.id)}
          >
            <span class="title">${conv.title || 'New Conversation'}</span>
            <button
              class="delete-btn"
              onClick=${(e) => { e.stopPropagation(); onDelete(conv.id); }}
            >✕</button>
          </div>
        `)}

        ${conversations.length === 0 ? html`
          <div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;">
            No conversations yet
          </div>
        ` : null}
      </div>

      <div class="sidebar-footer">
        <button
          class="settings-btn"
          style=${analyticsActive ? 'margin-bottom: 8px; border-color: var(--accent); color: var(--text-primary);' : 'margin-bottom: 8px;'}
          onClick=${onAnalytics}
        >📊 Analytics</button>
        <button class="settings-btn" onClick=${onSettings}>⚙ Settings</button>
      </div>
    </div>
  `;
}

function TokenMeter({ tokensRaw, tokensSent, saved }) {
  const healthLevel = saved > 30 ? '' : saved > 15 ? 'warning' : tokensSent > 0 ? 'danger' : '';

  return html`
    <div class="token-meter">
      <div class="token-stat">
        <span class="label">Raw:</span>
        <span class="value">${tokensRaw.toLocaleString()}</span>
      </div>
      <div class="token-stat sent">
        <span class="label">Sent:</span>
        <span class="value">${tokensSent.toLocaleString()}</span>
      </div>
      <div class="token-stat saved">
        <span class="label">Saved:</span>
        <span class="value">${saved}%</span>
      </div>
      <div class="health-indicator ${healthLevel}" title="Context health"></div>
    </div>
  `;
}

function ChatMessage({ msg }) {
  return html`
    <div class="message ${msg.role}">
      <div class="role">${msg.role}</div>
      <div class="content">${msg.content}</div>
      ${msg.tokens_raw ? html`
        <div class="meta">
          ${msg.tokens_raw} tokens raw → ${msg.tokens_sent || msg.tokens_raw} sent
        </div>
      ` : null}
    </div>
  `;
}

function EmptyState() {
  return html`
    <div class="empty-state">
      <img class="logo" src="/assets/opengauge-logo.png" alt="OpenGauge logo" />
      <h2>OpenGauge</h2>
      <p>A token-efficient LLM chat interface. Every token counts: compress before sending, retrieve instead of stuffing.</p>
    </div>
  `;
}

function AnalyticsView({ summary, rows, loading, onRefresh }) {
  if (loading) {
    return html`
      <div class="empty-state">
        <h2>Loading analytics...</h2>
      </div>
    `;
  }

  if (!summary) {
    return html`
      <div class="empty-state">
        <h2>No analytics yet</h2>
        <p>Send a few prompts to generate coaching insights.</p>
      </div>
    `;
  }

  return html`
    <div class="chat-area" style="gap: 12px;">
      <div class="message" style="max-width: 900px;">
        <div class="role" style="color: var(--accent);">Prompt Health</div>
        <div class="content">Score: <b>${summary.health_score}</b>/100</div>
        <div class="meta">Score delta: ${summary.trend?.score_delta || 0} | Duplicate delta: ${summary.trend?.duplicate_delta || 0}</div>
      </div>

      <div class="message" style="max-width: 900px;">
        <div class="role" style="color: var(--warning);">Efficiency</div>
        <div class="content">Avg raw: ${summary.efficiency?.avg_raw_tokens || 0} tokens | Avg sent: ${summary.efficiency?.avg_sent_tokens || 0} tokens | Ratio: ${summary.efficiency?.compression_ratio || 1}</div>
      </div>

      <div class="message" style="max-width: 900px;">
        <div class="role" style="color: var(--accent);">Improve Impact</div>
        <div class="content">
          Total improves: ${summary.improvements?.total || 0}
          | Used: ${summary.improvements?.used_count || 0} (${summary.improvements?.usage_rate || 0}%)
          | Avg score delta: ${summary.improvements?.avg_score_delta || 0}
        </div>
        <div class="meta">Source mix — LLM: ${summary.improvements?.source_mix?.llm || 0}, Heuristic: ${summary.improvements?.source_mix?.heuristic || 0}</div>
      </div>

      <div class="message" style="max-width: 900px;">
        <div class="role" style="color: var(--success);">Coaching Tips</div>
        <div class="content">
          ${(summary.tips && summary.tips.length > 0)
            ? summary.tips.map((tip) => `• ${tip.title} — ${tip.reason}`).join('\n')
            : '• Great quality prompts overall. Keep adding context and format constraints.'}
        </div>
      </div>

      <div class="message" style="max-width: 900px;">
        <div class="role" style="color: var(--text-secondary);">Recent Prompt Scores</div>
        <div class="content">
          ${(rows || []).slice(0, 12).map((row, index) => `${index + 1}. score ${row.scores?.total || 0} | duplicate: ${row.duplicate?.is_duplicate ? 'yes' : 'no'} | tokens ${row.prompt_tokens_raw || 0}→${row.prompt_tokens_sent || 0}`).join('\n') || 'No rows yet'}
        </div>
      </div>

      <div style="max-width: 900px; margin: 0 auto; width: 100%;">
        <button class="send-btn" onClick=${onRefresh}>Refresh Analytics</button>
      </div>
    </div>
  `;
}

// ============ Main App ============

function App() {
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [tokenStats, setTokenStats] = useState({ raw: 0, sent: 0, saved: 0 });
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [configuredProviders, setConfiguredProviders] = useState({});
  const [uiError, setUiError] = useState('');
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [analyticsSummary, setAnalyticsSummary] = useState(null);
  const [analyticsRows, setAnalyticsRows] = useState([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [improveLoading, setImproveLoading] = useState(false);
  const [improvePreview, setImprovePreview] = useState(null);
  const [autoImproveEnabled, setAutoImproveEnabled] = useState(() => {
    try {
      return localStorage.getItem('opengauge:autoImprove') === '1';
    } catch {
      return false;
    }
  });

  const providerDefaults = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    gemini: 'gemini-2.0-flash',
    ollama: 'llama3',
  };

  const chatEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
    checkConfig();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    try {
      localStorage.setItem('opengauge:autoImprove', autoImproveEnabled ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }, [autoImproveEnabled]);

  const loadConversations = async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs);
    } catch {
      // server might not be ready
    }
  };

  const checkConfig = async () => {
    try {
      const config = await api.getConfig();
      const providers = config.providers || {};
      setConfiguredProviders(providers);
      if (!config.providers || Object.keys(config.providers).length === 0) {
        setShowWizard(true);
      } else {
        const firstProvider = Object.keys(config.providers)[0];
        setProvider(firstProvider);
        setModel(config.providers[firstProvider]?.default_model || '');
      }
    } catch {
      setShowWizard(true);
    }
  };

  const isProviderReady = useCallback((providerName) => {
    if (providerName === 'ollama') return true;
    const cfg = configuredProviders?.[providerName];
    return Boolean(cfg?.api_key);
  }, [configuredProviders]);

  const getProviderDefaultModel = useCallback((providerName) => {
    const configured = configuredProviders?.[providerName]?.default_model;
    return configured || providerDefaults[providerName] || '';
  }, [configuredProviders]);

  const selectConversation = async (id) => {
    setShowAnalytics(false);
    setActiveConvId(id);
    try {
      const conv = await api.getConversation(id);
      setMessages(conv.messages || []);
      setProvider(conv.provider);
      setModel(conv.model);
    } catch {
      setMessages([]);
    }
  };

  const newConversation = () => {
    setShowAnalytics(false);
    setActiveConvId(null);
    setMessages([]);
    setImprovePreview(null);
  };

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const [summary, rows] = await Promise.all([
        api.getAnalyticsSummary('7d'),
        api.getAnalyticsMessages(120),
      ]);
      setAnalyticsSummary(summary);
      setAnalyticsRows(rows || []);
    } catch {
      setAnalyticsSummary(null);
      setAnalyticsRows([]);
    }
    setAnalyticsLoading(false);
  }, []);

  const openAnalytics = useCallback(async () => {
    setShowAnalytics(true);
    await loadAnalytics();
  }, [loadAnalytics]);

  const deleteConversation = async (id) => {
    await api.deleteConversation(id);
    if (activeConvId === id) {
      setActiveConvId(null);
      setMessages([]);
    }
    loadConversations();
  };

  const sendMessage = useCallback(async () => {
    if ((!input.trim() && selectedFiles.length === 0) || isStreaming) return;

    if (!isProviderReady(provider)) {
      setUiError(`${provider} is not configured. Add API key in Settings, then try again.`);
      return;
    }

    const userMessage = input.trim();
    let finalUserMessage = userMessage;
    const files = selectedFiles;
    setUiError('');
    setImprovePreview(null);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
    setSelectedFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setIsStreaming(true);

    if (autoImproveEnabled && userMessage && !isGreetingPrompt(userMessage) && !isLowIntentPrompt(userMessage)) {
      try {
        setImproveLoading(true);
        const autoImproved = await api.improvePrompt(
          userMessage,
          activeConvId,
          provider,
          model,
          files.length > 0,
          false
        );
        if (autoImproved?.improved_prompt && shouldUseAutoImprovedPrompt(userMessage, autoImproved.improved_prompt)) {
          finalUserMessage = autoImproved.improved_prompt;
          if (autoImproved?.improvement_id) {
            try {
              await api.markImproveUsed(autoImproved.improvement_id);
            } catch {
              // non-blocking
            }
          }
        }
      } catch {
        // Continue with original prompt if auto improve fails
      } finally {
        setImproveLoading(false);
      }
    }

    // Add user message to UI
    const attachmentLine = files.length
      ? `\n\n[Attached: ${files.map((f) => f.name).join(', ')}]`
      : '';
    setMessages((prev) => [...prev, {
      role: 'user',
      content: `${finalUserMessage || '[User sent attachments]'}${attachmentLine}`,
    }]);

    // Add placeholder for assistant
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      const response = await api.sendMessageWithFiles(finalUserMessage, activeConvId, provider, model, files);

      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const errorBody = await response.json();
          if (errorBody?.error) message = errorBody.error;
        } catch {
          // Ignore parse errors for non-JSON error responses
        }
        throw new Error(message);
      }

      let fullContent = '';
      for await (const { event, data } of parseSSE(response)) {
        if (event === 'meta') {
          if (!activeConvId && data.conversation_id) {
            setActiveConvId(data.conversation_id);
          }
          setTokenStats({
            raw: data.tokens_raw || 0,
            sent: data.tokens_sent || 0,
            saved: data.savings_percent || 0,
          });
        } else if (event === 'content') {
          fullContent += data.text;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: fullContent };
            return updated;
          });
        } else if (event === 'done') {
          setTokenStats((prev) => ({
            ...prev,
            tokensIn: data.tokens_in,
            tokensOut: data.tokens_out,
          }));
        } else if (event === 'error') {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: 'assistant',
              content: `Error: ${data.message}`,
            };
            return updated;
          });
        }
      }

      loadConversations();
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `Error: ${err.message}`,
        };
        return updated;
      });
    }

    setIsStreaming(false);
  }, [
    input,
    selectedFiles,
    isStreaming,
    activeConvId,
    provider,
    model,
    isProviderReady,
    autoImproveEnabled,
  ]);

  const onImprovePrompt = useCallback(async () => {
    const userMessage = input.trim();
    if (!userMessage || isStreaming || improveLoading) return;

    setImproveLoading(true);
    try {
      const result = await api.improvePrompt(
        userMessage,
        activeConvId,
        provider,
        model,
        selectedFiles.length > 0,
        false
      );

      if (result?.improved_prompt) {
        setImprovePreview(result);
      } else if (result?.error) {
        setUiError(result.error);
      }
    } catch (err) {
      setUiError(`Improve failed: ${err?.message || 'network error'}`);
    }
    setImproveLoading(false);
  }, [input, isStreaming, improveLoading, activeConvId, provider, model, selectedFiles]);

  const onPickFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    setSelectedFiles((prev) => [...prev, ...picked].slice(0, 8));
  };

  const removeFile = (index) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea
  const handleInput = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    const maxHeight = 200;
    const nextHeight = Math.min(e.target.scrollHeight, maxHeight);
    e.target.style.height = nextHeight + 'px';
    e.target.style.overflowY = e.target.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  return html`
    ${showWizard ? html`
      <${SetupWizard}
        onComplete=${() => { setShowWizard(false); checkConfig(); }}
        onSkip=${() => setShowWizard(false)}
      />
    ` : null}

    ${showSettings ? html`
      <${SetupWizard}
        onComplete=${() => { setShowSettings(false); checkConfig(); }}
        onSkip=${() => setShowSettings(false)}
      />
    ` : null}

    <div class="layout">
      <${Sidebar}
        conversations=${conversations}
        activeId=${activeConvId}
        onSelect=${selectConversation}
        onNew=${newConversation}
        onDelete=${deleteConversation}
        onSettings=${() => setShowSettings(true)}
        onAnalytics=${openAnalytics}
        analyticsActive=${showAnalytics}
      />

      <div class="main">
        <div class="header">
          <div class="model-selector">
            <select
              value=${provider}
              onChange=${(e) => {
                const nextProvider = e.target.value;
                setProvider(nextProvider);
                setModel(getProviderDefaultModel(nextProvider));
                setUiError('');
              }}
            >
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
            <input
              type="text"
              style="background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 180px; outline: none;"
              placeholder="model name"
              value=${model}
              onInput=${(e) => setModel(e.target.value)}
            />
          </div>

          <${TokenMeter}
            tokensRaw=${tokenStats.raw}
            tokensSent=${tokenStats.sent}
            saved=${tokenStats.saved}
          />
        </div>

        ${showAnalytics ? html`
          <${AnalyticsView}
            summary=${analyticsSummary}
            rows=${analyticsRows}
            loading=${analyticsLoading}
            onRefresh=${loadAnalytics}
          />
        ` : html`
          <div class="chat-area">
            ${messages.length === 0 ? html`<${EmptyState} />` : null}

            ${messages.map((msg, i) => html`
              <${ChatMessage} key=${i} msg=${msg} />
            `)}

            <div ref=${chatEndRef} />
          </div>

          <div class="input-area">
          ${uiError ? html`
            <div style="max-width: 800px; margin: 0 auto 10px auto; color: var(--danger); font-size: 13px;">
              ${uiError}
            </div>
          ` : null}

          ${selectedFiles.length > 0 ? html`
            <div style="max-width: 800px; margin: 0 auto 10px auto; display: flex; flex-wrap: wrap; gap: 6px;">
              ${selectedFiles.map((file, index) => html`
                <span style="background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-secondary); padding: 4px 8px; border-radius: 999px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
                  ${file.name}
                  <button
                    style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px;"
                    onClick=${() => removeFile(index)}
                  >✕</button>
                </span>
              `)}
            </div>
          ` : null}

          ${improvePreview ? html`
            <div style="max-width: 800px; margin: 0 auto 10px auto; border: 1px solid var(--border); background: var(--bg-secondary); border-radius: 8px; padding: 12px;">
              <div style="font-size: 13px; color: var(--accent); margin-bottom: 6px; font-weight: 600;">Improved Prompt Preview</div>
              <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">Source: ${improvePreview.source || 'heuristic'}</div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; white-space: pre-wrap;">${improvePreview.improved_prompt}</div>
              <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 10px;">
                Score: ${improvePreview.before?.scores?.total || 0} → ${improvePreview.after?.scores?.total || 0}
                &nbsp;|&nbsp; Clarity: ${improvePreview.benefit?.clarityDelta >= 0 ? '+' : ''}${improvePreview.benefit?.clarityDelta || 0}
                &nbsp;|&nbsp; Duplicate risk: ${Number(improvePreview.benefit?.duplicateRiskDelta || 0).toFixed(3)}
                &nbsp;|&nbsp; Token sent delta: ${improvePreview.benefit?.tokenSentDelta >= 0 ? '+' : ''}${improvePreview.benefit?.tokenSentDelta || 0}
              </div>
              <div style="display: flex; gap: 8px;">
                <button
                  class="send-btn"
                  style="height: 36px; padding: 6px 12px;"
                  onClick=${async () => {
                    try {
                      await api.markImproveUsed(improvePreview.improvement_id);
                    } catch {
                      // non-blocking
                    }
                    setInput(improvePreview.improved_prompt || input);
                    setImprovePreview(null);
                    if (textareaRef.current) {
                      textareaRef.current.style.height = 'auto';
                      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
                    }
                  }}
                >Use Improved</button>
                <button
                  class="send-btn"
                  style="height: 36px; padding: 6px 12px; background: var(--bg-tertiary); color: var(--text-primary);"
                  onClick=${() => setImprovePreview(null)}
                >Keep Original</button>
              </div>
            </div>
          ` : null}

          <div class="input-container">
            <input
              ref=${fileInputRef}
              type="file"
              multiple
              style="display:none"
              onChange=${onPickFiles}
            />
            <button
              class="send-btn"
              style="background: var(--bg-tertiary); color: var(--text-primary);"
              onClick=${() => fileInputRef.current && fileInputRef.current.click()}
              disabled=${isStreaming}
              title="Attach files"
            >
              Attach
            </button>
            <textarea
              ref=${textareaRef}
              placeholder="Send a message... (Shift+Enter for new line)"
              value=${input}
              onInput=${handleInput}
              onKeyDown=${handleKeyDown}
              rows="1"
              disabled=${isStreaming}
            />
            <button
              class="send-btn"
              style="background: var(--bg-tertiary); color: var(--text-primary);"
              onClick=${onImprovePrompt}
              disabled=${isStreaming || improveLoading || !input.trim()}
            >
              ${improveLoading ? 'Improving...' : 'Improve'}
            </button>
            <button
              class="send-btn"
              style="background: ${autoImproveEnabled ? 'var(--accent)' : 'var(--bg-tertiary)'}; color: ${autoImproveEnabled ? '#fff' : 'var(--text-primary)'};"
              onClick=${() => setAutoImproveEnabled((prev) => !prev)}
              disabled=${isStreaming || improveLoading}
              title="Automatically improve your prompt before sending"
            >
              ${autoImproveEnabled ? 'Auto Improve: On' : 'Auto Improve: Off'}
            </button>
            <button
              class="send-btn"
              onClick=${sendMessage}
              disabled=${isStreaming || (!input.trim() && selectedFiles.length === 0)}
            >
              ${isStreaming ? 'Sending...' : 'Send'}
            </button>
          </div>
          </div>
        `}
      </div>
    </div>
  `;
}

// ============ Mount ============
render(html`<${App} />`, document.getElementById('app'));
