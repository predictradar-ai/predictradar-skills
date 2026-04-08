/**
 * CopyHunter - Watch Engine
 *
 * Polls leader trading activity and saves new events to database
 */

import { getConfig } from '../core/config.js';
import { eventBus } from '../core/events.js';
import { getLeaderRepo, getEventRepo, getDailyStatsRepo, getWatchCursorRepo } from '../db/index.js';
import { getPolymarketCLI } from '../platforms/polymarket/index.js';
import { getPolymarketDataAPI } from '../platforms/polymarket/data-api.js';
import { getLeaderStatsUpdater } from '../analysis/leader-stats-updater.js';
import type { Platform, TradeEvent } from '../core/types.js';
import type { NewEvent } from '../db/schema.js';
import type { WatchCursorState } from '../db/repositories/watch-cursor-repo.js';
import type { FailureInfo } from '../core/failures.js';
import { StructuredFailure, createFailureInfo, toFailureInfo } from '../core/failures.js';
import type { TradeHistoryWindowOptions, TradeHistoryWindowResult } from '../platforms/polymarket/data-api.js';
import { getTradeIdentityKey } from '../core/trade-identity.js';
import type { EventRow } from '../db/schema.js';

export type WatchCatchUpMode = 'normal' | 'high_activity';

export interface WatchEngineOptions {
  interval?: number;
  filterMinUsd?: number;
  maxEventsPerPoll?: number; // Number of trades to request per fetch window expansion
  statsUpdateInterval?: number; // How often to update leader stats (in polls)
  maxTradeHistoryFetch?: number; // Maximum trades to fetch per leader in one poll
  maxCatchUpPasses?: number; // Sequential catch-up batches to process for one leader within a poll
  eventLoopYieldEvery?: number; // Yield to the event loop after emitting this many trades
}

export interface WatchEngineStats {
  isRunning: boolean;
  pollCount: number;
  eventsFound: number;
  eventsSaved: number;
  currentPollStartedAt?: number | null;
  leadersCompletedInPoll: number;
  currentLeaderAddress: string | null;
  currentLeaderStartedAt: number | null;
  currentLeaderPass: number;
  currentLeaderEventsFound: number;
  currentLeaderEventsSaved: number;
  currentLeaderCatchUpBudget: number;
  currentLeaderCatchUpPassLimit: number;
  currentLeaderCatchUpMode: WatchCatchUpMode;
  currentLeaderCursorTimestamp: number | null;
  currentLeaderCursorUpdatedAt: number | null;
  lastPollAt: number | null;
  lastSuccessfulPollAt: number | null;
  errors: number;
  consecutiveErrors: number;
  lastError: FailureInfo | null;
}

export interface WatchTradeSource {
  getTrades(address: string, limit?: number): Promise<TradeEvent[]>;
}

