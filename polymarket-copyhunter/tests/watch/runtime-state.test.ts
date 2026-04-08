/**
 * CopyHunter - Watch Runtime State Tests
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createWatchRuntimeStateManager,
  isWatchStatusStale,
  type WatchStatusSnapshot,
} from '../../src/watch/runtime-state.js';

const testRuntimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-runtime-state-test-'));

after(() => {
  try {
    rmSync(testRuntimeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

describe('Watch Runtime State Tests', () => {
  function createManager(isRunning: (pid: number) => boolean) {
    return createWatchRuntimeStateManager(
      {
        lockFile: join(testRuntimeDir, `watch-${Date.now()}-${Math.random()}.pid`),
        statusFile: join(testRuntimeDir, `watch-${Date.now()}-${Math.random()}.status.json`),
      },
      { isProcessRunning: isRunning }
    );
  }

  it('should write and read watch status snapshots', () => {
    const manager = createManager(() => true);
    const snapshot: WatchStatusSnapshot = {
      running: true,
      pid: 12345,
      startedAt: 100000,
      updatedAt: 111111,
      pollIntervalMs: 30000,
      lastError: null,
      consecutiveErrors: 0,
      engine: {
        isRunning: true,
        pollCount: 5,
        eventsFound: 8,
        eventsSaved: 7,
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
        lastPollAt: 222222,
        lastSuccessfulPollAt: 222222,
        errors: 1,
        consecutiveErrors: 0,
        lastError: null,
      },
      lastErrorInfo: null,
      follow: null,
    };

    manager.writeStatus(snapshot);
    assert.deepStrictEqual(manager.readStatus(), snapshot);
  });

  it('should clean up stale lock and status files', () => {
    const manager = createManager(() => false);
    manager.createLockFile(99999);
    manager.writeStatus({
      running: true,
      pid: 99999,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      pollIntervalMs: 30000,
      lastError: 'boom',
      consecutiveErrors: 2,
      engine: {
        isRunning: true,
        pollCount: 1,
        eventsFound: 1,
        eventsSaved: 1,
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
        lastPollAt: Date.now(),
        lastSuccessfulPollAt: Date.now(),
        errors: 0,
        consecutiveErrors: 2,
        lastError: null,
      },
      lastErrorInfo: null,
      follow: null,
    });

    const runningPid = manager.cleanupStaleState();

    assert.strictEqual(runningPid, null);
    assert.strictEqual(existsSync(manager.paths.lockFile), false);
    assert.strictEqual(existsSync(manager.paths.statusFile), false);
  });

  it('should only remove the lock file for the owning pid', () => {
    const manager = createManager((pid) => pid === 12345);
    manager.createLockFile(12345);

    manager.removeLockFile(54321);
    assert.strictEqual(existsSync(manager.paths.lockFile), true);
    assert.strictEqual(readFileSync(manager.paths.lockFile, 'utf-8').trim(), '12345');

    manager.removeLockFile(12345);
    assert.strictEqual(existsSync(manager.paths.lockFile), false);
  });

  it('should flag stale status snapshots based on poll interval', () => {
    const snapshot: WatchStatusSnapshot = {
      running: true,
      pid: 12345,
      startedAt: 1_000,
      updatedAt: 1_000,
      pollIntervalMs: 5_000,
      lastError: null,
      consecutiveErrors: 0,
      engine: {
        isRunning: true,
        pollCount: 1,
        eventsFound: 1,
        eventsSaved: 1,
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
        lastPollAt: 1_000,
        lastSuccessfulPollAt: 1_000,
        errors: 0,
        consecutiveErrors: 0,
        lastError: null,
      },
      lastErrorInfo: null,
      follow: null,
    };

    assert.strictEqual(isWatchStatusStale(snapshot, 12345, 10_000), false);
    assert.strictEqual(isWatchStatusStale(snapshot, 12345, 17_000), true);
    assert.strictEqual(isWatchStatusStale(snapshot, null, 17_000), false);
  });
});
