import fs from 'fs';
import path from 'path';
import os from 'os';

export interface OpenClawCircuitBreakerConfig {
  enabled: boolean;
  similarity_threshold: number;
  max_similar_calls: number;
  escalation_check: boolean;
  action: 'warn' | 'block';
}

export interface OpenClawBudgetConfig {
  session_limit_usd: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
}

export interface OpenClawPluginConfig {
  circuit_breaker: OpenClawCircuitBreakerConfig;
  budget: OpenClawBudgetConfig;
  optimize: boolean;
  log_response_text: boolean;
  log_full_request: boolean;
  session_timeout_ms: number;
}

const DEFAULT_CONFIG: OpenClawPluginConfig = {
  circuit_breaker: {
    enabled: true,
    similarity_threshold: 0.8,
    max_similar_calls: 5,
    escalation_check: true,
    action: 'warn',
  },
  budget: {
    session_limit_usd: 5.00,
    daily_limit_usd: 20.00,
    monthly_limit_usd: 400.00,
  },
  optimize: false,
  log_response_text: true,
  log_full_request: false,
  session_timeout_ms: 5 * 60 * 1000, // 5 minutes
};

export function loadPluginConfig(): OpenClawPluginConfig {
  const configPath = path.join(os.homedir(), '.opengauge', 'config.yml');

  try {
    if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };

    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      const yaml = require('js-yaml');
      const parsed = yaml.load(raw) as any;
      if (!parsed?.openclaw) return { ...DEFAULT_CONFIG };

      const oc = parsed.openclaw;
      return {
        circuit_breaker: {
          ...DEFAULT_CONFIG.circuit_breaker,
          ...oc.circuit_breaker,
        },
        budget: {
          ...DEFAULT_CONFIG.budget,
          ...oc.budget,
        },
        optimize: oc.optimize ?? DEFAULT_CONFIG.optimize,
        log_response_text: oc.log_response_text ?? DEFAULT_CONFIG.log_response_text,
        log_full_request: oc.log_full_request ?? DEFAULT_CONFIG.log_full_request,
        session_timeout_ms: oc.session_timeout_ms ?? DEFAULT_CONFIG.session_timeout_ms,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getErrorLogPath(): string {
  return path.join(os.homedir(), '.opengauge', 'error.log');
}

export function logError(error: unknown): void {
  try {
    const logPath = getErrorLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.stack || error.message : String(error);
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch {
    // If we can't even write error logs, silently fail
  }
}