export interface WatchTradeHistorySource {
  getTradesWindow(address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult>;
}

export interface WatchEngineDeps {
  tradeSource?: WatchTradeSource;
  tradeHistorySource?: WatchTradeHistorySource | null;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
  onStatsUpdated?: (stats: WatchEngineStats) => void;
}

interface LeaderCatchUpProfile {
  consecutiveIncompletePolls: number;
  highActivityPolls: number;
  lastBudget: number;
  lastPassLimit: number;
  lastMode: WatchCatchUpMode;
}

interface CatchUpPlan {
  budget: number;
  passLimit: number;
  mode: WatchCatchUpMode;
}

interface CatchUpHardCaps {
  budgetCap: number;
  passCap: number;
}

export class WatchEngine {
  private running = false;
  private intervalId: NodeJS.Timeout | null = null;
  private activePoll: Promise<TradeEvent[]> | null = null;
  private stats: WatchEngineStats = {
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

  private options: Required<WatchEngineOptions>;
  private tradeSource: WatchTradeSource;
  private tradeHistorySource: WatchTradeHistorySource | null;
  private now: () => number;
  private yieldToEventLoop: () => Promise<void>;
  private onStatsUpdated?: (stats: WatchEngineStats) => void;
  private leaderCatchUpProfiles = new Map<string, LeaderCatchUpProfile>();

  constructor(options: WatchEngineOptions = {}, deps: WatchEngineDeps = {}) {
    const config = getConfig();
    const maxEventsPerPoll = options.maxEventsPerPoll ?? 50;
    this.options = {
      interval: options.interval ?? config.watch.interval,
      filterMinUsd: options.filterMinUsd ?? config.watch.filterMinUsd,
      maxEventsPerPoll,
      statsUpdateInterval: options.statsUpdateInterval ?? 10, // Update stats every 10 polls
      maxTradeHistoryFetch: options.maxTradeHistoryFetch ?? maxEventsPerPoll * 10,
      maxCatchUpPasses: options.maxCatchUpPasses ?? 3,
      eventLoopYieldEvery: Math.max(1, options.eventLoopYieldEvery ?? 100),
    };
    this.tradeSource = deps.tradeSource ?? getPolymarketCLI();
    this.tradeHistorySource = deps.tradeHistorySource === undefined
      ? getPolymarketDataAPI()
      : deps.tradeHistorySource;
    this.now = deps.now ?? Date.now;
    this.yieldToEventLoop = deps.yieldToEventLoop ?? (() => new Promise((resolve) => setImmediate(resolve)));
    this.onStatsUpdated = deps.onStatsUpdated;
  }

  private emitStatsUpdated(): void {
    this.onStatsUpdated?.(this.getStats());
  }

  private resetCurrentLeaderStats(): void {
    this.stats.currentLeaderAddress = null;
    this.stats.currentLeaderStartedAt = null;
    this.stats.currentLeaderPass = 0;
    this.stats.currentLeaderEventsFound = 0;
    this.stats.currentLeaderEventsSaved = 0;
    this.stats.currentLeaderCatchUpBudget = 0;
    this.stats.currentLeaderCatchUpPassLimit = 0;
    this.stats.currentLeaderCatchUpMode = 'normal';
    this.stats.currentLeaderCursorTimestamp = null;
    this.stats.currentLeaderCursorUpdatedAt = null;
  }

  private setCurrentLeaderCursor(cursor: WatchCursorState | undefined): void {
    this.stats.currentLeaderCursorTimestamp = cursor?.cursorTimestamp ?? null;
    this.stats.currentLeaderCursorUpdatedAt = cursor?.updatedAt ?? null;
  }

  private applyCatchUpPlan(plan: CatchUpPlan): void {
    this.stats.currentLeaderCatchUpBudget = plan.budget;
    this.stats.currentLeaderCatchUpPassLimit = plan.passLimit;
    this.stats.currentLeaderCatchUpMode = plan.mode;
  }

  private getLeaderCatchUpProfile(address: string): LeaderCatchUpProfile {
    const normalizedAddress = address.toLowerCase();
    const existing = this.leaderCatchUpProfiles.get(normalizedAddress);
    if (existing) {
      return existing;
    }

    const profile: LeaderCatchUpProfile = {
      consecutiveIncompletePolls: 0,
      highActivityPolls: 0,
      lastBudget: Math.max(1, this.options.maxTradeHistoryFetch),
      lastPassLimit: Math.max(1, this.options.maxCatchUpPasses),
      lastMode: 'normal',
    };
    this.leaderCatchUpProfiles.set(normalizedAddress, profile);
    return profile;
  }

  private getCatchUpHardCaps(baseBudget: number, basePassLimit: number): CatchUpHardCaps {
    return {
      budgetCap: Math.max(baseBudget, Math.min(Math.max(baseBudget * 120, 20_000), 250_000)),
      passCap: Math.max(basePassLimit, Math.min(basePassLimit + 44, 48)),
    };
  }

  private buildCatchUpPlan(address: string, cursor: WatchCursorState | undefined): CatchUpPlan {
    const baseLimit = Math.max(1, this.options.maxEventsPerPoll);
    const baseBudget = Math.max(baseLimit, this.options.maxTradeHistoryFetch);
    const basePassLimit = Math.max(1, this.options.maxCatchUpPasses);
    const profile = this.getLeaderCatchUpProfile(address);
    const lagMs = cursor?.cursorTimestamp ? Math.max(0, this.now() - cursor.cursorTimestamp) : 0;
    const lagDrivenHighActivity = lagMs >= 60_000;
    const hasEstablishedHighActivity = lagDrivenHighActivity
      || profile.consecutiveIncompletePolls > 0
      || profile.highActivityPolls > 0;
    const { budgetCap: hardBudgetCap, passCap: hardPassCap } = this.getCatchUpHardCaps(baseBudget, basePassLimit);
    const lagMultiplier = hasEstablishedHighActivity
      ? (
          lagMs >= 30 * 60_000
            ? 24
            : lagMs >= 10 * 60_000
              ? 16
              : lagMs >= 5 * 60_000
                ? 10
                : lagMs >= 2 * 60_000
                  ? 6
                  : lagMs >= 60_000
                    ? 3
                    : 1
        )
      : (
          lagMs >= 10 * 60_000
            ? 8
            : lagMs >= 5 * 60_000
              ? 6
              : lagMs >= 2 * 60_000
                ? 4
                : lagMs >= 60_000
                  ? 2
                  : 1
        );
    const incompleteMultiplier = 1 + Math.min(profile.consecutiveIncompletePolls * 2, 10);
    const highActivityMultiplier = 1 + Math.min(profile.highActivityPolls * 2, 8);
    const reusePreviousMultiplier = profile.lastBudget > baseBudget
      ? Math.min(32, Math.ceil(profile.lastBudget / baseBudget))
      : 1;
    let budget = Math.max(
      baseBudget,
      baseBudget * lagMultiplier,
      baseBudget * incompleteMultiplier,
      baseBudget * highActivityMultiplier,
      baseBudget * reusePreviousMultiplier
    );
    let mode: WatchCatchUpMode = 'normal';

    if (hasEstablishedHighActivity) {
      mode = 'high_activity';
      budget = Math.max(
        budget,
        Math.min(Math.max(baseBudget * 12, baseLimit * 200), hardBudgetCap)
      );
    }

    const passLimit = Math.min(
      hardPassCap,
      basePassLimit
        + Math.min(profile.consecutiveIncompletePolls * 4, 16)
        + Math.min(profile.highActivityPolls * 4, 12)
        + (lagDrivenHighActivity ? 8 : 0)
    );

    return {
      budget: Math.min(hardBudgetCap, Math.max(baseBudget, budget)),
      passLimit,
      mode,
    };
  }

  private maybeEscalateCatchUpPlan(
    currentPlan: CatchUpPlan,
    context: {
      tradesFetched: number;
      newTradesCount: number;
      gapDetected: boolean;
    }
  ): CatchUpPlan {
    if (!context.gapDetected) {
      return currentPlan;
    }

    const baseLimit = Math.max(1, this.options.maxEventsPerPoll);
    const baseBudget = Math.max(baseLimit, this.options.maxTradeHistoryFetch);
    const { budgetCap: hardBudgetCap, passCap: hardPassCap } = this.getCatchUpHardCaps(
      baseBudget,
      Math.max(1, this.options.maxCatchUpPasses)
    );
    const stuckGap = context.newTradesCount === 0;
    const nearBudget = context.tradesFetched >= Math.max(baseLimit, Math.floor(currentPlan.budget * 0.7));
    const heavyNewTrades = context.newTradesCount >= Math.max(baseLimit, Math.floor(currentPlan.budget * 0.5));
    const leaderPollAgeMs = this.stats.currentLeaderStartedAt === null
      ? 0
      : Math.max(0, this.now() - this.stats.currentLeaderStartedAt);
    const severeBacklog = leaderPollAgeMs >= Math.max(Math.floor(this.options.interval / 2), 15_000)
      || this.stats.currentLeaderPass >= Math.max(2, currentPlan.passLimit - 2);
    const growthFactor = severeBacklog ? 4 : 3;
    const additiveBoost = severeBacklog ? baseBudget * 12 : baseBudget * 6;
    const nextBudget = nearBudget || heavyNewTrades || stuckGap
      ? Math.min(
          hardBudgetCap,
          Math.max(currentPlan.budget + additiveBoost, Math.ceil(currentPlan.budget * growthFactor))
        )
      : currentPlan.budget;
    const nextPassLimit = severeBacklog
      ? Math.max(currentPlan.passLimit + 4, this.stats.currentLeaderPass + 4)
      : Math.max(currentPlan.passLimit + 2, this.stats.currentLeaderPass + 2);

    return {
      budget: nextBudget,
      passLimit: Math.min(hardPassCap, nextPassLimit),
      mode: 'high_activity',
    };
  }

  private updateLeaderCatchUpProfile(
    address: string,
    summary: {
      gapDetected: boolean;
      budget: number;
      passLimit: number;
      mode: WatchCatchUpMode;
    }
  ): void {
    const normalizedAddress = address.toLowerCase();
    const profile = this.getLeaderCatchUpProfile(normalizedAddress);

    profile.consecutiveIncompletePolls = summary.gapDetected
      ? profile.consecutiveIncompletePolls + 1
      : 0;
    profile.highActivityPolls = summary.mode === 'high_activity'
      ? Math.min(profile.highActivityPolls + 1, 4)
      : Math.max(profile.highActivityPolls - 1, 0);
    profile.lastBudget = summary.budget;
    profile.lastPassLimit = summary.passLimit;
    profile.lastMode = summary.mode;

    this.leaderCatchUpProfiles.set(normalizedAddress, profile);
  }

  /**
   * Start the watch engine
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    const leaderRepo = getLeaderRepo();
    const leaders = await leaderRepo.getAll();

    if (leaders.length === 0) {
      throw new Error('No leaders to monitor. Add some first with: copyhunter leaders add');
    }

    this.running = true;
    this.stats.isRunning = true;
    this.emitStatsUpdated();

    eventBus.emit('watch:started', { leadersCount: leaders.length });

    // Initial poll
    await this.poll();

    // Set up interval
    this.intervalId = setInterval(() => {
      this.poll().catch((err) => {
        this.stats.errors++;
        this.stats.consecutiveErrors++;
        const detail = this.recordError(err, {
          operation: 'poll_interval',
        });
        eventBus.emit('watch:error', { error: this.toError(err), detail });
      });
    }, this.options.interval);
  }

  /**
   * Stop the watch engine
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.running = false;
    this.stats.isRunning = false;
    this.emitStatsUpdated();

    eventBus.emit('watch:stopped', {});
  }

  async waitForIdle(): Promise<void> {
    try {
      await this.activePoll;
    } catch {
      // Poll errors are already recorded in engine stats and event bus.
    }
  }

  /**
   * Poll for new trades from all leaders
   */
  async poll(): Promise<TradeEvent[]> {
    if (this.activePoll) {
      return this.activePoll;
    }

    this.stats.currentPollStartedAt = Date.now();
    this.stats.leadersCompletedInPoll = 0;
    this.resetCurrentLeaderStats();
    this.emitStatsUpdated();
    const task = this.runPoll();
    this.activePoll = task;
    void task.finally(() => {
      this.stats.currentPollStartedAt = null;
      this.resetCurrentLeaderStats();
      if (this.activePoll === task) {
        this.activePoll = null;
      }
      this.emitStatsUpdated();
    });

    return task;
  }

  private async runPoll(): Promise<TradeEvent[]> {
    const leaderRepo = getLeaderRepo();
    const eventRepo = getEventRepo();
    const statsRepo = getDailyStatsRepo();
    const cursorRepo = getWatchCursorRepo();

    const leaders = await leaderRepo.getActive();
    const allNewEvents: TradeEvent[] = [];
    let pollHadErrors = false;

    this.stats.pollCount++;
    this.emitStatsUpdated();
    eventBus.emit('watch:poll', { count: this.stats.pollCount });

    for (const leader of leaders) {
      this.stats.currentLeaderAddress = leader.address;
      this.stats.currentLeaderStartedAt = this.now();
      this.stats.currentLeaderPass = 0;
      this.stats.currentLeaderEventsFound = 0;
      this.stats.currentLeaderEventsSaved = 0;
      this.stats.currentLeaderCatchUpBudget = 0;
      this.stats.currentLeaderCatchUpPassLimit = 0;
      this.stats.currentLeaderCatchUpMode = 'normal';
      this.stats.currentLeaderCursorTimestamp = null;
      this.stats.currentLeaderCursorUpdatedAt = null;
      this.emitStatsUpdated();
      try {
        const { cursor: effectiveCursor } = await this.ensureCursorMatchesLocalHistory(leader.address, cursorRepo);
        this.setCurrentLeaderCursor(effectiveCursor);
        this.emitStatsUpdated();
        const result = await this.captureLeaderTrades(leader.address, effectiveCursor, cursorRepo);
        allNewEvents.push(...result.savedTrades);
        await statsRepo.incrementEventsCaptured(result.newTradesCount);

        if (result.latestTradeTimestamp !== null) {
          await leaderRepo.updateStats(leader.address, {
            totalTrades: leader.totalTrades + result.filteredTradesCount,
            winRate: leader.winRate,
            totalPnl: leader.totalPnl,
            lastTradeAt: result.latestTradeTimestamp,
          });
        }

        if (result.gapDetected) {
          const error = new StructuredFailure(createFailureInfo({
            code: 'runtime_error',
            source: 'watch_engine',
            operation: 'poll_leader',
            message: `Trade history catch-up remained incomplete for ${leader.address}. Increase catch-up budget or passes to avoid missing fills.`,
            retryable: false,
            details: {
              leaderAddress: leader.address,
              catchUpPasses: this.stats.currentLeaderCatchUpPassLimit || this.options.maxCatchUpPasses,
              catchUpBudget: this.stats.currentLeaderCatchUpBudget || this.options.maxTradeHistoryFetch,
              catchUpMode: this.stats.currentLeaderCatchUpMode,
            },
          }));
          const detail = this.recordError(error, {
            operation: 'poll_leader',
            leaderAddress: leader.address,
          });
          eventBus.emit('watch:error', {
            error,
            detail,
          });
        }
        this.stats.leadersCompletedInPoll += 1;
        this.emitStatsUpdated();
      } catch (error) {
        pollHadErrors = true;
        this.stats.errors++;
        const detail = this.recordError(error, {
          operation: 'poll_leader',
          leaderAddress: leader.address,
        });
        eventBus.emit('watch:error', {
          error: this.toError(error),
          detail,
        });
      } finally {
        this.resetCurrentLeaderStats();
        this.emitStatsUpdated();
      }
    }

    this.stats.lastPollAt = Date.now();
    this.stats.consecutiveErrors = pollHadErrors
      ? this.stats.consecutiveErrors + 1
      : 0;
    if (!pollHadErrors) {
      this.stats.lastSuccessfulPollAt = this.stats.lastPollAt;
      this.emitStatsUpdated();
      eventBus.emit('watch:healthy', {
        pollCount: this.stats.pollCount,
        lastSuccessfulPollAt: this.stats.lastSuccessfulPollAt,
        consecutiveErrors: this.stats.consecutiveErrors,
      });
    } else {
      this.emitStatsUpdated();
    }

    // Periodically update leader stats (winRate, totalPnl)
    if (this.stats.pollCount % this.options.statsUpdateInterval === 0) {
      this.updateLeaderStats().catch((err) => {
        const detail = this.recordError(err, {
          operation: 'update_leader_stats',
        });
        eventBus.emit('watch:error', {
          error: this.toError(err),
          detail,
        });
      });
    }

    return allNewEvents;
  }

  /**
   * Update leader stats from closed positions
   */
  private async updateLeaderStats(): Promise<void> {
    const statsUpdater = getLeaderStatsUpdater();
    const results = await statsUpdater.updateAll();

    const updated = results.filter(r => r.updated).length;
    const errors = results.filter(r => r.error).length;

    if (updated > 0 || errors > 0) {
      eventBus.emit('stats:batch_updated', { updated, errors });
    }
  }

  /**
   * Poll a single leader
   */
  async pollLeader(address: string): Promise<TradeEvent[]> {
    const cursorRepo = getWatchCursorRepo();
    const { cursor } = await this.ensureCursorMatchesLocalHistory(address, cursorRepo);
    const result = await this.captureLeaderTrades(address, cursor, cursorRepo);
    return result.savedTrades;
  }

  /**
   * Get current stats
   */
  getStats(): WatchEngineStats {
    return { ...this.stats };
  }

  /**
   * Check if engine is running
   */
  isRunning(): boolean {
    return this.running;
  }

  hasActivePoll(): boolean {
    return this.activePoll !== null;
  }

  /**
   * Update options
   */
  updateOptions(options: Partial<WatchEngineOptions>): void {
    this.options = { ...this.options, ...options };

    // Restart interval if running
    if (this.running && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        this.poll().catch((err) => {
          this.stats.errors++;
          this.stats.consecutiveErrors++;
          const detail = this.recordError(err, {
            operation: 'poll_interval',
          });
          eventBus.emit('watch:error', { error: this.toError(err), detail });
        });
      }, this.options.interval);
    }
  }

