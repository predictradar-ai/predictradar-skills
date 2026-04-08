/**
 * CopyHunter - Follow Engine
 *
 * Copy trading engine that evaluates and executes trades based on leader activity
 */

import { getConfig } from '../core/config.js';
import { eventBus } from '../core/events.js';
import type { TradeEvent, Order, AppConfig, FollowSizingMode } from '../core/types.js';
import {
  getDailyStatsRepo,
  getEventRepo,
  getOrderRepo,
  getPositionLotRepo,
  getPositionRepo,
} from '../db/index.js';
import { getPolymarketAdapter } from '../platforms/polymarket/index.js';
import type { NewOrder } from '../db/schema.js';
import type { FailureInfo } from '../core/failures.js';
import { toFailureInfo } from '../core/failures.js';
import { reconcileFollowExecution } from './reconciliation.js';
import {
  buildStoredFollowOutcomeReason,
  classifyFollowErrorCategory,
  type FollowOutcomeCategory,
} from './outcome-reason.js';

export interface FollowSizingDetails {
  mode: FollowSizingMode;
  source: 'config' | 'override';
  leaderTradeAmountUsd: number;
  uncappedAmountUsd: number;
  adjustedAmountUsd: number;
  maxPerTradeUsd: number;
  bankrollUsd?: number;
  leaderExposureUsd?: number;
  ratio?: number;
}

export interface FollowDecision {
  shouldFollow: boolean;
  reason: string;
  category?: FollowOutcomeCategory;
  adjustedAmount?: number;
  sizing?: FollowSizingDetails;
}

export interface FollowEngineStats {
  eventsEnqueued: number;
  eventsEvaluated: number;
  eventsFollowed: number;
  eventsSkipped: number;
  ordersExecuted: number;
  ordersFailed: number;
  totalAmountUsd: number;
  queueDepth: number;
  maxQueueDepth: number;
  lastEvaluatedAt: number | null;
  lastDecisionAt: number | null;
  lastDecisionReason: string | null;
  lastDecisionShouldFollow: boolean | null;
  lastExecutedAt: number | null;
  lastSkippedAt: number | null;
  lastError: FailureInfo | null;
}

export interface FollowEngineOptions {
  maxConcurrentEvents?: number;
}

interface QueuedTradeEvent {
  payload: { event: TradeEvent; isNew: boolean };
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface RiskReservation {
  amountUsd: number;
  positionReservationKey: string | null;
}

class FollowDecisionSkipError extends Error {
  readonly decision: FollowDecision;

  constructor(decision: FollowDecision) {
    super(decision.reason);
    this.name = 'FollowDecisionSkipError';
    this.decision = decision;
  }
}

export class FollowEngine {
  private stats: FollowEngineStats = {
    eventsEnqueued: 0,
    eventsEvaluated: 0,
    eventsFollowed: 0,
    eventsSkipped: 0,
    ordersExecuted: 0,
    ordersFailed: 0,
    totalAmountUsd: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    lastEvaluatedAt: null,
    lastDecisionAt: null,
    lastDecisionReason: null,
    lastDecisionShouldFollow: null,
    lastExecutedAt: null,
    lastSkippedAt: null,
    lastError: null,
  };

