/**
 * CopyHunter - Repository Tests
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up test data directory before importing modules
const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-test-'));
process.env.XDG_DATA_HOME = testDataDir;

import { getDb, closeDb } from '../../src/db/index.js';
import {
  getLeaderRepo,
  getEventRepo,
  getPositionLotRepo,
  getPositionRepo,
  getOrderRepo,
  getDailyStatsRepo,
  getWatchCursorRepo,
} from '../../src/db/repositories/index.js';
import { getTradeIdentityKey } from '../../src/core/trade-identity.js';

describe('Repository Tests', () => {
  before(() => {
    // Initialize database
    getDb();
  });

  after(() => {
    closeDb();
    // Clean up test directory
    try {
      rmSync(testDataDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('LeaderRepository', () => {
    const leaderRepo = getLeaderRepo();

    it('should add a new leader', async () => {
      const leader = await leaderRepo.add({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        alias: 'TestWhale',
        tags: ['high-freq', 'sports'],
      });

      assert.ok(leader.id);
      assert.strictEqual(leader.address, '0x1234567890abcdef1234567890abcdef12345678');
      assert.strictEqual(leader.alias, 'TestWhale');
      assert.strictEqual(leader.platform, 'polymarket');
    });

    it('should get leader by address', async () => {
      const leader = await leaderRepo.getByAddress('0x1234567890abcdef1234567890abcdef12345678');
      assert.ok(leader);
      assert.strictEqual(leader.alias, 'TestWhale');
    });

    it('should update leader', async () => {
      const updated = await leaderRepo.update('0x1234567890abcdef1234567890abcdef12345678', {
        alias: 'UpdatedWhale',
      });
      assert.ok(updated);
      assert.strictEqual(updated.alias, 'UpdatedWhale');
    });

    it('should check if leader exists', async () => {
      const exists = await leaderRepo.exists('0x1234567890abcdef1234567890abcdef12345678');
      assert.strictEqual(exists, true);

      const notExists = await leaderRepo.exists('0xnonexistent');
      assert.strictEqual(notExists, false);
    });

    it('should count leaders', async () => {
      const count = await leaderRepo.count();
      assert.ok(count >= 1);
    });

    it('should get all leaders', async () => {
      const leaders = await leaderRepo.getAll();
      assert.ok(Array.isArray(leaders));
      assert.ok(leaders.length >= 1);
    });
  });

  describe('EventRepository', () => {
    const eventRepo = getEventRepo();

    it('should save a new event', async () => {
      const event = await eventRepo.save({
        leaderAddress: '0x1234567890abcdef1234567890abcdef12345678',
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-123',
        marketTitle: 'Test Market',
        outcome: 'YES',
        price: 0.65,
        quantity: 100,
        amountUsd: 65,
        txHash: 'tx-001',
        timestamp: Date.now(),
        followed: 0,
        createdAt: Date.now(),
      });

      assert.ok(event.id);
      assert.strictEqual(event.eventType, 'BUY');
      assert.strictEqual(event.amountUsd, 65);
    });

    it('should find events with filters', async () => {
      const events = await eventRepo.find({ leaderAddress: '0x1234567890abcdef1234567890abcdef12345678' });
      assert.ok(Array.isArray(events));
      assert.ok(events.length >= 1);
    });

    it('should check if event exists', async () => {
      const exists = await eventRepo.exists('tx-001');
      assert.strictEqual(exists, true);

      const notExists = await eventRepo.exists('tx-nonexistent');
      assert.strictEqual(notExists, false);
    });

    it('should distinguish trades that share a tx hash but differ by trade identity', async () => {
      const leaderAddress = '0x1234567890abcdef1234567890abcdef12345678';
      const sharedTxHash = 'tx-shared';

      const baselineExists = await eventRepo.exists(
        sharedTxHash,
        leaderAddress,
        'cond-a',
        1000,
        'BUY',
        'YES',
        0.5,
        20
      );
      assert.strictEqual(baselineExists, false);

      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-a',
        marketTitle: 'Shared Tx A',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: sharedTxHash,
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });

      const firstExists = await eventRepo.exists(
        sharedTxHash,
        leaderAddress,
        'cond-a',
        1000,
        'BUY',
        'YES',
        0.5,
        20
      );
      const secondExistsBeforeSave = await eventRepo.exists(
        sharedTxHash,
        leaderAddress,
        'cond-b',
        2000,
        'BUY',
        'YES',
        0.55,
        40
      );

      assert.strictEqual(firstExists, true);
      assert.strictEqual(secondExistsBeforeSave, false);

      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-b',
        marketTitle: 'Shared Tx B',
        outcome: 'YES',
        price: 0.55,
        quantity: 40,
        amountUsd: 22,
        txHash: sharedTxHash,
        timestamp: 2000,
        followed: 0,
        createdAt: 2000,
      });

      const secondExistsAfterSave = await eventRepo.exists(
        sharedTxHash,
        leaderAddress,
        'cond-b',
        2000,
        'BUY',
        'YES',
        0.55,
        40
      );
      assert.strictEqual(secondExistsAfterSave, true);
    });

    it('should find existing trade keys in batch without collapsing shared tx hashes', async () => {
      const leaderAddress = '0xbatch-identity-leader';

      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-a',
        marketTitle: 'Batch Existing A',
        outcome: 'YES',
        price: 0.5,
        quantity: 20,
        amountUsd: 10,
        txHash: 'tx-batch-shared',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'SELL',
        conditionId: 'cond-b',
        marketTitle: 'Batch Existing B',
        outcome: 'NO',
        price: 0.45,
        quantity: 30,
        amountUsd: 13.5,
        txHash: 'tx-batch-shared',
        timestamp: 2000,
        followed: 0,
        createdAt: 2000,
      });

      const existingKeys = await eventRepo.findExistingTradeKeys([
        {
          leaderAddress,
          conditionId: 'cond-a',
          eventType: 'BUY',
          outcome: 'YES',
          timestamp: 1000,
          price: 0.5,
          quantity: 20,
          txHash: 'tx-batch-shared',
        },
        {
          leaderAddress,
          conditionId: 'cond-b',
          eventType: 'SELL',
          outcome: 'NO',
          timestamp: 2000,
          price: 0.45,
          quantity: 30,
          txHash: 'tx-batch-shared',
        },
        {
          leaderAddress,
          conditionId: 'cond-c',
          eventType: 'BUY',
          outcome: 'YES',
          timestamp: 3000,
          price: 0.6,
          quantity: 25,
          txHash: 'tx-batch-shared',
        },
      ]);

      assert.deepStrictEqual(
        [...existingKeys].sort(),
        [
          getTradeIdentityKey({
            leaderAddress,
            conditionId: 'cond-a',
            eventType: 'BUY',
            outcome: 'YES',
            timestamp: 1000,
            price: 0.5,
            quantity: 20,
            txHash: 'tx-batch-shared',
          }),
          getTradeIdentityKey({
            leaderAddress,
            conditionId: 'cond-b',
            eventType: 'SELL',
            outcome: 'NO',
            timestamp: 2000,
            price: 0.45,
            quantity: 30,
            txHash: 'tx-batch-shared',
          }),
        ].sort()
      );
    });

    it('should chunk large batch inserts to avoid sqlite variable limits', async () => {
      const leaderAddress = '0xlarge-batch-leader';
      const largeBatch = Array.from({ length: 120 }, (_, index) => ({
        leaderAddress,
        platform: 'polymarket',
        eventType: index % 2 === 0 ? 'BUY' as const : 'SELL' as const,
        conditionId: `cond-${index}`,
        marketTitle: `Large Batch ${index}`,
        outcome: index % 2 === 0 ? 'YES' : 'NO',
        price: 0.5,
        quantity: 10 + index,
        amountUsd: (10 + index) * 0.5,
        txHash: `tx-large-${index}`,
        timestamp: 10_000 + index,
        followed: 0,
        createdAt: 10_000 + index,
      }));

      const savedEvents = await eventRepo.saveBatch(largeBatch);

      assert.strictEqual(savedEvents.length, 120);

      const storedEvents = await eventRepo.find({ leaderAddress }, 200);
      assert.strictEqual(storedEvents.length, 120);
    });

    it('should mark event as followed', async () => {
      const events = await eventRepo.find({});
      if (events.length > 0) {
        await eventRepo.markFollowed(events[0].id, 'Test reason');
        const updated = await eventRepo.getById(events[0].id);
        assert.ok(updated);
        assert.strictEqual(updated.followed, 1);
      }
    });

    it('should mark event as skipped or failed without setting followed', async () => {
      const entries = await eventRepo.find({}, 2);
      assert.ok(entries.length >= 2);

      await eventRepo.markFollowSkipped(entries[0].id, 'Leader not in allowlist');
      await eventRepo.markFollowFailed(entries[1].id, 'wallet unavailable');

      const skipped = await eventRepo.getById(entries[0].id);
      const failed = await eventRepo.getById(entries[1].id);

      assert.ok(skipped);
      assert.ok(failed);
      assert.strictEqual(skipped.followed, 0);
      assert.strictEqual(skipped.followReason, 'skipped: Leader not in allowlist');
      assert.strictEqual(failed.followed, 0);
      assert.strictEqual(failed.followReason, 'error: wallet unavailable');
    });

    it('should count events', async () => {
      const count = await eventRepo.count();
      assert.ok(count >= 1);
    });

    it('should build the latest cursor snapshot from local events', async () => {
      const leaderAddress = '0xcursor-snapshot-leader';

      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-old',
        marketTitle: 'Older Trade',
        outcome: 'YES',
        price: 0.5,
        quantity: 10,
        amountUsd: 5,
        txHash: 'tx-old',
        timestamp: 1000,
        followed: 0,
        createdAt: 1000,
      });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'cond-new-a',
        marketTitle: 'Newer Trade A',
        outcome: 'YES',
        price: 0.6,
        quantity: 20,
        amountUsd: 12,
        txHash: 'tx-new-a',
        timestamp: 2000,
        followed: 0,
        createdAt: 2000,
      });
      await eventRepo.save({
        leaderAddress,
        platform: 'polymarket',
        eventType: 'SELL',
        conditionId: 'cond-new-b',
        marketTitle: 'Newer Trade B',
        outcome: 'NO',
        price: 0.4,
        quantity: 15,
        amountUsd: 6,
        txHash: 'tx-new-b',
        timestamp: 2000,
        followed: 0,
        createdAt: 2000,
      });

      const snapshot = await eventRepo.getLatestCursorSnapshot(leaderAddress);

      assert.strictEqual(snapshot.cursorTimestamp, 2000);
      assert.strictEqual(snapshot.cursorTradeKeys.length, 2);
      assert.ok(snapshot.cursorTradeKeys.every((key) => key.startsWith(`${leaderAddress}:`)));
    });
  });

  describe('PositionRepository', () => {
    const positionRepo = getPositionRepo();
    const positionLotRepo = getPositionLotRepo();

    it('should upsert a position', async () => {
      const position = await positionRepo.upsert({
        leaderAddress: 'self',
        platform: 'polymarket',
        conditionId: 'cond-123',
        marketTitle: 'Test Market',
        outcome: 'YES',
        quantity: 100,
        avgPrice: 0.65,
        costBasis: 65,
      });

      assert.ok(position.id);
      assert.strictEqual(position.quantity, 100);
      assert.strictEqual(position.status, 'open');
    });

    it('should get open positions', async () => {
      const positions = await positionRepo.getOpen();
      assert.ok(Array.isArray(positions));
      assert.ok(positions.length >= 1);
    });

    it('should calculate total exposure', async () => {
      const exposure = await positionRepo.getTotalExposure();
      assert.ok(exposure >= 65);
    });

    it('should close a position', async () => {
      const positions = await positionRepo.getOpen();
      if (positions.length > 0) {
        const closed = await positionRepo.close(positions[0].id, 10);
        assert.ok(closed);
        assert.strictEqual(closed.status, 'closed');
        assert.strictEqual(closed.realizedPnl, 10);
      }
    });

    it('should upsert aggregates from lots without failing on concurrent insert races', async () => {
      await positionLotRepo.create({
        leaderAddress: 'self',
        platform: 'polymarket',
        conditionId: 'cond-sync-race',
        marketTitle: 'Concurrent Aggregate Market',
        outcome: 'YES',
        entryQuantity: 10,
        remainingQuantity: 10,
        avgPrice: 0.4,
        costBasis: 4,
        realizedPnl: 0,
        status: 'open',
        openedOrderId: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const results = await Promise.all([
        positionRepo.syncAggregateFromLots({
          leaderAddress: 'self',
          platform: 'polymarket',
          conditionId: 'cond-sync-race',
          outcome: 'YES',
          marketTitle: 'Concurrent Aggregate Market',
        }),
        positionRepo.syncAggregateFromLots({
          leaderAddress: 'self',
          platform: 'polymarket',
          conditionId: 'cond-sync-race',
          outcome: 'YES',
          marketTitle: 'Concurrent Aggregate Market',
        }),
      ]);

      assert.strictEqual(results.filter(Boolean).length, 2);

      const positions = await positionRepo.find({ leaderAddress: 'self', conditionId: 'cond-sync-race' }, 10);
      assert.strictEqual(positions.length, 1);
      assert.strictEqual(positions[0].quantity, 10);
      assert.strictEqual(positions[0].status, 'open');
    });
  });

  describe('OrderRepository', () => {
    const orderRepo = getOrderRepo();

    it('should create an order', async () => {
      const order = await orderRepo.create({
        eventId: 1,
        leaderAddress: '0x1234567890abcdef1234567890abcdef12345678',
        platform: 'polymarket',
        orderType: 'market',
        side: 'buy',
        tokenId: 'token-123',
        price: 0.65,
        size: 100,
        amountUsd: 65,
        status: 'pending',
        mode: 'shadow',
        createdAt: Date.now(),
      });

      assert.ok(order.id);
      assert.strictEqual(order.status, 'pending');
    });

    it('should mark order as executed', async () => {
      const orders = await orderRepo.find({ status: 'pending' });
      if (orders.length > 0) {
        await orderRepo.markExecuted(orders[0].id, 'tx-executed', 0.66, {
          executedSize: 100,
          executedAmountUsd: 66,
          reconcileStatus: 'matched',
          lastReconciledAt: Date.now(),
        });
        const updated = await orderRepo.getById(orders[0].id);
        assert.ok(updated);
        assert.strictEqual(updated.status, 'executed');
        assert.strictEqual(updated.txHash, 'tx-executed');
        assert.strictEqual(updated.reconcileStatus, 'matched');
        assert.strictEqual(updated.executedSize, 100);
        assert.strictEqual(updated.executedAmountUsd, 66);
      }
    });

    it('should get daily spent', async () => {
      const spent = await orderRepo.getDailySpent();
      assert.ok(typeof spent === 'number');
    });

    it('should count only buy-side executed orders in daily spent by default', async () => {
      const baselineBuySpent = await orderRepo.getDailySpent(undefined, 'buy');
      const baselineSellSpent = await orderRepo.getDailySpent(undefined, 'sell');
      const uniqueSuffix = Date.now();

      const buyOrder = await orderRepo.create({
        eventId: uniqueSuffix,
        leaderAddress: '0x1234567890abcdef1234567890abcdef12345678',
        platform: 'polymarket',
        orderType: 'market',
        side: 'buy',
        tokenId: `token-buy-${uniqueSuffix}`,
        price: 0.5,
        size: 40,
        amountUsd: 20,
        status: 'pending',
        mode: 'shadow',
        createdAt: Date.now(),
      });
      await orderRepo.markExecuted(buyOrder.id, `tx-buy-${uniqueSuffix}`, 0.5, {
        executedSize: 40,
        executedAmountUsd: 20,
        reconcileStatus: 'simulated',
        reconcileReason: 'test',
        lastReconciledAt: Date.now(),
      });

      const sellOrder = await orderRepo.create({
        eventId: uniqueSuffix + 1,
        leaderAddress: '0x1234567890abcdef1234567890abcdef12345678',
        platform: 'polymarket',
        orderType: 'market',
        side: 'sell',
        tokenId: `token-sell-${uniqueSuffix}`,
        price: 0.5,
        size: 24,
        amountUsd: 12,
        status: 'pending',
        mode: 'shadow',
        createdAt: Date.now(),
      });
      await orderRepo.markExecuted(sellOrder.id, `tx-sell-${uniqueSuffix}`, 0.5, {
        executedSize: 24,
        executedAmountUsd: 12,
        reconcileStatus: 'simulated',
        reconcileReason: 'test',
        lastReconciledAt: Date.now(),
      });

      const buySpent = await orderRepo.getDailySpent(undefined, 'buy');
      const sellSpent = await orderRepo.getDailySpent(undefined, 'sell');
      const defaultSpent = await orderRepo.getDailySpent();
      const allSpent = await orderRepo.getDailySpent(undefined, 'all');

      assert.strictEqual(Number((buySpent - baselineBuySpent).toFixed(8)), 20);
      assert.strictEqual(Number((sellSpent - baselineSellSpent).toFixed(8)), 12);
      assert.strictEqual(Number((defaultSpent - baselineBuySpent).toFixed(8)), 20);
      assert.strictEqual(Number((allSpent - (baselineBuySpent + baselineSellSpent)).toFixed(8)), 32);
    });

    it('should count by status', async () => {
      const counts = await orderRepo.countByStatus();
      assert.ok('pending' in counts);
      assert.ok('executed' in counts);
      assert.ok('failed' in counts);
      assert.ok('cancelled' in counts);
    });
  });

  describe('DailyStatsRepository', () => {
    const statsRepo = getDailyStatsRepo();

    it('should get or create today stats', async () => {
      const stats = await statsRepo.getOrCreateToday();
      assert.ok(stats.id);
      assert.ok(stats.date);
    });

    it('should increment events captured', async () => {
      const before = await statsRepo.getOrCreateToday();
      await statsRepo.incrementEventsCaptured(5);
      const after = await statsRepo.getOrCreateToday();
      assert.strictEqual(after.eventsCaptured, before.eventsCaptured + 5);
    });

    it('should tolerate concurrent getOrCreateToday calls for the same platform', async () => {
      const stats = await Promise.all(
        Array.from({ length: 20 }, () => statsRepo.getOrCreateToday('race-platform'))
      );

      assert.strictEqual(stats.length, 20);
      assert.ok(stats.every((entry) => entry.platform === 'race-platform'));

      const stored = await statsRepo.getRecent(10, 'race-platform');
      assert.strictEqual(stored.length, 1);
    });

    it('should apply concurrent incrementEventsFollowed updates without losing counts', async () => {
      await statsRepo.getOrCreateToday('race-inc');

      await Promise.all(
        Array.from({ length: 20 }, () => statsRepo.incrementEventsFollowed(1, 'race-inc'))
      );

      const today = new Date().toISOString().split('T')[0];
      const stored = await statsRepo.getByDate(today, 'race-inc');

      assert.ok(stored);
      assert.strictEqual(stored.eventsFollowed, 20);
    });

    it('should get recent stats', async () => {
      const stats = await statsRepo.getRecent(7);
      assert.ok(Array.isArray(stats));
    });

    it('should get cumulative stats', async () => {
      const cumulative = await statsRepo.getCumulative();
      assert.ok('totalEventsCaptured' in cumulative);
      assert.ok('totalEventsFollowed' in cumulative);
      assert.ok('totalRealizedPnl' in cumulative);
    });
  });

  describe('WatchCursorRepository', () => {
    const cursorRepo = getWatchCursorRepo();

    it('should upsert and retrieve a watch cursor', async () => {
      const cursor = await cursorRepo.upsert({
        leaderAddress: '0x1234567890abcdef1234567890abcdef12345678',
        platform: 'polymarket',
        cursorTimestamp: 1234567890,
        cursorTradeKeys: ['tx-1', 'tx-2'],
      });

      assert.strictEqual(cursor.cursorTimestamp, 1234567890);
      assert.deepStrictEqual(cursor.cursorTradeKeys, ['tx-1', 'tx-2']);

      const stored = await cursorRepo.getByLeader('0x1234567890abcdef1234567890abcdef12345678');
      assert.ok(stored);
      assert.strictEqual(stored.cursorTimestamp, 1234567890);
      assert.deepStrictEqual(stored.cursorTradeKeys, ['tx-1', 'tx-2']);
    });
  });
});
