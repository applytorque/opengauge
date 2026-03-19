# OpenGauge

A local-first, token-efficient LLM chat interface.

If you just want to use it, you only need one command:

```bash
npx opengauge
```

## What this repo does

OpenGauge runs a local web chat app with:
- Token optimization (compression + deduplication + checkpoints)
- Context retrieval from conversation history (RAG-style)
- Multiple providers: Anthropic, OpenAI, Gemini, Ollama
- Local storage in SQLite at `~/.opengauge/opengauge.db`

## Use via npx (recommended)

```bash
npx opengauge
```

You do not need to install OpenGauge globally first.
`npx` will download the package (if not already cached) and run it.
On first run, it may take a little longer while it fetches the package.

This starts a local server and opens the app in your browser.

Default URL:

```txt
http://localhost:3000
```

If port 3000 is busy:

```bash
npx opengauge --port 3001
```

## First-time setup

When the app opens, configure your provider in the UI wizard, or create:

`~/.opengauge/config.yml`

Example:

```yaml
providers:
  anthropic:
    api_key: YOUR_API_KEY
    default_model: claude-opus-4-6

defaults:
  provider: anthropic
```

## Developer setup (from source)

```bash
git clone https://github.com/applytorque/opengauge.git
cd opengauge
npm install
npm run build
npm start
```

## Useful commands

```bash
npm run build        # Compile TypeScript + copy UI assets
npm start            # Run CLI entry locally
npm pack --dry-run   # Preview npm package contents
```

## Competitors and positioning

OpenGauge sits between chat UIs and full LLM observability suites.

### PromptOps / Observability tools

Examples: PromptLayer, Helicone, Langfuse, Humanloop, Arize Phoenix

- Great at: traces, eval pipelines, team dashboards, observability depth.
- OpenGauge advantage: local-first workflow, in-chat prompt improvement, duplicate-risk + token-efficiency feedback in one loop.

### Multi-model chat interfaces

Examples: LibreChat, Open WebUI, Chatbot UI, AnythingLLM

- Great at: broad chat UX and plugin ecosystems.
- OpenGauge advantage: prompt quality optimization is first-class (Improve + analytics), not only chat.

### IDE coding assistants

Examples: Continue and other IDE-native AI assistants

- Great at: deep coding workflows inside editors.
- OpenGauge advantage: model-agnostic PromptOps for any user (product, ops, research, support), not just coding.

### Cloud model platforms

Examples: Azure AI Studio, Vertex AI, Bedrock consoles

- Great at: enterprise governance and managed cloud workflows.
- OpenGauge advantage: fast setup, no cloud lock-in, supports local Ollama and cloud providers together.

### Why choose OpenGauge

- Improve prompts before send (optional Auto Improve mode)
- Measure quality, duplicates, and token efficiency after send
- Keep data local with SQLite and run quickly with `npx opengauge`

Positioning line:

> OpenGauge is PromptOps in the loop: improve prompt quality before send, measure impact after send, and reduce token waste continuously.

## License

MIT
