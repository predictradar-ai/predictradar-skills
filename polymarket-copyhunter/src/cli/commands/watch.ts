/**
 * CopyHunter - Watch Command
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { desc } from 'drizzle-orm';
import { getDb, events, getLeaderRepo, getEventRepo, getWatchCursorRepo } from '../../db/index.js';
import { getConfig } from '../../core/config.js';
import { eventBus } from '../../core/events.js';
import {
  WatchEngine,
  buildWatchDisplayStatus,
  buildWatchDaemonProcessPattern,
  getWatchEngine,
  calculateWatchBackoffMs,
  createInitialWatchRecoveryState,
  formatUnhealthyDependencySummary,
  resolveActiveWatchSnapshot,
  shouldScheduleDependencyRecovery,
  type WatchEngineStats,
} from '../../watch/index.js';
import { buildWatchDaemonLaunchSpec } from '../../watch/launcher.js';
import {
  parseReconciliationLookback,
  reconcileTradeSets,
  resolveRequestedReconciliationWindow,
  resolveIncrementalReconciliationComparisonWindow,
  resolveReconciliationComparisonWindow,
  summarizeReconciliationTradeWindow,
} from '../../watch/reconciliation.js';
import {
  getWatchRuntimeStateManager,
  isProcessRunning,
  isWatchStatusStale,
  type WatchStatusSnapshot,
} from '../../watch/runtime-state.js';
import { shouldLogVerboseWatchRuntimeEvents } from '../../watch/logging.js';
import { FollowEngine } from '../../follow/index.js';
import { buildEventFollowDisplay, summarizeEventFollowDisplays } from '../../follow/index.js';
import { getPolymarketCLI, getPolymarketDataAPI } from '../../platforms/polymarket/index.js';
import {
  createJsonArrayResponse,
  isJsonOutput,
  markCommandFailed,
  printJson,
  printJsonError,
  printJsonSuccess,
} from '../json-output.js';
import type { FailureInfo } from '../../core/failures.js';
import { createFailureInfo, toFailureInfo } from '../../core/failures.js';

export function createWatchCommand(): Command {
  const runtimeState = getWatchRuntimeStateManager();
  const cmd = new Command('watch')
    .description('Monitor leader trading activity');

  function resolveVisibleWatchError(snapshot: WatchStatusSnapshot | null, engineLastError: FailureInfo | null) {
    const hasHealthyDependency = snapshot?.recovery?.dependencies.some((dependency) => dependency.healthy) ?? false;
    const staleDependencyHealthError = hasHealthyDependency
      && snapshot?.lastErrorInfo?.operation === 'dependency_health_check';

    return {
      lastError: staleDependencyHealthError ? null : (snapshot?.lastError ?? null),
      lastErrorInfo: staleDependencyHealthError
        ? engineLastError ?? null
        : (snapshot?.lastErrorInfo ?? engineLastError ?? null),
    };
  }

  function isDaemonStartupSnapshotReady(
    snapshot: WatchStatusSnapshot | null,
    expectedPid: number
  ): boolean {
    if (!snapshot || snapshot.pid !== expectedPid) {
      return false;
    }

    if (snapshot.running) {
      return true;
    }

    const recoveryStatus = snapshot.recovery?.status;
    return recoveryStatus === 'backoff' || recoveryStatus === 'recovering';
  }

  function parsePositiveInt(value: string, label: string): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
  }

  function parseTimestampInput(value: string, label: string): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }

    throw new Error(`${label} must be an ISO timestamp, unix seconds, or unix milliseconds.`);
  }

  function resolveReconcileWindow(options: {
    from?: string;
    to?: string;
    hours?: string;
    window?: string;
  }): { fromTimestamp: number; toTimestamp: number; hours: number | null; lookbackMs: number; preset: string | null } {
    const toTimestamp = options.to ? parseTimestampInput(options.to, 'to') : Date.now();

    if (options.window) {
      const lookbackMs = parseReconciliationLookback(options.window, 'window');
      const window = resolveRequestedReconciliationWindow({
        toTimestamp,
        lookbackMs,
      });

      return {
        ...window,
        preset: options.window,
      };
    }

    const window = resolveRequestedReconciliationWindow({
      toTimestamp,
      fromTimestamp: options.from ? parseTimestampInput(options.from, 'from') : undefined,
      hours: options.hours ? parsePositiveInt(options.hours, 'hours') : undefined,
    });

    if (window.fromTimestamp > toTimestamp) {
      throw new Error('from must be earlier than to.');
    }

    return {
      ...window,
      preset: null,
    };
  }

  async function runWatchWorker(options: { interval: string; follow: boolean }): Promise<void> {
    let config = getConfig();
    const interval = parseInt(options.interval) || config.watch.interval;
    const startedAt = Date.now();
    const baseBackoffMs = Math.max(1_000, Math.min(interval, 5_000));
    const maxBackoffMs = Math.max(baseBackoffMs, Math.min(interval * 4, 60_000));
    const healthCheckIntervalMs = Math.max(interval, 30_000);

    const leaderRepo = getLeaderRepo();
    const allLeaders = await leaderRepo.getAll();

    if (allLeaders.length === 0) {
      throw new Error('No leaders to monitor. Add some first: copyhunter leaders add 0x... --alias "Whale"');
    }

    console.log(chalk.bold('\n📡 CopyHunter Watch Mode\n'));
    console.log(`Monitoring ${chalk.cyan(allLeaders.length)} leaders`);
    console.log(`Interval:  ${chalk.cyan(interval / 1000)}s`);
    console.log(`Mode:      ${chalk.cyan(config.follow.mode)}`);
    console.log(chalk.gray('\nPress Ctrl+C to stop\n'));

    let lastError: string | null = null;
    let lastErrorInfo: FailureInfo | null = null;
    let statusInterval: NodeJS.Timeout | null = null;
    let healthInterval: NodeJS.Timeout | null = null;
    let recoveryTimer: NodeJS.Timeout | null = null;
    let consecutiveDependencyHealthFailures = 0;
    let shuttingDown = false;
    let handleSigint: (() => void) | null = null;
    let handleSigterm: (() => void) | null = null;
    const recovery = createInitialWatchRecoveryState();
    const verboseRuntimeLogs = shouldLogVerboseWatchRuntimeEvents();
    let watchEngine!: WatchEngine;
    let followEngine!: FollowEngine;

    const persistStatus = () => {
      const stats = watchEngine.getStats();
      runtimeState.writeStatus({
        running: watchEngine.isRunning(),
        pid: process.pid,
        startedAt,
        updatedAt: Date.now(),
        pollIntervalMs: interval,
        lastError,
        lastErrorInfo,
        consecutiveErrors: stats.consecutiveErrors,
        engine: stats,
        follow: {
          listening: followEngine.isListening(),
          mode: config.follow.mode,
          stats: followEngine.getStats(),
        },
        recovery,
      });
    };

    watchEngine = new WatchEngine({ interval }, { onStatsUpdated: persistStatus });
    followEngine = new FollowEngine();

    const stopEngines = () => {
      watchEngine.stop();
      followEngine.stop();
    };

    const drainEngines = async () => {
      watchEngine.stop();
      await watchEngine.waitForIdle();
      followEngine.stop();
      await followEngine.waitForIdle();
    };

    const recreateEngines = () => {
      stopEngines();
      watchEngine = new WatchEngine({ interval }, { onStatsUpdated: persistStatus });
      followEngine = new FollowEngine();
    };

    const refreshConfig = () => {
      config = getConfig();
      return config;
    };

    const probeDependencies = async () => {
      const checkedAt = Date.now();
      const cliHealthy = await getPolymarketCLI().checkHealth().catch(() => false);
      const apiHealthy = await getPolymarketDataAPI().checkHealth().catch(() => false);

      recovery.lastHealthCheckAt = checkedAt;
      recovery.dependencies = [
        {
          name: 'polymarket_cli',
          healthy: cliHealthy,
          checkedAt,
          lastError: cliHealthy
            ? null
            : createFailureInfo({
                code: 'dependency_unavailable',
                source: 'polymarket_cli',
                operation: 'health_check',
                message: 'polymarket-cli health check failed.',
                retryable: true,
              }),
        },
        {
          name: 'polymarket_data_api',
          healthy: apiHealthy,
          checkedAt,
          lastError: apiHealthy
            ? null
            : createFailureInfo({
                code: 'dependency_unavailable',
                source: 'polymarket_data_api',
                operation: 'health_check',
                message: 'Polymarket Data API health check failed.',
                retryable: true,
              }),
        },
      ];

      if (cliHealthy || apiHealthy) {
        const staleDependencyHealthError = lastErrorInfo?.operation === 'dependency_health_check'
          || lastError === 'All Polymarket dependencies are unhealthy.';
        if (staleDependencyHealthError) {
          lastError = null;
          lastErrorInfo = null;
        }
      }

      persistStatus();

      return {
        cliHealthy,
        apiHealthy,
      };
    };

    const clearRecoveryTimer = () => {
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    };

    const startEngines = async () => {
      refreshConfig();
      recreateEngines();
      if (options.follow && config.follow.mode !== 'disabled') {
        followEngine.start();
      }
      await watchEngine.start();
      persistStatus();
    };

    const resetRecoveryState = () => {
      recovery.status = 'idle';
      recovery.currentBackoffMs = 0;
      recovery.consecutiveRetryableErrors = 0;
      recovery.lastRecoveryReason = null;
      consecutiveDependencyHealthFailures = 0;
      persistStatus();
    };

    const scheduleRecovery = (detail: FailureInfo) => {
      if (shuttingDown || !detail.retryable || recovery.status === 'recovering' || recoveryTimer) {
        return;
      }

      recovery.consecutiveRetryableErrors += 1;
      recovery.currentBackoffMs = calculateWatchBackoffMs(
        recovery.consecutiveRetryableErrors,
        baseBackoffMs,
        maxBackoffMs
      );
      recovery.status = 'backoff';
      recovery.lastRecoveryReason = detail.message;
      stopEngines();
      persistStatus();

      console.log(chalk.yellow(
        `  ↻ Recovery scheduled in ${(recovery.currentBackoffMs / 1000).toFixed(1)}s`
      ));

      recoveryTimer = setTimeout(async () => {
        recoveryTimer = null;

        if (shuttingDown) {
          return;
        }

        recovery.status = 'recovering';
        persistStatus();

        try {
          await probeDependencies();
          await startEngines();
          recovery.restartCount += 1;
          recovery.lastRestartAt = Date.now();
          resetRecoveryState();
          console.log(chalk.green('  ✓ Recovery completed'));
        } catch (error) {
          const retryDetail = toFailureInfo(error, {
            code: 'runtime_error',
            source: 'watch_engine',
            operation: 'daemon_recovery',
            retryable: true,
          });
          lastError = retryDetail.message;
          lastErrorInfo = retryDetail;
          recovery.status = 'idle';
          persistStatus();
          scheduleRecovery(retryDetail);
        }
      }, recovery.currentBackoffMs);
    };

    const cleanup = async (removeStatusFile = true) => {
      shuttingDown = true;
      clearRecoveryTimer();
      if (statusInterval) clearInterval(statusInterval);
      if (healthInterval) clearInterval(healthInterval);
      if (handleSigint) {
        process.off('SIGINT', handleSigint);
        handleSigint = null;
      }
      if (handleSigterm) {
        process.off('SIGTERM', handleSigterm);
        handleSigterm = null;
      }
      await drainEngines();
      runtimeState.removeLockFile(process.pid);
      if (removeStatusFile) {
        runtimeState.removeStatusFile();
      }
    };

    if (verboseRuntimeLogs) {
      eventBus.on('trade:new', ({ event }) => {
        const color = event.eventType === 'BUY' ? chalk.green : chalk.red;
        console.log(
          `${chalk.gray(new Date().toLocaleTimeString())} ` +
          `${color(event.eventType)} ` +
          `${chalk.yellow(`$${event.amountUsd.toFixed(2)}`)} ` +
          `${(event.marketTitle || event.conditionId).slice(0, 40)}`
        );
      });

      eventBus.on('follow:executed', ({ order }) => {
        console.log(
          chalk.green(`  ✓ Followed: $${order.amountUsd?.toFixed(2)} @ ${order.executedPrice?.toFixed(4)}`)
        );
      });

      eventBus.on('follow:skipped', ({ reason }) => {
        console.log(chalk.gray(`  ↷ Skipped: ${reason}`));
      });
    }

    eventBus.on('follow:error', () => {
      persistStatus();
    });

    eventBus.on('watch:healthy', () => {
      if (!recoveryTimer && recovery.status !== 'recovering') {
        resetRecoveryState();
      }
    });

    eventBus.on('watch:error', ({ error, detail }) => {
      lastError = detail?.message ?? error.message;
      lastErrorInfo = detail ?? null;
      persistStatus();
      console.log(chalk.red(`  ✗ Error: ${error.message}`));
      if (detail?.retryable) {
        scheduleRecovery(detail);
      }
    });

    const spinner = ora('Starting watch engine...').start();

    try {
      runtimeState.createLockFile(process.pid);
      persistStatus();
      statusInterval = setInterval(persistStatus, 1000);
      healthInterval = setInterval(() => {
        probeDependencies()
          .then(({ cliHealthy, apiHealthy }) => {
            if (cliHealthy || apiHealthy) {
              consecutiveDependencyHealthFailures = 0;
              return;
            }

            consecutiveDependencyHealthFailures += 1;
            if (shouldScheduleDependencyRecovery({
              cliHealthy,
              apiHealthy,
              consecutiveFailedChecks: consecutiveDependencyHealthFailures,
              hasActivePoll: watchEngine.hasActivePoll(),
              minimumFailedChecks: 2,
            })) {
              const detail = createFailureInfo({
                code: 'dependency_unavailable',
                source: 'watch_engine',
                operation: 'dependency_health_check',
                message: 'All Polymarket dependencies are unhealthy.',
                retryable: true,
              });
              lastError = detail.message;
              lastErrorInfo = detail;
              scheduleRecovery(detail);
            }
          })
          .catch(() => {
            // Ignore probe errors; they are captured in dependency snapshots.
          });
      }, healthCheckIntervalMs);

      await probeDependencies();

      try {
        if (options.follow && config.follow.mode !== 'disabled') {
          spinner.text = `Watching with ${config.follow.mode} mode...`;
        }
        await startEngines();
        spinner.succeed('Watch engine started');
      } catch (error) {
        const startupDetail = toFailureInfo(error, {
          code: 'runtime_error',
          source: 'watch_engine',
          operation: 'startup',
          retryable: true,
        });
        lastError = startupDetail.message;
        lastErrorInfo = startupDetail;
        persistStatus();
        scheduleRecovery(startupDetail);
        spinner.warn('Watch engine entered recovery mode');
      }

      handleSigint = () => {
        if (shuttingDown) {
          return;
        }
        void (async () => {
          spinner.stop();
          await cleanup();

          const stats = watchEngine.getStats();
          console.log(chalk.yellow('\n\nStopped watching.'));
          console.log(chalk.gray(`Polls: ${stats.pollCount}, Events: ${stats.eventsSaved}, Errors: ${stats.errors}`));
          process.exit(0);
        })();
      };

      handleSigterm = () => {
        if (shuttingDown) {
          return;
        }
        void (async () => {
          await cleanup();
          process.exit(0);
        })();
      };

      process.once('SIGINT', handleSigint);
      process.once('SIGTERM', handleSigterm);

      await new Promise(() => {});
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  // watch start
  cmd
    .command('start')
    .description('Start monitoring leaders in the background')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds', '30000')
    .option('--follow', 'Enable follow engine (respects current mode)', false)
    .option('--foreground', 'Run in the foreground worker process', false)
    .option('-f, --force', 'Force start even if another instance is running', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      // Check for existing running instance
      const runningPid = runtimeState.cleanupStaleState();
      if (runningPid && !options.force) {
        if (jsonOutput) {
          printJsonError('watch_already_running', `Watch already running (PID: ${runningPid})`, {
            pid: runningPid,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.yellow(`Watch already running (PID: ${runningPid})`));
        console.log(chalk.gray('  Use "copyhunter watch stop" to stop it first'));
        console.log(chalk.gray('  Or use --force to start anyway (not recommended)'));
        return;
      }

      if (options.foreground) {
        if (jsonOutput) {
          printJsonError('unsupported_output_mode', 'JSON output is not supported with --foreground.', {
            foreground: true,
          });
          return;
        }
        try {
          await runWatchWorker({ interval: options.interval, follow: !!options.follow });
        } catch (error) {
          markCommandFailed();
          console.log(chalk.red(`Failed to start: ${error instanceof Error ? error.message : error}`));
        }
        return;
      }

      const leaderRepo = getLeaderRepo();
      const allLeaders = await leaderRepo.getAll();

      if (allLeaders.length === 0) {
        if (jsonOutput) {
          printJsonError('no_leaders', 'No leaders to monitor. Add some first.', {
            command: 'copyhunter leaders add 0x... --alias "Whale"',
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.yellow('No leaders to monitor. Add some first:'));
        console.log(chalk.gray('  copyhunter leaders add 0x... --alias "Whale"'));
        return;
      }

      const entryPath = process.env.COPYHUNTER_CLI_ENTRY;
      if (!entryPath) {
        if (jsonOutput) {
          printJsonError('launcher_unavailable', 'Failed to determine CLI entry path for background launch.');
          return;
        }
        markCommandFailed();
        console.log(chalk.red('Failed to determine CLI entry path for background launch.'));
        return;
      }

      const spinner = jsonOutput ? null : ora('Starting watch daemon...').start();
      const pollIntervalMs = parseInt(options.interval) || getConfig().watch.interval;

      try {
        const launchSpec = buildWatchDaemonLaunchSpec({
          entryPath,
          interval: parseInt(options.interval) || undefined,
          follow: !!options.follow,
          runtimeDir: path.dirname(runtimeState.paths.lockFile),
        });

        const child = spawn(launchSpec.command, launchSpec.args, {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            COPYHUNTER_DAEMON: '1',
          },
        });
        child.unref();

        let ready = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const pid = runtimeState.getRunningPid();
          const snapshot = runtimeState.readStatus();
          if (pid === child.pid && isDaemonStartupSnapshotReady(snapshot, child.pid)) {
            ready = true;
            break;
          }
        }

        if (!ready) {
          throw new Error('Daemon did not publish its first status snapshot in time.');
        }

        if (jsonOutput) {
          printJsonSuccess('watch_started', `Watch daemon started (PID: ${child.pid})`, {
            pid: child.pid,
            follow: !!options.follow,
            pollIntervalMs,
            background: true,
          });
          return;
        }

        spinner?.succeed(`Watch daemon started (PID: ${child.pid})`);
      } catch (error) {
        if (jsonOutput) {
          printJsonError('watch_start_failed', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to launch daemon: ${error instanceof Error ? error.message : error}`);
      }
    });

  const runCmd = new Command('run')
    .description('Run the watch worker process')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds', '30000')
    .option('--follow', 'Enable follow engine (respects current mode)', false)
    .option('--runtime-dir <path>', 'Internal runtime instance marker')
    .action(async (options: { interval: string; follow?: boolean; runtimeDir?: string }) => {
      try {
        await runWatchWorker({ interval: options.interval, follow: !!options.follow });
      } catch (error) {
        console.log(chalk.red(`Failed to start: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  cmd.addCommand(runCmd, { hidden: true });

  // watch status
  cmd
    .command('status')
    .description('Show current watch status')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .option('--json', 'Output status as JSON', false)
    .action(async (options) => {
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();
      const config = getConfig();
      const runningPid = runtimeState.cleanupStaleState();
      const persistedStatus = runtimeState.readStatus();
      const activeSnapshot = resolveActiveWatchSnapshot(runningPid, persistedStatus);

      const leaderCount = await leaderRepo.count();
      const eventCount = await eventRepo.count();
      const recentEvents = await eventRepo.find({}, 5);
      const engineStats: WatchEngineStats = activeSnapshot
        ? activeSnapshot.engine
        : {
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
          };
      const currentLeaderAddress = engineStats.currentLeaderAddress;
      const currentLeaderDbProgress = currentLeaderAddress
        ? await (async () => {
            const [eventCountForLeader, localFrontier, persistedCursor] = await Promise.all([
              eventRepo.count({ leaderAddress: currentLeaderAddress }),
              eventRepo.getLatestCursorSnapshot(currentLeaderAddress),
              cursorRepo.getByLeader(currentLeaderAddress),
            ]);

            return {
              leaderAddress: currentLeaderAddress,
              eventCount: eventCountForLeader,
              latestEventTimestamp: localFrontier.cursorTimestamp,
              latestEventTradeKeys: localFrontier.cursorTradeKeys,
              cursorTimestamp: persistedCursor?.cursorTimestamp ?? null,
              cursorTradeKeys: persistedCursor?.cursorTradeKeys ?? [],
              cursorUpdatedAt: persistedCursor?.updatedAt ?? null,
            };
          })()
        : null;
      const followSnapshot = activeSnapshot?.follow ?? null;
      const recoverySnapshot = activeSnapshot?.recovery ?? null;
      const stale = isWatchStatusStale(persistedStatus, runningPid);
      const visibleError = resolveVisibleWatchError(activeSnapshot, engineStats.lastError);
      const recentEventSummary = summarizeEventFollowDisplays(recentEvents);
      const displayStatus = buildWatchDisplayStatus({
        runningPid,
        stale,
        snapshot: activeSnapshot,
        engineStats,
        visibleErrorInfo: visibleError.lastErrorInfo,
        visibleErrorMessage: visibleError.lastError,
      });
      const outputFormat = isJsonOutput(options) ? 'json' : options.output;

      if (outputFormat === 'json') {
        printJson({
          running: !!runningPid,
          pid: runningPid,
          stale,
          startedAt: activeSnapshot?.startedAt ?? null,
          leaders: leaderCount,
          events: eventCount,
          mode: config.follow.mode,
          interval: activeSnapshot?.pollIntervalMs ?? config.watch.interval,
          lastError: visibleError.lastError,
          lastErrorInfo: visibleError.lastErrorInfo,
          consecutiveErrors: activeSnapshot?.consecutiveErrors ?? engineStats.consecutiveErrors,
          engine: engineStats,
          follow: followSnapshot,
          recovery: recoverySnapshot,
          database: {
            totalEvents: eventCount,
            latestEventTimestamp: recentEvents[0]?.timestamp ?? null,
            currentLeader: currentLeaderDbProgress,
          },
          recentEventSummary,
          recentEvents: recentEvents.map(e => ({
            id: e.id,
            leader: e.leaderAddress,
            type: e.eventType,
            amount: e.amountUsd,
            market: e.marketTitle || e.conditionId,
            timestamp: e.timestamp,
            followState: buildEventFollowDisplay(e).label,
            followReason: buildEventFollowDisplay(e).detail,
          })),
        });
        return;
      }

      console.log(chalk.bold('\n📊 Watch Status\n'));
      if (runningPid) {
        const daemonLabel = stale
          ? chalk.yellow(`Running but stale (PID: ${runningPid})`)
          : chalk.green(`Running (PID: ${runningPid})`);
        console.log(`Daemon:         ${daemonLabel}`);
      } else {
        console.log(`Daemon:         ${chalk.gray('Stopped')}`);
      }
      console.log(`Leaders:        ${leaderCount}`);
      console.log(`Total Events:   ${eventCount}`);
      console.log(`Mode:           ${config.follow.mode}`);
      const visiblePollIntervalMs = activeSnapshot?.pollIntervalMs ?? config.watch.interval;
      console.log(`Poll Interval:  ${visiblePollIntervalMs / 1000}s`);
      console.log(`Min Trade USD:  $${config.watch.filterMinUsd}`);
      console.log(`State:          ${chalk[displayStatus.color](displayStatus.label)}`);
      if (displayStatus.detail) {
        console.log(`State Detail:   ${displayStatus.detail}`);
      }
      if (displayStatus.dependencySummary) {
        console.log(`Deps Unhealthy: ${chalk.yellow(displayStatus.dependencySummary)}`);
      }
      if (activeSnapshot?.startedAt) {
        console.log(`Started:        ${new Date(activeSnapshot.startedAt).toLocaleString()}`);
      }
      console.log(`Consec Errors:  ${activeSnapshot?.consecutiveErrors ?? engineStats.consecutiveErrors}`);
      if (visibleError.lastError) {
        console.log(`Last Error:     ${chalk.red(visibleError.lastError)}`);
        if (visibleError.lastErrorInfo) {
          console.log(`Error Source:   ${visibleError.lastErrorInfo.source}`);
          console.log(`Error Code:     ${visibleError.lastErrorInfo.code}`);
        }
      }

      if (recoverySnapshot) {
        console.log(chalk.bold('\nRecovery:\n'));
        console.log(`Status:         ${chalk[displayStatus.color](displayStatus.label)}`);
        console.log(`Backoff:        ${recoverySnapshot.currentBackoffMs}ms`);
        console.log(`Retryable:      ${recoverySnapshot.consecutiveRetryableErrors}`);
        console.log(`Restarts:       ${recoverySnapshot.restartCount}`);
        if (recoverySnapshot.lastRecoveryReason) {
          console.log(`Last Recovery:  ${recoverySnapshot.lastRecoveryReason}`);
        }
        const dependencySummary = formatUnhealthyDependencySummary(
          recoverySnapshot.dependencies
            .filter((dependency) => !dependency.healthy)
            .map((dependency) => dependency.name)
        );
        if (dependencySummary) {
          console.log(`Deps Down:      ${chalk.yellow(dependencySummary)}`);
        }
        if (recoverySnapshot.dependencies.length > 0) {
          recoverySnapshot.dependencies.forEach((dependency) => {
            console.log(
              `${dependency.name}: ${dependency.healthy ? chalk.green('healthy') : chalk.red('unhealthy')}`
            );
          });
        }
      }

      if (engineStats.pollCount > 0) {
        console.log(chalk.bold('\nEngine Stats:\n'));
        console.log(`Polls:          ${engineStats.pollCount}`);
        console.log(`Events Found:   ${engineStats.eventsFound}`);
        console.log(`Events Saved:   ${engineStats.eventsSaved}`);
        console.log(`Leaders Done:   ${engineStats.leadersCompletedInPoll}`);
        console.log(`Errors:         ${engineStats.errors}`);
        if (engineStats.currentPollStartedAt) {
          console.log(`Current Poll:   ${new Date(engineStats.currentPollStartedAt).toLocaleString()}`);
        }
        if (engineStats.currentLeaderAddress) {
          console.log(`Leader:         ${engineStats.currentLeaderAddress}`);
          console.log(`Leader Pass:    ${engineStats.currentLeaderPass}`);
          console.log(`Leader Found:   ${engineStats.currentLeaderEventsFound}`);
          console.log(`Leader Saved:   ${engineStats.currentLeaderEventsSaved}`);
          console.log(`Leader Mode:    ${engineStats.currentLeaderCatchUpMode}`);
          console.log(`Leader Budget:  ${engineStats.currentLeaderCatchUpBudget}`);
          console.log(`Leader Passes:  ${engineStats.currentLeaderCatchUpPassLimit}`);
          if (engineStats.currentLeaderCursorTimestamp) {
            console.log(`Leader Cursor:  ${new Date(engineStats.currentLeaderCursorTimestamp).toLocaleString()}`);
          }
          if (currentLeaderDbProgress) {
            console.log(`Leader DB Rows: ${currentLeaderDbProgress.eventCount}`);
            if (currentLeaderDbProgress.cursorTimestamp) {
              console.log(`Leader DB Ts:   ${new Date(currentLeaderDbProgress.cursorTimestamp).toLocaleString()}`);
            }
          }
        }
        if (engineStats.lastPollAt) {
          console.log(`Last Poll:      ${new Date(engineStats.lastPollAt).toLocaleString()}`);
        }
      }

      if (followSnapshot) {
        console.log(chalk.bold('\nFollow Engine:\n'));
        console.log(`Listening:      ${followSnapshot.listening ? chalk.green('Yes') : chalk.gray('No')}`);
        console.log(`Mode:           ${followSnapshot.mode}`);
        console.log(`Evaluated:      ${followSnapshot.stats.eventsEvaluated}`);
        console.log(`Followed:       ${followSnapshot.stats.eventsFollowed}`);
        console.log(`Skipped:        ${followSnapshot.stats.eventsSkipped}`);
        if (followSnapshot.stats.lastDecisionReason) {
          console.log(`Last Decision:  ${followSnapshot.stats.lastDecisionReason}`);
        }
        if (followSnapshot.stats.lastError) {
          console.log(`Follow Error:   ${chalk.red(followSnapshot.stats.lastError.message)}`);
          console.log(`Follow Code:    ${followSnapshot.stats.lastError.code}`);
        }
      }

      if (recentEvents.length > 0) {
        console.log(chalk.bold('\nRecent Events:\n'));
        console.log(
          `Result Summary: OK ${recentEventSummary.byState.ok} | SKIP ${recentEventSummary.byState.skip} | FAIL ${recentEventSummary.byState.fail} | PEND ${recentEventSummary.byState.pend}`
        );
        const table = new Table({
          head: ['Time', 'Leader', 'Type', 'Market', 'Amount', 'Result'],
          colWidths: [12, 14, 6, 24, 12, 10],
        });

        recentEvents.forEach(event => {
          const followDisplay = buildEventFollowDisplay(event);
          table.push([
            new Date(event.timestamp).toLocaleTimeString(),
            `${event.leaderAddress.slice(0, 6)}...`,
            event.eventType,
            (event.marketTitle || event.conditionId).slice(0, 22),
            `$${event.amountUsd.toFixed(2)}`,
            followDisplay.label,
          ]);
        });

        console.log(table.toString());
      } else {
        console.log(chalk.gray('\nNo events captured yet.'));
      }
    });

  // watch stream
  cmd
    .command('stream')
    .description('Stream events in real-time')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .option('-n, --limit <n>', 'Max events to show', '50')
    .action(async (options) => {
      const eventRepo = getEventRepo();
      const limit = parseInt(options.limit);

      // Get recent events
      const recentEvents = await eventRepo.find({}, limit);
      const eventSummary = summarizeEventFollowDisplays(recentEvents);

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('events', recentEvents.map(e => ({
            id: e.id,
            leaderAddress: e.leaderAddress,
            eventType: e.eventType,
            conditionId: e.conditionId,
            marketTitle: e.marketTitle,
            outcome: e.outcome,
            price: e.price,
            quantity: e.quantity,
            amountUsd: e.amountUsd,
            timestamp: e.timestamp,
            followed: !!e.followed,
            followState: buildEventFollowDisplay(e).label,
            followReason: buildEventFollowDisplay(e).detail,
          })), {
            summary: eventSummary,
          }));
        return;
      }

      console.log(chalk.bold('\n📡 Event Stream\n'));

      if (recentEvents.length === 0) {
        console.log(chalk.gray('No events captured yet.'));
        return;
      }

      const table = new Table({
        head: ['Time', 'Leader', 'Type', 'Outcome', 'Market', 'Amount', 'Result', 'Reason'],
        colWidths: [12, 14, 6, 8, 20, 12, 10, 24],
      });

      console.log(
        `Result Summary: OK ${eventSummary.byState.ok} | SKIP ${eventSummary.byState.skip} | FAIL ${eventSummary.byState.fail} | PEND ${eventSummary.byState.pend}`
      );

      recentEvents.forEach(event => {
        const typeColor = event.eventType === 'BUY' ? chalk.green : chalk.red;
        const followDisplay = buildEventFollowDisplay(event);
        table.push([
          new Date(event.timestamp).toLocaleTimeString(),
          `${event.leaderAddress.slice(0, 6)}...`,
          typeColor(event.eventType),
          event.outcome || '-',
          (event.marketTitle || event.conditionId).slice(0, 18),
          `$${event.amountUsd.toFixed(2)}`,
          followDisplay.color === 'green'
            ? chalk.green(followDisplay.label)
            : followDisplay.color === 'cyan'
              ? chalk.cyan(followDisplay.label)
              : followDisplay.color === 'red'
                ? chalk.red(followDisplay.label)
                : chalk.gray(followDisplay.label),
          (followDisplay.detail ?? '-').slice(0, 22),
        ]);
      });

      console.log(table.toString());
    });

  cmd
    .command('reconcile <address>')
    .description('Compare local captured trades with Polymarket Data API trades')
    .option('--incremental', 'Compare the latest overlapping API/local history slice instead of a fixed time window', false)
    .option('--from <value>', 'Start time (ISO, unix seconds, or unix milliseconds)')
    .option('--to <value>', 'End time (ISO, unix seconds, or unix milliseconds)')
    .option('--hours <n>', 'Lookback hours when --from is omitted')
    .option('--window <value>', 'Fixed lookback window like 10m, 30m, 2h, or 1d')
    .option('-n, --limit <n>', 'Max trades to compare from each source', '500')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (address: string, options) => {
      const jsonOutput = isJsonOutput(options);
      const normalizedAddress = address.toLowerCase();

      try {
        if (options.incremental && (options.from || options.to || options.hours || options.window)) {
          throw new Error('--incremental cannot be combined with --from, --to, --hours, or --window.');
        }
        if (options.window && options.from) {
          throw new Error('--window cannot be combined with --from. Use --to to anchor a fixed trailing window.');
        }
        if (options.window && options.hours) {
          throw new Error('--window cannot be combined with --hours.');
        }

        const limit = parsePositiveInt(options.limit, 'limit');
        const window = options.incremental ? null : resolveReconcileWindow(options);
        const spinner = jsonOutput ? null : ora(`Reconciling ${normalizedAddress}...`).start();
        const eventRepo = getEventRepo();
        const dataApi = getPolymarketDataAPI();
        const apiPageLimit = Math.min(limit, 1000);
        const defaultApiMaxPages = Math.max(4, Math.ceil(3000 / apiPageLimit) + 1);
        const apiMaxPages = options.incremental
          ? Math.max(defaultApiMaxPages, 25)
          : defaultApiMaxPages;
        const localFetchLimit = Math.max(limit, apiPageLimit * apiMaxPages);

        const localTrades = options.incremental
          ? await eventRepo.find({
              leaderAddress: normalizedAddress,
            }, localFetchLimit)
          : await eventRepo.find({
              leaderAddress: normalizedAddress,
              fromTimestamp: window!.fromTimestamp,
              toTimestamp: window!.toTimestamp,
            }, localFetchLimit);
        const localAvailableWindow = summarizeReconciliationTradeWindow(localTrades);
        const apiFetchFromTimestamp = options.incremental
          ? localAvailableWindow.latestTimestamp ?? 0
          : window!.fromTimestamp;
        const apiHistory = await dataApi.getTradesWindow(normalizedAddress, {
          fromTimestamp: apiFetchFromTimestamp,
          toTimestamp: window?.toTimestamp ?? Date.now(),
          pageLimit: apiPageLimit,
          maxPages: apiMaxPages,
        });
        const apiTrades = apiHistory.trades;
        const apiAvailableWindow = {
          count: apiTrades.length,
          latestTimestamp: apiHistory.latestTimestamp,
          oldestTimestamp: apiHistory.oldestTimestamp,
        };
        const comparisonWindow = options.incremental
          ? resolveIncrementalReconciliationComparisonWindow({
              apiTrades,
              localTrades,
            })
          : resolveReconciliationComparisonWindow({
              requestedFromTimestamp: window!.fromTimestamp,
              requestedToTimestamp: window!.toTimestamp,
              apiTrades,
              localTrades,
            });
        const comparedApiTrades = comparisonWindow.hasOverlap
          ? apiTrades.filter((trade) =>
              trade.timestamp >= comparisonWindow.fromTimestamp
              && trade.timestamp <= comparisonWindow.toTimestamp
            )
          : [];
        const comparedLocalTrades = comparisonWindow.hasOverlap
          ? localTrades.filter((trade) =>
              trade.timestamp >= comparisonWindow.fromTimestamp
              && trade.timestamp <= comparisonWindow.toTimestamp
            )
          : [];
        const apiWindowComplete = apiHistory.windowComplete;
        const localWindowComplete = options.incremental
          ? localTrades.length < localFetchLimit
          : localAvailableWindow.oldestTimestamp === null
            || localTrades.length < localFetchLimit
            || localAvailableWindow.oldestTimestamp <= window!.fromTimestamp;
        const reconciliation = comparisonWindow.hasOverlap
          ? reconcileTradeSets({
              apiTrades: comparedApiTrades,
              localTrades: comparedLocalTrades,
            })
          : {
              summary: {
                apiTrades: 0,
                localTrades: 0,
                matchedTrades: 0,
                missingInLocal: 0,
                localOnly: 0,
                coveragePct: 0,
              },
              missingInLocal: [],
              localOnly: [],
            };
        const formatWindowRange = (start: number | null, end: number | null): string => {
          if (start === null || end === null) {
            return 'n/a';
          }
          return `${new Date(start).toLocaleString()} -> ${new Date(end).toLocaleString()}`;
        };

        if (jsonOutput) {
          printJsonSuccess('watch_reconciled', 'Watch reconciliation completed.', {
            address: normalizedAddress,
            window: {
              mode: options.incremental ? 'incremental' : window?.preset ? 'fixed_window' : 'window',
              requestedFromTimestamp: window?.fromTimestamp ?? null,
              requestedToTimestamp: window?.toTimestamp ?? null,
              comparedFromTimestamp: comparisonWindow.hasOverlap ? comparisonWindow.fromTimestamp : null,
              comparedToTimestamp: comparisonWindow.hasOverlap ? comparisonWindow.toTimestamp : null,
              hours: window?.hours ?? null,
              lookbackMs: window?.lookbackMs ?? null,
              preset: window?.preset ?? null,
              limit,
              apiWindowComplete,
              localWindowComplete,
              comparisonAvailable: comparisonWindow.hasOverlap,
              apiPagesFetched: apiHistory.pagesFetched,
              apiPageBudgetReached: apiHistory.pageBudgetReached,
              apiOffsetCapReached: apiHistory.apiOffsetCapReached,
            },
            availability: {
              api: apiAvailableWindow,
              local: localAvailableWindow,
            },
            summary: reconciliation.summary,
            missingInLocal: reconciliation.missingInLocal,
            localOnly: reconciliation.localOnly,
          });
          return;
        }

        spinner?.succeed(`Reconciled ${normalizedAddress}`);

        console.log(chalk.bold('\nReconciliation Summary\n'));
        console.log(`Address:           ${normalizedAddress}`);
        console.log(`Mode:              ${options.incremental ? 'incremental' : window?.preset ? 'fixed_window' : 'window'}`);
        if (window) {
          console.log(`Requested Window:  ${new Date(window.fromTimestamp).toLocaleString()} -> ${new Date(window.toTimestamp).toLocaleString()}`);
          if (window.preset) {
            console.log(`Window Preset:     ${window.preset}`);
          }
        } else {
          console.log('Requested Window:  latest overlapping API/local slice');
        }
        console.log(`API Window:        ${formatWindowRange(apiAvailableWindow.oldestTimestamp, apiAvailableWindow.latestTimestamp)}`);
        console.log(`Local Window:      ${formatWindowRange(localAvailableWindow.oldestTimestamp, localAvailableWindow.latestTimestamp)}`);

        if (!comparisonWindow.hasOverlap) {
          console.log(chalk.yellow('\nNo overlapping comparison window is available.'));
          console.log(chalk.gray('The current API history slice and local capture slice do not overlap, so this run cannot judge capture completeness.'));
          if (apiHistory.apiOffsetCapReached) {
            console.log(chalk.gray('API history is truncated by Polymarket\'s current offset cap (3000).'));
          } else if (!apiWindowComplete) {
            console.log(chalk.gray('API history is truncated by the current reconciliation page budget.'));
          }
          if (!localWindowComplete) {
            console.log(chalk.gray('Local history is truncated by the current fetch limit.'));
          }
          return;
        }

        console.log(`Compared Window:   ${new Date(comparisonWindow.fromTimestamp).toLocaleString()} -> ${new Date(comparisonWindow.toTimestamp).toLocaleString()}`);
        console.log(`API Trades:        ${reconciliation.summary.apiTrades}`);
        console.log(`Local Trades:      ${reconciliation.summary.localTrades}`);
        console.log(`Matched Trades:    ${reconciliation.summary.matchedTrades}`);
        console.log(`Missing In Local:  ${reconciliation.summary.missingInLocal}`);
        console.log(`Local Only:        ${reconciliation.summary.localOnly}`);
        console.log(`Coverage:          ${reconciliation.summary.coveragePct.toFixed(2)}%`);

        if (!apiWindowComplete || !localWindowComplete) {
          console.log(chalk.yellow('\nWindow completeness is limited by the current --limit value.'));
          console.log(chalk.gray(`  apiWindowComplete=${apiWindowComplete}, localWindowComplete=${localWindowComplete}`));
        }

        const renderTradeTable = (title: string, trades: typeof reconciliation.missingInLocal) => {
          if (trades.length === 0) {
            return;
          }

          console.log(chalk.bold(`\n${title}\n`));
          const table = new Table({
            head: ['Time', 'Type', 'Outcome', 'Market', 'Amount', 'Tx'],
            colWidths: [22, 8, 10, 34, 12, 14],
          });

          trades.slice(0, 20).forEach((trade) => {
            table.push([
              new Date(trade.timestamp).toLocaleString(),
              trade.eventType,
              trade.outcome ?? '-',
              (trade.marketTitle || trade.marketSlug || trade.conditionId).slice(0, 32),
              `$${trade.amountUsd.toFixed(2)}`,
              trade.txHash ? `${trade.txHash.slice(0, 10)}...` : '-',
            ]);
          });

          console.log(table.toString());
          if (trades.length > 20) {
            console.log(chalk.gray(`Showing first 20 of ${trades.length} trades.`));
          }
        };

        renderTradeTable('Missing In Local', reconciliation.missingInLocal);
        renderTradeTable('Local Only', reconciliation.localOnly);
      } catch (error) {
        if (jsonOutput) {
          printJsonError('watch_reconcile_failed', error instanceof Error ? error.message : String(error), {
            address: normalizedAddress,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
    });

  // watch stop
  cmd
    .command('stop')
    .description('Stop the background watch daemon')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);
      const spinner = jsonOutput ? null : ora('Stopping watch daemon...').start();

      try {
        const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (!isProcessRunning(pid)) {
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return !isProcessRunning(pid);
        };

        // Check lock file first
        const runningPid = runtimeState.cleanupStaleState();

        if (runningPid) {
          // Kill the process from lock file
          try {
            const snapshot = runtimeState.readStatus();
            const hasActivePoll = snapshot?.pid === runningPid && snapshot.engine.currentPollStartedAt !== null;
            const gracefulTimeoutMs = hasActivePoll
              ? Math.max(15_000, Math.min(snapshot?.pollIntervalMs ?? 15_000, 30_000))
              : 5_000;
            process.kill(runningPid, 'SIGTERM');
            const exitedGracefully = await waitForExit(runningPid, gracefulTimeoutMs);

            // Check if still running, force kill if needed
            if (!exitedGracefully && isProcessRunning(runningPid)) {
              process.kill(runningPid, 'SIGKILL');
              await waitForExit(runningPid, 1_000);
            }

            // Clean up lock file
            runtimeState.removeLockFile(runningPid);
            runtimeState.removeStatusFile();
            if (jsonOutput) {
              printJsonSuccess('watch_stopped', `Stopped watch daemon (PID: ${runningPid})`, {
                pid: runningPid,
                stoppedProcesses: 1,
              });
              return;
            }
            spinner?.succeed(`Stopped watch daemon (PID: ${runningPid})`);
            return;
          } catch (err) {
            // Process may have already exited
            runtimeState.removeLockFile(runningPid);
            runtimeState.removeStatusFile();
          }
        }

        // Fallback: Try to find and kill copyhunter watch processes by grep
        const { execFileSync } = await import('child_process');
        const processPattern = buildWatchDaemonProcessPattern(path.dirname(runtimeState.paths.lockFile));

        let result = '';
        try {
          result = execFileSync('pgrep', ['-f', processPattern], {
            encoding: 'utf-8',
          }).trim();
        } catch (error: any) {
          if (error?.status !== 1) {
            throw error;
          }
        }

        if (!result) {
          if (jsonOutput) {
            printJsonSuccess('watch_not_running', 'No watch daemon running.', {
              stoppedProcesses: 0,
            });
            return;
          }
          spinner?.info('No watch daemon running.');
          return;
        }

        const pids = result.split('\n').filter(Boolean);

        // Kill the processes
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGTERM');
          } catch {
            // Process may have already exited
          }
        }

        if (jsonOutput) {
          printJsonSuccess('watch_stopped', `Stopped ${pids.length} watch process(es).`, {
            stoppedProcesses: pids.length,
            pids: pids.map((pid) => Number(pid)),
          });
          return;
        }
        spinner?.succeed(`Stopped ${pids.length} watch process(es).`);
        runtimeState.removeStatusFile();
      } catch (error) {
        if (jsonOutput) {
          printJsonError('watch_stop_failed', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to stop: ${error instanceof Error ? error.message : error}`);
      }
    });

  // watch poll
  cmd
    .command('poll')
    .description('Run a single poll cycle')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const watchEngine = getWatchEngine();
      const spinner = ora('Polling for new trades...').start();

      try {
        const newEvents = await watchEngine.poll();
        spinner.stop();

        if (isJsonOutput(options)) {
          printJson(createJsonArrayResponse('events', newEvents, { found: newEvents.length }));
          return;
        }

        if (newEvents.length === 0) {
          console.log(chalk.gray('No new events found.'));
          return;
        }

        console.log(chalk.green(`Found ${newEvents.length} new events:\n`));

        newEvents.forEach(event => {
          const typeColor = event.eventType === 'BUY' ? chalk.green : chalk.red;
          console.log(
            `${typeColor(event.eventType)} ` +
            `${chalk.yellow(`$${event.amountUsd.toFixed(2)}`)} ` +
            `${(event.marketTitle || event.conditionId).slice(0, 40)} ` +
            `(${event.leaderAddress.slice(0, 8)}...)`
          );
        });
      } catch (error) {
        spinner.fail(`Poll failed: ${error instanceof Error ? error.message : error}`);
      }
    });

  return cmd;
}
