
OPENGAUGE
PromptOps Implementation Blueprint

From Chat UI to PromptOps Observability Platform




Document Type
Technical Implementation Specification
Classification
Internal / Founders Only
Version
1.0
Author
Tushar Sengar / Vega IoT


1. Executive Summary
OpenGauge is currently a local chat UI that allows developers to interact with LLMs using their own API keys, with built-in prompt auto-improvement and token efficiency tracking. This document defines the complete implementation plan to transform OpenGauge from a standalone chat tool into the definitive PromptOps observability and optimization platform for the agentic AI era — starting with the largest autonomous AI agent ecosystem in the world.

Core Thesis
As LLMs grow in power, fragmentation, and usage volume, the need for a cross-model observability and optimization layer grows proportionally. OpenGauge is designed so that every advancement in the LLM ecosystem automatically expands our product’s surface area and value. The rise of autonomous agent frameworks — particularly OpenClaw (320K+ GitHub stars, 13K+ community skills, backed by NVIDIA, AMD, and AWS) — creates an urgent, unsolved need for cost governance, runaway detection, and session-level observability that OpenGauge is uniquely positioned to fill.

Revised Positioning
OpenGauge does not compete with agent frameworks like OpenClaw. It builds on top of them. OpenClaw is the "operating system" for personal AI agents — it connects LLMs to messaging channels, browser automation, cron jobs, and 13K+ skills. OpenGauge is the cost, quality, and governance layer that makes those agents observable and controllable. These are complementary, not competing. The one-liner:

"OpenGauge: The cost, quality, and governance layer for every AI agent — starting with the biggest one."

The OpenClaw Opportunity
OpenClaw’s biggest unsolved problem is exactly what OpenGauge solves. Agents run 24/7 burning tokens with zero visibility into spend. A Meta executive reported her agent wiped her entire email account — there was no observability layer to detect the runaway behavior. Security researchers found prompt injection flaws and data exfiltration risks — an audit layer watching API calls could detect anomalous patterns. Users who installed OpenClaw are paying to have it removed because they couldn’t control or understand what their agents were doing. Every one of these problems maps directly to OpenGauge’s architecture: cost tracking, runaway loop detection, context degradation alerts, session replay, and governance dashboards.

What OpenClaw Can’t Easily Replicate
OpenClaw is about agent capabilities — connecting to services, executing tasks, managing identity. It has no incentive to deeply invest in: cross-model optimization profiles, context lifecycle management with degradation detection, aggregated cost analytics and team governance dashboards, or the data flywheel from observing millions of LLM interactions across multiple tools. These are deeply specialized capabilities that require focused investment. They’re infrastructure concerns, not feature concerns — they’re not on OpenClaw’s roadmap.

What OpenGauge Should Leverage, Not Rebuild
Don’t rebuild what OpenClaw already has: multi-channel messaging, browser automation, cron/scheduling, identity management, the skill ecosystem, community momentum. OpenGauge consumes OpenClaw’s infrastructure; it doesn’t compete with it.


1.1 Strategic Positioning
OpenGauge does not compete with LLM providers, IDE agents, or agent frameworks. It occupies a complementary layer that becomes more essential as these tools proliferate. The positioning can be summarized as:

Market Force
Effect on Developers
OpenGauge Opportunity
More LLM models launching
Fragmented prompt strategies, no unified view
Cross-model optimization profiles and unified analytics
Cheaper tokens
Higher usage volume, more waste at scale
Cost analytics and waste detection become critical
Longer context windows
Context degradation harder to detect
Context lifecycle management and garbage collection
Agentic workflows (multi-step)
Compounding inefficiency per step
Session-level observability and optimization
IDE-integrated agents
Opaque AI spend, zero visibility
Audit layer sitting alongside, not in the path
Autonomous agent frameworks (OpenClaw, etc.)
24/7 token burn with zero governance, runaway loops, rogue agents
Circuit breaker, cost caps, per-call observability via registerProvider plugin


1.2 Transformation Summary
The transformation is additive — the existing chat UI is preserved and enhanced, not replaced. Each phase builds on the previous one, creating compounding value. The phasing has been revised to prioritize the OpenClaw integration as the primary distribution and adoption channel:

Phase
What Gets Built
Value Unlock
Phase 1
Extract @opengauge/core SDK + structured session logging
Reusable engine: DB layer, cost calculator, circuit breaker — consumable by any integration
Phase 2
@opengauge/openclaw-plugin via registerProvider
Every LLM call in OpenClaw logged with per-call cost tracking, runaway loop detection, circuit breaker. Instant distribution to 320K+ potential users via ClawHub
Phase 3
opengauge stats CLI + passive insights engine
Degradation detection, cost alerts, loop detection, budget controls — the governance layer OpenClaw users are asking for
Phase 4
Proxy watch mode for IDE agents + optimization
Extend beyond OpenClaw to Claude Code, Cursor, Copilot. Auto-improve prompts. Cross-platform positioning
Phase 5
Team cloud dashboard + monetization
Engineering org-level governance, paid tier. Users who discover OpenGauge through OpenClaw bring it to their other tools

Ship Order Rationale
Phase 1 (SDK extraction) must come first because the OpenClaw plugin, the stats CLI, and the existing Fastify chat UI all need the same core engine. One engine, multiple consumers. Phase 2 (OpenClaw plugin) is prioritized over the proxy watch mode because it offers a faster path to meaningful adoption — riding the distribution of a 320K-star ecosystem is more efficient than asking developers to configure proxy environment variables. Phase 3 adds the circuit breaker as the headline feature — the thing that makes OpenGauge indispensable for anyone running autonomous agents. Phases 4-5 expand the platform beyond OpenClaw.


2. System Architecture
2.1 Current State
Today, OpenGauge operates as a self-contained chat application. The user provides an LLM API key in settings, submits prompts through the chat UI, and OpenGauge applies auto-improvement before forwarding to the LLM. Token efficiency metrics are displayed in real-time.

User → [OpenGauge Chat UI] → (auto-improve) → LLM API → Response + Metrics

2.2 Target State Architecture
The target architecture introduces four parallel input paths feeding a shared @opengauge/core engine, with an optional cloud sync layer for team usage:

Input Layer
Path A: Chat UI
Path B: OpenClaw Plugin (registerProvider)
Path C: Proxy Watch
Path D: Log Ingestion
User interacts directly with OpenGauge chat. Prompts are auto-improved before hitting the LLM. Full control over the request lifecycle.
OpenGauge wraps OpenClaw's LLM provider via registerProvider API. Every individual LLM call — including multi-call tool-use loops within a single turn — is intercepted, logged, analyzed, and forwarded. The agent never knows OpenGauge is there.
OpenGauge runs as a local proxy. IDE agents (Claude Code, Cursor, Copilot) route through it. Requests are logged and optionally optimized.
OpenGauge reads log files and API traces produced by IDE agents. Zero-integration passive mode. Post-hoc analysis only.

