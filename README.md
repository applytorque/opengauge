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

## License

MIT
