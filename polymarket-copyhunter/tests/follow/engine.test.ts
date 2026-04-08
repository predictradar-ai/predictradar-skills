/**
 * CopyHunter - Follow Engine Tests
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as delay } from 'node:timers/promises';

// Set up test data directory before importing modules
const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-test-'));
process.env.XDG_DATA_HOME = testDataDir;

import { getDb, closeDb } from '../../src/db/index.js';
import {
  getDailyStatsRepo,
  getEventRepo,
  getLeaderRepo,
  getOrderRepo,
  getPositionRepo,
} from '../../src/db/repositories/index.js';
import { FollowEngine } from '../../src/follow/engine.js';
import { getConfig, setConfigValue } from '../../src/core/config.js';
import type { TradeEvent } from '../../src/core/types.js';
import { eventBus } from '../../src/core/events.js';
import { getPolymarketAdapter } from '../../src/platforms/polymarket/index.js';
import { StructuredFailure, createFailureInfo } from '../../src/core/failures.js';

describe('FollowEngine Tests', () => {
  let followEngine: FollowEngine;
  const adapter = getPolymarketAdapter();
  const originalFetchPositions = adapter.fetchPositions.bind(adapter);
  let eventCounter = 0;

  function createTradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
    eventCounter += 1;
    const timestamp = Date.now() + eventCounter;
    return {
      leaderAddress: '0xleader123',
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: `cond-test-${eventCounter}`,
      marketTitle: `Test Market ${eventCounter}`,
      outcome: 'YES',
      price: 0.5,
      quantity: 100,
      amountUsd: 50,
      timestamp,
      followed: false,
      createdAt: timestamp,
      ...overrides,
    };
  }

  before(async () => {
    // Initialize database
    getDb();

    // Add a test leader
    const leaderRepo = getLeaderRepo();
    await leaderRepo.add({
      address: '0xleader123',
      alias: 'TestLeader',
    });

    // Set up config for testing
    setConfigValue('follow.mode', 'shadow');
    setConfigValue('follow.maxPerTrade', 100);
    setConfigValue('follow.dailyLimit', 1000);
  });

  after(() => {
    closeDb();
    try {
      rmSync(testDataDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    eventBus.removeAllListeners('trade:new');
    followEngine = new FollowEngine();
    setConfigValue('follow.mode', 'shadow');
    setConfigValue('follow.sizingMode', 'fixed');
    setConfigValue('follow.bankrollUsd', 1000);
    setConfigValue('follow.maxPerTrade', 100);
    setConfigValue('follow.dailyLimit', 1000);
    setConfigValue('follow.allowlist', []);
    setConfigValue('follow.blocklist', []);
    setConfigValue('watch.filterMinUsd', 10);
    setConfigValue('risk.maxExposure', 1000);
    setConfigValue('risk.maxPositions', 20);
    adapter.fetchPositions = originalFetchPositions;
  });

  describe('evaluate()', () => {
    const baseEvent = createTradeEvent({
      conditionId: 'cond-test',
      marketTitle: 'Test Market',
    });

    it('should approve valid trade', async () => {
      const decision = await followEngine.evaluate(baseEvent);
      assert.strictEqual(decision.shouldFollow, true);
      assert.ok(decision.adjustedAmount);
    });

    it('should reject trade below minimum amount', async () => {
      const smallEvent = { ...baseEvent, amountUsd: 1 };
      const decision = await followEngine.evaluate(smallEvent);
      assert.strictEqual(decision.shouldFollow, false);
      assert.ok(decision.reason.includes('below minimum'));
    });

    it('should cap amount at maxPerTrade', async () => {
      const largeEvent = { ...baseEvent, amountUsd: 500 };
      const config = getConfig();
      const decision = await followEngine.evaluate(largeEvent);

      assert.strictEqual(decision.shouldFollow, true);
      assert.strictEqual(decision.adjustedAmount, config.follow.maxPerTrade);
    });

    it('should size proportionally using leader exposure', async () => {
      setConfigValue('follow.sizingMode', 'proportional');
      setConfigValue('follow.bankrollUsd', 1000);
      setConfigValue('follow.maxPerTrade', 50);

      adapter.fetchPositions = async () => [{
        leaderAddress: '0xleader123',
        platform: 'polymarket' as const,
        conditionId: 'cond-open',
        outcome: 'YES' as const,
        quantity: 1,
        avgPrice: 1,
        costBasis: 5000,
        status: 'open' as const,
        realizedPnl: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const event = { ...baseEvent, amountUsd: 80 };
      const decision = await followEngine.evaluate(event);

      assert.strictEqual(decision.shouldFollow, true);
      assert.strictEqual(decision.adjustedAmount, 16);
      assert.strictEqual(decision.sizing?.mode, 'proportional');
      assert.strictEqual(decision.sizing?.leaderExposureUsd, 5000);
      assert.strictEqual(decision.sizing?.ratio, 0.2);
    });

    it('should evaluate risk using the adjusted amount instead of leader trade size', async () => {
      setConfigValue('follow.maxPerTrade', 20);
      setConfigValue('follow.dailyLimit', 60);

      const event = { ...baseEvent, amountUsd: 100 };
      const decision = await followEngine.evaluate(event);

      assert.strictEqual(decision.shouldFollow, true);
      assert.strictEqual(decision.adjustedAmount, 20);
    });

    it('should respect allowlist when set', async () => {
      setConfigValue('follow.allowlist', ['0xallowed']);

      const decision = await followEngine.evaluate(baseEvent);
      assert.strictEqual(decision.shouldFollow, false);
      assert.ok(decision.reason.includes('not in allowlist'));

      // Clean up
      setConfigValue('follow.allowlist', []);
    });

    it('should respect blocklist', async () => {
      setConfigValue('follow.blocklist', ['0xleader123']);

      const decision = await followEngine.evaluate(baseEvent);
      assert.strictEqual(decision.shouldFollow, false);
      assert.ok(decision.reason.includes('blocklisted'));

      // Clean up
      setConfigValue('follow.blocklist', []);
    });

    it('should reject sell events when no open position exists', async () => {
      const decision = await followEngine.evaluate(createTradeEvent({
        eventType: 'SELL',
        conditionId: 'cond-no-position',
        amountUsd: 20,
        quantity: 40,
      }));

      assert.strictEqual(decision.shouldFollow, false);
      assert.ok(decision.reason.toLowerCase().includes('open position'));
    });

    it('should cap sell amount to the current open position and bypass opening risk limits', async () => {
      const positionRepo = getPositionRepo();

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-sell-cap',
        price: 0.5,
        amountUsd: 25,
        quantity: 50,
      }), 25);

      const openBefore = await positionRepo.find({ conditionId: 'cond-sell-cap', status: 'open' });
      assert.strictEqual(openBefore.length, 1);
      assert.strictEqual(openBefore[0].quantity, 50);

      setConfigValue('follow.dailyLimit', 0);
      setConfigValue('risk.maxExposure', 0);
      setConfigValue('risk.maxPositions', 1);

      const decision = await followEngine.evaluate(createTradeEvent({
        eventType: 'SELL',
        conditionId: 'cond-sell-cap',
        price: 1,
        amountUsd: 100,
        quantity: 100,
      }));

      assert.strictEqual(decision.shouldFollow, true);
      assert.strictEqual(decision.adjustedAmount, 50);
    });
  });

  describe('execute()', () => {
    it('should execute in shadow mode', async () => {
      const eventRepo = getEventRepo();
      setConfigValue('follow.mode', 'shadow');

      const savedEvent = await eventRepo.save({
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-exec-test',
        marketTitle: 'Execute Test Market',
        outcome: 'YES',
        price: 0.6,
        quantity: 50,
        amountUsd: 30,
        txHash: 'tx-follow-shadow',
        timestamp: Date.now(),
        followed: 0,
        createdAt: Date.now(),
      });

      const testEvent: TradeEvent = {
        id: savedEvent.id,
        leaderAddress: savedEvent.leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: savedEvent.conditionId,
        marketTitle: savedEvent.marketTitle ?? undefined,
        outcome: 'YES',
        price: savedEvent.price,
        quantity: savedEvent.quantity,
        amountUsd: savedEvent.amountUsd,
        txHash: savedEvent.txHash ?? undefined,
        timestamp: savedEvent.timestamp,
        followed: false,
        createdAt: savedEvent.createdAt,
      };

      const order = await followEngine.execute(testEvent, 30);

      assert.ok(order.id);
      assert.strictEqual(order.status, 'executed');
      assert.ok(order.txHash?.startsWith('shadow-'));
      assert.strictEqual(order.amountUsd, 30);
      assert.strictEqual(order.eventId, savedEvent.id);

      const updatedEvent = await eventRepo.getById(savedEvent.id!);
      assert.ok(updatedEvent);
      assert.strictEqual(updatedEvent.followed, 1);
    });

    it('should create a backing event record instead of an orphan order', async () => {
      const eventRepo = getEventRepo();
      const orderRepo = getOrderRepo();
      setConfigValue('follow.mode', 'shadow');

      const timestamp = Date.now();
      const testEvent: TradeEvent = {
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-manual-follow',
        marketTitle: 'Manual Follow Market',
        price: 0.4,
        quantity: 25,
        amountUsd: 10,
        timestamp,
        followed: false,
        createdAt: timestamp,
      };

      const order = await followEngine.execute(testEvent, 10);

      assert.ok(order.id);
      assert.ok(order.eventId);
      assert.notStrictEqual(order.eventId, 0);

      const storedOrder = await orderRepo.getById(order.id!);
      assert.ok(storedOrder);
      assert.strictEqual(storedOrder.eventId, order.eventId);

      const createdEvent = await eventRepo.getById(order.eventId!);
      assert.ok(createdEvent);
      assert.strictEqual(createdEvent.conditionId, 'cond-manual-follow');
      assert.strictEqual(createdEvent.followed, 1);
    });

    it('should match the exact saved event when multiple trades share the same tx hash', async () => {
      const eventRepo = getEventRepo();
      const orderRepo = getOrderRepo();
      setConfigValue('follow.mode', 'shadow');

      const sharedTxHash = 'tx-shared-follow-match';
      const baseTimestamp = Date.now();

      const targetEvent = await eventRepo.save({
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-shared-target',
        marketTitle: 'Shared Tx Target',
        outcome: 'YES',
        price: 0.41,
        quantity: 20,
        amountUsd: 8.2,
        txHash: sharedTxHash,
        timestamp: baseTimestamp,
        followed: 0,
        createdAt: baseTimestamp,
      });

      const distractorEvent = await eventRepo.save({
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-shared-distractor',
        marketTitle: 'Shared Tx Distractor',
        outcome: 'NO',
        price: 0.77,
        quantity: 5,
        amountUsd: 3.85,
        txHash: sharedTxHash,
        timestamp: baseTimestamp + 1,
        followed: 0,
        createdAt: baseTimestamp + 1,
      });

      const order = await followEngine.execute({
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: targetEvent.conditionId,
        marketTitle: targetEvent.marketTitle ?? undefined,
        outcome: targetEvent.outcome ?? undefined,
        price: targetEvent.price,
        quantity: targetEvent.quantity,
        amountUsd: targetEvent.amountUsd,
        txHash: sharedTxHash,
        timestamp: targetEvent.timestamp,
        followed: false,
        createdAt: targetEvent.createdAt,
      }, targetEvent.amountUsd);

      assert.ok(order.id);
      assert.strictEqual(order.eventId, targetEvent.id);

      const storedOrder = await orderRepo.getById(order.id!);
      assert.ok(storedOrder);
      assert.strictEqual(storedOrder.eventId, targetEvent.id);

      const updatedTarget = await eventRepo.getById(targetEvent.id!);
      const updatedDistractor = await eventRepo.getById(distractorEvent.id!);
      assert.strictEqual(updatedTarget?.followed, 1);
      assert.strictEqual(updatedDistractor?.followed, 0);
    });

    it('should fully close a position on sell and record realized pnl in shadow mode', async () => {
      const positionRepo = getPositionRepo();
      const orderRepo = getOrderRepo();
      const statsRepo = getDailyStatsRepo();
      const beforeStats = await statsRepo.getOrCreateToday();
      const baselineBuySpent = await orderRepo.getDailySpent();
      const baselineSellSpent = await orderRepo.getDailySpent(undefined, 'sell');

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-full-close',
        marketTitle: 'Full Close Market',
        price: 0.5,
        amountUsd: 50,
        quantity: 100,
      }), 50);

      const sellOrder = await followEngine.execute(createTradeEvent({
        eventType: 'SELL',
        conditionId: 'cond-full-close',
        marketTitle: 'Full Close Market',
        price: 0.7,
        amountUsd: 70,
        quantity: 100,
      }), 70);

      assert.strictEqual(sellOrder.status, 'executed');
      assert.strictEqual(sellOrder.side, 'sell');

      const openPositions = await positionRepo.find({ conditionId: 'cond-full-close', status: 'open' });
      assert.strictEqual(openPositions.length, 0);

      const closedPositions = await positionRepo.find({ conditionId: 'cond-full-close', status: 'closed' });
      assert.strictEqual(closedPositions.length, 1);
      assert.strictEqual(Number(closedPositions[0].realizedPnl.toFixed(8)), 20);
      assert.strictEqual(Number(((await orderRepo.getDailySpent()) - baselineBuySpent).toFixed(8)), 50);
      assert.strictEqual(Number(((await orderRepo.getDailySpent(undefined, 'sell')) - baselineSellSpent).toFixed(8)), 70);

      const afterStats = await statsRepo.getOrCreateToday();
      assert.strictEqual(afterStats.positionsClosed, beforeStats.positionsClosed + 1);
      assert.strictEqual(Number(afterStats.realizedPnl.toFixed(8)), Number((beforeStats.realizedPnl + 20).toFixed(8)));
    });

    it('should reduce positions using FIFO when partially selling after multiple buys', async () => {
      const positionRepo = getPositionRepo();
      const statsRepo = getDailyStatsRepo();
      const beforeStats = await statsRepo.getOrCreateToday();

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-fifo-close',
        marketTitle: 'FIFO Market',
        price: 0.6,
        amountUsd: 30,
        quantity: 50,
      }), 30);

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-fifo-close',
        marketTitle: 'FIFO Market',
        price: 0.4,
        amountUsd: 20,
        quantity: 50,
      }), 20);

      const sellOrder = await followEngine.execute(createTradeEvent({
        eventType: 'SELL',
        conditionId: 'cond-fifo-close',
        marketTitle: 'FIFO Market',
        price: 0.8,
        amountUsd: 40,
        quantity: 50,
      }), 40);

      assert.strictEqual(sellOrder.status, 'executed');

      const openPositions = await positionRepo.find({ conditionId: 'cond-fifo-close', status: 'open' });
      assert.strictEqual(openPositions.length, 1);
      assert.strictEqual(Number(openPositions[0].quantity.toFixed(8)), 50);
      assert.strictEqual(Number(openPositions[0].avgPrice.toFixed(8)), 0.4);
      assert.strictEqual(Number(openPositions[0].costBasis.toFixed(8)), 20);

      const afterStats = await statsRepo.getOrCreateToday();
      assert.strictEqual(Number(afterStats.realizedPnl.toFixed(8)), Number((beforeStats.realizedPnl + 10).toFixed(8)));
    });

    it('should skip a stale sell cleanly when inventory is consumed by an earlier concurrent sell', async () => {
      const positionRepo = getPositionRepo();
      const eventRepo = getEventRepo();

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-stale-sell',
        marketTitle: 'Stale Sell Market',
        price: 0.5,
        amountUsd: 50,
        quantity: 100,
      }), 50);

      const originalExecute = followEngine.execute.bind(followEngine);
      let firstSellDelayed = false;
      followEngine.execute = async (event, amount, config) => {
        if (event.eventType === 'SELL' && !firstSellDelayed) {
          firstSellDelayed = true;
          await delay(50);
        }
        return originalExecute(event, amount, config);
      };

      followEngine.start();

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          txHash: 'tx-stale-sell-1',
          eventType: 'SELL',
          conditionId: 'cond-stale-sell',
          marketTitle: 'Stale Sell Market',
          price: 0.6,
          amountUsd: 60,
          quantity: 100,
        }),
        isNew: true,
      });

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          txHash: 'tx-stale-sell-2',
          eventType: 'SELL',
          conditionId: 'cond-stale-sell',
          marketTitle: 'Stale Sell Market',
          price: 0.6,
          amountUsd: 60,
          quantity: 100,
        }),
        isNew: true,
      });

      await followEngine.waitForIdle();
      followEngine.stop();
      followEngine.execute = originalExecute;

      const stats = followEngine.getStats();
      assert.strictEqual(stats.eventsFollowed, 1);
      assert.strictEqual(stats.eventsSkipped, 1);
      assert.strictEqual(stats.ordersFailed, 0);

      const openPositions = await positionRepo.find({ conditionId: 'cond-stale-sell', status: 'open' });
      assert.strictEqual(openPositions.length, 0);

      const skippedEvents = await eventRepo.find({ txHash: 'tx-stale-sell-2' }, 1);
      assert.strictEqual(skippedEvents.length, 1);
      assert.match(skippedEvents[0].followReason ?? '', /^skipped:risk:\s+No open position available to reduce/i);
    });

    it('should downgrade stale sell execution misses to skipped risk outcomes', async () => {
      const eventRepo = getEventRepo();
      const originalRevalidateDecisionForExecution = (followEngine as any).revalidateDecisionForExecution?.bind(followEngine) as
        ((event: TradeEvent, decision: unknown, config: unknown) => Promise<unknown>) | undefined;

      await followEngine.execute(createTradeEvent({
        conditionId: 'cond-stale-sell-preflight',
        marketTitle: 'Stale Sell Preflight Market',
        price: 0.5,
        amountUsd: 50,
        quantity: 100,
      }), 50);

      (followEngine as any).revalidateDecisionForExecution = async () => ({
        shouldFollow: true,
        reason: 'Stale decision reused.',
        adjustedAmount: 60,
      });

      followEngine.start();

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          txHash: 'tx-stale-preflight-1',
          eventType: 'SELL',
          conditionId: 'cond-stale-sell-preflight',
          marketTitle: 'Stale Sell Preflight Market',
          price: 0.6,
          amountUsd: 60,
          quantity: 100,
        }),
        isNew: true,
      });

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          txHash: 'tx-stale-preflight-2',
          eventType: 'SELL',
          conditionId: 'cond-stale-sell-preflight',
          marketTitle: 'Stale Sell Preflight Market',
          price: 0.6,
          amountUsd: 60,
          quantity: 100,
        }),
        isNew: true,
      });

      await followEngine.waitForIdle();
      followEngine.stop();
      if (originalRevalidateDecisionForExecution) {
        (followEngine as any).revalidateDecisionForExecution = originalRevalidateDecisionForExecution;
      }

      const staleEvent = await eventRepo.find({ txHash: 'tx-stale-preflight-2' }, 1);
      assert.strictEqual(staleEvent.length, 1);
      assert.match(staleEvent[0].followReason ?? '', /^skipped:risk:\s+No open position available to reduce/i);
      assert.strictEqual(followEngine.getStats().ordersFailed, 0);
    });

    it('should persist live fill details and mark matched executions', async () => {
      const orderRepo = getOrderRepo();
      const liveAdapter = getPolymarketAdapter() as ReturnType<typeof getPolymarketAdapter> & {
        getTokenIdForOutcome: (conditionId: string, outcome: string) => Promise<string | null>;
        executeCopyTrade: (params: { tokenId: string; side: 'buy' | 'sell'; amount: number; useMarketOrder?: boolean }) => Promise<unknown>;
      };
      const originalGetTokenIdForOutcome = liveAdapter.getTokenIdForOutcome.bind(liveAdapter);
      const originalExecuteCopyTrade = liveAdapter.executeCopyTrade.bind(liveAdapter);

      setConfigValue('follow.mode', 'live');
      liveAdapter.getTokenIdForOutcome = async () => 'token-live-match';
      liveAdapter.executeCopyTrade = async () => ({
        orderId: 'live-match-1',
        status: 'executed',
        txHash: 'tx-live-match',
        executedPrice: 0.5002,
        executedSize: 20.1,
      });

      try {
        const order = await followEngine.execute(createTradeEvent({
          conditionId: 'cond-live-match',
          marketTitle: 'Live Match Market',
          price: 0.5,
          amountUsd: 10,
          quantity: 20,
        }), 10);

        assert.strictEqual(order.status, 'executed');
        assert.strictEqual(order.txHash, 'tx-live-match');
        assert.strictEqual(order.reconcileStatus, 'matched');
        assert.ok(typeof order.executedSize === 'number');
        assert.ok(typeof order.executedAmountUsd === 'number');

        const stored = await orderRepo.getById(order.id!);
        assert.ok(stored);
        assert.strictEqual(stored.reconcileStatus, 'matched');
        assert.strictEqual(stored.txHash, 'tx-live-match');
        assert.ok(typeof stored.executedSize === 'number');
        assert.ok(typeof stored.executedAmountUsd === 'number');
        assert.strictEqual(stored.reconcileReason, null);
      } finally {
        liveAdapter.getTokenIdForOutcome = originalGetTokenIdForOutcome;
        liveAdapter.executeCopyTrade = originalExecuteCopyTrade;
        setConfigValue('follow.mode', 'shadow');
      }
    });

    it('should flag live execution drift when actual fill materially differs', async () => {
      const orderRepo = getOrderRepo();
      const liveAdapter = getPolymarketAdapter() as ReturnType<typeof getPolymarketAdapter> & {
        getTokenIdForOutcome: (conditionId: string, outcome: string) => Promise<string | null>;
        executeCopyTrade: (params: { tokenId: string; side: 'buy' | 'sell'; amount: number; useMarketOrder?: boolean }) => Promise<unknown>;
      };
      const originalGetTokenIdForOutcome = liveAdapter.getTokenIdForOutcome.bind(liveAdapter);
      const originalExecuteCopyTrade = liveAdapter.executeCopyTrade.bind(liveAdapter);

      setConfigValue('follow.mode', 'live');
      liveAdapter.getTokenIdForOutcome = async () => 'token-live-drift';
      liveAdapter.executeCopyTrade = async () => ({
        orderId: 'live-drift-1',
        status: 'executed',
        txHash: 'tx-live-drift',
        executedPrice: 0.62,
        executedSize: 15,
      });

      try {
        const order = await followEngine.execute(createTradeEvent({
          conditionId: 'cond-live-drift',
          marketTitle: 'Live Drift Market',
          price: 0.5,
          amountUsd: 10,
          quantity: 20,
        }), 10);

        assert.strictEqual(order.status, 'executed');
        assert.strictEqual(order.reconcileStatus, 'drifted');
        assert.ok(order.reconcileReason?.includes('size'));
        assert.ok(order.reconcileReason?.includes('price'));
        assert.strictEqual(Number(order.executedAmountUsd!.toFixed(8)), 9.3);

        const stored = await orderRepo.getById(order.id!);
        assert.ok(stored);
        assert.strictEqual(stored.reconcileStatus, 'drifted');
        assert.ok(stored.reconcileReason?.includes('size'));
        assert.strictEqual(Number(stored.executedAmountUsd!.toFixed(8)), 9.3);
        assert.ok(typeof stored.lastReconciledAt === 'number');
      } finally {
        liveAdapter.getTokenIdForOutcome = originalGetTokenIdForOutcome;
        liveAdapter.executeCopyTrade = originalExecuteCopyTrade;
        setConfigValue('follow.mode', 'shadow');
      }
    });
  });

  describe('followOnce()', () => {
    it('should reuse proportional sizing when no explicit amount is provided', async () => {
      const eventRepo = getEventRepo();
      setConfigValue('follow.mode', 'shadow');
      setConfigValue('follow.sizingMode', 'proportional');
      setConfigValue('follow.bankrollUsd', 1000);
      setConfigValue('follow.maxPerTrade', 100);

      adapter.fetchPositions = async () => [{
        leaderAddress: '0xleader123',
        platform: 'polymarket' as const,
        conditionId: 'cond-proportional',
        outcome: 'YES' as const,
        quantity: 1,
        avgPrice: 1,
        costBasis: 5000,
        status: 'open' as const,
        realizedPnl: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const savedEvent = await eventRepo.save({
        leaderAddress: '0xleader123',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-follow-once',
        marketTitle: 'Follow Once Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 100,
        amountUsd: 50,
        txHash: 'tx-follow-once',
        timestamp: Date.now(),
        followed: 0,
        createdAt: Date.now(),
      });

      const order = await followEngine.followOnce(savedEvent.id);

      assert.strictEqual(order.status, 'executed');
      assert.strictEqual(order.amountUsd, 10);
    });
  });

  describe('getStats()', () => {
    it('should return initial stats', () => {
      const stats = followEngine.getStats();

      assert.strictEqual(stats.eventsEnqueued, 0);
      assert.strictEqual(stats.eventsEvaluated, 0);
      assert.strictEqual(stats.eventsFollowed, 0);
      assert.strictEqual(stats.eventsSkipped, 0);
      assert.strictEqual(stats.ordersExecuted, 0);
      assert.strictEqual(stats.ordersFailed, 0);
      assert.strictEqual(stats.totalAmountUsd, 0);
      assert.strictEqual(stats.queueDepth, 0);
      assert.strictEqual(stats.maxQueueDepth, 0);
      assert.strictEqual(stats.lastEvaluatedAt, null);
      assert.strictEqual(stats.lastDecisionReason, null);
      assert.strictEqual(stats.lastError, null);
    });

    it('should reset stats', () => {
      // Modify stats somehow (via internal state)
      followEngine.resetStats();
      const stats = followEngine.getStats();

      assert.strictEqual(stats.eventsEnqueued, 0);
      assert.strictEqual(stats.eventsEvaluated, 0);
      assert.strictEqual(stats.totalAmountUsd, 0);
      assert.strictEqual(stats.queueDepth, 0);
      assert.strictEqual(stats.maxQueueDepth, 0);
      assert.strictEqual(stats.lastError, null);
    });

    it('should record structured execution failures', async () => {
      const adapter = getPolymarketAdapter() as ReturnType<typeof getPolymarketAdapter> & {
        getTokenIdForOutcome: (conditionId: string, outcome: string) => Promise<string | null>;
        executeCopyTrade: (params: { tokenId: string; side: 'buy' | 'sell'; amount: number; useMarketOrder?: boolean }) => Promise<unknown>;
      };
      const originalGetTokenIdForOutcome = adapter.getTokenIdForOutcome.bind(adapter);
      const originalExecuteCopyTrade = adapter.executeCopyTrade.bind(adapter);

      setConfigValue('follow.mode', 'live');
      adapter.getTokenIdForOutcome = async () => 'token-yes';
      adapter.executeCopyTrade = async () => {
        throw new StructuredFailure(createFailureInfo({
          code: 'dependency_unavailable',
          source: 'polymarket_cli',
          operation: 'polymarket clob market-order',
          message: 'wallet unavailable',
          retryable: false,
        }));
      };

      followEngine.start();

      const followError = eventBus.waitFor('follow:error', 1000);
      eventBus.emit('trade:new', {
        event: {
          leaderAddress: '0xleader123',
          platform: 'polymarket',
          eventType: 'BUY',
          conditionId: 'cond-live-failure',
          marketTitle: 'Live Failure Market',
          outcome: 'YES',
          price: 0.5,
          quantity: 100,
          amountUsd: 50,
          txHash: 'tx-live-failure',
          timestamp: Date.now(),
          followed: false,
          createdAt: Date.now(),
        },
        isNew: true,
      });

      const payload = await followError;
      const stats = followEngine.getStats();

      assert.strictEqual(payload.detail?.code, 'dependency_unavailable');
      assert.strictEqual(stats.ordersFailed, 1);
      assert.strictEqual(stats.lastDecisionShouldFollow, true);
      assert.strictEqual(stats.lastError?.code, 'dependency_unavailable');
      assert.strictEqual(stats.lastError?.source, 'polymarket_cli');
      const failedEvents = await getEventRepo().find({ txHash: 'tx-live-failure' }, 1);
      assert.strictEqual(failedEvents.length, 1);
      assert.strictEqual(failedEvents[0].followed, 0);
      assert.match(failedEvents[0].followReason ?? '', /^error:dependency:\s+wallet unavailable$/i);

      followEngine.stop();
      adapter.getTokenIdForOutcome = originalGetTokenIdForOutcome;
      adapter.executeCopyTrade = originalExecuteCopyTrade;
      setConfigValue('follow.mode', 'shadow');
    });
  });

  describe('start/stop', () => {
    it('should start and stop listening', () => {
      assert.strictEqual(followEngine.isListening(), false);
      assert.strictEqual(eventBus.listenerCount('trade:new'), 0);

      followEngine.start();
      assert.strictEqual(followEngine.isListening(), true);
      assert.strictEqual(eventBus.listenerCount('trade:new'), 1);

      followEngine.stop();
      assert.strictEqual(followEngine.isListening(), false);
      assert.strictEqual(eventBus.listenerCount('trade:new'), 0);
    });

    it('should not start twice', () => {
      followEngine.start();
      followEngine.start(); // Should not throw
      assert.strictEqual(followEngine.isListening(), true);
      assert.strictEqual(eventBus.listenerCount('trade:new'), 1);

      followEngine.stop();
      assert.strictEqual(eventBus.listenerCount('trade:new'), 0);
    });

    it('should serialize concurrent trade events so maxPositions is not exceeded', async () => {
      const positionRepo = getPositionRepo();
      const baselineOpenPositions = await positionRepo.count({ status: 'open' });
      setConfigValue('risk.maxPositions', baselineOpenPositions + 1);
      setConfigValue('risk.maxExposure', 10_000);
      setConfigValue('follow.dailyLimit', 10_000);

      const originalCheckRiskLimits = (followEngine as any).checkRiskLimits.bind(followEngine) as
        (amountUsd: number, config: ReturnType<typeof getConfig>) => Promise<{ shouldFollow: boolean; reason: string }>;

      let riskChecksEntered = 0;
      let releaseRiskChecks: (() => void) | null = null;
      const riskCheckGate = new Promise<void>((resolve) => {
        releaseRiskChecks = resolve;
      });

      (followEngine as any).checkRiskLimits = async (amountUsd: number, config: ReturnType<typeof getConfig>) => {
        const decision = await originalCheckRiskLimits(amountUsd, config);
        if (!decision.shouldFollow) {
          return decision;
        }

        riskChecksEntered += 1;
        if (riskChecksEntered === 2) {
          releaseRiskChecks?.();
        }

        await Promise.race([riskCheckGate, delay(50)]);
        return decision;
      };

      followEngine.start();

      const outcomes = await new Promise<{ executed: number; skipped: number }>((resolve, reject) => {
        let executed = 0;
        let skipped = 0;

        const cleanup = () => {
          eventBus.off('follow:executed', onExecuted);
          eventBus.off('follow:skipped', onSkipped);
          clearTimeout(timeoutId);
        };

        const finishIfDone = () => {
          if (executed + skipped < 2) {
            return;
          }
          cleanup();
          resolve({ executed, skipped });
        };

        const onExecuted = () => {
          executed += 1;
          finishIfDone();
        };

        const onSkipped = () => {
          skipped += 1;
          finishIfDone();
        };

        const timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Timed out waiting for concurrent follow outcomes.'));
        }, 2_000);

        eventBus.on('follow:executed', onExecuted);
        eventBus.on('follow:skipped', onSkipped);

        eventBus.emit('trade:new', {
          event: createTradeEvent({
            conditionId: 'cond-concurrency-a',
            marketTitle: 'Concurrency A',
            amountUsd: 20,
            quantity: 40,
          }),
          isNew: true,
        });

        eventBus.emit('trade:new', {
          event: createTradeEvent({
            conditionId: 'cond-concurrency-b',
            marketTitle: 'Concurrency B',
            amountUsd: 20,
            quantity: 40,
          }),
          isNew: true,
        });
      });

      const finalOpenPositions = await positionRepo.count({ status: 'open' });

      assert.strictEqual(outcomes.executed, 1);
      assert.strictEqual(outcomes.skipped, 1);
      assert.strictEqual(finalOpenPositions, baselineOpenPositions + 1);

      followEngine.stop();
    });

    it('should process different markets concurrently when worker capacity is available', async () => {
      followEngine = new FollowEngine({ maxConcurrentEvents: 2 });

      const originalExecute = followEngine.execute.bind(followEngine);
      let inFlightExecutions = 0;
      let concurrentExecutionObserved = false;
      let releaseExecutions: (() => void) | null = null;
      const executionGate = new Promise<void>((resolve) => {
        releaseExecutions = resolve;
      });

      followEngine.execute = (async (event, amount, config) => {
        inFlightExecutions += 1;
        if (inFlightExecutions >= 2) {
          concurrentExecutionObserved = true;
        }

        await executionGate;

        try {
          return await originalExecute(event, amount, config);
        } finally {
          inFlightExecutions -= 1;
        }
      }) as typeof followEngine.execute;

      followEngine.start();

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          conditionId: 'cond-parallel-a',
          marketTitle: 'Parallel A',
          amountUsd: 20,
          quantity: 40,
        }),
        isNew: true,
      });

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          conditionId: 'cond-parallel-b',
          marketTitle: 'Parallel B',
          amountUsd: 20,
          quantity: 40,
        }),
        isNew: true,
      });

      for (let attempt = 0; attempt < 20 && !concurrentExecutionObserved; attempt += 1) {
        await delay(10);
      }

      assert.strictEqual(concurrentExecutionObserved, true);

      releaseExecutions?.();
      await followEngine.waitForIdle();
      followEngine.stop();
    });

    it('should drain queued trade events after stop when waiting for idle', async () => {
      followEngine = new FollowEngine({ maxConcurrentEvents: 1 });
      const originalExecute = followEngine.execute.bind(followEngine);
      const executedConditions: string[] = [];

      followEngine.execute = (async (event, amount, config) => {
        await delay(25);
        executedConditions.push(event.conditionId);
        return originalExecute(event, amount, config);
      }) as typeof followEngine.execute;

      followEngine.start();

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          conditionId: 'cond-drain-a',
          marketTitle: 'Drain A',
          amountUsd: 20,
          quantity: 40,
        }),
        isNew: true,
      });

      eventBus.emit('trade:new', {
        event: createTradeEvent({
          conditionId: 'cond-drain-b',
          marketTitle: 'Drain B',
          amountUsd: 20,
          quantity: 40,
        }),
        isNew: true,
      });

      const queuedStats = followEngine.getStats();
      assert.strictEqual(queuedStats.eventsEnqueued, 2);
      assert.strictEqual(queuedStats.maxQueueDepth, 2);
      assert.ok(queuedStats.queueDepth >= 1);

      followEngine.stop();
      await followEngine.waitForIdle();

      assert.deepStrictEqual(executedConditions, ['cond-drain-a', 'cond-drain-b']);
      assert.strictEqual(followEngine.getStats().queueDepth, 0);
    });

    it('should persist skipped follow reasons onto the event record', async () => {
      setConfigValue('follow.allowlist', ['0xanotherleader']);
      followEngine.start();

      const skipped = eventBus.waitFor('follow:skipped', 1000);
      eventBus.emit('trade:new', {
        event: createTradeEvent({
          conditionId: 'cond-skip-persist',
          marketTitle: 'Skip Persist Market',
          txHash: 'tx-skip-persist',
        }),
        isNew: true,
      });

      await skipped;

      const skippedEvents = await getEventRepo().find({ txHash: 'tx-skip-persist' }, 1);
      assert.strictEqual(skippedEvents.length, 1);
      assert.strictEqual(skippedEvents[0].followed, 0);
      assert.match(skippedEvents[0].followReason ?? '', /^skipped:policy:\s+Leader not in allowlist$/i);

      followEngine.stop();
      setConfigValue('follow.allowlist', []);
    });
  });
});