@opengauge/core SDK
All input paths feed into a unified core SDK extracted as a standalone module (@opengauge/core). This SDK has zero server dependencies — no Fastify, no HTTP, no browser. It comprises four subsystems:
Session Logger: Persists every API interaction into a structured SQLite database with a normalized schema covering prompts, responses, token counts, costs, model metadata, and optimization deltas. Pure better-sqlite3, initialized at ~/.opengauge/opengauge.db.
Cost Calculator: Model pricing lookup and token-to-dollar conversion. Maintains a seeded table of per-model pricing (input/output per 1K tokens) for all major providers. Updated via opengauge models --update.
Circuit Breaker: Detects runaway loops (similarity analysis on consecutive calls), escalating token consumption without progress, and budget threshold violations. Pure functions operating on interaction history. Can emit alerts or block calls when thresholds are breached.
Analytics Engine: Reads the session log to compute aggregated metrics — cost per session, tokens saved, efficiency trends, per-model comparisons, per-project breakdowns. Powers both opengauge stats and the web dashboard.
Insights Engine: Applies heuristic and statistical models to detect context degradation, runaway agent loops, diminishing returns in multi-step sessions, and anomalous spend patterns.
Optimization Engine: The existing auto-improve logic, extended with model-specific profiles and session-aware context management. Can be applied in chat mode (always on), watch mode (opt-in toggle), or OpenClaw plugin mode (--optimize flag).

Output Layer
CLI Dashboard (opengauge stats): Local terminal-based analytics view. Free, always available, zero infrastructure. Reads the same SQLite database populated by any input path.
Web Dashboard: Rich browser-based interface served locally or from the cloud tier. Visualizations, session replay, drill-downs.
Cloud Sync (Team Tier): Optional aggregation endpoint that collects anonymized session data from team members for org-level governance dashboards.

2.3 OpenClaw Integration Architecture
OpenClaw's plugin system (documented at openclaw/openclaw/docs/tools/plugin.md) allows in-process TypeScript extensions loaded at runtime. A plugin exports a register(api) function with access to lifecycle hooks, tool registration, provider registration, and more.

OpenGauge integrates at the registerProvider level — the deepest stable hook point for intercepting LLM calls. The architecture:

OpenClaw Agent Turn
  ↓
[OpenClaw requests LLM call]
  ↓
[OpenGauge Wrapped Provider receives request]
  ↓
  ├── Log request to @opengauge/core (SQLite)
  ├── Run circuit breaker check:
  │   ├── Is this suspiciously similar to the last N calls? (trigram Jaccard >0.8)
  │   ├── Is token consumption escalating without progress?
  │   └── Has budget threshold been breached?
  ├── If circuit breaker triggers → log alert, optionally block
  ├── Forward to real provider unchanged (unless --optimize mode)
  ↓
[Real Provider returns response]
  ↓
  ├── Capture response + token counts + latency
  ├── Write complete interaction record to SQLite
  ├── Update session aggregates (total cost, tokens, interaction count)
  ↓
[Return response to OpenClaw unmodified]

Why registerProvider Over Simpler Hooks
OpenClaw's plugin lifecycle hooks (before_agent_start, agent_end) fire once per turn. But a single agent turn can involve multiple LLM calls in tool-use loops — and that's exactly where runaway loops happen and token waste compounds. If you only see turn-level data, your circuit breaker can't detect an agent making 15 redundant tool calls within a single turn. registerProvider catches every individual call, which is what makes the circuit breaker and per-call cost tracking actually work.

