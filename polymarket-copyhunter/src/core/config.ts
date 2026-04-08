/**
 * CopyHunter - Configuration Management
 */

import { z } from 'zod';
import Conf from 'conf';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { isDeepStrictEqual } from 'node:util';
import type { AppConfig } from './types.js';

// ============ Zod Schemas ============

const LeadersConfigSchema = z.object({
  autoImport: z.boolean().default(false),
  importTop: z.number().min(1).max(100).default(10),
  importPeriod: z.enum(['weekly', 'monthly']).default('monthly'),
});

const WatchConfigSchema = z.object({
  interval: z.number().min(5000).max(300000).default(30000),
  sources: z.array(z.enum(['polling', 'websocket'])).default(['polling']),
  filterMinUsd: z.number().min(0).default(10),
});

const FollowConfigSchema = z.object({
  mode: z.enum(['shadow', 'live', 'disabled']).default('shadow'),
  followerAddress: z.string().default(''),
  sizingMode: z.enum(['fixed', 'proportional']).default('fixed'),
  bankrollUsd: z.number().min(1).default(1000),
  maxPerTrade: z.number().min(1).default(50),
  dailyLimit: z.number().min(0).default(500),
  allowlist: z.array(z.string()).default([]),
  blocklist: z.array(z.string()).default([]),
});

const RiskConfigSchema = z.object({
  maxExposure: z.number().min(0).default(1000),
  maxPositions: z.number().min(1).default(20),
  maxLossPerDay: z.number().min(0).default(100),
  stopLossPercent: z.number().min(0).max(1).default(0.2),
});

const DisplayConfigSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  refreshInterval: z.number().min(1000).default(5000),
});

export const AppConfigSchema = z.object({
  leaders: LeadersConfigSchema.default({}),
  watch: WatchConfigSchema.default({}),
  follow: FollowConfigSchema.default({}),
  risk: RiskConfigSchema.default({}),
  display: DisplayConfigSchema.default({}),
});

// ============ Data Directory ============

const APP_NAME = 'copyhunter';

/**
 * Get the data directory for CopyHunter
 * Uses XDG_DATA_HOME on Linux, ~/.copyhunter elsewhere
 */
export function getDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  let dataDir: string;

  if (xdgDataHome) {
    dataDir = join(xdgDataHome, APP_NAME);
  } else if (process.platform === 'darwin') {
    dataDir = join(homedir(), `.${APP_NAME}`);
  } else if (process.platform === 'win32') {
    dataDir = join(process.env.APPDATA || homedir(), APP_NAME);
  } else {
    dataDir = join(homedir(), `.${APP_NAME}`);
  }

  // Ensure directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}

/**
 * Get the logs directory
 */
export function getLogsDir(): string {
  const logsDir = join(getDataDir(), 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

/**
 * Get the database file path
 */
export function getDbPath(): string {
  return join(getDataDir(), 'copyhunter.db');
}

// ============ Config Store ============

const defaultConfig: AppConfig = AppConfigSchema.parse({});

let configStore: Conf<AppConfig> | null = null;

function clearConfigStore(): void {
  configStore = null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getPathSegments(path: string): string[] {
  const segments = path.split('.').filter(Boolean);

  if (segments.length === 0) {
    throw new Error('Config path must not be empty.');
  }

  return segments;
}

function getNestedValue(target: unknown, path: string): unknown {
  let current = target;

  for (const segment of getPathSegments(path)) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = getPathSegments(path);
  let current: Record<string, unknown> = target;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];

    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  current[segments.at(-1)!] = value;
}

function getConfigStore(): Conf<AppConfig> {
  if (!configStore) {
    configStore = new Conf<AppConfig>({
      projectName: APP_NAME,
      cwd: getDataDir(),
      defaults: defaultConfig,
      schema: {
        leaders: {
          type: 'object',
          properties: {
            autoImport: { type: 'boolean' },
            importTop: { type: 'number' },
            importPeriod: { type: 'string' },
          },
        },
        watch: {
          type: 'object',
          properties: {
            interval: { type: 'number' },
            sources: { type: 'array' },
            filterMinUsd: { type: 'number' },
          },
        },
        follow: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            followerAddress: { type: 'string' },
            sizingMode: { type: 'string' },
            bankrollUsd: { type: 'number' },
            maxPerTrade: { type: 'number' },
            dailyLimit: { type: 'number' },
            allowlist: { type: 'array' },
            blocklist: { type: 'array' },
          },
        },
        risk: {
          type: 'object',
          properties: {
            maxExposure: { type: 'number' },
            maxPositions: { type: 'number' },
            maxLossPerDay: { type: 'number' },
            stopLossPercent: { type: 'number' },
          },
        },
        display: {
          type: 'object',
          properties: {
            theme: { type: 'string' },
            refreshInterval: { type: 'number' },
          },
        },
      },
    });
  }
  return configStore;
}

// ============ Config API ============

/**
 * Get the full configuration
 */
export function getConfig(): AppConfig {
  const store = getConfigStore();
  return AppConfigSchema.parse(store.store);
}

/**
 * Get a specific config value by path
 */
export function getConfigValue<T>(path: string): T | undefined {
  return getNestedValue(getConfig(), path) as T | undefined;
}

/**
 * Set a specific config value by path
 */
export function setConfigValue(path: string, value: unknown): void {
  const store = getConfigStore();
  const nextConfig = structuredClone(getConfig()) as unknown as Record<string, unknown>;

  setNestedValue(nextConfig, path, value);

  const parsedConfig = AppConfigSchema.parse(nextConfig);
  store.store = parsedConfig;

  const expectedValue = getNestedValue(parsedConfig, path);
  const deadline = Date.now() + 500;

  while (Date.now() <= deadline) {
    clearConfigStore();
    const persistedValue = getNestedValue(getConfig(), path);

    if (isDeepStrictEqual(persistedValue, expectedValue)) {
      return;
    }

    sleepSync(25);
  }

  throw new Error(`Failed to persist config value for "${path}".`);
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  const store = getConfigStore();
  store.clear();
  clearConfigStore();
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return getConfigStore().path;
}
