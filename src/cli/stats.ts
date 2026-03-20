/**
 * opengauge stats — Terminal analytics dashboard
 *
 * Reads the SQLite database and renders analytics to the terminal.
 * Supports filtering by period, model, source, and output format.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { getDb } from '../db';
import { SessionQueries } from '../db/session-queries';
import { Queries } from '../db/queries';
import { initPricing } from '../core/cost/pricing-loader';

// ---- Argument parsing ----

export interface StatsOptions {
  period?: string;       // e.g. "7d", "30d", "24h"
  model?: string;        // filter by model name
  source?: string;       // filter by source
  alerts?: boolean;      // show alerts only
  json?: boolean;        // machine-readable JSON output
  compare?: boolean;     // show optimization comparison
  help?: boolean;        // show command help
}

export function parseStatsArgs(args: string[]): StatsOptions {
  const opts: StatsOptions = {};
  for (const arg of args) {
    if (arg.startsWith('--period=')) opts.period = arg.split('=')[1];
    else if (arg.startsWith('--model=')) opts.model = arg.split('=')[1];
    else if (arg.startsWith('--source=')) opts.source = arg.split('=')[1];
    else if (arg === '--alerts') opts.alerts = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--compare') opts.compare = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printStatsHelp(): void {
  console.log(`
  OpenGauge Stats — Terminal analytics dashboard

  Usage:
    npx opengauge stats [options]

  Options:
    --period=<N>d|h|w|m   Time period (e.g. 7d, 24h, 4w)
    --model=<name>        Filter by model
    --source=<name>       Filter by source (chat, openclaw, proxy)
    --alerts              Show active alerts only
    --json                Machine-readable JSON output
    --compare             Show optimization comparison
    --help, -h            Show this help message

  Examples:
    npx opengauge stats
    npx opengauge stats --period=7d --source=proxy
    npx opengauge stats --json
  `);
}

function parsePeriod(period?: string): number | undefined {
  if (!period) return undefined;
  const match = period.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return undefined;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  const ms: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
  return Date.now() - val * (ms[unit] || 86400000);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(startMs: number, endMs: number | null): string {
  const duration = (endMs || Date.now()) - startMs;
  const mins = Math.floor(duration / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// ---- Main stats command ----

export async function runStats(args: string[]): Promise<void> {
  const opts = parseStatsArgs(args);

  if (opts.help) {
    printStatsHelp();
    return;
  }

  const db = getDb();
  initPricing(db);
  const sq = new SessionQueries(db);
  const since = parsePeriod(opts.period);

  if (opts.json) {
    return runStatsJson(sq, opts, since);
  }

  if (opts.alerts) {
    return renderAlerts(sq, since);
  }

  if (opts.compare) {
    return renderComparison(sq, since);
  }

  // ---- Header ----
  console.log();
  console.log(chalk.bold.cyan('  OpenGauge Stats'));
  console.log(chalk.dim(`  ${opts.period ? `Last ${opts.period}` : 'All time'}${opts.source ? ` · source: ${opts.source}` : ''}${opts.model ? ` · model: ${opts.model}` : ''}`));
  console.log();

  // ---- Total Spend ----
  const summary = sq.getSpendSummary(since, opts.source);
  const spendTable = new Table({
    head: ['Metric', 'Value'].map(h => chalk.bold(h)),
    style: { head: [], border: [] },
  });
  spendTable.push(
    ['Total Spend', chalk.yellow(formatCost(summary.total_cost_usd))],
    ['Tokens In', formatTokens(summary.total_tokens_in)],
    ['Tokens Out', formatTokens(summary.total_tokens_out)],
    ['Tokens Saved', chalk.green(formatTokens(summary.total_tokens_saved))],
    ['Cost Saved', chalk.green(formatCost(summary.total_cost_saved_usd))],
    ['Sessions', String(summary.session_count)],
    ['API Calls', String(summary.interaction_count)],
  );
  console.log(chalk.bold('  Total Spend'));
  console.log(spendTable.toString());
  console.log();

  // ---- Spend by Source ----
  const sources = ['chat', 'openclaw', 'proxy', 'log_ingest'];
  const sourceRows: string[][] = [];
  for (const src of sources) {
    const s = sq.getSpendSummary(since, src);
    if (s.session_count > 0) {
      sourceRows.push([src, formatCost(s.total_cost_usd), String(s.session_count), String(s.interaction_count)]);
    }
  }
  if (sourceRows.length > 0) {
    const sourceTable = new Table({
      head: ['Source', 'Spend', 'Sessions', 'Calls'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });
    sourceTable.push(...sourceRows);
    console.log(chalk.bold('  Spend by Source'));
    console.log(sourceTable.toString());
    console.log();
  }

  // ---- Model Distribution ----
  const models = sq.getModelUsage(since);
  if (models.length > 0) {
    const modelTable = new Table({
      head: ['Provider', 'Model', 'Spend', 'Tokens In', 'Tokens Out', 'Sessions'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });
    for (const m of models.slice(0, 10)) {
      modelTable.push([
        m.provider, m.model,
        chalk.yellow(formatCost(m.total_cost_usd)),
        formatTokens(m.total_tokens_in),
        formatTokens(m.total_tokens_out),
        String(m.session_count),
      ]);
    }
    console.log(chalk.bold('  Model Distribution'));
    console.log(modelTable.toString());
    console.log();
  }

  // ---- Daily Spend Trend ----
  const daily = sq.getDailySpend(opts.period ? parseInt(opts.period) || 7 : 7);
  if (daily.length > 0) {
    const dailyTable = new Table({
      head: ['Date', 'Spend', 'Tokens', 'Sessions'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });
    for (const d of daily.slice(0, 14)) {
      dailyTable.push([
        d.day,
        chalk.yellow(formatCost(d.cost_usd)),
        formatTokens(d.tokens_in + d.tokens_out),
        String(d.sessions),
      ]);
    }
    console.log(chalk.bold('  Daily Spend'));
    console.log(dailyTable.toString());
    console.log();
  }

  // ---- Top Sessions by Cost ----
  const topSessions = sq.getTopSessionsByCost(5, since);
  if (topSessions.length > 0) {
    const sessionTable = new Table({
      head: ['Source', 'Model', 'Cost', 'Calls', 'Duration'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });
    for (const s of topSessions) {
      sessionTable.push([
        s.source,
        s.model,
        chalk.yellow(formatCost(s.total_cost_usd)),
        String(s.interaction_count),
        formatDuration(s.started_at, s.ended_at),
      ]);
    }
    console.log(chalk.bold('  Top Sessions by Cost'));
    console.log(sessionTable.toString());
    console.log();
  }

  // ---- Circuit Breaker Activity ----
  const alertSummary = sq.getAlertSummary(since);
  if (alertSummary.length > 0) {
    const alertTable = new Table({
      head: ['Type', 'Severity', 'Count'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });
    for (const a of alertSummary) {
      const severityColor = a.severity === 'critical' ? chalk.red : a.severity === 'warning' ? chalk.yellow : chalk.dim;
      alertTable.push([a.alert_type, severityColor(a.severity), String(a.count)]);
    }
    console.log(chalk.bold('  Circuit Breaker Activity'));
    console.log(alertTable.toString());
    console.log();
  }

  // ---- Active Alerts ----
  const activeAlerts = sq.queryAlerts({ dismissed: false, limit: 5, since });
  if (activeAlerts.length > 0) {
    console.log(chalk.bold('  Active Alerts'));
    for (const alert of activeAlerts) {
      const icon = alert.severity === 'critical' ? chalk.red('!!') : alert.severity === 'warning' ? chalk.yellow('!!') : chalk.dim('i');
      console.log(`  ${icon} [${alert.alert_type}] ${alert.message}`);
    }
    console.log();
  }

  // ---- Also include legacy chat UI stats ----
  try {
    const legacyQueries = new Queries(db);
    const legacyUsage = legacyQueries.getAggregatedTokenUsage();
    if (legacyUsage.length > 0) {
      const legacyTable = new Table({
        head: ['Provider', 'Model', 'Tokens In', 'Tokens Out', 'Saved', 'Requests'].map(h => chalk.bold(h)),
        style: { head: [], border: [] },
      });
      for (const u of legacyUsage) {
        legacyTable.push([
          u.provider, u.model,
          formatTokens(u.total_tokens_in),
          formatTokens(u.total_tokens_out),
          chalk.green(formatTokens(u.total_tokens_saved)),
          String(u.request_count),
        ]);
      }
      console.log(chalk.bold('  Chat UI Usage (legacy)'));
      console.log(legacyTable.toString());
      console.log();
    }
  } catch {
    // Legacy tables may not exist
  }
}

// ---- JSON output ----

function runStatsJson(sq: SessionQueries, opts: StatsOptions, since?: number): void {
  const days = opts.period ? parseInt(opts.period) || 7 : 30;
  const output = {
    meta: {
      version: '0.2.5',
      generatedAt: new Date().toISOString(),
      filters: {
        period: opts.period || null,
        model: opts.model || null,
        source: opts.source || null,
      },
    },
    summary: sq.getSpendSummary(since, opts.source),
    models: sq.getModelUsage(since, opts.source),
    daily: sq.getDailySpend(days),
    topSessions: sq.getTopSessionsByCost(10, since, opts.source),
    alerts: sq.queryAlerts({ dismissed: false, limit: 20, since }),
    alertSummary: sq.getAlertSummary(since),
  };
  console.log(JSON.stringify(output, null, 2));
}

// ---- Alerts view ----

function renderAlerts(sq: SessionQueries, since?: number): void {
  const alerts = sq.queryAlerts({ dismissed: false, since, limit: 50 });

  console.log();
  console.log(chalk.bold.cyan('  OpenGauge Alerts'));
  console.log();

  if (alerts.length === 0) {
    console.log(chalk.green('  No active alerts.'));
    console.log();
    return;
  }

  for (const alert of alerts) {
    const icon = alert.severity === 'critical' ? chalk.red.bold('CRITICAL')
      : alert.severity === 'warning' ? chalk.yellow.bold('WARNING')
      : chalk.dim('INFO');
    const time = new Date(alert.created_at).toLocaleString();

    console.log(`  ${icon}  ${chalk.bold(alert.alert_type)}`);
    console.log(`  ${alert.message}`);
    console.log(chalk.dim(`  ${time}  session: ${alert.session_id.slice(0, 8)}...`));
    console.log();
  }
}

// ---- Comparison view (A/B optimization) ----

function renderComparison(sq: SessionQueries, since?: number): void {
  const summary = sq.getSpendSummary(since);

  console.log();
  console.log(chalk.bold.cyan('  OpenGauge Optimization Comparison'));
  console.log();

  if (summary.interaction_count === 0) {
    console.log(chalk.dim('  No data available.'));
    console.log();
    return;
  }

  const actualSpend = summary.total_cost_usd;
  const savedAmount = summary.total_cost_saved_usd;
  const optimizedSpend = actualSpend - savedAmount;
  const savingsPercent = actualSpend > 0 ? (savedAmount / actualSpend) * 100 : 0;

  console.log(`  ${chalk.bold('API calls observed:')}  ${summary.interaction_count}`);
  console.log(`  ${chalk.bold('Actual spend:')}       ${chalk.yellow(formatCost(actualSpend))}`);
  console.log(`  ${chalk.bold('Optimized spend:')}    ${chalk.green(formatCost(optimizedSpend))}  ${chalk.green(`(saved ${formatCost(savedAmount)} / ${savingsPercent.toFixed(1)}%)`)}`);
  console.log();
}
