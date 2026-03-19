# OpenGauge

Local-first LLM cost tracking and observability. Per-call cost logging, runaway loop detection, circuit breaker, and budget enforcement — all stored in SQLite on your machine.

## Quick Start

```bash
npx opengauge
```

## What it does

- **Per-call cost tracking** — every LLM API call logged with token counts, cost estimates, and latency
- **Runaway loop detection** — trigram similarity catches agents stuck repeating the same call
- **Circuit breaker** — alerts (or blocks) when loops or budget thresholds are breached
- **Budget enforcement** — session, daily, and monthly spend limits
- **Multi-provider** — Anthropic, OpenAI, Google Gemini, Ollama (local)

## Three ways to use it

### 1. Proxy mode — track any LLM tool

Point any tool (Claude Code, Cursor, custom apps) at the proxy to track all API calls:

```bash
npx opengauge watch
```

Then configure your tool to use the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:4000 claude
OPENAI_BASE_URL=http://localhost:4000/v1 your-tool
```

### 2. OpenClaw plugin — track OpenClaw agents

```bash
openclaw plugins install @opengauge/openclaw-plugin
openclaw gateway restart
```

Every LLM call your agent makes is automatically tracked. No code changes needed.

### 3. Chat UI — built-in chat interface

```bash
npx opengauge
```

Opens a local web chat at `http://localhost:3000` with token optimization, context retrieval, and cost tracking built in.

## View stats

```bash
npx opengauge stats                              # all time, all sources
npx opengauge stats --source=proxy               # proxy mode only
npx opengauge stats --source=openclaw            # openclaw plugin only
npx opengauge stats --period=7d                  # last 7 days
npx opengauge stats --model=claude-sonnet-4-6    # specific model
npx opengauge stats --json                       # machine-readable output
```

Example output:

```
  Total Spend
┌──────────────┬─────────┐
│ Total Spend  │ $0.0408 │
│ Tokens In    │ 25.4K   │
│ Tokens Out   │ 203     │
│ Sessions     │ 7       │
│ API Calls    │ 7       │
└──────────────┴─────────┘
```

## Configuration

Create `~/.opengauge/config.yml`:

```yaml
providers:
  anthropic:
    api_key: YOUR_API_KEY
    default_model: claude-sonnet-4-6
  openai:
    api_key: YOUR_API_KEY
    default_model: gpt-4o
  ollama:
    base_url: http://localhost:11434
    default_model: llama3

defaults:
  provider: anthropic

# OpenClaw plugin settings (optional)
openclaw:
  circuit_breaker:
    enabled: true
    similarity_threshold: 0.8
    max_similar_calls: 5
    action: warn            # warn | block
  budget:
    session_limit_usd: 5.00
    daily_limit_usd: 20.00
    monthly_limit_usd: 400.00
```

## Supported models

| Provider | Models | Input/1M | Output/1M |
|----------|--------|----------|-----------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | $0.80–$15 | $4–$75 |
| OpenAI | gpt-4o, gpt-4o-mini, o1, o3-mini | $0.15–$15 | $0.60–$60 |
| Google | gemini-2.0-flash, gemini-1.5-pro | $0.075–$1.25 | $0.30–$5 |
| Ollama | Any local model | Free | Free |

## Data storage

Everything local at `~/.opengauge/`:

```
config.yml       — configuration
opengauge.db     — SQLite database (sessions, interactions, alerts)
error.log        — error log for debugging
```

## Packages

| Package | Description |
|---------|-------------|
| [opengauge](https://www.npmjs.com/package/opengauge) | Core CLI — chat UI, proxy mode, stats |
| [@opengauge/openclaw-plugin](https://www.npmjs.com/package/@opengauge/openclaw-plugin) | OpenClaw agent observability plugin |

## Developer setup

```bash
git clone https://github.com/applytorque/opengauge.git
cd opengauge
npm install
npm run build
npm start
```

## Docs

See [docs/GUIDE.md](docs/GUIDE.md) for the full setup and usage guide.

## License

MIT