The interceptor pipeline (params.before merged via PR #6569) is useful for parameter mutation but doesn't give full request/response visibility. The undocumented streamFn override provides the deepest access but is internal API and could break across versions. registerProvider is the sweet spot: stable plugin API, full per-call visibility, endorsed by the OpenClaw architecture.

Known Limitations (Design Around, Don't Solve in v1)
CLI subprocess mode bypass: When OpenClaw spawns PI as a subprocess (runCliAgent()), in-process plugin hooks don't fire. OpenGauge works with OpenClaw's default embedded gateway mode (runEmbeddedPiAgent()). CLI subprocess mode is not supported. Most users run embedded mode — document this clearly, don't try to solve it in v1.
Fail-silently convention: OpenClaw plugins must never crash or block the agent. Every OpenGauge operation is wrapped in try-catch at the top level. If SQLite write fails, if analytics computation throws, if anything goes wrong — log to ~/.opengauge/error.log and return the response untouched. The agent must never be affected by OpenGauge failing. This is non-negotiable for trust.
No dedicated before_model_call hook: The OpenClaw core team has actively resisted adding fine-grained model-call hooks to the public API (PR #8022 closed, issue #5279 closed as "not planned"). registerProvider wrapping is the endorsed workaround and the correct integration point.

3. Data Model & Storage
3.1 SQLite Schema
All local data is stored in a single SQLite database at ~/.opengauge/data.db. SQLite is chosen for zero-dependency local persistence, single-file portability, and excellent read performance for analytics queries. The schema is designed to support both real-time chat logging and proxy watch ingestion.

sessions Table
Each conversation or agent session is a single row. Sessions can originate from the chat UI, proxy watch, or log ingestion.

Column
Type
Description
id
TEXT PK
UUID v4, generated on session start
source
TEXT
Enum: 'chat' | 'proxy' | 'log_ingest'
model
TEXT
LLM model identifier (e.g., claude-sonnet-4-20250514)
provider
TEXT
API provider (anthropic, openai, google, local)
project_dir
TEXT NULL
Filesystem path of the project (if detectable from IDE agent)
started_at
DATETIME
Session start timestamp (UTC)
ended_at
DATETIME NULL
Session end timestamp, null if still active
total_tokens_in
INTEGER
Cumulative input tokens across all interactions
total_tokens_out
INTEGER
Cumulative output tokens across all interactions
total_cost_usd
REAL
Estimated total cost in USD based on provider pricing
tokens_saved
INTEGER
Tokens saved by optimization (0 if unoptimized)
cost_saved_usd
REAL
Dollar value of tokens saved
interaction_count
INTEGER
Number of request-response pairs in the session
metadata
JSON
Extensible metadata blob for future fields


interactions Table
Each individual API call within a session. This is the granular event log.

Column
Type
Description
id
TEXT PK
UUID v4
session_id
TEXT FK
References sessions.id
sequence_num
INTEGER
Order within session (1-indexed)
timestamp
DATETIME
When the API call was made
original_prompt
TEXT
The prompt before optimization (null in watch mode without optimization)
optimized_prompt
TEXT NULL
The prompt after auto-improve (null if optimization was disabled)
response_text
TEXT
First 2000 chars of LLM response (truncated for storage efficiency)
tokens_in
INTEGER
Input tokens for this specific call
tokens_out
INTEGER
Output tokens for this specific call
cost_usd
REAL
Estimated cost for this call
latency_ms
INTEGER
Round-trip time in milliseconds
optimization_delta
REAL
Percentage token reduction from optimization (0 if none)
context_depth_tokens
INTEGER
Cumulative context size at time of call
model
TEXT
Model used (may differ from session default in multi-model setups)
metadata
JSON
Headers, status codes, error flags, tool usage indicators


model_profiles Table
Stores model-specific optimization configuration and learned parameters.

Column
Type
Description
model_id
TEXT PK
Model identifier string
provider
TEXT
Provider name
cost_per_1k_in
REAL
Price per 1K input tokens in USD
cost_per_1k_out
REAL
Price per 1K output tokens in USD
max_context
INTEGER
Maximum context window in tokens
preferred_format
TEXT
Optimal prompt format (xml, markdown, conversational, json)
optimization_rules
JSON
Model-specific rewrite rules and constraints
updated_at
DATETIME
Last profile update timestamp


alerts Table
Stores detected anomalies, degradation events, and cost alerts for dashboard display.

Column
Type
Description
id
TEXT PK
UUID v4
session_id
TEXT FK
Session that triggered the alert
interaction_id
TEXT FK NULL
Specific interaction, if applicable
alert_type
TEXT
Enum: 'degradation' | 'runaway_loop' | 'cost_spike' | 'stale_context'
severity
TEXT
Enum: 'info' | 'warning' | 'critical'
message
TEXT
Human-readable alert description
data
JSON
Supporting metrics and evidence
created_at
DATETIME
When the alert was generated
dismissed
BOOLEAN
Whether the user has acknowledged this alert


Storage Considerations
At ~500 bytes per interaction row and an average of 20 interactions per session, a developer running 10 sessions per day accumulates roughly 100KB/day or 36MB/year. SQLite handles this trivially. The response_text field is intentionally truncated to 2000 characters to prevent database bloat while retaining enough for debugging. Full responses can optionally be stored in a separate overflow table or flat files.


4. Phase 1: @opengauge/core SDK Extraction + Structured Session Logging
4.1 Objective
Extract the core engine from the existing OpenGauge codebase into a standalone @opengauge/core module with zero server dependencies. This SDK becomes the single engine consumed by the OpenClaw plugin, the chat UI, the stats CLI, and the future proxy watch mode.

4.2 SDK Architecture
@opengauge/core exports three standalone modules:

4.2.1 Database Layer (core/db)
Pure better-sqlite3, no Fastify, no HTTP. Can be imported and used by any Node.js consumer.
Initialize the database at ~/.opengauge/opengauge.db on first run with the schema from Section 3.
Create a DatabaseService class that wraps all insert/query operations with prepared statements. This service should be a singleton shared across all consumers.
Implement automatic migration support. Store a schema_version table and apply incremental migrations on startup. This is critical for future schema evolution without breaking existing installations.
Seed the model_profiles table with current pricing and context limits for major providers: Anthropic (Claude Haiku, Sonnet, Opus), OpenAI (GPT-4o, GPT-4.1, o3), Google (Gemini 2.5 Pro, Flash), and key open-weight models (Llama, Qwen, DeepSeek).

Key exports:
  initDatabase(): initializes schema + migrations + seeding
  writeInteraction(interaction: InteractionRecord): void
  writeSession(session: SessionRecord): void
  writeAlert(alert: AlertRecord): void
  querySessions(filters: SessionFilters): SessionRecord[]
  queryInteractions(sessionId: string): InteractionRecord[]
  queryAlerts(filters: AlertFilters): AlertRecord[]

4.2.2 Circuit Breaker (core/circuit-breaker)
Pure functions operating on interaction history. No side effects beyond returning verdicts.
Similarity detection: trigram Jaccard on consecutive prompts. Threshold >0.8 = potential loop.
Escalation tracking: if token consumption is increasing across similar consecutive calls without meaningful output variation, flag as runaway.
Budget threshold evaluation: check cumulative session/daily/monthly cost against configured limits.
Configurable thresholds via .opengauge config or programmatic options.

Key exports:
  checkRunawayLoop(recentInteractions: InteractionRecord[]): CircuitBreakerVerdict
  checkBudgetThreshold(session: SessionRecord, config: BudgetConfig): CircuitBreakerVerdict
  checkEscalation(recentInteractions: InteractionRecord[]): CircuitBreakerVerdict

CircuitBreakerVerdict: { triggered: boolean, reason: string, severity: ‘info’ | ‘warning’ | ‘critical’, data: object }

4.2.3 Cost Calculator (core/cost)
Model pricing lookup from model_profiles table.
Token-to-dollar conversion for any model/provider combination.
Handles input vs output token pricing differences.
Falls back to sensible defaults for unknown models.

Key exports:
  calculateCost(model: string, tokensIn: number, tokensOut: number): CostResult
  getModelProfile(model: string): ModelProfile | null
  updateModelProfiles(): Promise<void>  // fetch latest pricing

4.2.4 Analytics Engine (core/analytics — extracted from existing scorer.ts)
Reads the session log to compute aggregated metrics.
Powers both opengauge stats CLI and the web dashboard.
Prompt quality scoring, duplicate detection, efficiency trends.

4.3 Standalone Validation
The SDK must be testable without any server running:
  - Can you initialize a database, write interactions, and query them back?
  - Can you feed interaction history to the circuit breaker and get correct verdicts?
  - Can you calculate costs for known models and get accurate dollar amounts?
  - Can you detect a simulated runaway loop (15 similar prompts with escalating tokens)?

4.4 Chat UI Re-integration
After extraction, the existing Fastify chat UI imports @opengauge/core instead of its inline implementations:
On conversation start, create a new session row with source=’chat’, model, provider, and started_at.
Before each API call, capture the original prompt text. After auto-improvement runs, capture the optimized prompt. Log both to the interactions table along with sequence_num (incrementing counter within the session).
On API response, populate tokens_in, tokens_out, latency_ms, and calculate cost_usd using the cost calculator. Update the parent session row’s aggregates.
Calculate and store optimization_delta as the percentage difference between original and optimized prompt token counts. If optimization was disabled for this interaction, store 0.
Track context_depth_tokens by maintaining a running sum of all tokens sent in the session so far.

4.5 Success Criteria
@opengauge/core can be imported and used without any server running.
Every chat interaction is persisted with zero data loss.
Circuit breaker correctly identifies simulated runaway loops in isolation.
Cost calculator returns accurate dollar amounts for all seeded model profiles.
Database size remains under 50MB for 6 months of typical individual usage.
No regression in chat UI latency — database writes must be non-blocking.

5. Phase 2: @opengauge/openclaw-plugin via registerProvider
5.1 Objective
Ship an OpenClaw plugin that wraps every LLM provider call via registerProvider, logging every individual API call to @opengauge/core's SQLite database. This is the primary distribution channel — published on ClawHub for instant access by OpenClaw's 320K+ user base.

5.2 Plugin Structure

@opengauge/openclaw-plugin/
├── openclaw.plugin.json          # OpenClaw plugin manifest
├── package.json                  # npm package, depends on @opengauge/core
├── src/
│   ├── index.ts                  # exports register(api) function
│   ├── wrapped-provider.ts       # provider wrapper with logging + circuit breaker
│   └── config.ts                 # plugin configuration (thresholds, budget, optimize flag)
└── README.md

5.3 Implementation Tasks
5.3.1 Plugin Entry Point (index.ts)
Export a register(api) function per OpenClaw's plugin contract.
Call api.registerProvider() to wrap the active LLM provider with OpenGauge's instrumented wrapper.
Initialize @opengauge/core's database on plugin load (initDatabase()).
Register an optional opengauge-stats command via api.registerCommand() so users can query stats from within OpenClaw.

5.3.2 Wrapped Provider (wrapped-provider.ts)
Implement the LLM provider interface expected by OpenClaw's PI SDK.
On every inference request:
  1. Capture timestamp, model, full request payload (messages array, parameters).
  2. Call @opengauge/core circuit breaker: checkRunawayLoop() on recent interactions for this session.
  3. Call checkBudgetThreshold() against configured spend limits.
  4. If circuit breaker triggers at 'critical' severity:
     - Write alert to database via writeAlert().
     - If configured to block (circuit_breaker.action = 'block'), return an error response to OpenClaw explaining why the call was blocked. The agent receives a clear message: "OpenGauge circuit breaker: N similar calls detected without progress. Session cost: $X.XX. Stopping to prevent runaway spend."
     - If configured to warn only (default), log the alert and proceed.
  5. Forward request to the real provider unchanged (unless --optimize mode is enabled, in which case run the optimization engine on the prompt before forwarding).
  6. Capture the complete response: text, token counts (input/output), latency.
  7. Write the full interaction record to SQLite via writeInteraction().
  8. Update session aggregates via updateSession().
  9. Return the response to OpenClaw completely unmodified.

All of the above is wrapped in a top-level try-catch. If ANY step fails, log the error to ~/.opengauge/error.log and return the response from the real provider as if OpenGauge were not there. The agent must never be affected by OpenGauge failing.

5.3.3 Session Management
Create a new session (source='openclaw') on first call after plugin load or after 5 minutes of inactivity.
Track session state in memory: session ID, interaction count, running cost, recent interactions (last 20 for circuit breaker window).
On OpenClaw shutdown (gateway_stop hook), finalize the session record with ended_at and final aggregates.

5.3.4 Configuration (config.ts)
Read from ~/.opengauge/config.yml (same config file as standalone OpenGauge) with OpenClaw-specific section:

openclaw:
  circuit_breaker:
    enabled: true
    similarity_threshold: 0.8       # trigram Jaccard threshold for loop detection
    max_similar_calls: 5             # consecutive similar calls before triggering
    escalation_check: true           # detect escalating token usage without progress
    action: warn                     # warn | block
  budget:
    session_limit_usd: 5.00
    daily_limit_usd: 20.00
    monthly_limit_usd: 400.00
  optimize: false                    # opt-in prompt optimization
  log_response_text: true            # store response text (truncated to 2000 chars)
  log_full_request: false            # store full messages array (storage-heavy, off by default)

5.4 Testing Strategy
Unit tests: Feed simulated interaction sequences to the circuit breaker. Verify it correctly detects runaway loops (15 similar prompts), escalation (increasing tokens on similar prompts), and budget breaches.
Integration test: Install the plugin in a local OpenClaw instance. Run an agent that makes multiple LLM calls (including tool-use loops). Verify that every individual LLM call appears in the SQLite database with accurate token counts and costs.
Runaway simulation: Deliberately trigger a runaway loop in a test agent (e.g., a skill that repeatedly fails and retries). Verify that OpenGauge detects and reports it. With action=block, verify the agent receives the circuit breaker message and stops.
Fail-safety test: Simulate SQLite failures (read-only filesystem, corrupt database). Verify that the wrapped provider still returns responses from the real provider without any errors visible to OpenClaw.

5.5 Distribution
Publish to npm as @opengauge/openclaw-plugin.
Submit to ClawHub skill/plugin registry for discovery by OpenClaw users.
Installation: openclaw plugins install @opengauge/openclaw-plugin or manual install to {workspaceDir}/.openclaw/extensions/.

5.6 Success Criteria
Every individual LLM call within an OpenClaw agent turn is captured — including multi-call tool-use loops.
Circuit breaker correctly detects and alerts on runaway loops within 5 consecutive similar calls.
Zero impact on agent latency: provider wrapper adds <5ms overhead per call (excluding SQLite write, which is async).
Fail-safe: any internal OpenGauge error is swallowed — the agent never sees it.
Plugin installs and initializes in <2 seconds on first load.


6. Phase 3: opengauge stats CLI + Passive Insights Engine
6.1 Objective
Expose the data collected by Phase 1 (chat UI) and Phase 2 (OpenClaw plugin) through a CLI analytics dashboard and a passive insights engine that surfaces actionable alerts. This is the feature that makes OpenGauge indispensable — users see the value of their data.

6.2 CLI Analytics Dashboard (opengauge stats)
Add a new CLI command that reads the SQLite database and renders analytics to the terminal. Use chalk + cli-table3 for lightweight terminal formatting.

Required metrics for v1:
Total Spend: Cumulative USD spent across all sessions, with daily/weekly/monthly breakdowns. Broken down by source (chat/openclaw/proxy).
Tokens Saved: Total tokens saved by auto-improvement, with a dollar equivalent based on model pricing.
Sessions Summary: Count of sessions by source, average duration, average interaction count. OpenClaw sessions prominently featured.
Model Distribution: Table showing usage distribution across models.
Efficiency Trend: Week-over-week trend of optimization savings percentage.
Top Sessions by Cost: List of the 5 most expensive sessions with model, duration, and cost.
Circuit Breaker Activity: Number of runaway loops detected, calls blocked, estimated dollars saved by early termination.
Active Alerts: Unacknowledged degradation, loop, and cost spike alerts.

$ npx opengauge stats
$ npx opengauge stats --period=7d    # last 7 days
$ npx opengauge stats --model=claude  # filter by model
$ npx opengauge stats --source=openclaw  # filter by source
$ npx opengauge stats --alerts       # show unacknowledged alerts
$ npx opengauge stats --json         # machine-readable output

6.3 Success Criteria
opengauge stats renders accurate metrics within 200ms for databases up to 100K interactions.
OpenClaw users can run opengauge stats and immediately see their agent's spend, loop detections, and cost trends.
Stats correctly aggregate data from all sources (chat, openclaw, proxy) into unified views.


7. Phase 4: Proxy Watch Mode + Cross-Platform Expansion
7.1 Objective
Enable OpenGauge to observe and log LLM API traffic from any IDE agent or CLI tool without modifying those tools. This extends OpenGauge beyond OpenClaw to Claude Code, Cursor, Copilot, and custom scripts — making it the universal PromptOps layer. Users who discover OpenGauge through OpenClaw bring it to their other tools.

7.2 How It Works
OpenGauge starts a local HTTP proxy server that accepts LLM API requests, logs them to @opengauge/core (same SQLite database as the chat UI and OpenClaw plugin), optionally optimizes them, and forwards them to the actual provider endpoint. Tools that support base URL configuration can be pointed at the proxy with a single environment variable.

$ npx opengauge watch --port 4000

Then configure the IDE agent:

# Claude Code
ANTHROPIC_BASE_URL=http://localhost:4000 claude

# Cursor (in settings.json)
"openai.apiBase": "http://localhost:4000/v1"

# Any OpenAI-compatible client
OPENAI_BASE_URL=http://localhost:4000/v1 your-tool

7.3 Implementation Tasks
7.3.1 Proxy Server
Build a lightweight HTTP server using Node.js native http module (not Express — minimize dependency footprint for an npx tool). The server must handle both HTTP/1.1 and support streaming responses (SSE) since most LLM APIs use streaming.
Implement provider detection by inspecting the request path and headers. Map /v1/messages to Anthropic, /v1/chat/completions to OpenAI-compatible, /v1beta/models to Google. Extract the model name from the request body.
Forward the request to the real provider endpoint using the original API key from the Authorization / x-api-key header. For Anthropic, forward to https://api.anthropic.com. For OpenAI, forward to https://api.openai.com. Store the original base URL from the provider’s config if available.
For streaming responses, buffer the SSE chunks to extract the complete response and token usage data, while simultaneously streaming them back to the caller with zero additional latency. The user must not perceive any performance degradation.
On request completion, log the interaction via @opengauge/core writeInteraction() (source=’proxy’). Run the same circuit breaker checks as the OpenClaw plugin. Create a new session if this is the first request from a new caller or if more than 5 minutes have elapsed since the last request.

7.3.2 Session Grouping Heuristics
Unlike the chat UI where sessions are explicit, proxy mode requires heuristic session grouping. Implement the following logic:
Requests from the same process ID or API key within a 5-minute window belong to the same session.
If a request includes a new system prompt or significantly different context, start a new session even within the time window.
Detect project directory from x-opengauge-project header (custom) or by inspecting the prompt for file paths, then group by project.
Allow manual session tagging via an optional x-opengauge-session header that tools can be configured to send.

7.3.3 Provider Compatibility Matrix
Provider / Tool
Base URL Override
Streaming Support
Notes
Claude Code
ANTHROPIC_BASE_URL
SSE (text/event-stream)
Full support, most common target
Cursor
openai.apiBase in config
SSE
Uses OpenAI-compatible format
GitHub Copilot
Limited (via plugin)
SSE
May require extension-level proxy
OpenAI Codex CLI
OPENAI_BASE_URL
SSE
Standard OpenAI client
Custom scripts / LangChain
Client-specific env var
Varies
Works with any HTTP-based LLM client


7.4 Watch Mode Optimization
Extend the proxy watch mode to optionally apply the auto-improvement logic to intercepted requests. This brings the core value of OpenGauge’s chat mode to every IDE agent and CLI tool.

$ npx opengauge watch --port 4000 --optimize
$ npx opengauge watch --port 4000 --optimize --aggressiveness=medium

Three aggressiveness levels:
Conservative: Only remove redundant whitespace, repeated instructions, and obvious bloat. Preserves prompt semantics exactly. Typical savings: 5-15%.
Medium: Apply model-specific format restructuring (e.g., convert free-text to XML for Claude, add structured markers for GPT). Rephrase verbose instructions. Typical savings: 15-30%.
Aggressive: Summarize long context sections, deduplicate information across system prompt and user messages, compress examples. Typical savings: 25-50%. Higher risk of semantic drift.

7.5 Model-Specific Optimization Profiles
Each model has distinct preferences for how prompts are structured. The optimization engine applies model-aware transformations:

Model Family
Optimization Strategy
Claude (Anthropic)
Restructure prompts using XML tags for clear delineation. Add explicit role and constraint sections. Claude responds best to structured, hierarchical prompts with clear boundaries.
GPT-4 / o3 (OpenAI)
Use markdown headers and bullet points. System prompt should front-load constraints. User messages benefit from numbered steps. JSON mode prompts should include schema in system.
Gemini (Google)
Conversational style performs well. Shorter, more direct prompts. Avoid over-structuring — Gemini handles ambiguity better than Claude/GPT but benefits from explicit output format instructions.
Open-weight (Llama, Qwen)
Simpler prompts perform disproportionately better. Strip meta-instructions and complex nested structures. Use direct imperative instructions. Context window is typically smaller, so compression is more critical.

7.6 A/B Comparison Mode
Even without --optimize enabled, OpenGauge can show the user what would have happened with optimization. Implement a shadow mode where the optimizer runs but doesn’t apply changes, storing both the original and optimized versions in the interactions table. The stats dashboard then shows:

$ npx opengauge stats --compare


Last 7 days: 847 API calls observed
Actual spend:     $23.41
Optimized spend:  $16.88  (saved $6.53 / 27.9%)


Largest savings opportunity:
  Session ‘auth-refactor’ - 34 calls, $1.40 actual, $0.91 optimized

7.7 Passive Insights Engine
The insights engine analyzes logged sessions from all sources (chat, OpenClaw, proxy) to surface actionable alerts. These algorithms run in @opengauge/core and are shared across all consumers.

7.7.1 Context Degradation Detection
As a session’s context window fills, LLM output quality degrades — but the model maintains the same authoritative tone, making degradation invisible to the user. OpenGauge detects this by tracking:

Context fill ratio: context_depth_tokens / model_max_context. Trigger a warning at 70% and critical at 85%.
Response entropy decline: Measure the lexical diversity (unique tokens / total tokens) of consecutive responses. A sustained decline over 3+ interactions indicates the model is becoming repetitive and less creative.
Token-per-value ratio: Track the ratio of output tokens to ‘useful’ content (measured by absence of repetition and boilerplate). Rising ratio = declining efficiency.

// Pseudocode: degradation scoring
function degradationScore(session) {
  const fillRatio = session.contextDepth / modelProfile.maxContext;
  const entropyTrend = linearRegression(session.responseDiversities);
  const score = (fillRatio * 0.5) + (entropyDecline * 0.3) + (repetitionRate * 0.2);
  return { score, recommendation: score > 0.7 ? ‘RESET_CONTEXT’ : ‘OK’ };
}

7.7.2 Runaway Loop Detection (complements Phase 2 circuit breaker)
The Phase 2 circuit breaker operates in real-time within the OpenClaw plugin. The insights engine adds post-hoc analysis across all sources:
Tracking prompt similarity between consecutive interactions using a lightweight similarity metric (Jaccard on trigrams, not full embeddings — must be local and fast).
If 3+ consecutive prompts have >80% similarity and output tokens are increasing (the model is ‘trying harder’), flag as a potential runaway loop.
Calculate cost-since-loop-start and display to user.

7.7.3 Cost Anomaly Detection
Maintain a rolling 7-day average of daily spend. If today’s spend exceeds 2x the average, trigger a cost spike alert. Also flag individual sessions that exceed the 95th percentile of historical session costs.

7.7.4 Stale Context Detection
In long sessions, early context may become irrelevant. Track the ratio of ‘referenced’ context (tokens from earlier messages that appear or are referenced in recent outputs) vs total context. A low reference ratio suggests the session would benefit from a summarize-and-reset.

7.8 Alert Delivery
In chat mode: Display inline alerts in the UI when degradation or loops are detected. Suggest a context reset with a one-click action.
In OpenClaw plugin mode: Alerts are written to the database and surfaced in opengauge stats. For critical alerts (circuit breaker triggers), the wrapped provider can optionally block the call.
In watch mode: Alerts are logged to the alerts table and surfaced in opengauge stats. For critical alerts, optionally send a desktop notification (node-notifier or native OS notification API).
Terminal output: opengauge stats --alerts shows recent unacknowledged alerts with severity, message, and affected session.

7.9 Security Considerations
The proxy runs on localhost only — never bind to 0.0.0.0 by default. API keys pass through the proxy in memory but are never persisted to the database or logs.
Add a --allow-remote flag for team environments where the proxy runs on a shared dev server, but require an auth token.
The proxy must not modify requests by default. Optimization is disabled unless --optimize is explicitly passed. Trust is paramount — developers must be confident the proxy is transparent.

Trust-First Philosophy
Neither the proxy nor the OpenClaw plugin modify requests by default. Optimization is always opt-in, always reversible, and always transparent. Users must be able to see exactly what was changed and why. If the optimization engine ever introduces a semantic error that causes a tool to fail, the user will lose trust permanently. Conservative defaults protect the product.


8. Phase 5: Team Cloud Dashboard & Monetization
8.1 Objective
Introduce a hosted cloud layer that aggregates session data from multiple team members into a unified governance dashboard. This is the monetization layer — individual developers use OpenGauge for free, engineering teams pay for aggregated visibility and control.

8.2 Cloud Architecture
The cloud tier is deliberately minimal. It receives pre-aggregated session summaries (not raw prompts or responses) and stores them for dashboard rendering. This design respects developer privacy and minimizes infrastructure cost.

Data Flow
The local OpenGauge CLI periodically syncs session-level aggregates to the cloud endpoint. Sync happens on session close or every 5 minutes for active sessions.
Synced data includes: session ID, source, model, provider, project directory (hashed), started_at, ended_at, total_tokens_in/out, total_cost_usd, tokens_saved, interaction_count, and active alerts.
Synced data explicitly excludes: prompt text, response text, API keys, file paths (only hashed project identifiers), and any PII.
Each team member’s CLI authenticates with a team token generated from the cloud dashboard.

Cloud Stack
Given the existing Cloudflare expertise from SellKraft, the recommended cloud stack is:
API: Cloudflare Workers handling ingest and dashboard API endpoints.
Storage: Cloudflare D1 (SQLite-compatible) for team session data. Familiar schema, zero operational overhead.
Dashboard: Static React app on Cloudflare Pages. Authentication via Cloudflare Access or simple JWT.
Sync endpoint: POST /api/v1/sync accepting batched session summaries. Idempotent writes keyed on session_id.

8.3 Team Dashboard Features
Team Spend Overview: Total spend across all team members, broken down by developer, model, and project. Daily/weekly/monthly trends.
Per-Developer Efficiency: Ranked view of team members by optimization savings, cost efficiency, and session patterns. Not for punishment — for identifying who has effective workflows that others can learn from.
Project-Level Analytics: Which projects consume the most AI tokens? Which have the highest optimization opportunity? Useful for budgeting and capacity planning.
Alert Aggregation: Team-wide view of degradation, loop, and cost alerts. Identify systemic issues (e.g., a specific model version causing loops across multiple developers).
Budget Controls: Set monthly spend caps per developer or per project. Alert engineering leads when thresholds are approached.

8.4 Pricing Model
Tier
Price
Includes
Free (Individual)
$0
Full CLI (chat + watch + stats + insights). Unlimited local usage. Community support.
Team
$12/seat/month
Everything in Free + cloud dashboard, team analytics, budget controls, alert aggregation, email support. Minimum 5 seats.
Enterprise
Custom
Everything in Team + SSO/SAML, audit logs, self-hosted option, custom optimization profiles, dedicated support, SLA.


Revenue Projection Basis
At 100 teams averaging 8 seats on the Team tier, MRR = $9,600. At 500 teams, MRR = $48,000. The free tier drives adoption and creates bottom-up demand within engineering organizations. The key conversion trigger is when a developer shows their manager the opengauge stats --compare output showing dollar savings.


9. Plugin & Extension Ecosystem
9.1 Plugin Architecture
OpenGauge exposes a plugin API that allows third-party developers to contribute optimization strategies, custom analytics, and integrations. Plugins are loaded at runtime and executed within the optimization and insights pipeline.

Plugin Interface
// opengauge-plugin.d.ts
interface OpenGaugePlugin {
  name: string;
  version: string;
  hooks: {
    beforeOptimize?: (ctx: PromptContext) => PromptContext;
    afterResponse?: (ctx: ResponseContext) => void;
    onSessionEnd?: (session: SessionSummary) => InsightResult[];
    registerMetrics?: () => MetricDefinition[];
  };
}

Example Plugin Concepts
Plugin
Description
@opengauge/openclaw-plugin
The flagship integration. Wraps OpenClaw's LLM provider via registerProvider to capture every API call, run circuit breaker checks, and enforce budget controls. Published on ClawHub for discovery by 320K+ OpenClaw users. See Phase 2 for full specification.
@opengauge/codegen
Specialized optimization for code generation prompts. Detects when the prompt is asking for code and restructures it with language-specific best practices (e.g., adding type hints for TypeScript, specifying error handling patterns).
@opengauge/rag
Optimizes retrieval-augmented generation prompts by detecting and deduplicating retrieved context chunks, reranking by relevance, and compressing low-value chunks.
@opengauge/safety
Auto-injects safety guardrails into prompts. Detects prompts missing output constraints and adds them. Useful for teams with compliance requirements.
@opengauge/changelog
Tracks LLM model updates and version changes. Notifies users when a model they use frequently has been updated and auto-adjusts optimization profiles.
@opengauge/export
Exports session data and analytics to external systems: Datadog, Grafana, CSV, BigQuery. Enables integration with existing observability stacks.


9.2 Plugin Distribution
Plugins are distributed as npm packages under the @opengauge scope. Users install them globally or per-project:
$ npm install -g @opengauge/codegen
$ npx opengauge chat --plugins=codegen,safety

The .opengauge config file (see Section 10) can specify default plugins for a project, ensuring consistent team usage.

10. Project Configuration (.opengauge)
10.1 Purpose
The .opengauge configuration file is committed to a project’s repository and defines the team’s PromptOps preferences. Once adopted across repositories, it creates meaningful switching cost — the same mechanism that makes .eslintrc, .prettierrc, and tsconfig.json sticky.

10.2 Configuration Schema
// .opengauge (JSON or YAML)
{
  "version": "1",
  "team_id": "tm_abc123",           // Optional: cloud sync team identifier
  "defaults": {
    "model": "claude-sonnet-4-20250514",
    "provider": "anthropic",
    "optimization": "medium",        // conservative | medium | aggressive
    "max_context_fill": 0.75,        // Alert when context exceeds 75% capacity
    "max_session_cost": 5.00          // Alert when a single session exceeds $5
  },
  "plugins": ["codegen", "safety"],
  "budget": {
    "daily_limit_usd": 20,
    "monthly_limit_usd": 400,
    "alert_threshold": 0.8            // Alert at 80% of budget
  },
  "rules": [
    {
      "match": "*.test.*",            // Pattern matching for file context
      "optimization": "conservative"  // Less aggressive for test generation
    },
    {
      "match": "*.migration.*",
      "optimization": "aggressive"    // Compress heavily for migration scripts
    }
  ],
  "context_management": {
    "auto_summarize_at": 0.7,         // Trigger context summarization at 70% fill
    "preserve_recent": 5,             // Always keep last 5 interactions verbatim
    "summary_model": "claude-haiku"  // Use cheap model for summarization
  }
}

10.3 Config Resolution
OpenGauge resolves configuration by walking up the directory tree from the current working directory, merging configs at each level. This allows monorepos to have per-package overrides:

/repo/.opengauge                  # Base config
/repo/packages/api/.opengauge     # Override for API package
/repo/packages/web/.opengauge     # Override for web package

User-level defaults at ~/.opengauge/config are applied as the lowest-priority layer, overridden by any project-level configs.

11. Context Lifecycle Management
11.1 The Core Problem
LLMs degrade confidently, not gracefully. As the context window fills, the model doesn’t signal lower confidence or reduced quality — it continues responding in the same authoritative tone while producing increasingly repetitive, hallucinated, or irrelevant output. No model provider is incentivized to solve this because they benefit from higher token consumption.

11.2 OpenGauge’s Context Garbage Collector
The context lifecycle manager operates as an intelligent garbage collector for LLM context. It monitors, compresses, and recommends resets to maintain output quality throughout long sessions.

11.2.1 Monitoring
Track context_depth_tokens in real-time for every session (already captured in the interactions table).
Compute a context quality score that combines fill ratio, response entropy trend, and reference freshness (how much of the early context is still being meaningfully used).
Display a context health indicator in the chat UI and as a metric in watch mode stats.

11.2.2 Automatic Summarization
When context fill reaches the auto_summarize_at threshold (configurable in .opengauge, default 70%), OpenGauge can:
Identify stale context segments — message pairs from early in the session that are no longer referenced in recent interactions.
Generate a compressed summary of stale segments using a cheap, fast model (e.g., Claude Haiku or a local model). The summary preserves key decisions, code snippets, and constraints while discarding conversational filler.
Replace the stale segments with the summary in the session context. The original messages are preserved in the SQLite log for forensic analysis.
Preserve the most recent N interactions (configurable, default 5) verbatim to maintain conversation coherence.

11.2.3 Reset Recommendations
When summarization is insufficient (context quality score below 0.3 even after compression), OpenGauge recommends a full context reset:
In chat mode: Display a prominent UI notification with a one-click reset action that carries forward a structured summary of the session state.
In watch mode: Log a critical alert and, if desktop notifications are enabled, push a notification to the developer.
The reset summary is generated as a structured document containing: key decisions made, current task state, unresolved issues, and relevant code context.

12. Defensibility & Competitive Moat
12.1 OpenClaw Ecosystem Position
OpenGauge’s integration with OpenClaw (320K+ stars, NVIDIA/AMD/AWS backing) provides a distribution advantage that no standalone launch could replicate. By shipping as a ClawHub plugin, OpenGauge reaches an existing audience of autonomous agent users who have an acute, unsolved need for cost governance and runaway detection. Even 1% adoption from the OpenClaw user base provides more traction than any organic growth strategy. Once adopted, the data OpenGauge collects from OpenClaw sessions feeds every other moat listed below.

12.2 Data Flywheel
Every invocation of OpenGauge — chat mode, OpenClaw plugin, watch mode, or log ingestion — generates a prompt-optimization-outcome triple. With opt-in anonymous telemetry, these triples aggregate into a dataset that powers increasingly accurate optimization profiles. This is a classic data flywheel: more users produce better data, which produces better optimization, which attracts more users.

No competitor can bootstrap this dataset without a comparable installed base. The dataset is defensible because it reflects real-world usage patterns, not synthetic benchmarks. The OpenClaw integration accelerates this flywheel by capturing high-volume autonomous agent interactions — far more data per user than manual chat sessions generate.

12.3 Multi-Model Intelligence
LLM providers optimize for their own model. OpenAI will never tell you that your prompt would perform better on Claude. Google will never suggest using GPT-4 for a specific task. OpenClaw supports multiple providers but doesn’t optimize across them. OpenGauge is the only tool with incentive and data to provide cross-model intelligence: which model handles your specific prompt type best, at what cost, with what tradeoffs.

12.4 Config File Lock-in
Once .opengauge is committed across 50+ repositories in an organization, the switching cost becomes substantial. Custom rules, budget configurations, plugin selections, and context management settings represent organizational knowledge that’s expensive to recreate.

12.5 Plugin Ecosystem Network Effects
Each third-party plugin increases OpenGauge’s value for all users. As the plugin ecosystem grows, it becomes the standard extension point for PromptOps tooling, similar to how ESLint’s plugin ecosystem makes it nearly impossible for a competitor to displace. The OpenClaw plugin is the anchor — it demonstrates that OpenGauge can integrate with any agent framework, not just its own chat UI.

12.6 LLM Changelog Tracker
OpenGauge can maintain a living index of model version changes across all major providers. When a model updates (version bump, behavior change, pricing adjustment), OpenGauge auto-adjusts optimization profiles and notifies users. This turns model churn — a pain point for every developer — into a feature that reinforces dependency on OpenGauge.

12.7 Cross-Platform Positioning
OpenGauge doesn’t just work with OpenClaw — it works with Claude Code, Cursor, Codex, custom scripts, and any LLM client that supports base URL configuration. This makes OpenGauge the universal PromptOps layer, with OpenClaw as the highest-value integration. Users who discover OpenGauge through OpenClaw bring it to their other tools. Users who discover it through the proxy bring it to their OpenClaw agents. Each integration channel reinforces the others.

13. CLI Command Reference
Complete reference for all OpenGauge CLI commands across all phases:

Command
Description
Phase
npx opengauge
Launch the chat UI (existing behavior, now with @opengauge/core session logging)
1
npx opengauge chat
Explicit alias for the chat UI
1
npx opengauge stats
Display local analytics dashboard (all sources: chat, OpenClaw, proxy)
3
npx opengauge stats --period=30d
Analytics for a specific time period
3
npx opengauge stats --model=claude
Filter analytics by model family
3
npx opengauge stats --source=openclaw
Filter analytics by source (chat, openclaw, proxy)
3
npx opengauge stats --project=/path
Filter analytics by project directory
3
npx opengauge stats --compare
Show A/B comparison of actual vs optimized spend
4
npx opengauge stats --alerts
Show unacknowledged alerts (including circuit breaker triggers)
3
npx opengauge stats --json
Machine-readable JSON output for CI/CD integration
3
npx opengauge watch
Start the proxy server in observation-only mode (default port 4000)
4
npx opengauge watch --optimize
Start the proxy server with prompt optimization enabled
4
npx opengauge watch --optimize --aggressiveness=aggressive
Watch mode with aggressive optimization
4
npx opengauge config init
Generate a .opengauge config file in the current directory
1
npx opengauge config validate
Validate the current .opengauge configuration
1
npx opengauge sync
Manually trigger cloud sync (team tier)
5
npx opengauge models
List all known model profiles with pricing and capabilities
1
npx opengauge models --update
Fetch latest model pricing and context limits
1
npx opengauge reset
Clear local database (with confirmation prompt)
1

OpenClaw Plugin Commands (available within OpenClaw after installing @opengauge/openclaw-plugin):
Command
Description
Phase
openclaw plugins install @opengauge/openclaw-plugin
Install the OpenGauge plugin into an OpenClaw workspace
2
opengauge-stats (registered via api.registerCommand)
Query OpenGauge analytics from within OpenClaw
2


14. Technology Stack
Layer
Technology
Rationale
CLI Framework
Node.js + Commander.js
Already the runtime for the chat UI. Commander adds structured command parsing with minimal overhead.
Local Database
better-sqlite3
Synchronous API (simpler code), fastest SQLite binding for Node.js, zero external dependencies.
Proxy Server
Node.js native http
No framework overhead for a passthrough proxy. Full control over streaming (SSE) handling.
Terminal UI
chalk + cli-table3
Lightweight terminal formatting. Blessed/Ink for v2 if richer TUI is needed.
Optimization Engine
TypeScript (existing)
Extend the current auto-improve module with model profiles and aggressiveness levels.
Similarity Detection
trigram Jaccard
Fast, local, no ML dependencies. Sufficient for loop and repetition detection.
Cloud API
Cloudflare Workers
Edge-deployed, zero cold start, familiar from SellKraft. D1 for storage, Pages for dashboard.
Cloud Dashboard
React + Recharts
Lightweight charting, fast development, deployed on Cloudflare Pages.
Plugin System
Node.js dynamic import
Standard ES module loading. Plugins are npm packages with a conventional export.
Desktop Notifications
node-notifier
Cross-platform native notifications for critical alerts in watch mode.
Testing
Vitest
Fast, TypeScript-native, compatible with the existing codebase.


15. Success Metrics & KPIs
15.1 Product Metrics
Metric
Target (6 months)
Target (12 months)
OpenClaw plugin installs (ClawHub)
500+
5,000+
Weekly active npx runs (all sources)
1,000+
10,000+
GitHub stars
500+
3,000+
OpenClaw plugin adoption (% of active OpenClaw users)
0.5%
2%
Circuit breaker activations (runaway loops caught)
100+
1,000+
Watch mode adoption (% of active users)
10%
30%
Average token savings
15%+ for chat, 10%+ for watch/OpenClaw
25%+ for chat, 18%+ for watch/OpenClaw
Team tier conversions
10 teams
100 teams
Plugin ecosystem
2 first-party (core + OpenClaw)
5 first-party + 10 community plugins
Config file adoption
50 repos with .opengauge
500 repos with .opengauge


15.2 Technical Quality Metrics
OpenClaw provider wrapper overhead: < 5ms per call (p99), excluding async SQLite write.
Proxy latency overhead: < 5ms per request (p99).
Database write latency: < 2ms async, non-blocking to user experience.
Circuit breaker evaluation: < 1ms per call (pure in-memory trigram comparison).
Stats dashboard render: < 200ms for databases up to 100K interactions.
Zero data loss: every observed interaction must be persisted.
Fail-safety: 100% of internal OpenGauge errors swallowed — zero impact on OpenClaw agent or proxy consumer.
Optimization semantic accuracy: < 0.1% of optimized prompts produce different semantic outcomes vs original.




"OpenGauge: The cost, quality, and governance layer for every AI agent — starting with the biggest one."
