#!/usr/bin/env node

/**
 * OpenGauge CLI — starts the server and opens the browser
 *
 * Usage:
 *   npx opengauge
 *   npx opengauge --port 8080
 *   npx opengauge --no-open
 */

const { createServer } = require('../dist/server/index');

async function main() {
  const args = process.argv.slice(2);

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
  OpenGauge — Token-efficient LLM chat interface

  Usage:
    npx opengauge [options]

  Options:
    --port <number>   Port to run on (default: 3000)
    --no-open         Don't open browser automatically
    --help, -h        Show this help message

  Config:
    ~/.opengauge/config.yml    Provider configuration
    ~/.opengauge/opengauge.db  SQLite database

  Homepage: https://github.com/opengauge/opengauge
      `);
      process.exit(0);
    }
  }

  console.log(`
  ⚡ OpenGauge v0.1.0
  Token-efficient LLM chat interface
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
