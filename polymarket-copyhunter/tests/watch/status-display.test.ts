/**
 * CopyHunter - Watch Status Display Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildWatchDisplayStatus,
  resolveActiveWatchSnapshot,
} from '../../src/watch/status-display.js';
import type { WatchEngineStats } from '../../src/watch/engine.js';
import type { WatchStatusSnapshot } from '../../src/watch/runtime-state.js';

function createEngineStats(overrides: Partial<WatchEngineStats> = {}): WatchEngineStats {
  return {
    isRunning: false,
    pollCount: 0,
    eventsFound: 0,
    eventsSaved: 0,
    currentPollStartedAt: null,
    leadersCompletedInPoll: 0,
    currentLeaderAddress: null,
    currentLeaderStartedAt: null,
    currentLeaderPass: 0,
    currentLeaderEventsFound: 0,
    currentLeaderEventsSaved: 0,
    currentLeaderCatchUpBudget: 0,
    currentLeaderCatchUpPassLimit: 0,
    currentLeaderCatchUpMode: 'normal',
    currentLeaderCursorTimestamp: null,
    currentLeaderCursorUpdatedAt: null,
    lastPollAt: null,
    lastSuccessfulPollAt: null,
    errors: 0,
    consecutiveErrors: 0,
    lastError: null,
    ...overrides,
  };
}

function createSnapshot(overrides: Partial<WatchStatusSnapshot> = {}): WatchStatusSnapshot {
  return {
    running: true,
    pid: 123,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    pollIntervalMs: 30_000,
    lastError: null,
    lastErrorInfo: null,
    consecutiveErrors: 0,
    engine: createEngineStats({ isRunning: true }),
    follow: null,
    recovery: {
      status: 'idle',
      currentBackoffMs: 0,
      consecutiveRetryableErrors: 0,
      restartCount: 0,
      lastRestartAt: null,
      lastRecoveryReason: null,
      lastHealthCheckAt: null,
      dependencies: [],
    },
    ...overrides,
  };
}

describe('Watch Status Display Helpers', () => {
  it('should resolve the active snapshot only when the pid matches', () => {
    const snapshot = createSnapshot({ pid: 456 });

    assert.strictEqual(resolveActiveWatchSnapshot(456, snapshot), snapshot);
    assert.strictEqual(resolveActiveWatchSnapshot(789, snapshot), null);
    assert.strictEqual(resolveActiveWatchSnapshot(null, snapshot), null);
  });

  it('should mark a live snapshot as running', () => {
    const snapshot = createSnapshot();
    const display = buildWatchDisplayStatus({
      runningPid: 123,
      stale: false,
      snapshot,
      engineStats: snapshot.engine,
    });

    assert.strictEqual(display.label, 'RUNNING');
    assert.strictEqual(display.color, 'green');
    assert.strictEqual(display.detail, null);
  });

  it('should mark a backoff snapshot with retry detail and unhealthy dependencies', () => {
    const snapshot = createSnapshot({
      running: false,
      lastError: 'fetch failed',
      recovery: {
        status: 'backoff',
        currentBackoffMs: 5000,
        consecutiveRetryableErrors: 2,
        restartCount: 1,
        lastRestartAt: 1_700_000_000_400,
        lastRecoveryReason: 'fetch failed',
        lastHealthCheckAt: 1_700_000_000_450,
        dependencies: [
          {
            name: 'polymarket_data_api',
            healthy: false,
            checkedAt: 1_700_000_000_450,
            lastError: null,
          },
        ],
      },
    });
    const display = buildWatchDisplayStatus({
      runningPid: 123,
      stale: false,
      snapshot,
      engineStats: createEngineStats(),
      visibleErrorMessage: 'fetch failed',
    });

    assert.strictEqual(display.label, 'BACKOFF');
    assert.strictEqual(display.color, 'yellow');
    assert.match(display.detail ?? '', /Retry in 5\.0s\./);
    assert.strictEqual(display.dependencySummary, 'polymarket_data_api');
  });

  it('should mark a stale snapshot even when the pid is still present', () => {
    const snapshot = createSnapshot({
      lastError: 'status updates paused',
    });
    const display = buildWatchDisplayStatus({
      runningPid: 123,
      stale: true,
      snapshot,
      engineStats: createEngineStats(),
    });

    assert.strictEqual(display.label, 'STALE');
    assert.strictEqual(display.color, 'yellow');
    assert.strictEqual(display.detail, 'status updates paused');
  });
});
