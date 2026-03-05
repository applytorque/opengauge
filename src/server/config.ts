/**
 * Configuration management — reads/writes YAML config
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { ProviderConfig, ProviderName } from '../core/providers/adapter';

export interface AppConfig {
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  defaults?: {
    provider?: ProviderName;
    system_prompt?: string;
  };
  optimizer?: {
    compression_level?: number;
    checkpoint_interval?: number;
    keep_recent?: number;
    rag_top_k?: number;
    target_savings_percent?: number;
    quality_floor_tokens?: number;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.opengauge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yml');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = yaml.load(content) as AppConfig;
      return config || { providers: {} };
    }
  } catch (error) {
    console.warn('Failed to load config:', error);
  }
  return { providers: {} };
}

export function saveConfig(config: AppConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
}

export function updateProviderConfig(
  providerName: ProviderName,
  providerConfig: ProviderConfig
): AppConfig {
  const config = loadConfig();
  config.providers[providerName] = {
    ...config.providers[providerName],
    ...providerConfig,
  };
  saveConfig(config);
  return config;
}

export function getDefaultProvider(config: AppConfig): ProviderName | null {
  if (config.defaults?.provider) return config.defaults.provider;

  // Auto-detect: use the first configured provider
  const providers = Object.keys(config.providers) as ProviderName[];
  for (const name of providers) {
    const p = config.providers[name];
    if (p?.api_key || name === 'ollama') {
      return name;
    }
  }

  return null;
}