  private listening = false;
  private readonly tradeEventHandler = this.handleTradeEvent.bind(this);
  private readonly maxConcurrentEvents: number;
  private readonly pendingEvents: QueuedTradeEvent[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly marketLocks = new Map<string, Promise<void>>();
  private activeWorkers = 0;
  private reservedDailySpentUsd = 0;
  private reservedExposureUsd = 0;
  private reservedPositionCount = 0;
  private readonly reservedPositionKeys = new Map<string, number>();
  private riskStateLock: Promise<void> = Promise.resolve();

  constructor(options: FollowEngineOptions = {}) {
    this.maxConcurrentEvents = Math.max(1, options.maxConcurrentEvents ?? 8);
  }

  /**
   * Start listening for trade events
   */
  start(): void {
    if (this.listening) return;

    eventBus.on('trade:new', this.tradeEventHandler);
    this.listening = true;

    const config = getConfig();
    eventBus.emit('follow:started', { mode: config.follow.mode as 'shadow' | 'live' });
  }

  /**
   * Stop listening for trade events
   */
  stop(): void {
    if (!this.listening) return;

    eventBus.off('trade:new', this.tradeEventHandler);
    this.listening = false;

    eventBus.emit('follow:stopped', {});
  }

  async waitForIdle(): Promise<void> {
    if (this.pendingEvents.length === 0 && this.activeWorkers === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  /**
   * Handle incoming trade event
   */
  private handleTradeEvent(payload: { event: TradeEvent; isNew: boolean }): Promise<void> {
    this.stats.eventsEnqueued += 1;
    this.stats.queueDepth += 1;
    this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, this.stats.queueDepth);
    this.idleWaiters.clear();

    return new Promise<void>((resolve, reject) => {
      this.pendingEvents.push({ payload, resolve, reject });
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    while (this.activeWorkers < this.maxConcurrentEvents && this.pendingEvents.length > 0) {
      const nextItem = this.pendingEvents.shift();
      if (!nextItem) {
        break;
      }

      this.activeWorkers += 1;
      void this.runQueuedTradeEvent(nextItem);
    }
  }

  private async runQueuedTradeEvent(item: QueuedTradeEvent): Promise<void> {
    try {
      await this.processTradeEvent(item.payload);
      item.resolve();
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.stats.queueDepth = Math.max(0, this.stats.queueDepth - 1);
      this.pumpQueue();
      this.notifyIfIdle();
    }
  }

  private notifyIfIdle(): void {
    if (this.pendingEvents.length > 0 || this.activeWorkers > 0) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }

  private getPositionReservationKey(event: TradeEvent): string {
    return [
      'self',
      event.platform,
      event.conditionId,
      event.outcome ?? 'YES',
    ].join(':');
  }

  private async withRiskStateLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.riskStateLock;
    let release!: () => void;
    this.riskStateLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async reserveRiskCapacity(
    event: TradeEvent,
    amountUsd: number,
    config: AppConfig
  ): Promise<FollowDecision & { reservation?: RiskReservation }> {
    if (event.eventType !== 'BUY') {
      return {
        shouldFollow: true,
        reason: 'Sell orders do not reserve opening risk capacity.',
        reservation: undefined,
      };
    }

    return this.withRiskStateLock(async () => {
      const orderRepo = getOrderRepo();
      const positionRepo = getPositionRepo();

      const [dailySpent, totalExposure, openPositionCount] = await Promise.all([
        orderRepo.getDailySpent(config.follow.mode as 'shadow' | 'live'),
        positionRepo.getTotalExposure(),
        positionRepo.count({ status: 'open' }),
      ]);

      if (dailySpent + this.reservedDailySpentUsd + amountUsd > config.follow.dailyLimit) {
        eventBus.emit('risk:limit_reached', {
          type: 'daily',
          current: dailySpent + this.reservedDailySpentUsd,
          limit: config.follow.dailyLimit,
        });
        return {
          shouldFollow: false,
          reason: `Daily limit would be exceeded: $${dailySpent + this.reservedDailySpentUsd} + $${amountUsd} > $${config.follow.dailyLimit}`,
          category: 'risk',
        };
      }

      if (totalExposure + this.reservedExposureUsd + amountUsd > config.risk.maxExposure) {
        eventBus.emit('risk:limit_reached', {
          type: 'exposure',
          current: totalExposure + this.reservedExposureUsd,
          limit: config.risk.maxExposure,
        });
        return {
          shouldFollow: false,
          reason: `Max exposure would be exceeded: $${totalExposure + this.reservedExposureUsd} + $${amountUsd} > $${config.risk.maxExposure}`,
          category: 'risk',
        };
      }

      const positionReservationKey = this.getPositionReservationKey(event);
      const existingPosition = await positionRepo.getByKey({
        leaderAddress: 'self',
        conditionId: event.conditionId,
        outcome: event.outcome ?? 'YES',
      });
      const hasOpenPosition = existingPosition?.status === 'open' && existingPosition.quantity > 0;
      const alreadyReservedPosition = (this.reservedPositionKeys.get(positionReservationKey) ?? 0) > 0;
      const requiredPositionReservation = hasOpenPosition || alreadyReservedPosition ? 0 : 1;

      if (openPositionCount + this.reservedPositionCount + requiredPositionReservation > config.risk.maxPositions) {
        eventBus.emit('risk:limit_reached', {
          type: 'position',
          current: openPositionCount + this.reservedPositionCount,
          limit: config.risk.maxPositions,
        });
        return {
          shouldFollow: false,
          reason: `Max positions reached: ${openPositionCount + this.reservedPositionCount} >= ${config.risk.maxPositions}`,
          category: 'risk',
        };
      }

      this.reservedDailySpentUsd += amountUsd;
      this.reservedExposureUsd += amountUsd;
      if (requiredPositionReservation > 0) {
        this.reservedPositionCount += requiredPositionReservation;
        this.reservedPositionKeys.set(
          positionReservationKey,
          (this.reservedPositionKeys.get(positionReservationKey) ?? 0) + requiredPositionReservation
        );
      }

      return {
        shouldFollow: true,
        reason: 'Reserved risk capacity for execution.',
        reservation: {
          amountUsd,
          positionReservationKey: requiredPositionReservation > 0 ? positionReservationKey : null,
        },
      };
    });
  }

  private async releaseRiskCapacity(reservation?: RiskReservation): Promise<void> {
    if (!reservation) {
      return;
    }

    await this.withRiskStateLock(async () => {
      this.reservedDailySpentUsd = Math.max(0, this.reservedDailySpentUsd - reservation.amountUsd);
      this.reservedExposureUsd = Math.max(0, this.reservedExposureUsd - reservation.amountUsd);

      if (!reservation.positionReservationKey) {
        return;
      }

      const currentCount = this.reservedPositionKeys.get(reservation.positionReservationKey) ?? 0;
      if (currentCount <= 1) {
        this.reservedPositionKeys.delete(reservation.positionReservationKey);
      } else {
        this.reservedPositionKeys.set(reservation.positionReservationKey, currentCount - 1);
      }

      this.reservedPositionCount = Math.max(0, this.reservedPositionCount - 1);
    });
  }

  private async withMarketLock<T>(event: TradeEvent, task: () => Promise<T>): Promise<T> {
    const key = this.getPositionReservationKey(event);
    const previous = this.marketLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.marketLocks.set(key, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.marketLocks.get(key) === current) {
        this.marketLocks.delete(key);
      }
    }
  }

  private async processTradeEvent(payload: { event: TradeEvent; isNew: boolean }): Promise<void> {
    const { event } = payload;
    const config = getConfig();

    // Skip if follow mode is disabled
    if (config.follow.mode === 'disabled') {
      return;
    }

    const eventRepo = getEventRepo();
    const dbEvent = await this.ensureEventRecord(event);

    this.stats.eventsEvaluated++;
    this.stats.lastEvaluatedAt = Date.now();
    eventBus.emit('follow:evaluating', { event });

    try {
      const decision = await this.evaluate(event, config);
      this.stats.lastDecisionAt = Date.now();
      this.stats.lastDecisionReason = decision.reason;
      this.stats.lastDecisionShouldFollow = decision.shouldFollow;

      if (!decision.shouldFollow) {
        this.stats.eventsSkipped++;
        this.stats.lastSkippedAt = Date.now();
        eventBus.emit('follow:skipped', { event, reason: decision.reason });
        await eventRepo.markFollowSkipped(
          dbEvent.id,
          buildStoredFollowOutcomeReason('skipped', decision.category ?? 'policy', decision.reason)
        );
        await getDailyStatsRepo().incrementEventsSkipped();
        return;
      }

      let reservation: RiskReservation | undefined;
      try {
        const reservationDecision = await this.reserveRiskCapacity(
          event,
          decision.adjustedAmount ?? event.amountUsd,
          config
        );
        if (!reservationDecision.shouldFollow) {
          this.stats.eventsSkipped++;
          this.stats.lastSkippedAt = Date.now();
          this.stats.lastDecisionAt = Date.now();
          this.stats.lastDecisionReason = reservationDecision.reason;
          this.stats.lastDecisionShouldFollow = false;
          eventBus.emit('follow:skipped', { event, reason: reservationDecision.reason });
          await eventRepo.markFollowSkipped(
            dbEvent.id,
            buildStoredFollowOutcomeReason(
              'skipped',
              reservationDecision.category ?? 'risk',
              reservationDecision.reason
            )
          );
          await getDailyStatsRepo().incrementEventsSkipped();
          return;
        }

        reservation = reservationDecision.reservation;
        let executionOutcome: {
          order: Partial<Order> | null;
          skippedDecision: FollowDecision | null;
        };
        try {
          executionOutcome = await this.withMarketLock(
            event,
            async () => {
              const executionDecision = await this.revalidateDecisionForExecution(event, decision, config);
              if (!executionDecision.shouldFollow || executionDecision.adjustedAmount === undefined) {
                return {
                  order: null,
                  skippedDecision: executionDecision,
                };
              }

              return {
                order: await this.execute(event, executionDecision.adjustedAmount, config),
                skippedDecision: null,
              };
            }
          );
        } catch (error) {
          if (error instanceof FollowDecisionSkipError) {
            await this.markSkippedDecision(dbEvent.id, event, error.decision);
            return;
          }
          throw error;
        }

        if (!executionOutcome.order) {
          if (!executionOutcome.skippedDecision) {
            throw new Error('Execution returned no order and no skip decision.');
          }
          await this.markSkippedDecision(dbEvent.id, event, executionOutcome.skippedDecision);
          return;
        }

        const order = executionOutcome.order;
        this.stats.eventsFollowed++;
        this.stats.ordersExecuted++;
        this.stats.totalAmountUsd += order.amountUsd ?? 0;
        this.stats.lastExecutedAt = Date.now();

        eventBus.emit('follow:executed', { event, order: order as Order });
        await getDailyStatsRepo().incrementEventsFollowed();
      } finally {
        await this.releaseRiskCapacity(reservation);
      }
    } catch (error) {
      this.stats.ordersFailed++;
      const detail = this.recordError(error, {
        operation: 'handle_trade_event',
        leaderAddress: event.leaderAddress,
        mode: config.follow.mode,
      });
      await eventRepo.markFollowFailed(
        dbEvent.id,
        buildStoredFollowOutcomeReason(
          'error',
          classifyFollowErrorCategory(detail),
          detail.message ?? (error instanceof Error ? error.message : String(error))
        )
      );
      eventBus.emit('follow:error', {
        event,
        error: error instanceof Error ? error : new Error(String(error)),
        detail,
      });
    }
  }

  private async markSkippedDecision(
    eventId: number,
    event: TradeEvent,
    decision: FollowDecision
  ): Promise<void> {
    this.stats.eventsSkipped++;
    this.stats.lastSkippedAt = Date.now();
    this.stats.lastDecisionAt = Date.now();
    this.stats.lastDecisionReason = decision.reason;
    this.stats.lastDecisionShouldFollow = false;
    eventBus.emit('follow:skipped', { event, reason: decision.reason });
    await getEventRepo().markFollowSkipped(
      eventId,
      buildStoredFollowOutcomeReason('skipped', decision.category ?? 'risk', decision.reason)
    );
    await getDailyStatsRepo().incrementEventsSkipped();
  }

  private async revalidateDecisionForExecution(
    event: TradeEvent,
    decision: FollowDecision,
    config: AppConfig
  ): Promise<FollowDecision> {
    if (event.eventType !== 'SELL') {
      return decision;
    }

    const executionDecision = await this.planFollow(
      event,
      config,
      { requestedAmountUsd: decision.adjustedAmount ?? event.amountUsd }
    );

    if (!executionDecision.shouldFollow) {
      return executionDecision;
    }

    return {
      ...executionDecision,
      sizing: executionDecision.sizing ?? decision.sizing,
    };
  }

  /**
   * Evaluate whether to follow a trade
   */
  async evaluate(event: TradeEvent, config?: AppConfig): Promise<FollowDecision> {
    return this.planFollow(event, config);
  }

  async planFollow(
    event: TradeEvent,
    config?: AppConfig,
    options?: { requestedAmountUsd?: number }
  ): Promise<FollowDecision> {
    const cfg = config ?? getConfig();

    // Check allowlist/blocklist
    if (cfg.follow.allowlist.length > 0) {
      const inAllowlist = cfg.follow.allowlist.some(
        (addr) => addr.toLowerCase() === event.leaderAddress.toLowerCase()
      );
      if (!inAllowlist) {
        return { shouldFollow: false, reason: 'Leader not in allowlist', category: 'policy' };
      }
    }

    if (cfg.follow.blocklist.length > 0) {
      const inBlocklist = cfg.follow.blocklist.some(
        (addr) => addr.toLowerCase() === event.leaderAddress.toLowerCase()
      );
      if (inBlocklist) {
        return { shouldFollow: false, reason: 'Leader is blocklisted', category: 'policy' };
      }
    }

    // Check minimum trade amount
    if (event.amountUsd < cfg.watch.filterMinUsd) {
      return {
        shouldFollow: false,
        reason: `Amount $${event.amountUsd} below minimum $${cfg.watch.filterMinUsd}`,
        category: 'policy',
      };
    }

    const sizingDecision = await this.calculateAdjustedAmount(event, cfg, options?.requestedAmountUsd);
    if (!sizingDecision.shouldFollow || sizingDecision.adjustedAmount === undefined) {
      return sizingDecision;
    }

    if (event.eventType === 'SELL') {
      return this.constrainSellDecision(event, sizingDecision);
    }

    const riskCheck = await this.checkRiskLimits(sizingDecision.adjustedAmount, cfg);
    if (!riskCheck.shouldFollow) {
      return {
        ...riskCheck,
        adjustedAmount: sizingDecision.adjustedAmount,
        sizing: sizingDecision.sizing,
      };
    }

    return {
      shouldFollow: true,
      reason: 'Passed all checks',
      adjustedAmount: sizingDecision.adjustedAmount,
      sizing: sizingDecision.sizing,
    };
  }

  private async constrainSellDecision(
    event: TradeEvent,
    decision: FollowDecision
  ): Promise<FollowDecision> {
    const adjustedAmount = decision.adjustedAmount;
    if (adjustedAmount === undefined || adjustedAmount <= 0) {
      return {
        shouldFollow: false,
        reason: 'Sell amount must be greater than 0.',
        category: 'policy',
      };
    }

    const outcome = event.outcome ?? 'YES';
    const lotRepo = getPositionLotRepo();
    const openQuantity = await lotRepo.getOpenQuantity({
      leaderAddress: 'self',
      platform: event.platform,
      conditionId: event.conditionId,
      outcome,
    });

    if (!Number.isFinite(openQuantity) || openQuantity <= 0) {
      return {
        shouldFollow: false,
        reason: await this.describeSellInventoryGap(event, outcome),
        category: 'risk',
      };
    }

    const desiredQuantity = adjustedAmount / event.price;
    const sellQuantity = Math.min(openQuantity, desiredQuantity);
    const cappedAmount = sellQuantity * event.price;

    return {
      shouldFollow: true,
      reason: sellQuantity < desiredQuantity
        ? 'Sell size capped by current open position.'
        : decision.reason,
      adjustedAmount: cappedAmount,
      sizing: decision.sizing
        ? {
            ...decision.sizing,
            adjustedAmountUsd: cappedAmount,
          }
        : undefined,
    };
  }

  private async describeSellInventoryGap(event: TradeEvent, outcome: string): Promise<string> {
    const lotRepo = getPositionLotRepo();
    const openLots = await lotRepo.find({
      leaderAddress: 'self',
      platform: event.platform,
      conditionId: event.conditionId,
      status: 'open',
    }, 1000, 'asc');

    if (openLots.length === 0) {
      return `No open position available to reduce for outcome "${outcome}". No local open lots exist for this market.`;
    }

    const byOutcome = new Map<string, number>();
    for (const lot of openLots) {
      const key = lot.outcome;
      byOutcome.set(key, (byOutcome.get(key) ?? 0) + lot.remainingQuantity);
    }

    const inventorySummary = Array.from(byOutcome.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, quantity]) => `${label}=${quantity.toFixed(6)}`)
      .join(', ');

    return `No open position available to reduce for outcome "${outcome}". Local open outcomes for this market: ${inventorySummary}`;
  }

  /**
   * Check risk limits
   */
  private async checkRiskLimits(
    amountUsd: number,
    config: AppConfig
  ): Promise<FollowDecision> {
    const orderRepo = getOrderRepo();
    const positionRepo = getPositionRepo();

    // Check daily limit
    const dailySpent = await orderRepo.getDailySpent(config.follow.mode as 'shadow' | 'live');
    if (dailySpent + amountUsd > config.follow.dailyLimit) {
      eventBus.emit('risk:limit_reached', {
        type: 'daily',
        current: dailySpent,
        limit: config.follow.dailyLimit,
      });
      return {
        shouldFollow: false,
        reason: `Daily limit would be exceeded: $${dailySpent} + $${amountUsd} > $${config.follow.dailyLimit}`,
        category: 'risk',
      };
    }

    // Check total exposure
    const totalExposure = await positionRepo.getTotalExposure();
    if (totalExposure + amountUsd > config.risk.maxExposure) {
      eventBus.emit('risk:limit_reached', {
        type: 'exposure',
        current: totalExposure,
        limit: config.risk.maxExposure,
      });
      return {
        shouldFollow: false,
        reason: `Max exposure would be exceeded: $${totalExposure} + $${amountUsd} > $${config.risk.maxExposure}`,
        category: 'risk',
      };
    }

    // Check position count
    const positionCount = await positionRepo.count({ status: 'open' });
    if (positionCount >= config.risk.maxPositions) {
      eventBus.emit('risk:limit_reached', {
        type: 'position',
        current: positionCount,
        limit: config.risk.maxPositions,
      });
      return {
        shouldFollow: false,
        reason: `Max positions reached: ${positionCount} >= ${config.risk.maxPositions}`,
        category: 'risk',
      };
    }

    return { shouldFollow: true, reason: 'Risk checks passed' };
  }

  private async calculateAdjustedAmount(
    event: TradeEvent,
    config: AppConfig,
    requestedAmountUsd?: number
  ): Promise<FollowDecision> {
    const overrideAmount = requestedAmountUsd ?? null;

    if (overrideAmount !== null) {
      if (!Number.isFinite(overrideAmount) || overrideAmount <= 0) {
        return {
          shouldFollow: false,
          reason: 'Requested follow amount must be greater than 0.',
          category: 'policy',
        };
      }

      const adjustedAmount = Math.min(overrideAmount, config.follow.maxPerTrade);
      return {
        shouldFollow: true,
        reason: adjustedAmount < overrideAmount
          ? `Requested amount capped at max per trade ($${config.follow.maxPerTrade}).`
          : 'Using requested follow amount.',
        adjustedAmount,
        sizing: {
          mode: config.follow.sizingMode,
          source: 'override',
          leaderTradeAmountUsd: event.amountUsd,
          uncappedAmountUsd: overrideAmount,
          adjustedAmountUsd: adjustedAmount,
          maxPerTradeUsd: config.follow.maxPerTrade,
          bankrollUsd: config.follow.sizingMode === 'proportional' ? config.follow.bankrollUsd : undefined,
        },
      };
    }

    if (config.follow.sizingMode === 'proportional') {
      if (!Number.isFinite(config.follow.bankrollUsd) || config.follow.bankrollUsd <= 0) {
        return {
          shouldFollow: false,
          reason: 'Proportional sizing requires a positive follow.bankrollUsd.',
          category: 'policy',
        };
      }

      const leaderExposureUsd = await this.estimateLeaderExposureUsd(event.leaderAddress);
      if (!Number.isFinite(leaderExposureUsd) || leaderExposureUsd <= 0) {
        return {
          shouldFollow: false,
          reason: 'Leader open exposure unavailable for proportional sizing.',
          category: 'policy',
        };
      }

      const ratio = config.follow.bankrollUsd / leaderExposureUsd;
      const uncappedAmountUsd = event.amountUsd * ratio;
      const adjustedAmountUsd = Math.min(uncappedAmountUsd, config.follow.maxPerTrade);

      if (!Number.isFinite(adjustedAmountUsd) || adjustedAmountUsd <= 0) {
        return {
          shouldFollow: false,
          reason: 'Calculated follow amount is zero after proportional sizing.',
          category: 'policy',
        };
      }

      return {
        shouldFollow: true,
        reason: 'Calculated proportional follow amount.',
        adjustedAmount: adjustedAmountUsd,
        sizing: {
          mode: 'proportional',
          source: 'config',
          leaderTradeAmountUsd: event.amountUsd,
          uncappedAmountUsd,
          adjustedAmountUsd,
          maxPerTradeUsd: config.follow.maxPerTrade,
          bankrollUsd: config.follow.bankrollUsd,
          leaderExposureUsd,
          ratio,
        },
      };
    }

    const adjustedAmountUsd = Math.min(event.amountUsd, config.follow.maxPerTrade);
    return {
      shouldFollow: true,
      reason: adjustedAmountUsd < event.amountUsd
        ? `Trade capped at max per trade ($${config.follow.maxPerTrade}).`
        : 'Using fixed follow amount.',
      adjustedAmount: adjustedAmountUsd,
      sizing: {
        mode: 'fixed',
        source: 'config',
        leaderTradeAmountUsd: event.amountUsd,
        uncappedAmountUsd: event.amountUsd,
        adjustedAmountUsd,
        maxPerTradeUsd: config.follow.maxPerTrade,
      },
    };
  }

  private async estimateLeaderExposureUsd(address: string): Promise<number> {
    const adapter = getPolymarketAdapter();
    const positions = await adapter.fetchPositions(address);

    return positions.reduce((total, position) => {
      if (position.status !== 'open') {
        return total;
      }
      return total + Math.max(0, position.costBasis);
    }, 0);
  }

  private async applyExecutionToLedger(params: {
    event: TradeEvent;
    orderId: number;
    executedQuantity: number;
    executedPrice: number;
  }): Promise<{
    closedLots: number;
    openedLots: number;
    realizedPnl: number;
    totalExposure: number;
  }> {
    const positionLotRepo = getPositionLotRepo();
    const positionRepo = getPositionRepo();
    const outcome = params.event.outcome ?? 'YES';

    if (params.event.eventType === 'BUY') {
      await positionLotRepo.create({
        leaderAddress: 'self',
        platform: params.event.platform,
        conditionId: params.event.conditionId,
        marketSlug: params.event.marketSlug,
        marketTitle: params.event.marketTitle,
        outcome,
        entryQuantity: params.executedQuantity,
        remainingQuantity: params.executedQuantity,
        avgPrice: params.executedPrice,
        costBasis: params.executedQuantity * params.executedPrice,
        realizedPnl: 0,
        status: 'open',
        openedOrderId: params.orderId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await positionRepo.syncAggregateFromLots({
        leaderAddress: 'self',
        platform: params.event.platform,
        conditionId: params.event.conditionId,
        outcome,
        marketSlug: params.event.marketSlug,
        marketTitle: params.event.marketTitle,
      });

      return {
        openedLots: 1,
        closedLots: 0,
        realizedPnl: 0,
        totalExposure: await positionRepo.getTotalExposure(),
      };
    }

    const openLots = await positionLotRepo.getOpenLots({
      leaderAddress: 'self',
      platform: params.event.platform,
      conditionId: params.event.conditionId,
      outcome,
    });

    if (openLots.length === 0) {
      throw new Error('No open position available to reduce.');
    }

    let remainingToSell = params.executedQuantity;
    let realizedPnl = 0;
    let closedLots = 0;
    const epsilon = 1e-9;

    for (const lot of openLots) {
      if (remainingToSell <= epsilon) {
        break;
      }

      const matchedQuantity = Math.min(lot.remainingQuantity, remainingToSell);
      if (matchedQuantity <= epsilon) {
        continue;
      }

      const nextRemaining = lot.remainingQuantity - matchedQuantity;
      const nextRealizedPnl = lot.realizedPnl + (matchedQuantity * (params.executedPrice - lot.avgPrice));

      await positionLotRepo.update(lot.id, {
        remainingQuantity: Math.max(0, nextRemaining),
        realizedPnl: nextRealizedPnl,
        status: nextRemaining <= epsilon ? 'closed' : 'open',
        closedAt: nextRemaining <= epsilon ? Date.now() : null,
      });

      if (nextRemaining <= epsilon) {
        closedLots += 1;
      }

      realizedPnl += matchedQuantity * (params.executedPrice - lot.avgPrice);
      remainingToSell -= matchedQuantity;
    }

    await positionRepo.syncAggregateFromLots({
      leaderAddress: 'self',
      platform: params.event.platform,
      conditionId: params.event.conditionId,
      outcome,
      marketSlug: params.event.marketSlug,
      marketTitle: params.event.marketTitle,
      closedAt: Date.now(),
    });

    return {
      openedLots: 0,
      closedLots,
      realizedPnl,
      totalExposure: await positionRepo.getTotalExposure(),
    };
  }

  /**
   * Execute a follow trade
   */
  async execute(
    event: TradeEvent,
    amount: number,
    config?: AppConfig
  ): Promise<Partial<Order>> {
    const cfg = config ?? getConfig();
    const orderRepo = getOrderRepo();
    const eventRepo = getEventRepo();
    const statsRepo = getDailyStatsRepo();
    const adapter = getPolymarketAdapter();

    if (event.eventType === 'SELL') {
      const executableDecision = await this.constrainSellDecision(event, {
        shouldFollow: true,
        reason: 'Sell execution preflight.',
        adjustedAmount: amount,
      });
      if (!executableDecision.shouldFollow || executableDecision.adjustedAmount === undefined) {
        throw new FollowDecisionSkipError(executableDecision);
      }
      amount = executableDecision.adjustedAmount;
    }

    const dbEvent = await this.ensureEventRecord(event);
    const eventId = dbEvent.id;

    // Get actual token ID from market info
    let tokenId = event.conditionId; // fallback to conditionId
    if (event.outcome) {
      const resolvedTokenId = await adapter.getTokenIdForOutcome(event.conditionId, event.outcome);
      if (resolvedTokenId) {
        tokenId = resolvedTokenId;
      }
    }

    // Prepare order
    const newOrder: NewOrder = {
      eventId,
      leaderAddress: event.leaderAddress.toLowerCase(),
      platform: event.platform,
      orderType: 'market',
      side: event.eventType.toLowerCase() as 'buy' | 'sell',
      tokenId,
      price: event.price,
      size: amount / event.price,
      amountUsd: amount,
      status: 'pending',
      mode: cfg.follow.mode as 'shadow' | 'live',
      createdAt: Date.now(),
    };

    // Create order record
    const order = await orderRepo.create(newOrder);

    eventBus.emit('follow:executing', { event, order: newOrder as Partial<Order> });

    if (cfg.follow.mode === 'shadow') {
      // Shadow mode: simulate execution
      const txHash = `shadow-${Date.now()}`;
      const executedPrice = event.price;
      const executedQuantity = amount / executedPrice;
      const executedAmount = executedQuantity * executedPrice;
      const fillReconciliation = reconcileFollowExecution({
        mode: 'shadow',
        requestedPrice: event.price,
        requestedSize: newOrder.size,
        requestedAmountUsd: amount,
        executedPrice,
        executedSize: executedQuantity,
        executedAmountUsd: executedAmount,
      });

      const ledgerUpdate = await this.applyExecutionToLedger({
        event,
        orderId: order.id,
        executedQuantity,
        executedPrice,
      });

      await orderRepo.markExecuted(order.id, txHash, executedPrice, {
        executedSize: executedQuantity,
        executedAmountUsd: executedAmount,
        reconcileStatus: fillReconciliation.status,
        reconcileReason: fillReconciliation.reason,
        lastReconciledAt: Date.now(),
      });

      if (ledgerUpdate.openedLots > 0) {
        await statsRepo.incrementPositionsOpened(ledgerUpdate.openedLots);
      }
      if (ledgerUpdate.closedLots > 0) {
        await statsRepo.incrementPositionsClosed(ledgerUpdate.closedLots);
      }
      if (ledgerUpdate.realizedPnl !== 0) {
        await statsRepo.addRealizedPnl(ledgerUpdate.realizedPnl);
      }
      await statsRepo.updateExposure(ledgerUpdate.totalExposure);
      await eventRepo.markFollowed(dbEvent.id, `${cfg.follow.mode}:order:${order.id}`);

      return {
        id: order.id,
        eventId: newOrder.eventId,
        leaderAddress: newOrder.leaderAddress,
        platform: event.platform,
        orderType: newOrder.orderType as 'market' | 'limit',
        side: newOrder.side as 'buy' | 'sell',
        tokenId: newOrder.tokenId,
        size: executedQuantity,
        amountUsd: executedAmount,
        mode: newOrder.mode as 'shadow' | 'live',
        status: 'executed',
        txHash,
        executedPrice,
        executedSize: executedQuantity,
        executedAmountUsd: executedAmount,
        reconcileStatus: fillReconciliation.status,
        reconcileReason: fillReconciliation.reason,
        lastReconciledAt: Date.now(),
        createdAt: newOrder.createdAt,
      };
    } else {
      // Live mode: execute real trade
      const adapter = getPolymarketAdapter();

      try {
        const result = await adapter.executeCopyTrade({
          tokenId, // Use resolved tokenId
          side: event.eventType.toLowerCase() as 'buy' | 'sell',
          amount,
          useMarketOrder: true,
        });

        const executedPrice = result.executedPrice ?? event.price;
        const executedQuantity = result.executedSize ?? (amount / event.price);
        const executedAmount = executedQuantity * executedPrice;
        const fillReconciliation = reconcileFollowExecution({
          mode: 'live',
          requestedPrice: event.price,
          requestedSize: newOrder.size,
          requestedAmountUsd: amount,
          executedPrice: result.executedPrice,
          executedSize: result.executedSize,
          executedAmountUsd: result.executedPrice !== undefined && result.executedSize !== undefined
            ? result.executedPrice * result.executedSize
            : undefined,
        });

        await orderRepo.markExecuted(order.id, result.txHash ?? '', executedPrice, {
          executedSize: executedQuantity,
          executedAmountUsd: executedAmount,
          reconcileStatus: fillReconciliation.status,
          reconcileReason: fillReconciliation.reason,
          lastReconciledAt: Date.now(),
        });

        const ledgerUpdate = await this.applyExecutionToLedger({
          event,
          orderId: order.id,
          executedQuantity,
          executedPrice,
        });

        if (ledgerUpdate.openedLots > 0) {
          await statsRepo.incrementPositionsOpened(ledgerUpdate.openedLots);
        }
        if (ledgerUpdate.closedLots > 0) {
          await statsRepo.incrementPositionsClosed(ledgerUpdate.closedLots);
        }
        if (ledgerUpdate.realizedPnl !== 0) {
          await statsRepo.addRealizedPnl(ledgerUpdate.realizedPnl);
        }
        await statsRepo.updateExposure(ledgerUpdate.totalExposure);
        await eventRepo.markFollowed(dbEvent.id, `${cfg.follow.mode}:order:${order.id}`);

        return {
          id: order.id,
          eventId: newOrder.eventId,
          leaderAddress: newOrder.leaderAddress,
          platform: event.platform,
          orderType: newOrder.orderType as 'market' | 'limit',
          side: newOrder.side as 'buy' | 'sell',
          tokenId: newOrder.tokenId,
          size: executedQuantity,
          amountUsd: executedAmount,
          mode: newOrder.mode as 'shadow' | 'live',
          status: 'executed',
          txHash: result.txHash,
          executedPrice,
          executedSize: executedQuantity,
          executedAmountUsd: executedAmount,
          reconcileStatus: fillReconciliation.status,
          reconcileReason: fillReconciliation.reason,
          lastReconciledAt: Date.now(),
          createdAt: newOrder.createdAt,
        };
      } catch (error) {
        await orderRepo.markFailed(
          order.id,
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    }
  }

  /**
   * Manually follow a specific event
   */
  async followOnce(eventId: number, amount?: number): Promise<Partial<Order>> {
    const eventRepo = getEventRepo();
    const event = await eventRepo.getById(eventId);

    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    const tradeEvent: TradeEvent = {
      leaderAddress: event.leaderAddress,
      platform: event.platform as 'polymarket',
      eventType: event.eventType as 'BUY' | 'SELL',
      conditionId: event.conditionId,
      marketSlug: event.marketSlug ?? undefined,
      marketTitle: event.marketTitle ?? undefined,
      outcome: event.outcome ?? undefined,
      price: event.price,
      quantity: event.quantity,
      amountUsd: event.amountUsd,
      txHash: event.txHash ?? undefined,
      timestamp: event.timestamp,
      followed: !!event.followed,
      createdAt: event.createdAt,
    };

    const config = getConfig();
    const decision = await this.planFollow(tradeEvent, config, { requestedAmountUsd: amount });
    if (!decision.shouldFollow || decision.adjustedAmount === undefined) {
      throw new Error(decision.reason);
    }

    return this.execute(tradeEvent, decision.adjustedAmount, config);
  }

  /**
   * Get engine stats
   */
  getStats(): FollowEngineStats {
    return { ...this.stats };
  }

  /**
   * Reset stats
   */
  resetStats(): void {
    this.stats = {
      eventsEnqueued: 0,
      eventsEvaluated: 0,
      eventsFollowed: 0,
      eventsSkipped: 0,
      ordersExecuted: 0,
      ordersFailed: 0,
      totalAmountUsd: 0,
      queueDepth: 0,
      maxQueueDepth: 0,
      lastEvaluatedAt: null,
      lastDecisionAt: null,
      lastDecisionReason: null,
      lastDecisionShouldFollow: null,
      lastExecutedAt: null,
      lastSkippedAt: null,
      lastError: null,
    };
    this.pendingEvents.length = 0;
    this.activeWorkers = 0;
    this.reservedDailySpentUsd = 0;
    this.reservedExposureUsd = 0;
    this.reservedPositionCount = 0;
    this.reservedPositionKeys.clear();
    this.marketLocks.clear();
    this.idleWaiters.clear();
    this.riskStateLock = Promise.resolve();
  }

  /**
   * Check if engine is listening
   */
  isListening(): boolean {
    return this.listening;
  }

  private async ensureEventRecord(event: TradeEvent) {
    const eventRepo = getEventRepo();

    if (event.id) {
      const existingById = await eventRepo.getById(event.id);
      if (existingById) {
        return existingById;
      }
    }

    const exactMatches = await eventRepo.find({
      leaderAddress: event.leaderAddress,
      conditionId: event.conditionId,
      fromTimestamp: event.timestamp,
      toTimestamp: event.timestamp,
    }, 20);

    const matchedEvent = exactMatches.find((candidate) =>
      candidate.eventType === event.eventType
      && candidate.price === event.price
      && candidate.quantity === event.quantity
      && candidate.amountUsd === event.amountUsd
      && (candidate.outcome ?? undefined) === event.outcome
    );

    if (matchedEvent) {
      return matchedEvent;
    }

    if (event.txHash) {
      const existingByTxHash = await eventRepo.find({ txHash: event.txHash }, 1);
      if (existingByTxHash.length > 0) {
        return existingByTxHash[0];
      }
    }

    return eventRepo.save({
      leaderAddress: event.leaderAddress.toLowerCase(),
      platform: event.platform,
      eventType: event.eventType,
      conditionId: event.conditionId,
      marketSlug: event.marketSlug,
      marketTitle: event.marketTitle,
      outcome: event.outcome,
      price: event.price,
      quantity: event.quantity,
      amountUsd: event.amountUsd,
      txHash: event.txHash,
      timestamp: event.timestamp,
      followed: event.followed ? 1 : 0,
      createdAt: event.createdAt,
    });
  }

  private recordError(
    error: unknown,
    context: { operation: string; leaderAddress?: string; mode?: string }
  ): FailureInfo {
    const detail = toFailureInfo(error, {
      code: 'runtime_error',
      source: 'follow_engine',
      operation: context.operation,
      retryable: true,
      details: {
        leaderAddress: context.leaderAddress ?? null,
        mode: context.mode ?? null,
      },
    });

    this.stats.lastError = {
      ...detail,
      details: {
        ...detail.details,
        leaderAddress: context.leaderAddress ?? detail.details?.leaderAddress ?? null,
        mode: context.mode ?? detail.details?.mode ?? null,
      },
    };

    return this.stats.lastError;
  }
}

// Singleton
let followEngine: FollowEngine | null = null;

export function getFollowEngine(): FollowEngine {
  if (!followEngine) {
    followEngine = new FollowEngine();
  }
  return followEngine;
}
