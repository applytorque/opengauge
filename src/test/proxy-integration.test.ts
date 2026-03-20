import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Set up isolated DB before importing anything that uses getDb
const testDbPath = path.join(os.tmpdir(), `opengauge-test-${Date.now()}.db`);
process.env.OPENGAUGE_DB_PATH = testDbPath;

import { startWatchProxy } from '../proxy/server';
import { getDb, closeDb } from '../db';
import { SessionQueries } from '../db/session-queries';

function makeRequest(
  port: number,
  path: string,
  body: object,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Proxy integration', () => {
  let mockServer: http.Server;
  let proxyServer: http.Server;
  let mockPort: number;
  const proxyPort = 14000 + Math.floor(Math.random() * 1000);

  before(async () => {
    // Start a mock upstream that returns canned Anthropic responses
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from mock!' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 50, output_tokens: 20 },
        }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as any).port;
        resolve();
      });
    });

    // Start the proxy — we can't easily redirect upstream, so we test
    // the health endpoint and unknown-path handling. For full E2E, we'd
    // need to patch PROVIDER_MAP at runtime.
    proxyServer = startWatchProxy({ port: proxyPort });
    // Give server time to bind
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    proxyServer.close();
    mockServer.close();
    closeDb();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
    try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
  });

  it('health endpoint returns ok', async () => {
    const result = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/health`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      }).on('error', reject);
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'ok');
    assert.equal(result.body.mode, 'watch');
  });

  it('returns 404 for unknown paths', async () => {
    const result = await makeRequest(proxyPort, '/unknown/path', { model: 'test' });
    assert.equal(result.statusCode, 404);
  });

  it('stats endpoint returns spend summary', async () => {
    const result = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/__opengauge/stats`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      }).on('error', reject);
    });

    assert.equal(result.statusCode, 200);
    assert.ok('total_cost_usd' in result.body);
    assert.ok('session_count' in result.body);
  });

  it('DB schema is initialized with sessions and interactions tables', () => {
    const db = getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('interactions'));
    assert.ok(names.includes('alerts'));
    assert.ok(names.includes('model_profiles'));
  });

  it('SessionQueries can create and query sessions', () => {
    const db = getDb();
    const sq = new SessionQueries(db);

    const session = sq.createSession('proxy', 'claude-sonnet-4-6', 'anthropic');
    assert.ok(session.id);
    assert.equal(session.source, 'proxy');

    sq.writeInteraction(session.id, 1, 'claude-sonnet-4-6', {
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      originalPrompt: 'test prompt',
      responseText: 'test response',
    });
    sq.updateSessionAggregates(session.id, 100, 50, 0.001);

    const summary = sq.getSpendSummary(undefined, 'proxy');
    assert.ok(summary.total_cost_usd >= 0.001);
    assert.ok(summary.total_tokens_in >= 100);
  });
});
