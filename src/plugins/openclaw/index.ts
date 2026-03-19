/**
 * @opengauge/openclaw-plugin
 *
 * OpenClaw plugin that wraps every LLM provider call via registerProvider,
 * logging every individual API call to @opengauge/core's SQLite database.
 *
 * Features:
 *   - Per-call cost tracking
 *   - Runaway loop detection (circuit breaker)
 *   - Budget enforcement (session/daily/monthly)
 *   - Fail-safe: never crashes the agent
 *
 * Install: openclaw plugins install @opengauge/openclaw-plugin
 */

import { getDb, initSchema } from '../../core';
import { WrappedProvider, type OpenClawProvider } from './wrapped-provider';
import { loadPluginConfig, logError } from './config';

/**
 * OpenClaw plugin API interface (minimal — matches registerProvider + registerCommand).
 */
interface OpenClawPluginAPI {
  registerProvider(provider: any): void;
  registerCommand?(name: string, handler: (args: string[]) => Promise<string | void>): void;
  getProvider?(): OpenClawProvider;
  on?(event: string, handler: (...args: any[]) => void): void;
}

let wrappedProvider: WrappedProvider | null = null;

/**
 * Plugin entry point — called by OpenClaw when the plugin is loaded.
 */
export function register(api: OpenClawPluginAPI): void {
  try {
    // Initialize database
    const db = getDb();
    initSchema(db);

    const config = loadPluginConfig();

    // Get the current provider and wrap it
    const realProvider = api.getProvider?.();
    if (!realProvider) {
      logError(new Error('OpenGauge: Could not get current provider from OpenClaw API'));
      return;
    }

    wrappedProvider = new WrappedProvider(realProvider, config);

    // Register the wrapped provider
    api.registerProvider(wrappedProvider);

    // Register optional stats command
    if (api.registerCommand) {
      api.registerCommand('opengauge-stats', async (args: string[]) => {
        try {
          const { SessionQueries } = await import('../../core');
          const queries = new SessionQueries(getDb());
          const summary = queries.getSpendSummary();
          const alerts = queries.queryAlerts({ dismissed: false, limit: 5 });

          const lines: string[] = [
            '--- OpenGauge Stats ---',
            `Sessions: ${summary.session_count}`,
            `Total spend: $${summary.total_cost_usd.toFixed(4)}`,
            `Tokens: ${summary.total_tokens_in.toLocaleString()} in / ${summary.total_tokens_out.toLocaleString()} out`,
            `Tokens saved: ${summary.total_tokens_saved.toLocaleString()}`,
          ];

          if (alerts.length > 0) {
            lines.push('', '--- Active Alerts ---');
            for (const alert of alerts) {
              lines.push(`[${alert.severity.toUpperCase()}] ${alert.alert_type}: ${alert.message}`);
            }
          }

          return lines.join('\n');
        } catch (e) {
          logError(e);
          return 'OpenGauge: Failed to fetch stats. Check ~/.opengauge/error.log';
        }
      });
    }

    // Listen for shutdown to finalize session
    if (api.on) {
      api.on('gateway_stop', () => {
        wrappedProvider?.shutdown();
      });
    }

  } catch (error) {
    // Fail-safe: plugin must never crash OpenClaw
    logError(error);
  }
}

/**
 * Plugin metadata for OpenClaw's plugin system.
 */
export const metadata = {
  name: '@opengauge/openclaw-plugin',
  version: '0.1.0',
  description: 'Cost tracking, runaway loop detection, and budget enforcement for OpenClaw agents',
  author: 'OpenGauge',
};
