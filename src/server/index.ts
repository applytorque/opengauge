/**
 * Fastify server setup for OpenGauge
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { registerRoutes } from './routes';
import { getDb, closeDb } from '../db';

export async function createServer(port: number = 3000) {
  const app = Fastify({
    logger: {
      level: 'info',
    },
  });

  // CORS for local development
  await app.register(fastifyCors, {
    origin: true,
  });

  // Serve static UI files
  // In development they're in src/ui/static, in production in dist/ui/static
  let staticPath = path.join(__dirname, '..', 'ui', 'static');
  if (!require('fs').existsSync(staticPath)) {
    // Fallback: look relative to the project root (src/ui/static)
    staticPath = path.join(__dirname, '..', '..', 'src', 'ui', 'static');
  }
  await app.register(fastifyStatic, {
    root: staticPath,
    prefix: '/',
  });

  // Initialize database
  getDb();

  // Register API routes
  registerRoutes(app);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    closeDb();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n  OpenGauge is running at http://localhost:${port}\n`);
    return app;
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
