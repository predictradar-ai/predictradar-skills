/**
 * CopyHunter - Follow Command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { getConfig, setConfigValue } from '../../core/config.js';
import {
  buildEventFollowDisplay,
  getFollowEngine,
  summarizeEventFollowDisplays,
} from '../../follow/index.js';
import { reconcileFollowOrders } from '../../follow/order-reconciliation.js';
import { getEventRepo, getOrderRepo, getPositionLotRepo, getPositionRepo, getDailyStatsRepo } from '../../db/index.js';
import { getWatchRuntimeStateManager, isWatchStatusStale } from '../../watch/runtime-state.js';
import {
  buildWatchDisplayStatus,
  formatUnhealthyDependencySummary,
  resolveActiveWatchSnapshot,
} from '../../watch/index.js';
import type { FollowMode, FollowSizingMode, OrderReconcileStatus } from '../../core/types.js';
import type { OrderRow, PositionRow } from '../../db/schema.js';
import type { PositionLotGroupSummary, PositionLotSummary } from '../../db/repositories/position-lot-repo.js';
import { createJsonArrayResponse, isJsonOutput, markCommandFailed, printJson, printJsonError, printJsonSuccess } from '../json-output.js';

function parseUsdOption(value: string, label: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} number.`);
  }
  return parsed;
}

function parseSizingMode(value: string): FollowSizingMode {
  if (value !== 'fixed' && value !== 'proportional') {
    throw new Error('Sizing mode must be "fixed" or "proportional".');
  }
  return value;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

interface FollowLedgerStatusSummary extends PositionLotSummary {
  openPositions: number;
  closedPositions: number;
}

function buildMarketKey(params: {
  leaderAddress: string;
  platform: string;
  conditionId: string;
  outcome: string;
}): string {
  return [
    params.leaderAddress.toLowerCase(),
    params.platform,
    params.conditionId,
    params.outcome,
  ].join(':');
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatOutcomeSummaryLine(summary: ReturnType<typeof summarizeEventFollowDisplays>): string {
  return `OK ${summary.byState.ok} | SKIP ${summary.byState.skip} | FAIL ${summary.byState.fail} | PEND ${summary.byState.pend}`;
}

function createEmptyReconciliationCounts(): Record<OrderReconcileStatus, number> {
  return {
    pending: 0,
    not_applicable: 0,
    simulated: 0,
    estimated: 0,
    matched: 0,
    drifted: 0,
  };
}

function toCliReconciliationCounts(counts: Record<OrderReconcileStatus, number>) {
  return {
    pending: counts.pending,
    notApplicable: counts.not_applicable,
    simulated: counts.simulated,
    estimated: counts.estimated,
    matched: counts.matched,
    drifted: counts.drifted,
  };
}

function summarizeOrders(orders: OrderRow[]): {
  returned: number;
  requestedAmountUsd: number;
  executedAmountUsd: number;
  byStatus: Record<'pending' | 'executed' | 'failed' | 'cancelled', number>;
  byReconcileStatus: ReturnType<typeof toCliReconciliationCounts>;
} {
  const reconcileCounts = createEmptyReconciliationCounts();

  const summary = orders.reduce((acc, order) => {
    acc.returned += 1;
    acc.requestedAmountUsd += order.amountUsd;
    acc.executedAmountUsd += order.executedAmountUsd ?? 0;
    acc.byStatus[order.status as keyof typeof acc.byStatus] += 1;
    reconcileCounts[(order.reconcileStatus ?? 'pending') as OrderReconcileStatus] += 1;
    return acc;
  }, {
    returned: 0,
    requestedAmountUsd: 0,
    executedAmountUsd: 0,
    byStatus: {
      pending: 0,
      executed: 0,
      failed: 0,
      cancelled: 0,
    },
  });

  return {
    ...summary,
    byReconcileStatus: toCliReconciliationCounts(reconcileCounts),
  };
}

async function getFollowLedgerSummary(): Promise<FollowLedgerStatusSummary> {
  const positionRepo = getPositionRepo();
  const lotRepo = getPositionLotRepo();
  const [openPositions, closedPositions, lotSummary] = await Promise.all([
    positionRepo.count({ leaderAddress: 'self', status: 'open' }),
    positionRepo.count({ leaderAddress: 'self', status: 'closed' }),
    lotRepo.summarize({ leaderAddress: 'self' }),
  ]);

  return {
    openPositions,
    closedPositions,
    ...lotSummary,
  };
}

async function enrichPositionsWithLotSummary(positions: PositionRow[]): Promise<Array<PositionRow & {
  lotSummary: Pick<PositionLotGroupSummary, 'openLots' | 'closedLots' | 'totalLots'>;
}>> {
  const lotRepo = getPositionLotRepo();
  const summaries = await lotRepo.summarizeByMarket({ leaderAddress: 'self' });
  const summaryByKey = new Map(
    summaries.map((summary) => [
      buildMarketKey(summary),
      summary,
    ])
  );

  return positions.map((position) => {
    const summary = summaryByKey.get(buildMarketKey({
      leaderAddress: position.leaderAddress,
      platform: position.platform,
      conditionId: position.conditionId,
      outcome: position.outcome,
    }));

    return {
      ...position,
      lotSummary: {
        openLots: summary?.openLots ?? 0,
        closedLots: summary?.closedLots ?? 0,
        totalLots: summary?.totalLots ?? 0,
      },
    };
  });
}

export function createFollowCommand(): Command {
  const cmd = new Command('follow')
    .description('Copy trading commands');

  // follow shadow
  cmd
    .command('shadow')
    .description('Start shadow mode (simulate trades without executing)')
    .option('--sizing <mode>', 'Sizing mode: fixed or proportional')
    .option('--bankroll <amount>', 'Follower bankroll in USD for proportional sizing')
    .option('--max-per-trade <amount>', 'Max USD per trade')
    .option('--daily-limit <amount>', 'Daily USD limit')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      try {
        const currentConfig = getConfig();
        const sizingMode = options.sizing ? parseSizingMode(options.sizing) : currentConfig.follow.sizingMode;
        const bankrollUsd = options.bankroll ? parseUsdOption(options.bankroll, 'Bankroll') : null;
        const maxPerTrade = options.maxPerTrade ? parseUsdOption(options.maxPerTrade, 'Max per trade') : null;
        const dailyLimit = options.dailyLimit ? parseUsdOption(options.dailyLimit, 'Daily limit', true) : null;

        setConfigValue('follow.mode', 'shadow');
        setConfigValue('follow.sizingMode', sizingMode);
        if (bankrollUsd !== null) {
          setConfigValue('follow.bankrollUsd', bankrollUsd);
        }
        if (maxPerTrade !== null) {
          setConfigValue('follow.maxPerTrade', maxPerTrade);
        }
        if (dailyLimit !== null) {
          setConfigValue('follow.dailyLimit', dailyLimit);
        }

        if (jsonOutput) {
          printJsonSuccess('follow_mode_updated', 'Shadow mode enabled.', {
            mode: 'shadow',
            dryRun: true,
            sizingMode,
            bankrollUsd: bankrollUsd ?? getConfig().follow.bankrollUsd,
            maxPerTrade: maxPerTrade ?? getConfig().follow.maxPerTrade,
            dailyLimit: dailyLimit ?? getConfig().follow.dailyLimit,
          });
          return;
        }

        console.log(chalk.green('✓ Shadow mode enabled'));
        console.log(chalk.gray('  Trades will be simulated, not executed'));
        console.log(chalk.gray(`  Sizing: ${sizingMode}`));
        console.log(chalk.gray('\n  Start watching with: copyhunter watch start --follow'));
      } catch (error) {
        if (jsonOutput) {
          printJsonError('invalid_follow_config', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
    });

  // follow live
  cmd
    .command('live')
    .description('Start live mode (execute real trades)')
    .option('--sizing <mode>', 'Sizing mode: fixed or proportional')
    .option('--bankroll <amount>', 'Follower bankroll in USD for proportional sizing')
    .option('--max-per-trade <amount>', 'Max USD per trade', '50')
    .option('--daily-limit <amount>', 'Daily USD limit', '500')
    .option('--confirm', 'Confirm live trading', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      try {
        const currentConfig = getConfig();
        const sizingMode = options.sizing ? parseSizingMode(options.sizing) : currentConfig.follow.sizingMode;
        const bankrollUsd = options.bankroll ? parseUsdOption(options.bankroll, 'Bankroll') : null;
        const maxPerTrade = parseUsdOption(options.maxPerTrade, 'Max per trade');
        const dailyLimit = parseUsdOption(options.dailyLimit, 'Daily limit', true);

        if (!options.confirm) {
          if (jsonOutput) {
            printJsonError('confirmation_required', 'Live trading requires --confirm.', {
              command: 'copyhunter follow live --confirm',
            });
            return;
          }
          markCommandFailed();
          console.log(chalk.yellow('\n⚠️  Live trading requires confirmation\n'));
          console.log('This will execute REAL trades using your polymarket-cli wallet.');
          console.log(chalk.gray('\nTo enable live trading:'));
          console.log(chalk.gray('  copyhunter follow live --confirm'));
          return;
        }

        setConfigValue('follow.mode', 'live');
        setConfigValue('follow.sizingMode', sizingMode);
        setConfigValue('follow.maxPerTrade', maxPerTrade);
        setConfigValue('follow.dailyLimit', dailyLimit);
        if (bankrollUsd !== null) {
          setConfigValue('follow.bankrollUsd', bankrollUsd);
        }

        if (jsonOutput) {
          printJsonSuccess('follow_mode_updated', 'Live mode enabled.', {
            mode: 'live',
            sizingMode,
            bankrollUsd: bankrollUsd ?? getConfig().follow.bankrollUsd,
            maxPerTrade,
            dailyLimit,
          });
          return;
        }

        console.log(chalk.green('✓ Live mode enabled'));
        console.log(`  Sizing mode:   ${sizingMode}`);
        if (bankrollUsd !== null) {
          console.log(`  Bankroll:      $${bankrollUsd}`);
        }
        console.log(`  Max per trade: $${maxPerTrade}`);
        console.log(`  Daily limit:   $${dailyLimit}`);
        console.log(chalk.gray('\n  Start watching with: copyhunter watch start --follow'));
      } catch (error) {
        if (jsonOutput) {
          printJsonError('invalid_follow_config', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
    });

  // follow stop
  cmd
    .command('stop')
    .description('Stop following (disable mode)')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const followEngine = getFollowEngine();
      followEngine.stop();
      setConfigValue('follow.mode', 'disabled');

      if (isJsonOutput(options)) {
        printJsonSuccess('follow_mode_updated', 'Following disabled.', {
          mode: 'disabled',
        });
        return;
      }

      console.log(chalk.yellow('✓ Following disabled'));
    });

  // follow status
  cmd
    .command('status')
    .description('Show current follow status')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const config = getConfig();
      const followEngine = getFollowEngine();
      const runtimeState = getWatchRuntimeStateManager();
      const eventRepo = getEventRepo();
      const orderRepo = getOrderRepo();
      const statsRepo = getDailyStatsRepo();
      const runningPid = runtimeState.cleanupStaleState();
      const persistedStatus = runtimeState.readStatus();
      const activeSnapshot = resolveActiveWatchSnapshot(runningPid, persistedStatus);
      const persistedFollow = activeSnapshot?.follow ?? null;
      const recovery = activeSnapshot?.recovery ?? null;
      const runtimeStale = isWatchStatusStale(persistedStatus, runningPid);

      const engineStats = persistedFollow?.stats ?? followEngine.getStats();
      const watchStats = activeSnapshot?.engine;
      const watchStatus = buildWatchDisplayStatus({
        runningPid,
        stale: runtimeStale,
        snapshot: activeSnapshot,
        engineStats: watchStats ?? {
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
        },
        visibleErrorInfo: activeSnapshot?.lastErrorInfo ?? watchStats?.lastError ?? null,
        visibleErrorMessage: activeSnapshot?.lastError ?? watchStats?.lastError?.message ?? null,
      });
      const [orderCounts, orderReconciliation] = await Promise.all([
        orderRepo.countByStatus(),
        orderRepo.countByReconcileStatus(),
      ]);
      const recentEvents = await eventRepo.find({}, 50);
      const recentEventSummary = summarizeEventFollowDisplays(recentEvents);
      const ledgerSummary = await getFollowLedgerSummary();
      const dailySpent = await orderRepo.getDailySpent();
      const todayStats = await statsRepo.getOrCreateToday();

      if (isJsonOutput(options)) {
        printJson({
          mode: config.follow.mode,
          listening: persistedFollow?.listening ?? followEngine.isListening(),
          daemonPid: runningPid,
          config: {
            followerAddress: config.follow.followerAddress,
            sizingMode: config.follow.sizingMode,
            bankrollUsd: config.follow.bankrollUsd,
            maxPerTrade: config.follow.maxPerTrade,
            dailyLimit: config.follow.dailyLimit,
            allowlist: config.follow.allowlist,
            blocklist: config.follow.blocklist,
          },
          risk: config.risk,
          stats: {
            engine: engineStats,
            recentEvents: {
              summary: recentEventSummary,
              sample: recentEvents.slice(0, 10).map((event) => {
                const followDisplay = buildEventFollowDisplay(event);
                return {
                  id: event.id,
                  leaderAddress: event.leaderAddress,
                  eventType: event.eventType,
                  market: event.marketTitle || event.conditionId,
                  amountUsd: event.amountUsd,
                  timestamp: event.timestamp,
                  state: followDisplay.label,
                  category: followDisplay.category,
                  reason: followDisplay.detail,
                };
              }),
            },
            orders: orderCounts,
            positions: ledgerSummary.openPositions,
            exposure: ledgerSummary.totalExposure,
            dailySpent,
            today: todayStats,
            orderReconciliation: toCliReconciliationCounts(orderReconciliation),
            ledger: {
              openPositions: ledgerSummary.openPositions,
              closedPositions: ledgerSummary.closedPositions,
              openLots: ledgerSummary.openLots,
              closedLots: ledgerSummary.closedLots,
              totalLots: ledgerSummary.totalLots,
              totalExposure: ledgerSummary.totalExposure,
              realizedPnl: ledgerSummary.realizedPnl,
            },
          },
          recovery,
        });
        return;
      }

      const modeColors: Record<FollowMode, (text: string) => string> = {
        shadow: chalk.cyan,
        live: chalk.green,
        disabled: chalk.gray,
      };

      console.log(chalk.bold('\n🎯 Follow Status\n'));
      console.log(`Mode:           ${modeColors[config.follow.mode](config.follow.mode)}`);
      console.log(`Engine:         ${(persistedFollow?.listening ?? followEngine.isListening()) ? chalk.green('Running') : chalk.gray('Stopped')}`);
      if (runningPid) {
        console.log(`Daemon PID:     ${runningPid}`);
      }
      console.log(`Watch State:    ${chalk[watchStatus.color](watchStatus.label)}`);
      if (watchStatus.detail) {
        console.log(`Watch Detail:   ${watchStatus.detail}`);
      }
      if (watchStatus.dependencySummary) {
        console.log(`Deps Unhealthy: ${chalk.yellow(watchStatus.dependencySummary)}`);
      }
      console.log(`Follower Addr:  ${config.follow.followerAddress || '(not set)'}`);
      console.log(`Max Per Trade:  $${config.follow.maxPerTrade}`);
      console.log(`Sizing Mode:    ${config.follow.sizingMode}`);
      console.log(`Bankroll:       $${config.follow.bankrollUsd.toFixed(2)}`);
      console.log(`Daily Limit:    $${config.follow.dailyLimit}`);
      console.log(`Daily Spent:    $${dailySpent.toFixed(2)}`);
      console.log(`Drifted Orders: ${orderReconciliation.drifted}`);

      console.log(chalk.bold('\n🧭 Recent Outcomes\n'));
      console.log(`Summary:        ${formatOutcomeSummaryLine(recentEventSummary)}`);
      console.log(`Policy:         ${recentEventSummary.byCategory.policy}`);
      console.log(`Risk:           ${recentEventSummary.byCategory.risk}`);
      console.log(`Dependency:     ${recentEventSummary.byCategory.dependency}`);
      console.log(`Execution:      ${recentEventSummary.byCategory.execution}`);
      console.log(`Runtime:        ${recentEventSummary.byCategory.runtime}`);
      console.log(`Uncategorized:  ${recentEventSummary.byCategory.uncategorized}`);
      if (recentEventSummary.topReasons.length > 0) {
        recentEventSummary.topReasons.slice(0, 3).forEach((entry, index) => {
          console.log(`Top ${index + 1}:         ${entry.state}${entry.category ? `/${entry.category}` : ''} x${entry.count} ${entry.reason}`);
        });
      }

      console.log(chalk.bold('\n📊 Today\'s Activity\n'));
      console.log(`Events Captured:  ${todayStats.eventsCaptured}`);
      console.log(`Events Followed:  ${todayStats.eventsFollowed}`);
      console.log(`Events Skipped:   ${todayStats.eventsSkipped}`);
      console.log(`Positions Opened: ${todayStats.positionsOpened}`);

      console.log(chalk.bold('\n📈 Positions\n'));
      console.log(`Open Positions: ${ledgerSummary.openPositions}`);
      console.log(`Closed Positions: ${ledgerSummary.closedPositions}`);
      console.log(`Open Lots:      ${ledgerSummary.openLots}`);
      console.log(`Closed Lots:    ${ledgerSummary.closedLots}`);
      console.log(`Total Exposure: ${formatCurrency(ledgerSummary.totalExposure)}`);
      console.log(`Realized PnL:   ${formatCurrency(ledgerSummary.realizedPnl)}`);

      console.log(chalk.bold('\n⚠️  Risk Settings\n'));
      console.log(`Max Exposure:   $${config.risk.maxExposure}`);
      console.log(`Max Positions:  ${config.risk.maxPositions}`);
      console.log(`Max Loss/Day:   $${config.risk.maxLossPerDay}`);
      console.log(`Stop Loss:      ${(config.risk.stopLossPercent * 100).toFixed(0)}%`);

      if (engineStats.eventsEvaluated > 0 || engineStats.lastError || engineStats.lastDecisionReason) {
        console.log(chalk.bold('\n🔄 Engine Stats\n'));
        console.log(`Enqueued:       ${engineStats.eventsEnqueued}`);
        console.log(`Evaluated:      ${engineStats.eventsEvaluated}`);
        console.log(`Followed:       ${engineStats.eventsFollowed}`);
        console.log(`Skipped:        ${engineStats.eventsSkipped}`);
        console.log(`Orders OK:      ${engineStats.ordersExecuted}`);
        console.log(`Orders Failed:  ${engineStats.ordersFailed}`);
        console.log(`Total Amount:   $${engineStats.totalAmountUsd.toFixed(2)}`);
        console.log(`Queue Depth:    ${engineStats.queueDepth}`);
        console.log(`Queue Peak:     ${engineStats.maxQueueDepth}`);
        if (engineStats.lastDecisionReason) {
          console.log(`Last Decision:  ${engineStats.lastDecisionReason}`);
        }
        if (engineStats.lastError) {
          console.log(`Last Error:     ${chalk.red(engineStats.lastError.message)}`);
          console.log(`Error Code:     ${engineStats.lastError.code}`);
          console.log(`Error Source:   ${engineStats.lastError.source}`);
        }
      }

      if (recovery?.dependencies.length) {
        console.log(chalk.bold('\nDependencies\n'));
        const dependencySummary = formatUnhealthyDependencySummary(
          recovery.dependencies
            .filter((dependency) => !dependency.healthy)
            .map((dependency) => dependency.name)
        );
        if (dependencySummary) {
          console.log(`Deps Down:      ${chalk.yellow(dependencySummary)}`);
        }
        recovery.dependencies.forEach((dependency) => {
          console.log(
            `${dependency.name}: ${dependency.healthy ? chalk.green('healthy') : chalk.red('unhealthy')}`
          );
        });
      }
    });

  cmd
    .command('audit')
    .description('Audit recent follow outcomes from local events')
    .option('-n, --limit <n>', 'Number of recent events to inspect', '100')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const limit = parsePositiveInt(options.limit, 'limit');
      const eventRepo = getEventRepo();
      const events = await eventRepo.find({}, limit);
      const summary = summarizeEventFollowDisplays(events);
      const rows = events.map((event) => {
        const display = buildEventFollowDisplay(event);
        return {
          id: event.id,
          leaderAddress: event.leaderAddress,
          eventType: event.eventType,
          market: event.marketTitle || event.conditionId,
          amountUsd: event.amountUsd,
          timestamp: event.timestamp,
          state: display.label,
          category: display.category,
          reason: display.detail,
        };
      });

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('events', rows, {
          summary,
          limit,
        }));
        return;
      }

      console.log(chalk.bold('\n🧾 Follow Audit\n'));
      console.log(`Window:         Last ${rows.length} local events`);
      console.log(`Summary:        ${formatOutcomeSummaryLine(summary)}`);
      console.log(
        `Categories:     policy ${summary.byCategory.policy} | risk ${summary.byCategory.risk} | dependency ${summary.byCategory.dependency} | execution ${summary.byCategory.execution} | runtime ${summary.byCategory.runtime} | uncategorized ${summary.byCategory.uncategorized}`
      );

      if (summary.topReasons.length > 0) {
        console.log(chalk.bold('\nTop Reasons\n'));
        summary.topReasons.slice(0, 5).forEach((entry) => {
          console.log(`${entry.state}${entry.category ? `/${entry.category}` : ''}: x${entry.count} ${entry.reason}`);
        });
      }

      if (rows.length === 0) {
        console.log(chalk.gray('\nNo events available for follow audit.'));
        return;
      }

      console.log(chalk.bold('\nRecent Outcomes\n'));
      const table = new Table({
        head: ['Time', 'Leader', 'Type', 'Amount', 'State', 'Category', 'Reason'],
        colWidths: [12, 14, 6, 12, 10, 14, 34],
      });

      rows.slice(0, 20).forEach((row) => {
        table.push([
          new Date(row.timestamp).toLocaleTimeString(),
          `${row.leaderAddress.slice(0, 6)}...`,
          row.eventType,
          formatCurrency(row.amountUsd),
          row.state,
          row.category ?? '-',
          (row.reason ?? '-').slice(0, 32),
        ]);
      });

      console.log(table.toString());
      if (rows.length > 20) {
        console.log(chalk.gray(`Showing first 20 of ${rows.length} events.`));
      }
    });

  // follow once
  cmd
    .command('once <identifier>')
    .description('Follow the latest trade from a specific leader (by address, #number, or alias)')
    .option('-a, --amount <usd>', 'Amount in USD to follow with')
    .option('--dry-run', 'Preview without executing')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (identifier: string, options) => {
      const config = getConfig();
      const jsonOutput = isJsonOutput(options);

      if (config.follow.mode === 'disabled' && !options.dryRun) {
        if (jsonOutput) {
          printJsonError('follow_disabled', 'Follow mode is disabled. Enable shadow or live mode first.', {
            mode: config.follow.mode,
          });
          return;
        }
        console.log(chalk.yellow('Follow mode is disabled. Enable shadow or live mode first.'));
        console.log(chalk.gray('  copyhunter follow shadow    # Enable shadow mode'));
        console.log(chalk.gray('  copyhunter follow live --confirm    # Enable live mode'));
        return;
      }

      const spinner = jsonOutput ? null : ora(`Resolving leader ${identifier}...`).start();

      try {
        // Resolve leader identifier (address, #number, or alias)
        const { getDb, leaders } = await import('../../db/index.js');
        const { eq } = await import('drizzle-orm');
        const db = getDb();

        let leaderAddress: string | null = null;
        let leaderAlias: string | null = null;

        // Check if it's a number reference (#1, #2, etc.)
        const numMatch = identifier.match(/^#?(\d+)$/);
        if (numMatch) {
          const index = parseInt(numMatch[1], 10) - 1;
          const allLeaders = await db.query.leaders.findMany({
            orderBy: (leaders, { desc }) => [desc(leaders.totalPnl)],
          });
          if (index >= 0 && index < allLeaders.length) {
            leaderAddress = allLeaders[index].address;
            leaderAlias = allLeaders[index].alias ?? null;
          }
        } else if (identifier.toLowerCase().startsWith('0x')) {
          // Full address
          const leader = await db.query.leaders.findFirst({
            where: eq(leaders.address, identifier.toLowerCase()),
          });
          if (leader) {
            leaderAddress = leader.address;
            leaderAlias = leader.alias ?? null;
          } else {
            // Use address directly even if not in database
            leaderAddress = identifier.toLowerCase();
          }
        } else {
          // Try alias
          const allLeaders = await db.query.leaders.findMany();
          const byAlias = allLeaders.find(
            (l) => l.alias && l.alias.toLowerCase() === identifier.toLowerCase()
          );
          if (byAlias) {
            leaderAddress = byAlias.address;
            leaderAlias = byAlias.alias ?? null;
          }
        }

        if (!leaderAddress) {
          if (jsonOutput) {
            printJsonError('leader_not_found', `Leader not found: ${identifier}`, {
              identifier,
            });
            return;
          }
          spinner?.fail(`Leader not found: ${identifier}`);
          console.log(chalk.gray('\nUse address, #number (e.g. #1), or alias'));
          return;
        }

        if (spinner) {
          spinner.text = `Fetching latest trade from ${leaderAlias || leaderAddress.slice(0, 10)}...`;
        }

        // Fetch latest trade using polymarket-cli
        const { getPolymarketCLI } = await import('../../platforms/polymarket/cli-wrapper.js');
        const cli = getPolymarketCLI();

        const trades = await cli.getTrades(leaderAddress, 5);

        if (trades.length === 0) {
          if (jsonOutput) {
            printJsonError('no_recent_trades', 'No recent trades found for this leader', {
              leaderAddress,
            });
            return;
          }
          spinner?.fail('No recent trades found for this leader');
          return;
        }

        const latestTrade = trades[0];
        spinner?.succeed(`Found latest trade: ${latestTrade.eventType} ${latestTrade.outcome} on ${latestTrade.marketSlug || latestTrade.conditionId.slice(0, 10)}`);

        const requestedAmount = options.amount
          ? parseUsdOption(options.amount, 'Follow amount')
          : null;
        const followEngine = getFollowEngine();
        const decision = await followEngine.planFollow(latestTrade, config, {
          requestedAmountUsd: requestedAmount ?? undefined,
        });

        if (!decision.shouldFollow || decision.adjustedAmount === undefined) {
          if (jsonOutput) {
            printJsonError('follow_rejected', decision.reason, {
              trade: latestTrade,
              decision,
            });
            return;
          }
          spinner?.fail(`Follow rejected: ${decision.reason}`);
          return;
        }

        if (jsonOutput) {
          if (options.dryRun) {
            printJsonSuccess('follow_once_preview', 'Follow plan generated.', {
              trade: latestTrade,
              decision,
              followPlan: {
                mode: config.follow.mode,
                amount: decision.adjustedAmount,
                dryRun: true,
              },
            });
            return;
          }

          const order = await followEngine.execute(latestTrade, decision.adjustedAmount, config);

          printJsonSuccess('follow_once_executed', 'Follow executed.', {
            trade: latestTrade,
            decision,
            followPlan: {
              mode: config.follow.mode,
              amount: decision.adjustedAmount,
              dryRun: false,
            },
            order,
          });
          return;
        }

        // Show trade details
        console.log(chalk.bold('\nTrade Details\n'));
        console.log(`Market:    ${latestTrade.marketTitle || latestTrade.marketSlug || latestTrade.conditionId}`);
        console.log(`Side:      ${latestTrade.eventType}`);
        console.log(`Outcome:   ${latestTrade.outcome}`);
        console.log(`Price:     $${latestTrade.price.toFixed(4)}`);
        console.log(`Amount:    $${latestTrade.amountUsd.toFixed(2)}`);
        console.log(`Time:      ${new Date(latestTrade.timestamp).toLocaleString()}`);

        console.log(chalk.bold('\nFollow Plan\n'));
        console.log(`Mode:      ${config.follow.mode}`);
        console.log(`Amount:    $${decision.adjustedAmount.toFixed(2)}`);
        console.log(`Sizing:    ${decision.sizing?.mode ?? config.follow.sizingMode}`);
        if (decision.sizing?.leaderExposureUsd !== undefined) {
          console.log(`Exposure:  $${decision.sizing.leaderExposureUsd.toFixed(2)}`);
        }
        console.log(`Reason:    ${decision.reason}`);

        if (options.dryRun) {
          console.log(chalk.yellow('\n--dry-run: No order executed'));
          return;
        }

        // Execute the follow
        const executeSpinner = ora('Executing follow...').start();

        const order = await followEngine.execute(latestTrade, decision.adjustedAmount, config);

        if (order.status === 'executed') {
          executeSpinner.succeed(`Order executed successfully`);
          console.log(`Order ID:  ${order.id}`);
          console.log(`Status:    ${chalk.green(order.status!)}`);
          if (order.txHash) {
            console.log(`Tx Hash:   ${order.txHash}`);
          }
        } else {
          executeSpinner.fail(`Order failed: ${order.status}`);
        }

      } catch (error) {
        if (jsonOutput) {
          printJsonError('follow_once_failed', error instanceof Error ? error.message : String(error));
          return;
        }
        spinner?.fail(`Failed: ${error instanceof Error ? error.message : error}`);
      }
    });

  // follow orders
  cmd
    .command('orders')
    .description('Show recent orders')
    .option('-n, --limit <n>', 'Number of orders to show', '20')
    .option('-s, --status <status>', 'Filter by status (pending/executed/failed/cancelled)')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const orderRepo = getOrderRepo();
      const limit = parseInt(options.limit);

      const orders = await orderRepo.find(
        options.status ? { status: options.status } : {},
        limit
      );

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('orders', orders, {
          summary: summarizeOrders(orders),
        }));
        return;
      }

      if (orders.length === 0) {
        console.log(chalk.gray('No orders found.'));
        return;
      }

      console.log(chalk.bold('\n📋 Recent Orders\n'));

      const table = new Table({
        head: ['ID', 'Mode', 'Side', 'Req Amt', 'Exec Amt', 'Reconcile', 'Detail'],
        colWidths: [6, 8, 6, 12, 12, 12, 24],
      });

      orders.forEach(order => {
        const statusColor = {
          pending: chalk.yellow,
          executed: chalk.green,
          failed: chalk.red,
          cancelled: chalk.gray,
        }[order.status] ?? chalk.white;

        table.push([
          order.id,
          order.mode,
          order.side.toUpperCase(),
          formatCurrency(order.amountUsd),
          order.executedAmountUsd !== null && order.executedAmountUsd !== undefined
            ? formatCurrency(order.executedAmountUsd)
            : '-',
          order.reconcileStatus ?? 'pending',
          order.reconcileReason ?? order.errorMessage ?? order.txHash ?? new Date(order.createdAt).toLocaleString(),
        ]);
      });

      console.log(table.toString());

      const summary = summarizeOrders(orders);
      console.log(chalk.gray(`\nReturned: ${summary.returned} | Requested amount: ${formatCurrency(summary.requestedAmountUsd)}`));
    });

  cmd
    .command('reconcile')
    .description('Reconcile executed live follow orders against follower trades')
    .option('--address <address>', 'Follower wallet address override')
    .option('--hours <n>', 'Lookback hours', '24')
    .option('-n, --limit <n>', 'Max orders/trades to reconcile', '200')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      try {
        const limit = parsePositiveInt(options.limit, 'limit');
        const hours = parsePositiveInt(options.hours, 'hours');
        const toTimestamp = Date.now();
        const fromTimestamp = toTimestamp - (hours * 60 * 60 * 1000);
        const result = await reconcileFollowOrders({
          followerAddress: options.address,
          fromTimestamp,
          toTimestamp,
          limit,
        });

        if (jsonOutput) {
          printJsonSuccess('follow_reconciled', 'Follow order reconciliation completed.', result);
          return;
        }

        console.log(chalk.bold('\n🔎 Follow Reconciliation\n'));
        console.log(`Follower:        ${result.followerAddress}`);
        console.log(`Window:          ${new Date(result.window.fromTimestamp).toLocaleString()} -> ${new Date(result.window.toTimestamp).toLocaleString()}`);
        console.log(`Scanned Orders:  ${result.summary.scannedOrders}`);
        console.log(`Reconciled:      ${result.summary.reconciledOrders}`);
        console.log(`Matched:         ${result.summary.matched}`);
        console.log(`Drifted:         ${result.summary.drifted}`);
        console.log(`Estimated:       ${result.summary.estimated}`);
        console.log(`Pending:         ${result.summary.pending}`);

        if (result.orders.length > 0) {
          const table = new Table({
            head: ['Order', 'Status', 'Exec Amt', 'Tx', 'Reason'],
            colWidths: [8, 12, 12, 14, 40],
          });

          result.orders.slice(0, 20).forEach((order) => {
            table.push([
              order.orderId,
              order.status,
              order.executedAmountUsd !== null ? formatCurrency(order.executedAmountUsd) : '-',
              order.txHash ? `${order.txHash.slice(0, 10)}...` : '-',
              (order.reason ?? '').slice(0, 38),
            ]);
          });

          console.log(`\n${table.toString()}`);
          if (result.orders.length > 20) {
            console.log(chalk.gray(`Showing first 20 of ${result.orders.length} reconciled orders.`));
          }
        }
      } catch (error) {
        if (jsonOutput) {
          printJsonError('follow_reconcile_failed', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
    });

  // follow positions
  cmd
    .command('positions')
    .description('Show current positions')
    .option('-a, --all', 'Show all positions including closed', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const positionRepo = getPositionRepo();
      const ledgerSummary = await getFollowLedgerSummary();

      const positions = options.all
        ? await positionRepo.find({ leaderAddress: 'self' })
        : await positionRepo.getOpenByLeader('self');
      const enrichedPositions = await enrichPositionsWithLotSummary(positions);

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('positions', enrichedPositions, {
          summary: {
            returned: enrichedPositions.length,
            openPositions: ledgerSummary.openPositions,
            closedPositions: ledgerSummary.closedPositions,
            openLots: ledgerSummary.openLots,
            closedLots: ledgerSummary.closedLots,
            totalLots: ledgerSummary.totalLots,
            totalExposure: ledgerSummary.totalExposure,
            realizedPnl: ledgerSummary.realizedPnl,
          },
        }));
        return;
      }

      if (enrichedPositions.length === 0) {
        console.log(chalk.gray('No positions found.'));
        return;
      }

      console.log(chalk.bold(`\n📊 ${options.all ? 'All' : 'Open'} Positions\n`));

      const table = new Table({
        head: ['Market', 'Side', 'Qty', 'Avg Price', 'Cost', 'Lots', 'Realized', 'Status'],
        colWidths: [24, 6, 10, 12, 12, 10, 12, 10],
      });

      enrichedPositions.forEach(pos => {
        const statusColor = pos.status === 'open' ? chalk.green : chalk.gray;
        table.push([
          (pos.marketTitle || pos.conditionId).slice(0, 22),
          pos.outcome,
          pos.quantity.toFixed(2),
          `$${pos.avgPrice.toFixed(4)}`,
          formatCurrency(pos.costBasis),
          `${pos.lotSummary.openLots}/${pos.lotSummary.totalLots}`,
          formatCurrency(pos.realizedPnl),
          statusColor(pos.status),
        ]);
      });

      console.log(table.toString());

      console.log(chalk.gray(
        `\nOpen positions: ${ledgerSummary.openPositions} | Open lots: ${ledgerSummary.openLots} | Total exposure: ${formatCurrency(ledgerSummary.totalExposure)} | Realized PnL: ${formatCurrency(ledgerSummary.realizedPnl)}`
      ));
    });

  return cmd;
}
