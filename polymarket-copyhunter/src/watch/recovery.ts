/**
 * CopyHunter - Watch Recovery Helpers
 */

import type { FailureInfo } from '../core/failures.js';

export interface DependencyHealthSnapshot {
  name: 'polymarket_cli' | 'polymarket_data_api';
  healthy: boolean;
  checkedAt: number;
  lastError: FailureInfo | null;
}

export interface WatchRecoveryState {
  status: 'idle' | 'backoff' | 'recovering';
  currentBackoffMs: number;
  consecutiveRetryableErrors: number;
  restartCount: number;
  lastRestartAt: number | null;
  lastRecoveryReason: string | null;
  lastHealthCheckAt: number | null;
  dependencies: DependencyHealthSnapshot[];
}

export function calculateWatchBackoffMs(
  consecutiveRetryableErrors: number,
  baseBackoffMs: number,
  maxBackoffMs: number
): number {
  if (consecutiveRetryableErrors <= 0) {
    return 0;
  }

  return Math.min(baseBackoffMs * (2 ** (consecutiveRetryableErrors - 1)), maxBackoffMs);
}

export function createInitialWatchRecoveryState(): WatchRecoveryState {
  return {
    status: 'idle',
    currentBackoffMs: 0,
    consecutiveRetryableErrors: 0,
    restartCount: 0,
    lastRestartAt: null,
    lastRecoveryReason: null,
    lastHealthCheckAt: null,
    dependencies: [],
  };
}

export function shouldScheduleDependencyRecovery(input: {
  cliHealthy: boolean;
  apiHealthy: boolean;
  consecutiveFailedChecks: number;
  hasActivePoll: boolean;
  minimumFailedChecks?: number;
}): boolean {
  if (input.cliHealthy || input.apiHealthy) {
    return false;
  }

  if (input.hasActivePoll) {
    return false;
  }

  return input.consecutiveFailedChecks >= (input.minimumFailedChecks ?? 2);
}
