/**
 * CopyHunter - Watch Engine Tests
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up test data directory before importing modules
const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-watch-test-'));
process.env.XDG_DATA_HOME = testDataDir;

import {
  getDb,
  closeDb,
  dailyStats,
  events,
  leaders,
  orders,
  positionLots,
  positions,
  watchCursors,
} from '../../src/db/index.js';
import { getEventRepo, getLeaderRepo, getWatchCursorRepo } from '../../src/db/repositories/index.js';
import { WatchEngine } from '../../src/watch/engine.js';
import { eventBus } from '../../src/core/events.js';
import type { TradeEvent } from '../../src/core/types.js';
import { StructuredFailure, createFailureInfo } from '../../src/core/failures.js';
import type { TradeHistoryWindowOptions, TradeHistoryWindowResult } from '../../src/platforms/polymarket/data-api.js';
import { getTradeIdentityKey } from '../../src/core/trade-identity.js';

describe('WatchEngine Tests', () => {
  let watchEngine: WatchEngine;
  let tradeCalls: Array<{ address: string; limit: number }>;
  let historyCalls: Array<{ address: string; options: TradeHistoryWindowOptions }>;
  let tradeHistoryByAddress: Record<string, TradeEvent[]>;

  function makeTrade(params: {
    leaderAddress: string;
    txHash: string;
    timestamp: number;
    amountUsd?: number;
    conditionId?: string;
  }): TradeEvent {
    return {
      leaderAddress: params.leaderAddress,
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: params.conditionId ?? `cond-${params.txHash}`,
      marketTitle: `Market ${params.txHash}`,
      outcome: 'YES',
      price: 0.5,
      quantity: (params.amountUsd ?? 50) / 0.5,
      amountUsd: params.amountUsd ?? 50,
      txHash: params.txHash,
      timestamp: params.timestamp,
      followed: false,
      createdAt: params.timestamp,
    };
  }

  function createWatchEngine() {
    tradeCalls = [];
    historyCalls = [];
    watchEngine = new WatchEngine(
      {
        interval: 60000,
        filterMinUsd: 10,
        maxEventsPerPoll: 2,
        maxTradeHistoryFetch: 6,
      },
      {
        tradeSource: {
          getTrades: async (address: string, limit = 100) => {
            tradeCalls.push({ address: address.toLowerCase(), limit });
            return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
          },
        },
        tradeHistorySource: {
          getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
            historyCalls.push({ address: address.toLowerCase(), options });
            const normalizedAddress = address.toLowerCase();
            const trades = (tradeHistoryByAddress[normalizedAddress] ?? [])
              .filter((trade) => trade.timestamp >= options.fromTimestamp && trade.timestamp <= options.toTimestamp)
              .sort((a, b) => b.timestamp - a.timestamp);

            return {
              trades,
              pagesFetched: 1,
              latestTimestamp: trades[0]?.timestamp ?? null,
              oldestTimestamp: trades[trades.length - 1]?.timestamp ?? null,
              windowComplete: true,
              pageBudgetReached: false,
              apiOffsetCapReached: false,
            };
          },
        },
      }
    );
  }

  before(async () => {
    // Initialize database
    getDb();
  });

  after(() => {
    closeDb();
    try {
      rmSync(testDataDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    const db = getDb();
    await db.delete(orders);
    await db.delete(positionLots);
    await db.delete(positions);
    await db.delete(events);
    await db.delete(watchCursors);
    await db.delete(dailyStats);
    await db.delete(leaders);

    tradeHistoryByAddress = {};
    createWatchEngine();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const engine = new WatchEngine();
      const stats = engine.getStats();

      assert.strictEqual(stats.isRunning, false);
      assert.strictEqual(stats.pollCount, 0);
      assert.strictEqual(stats.eventsFound, 0);
    });

    it('should accept custom options', () => {
      const engine = new WatchEngine({
        interval: 5000,
        filterMinUsd: 50,
        maxEventsPerPoll: 100,
      });

      assert.ok(engine);
    });
  });

  describe('getStats()', () => {
    it('should return initial stats', () => {
      const stats = watchEngine.getStats();

      assert.strictEqual(stats.isRunning, false);
      assert.strictEqual(stats.pollCount, 0);
      assert.strictEqual(stats.eventsFound, 0);
      assert.strictEqual(stats.eventsSaved, 0);
      assert.strictEqual(stats.currentPollStartedAt, null);
      assert.strictEqual(stats.leadersCompletedInPoll, 0);
      assert.strictEqual(stats.currentLeaderAddress, null);
      assert.strictEqual(stats.currentLeaderStartedAt, null);
      assert.strictEqual(stats.currentLeaderPass, 0);
      assert.strictEqual(stats.currentLeaderEventsFound, 0);
      assert.strictEqual(stats.currentLeaderEventsSaved, 0);
      assert.strictEqual(stats.lastPollAt, null);
      assert.strictEqual(stats.lastSuccessfulPollAt, null);
      assert.strictEqual(stats.errors, 0);
      assert.strictEqual(stats.consecutiveErrors, 0);
      assert.strictEqual(stats.lastError, null);
    });
  });

  describe('isRunning()', () => {
    it('should return false initially', () => {
      assert.strictEqual(watchEngine.isRunning(), false);
    });
  });

  describe('start()', () => {
    it('should throw if no leaders', async () => {
      await assert.rejects(
        async () => {
          await watchEngine.start();
        },
        {
          message: /No leaders to monitor/,
        }
      );
    });

    it('should start when leaders exist', async () => {
      // Add a leader first
      const leaderRepo = getLeaderRepo();
      tradeHistoryByAddress['0xwatchtest123'] = [
        makeTrade({ leaderAddress: '0xwatchtest123', txHash: 'tx-start', timestamp: 1000 }),
      ];
      await leaderRepo.add({
        address: '0xwatchtest123',
        alias: 'WatchTestLeader',
      });

      // Track events
      let startedEmitted = false;
      eventBus.once('watch:started', () => {
        startedEmitted = true;
      });

      await watchEngine.start();
      assert.strictEqual(watchEngine.isRunning(), true);
      assert.strictEqual(startedEmitted, true);
      watchEngine.stop();
    });
  });

  describe('stop()', () => {
    it('should stop gracefully', async () => {
      const leaderRepo = getLeaderRepo();
      // Ensure leader exists
      const exists = await leaderRepo.exists('0xwatchtest123');
      if (!exists) {
        tradeHistoryByAddress['0xwatchtest123'] = [];
        await leaderRepo.add({
          address: '0xwatchtest123',
          alias: 'WatchTestLeader',
        });
      }

      let stoppedEmitted = false;
      eventBus.once('watch:stopped', () => {
        stoppedEmitted = true;
      });

      await watchEngine.start();

      watchEngine.stop();
      assert.strictEqual(watchEngine.isRunning(), false);
      assert.strictEqual(stoppedEmitted, true);
    });

    it('should not throw if already stopped', () => {
      watchEngine.stop();
      watchEngine.stop(); // Should not throw
      assert.strictEqual(watchEngine.isRunning(), false);
    });
  });

  describe('updateOptions()', () => {
    it('should update options', () => {
      watchEngine.updateOptions({
        interval: 10000,
        filterMinUsd: 25,
      });

      // Options are internal, but we can verify engine still works
      assert.ok(watchEngine);
    });
  });

  describe('poll()', () => {
    it('should publish incremental leader progress before the poll completes', async () => {
      const leaderAddress = '0xprogress-leader';
      const leaderRepo = getLeaderRepo();
      const progressSnapshots: Array<{
        eventsFound: number;
        leadersCompletedInPoll: number;
        currentLeaderAddress: string | null;
        currentLeaderPass: number;
        currentLeaderEventsFound: number;
      }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 6,
        },
        {
          tradeSource: {
            getTrades: async (address: string, limit = 100) => {
              return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
            },
          },
          tradeHistorySource: null,
          onStatsUpdated: (stats) => {
            progressSnapshots.push({
              eventsFound: stats.eventsFound,
              leadersCompletedInPoll: stats.leadersCompletedInPoll,
              currentLeaderAddress: stats.currentLeaderAddress,
              currentLeaderPass: stats.currentLeaderPass,
              currentLeaderEventsFound: stats.currentLeaderEventsFound,
            });
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'ProgressLeader' });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-6', timestamp: 7000 }),
        makeTrade({ leaderAddress, txHash: 'tx-5', timestamp: 6000 }),
        makeTrade({ leaderAddress, txHash: 'tx-4', timestamp: 5000 }),
        makeTrade({ leaderAddress, txHash: 'tx-3', timestamp: 4000 }),
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
      ];

      const newEvents = await watchEngine.poll();

      assert.strictEqual(newEvents.length, 6);
      assert.ok(progressSnapshots.some((snapshot) =>
        snapshot.currentLeaderAddress === leaderAddress
        && snapshot.currentLeaderPass >= 1
        && snapshot.currentLeaderEventsFound > 0
        && snapshot.leadersCompletedInPoll === 0
      ));
      assert.ok(progressSnapshots.some((snapshot) =>
        snapshot.eventsFound === 6
        && snapshot.leadersCompletedInPoll === 1
      ));
    });

    it('should yield to the event loop while emitting large trade catch-up batches', async () => {
      const leaderAddress = '0xyield-leader';
      const leaderRepo = getLeaderRepo();
      const cursorRepo = getWatchCursorRepo();
      let yieldCalls = 0;

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 200,
          maxTradeHistoryFetch: 200,
          eventLoopYieldEvery: 25,
        },
        {
          tradeSource: {
            getTrades: async (address: string, limit = 100) => {
              tradeCalls.push({ address: address.toLowerCase(), limit });
              return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
            },
          },
          tradeHistorySource: null,
          yieldToEventLoop: async () => {
            yieldCalls += 1;
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'YieldLeader' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = Array.from({ length: 80 }, (_, index) =>
        makeTrade({
          leaderAddress,
          txHash: `tx-yield-${index}`,
          timestamp: 10_000 - index,
          amountUsd: 20,
          conditionId: `cond-yield-${index}`,
        })
      );

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.strictEqual(newEvents.length, 80);
      assert.ok(yieldCalls >= 3);
    });

    it('should capture late-arriving trades with the same timestamp', async () => {
      const leaderAddress = '0xsame-second-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'SameSecond' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-b', timestamp: 1000 }),
        makeTrade({ leaderAddress, txHash: 'tx-a', timestamp: 1000 }),
      ];

      const firstPoll = await watchEngine.poll();
      assert.strictEqual(firstPoll.length, 2);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-c', timestamp: 1000 }),
        makeTrade({ leaderAddress, txHash: 'tx-b', timestamp: 1000 }),
        makeTrade({ leaderAddress, txHash: 'tx-a', timestamp: 1000 }),
      ];

      const secondPoll = await watchEngine.poll();
      assert.strictEqual(secondPoll.length, 1);
      assert.strictEqual(secondPoll[0].txHash, 'tx-c');

      const events = await eventRepo.find({ leaderAddress }, 10);
      assert.strictEqual(events.length, 3);
    });

    it('should persist below-minimum trades while emitting them as filtered', async () => {
      const leaderAddress = '0xfiltered-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'Filtered' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-small', timestamp: 1000, amountUsd: 5 }),
      ];

      let filteredReason: string | null = null;
      let emittedNewTrade = false;
      eventBus.once('trade:filtered', ({ reason }) => {
        filteredReason = reason;
      });
      eventBus.once('trade:new', () => {
        emittedNewTrade = true;
      });

      const newEvents = await watchEngine.poll();

      assert.strictEqual(newEvents.length, 1);
      assert.strictEqual(emittedNewTrade, false);
      assert.ok(filteredReason?.includes('below minimum'));

      const storedEvents = await eventRepo.find({ leaderAddress }, 10);
      assert.strictEqual(storedEvents.length, 1);
      assert.strictEqual(storedEvents[0].amountUsd, 5);
    });

    it('should expand the fetch window when new trades overflow one page', async () => {
      const leaderAddress = '0xoverflow-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 6,
        },
        {
          tradeSource: {
            getTrades: async (address: string, limit = 100) => {
              tradeCalls.push({ address: address.toLowerCase(), limit });
              return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
            },
          },
          tradeHistorySource: null,
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'Overflow' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
        makeTrade({ leaderAddress, txHash: 'tx-old', timestamp: 900 }),
      ];

      await watchEngine.pollLeader(leaderAddress);
      tradeCalls = [];

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-5', timestamp: 5000 }),
        makeTrade({ leaderAddress, txHash: 'tx-4', timestamp: 4000 }),
        makeTrade({ leaderAddress, txHash: 'tx-3', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
        makeTrade({ leaderAddress, txHash: 'tx-old', timestamp: 900 }),
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        tradeCalls
          .filter((call) => call.address === leaderAddress)
          .map((call) => call.limit),
        [2, 4]
      );
      assert.deepStrictEqual(
        newEvents.map((event) => event.txHash),
        ['tx-3', 'tx-4', 'tx-5']
      );

      const events = await eventRepo.find({ leaderAddress }, 10);
      assert.strictEqual(events.length, 5);
    });

    it('should recover when the stored cursor is ahead of local event history', async () => {
      const leaderAddress = '0xcursor-recovery-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'CursorRecovery' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-old',
        marketTitle: 'Old Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: 'tx-old-local',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 5000,
        cursorTradeKeys: ['tx-cursor-newer'],
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-new', timestamp: 6000, amountUsd: 25 }),
        makeTrade({ leaderAddress, txHash: 'tx-mid', timestamp: 3000, amountUsd: 15 }),
        makeTrade({
          leaderAddress,
          txHash: 'tx-old-local',
          timestamp: 1000,
          amountUsd: 10,
          conditionId: 'cond-old',
        }),
      ];

      const newEvents = await watchEngine.poll();

      assert.deepStrictEqual(
        newEvents
          .filter((event) => event.leaderAddress === leaderAddress)
          .map((event) => event.txHash),
        ['tx-mid', 'tx-new']
      );

      const storedEvents = await eventRepo.find({ leaderAddress }, 10);
      assert.strictEqual(storedEvents.length, 3);

      const updatedCursor = await cursorRepo.getByLeader(leaderAddress);
      assert.ok(updatedCursor);
      assert.strictEqual(updatedCursor?.cursorTimestamp, 6000);
    });

    it('should heal a stored cursor that is behind local persisted history', async () => {
      const leaderAddress = '0xcursor-heal-behind-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'CursorHealBehind' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-latest',
        marketTitle: 'Latest Market',
        outcome: 'YES',
        price: 0.6,
        quantity: 10,
        amountUsd: 6,
        txHash: 'tx-local-latest',
        timestamp: 5000,
        followed: 0,
        createdAt: 5000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: ['stale-key'],
      });

      tradeHistoryByAddress[leaderAddress] = [
        {
          leaderAddress,
          platform: 'polymarket',
          eventType: 'BUY',
          timestamp: 5000,
          conditionId: 'cond-latest',
          marketTitle: 'Latest Market',
          outcome: 'YES',
          price: 0.6,
          quantity: 10,
          amountUsd: 6,
          txHash: 'tx-local-latest',
          followed: false,
          createdAt: 5000,
        },
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.strictEqual(newEvents.length, 0);

      const healedCursor = await cursorRepo.getByLeader(leaderAddress);
      assert.ok(healedCursor);
      assert.strictEqual(healedCursor?.cursorTimestamp, 5000);
      assert.deepStrictEqual(healedCursor?.cursorTradeKeys, [
        getTradeIdentityKey({
          leaderAddress,
          conditionId: 'cond-latest',
          eventType: 'BUY',
          outcome: 'YES',
          timestamp: 5000,
          price: 0.6,
          quantity: 10,
          txHash: 'tx-local-latest',
        }),
      ]);
    });

    it('should not skip newer fills that reuse an existing tx hash', async () => {
      const leaderAddress = '0xshared-tx-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'SharedTx' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({
          leaderAddress,
          txHash: 'tx-shared',
          timestamp: 1000,
          conditionId: 'cond-a',
        }),
      ];

      await watchEngine.pollLeader(leaderAddress);

      const newerSharedTrade = makeTrade({
        leaderAddress,
        txHash: 'tx-shared',
        timestamp: 2000,
        conditionId: 'cond-b',
      });
      const olderSharedTrade = makeTrade({
        leaderAddress,
        txHash: 'tx-shared',
        timestamp: 1000,
        conditionId: 'cond-a',
      });

      tradeHistoryByAddress[leaderAddress] = [newerSharedTrade, olderSharedTrade];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        newEvents.map((event) => event.conditionId),
        ['cond-b']
      );

      const storedEvents = await eventRepo.find({ leaderAddress }, 10);
      assert.strictEqual(storedEvents.length, 2);
      assert.deepStrictEqual(
        storedEvents.map((event) => event.conditionId).sort(),
        ['cond-a', 'cond-b']
      );

      const updatedCursor = await cursorRepo.getByLeader(leaderAddress);
      assert.ok(updatedCursor);
      assert.strictEqual(updatedCursor?.cursorTimestamp, 2000);
      assert.deepStrictEqual(updatedCursor?.cursorTradeKeys, [getTradeIdentityKey(newerSharedTrade)]);
    });

    it('should advance cursor before emitting newly persisted trades', async () => {
      const leaderAddress = '0xcursor-before-emit-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'CursorBeforeEmit' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-tx-anchor',
        marketTitle: 'Anchor Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 100,
        amountUsd: 50,
        txHash: 'tx-anchor',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: [getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-anchor',
          timestamp: 1000,
        }))],
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
      ];

      let cursorSeenAtFirstEmission: Awaited<ReturnType<typeof cursorRepo.getByLeader>> | undefined;
      const observedCursor = new Promise<void>((resolve) => {
        eventBus.once('trade:detected', () => {
          void cursorRepo.getByLeader(leaderAddress).then((cursor) => {
            cursorSeenAtFirstEmission = cursor;
            resolve();
          });
        });
      });

      const newEvents = await watchEngine.pollLeader(leaderAddress);
      await observedCursor;

      assert.deepStrictEqual(
        newEvents.map((event) => event.txHash),
        ['tx-1', 'tx-2']
      );
      assert.ok(cursorSeenAtFirstEmission);
      assert.strictEqual(cursorSeenAtFirstEmission?.cursorTimestamp, 3000);
      assert.deepStrictEqual(cursorSeenAtFirstEmission?.cursorTradeKeys, [
        getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-2',
          timestamp: 3000,
        })),
      ]);
    });

    it('should use paginated history fetches to catch up beyond the recent trade limit', async () => {
      const leaderAddress = '0xcatchup-leader';
      const leaderRepo = getLeaderRepo();
      const cursorRepo = getWatchCursorRepo();
      const localTradeCalls: Array<{ address: string; limit: number }> = [];
      const localHistoryCalls: Array<{ address: string; options: TradeHistoryWindowOptions }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 6,
        },
        {
          tradeSource: {
            getTrades: async (address: string, limit = 100) => {
              localTradeCalls.push({ address: address.toLowerCase(), limit });
              return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
            },
          },
          tradeHistorySource: {
            getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
              localHistoryCalls.push({ address: address.toLowerCase(), options });
              const normalizedAddress = address.toLowerCase();
              const trades = (tradeHistoryByAddress[normalizedAddress] ?? [])
                .filter((trade) => trade.timestamp >= options.fromTimestamp && trade.timestamp <= options.toTimestamp)
                .sort((a, b) => b.timestamp - a.timestamp);

              return {
                trades,
                pagesFetched: 1,
                latestTimestamp: trades[0]?.timestamp ?? null,
                oldestTimestamp: trades[trades.length - 1]?.timestamp ?? null,
                windowComplete: true,
                pageBudgetReached: false,
                apiOffsetCapReached: false,
              };
            },
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'Catchup' });
      await cursorRepo.clear(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
      ];

      await watchEngine.pollLeader(leaderAddress);

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-6', timestamp: 7000 }),
        makeTrade({ leaderAddress, txHash: 'tx-5', timestamp: 6000 }),
        makeTrade({ leaderAddress, txHash: 'tx-4', timestamp: 5000 }),
        makeTrade({ leaderAddress, txHash: 'tx-3', timestamp: 4000 }),
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        newEvents
          .filter((event) => event.leaderAddress === leaderAddress)
          .map((event) => event.txHash),
        ['tx-1', 'tx-2', 'tx-3', 'tx-4', 'tx-5', 'tx-6']
      );
      assert.strictEqual(localHistoryCalls.filter((call) => call.address === leaderAddress).length, 1);
      assert.strictEqual(localHistoryCalls[0]?.options.anchor, 'from');
      assert.strictEqual(localTradeCalls.filter((call) => call.address === leaderAddress).length, 1);
    });

    it('should honor the configured history fetch budget instead of forcing oversized batches', async () => {
      const leaderAddress = '0xhistory-budget-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();
      const localHistoryCalls: Array<{ address: string; options: TradeHistoryWindowOptions }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 50,
          maxTradeHistoryFetch: 120,
        },
        {
          now: () => 1_500,
          tradeSource: {
            getTrades: async () => [],
          },
          tradeHistorySource: {
            getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
              localHistoryCalls.push({ address: address.toLowerCase(), options });
              return {
                trades: [],
                pagesFetched: 0,
                latestTimestamp: null,
                oldestTimestamp: null,
                windowComplete: true,
                pageBudgetReached: false,
                apiOffsetCapReached: false,
              };
            },
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'HistoryBudget' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-tx-anchor',
        marketTitle: 'Anchor Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 100,
        amountUsd: 50,
        txHash: 'tx-anchor',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: [getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-anchor',
          timestamp: 1000,
        }))],
      });

      await watchEngine.pollLeader(leaderAddress);

      assert.strictEqual(localHistoryCalls.length, 1);
      assert.strictEqual(localHistoryCalls[0]?.options.anchor, 'from');
      assert.strictEqual(localHistoryCalls[0]?.options.pageLimit, 120);
      assert.strictEqual(localHistoryCalls[0]?.options.maxPages, 1);
    });

    it('should continue catch-up across multiple history batches in one poll', async () => {
      const leaderAddress = '0xmulti-batch-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();
      const localHistoryCalls: Array<{ address: string; options: TradeHistoryWindowOptions }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 6,
          maxCatchUpPasses: 3,
        },
        {
          tradeSource: {
            getTrades: async () => [],
          },
          tradeHistorySource: {
            getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
              localHistoryCalls.push({ address: address.toLowerCase(), options });
              const normalizedAddress = address.toLowerCase();
              const allTrades = (tradeHistoryByAddress[normalizedAddress] ?? [])
                .filter((trade) => trade.timestamp > options.fromTimestamp && trade.timestamp <= options.toTimestamp)
                .sort((a, b) => a.timestamp - b.timestamp);

              const batch = allTrades.slice(0, 2).sort((a, b) => b.timestamp - a.timestamp);
              const latestTimestamp = batch[0]?.timestamp ?? null;

              return {
                trades: batch,
                pagesFetched: 1,
                latestTimestamp,
                oldestTimestamp: batch[batch.length - 1]?.timestamp ?? null,
                windowComplete: batch.length === allTrades.length,
                pageBudgetReached: batch.length < allTrades.length,
                apiOffsetCapReached: false,
              };
            },
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'MultiBatch' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-tx-anchor',
        marketTitle: 'Anchor Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: 'tx-anchor',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: [getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-anchor',
          timestamp: 1000,
        }))],
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-6', timestamp: 7000 }),
        makeTrade({ leaderAddress, txHash: 'tx-5', timestamp: 6000 }),
        makeTrade({ leaderAddress, txHash: 'tx-4', timestamp: 5000 }),
        makeTrade({ leaderAddress, txHash: 'tx-3', timestamp: 4000 }),
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000 }),
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        newEvents.map((event) => event.txHash),
        ['tx-1', 'tx-2', 'tx-3', 'tx-4', 'tx-5', 'tx-6']
      );
      assert.strictEqual(localHistoryCalls.length, 3);
      assert.deepStrictEqual(
        localHistoryCalls.map((call) => call.options.fromTimestamp),
        [1000, 3000, 5000]
      );

      const updatedCursor = await cursorRepo.getByLeader(leaderAddress);
      assert.ok(updatedCursor);
      assert.strictEqual(updatedCursor?.cursorTimestamp, 7000);
    });

    it('should retry within the same poll when a gap remains but the current batch yields no new trades', async () => {
      const leaderAddress = '0xgap-retry-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();
      const localHistoryCalls: Array<{ address: string; options: TradeHistoryWindowOptions }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 2,
          maxCatchUpPasses: 1,
        },
        {
          now: () => 4_000,
          tradeSource: {
            getTrades: async () => [],
          },
          tradeHistorySource: {
            getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
              localHistoryCalls.push({ address: address.toLowerCase(), options });

              if ((options.pageLimit ?? 0) < 10) {
                const anchorOnly = tradeHistoryByAddress[address.toLowerCase()]?.filter((trade) => trade.timestamp === 1000) ?? [];
                return {
                  trades: anchorOnly,
                  pagesFetched: 1,
                  latestTimestamp: anchorOnly[0]?.timestamp ?? null,
                  oldestTimestamp: anchorOnly[anchorOnly.length - 1]?.timestamp ?? null,
                  windowComplete: false,
                  pageBudgetReached: true,
                  apiOffsetCapReached: false,
                };
              }

              const trades = (tradeHistoryByAddress[address.toLowerCase()] ?? [])
                .filter((trade) => trade.timestamp >= options.fromTimestamp && trade.timestamp <= options.toTimestamp)
                .sort((a, b) => b.timestamp - a.timestamp);
              return {
                trades,
                pagesFetched: 1,
                latestTimestamp: trades[0]?.timestamp ?? null,
                oldestTimestamp: trades[trades.length - 1]?.timestamp ?? null,
                windowComplete: true,
                pageBudgetReached: false,
                apiOffsetCapReached: false,
              };
            },
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'GapRetry' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-anchor',
        marketTitle: 'Anchor Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: 'tx-anchor',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: [getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-anchor',
          timestamp: 1000,
          conditionId: 'cond-anchor',
        }))],
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000, conditionId: 'cond-anchor', amountUsd: 10 }),
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        newEvents.map((event) => event.txHash),
        ['tx-1', 'tx-2']
      );
      assert.ok(localHistoryCalls.length >= 2);
      assert.strictEqual(localHistoryCalls[0]?.options.pageLimit, 2);
      assert.ok((localHistoryCalls[1]?.options.pageLimit ?? 0) >= 12);
    });

    it('should adapt catch-up budget and pass limit for high-activity leaders', async () => {
      const leaderAddress = '0xadaptive-budget-leader';
      const leaderRepo = getLeaderRepo();
      const eventRepo = getEventRepo();
      const cursorRepo = getWatchCursorRepo();
      const progressSnapshots: Array<{
        currentLeaderPass: number;
        currentLeaderCatchUpBudget: number;
        currentLeaderCatchUpPassLimit: number;
        currentLeaderCatchUpMode: string;
        currentLeaderCursorTimestamp: number | null;
      }> = [];
      const localHistoryCalls: Array<{ address: string; options: TradeHistoryWindowOptions }> = [];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 2,
          maxCatchUpPasses: 1,
        },
        {
          now: () => 13_500,
          tradeSource: {
            getTrades: async () => [],
          },
          tradeHistorySource: {
            getTradesWindow: async (address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> => {
              localHistoryCalls.push({ address: address.toLowerCase(), options });
              const normalizedAddress = address.toLowerCase();
              const allTrades = (tradeHistoryByAddress[normalizedAddress] ?? [])
                .filter((trade) => trade.timestamp > options.fromTimestamp && trade.timestamp <= options.toTimestamp)
                .sort((a, b) => a.timestamp - b.timestamp);
              const batch = allTrades.slice(0, options.pageLimit ?? allTrades.length).sort((a, b) => b.timestamp - a.timestamp);

              return {
                trades: batch,
                pagesFetched: 1,
                latestTimestamp: batch[0]?.timestamp ?? null,
                oldestTimestamp: batch[batch.length - 1]?.timestamp ?? null,
                windowComplete: batch.length === allTrades.length,
                pageBudgetReached: batch.length < allTrades.length,
                apiOffsetCapReached: false,
              };
            },
          },
          onStatsUpdated: (stats) => {
            progressSnapshots.push({
              currentLeaderPass: stats.currentLeaderPass,
              currentLeaderCatchUpBudget: stats.currentLeaderCatchUpBudget,
              currentLeaderCatchUpPassLimit: stats.currentLeaderCatchUpPassLimit,
              currentLeaderCatchUpMode: stats.currentLeaderCatchUpMode,
              currentLeaderCursorTimestamp: stats.currentLeaderCursorTimestamp,
            });
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'AdaptiveBudget' });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-anchor',
        marketTitle: 'Anchor Market',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: 'tx-anchor',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await cursorRepo.upsert({
        leaderAddress,
        platform: 'polymarket',
        cursorTimestamp: 1000,
        cursorTradeKeys: [getTradeIdentityKey(makeTrade({
          leaderAddress,
          txHash: 'tx-anchor',
          timestamp: 1000,
          conditionId: 'cond-anchor',
        }))],
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-12', timestamp: 13000 }),
        makeTrade({ leaderAddress, txHash: 'tx-11', timestamp: 12000 }),
        makeTrade({ leaderAddress, txHash: 'tx-10', timestamp: 11000 }),
        makeTrade({ leaderAddress, txHash: 'tx-9', timestamp: 10000 }),
        makeTrade({ leaderAddress, txHash: 'tx-8', timestamp: 9000 }),
        makeTrade({ leaderAddress, txHash: 'tx-7', timestamp: 8000 }),
        makeTrade({ leaderAddress, txHash: 'tx-6', timestamp: 7000 }),
        makeTrade({ leaderAddress, txHash: 'tx-5', timestamp: 6000 }),
        makeTrade({ leaderAddress, txHash: 'tx-4', timestamp: 5000 }),
        makeTrade({ leaderAddress, txHash: 'tx-3', timestamp: 4000 }),
        makeTrade({ leaderAddress, txHash: 'tx-2', timestamp: 3000 }),
        makeTrade({ leaderAddress, txHash: 'tx-1', timestamp: 2000 }),
        makeTrade({ leaderAddress, txHash: 'tx-anchor', timestamp: 1000, conditionId: 'cond-anchor' }),
      ];

      const newEvents = await watchEngine.pollLeader(leaderAddress);

      assert.deepStrictEqual(
        newEvents.map((event) => event.txHash),
        ['tx-1', 'tx-2', 'tx-3', 'tx-4', 'tx-5', 'tx-6', 'tx-7', 'tx-8', 'tx-9', 'tx-10', 'tx-11', 'tx-12']
      );
      assert.deepStrictEqual(
        localHistoryCalls.map((call) => call.options.pageLimit),
        [2, 14]
      );
      assert.ok(progressSnapshots.some((snapshot) =>
        snapshot.currentLeaderCatchUpBudget >= 14
        && snapshot.currentLeaderCatchUpPassLimit >= 3
        && snapshot.currentLeaderCatchUpMode === 'high_activity'
      ));
      assert.ok(progressSnapshots.some((snapshot) => snapshot.currentLeaderCursorTimestamp === 13000));
    });

    it('should wait for an in-flight poll to finish without starting a second poll', async () => {
      const leaderAddress = '0xidle-leader';
      const leaderRepo = getLeaderRepo();
      const cursorRepo = getWatchCursorRepo();

      let markFetchEntered: (() => void) | null = null;
      const fetchEntered = new Promise<void>((resolve) => {
        markFetchEntered = resolve;
      });
      let releaseFetch: (() => void) | null = null;
      const fetchBlocked = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });

      tradeHistoryByAddress[leaderAddress] = [
        makeTrade({ leaderAddress, txHash: 'tx-idle', timestamp: 1000 }),
      ];

      watchEngine = new WatchEngine(
        {
          interval: 60000,
          filterMinUsd: 10,
          maxEventsPerPoll: 2,
          maxTradeHistoryFetch: 6,
        },
        {
          tradeSource: {
            getTrades: async (address: string, limit = 100) => {
              tradeCalls.push({ address: address.toLowerCase(), limit });
              if (address.toLowerCase() === leaderAddress) {
                markFetchEntered?.();
                await fetchBlocked;
              }
              return (tradeHistoryByAddress[address.toLowerCase()] ?? []).slice(0, limit);
            },
          },
        }
      );

      await leaderRepo.add({ address: leaderAddress, alias: 'IdleLeader' });
      await cursorRepo.clear(leaderAddress);

      const firstPoll = watchEngine.poll();
      const secondPoll = watchEngine.poll();
      const idleWait = watchEngine.waitForIdle();
      await fetchEntered;

      let idleResolved = false;
      void idleWait.then(() => {
        idleResolved = true;
      });

      assert.strictEqual(idleResolved, false);
      assert.ok(watchEngine.getStats().currentPollStartedAt);
      assert.strictEqual(tradeCalls.filter((call) => call.address === leaderAddress).length, 1);

      releaseFetch?.();

      const [firstEvents, secondEvents] = await Promise.all([firstPoll, secondPoll, idleWait]);
      const firstLeaderEvents = firstEvents.filter((event) => event.leaderAddress === leaderAddress);
      const secondLeaderEvents = secondEvents.filter((event) => event.leaderAddress === leaderAddress);
      assert.strictEqual(firstLeaderEvents.length, 1);
      assert.deepStrictEqual(
        firstLeaderEvents.map((event) => event.txHash),
        secondLeaderEvents.map((event) => event.txHash)
      );
      assert.strictEqual(watchEngine.getStats().currentPollStartedAt, null);
      assert.strictEqual(idleResolved, true);
      assert.strictEqual(watchEngine.getStats().pollCount, 1);
    });

    it('should capture structured dependency failures in stats', async () => {
      const leaderAddress = '0xerror-leader';
      const leaderRepo = getLeaderRepo();

      await leaderRepo.add({ address: leaderAddress, alias: 'ErrorLeader' });

      const failingEngine = new WatchEngine(
        { interval: 60000 },
        {
          tradeSource: {
            getTrades: async (address: string) => {
              if (address !== leaderAddress) {
                return [];
              }
              throw new StructuredFailure(createFailureInfo({
                code: 'dependency_timeout',
                source: 'polymarket_cli',
                operation: 'polymarket data trades',
                message: 'trade fetch timed out',
                retryable: true,
              }));
            },
          },
        }
      );

      await failingEngine.poll();

      const stats = failingEngine.getStats();
      assert.ok(stats.lastError);
      assert.strictEqual(stats.errors, 1);
      assert.strictEqual(stats.consecutiveErrors, 1);
      assert.strictEqual(stats.lastError?.code, 'dependency_timeout');
      assert.strictEqual(stats.lastError?.source, 'polymarket_cli');
      assert.strictEqual(stats.lastError?.details?.leaderAddress, leaderAddress);
    });
  });
});
