/**
 * CopyHunter - Watch Status CLI Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Watch Status CLI Tests', () => {
  it('should include daemon metadata in watch status json output', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-data-'));
    const pid = process.pid;
    const startedAt = 1_700_000_000_000;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: true,
          pid,
          startedAt,
          updatedAt: Date.now(),
          pollIntervalMs: 10_000,
          lastError: 'boom',
          lastErrorInfo: {
            code: 'dependency_timeout',
            source: 'polymarket_cli',
            operation: 'polymarket data trades',
            message: 'boom',
            retryable: true,
            occurredAt: startedAt + 600,
          },
          consecutiveErrors: 3,
          engine: {
            isRunning: true,
            pollCount: 12,
            eventsFound: 8,
            eventsSaved: 6,
            currentPollStartedAt: null,
            leadersCompletedInPoll: 2,
            currentLeaderAddress: '0xleader-progress',
            currentLeaderStartedAt: startedAt + 450,
            currentLeaderPass: 3,
            currentLeaderEventsFound: 5,
            currentLeaderEventsSaved: 4,
            currentLeaderCatchUpBudget: 900,
            currentLeaderCatchUpPassLimit: 6,
            currentLeaderCatchUpMode: 'high_activity',
            currentLeaderCursorTimestamp: startedAt + 500,
            currentLeaderCursorUpdatedAt: startedAt + 500,
            lastPollAt: startedAt + 500,
            lastSuccessfulPollAt: startedAt + 400,
            errors: 3,
            consecutiveErrors: 3,
            lastError: {
              code: 'dependency_timeout',
              source: 'polymarket_cli',
              operation: 'polymarket data trades',
              message: 'boom',
              retryable: true,
              occurredAt: startedAt + 600,
            },
          },
          follow: {
            listening: true,
            mode: 'shadow',
            stats: {
              eventsEvaluated: 5,
              eventsFollowed: 2,
              eventsSkipped: 3,
              ordersExecuted: 2,
              ordersFailed: 1,
              totalAmountUsd: 42,
              lastEvaluatedAt: startedAt + 700,
              lastDecisionAt: startedAt + 700,
              lastDecisionReason: 'Leader not in allowlist',
              lastDecisionShouldFollow: false,
              lastExecutedAt: startedAt + 650,
              lastSkippedAt: startedAt + 700,
              lastError: {
                code: 'dependency_unavailable',
                source: 'polymarket_cli',
                operation: 'polymarket clob market-order',
                message: 'wallet unavailable',
                retryable: false,
                occurredAt: startedAt + 750,
              },
            },
          },
          recovery: {
            status: 'backoff',
            currentBackoffMs: 4000,
            consecutiveRetryableErrors: 3,
            restartCount: 2,
            lastRestartAt: startedAt + 550,
            lastRecoveryReason: 'boom',
            lastHealthCheckAt: startedAt + 580,
            dependencies: [
              {
                name: 'polymarket_cli',
                healthy: false,
                checkedAt: startedAt + 580,
                lastError: {
                  code: 'dependency_unavailable',
                  source: 'polymarket_cli',
                  operation: 'health_check',
                  message: 'polymarket-cli health check failed.',
                  retryable: true,
                  occurredAt: startedAt + 580,
                },
              },
              {
                name: 'polymarket_data_api',
                healthy: true,
                checkedAt: startedAt + 580,
                lastError: null,
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts watch status --json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.running, true);
      assert.strictEqual(parsed.pid, pid);
      assert.strictEqual(parsed.startedAt, startedAt);
      assert.strictEqual(parsed.interval, 10_000);
      assert.strictEqual(parsed.consecutiveErrors, 3);
      assert.strictEqual(parsed.lastError, 'boom');
      assert.strictEqual(parsed.lastErrorInfo.code, 'dependency_timeout');
      assert.strictEqual(parsed.engine.consecutiveErrors, 3);
      assert.strictEqual(parsed.engine.lastSuccessfulPollAt, startedAt + 400);
      assert.strictEqual(parsed.engine.leadersCompletedInPoll, 2);
      assert.strictEqual(parsed.engine.currentLeaderAddress, '0xleader-progress');
      assert.strictEqual(parsed.engine.currentLeaderPass, 3);
      assert.strictEqual(parsed.engine.currentLeaderEventsFound, 5);
      assert.strictEqual(parsed.engine.currentLeaderEventsSaved, 4);
      assert.strictEqual(parsed.engine.currentLeaderCatchUpBudget, 900);
      assert.strictEqual(parsed.engine.currentLeaderCatchUpPassLimit, 6);
      assert.strictEqual(parsed.engine.currentLeaderCatchUpMode, 'high_activity');
      assert.strictEqual(parsed.engine.currentLeaderCursorTimestamp, startedAt + 500);
      assert.strictEqual(parsed.follow.mode, 'shadow');
      assert.strictEqual(parsed.follow.stats.lastDecisionReason, 'Leader not in allowlist');
      assert.strictEqual(parsed.follow.stats.lastError.code, 'dependency_unavailable');
      assert.strictEqual(parsed.recovery.status, 'backoff');
      assert.strictEqual(parsed.recovery.currentBackoffMs, 4000);
      assert.strictEqual(parsed.recovery.dependencies[0].healthy, false);
      assert.strictEqual(parsed.database.totalEvents, 0);
      assert.strictEqual(parsed.database.currentLeader.eventCount, 0);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should expose database-backed leader progress when runtime snapshot lags behind', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-data-'));
    const pid = process.pid;
    const leaderAddress = '0x1111111111111111111111111111111111111111';

    try {
      execSync(
        `node --import tsx -e "(async () => {
          const { getLeaderRepo, getEventRepo, getWatchCursorRepo } = await import('./src/db/repositories/index.js');
          const { closeDb } = await import('./src/db/index.js');
          const leaderRepo = getLeaderRepo();
          const eventRepo = getEventRepo();
          const cursorRepo = getWatchCursorRepo();
          await leaderRepo.add({ address: '${leaderAddress}', alias: 'DbProgress' });
          await eventRepo.save({
            leaderAddress: '${leaderAddress}',
            platform: 'polymarket',
            eventType: 'BUY',
            conditionId: 'cond-a',
            marketTitle: 'Market A',
            outcome: 'YES',
            price: 0.5,
            quantity: 10,
            amountUsd: 5,
            txHash: 'tx-a',
            timestamp: 2000,
            followed: 0,
            createdAt: 2000,
          });
          await eventRepo.save({
            leaderAddress: '${leaderAddress}',
            platform: 'polymarket',
            eventType: 'BUY',
            conditionId: 'cond-b',
            marketTitle: 'Market B',
            outcome: 'YES',
            price: 0.5,
            quantity: 20,
            amountUsd: 10,
            txHash: 'tx-b',
            timestamp: 3000,
            followed: 0,
            createdAt: 3000,
          });
          await cursorRepo.upsert({
            leaderAddress: '${leaderAddress}',
            platform: 'polymarket',
            cursorTimestamp: 3000,
            cursorTradeKeys: ['${leaderAddress.toLowerCase()}:cond-b:BUY:YES:3000:0.500000:20.000000:tx-b'],
          });
          closeDb();
        })()"`,
        {
          cwd: process.cwd(),
          encoding: 'utf-8',
          timeout: 30_000,
          env: {
            ...process.env,
            XDG_DATA_HOME: dataDir,
          },
        }
      );

      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: true,
          pid,
          startedAt: 1_700_000_000_000,
          updatedAt: Date.now(),
          pollIntervalMs: 10_000,
          lastError: null,
          lastErrorInfo: null,
          consecutiveErrors: 0,
          engine: {
            isRunning: true,
            pollCount: 5,
            eventsFound: 2,
            eventsSaved: 1,
            currentPollStartedAt: null,
            leadersCompletedInPoll: 0,
            currentLeaderAddress: leaderAddress,
            currentLeaderStartedAt: 1_700_000_000_100,
            currentLeaderPass: 1,
            currentLeaderEventsFound: 1,
            currentLeaderEventsSaved: 1,
            currentLeaderCatchUpBudget: 100,
            currentLeaderCatchUpPassLimit: 1,
            currentLeaderCatchUpMode: 'normal',
            currentLeaderCursorTimestamp: 1000,
            currentLeaderCursorUpdatedAt: 1000,
            lastPollAt: 1_700_000_000_100,
            lastSuccessfulPollAt: 1_700_000_000_100,
            errors: 0,
            consecutiveErrors: 0,
            lastError: null,
          },
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
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts watch status -o json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.engine.currentLeaderCursorTimestamp, 1000);
      assert.strictEqual(parsed.database.totalEvents, 2);
      assert.strictEqual(parsed.database.currentLeader.eventCount, 2);
      assert.strictEqual(parsed.database.currentLeader.cursorTimestamp, 3000);
      assert.strictEqual(parsed.database.currentLeader.latestEventTimestamp, 3000);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should expose persisted follow observability via follow status json output', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-data-'));
    const pid = process.pid;
    const startedAt = 1_700_000_000_000;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: true,
          pid,
          startedAt,
          updatedAt: Date.now(),
          pollIntervalMs: 30_000,
          lastError: null,
          lastErrorInfo: null,
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
            lastPollAt: startedAt + 100,
            lastSuccessfulPollAt: startedAt + 100,
            errors: 0,
            consecutiveErrors: 0,
            lastError: null,
          },
          follow: {
            listening: true,
            mode: 'live',
            stats: {
              eventsEvaluated: 7,
              eventsFollowed: 3,
              eventsSkipped: 4,
              ordersExecuted: 3,
              ordersFailed: 1,
              totalAmountUsd: 88,
              lastEvaluatedAt: startedAt + 200,
              lastDecisionAt: startedAt + 200,
              lastDecisionReason: 'Daily limit would be exceeded',
              lastDecisionShouldFollow: false,
              lastExecutedAt: startedAt + 150,
              lastSkippedAt: startedAt + 200,
              lastError: {
                code: 'dependency_timeout',
                source: 'polymarket_cli',
                operation: 'polymarket clob market-order',
                message: 'order timed out',
                retryable: true,
                occurredAt: startedAt + 250,
              },
            },
          },
          recovery: {
            status: 'idle',
            currentBackoffMs: 0,
            consecutiveRetryableErrors: 0,
            restartCount: 1,
            lastRestartAt: startedAt + 180,
            lastRecoveryReason: null,
            lastHealthCheckAt: startedAt + 220,
            dependencies: [
              {
                name: 'polymarket_cli',
                healthy: true,
                checkedAt: startedAt + 220,
                lastError: null,
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts follow status -o json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.listening, true);
      assert.strictEqual(parsed.daemonPid, pid);
      assert.strictEqual(parsed.stats.engine.eventsEvaluated, 7);
      assert.strictEqual(parsed.stats.engine.lastDecisionReason, 'Daily limit would be exceeded');
      assert.strictEqual(parsed.stats.engine.lastError.code, 'dependency_timeout');
      assert.strictEqual(parsed.recovery.restartCount, 1);
      assert.strictEqual(parsed.recovery.dependencies[0].name, 'polymarket_cli');
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should expose persisted recovery status while the daemon process is still alive', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-data-'));
    const pid = process.pid;
    const startedAt = 1_700_000_000_000;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: false,
          pid,
          startedAt,
          updatedAt: Date.now(),
          pollIntervalMs: 15_000,
          lastError: 'fetch failed',
          lastErrorInfo: {
            code: 'dependency_network_error',
            source: 'polymarket_data_api',
            operation: 'http_fetch',
            message: 'fetch failed',
            retryable: true,
            occurredAt: startedAt + 900,
          },
          consecutiveErrors: 2,
          engine: {
            isRunning: false,
            pollCount: 3,
            eventsFound: 2,
            eventsSaved: 2,
            currentPollStartedAt: null,
            leadersCompletedInPoll: 1,
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
            lastPollAt: startedAt + 850,
            lastSuccessfulPollAt: startedAt + 700,
            errors: 2,
            consecutiveErrors: 2,
            lastError: {
              code: 'dependency_network_error',
              source: 'polymarket_data_api',
              operation: 'http_fetch',
              message: 'fetch failed',
              retryable: true,
              occurredAt: startedAt + 900,
            },
          },
          follow: {
            listening: false,
            mode: 'shadow',
            stats: {
              eventsEvaluated: 0,
              eventsFollowed: 0,
              eventsSkipped: 0,
              ordersExecuted: 0,
              ordersFailed: 0,
              totalAmountUsd: 0,
              lastEvaluatedAt: null,
              lastDecisionAt: null,
              lastDecisionReason: null,
              lastDecisionShouldFollow: null,
              lastExecutedAt: null,
              lastSkippedAt: null,
              lastError: null,
            },
          },
          recovery: {
            status: 'backoff',
            currentBackoffMs: 5000,
            consecutiveRetryableErrors: 2,
            restartCount: 1,
            lastRestartAt: startedAt + 800,
            lastRecoveryReason: 'fetch failed',
            lastHealthCheckAt: startedAt + 880,
            dependencies: [
              {
                name: 'polymarket_data_api',
                healthy: false,
                checkedAt: startedAt + 880,
                lastError: {
                  code: 'dependency_unavailable',
                  source: 'polymarket_data_api',
                  operation: 'health_check',
                  message: 'Polymarket Data API health check failed.',
                  retryable: true,
                  occurredAt: startedAt + 880,
                },
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts watch status -o json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.running, true);
      assert.strictEqual(parsed.pid, pid);
      assert.strictEqual(parsed.startedAt, startedAt);
      assert.strictEqual(parsed.interval, 15_000);
      assert.strictEqual(parsed.lastError, 'fetch failed');
      assert.strictEqual(parsed.lastErrorInfo.code, 'dependency_network_error');
      assert.strictEqual(parsed.engine.isRunning, false);
      assert.strictEqual(parsed.engine.pollCount, 3);
      assert.strictEqual(parsed.recovery.status, 'backoff');
      assert.strictEqual(parsed.recovery.currentBackoffMs, 5000);
      assert.strictEqual(parsed.follow.mode, 'shadow');
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should surface a backoff summary in watch status text output', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-data-'));
    const pid = process.pid;
    const startedAt = 1_700_000_000_000;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: false,
          pid,
          startedAt,
          updatedAt: Date.now(),
          pollIntervalMs: 15_000,
          lastError: 'fetch failed',
          lastErrorInfo: {
            code: 'dependency_network_error',
            source: 'polymarket_data_api',
            operation: 'http_fetch',
            message: 'fetch failed',
            retryable: true,
            occurredAt: startedAt + 900,
          },
          consecutiveErrors: 2,
          engine: {
            isRunning: false,
            pollCount: 3,
            eventsFound: 2,
            eventsSaved: 2,
            currentPollStartedAt: null,
            leadersCompletedInPoll: 1,
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
            lastPollAt: startedAt + 850,
            lastSuccessfulPollAt: startedAt + 700,
            errors: 2,
            consecutiveErrors: 2,
            lastError: {
              code: 'dependency_network_error',
              source: 'polymarket_data_api',
              operation: 'http_fetch',
              message: 'fetch failed',
              retryable: true,
              occurredAt: startedAt + 900,
            },
          },
          follow: {
            listening: false,
            mode: 'shadow',
            stats: {
              eventsEvaluated: 0,
              eventsFollowed: 0,
              eventsSkipped: 0,
              ordersExecuted: 0,
              ordersFailed: 0,
              totalAmountUsd: 0,
              lastEvaluatedAt: null,
              lastDecisionAt: null,
              lastDecisionReason: null,
              lastDecisionShouldFollow: null,
              lastExecutedAt: null,
              lastSkippedAt: null,
              lastError: null,
            },
          },
          recovery: {
            status: 'backoff',
            currentBackoffMs: 5000,
            consecutiveRetryableErrors: 2,
            restartCount: 1,
            lastRestartAt: startedAt + 800,
            lastRecoveryReason: 'fetch failed',
            lastHealthCheckAt: startedAt + 880,
            dependencies: [
              {
                name: 'polymarket_data_api',
                healthy: false,
                checkedAt: startedAt + 880,
                lastError: {
                  code: 'dependency_unavailable',
                  source: 'polymarket_data_api',
                  operation: 'health_check',
                  message: 'Polymarket Data API health check failed.',
                  retryable: true,
                  occurredAt: startedAt + 880,
                },
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts watch status', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      });

      assert.match(output, /State:\s+BACKOFF/);
      assert.match(output, /State Detail:\s+fetch failed/i);
      assert.match(output, /Deps Unhealthy:\s+polymarket_data_api/i);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should surface watch recovery state in follow status text output', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-data-'));
    const pid = process.pid;
    const startedAt = 1_700_000_000_000;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: false,
          pid,
          startedAt,
          updatedAt: Date.now(),
          pollIntervalMs: 30_000,
          lastError: 'fetch failed',
          lastErrorInfo: {
            code: 'dependency_network_error',
            source: 'polymarket_data_api',
            operation: 'http_fetch',
            message: 'fetch failed',
            retryable: true,
            occurredAt: startedAt + 250,
          },
          consecutiveErrors: 1,
          engine: {
            isRunning: false,
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
            lastPollAt: startedAt + 100,
            lastSuccessfulPollAt: startedAt + 100,
            errors: 1,
            consecutiveErrors: 1,
            lastError: {
              code: 'dependency_network_error',
              source: 'polymarket_data_api',
              operation: 'http_fetch',
              message: 'fetch failed',
              retryable: true,
              occurredAt: startedAt + 250,
            },
          },
          follow: {
            listening: false,
            mode: 'shadow',
            stats: {
              eventsEvaluated: 7,
              eventsFollowed: 3,
              eventsSkipped: 4,
              ordersExecuted: 3,
              ordersFailed: 1,
              totalAmountUsd: 88,
              lastEvaluatedAt: startedAt + 200,
              lastDecisionAt: startedAt + 200,
              lastDecisionReason: 'Daily limit would be exceeded',
              lastDecisionShouldFollow: false,
              lastExecutedAt: startedAt + 150,
              lastSkippedAt: startedAt + 200,
              lastError: {
                code: 'dependency_timeout',
                source: 'polymarket_cli',
                operation: 'polymarket clob market-order',
                message: 'order timed out',
                retryable: true,
                occurredAt: startedAt + 250,
              },
            },
          },
          recovery: {
            status: 'backoff',
            currentBackoffMs: 5000,
            consecutiveRetryableErrors: 1,
            restartCount: 1,
            lastRestartAt: startedAt + 180,
            lastRecoveryReason: 'fetch failed',
            lastHealthCheckAt: startedAt + 220,
            dependencies: [
              {
                name: 'polymarket_data_api',
                healthy: false,
                checkedAt: startedAt + 220,
                lastError: null,
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts follow status', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      });

      assert.match(output, /Watch State:\s+BACKOFF/);
      assert.match(output, /Watch Detail:\s+fetch failed/i);
      assert.match(output, /Deps Unhealthy:\s+polymarket_data_api/i);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should suppress stale dependency health errors when a dependency is healthy again', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-health-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-health-data-'));
    const pid = process.pid;

    try {
      writeFileSync(join(runtimeDir, 'copyhunter-watch.pid'), String(pid));
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: true,
          pid,
          startedAt: 1_700_000_000_000,
          updatedAt: Date.now(),
          pollIntervalMs: 30_000,
          lastError: 'All Polymarket dependencies are unhealthy.',
          lastErrorInfo: {
            code: 'dependency_unavailable',
            source: 'watch_engine',
            operation: 'dependency_health_check',
            message: 'All Polymarket dependencies are unhealthy.',
            retryable: true,
            occurredAt: 1_700_000_000_100,
          },
          consecutiveErrors: 0,
          engine: {
            isRunning: true,
            pollCount: 2,
            eventsFound: 4,
            eventsSaved: 4,
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
            lastPollAt: 1_700_000_000_100,
            lastSuccessfulPollAt: 1_700_000_000_100,
            errors: 0,
            consecutiveErrors: 0,
            lastError: null,
          },
          follow: null,
          recovery: {
            status: 'idle',
            currentBackoffMs: 0,
            consecutiveRetryableErrors: 0,
            restartCount: 1,
            lastRestartAt: 1_700_000_000_150,
            lastRecoveryReason: null,
            lastHealthCheckAt: 1_700_000_000_200,
            dependencies: [
              {
                name: 'polymarket_cli',
                healthy: false,
                checkedAt: 1_700_000_000_200,
                lastError: {
                  code: 'dependency_unavailable',
                  source: 'polymarket_cli',
                  operation: 'health_check',
                  message: 'polymarket-cli health check failed.',
                  retryable: true,
                  occurredAt: 1_700_000_000_200,
                },
              },
              {
                name: 'polymarket_data_api',
                healthy: true,
                checkedAt: 1_700_000_000_200,
                lastError: null,
              },
            ],
          },
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts watch status -o json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.lastError, null);
      assert.strictEqual(parsed.lastErrorInfo, null);
      assert.strictEqual(parsed.recovery.dependencies[1].healthy, true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('should ignore orphaned persisted follow status when no daemon lock is present', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-orphan-runtime-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-orphan-data-'));

    try {
      writeFileSync(
        join(runtimeDir, 'copyhunter-watch.status.json'),
        JSON.stringify({
          running: true,
          pid: 999999,
          startedAt: 1_700_000_000_000,
          updatedAt: Date.now(),
          pollIntervalMs: 30_000,
          lastError: null,
          lastErrorInfo: null,
          consecutiveErrors: 0,
          engine: {
            isRunning: true,
            pollCount: 3,
            eventsFound: 10,
            eventsSaved: 10,
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
            lastPollAt: 1_700_000_000_100,
            lastSuccessfulPollAt: 1_700_000_000_100,
            errors: 0,
            consecutiveErrors: 0,
            lastError: null,
          },
          follow: {
            listening: true,
            mode: 'shadow',
            stats: {
              eventsEvaluated: 9,
              eventsFollowed: 4,
              eventsSkipped: 5,
              ordersExecuted: 4,
              ordersFailed: 0,
              totalAmountUsd: 100,
              lastEvaluatedAt: 1_700_000_000_200,
              lastDecisionAt: 1_700_000_000_200,
              lastDecisionReason: 'stale snapshot',
              lastDecisionShouldFollow: true,
              lastExecutedAt: 1_700_000_000_150,
              lastSkippedAt: 1_700_000_000_190,
              lastError: null,
            },
          },
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
        })
      );

      const output = execSync('node --import tsx bin/copyhunter.ts follow status -o json', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
          ...process.env,
          COPYHUNTER_RUNTIME_DIR: runtimeDir,
          XDG_DATA_HOME: dataDir,
        },
      }).trim();

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.listening, false);
      assert.strictEqual(parsed.daemonPid, null);
      assert.strictEqual(parsed.recovery, null);
      assert.strictEqual(parsed.stats.engine.eventsEvaluated, 0);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
