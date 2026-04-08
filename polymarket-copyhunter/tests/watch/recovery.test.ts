/**
 * CopyHunter - Watch Recovery Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateWatchBackoffMs,
  createInitialWatchRecoveryState,
  shouldScheduleDependencyRecovery,
} from '../../src/watch/recovery.js';

describe('Watch Recovery Tests', () => {
  it('should calculate exponential backoff with a cap', () => {
    assert.strictEqual(calculateWatchBackoffMs(0, 1000, 16000), 0);
    assert.strictEqual(calculateWatchBackoffMs(1, 1000, 16000), 1000);
    assert.strictEqual(calculateWatchBackoffMs(2, 1000, 16000), 2000);
    assert.strictEqual(calculateWatchBackoffMs(3, 1000, 16000), 4000);
    assert.strictEqual(calculateWatchBackoffMs(10, 1000, 16000), 16000);
  });

  it('should create an empty initial recovery state', () => {
    const state = createInitialWatchRecoveryState();

    assert.strictEqual(state.status, 'idle');
    assert.strictEqual(state.currentBackoffMs, 0);
    assert.strictEqual(state.consecutiveRetryableErrors, 0);
    assert.strictEqual(state.restartCount, 0);
    assert.strictEqual(state.lastRestartAt, null);
    assert.strictEqual(state.lastRecoveryReason, null);
    assert.strictEqual(state.lastHealthCheckAt, null);
    assert.deepStrictEqual(state.dependencies, []);
  });

  it('should debounce dependency recovery until failures are consecutive and no poll is active', () => {
    assert.strictEqual(shouldScheduleDependencyRecovery({
      cliHealthy: false,
      apiHealthy: false,
      consecutiveFailedChecks: 1,
      hasActivePoll: false,
    }), false);

    assert.strictEqual(shouldScheduleDependencyRecovery({
      cliHealthy: false,
      apiHealthy: false,
      consecutiveFailedChecks: 2,
      hasActivePoll: true,
    }), false);

    assert.strictEqual(shouldScheduleDependencyRecovery({
      cliHealthy: false,
      apiHealthy: false,
      consecutiveFailedChecks: 2,
      hasActivePoll: false,
    }), true);

    assert.strictEqual(shouldScheduleDependencyRecovery({
      cliHealthy: true,
      apiHealthy: false,
      consecutiveFailedChecks: 3,
      hasActivePoll: false,
    }), false);
  });
});
