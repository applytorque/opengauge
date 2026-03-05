# OpenGauge

A local-first, token-efficient LLM chat interface that runs on your machine and helps reduce context bloat while preserving useful history.

## What this repo does

OpenGauge provides:
- A local web chat UI on `http://localhost:3000`
- Token optimization (compression + deduplication + checkpointing)
- Context retrieval from past messages (RAG-style memory)
- Provider support for Anthropic, OpenAI, Gemini, and Ollama
- Local storage via SQLite in `~/.opengauge/opengauge.db`

## Quick start

### Run directly

```bash
npx opengauge
```

### Run from source

```bash
git clone https://github.com/applytorque/opengauge.git
cd opengauge
npm install
npm run build
npm start
```

Then open:

```txt
http://localhost:3000
```

## Provider setup

On first launch, use the in-app setup wizard or create this file:

`~/.opengauge/config.yml`

```yaml
providers:
  anthropic:
    api_key: YOUR_API_KEY
    default_model: claude-opus-4-6

defaults:
  provider: anthropic
```

## Useful scripts

```bash
npm run build        # compile TypeScript + copy UI assets
npm start            # start OpenGauge
npm pack --dry-run   # preview npm package contents
```

## License

MIT
