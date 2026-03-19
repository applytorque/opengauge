#!/usr/bin/env node

/**
 * OpenGauge CLI
 *
 * Commands:
 *   npx opengauge                Start the chat UI server
 *   npx opengauge stats          Show analytics dashboard
 *   npx opengauge watch          Start proxy watch mode
 *   npx opengauge --help         Show help
 */

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // ---- stats command ----
  if (command === 'stats') {
    const { runStats } = require('../dist/cli/stats');
    await runStats(args.slice(1));
    return;
  }

  // ---- watch command ----
  if (command === 'watch') {
    const { startWatchProxy } = require('../dist/proxy/server');
    let port = 4000;
    let optimize = false;
    let aggressiveness = 'conservative';

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
        i++;
      }
      if (args[i] === '--optimize') optimize = true;
      if (args[i] && args[i].startsWith('--aggressiveness=')) {
        aggressiveness = args[i].split('=')[1];
      }
      if (args[i] === '--help' || args[i] === '-h') {
        console.log(`
  OpenGauge Watch — Local proxy for observing LLM API traffic

  Usage:
    npx opengauge watch [options]

  Options:
    --port <number>              Port to run on (default: 4000)
    --optimize                   Enable prompt optimization
    --aggressiveness=<level>     conservative | medium | aggressive (default: conservative)
    --help, -h                   Show this help message

  Examples:
    ANTHROPIC_BASE_URL=http://localhost:4000 claude
    OPENAI_BASE_URL=http://localhost:4000/v1 your-tool
        `);
        process.exit(0);
      }
    }

    startWatchProxy({ port, optimize, aggressiveness });
    return;
  }

  // ---- Default: start chat UI server ----
  const { createServer } = require('../dist/server/index');

  let port = 3000;
  let shouldOpen = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--no-open') {
      shouldOpen = false;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
  OpenGauge — PromptOps observability platform

  Usage:
    npx opengauge [command] [options]

  Commands:
    (default)       Start the chat UI server
    stats           Show analytics dashboard
    watch           Start proxy watch mode for IDE agents

  Options (chat server):
    --port <number>   Port to run on (default: 3000)
    --no-open         Don't open browser automatically
    --help, -h        Show this help message

  Stats options:
    --period=<N>d|h|w|m   Time period (e.g. 7d, 24h, 4w)
    --model=<name>        Filter by model
    --source=<name>       Filter by source (chat, openclaw, proxy)
    --alerts              Show active alerts only
    --json                Machine-readable JSON output
    --compare             Show optimization comparison

  Watch options:
    --port <number>       Proxy port (default: 4000)
    --optimize            Enable prompt optimization
    --aggressiveness=<l>  conservative | medium | aggressive

  Config:
    ~/.opengauge/config.yml    Provider configuration
    ~/.opengauge/opengauge.db  SQLite database
      `);
      process.exit(0);
    }
  }

  console.log(`
  ⚡ OpenGauge v0.2.0
  PromptOps observability platform
  `);

  await createServer(port);

  if (shouldOpen) {
    try {
      const open = (await import('open')).default;
      await open(`http://localhost:${port}`);
    } catch {
      console.log(`  Open http://localhost:${port} in your browser\n`);
    }
  }
}

main().catch((err) => {
  console.error('Failed to start OpenGauge:', err);
  process.exit(1);
});
