/**
 * Dynamic pricing loader — loads model pricing from:
 *   1. User config (~/.opengauge/config.yml pricing section)
 *   2. Cached remote pricing (model_profiles DB table)
 *   3. Local pricing.json bundled with the package
 *
 * Falls back to hardcoded MODEL_PROFILES if all else fails.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerModelProfile, type ModelProfile } from './index';

const REMOTE_PRICING_URL =
  'https://raw.githubusercontent.com/applytorque/opengauge/main/pricing.json';

/**
 * Load pricing from the bundled pricing.json file.
 */
export function loadBundledPricing(): ModelProfile[] {
  try {
    // Try to find pricing.json relative to the package root
    const candidates = [
      path.resolve(__dirname, '../../../pricing.json'),   // from dist/core/cost/
      path.resolve(__dirname, '../../pricing.json'),      // fallback
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (Array.isArray(data.models)) {
          return data.models as ModelProfile[];
        }
      }
    }
  } catch {
    // Ignore — fall back to hardcoded
  }
  return [];
}

/**
 * Load custom pricing overrides from ~/.opengauge/config.yml
 */
export function loadUserPricingOverrides(): ModelProfile[] {
  try {
    const configPath = path.join(os.homedir(), '.opengauge', 'config.yml');
    if (!fs.existsSync(configPath)) return [];

    // Lazy-load js-yaml only when needed
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as any;

    if (!config?.pricing || !Array.isArray(config.pricing)) return [];

    return config.pricing.map((entry: any) => ({
      provider: entry.provider,
      model: entry.model,
      inputPricePer1M: entry.inputPricePer1M ?? entry.input_price_per_1m ?? 0,
      outputPricePer1M: entry.outputPricePer1M ?? entry.output_price_per_1m ?? 0,
      contextWindow: entry.contextWindow ?? entry.context_window,
    })).filter((p: any) => p.provider && p.model);
  } catch {
    return [];
  }
}

/**
 * Fetch latest pricing from remote and return parsed profiles.
 */
export async function fetchRemotePricing(): Promise<ModelProfile[]> {
  const https = require('https');
  const http = require('http');

  return new Promise((resolve) => {
    const transport = REMOTE_PRICING_URL.startsWith('https') ? https : http;
    const req = transport.get(REMOTE_PRICING_URL, { timeout: 10000 }, (res: any) => {
      if (res.statusCode !== 200) {
        resolve([]);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (Array.isArray(data.models)) {
            resolve(data.models as ModelProfile[]);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/**
 * Cache pricing profiles to the model_profiles DB table.
 */
export function cachePricingToDb(
  db: any,
  profiles: ModelProfile[]
): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO model_profiles (model_id, provider, cost_per_1m_in, cost_per_1m_out, max_context, preferred_format, optimization_rules, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        provider = excluded.provider,
        cost_per_1m_in = excluded.cost_per_1m_in,
        cost_per_1m_out = excluded.cost_per_1m_out,
        max_context = excluded.max_context,
        updated_at = excluded.updated_at
    `);

    const now = Date.now();
    const tx = db.transaction(() => {
      for (const p of profiles) {
        stmt.run(`${p.provider}:${p.model}`, p.provider, p.inputPricePer1M, p.outputPricePer1M, p.contextWindow || null, now);
      }
    });
    tx();
  } catch {
    // Non-blocking
  }
}

/**
 * Load cached pricing from the model_profiles DB table.
 */
export function loadPricingFromDb(db: any): ModelProfile[] {
  try {
    const rows = db.prepare(`SELECT * FROM model_profiles`).all() as Array<{
      model_id: string; provider: string; cost_per_1m_in: number;
      cost_per_1m_out: number; max_context: number | null; updated_at: number;
    }>;

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model_id.includes(':') ? r.model_id.split(':').slice(1).join(':') : r.model_id,
      inputPricePer1M: r.cost_per_1m_in,
      outputPricePer1M: r.cost_per_1m_out,
      contextWindow: r.max_context ?? undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Initialize pricing: load from bundled file, then DB cache, then user overrides.
 * User overrides take highest priority.
 */
export function initPricing(db?: any): void {
  // 1. Load bundled pricing.json (supplements hardcoded defaults)
  const bundled = loadBundledPricing();
  for (const p of bundled) {
    registerModelProfile(p);
  }

  // 2. Load from DB cache (may have newer remote data)
  if (db) {
    const cached = loadPricingFromDb(db);
    for (const p of cached) {
      registerModelProfile(p);
    }
  }

  // 3. User config overrides (highest priority)
  const overrides = loadUserPricingOverrides();
  for (const p of overrides) {
    registerModelProfile(p);
  }
}
