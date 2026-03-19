# @opengauge/openclaw-plugin

PromptOps observability for [OpenClaw](https://openclaw.ai) agents. Wraps every LLM provider call via `registerProvider` to give you per-call cost tracking, runaway loop detection, circuit breaker protection, and budget enforcement — without modifying your agent.

## Install

```bash
openclaw plugins install @opengauge/openclaw-plugin
```

Or manually:

```bash
npm install @opengauge/openclaw-plugin
```

## What it does

Once installed, the plugin transparently wraps your OpenClaw agent's LLM provider:

- **Per-call cost tracking** — every API call logged to `~/.opengauge/data.db` with token counts, cost estimates, and latency
- **Runaway loop detection** — trigram Jaccard similarity detects when your agent is stuck making the same call repeatedly
- **Circuit breaker** — optionally blocks calls when runaway loops or budget thresholds are breached
- **Budget enforcement** — session, daily, and monthly spend limits
- **Fail-safe** — if anything in OpenGauge fails, your agent is unaffected. Errors are logged to `~/.opengauge/error.log`

## Configuration

Create or edit `~/.opengauge/config.yml`:

```yaml
openclaw:
  circuit_breaker:
    enabled: true
    similarity_threshold: 0.8
    max_similar_calls: 5
    action: warn          # warn | block
  budget:
    session_limit_usd: 5.00
    daily_limit_usd: 20.00
    monthly_limit_usd: 400.00
  optimize: false
  log_response_text: true
  log_full_request: false
```

## View stats

From within OpenClaw:
```
opengauge-stats
```

Or from the terminal:
```bash
npx opengauge stats --source=openclaw
```

## How it works

The plugin uses OpenClaw's `registerProvider` API to wrap the active LLM provider. Every individual LLM call — including multi-call tool-use loops within a single agent turn — is intercepted, logged, analyzed, and forwarded. The agent never knows OpenGauge is there.

## License

MIT
