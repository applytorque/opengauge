# Using OpenGauge with OpenClaw

OpenGauge ships a first-class OpenClaw plugin (`@opengauge/openclaw-plugin`) that wraps every LLM call your agent makes — giving you per-call cost tracking, runaway loop detection, and budget enforcement without touching your agent code.

## How it works

OpenClaw's `registerProvider` API lets plugins intercept every LLM call. The OpenGauge plugin wraps your active provider transparently: your agent code is unchanged, but every API call is logged to a local SQLite database at `~/.opengauge/opengauge.db`.

```
your agent → OpenClaw → [OpenGauge plugin] → real LLM provider
                                ↓
                        ~/.opengauge/opengauge.db
```

## Installation

Install the plugin from ClawHub:

```bash
openclaw plugins install @opengauge/openclaw-plugin
```

That's it. The plugin auto-registers on the next OpenClaw session.

## What you get out of the box

Once installed, every LLM call is automatically:

- **Logged** — prompt, response (optional), token counts, latency, cost
- **Tracked** — running session cost, daily spend, tokens saved
- **Protected** — circuit breaker fires if a runaway loop is detected

No config file required. Defaults are conservative and safe.

## Configuration

All settings are optional. Create `~/.opengauge/config.yml` to override defaults:

```yaml
openclaw:
  # Runaway loop detection
  circuit_breaker:
    enabled: true
    similarity_threshold: 0.8   # 0–1; how similar prompts must be to count
    max_similar_calls: 5        # trips after this many similar calls in a row
    escalation_check: true      # also watch for escalating token counts
    action: warn                # "warn" logs an alert; "block" stops the call

  # Spend limits
  budget:
    session_limit_usd: 5.00
    daily_limit_usd: 20.00
    monthly_limit_usd: 400.00

  # Logging
  log_response_text: true       # store assistant response text in DB
  log_full_request: false       # store full message array (verbose)
  session_timeout_ms: 300000    # new session after 5 min idle (default)

  optimize: false               # reserved for future token optimization pass
```

### Circuit breaker actions

| `action` | Behaviour |
|----------|-----------|
| `warn`   | Writes a `critical` alert to the DB and logs to `~/.opengauge/error.log`; the call still goes through |
| `block`  | Returns a synthetic error response to the agent immediately, stopping the loop |

Start with `warn` to understand your agent's patterns before enabling `block`.

### Budget enforcement

When a session, daily, or monthly limit is hit, the plugin writes a `budget_breach` alert. If `action` is `block`, the call is also stopped. Daily and monthly totals are computed from the SQLite database, so they persist across OpenClaw restarts.

## Viewing stats during a session

The plugin registers an `opengauge-stats` command in OpenClaw. Run it from the OpenClaw REPL at any time:

```
> opengauge-stats
--- OpenGauge Stats ---
Sessions: 12
Total spend: $1.2340
Tokens: 148,200 in / 34,100 out
Tokens saved: 8,400

--- Active Alerts ---
[WARNING] runaway_loop: 4 similar prompts detected in last 8 calls
```

## Full analytics dashboard

Outside of OpenClaw, you can run the full terminal dashboard:

```bash
npx opengauge stats
npx opengauge stats --period=7d --source=openclaw --alerts
npx opengauge stats --json   # machine-readable output
```

The `--source=openclaw` flag filters to sessions created by the plugin only.

## Where data lives

| Path | Contents |
|------|----------|
| `~/.opengauge/opengauge.db` | All sessions, interactions, alerts |
| `~/.opengauge/config.yml` | Plugin configuration |
| `~/.opengauge/error.log` | Plugin errors (plugin never crashes OpenClaw) |

The plugin is **fail-safe**: if anything inside the wrapper throws, it falls back to the real provider directly and logs the error. Your agent will never be broken by the plugin.

## Uninstalling

```bash
openclaw plugins remove @opengauge/openclaw-plugin
```

Your existing data in `~/.opengauge/opengauge.db` is preserved.