  private recordError(
    error: unknown,
    context: { operation: string; leaderAddress?: string }
  ): FailureInfo {
    const detail = toFailureInfo(error, {
      code: 'runtime_error',
      source: 'watch_engine',
      operation: context.operation,
      retryable: true,
      details: context.leaderAddress ? { leaderAddress: context.leaderAddress } : undefined,
    });

    this.stats.lastError = context.leaderAddress
      ? {
          ...detail,
          details: {
            ...detail.details,
            leaderAddress: context.leaderAddress,
          },
        }
      : detail;

    return this.stats.lastError;
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }

  private normalizeTrades(trades: TradeEvent[]): TradeEvent[] {
    const uniqueTrades = new Map<string, TradeEvent>();

    for (const trade of trades) {
      const normalizedTrade: TradeEvent = {
        ...trade,
        leaderAddress: trade.leaderAddress.toLowerCase(),
        txHash: trade.txHash?.toLowerCase(),
      };
      uniqueTrades.set(this.getTradeKey(normalizedTrade), normalizedTrade);
    }

    return [...uniqueTrades.values()].sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return this.getTradeKey(a).localeCompare(this.getTradeKey(b));
    });
  }

  private getTradeKey(trade: TradeEvent): string {
    return getTradeIdentityKey(trade);
  }

  private async persistNewTrades(
    trades: TradeEvent[]
  ): Promise<{ savedTrades: TradeEvent[]; confirmedTrades: TradeEvent[] }> {
    const eventRepo = getEventRepo();
    const savedTrades: TradeEvent[] = [];
    const confirmedTrades: TradeEvent[] = [];
    const existingKeys = await eventRepo.findExistingTradeKeys(trades);
    const newEvents: NewEvent[] = [];

    for (const trade of trades) {
      if (existingKeys.has(this.getTradeKey(trade))) {
        continue;
      }

      newEvents.push({
        leaderAddress: trade.leaderAddress.toLowerCase(),
        platform: trade.platform,
        eventType: trade.eventType,
        conditionId: trade.conditionId,
        marketSlug: trade.marketSlug,
        marketTitle: trade.marketTitle,
        outcome: trade.outcome,
        price: trade.price,
        quantity: trade.quantity,
        amountUsd: trade.amountUsd,
        txHash: trade.txHash,
        timestamp: trade.timestamp,
        followed: 0,
        createdAt: this.now(),
      });
    }

    const savedEventByTradeKey = new Map<string, EventRow>();
    if (newEvents.length > 0) {
      const savedEvents = await eventRepo.saveBatch(newEvents);
      this.stats.eventsSaved += savedEvents.length;

      for (const savedEvent of savedEvents) {
        savedEventByTradeKey.set(this.getTradeKey({
          leaderAddress: savedEvent.leaderAddress,
          platform: savedEvent.platform as Platform,
          eventType: savedEvent.eventType as 'BUY' | 'SELL',
          conditionId: savedEvent.conditionId,
          marketSlug: savedEvent.marketSlug ?? undefined,
          marketTitle: savedEvent.marketTitle ?? undefined,
          outcome: savedEvent.outcome ?? undefined,
          price: savedEvent.price,
          quantity: savedEvent.quantity,
          amountUsd: savedEvent.amountUsd,
          txHash: savedEvent.txHash ?? undefined,
          timestamp: savedEvent.timestamp,
          followed: !!savedEvent.followed,
          createdAt: savedEvent.createdAt,
          id: savedEvent.id,
        }), savedEvent);
      }
    }

    for (const trade of trades) {
      const tradeKey = this.getTradeKey(trade);
      if (existingKeys.has(tradeKey)) {
        confirmedTrades.push(trade);
        continue;
      }

      const savedEvent = savedEventByTradeKey.get(tradeKey);
      if (!savedEvent) {
        throw new Error(`Saved event missing for trade ${tradeKey}`);
      }

      const emittedTrade: TradeEvent = {
        ...trade,
        id: savedEvent.id,
        followed: !!savedEvent.followed,
        createdAt: savedEvent.createdAt,
      };

      confirmedTrades.push(emittedTrade);
      savedTrades.push(emittedTrade);
    }

    return { savedTrades, confirmedTrades };
  }

  private async emitPersistedTrades(trades: TradeEvent[]): Promise<void> {
    let emittedCount = 0;

    for (const trade of trades) {
      eventBus.emit('trade:detected', { event: trade });
      if (trade.amountUsd >= this.options.filterMinUsd) {
        eventBus.emit('trade:new', { event: trade, isNew: true });
      } else {
        eventBus.emit('trade:filtered', {
          event: trade,
          reason: `Amount $${trade.amountUsd} below minimum $${this.options.filterMinUsd}`,
        });
      }

      emittedCount += 1;
      if (emittedCount % this.options.eventLoopYieldEvery === 0) {
        await this.yieldToEventLoop();
      }
    }
  }

  private hasReachedCursor(trades: TradeEvent[], cursor?: WatchCursorState): boolean {
    const cursorTimestamp = cursor?.cursorTimestamp ?? null;
    if (cursorTimestamp === null) {
      return false;
    }

    const cursorTradeKeys = new Set(cursor?.cursorTradeKeys ?? []);

    return trades.some((trade) => {
      if (trade.timestamp < cursorTimestamp) {
        return true;
      }

      return trade.timestamp === cursorTimestamp
        && cursorTradeKeys.has(this.getTradeKey(trade));
    });
  }

  private getNewTrades(trades: TradeEvent[], cursor?: WatchCursorState): TradeEvent[] {
    if (!cursor?.cursorTimestamp) {
      return [...trades].sort((a, b) => a.timestamp - b.timestamp);
    }

    const cursorTradeKeys = new Set(cursor.cursorTradeKeys);

    return trades
      .filter((trade) => {
        if (trade.timestamp > cursor.cursorTimestamp!) {
          return true;
        }

        return trade.timestamp === cursor.cursorTimestamp
          && !cursorTradeKeys.has(this.getTradeKey(trade));
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private getNextCursorState(
    trades: TradeEvent[],
    previousCursor?: WatchCursorState
  ): Pick<WatchCursorState, 'platform' | 'cursorTimestamp' | 'cursorTradeKeys'> {
    const latestTimestamp = trades.length > 0
      ? trades.reduce((maxTimestamp, trade) => Math.max(maxTimestamp, trade.timestamp), Number.NEGATIVE_INFINITY)
      : (previousCursor?.cursorTimestamp ?? null);

    if (!latestTimestamp) {
      return {
        platform: previousCursor?.platform ?? 'polymarket',
        cursorTimestamp: null,
        cursorTradeKeys: [],
      };
    }

    const latestTradeKeys = trades
      .filter((trade) => trade.timestamp === latestTimestamp)
      .map((trade) => this.getTradeKey(trade));

    const mergedTradeKeys = previousCursor?.cursorTimestamp === latestTimestamp
      ? [...new Set([...previousCursor.cursorTradeKeys, ...latestTradeKeys])]
      : [...new Set(latestTradeKeys)];

    return {
      platform: trades.find((trade) => trade.timestamp === latestTimestamp)?.platform
        ?? previousCursor?.platform
        ?? 'polymarket',
      cursorTimestamp: latestTimestamp,
      cursorTradeKeys: mergedTradeKeys,
    };
  }

  private async ensureCursorMatchesLocalHistory(
    address: string,
    cursorRepo = getWatchCursorRepo()
  ): Promise<{ cursor: WatchCursorState | undefined; corrected: boolean }> {
    const eventRepo = getEventRepo();
    const persistedCursor = await cursorRepo.getByLeader(address);
    const localFrontier = await eventRepo.getLatestCursorSnapshot(address);
    const effectiveCursor = this.reconcileCursorWithLocalHistory(address, persistedCursor, localFrontier);

    if (this.isCursorStateEqual(persistedCursor, effectiveCursor)) {
      return {
        cursor: effectiveCursor,
        corrected: false,
      };
    }

    if (!effectiveCursor) {
      if (persistedCursor) {
        await cursorRepo.clear(address);
      }
      return {
        cursor: undefined,
        corrected: true,
      };
    }

    await cursorRepo.upsert({
      leaderAddress: address,
      platform: effectiveCursor.platform,
      cursorTimestamp: effectiveCursor.cursorTimestamp,
      cursorTradeKeys: effectiveCursor.cursorTradeKeys,
    });

    return {
      cursor: effectiveCursor,
      corrected: true,
    };
  }

  private reconcileCursorWithLocalHistory(
    address: string,
    cursor: WatchCursorState | null | undefined,
    localFrontier: { cursorTimestamp: number | null; cursorTradeKeys: string[] }
  ): WatchCursorState | undefined {
    if (localFrontier.cursorTimestamp === null) {
      return cursor?.cursorTimestamp === null
        ? {
            ...cursor,
            cursorTradeKeys: [],
          }
        : undefined;
    }

    return {
      leaderAddress: address.toLowerCase(),
      platform: cursor?.platform ?? 'polymarket',
      cursorTimestamp: localFrontier.cursorTimestamp,
      cursorTradeKeys: [...localFrontier.cursorTradeKeys],
      updatedAt: cursor?.updatedAt ?? this.now(),
    };
  }

  private isCursorStateEqual(
    left: WatchCursorState | null | undefined,
    right: WatchCursorState | null | undefined
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    if (
      left.leaderAddress !== right.leaderAddress
      || left.platform !== right.platform
      || left.cursorTimestamp !== right.cursorTimestamp
      || left.cursorTradeKeys.length !== right.cursorTradeKeys.length
    ) {
      return false;
    }

    return left.cursorTradeKeys.every((key, index) => key === right.cursorTradeKeys[index]);
  }

  private async captureLeaderTrades(
    address: string,
    initialCursor: WatchCursorState | undefined,
    cursorRepo = getWatchCursorRepo()
  ): Promise<{
    savedTrades: TradeEvent[];
    newTradesCount: number;
    filteredTradesCount: number;
    latestTradeTimestamp: number | null;
    gapDetected: boolean;
  }> {
    let cursor = initialCursor;
    let gapDetected = false;
    let latestTradeTimestamp: number | null = null;
    let newTradesCount = 0;
    let filteredTradesCount = 0;
    const savedTrades: TradeEvent[] = [];
    let plan = this.buildCatchUpPlan(address, cursor);
    let pass = 0;

    this.applyCatchUpPlan(plan);
    this.setCurrentLeaderCursor(cursor);
    this.emitStatsUpdated();

    while (pass < plan.passLimit) {
      this.stats.currentLeaderPass = pass + 1;
      this.emitStatsUpdated();
      const { trades, gapDetected: batchGapDetected } = await this.fetchTradesForLeader(address, cursor, plan.budget);
      if (trades.length > 0) {
        latestTradeTimestamp = latestTradeTimestamp === null
          ? trades[0].timestamp
          : Math.max(latestTradeTimestamp, trades[0].timestamp);
      }

      const newTrades = this.getNewTrades(trades, cursor);
      if (newTrades.length === 0) {
        gapDetected = batchGapDetected;
        if (batchGapDetected) {
          const nextPlan = this.maybeEscalateCatchUpPlan(plan, {
            tradesFetched: trades.length,
            newTradesCount: 0,
            gapDetected: batchGapDetected,
          });
          const shouldRetryWithinPoll = nextPlan.budget > plan.budget || nextPlan.passLimit > plan.passLimit;
          plan = nextPlan;
          this.applyCatchUpPlan(plan);
          this.emitStatsUpdated();
          if (shouldRetryWithinPoll) {
            pass += 1;
            continue;
          }
        }
        break;
      }

      newTradesCount += newTrades.length;
      this.stats.eventsFound += newTrades.length;
      this.stats.currentLeaderEventsFound += newTrades.length;
      filteredTradesCount += newTrades.filter((trade) => trade.amountUsd >= this.options.filterMinUsd).length;
      this.emitStatsUpdated();

      const persisted = await this.persistNewTrades(newTrades);
      savedTrades.push(...persisted.savedTrades);
      this.stats.currentLeaderEventsSaved += persisted.savedTrades.length;
      this.emitStatsUpdated();

      if (persisted.confirmedTrades.length === 0) {
        gapDetected = batchGapDetected;
        this.emitStatsUpdated();
        break;
      }

      const nextCursorState = this.getNextCursorState(persisted.confirmedTrades, cursor);
      await cursorRepo.upsert({
        leaderAddress: address,
        ...nextCursorState,
      });
      cursor = {
        leaderAddress: address.toLowerCase(),
        updatedAt: this.now(),
        ...nextCursorState,
      };
      this.setCurrentLeaderCursor(cursor);
      this.emitStatsUpdated();
      await this.emitPersistedTrades(persisted.savedTrades);

      gapDetected = batchGapDetected;
      if (!batchGapDetected) {
        this.emitStatsUpdated();
        break;
      }

      plan = this.maybeEscalateCatchUpPlan(plan, {
        tradesFetched: trades.length,
        newTradesCount: newTrades.length,
        gapDetected: batchGapDetected,
      });
      this.applyCatchUpPlan(plan);
      this.emitStatsUpdated();
      pass += 1;
    }

    this.updateLeaderCatchUpProfile(address, {
      gapDetected,
      budget: plan.budget,
      passLimit: plan.passLimit,
      mode: plan.mode,
    });

    return {
      savedTrades,
      newTradesCount,
      filteredTradesCount,
      latestTradeTimestamp,
      gapDetected,
    };
  }

  private async fetchTradesForLeader(
    address: string,
    cursor?: WatchCursorState,
    historyFetchBudget = this.options.maxTradeHistoryFetch
  ): Promise<{ trades: TradeEvent[]; gapDetected: boolean }> {
    if (cursor?.cursorTimestamp && this.tradeHistorySource) {
      try {
        return await this.fetchTradesForLeaderFromHistory(address, cursor, historyFetchBudget);
      } catch {
        // Fall back to recent-trade expansion when the paginated history source is unavailable.
      }
    }

    return this.fetchTradesForLeaderFromRecent(address, cursor, historyFetchBudget);
  }

  private async fetchTradesForLeaderFromHistory(
    address: string,
    cursor: WatchCursorState,
    historyFetchBudget: number
  ): Promise<{ trades: TradeEvent[]; gapDetected: boolean }> {
    const tradeHistorySource = this.tradeHistorySource;
    const cursorTimestamp = cursor.cursorTimestamp;
    if (!tradeHistorySource || cursorTimestamp === null) {
      throw new Error('Trade history source or cursor timestamp unavailable.');
    }
    const requestedToTimestamp = this.now();
    const baseLimit = Math.max(1, this.options.maxEventsPerPoll);
    const effectiveHistoryFetchBudget = Math.max(baseLimit, historyFetchBudget);
    const historyPageLimit = Math.min(
      1000,
      Math.max(baseLimit, Math.min(effectiveHistoryFetchBudget, 1000))
    );
    const maxPages = Math.max(1, Math.ceil(effectiveHistoryFetchBudget / historyPageLimit));
    const history = await tradeHistorySource.getTradesWindow(address, {
      fromTimestamp: cursorTimestamp,
      toTimestamp: requestedToTimestamp,
      pageLimit: historyPageLimit,
      maxPages,
      anchor: 'from',
    });
    const trades = this.normalizeTrades(history.trades);
    const latestTimestamp = trades[0]?.timestamp ?? null;
    const oldestTimestamp = trades[trades.length - 1]?.timestamp ?? null;
    const gapDetected = !!(
      (history.apiOffsetCapReached
        && oldestTimestamp !== null
        && oldestTimestamp > cursorTimestamp)
      || (!history.windowComplete
        && latestTimestamp !== null
        && latestTimestamp < requestedToTimestamp)
    );

    return { trades, gapDetected };
  }

  private async fetchTradesForLeaderFromRecent(
    address: string,
    cursor?: WatchCursorState,
    historyFetchBudget = this.options.maxTradeHistoryFetch
  ): Promise<{ trades: TradeEvent[]; gapDetected: boolean }> {
    const baseLimit = Math.max(1, this.options.maxEventsPerPoll);
    const maxLimit = Math.max(baseLimit, historyFetchBudget);
    const cursorTimestamp = cursor?.cursorTimestamp ?? null;
    let limit = baseLimit;
    let trades: TradeEvent[] = [];
    let reachedCursor = false;

    while (limit <= maxLimit) {
      trades = this.normalizeTrades(await this.tradeSource.getTrades(address, limit));

      if (!cursor?.cursorTimestamp) {
        if (trades.length < limit || limit === maxLimit) {
          break;
        }
      } else {
        reachedCursor = this.hasReachedCursor(trades, cursor);
        if (reachedCursor || trades.length < limit || limit === maxLimit) {
          break;
        }
      }

      limit = Math.min(limit + baseLimit, maxLimit);
    }

    const oldestTimestamp = trades[trades.length - 1]?.timestamp ?? null;
    const gapDetected = !!(
      cursorTimestamp !== null
      && trades.length > 0
      && !reachedCursor
      && trades.length >= maxLimit
      && oldestTimestamp !== null
      && oldestTimestamp >= cursorTimestamp
    );

    return { trades, gapDetected };
  }
}

// Singleton
let watchEngine: WatchEngine | null = null;

export function getWatchEngine(options?: WatchEngineOptions): WatchEngine {
  if (!watchEngine) {
    watchEngine = new WatchEngine(options);
  }
  return watchEngine;
}
