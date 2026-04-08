/**
 * CopyHunter - Watch Status Display Helpers
 */

import type { FailureInfo } from '../core/failures.js';
import type { WatchEngineStats } from './engine.js';
import type { WatchStatusSnapshot } from './runtime-state.js';

export interface WatchDisplayStatus {
  label: 'STOPPED' | 'STALE' | 'RUNNING' | 'BACKOFF' | 'RECOVERING' | 'ERROR' | 'STARTING';
  color: 'gray' | 'yellow' | 'green' | 'red' | 'cyan';
  detail: string | null;
  dependencySummary: string | null;
  unhealthyDependencies: string[];
}

export function resolveActiveWatchSnapshot(
  runningPid: number | null,
  persistedStatus: WatchStatusSnapshot | null
): WatchStatusSnapshot | null {
  if (!runningPid || !persistedStatus || persistedStatus.pid !== runningPid) {
    return null;
  }
  return persistedStatus;
}

export function collectUnhealthyDependencies(snapshot: WatchStatusSnapshot | null): string[] {
  return snapshot?.recovery?.dependencies
    .filter((dependency) => !dependency.healthy)
    .map((dependency) => dependency.name) ?? [];
}

export function formatUnhealthyDependencySummary(unhealthyDependencies: string[]): string | null {
  if (unhealthyDependencies.length === 0) {
    return null;
  }

  return unhealthyDependencies.join(', ');
}

export function buildWatchDisplayStatus(input: {
  runningPid: number | null;
  stale: boolean;
  snapshot: WatchStatusSnapshot | null;
  engineStats: WatchEngineStats;
  visibleErrorInfo?: FailureInfo | null;
  visibleErrorMessage?: string | null;
}): WatchDisplayStatus {
  const unhealthyDependencies = collectUnhealthyDependencies(input.snapshot);
  const dependencySummary = formatUnhealthyDependencySummary(unhealthyDependencies);
  const errorMessage = input.visibleErrorMessage
    ?? input.visibleErrorInfo?.message
    ?? input.snapshot?.lastError
    ?? input.engineStats.lastError?.message
    ?? null;
  const recovery = input.snapshot?.recovery ?? null;

  if (!input.runningPid) {
    return {
      label: 'STOPPED',
      color: 'gray',
      detail: null,
      dependencySummary,
      unhealthyDependencies,
    };
  }

  if (input.stale) {
    return {
      label: 'STALE',
      color: 'yellow',
      detail: errorMessage ?? 'Status updates are delayed.',
      dependencySummary,
      unhealthyDependencies,
    };
  }

  if (recovery?.status === 'recovering') {
    return {
      label: 'RECOVERING',
      color: 'yellow',
      detail: recovery.lastRecoveryReason ?? errorMessage ?? 'Restarting watch engine.',
      dependencySummary,
      unhealthyDependencies,
    };
  }

  if (recovery?.status === 'backoff') {
    const backoffSeconds = (recovery.currentBackoffMs / 1000).toFixed(1);
    const detail = recovery.lastRecoveryReason ?? errorMessage ?? `Retrying in ${backoffSeconds}s.`;

    return {
      label: 'BACKOFF',
      color: 'yellow',
      detail: `${detail} Retry in ${backoffSeconds}s.`,
      dependencySummary,
      unhealthyDependencies,
    };
  }

  if (errorMessage && !input.snapshot?.running && !input.engineStats.isRunning) {
    return {
      label: 'ERROR',
      color: 'red',
      detail: errorMessage,
      dependencySummary,
      unhealthyDependencies,
    };
  }

  if (input.snapshot?.running || input.engineStats.isRunning) {
    return {
      label: 'RUNNING',
      color: 'green',
      detail: errorMessage,
      dependencySummary,
      unhealthyDependencies,
    };
  }

  return {
    label: 'STARTING',
    color: 'cyan',
    detail: errorMessage,
    dependencySummary,
    unhealthyDependencies,
  };
}
