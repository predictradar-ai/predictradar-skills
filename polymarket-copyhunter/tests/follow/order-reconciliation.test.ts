/**
 * CopyHunter - Follow Order Reconciliation Tests
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-reconcile-test-'));
process.env.XDG_DATA_HOME = testDataDir;

import { getDb, closeDb } from '../../src/db/index.js';
import { getEventRepo, getOrderRepo } from '../../src/db/repositories/index.js';
import { reconcileFollowOrders } from '../../src/follow/order-reconciliation.js';
import { setConfigValue } from '../../src/core/config.js';
import { getPolymarketCLI } from '../../src/platforms/polymarket/index.js';
import type { TradeEvent } from '../../src/core/types.js';

describe('Follow Order Reconciliation', () => {
  before(() => {
    getDb();
  });

  after(() => {
    closeDb();
    try {
      rmSync(testDataDir, { recursive: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  beforeEach(() => {
    setConfigValue('follow.followerAddress', '0xself123');
  });

  it('should reconcile live orders against follower trades and persist matched fills', async () => {
    const eventRepo = getEventRepo();
    const orderRepo = getOrderRepo();
    const cli = getPolymarketCLI() as ReturnType<typeof getPolymarketCLI> & {
      getTrades: (address: string, limit?: number) => Promise<TradeEvent[]>;
    };
    const originalGetTrades = cli.getTrades.bind(cli);
    const now = Date.now();

    const event = await eventRepo.save({
      leaderAddress: '0xleader-reconcile',
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: 'cond-reconcile-live',
      marketTitle: 'Reconcile Live Market',
      outcome: 'YES',
      price: 0.5,
      quantity: 20,
      amountUsd: 10,
      followed: 1,
      createdAt: now,
      timestamp: now,
    });

    const order = await orderRepo.create({
      eventId: event.id,
      leaderAddress: event.leaderAddress,
      platform: 'polymarket',
      orderType: 'market',
      side: 'buy',
      tokenId: 'token-reconcile-live',
      price: 0.5,
      size: 20,
      amountUsd: 10,
      status: 'executed',
      mode: 'live',
      createdAt: now,
    });

    await orderRepo.reconcileExecution(order.id, {
      reconcileStatus: 'estimated',
      reconcileReason: 'Executed fill details unavailable; using derived estimates.',
      lastReconciledAt: now,
    });

    cli.getTrades = async () => [{
      leaderAddress: '0xself123',
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: 'cond-reconcile-live',
      marketTitle: 'Reconcile Live Market',
      outcome: 'YES',
      price: 0.5001,
      quantity: 20.02,
      amountUsd: 10.012002,
      txHash: 'tx-follow-self-match',
      timestamp: now + 5_000,
      followed: false,
      createdAt: now + 5_000,
    }];

    try {
      const result = await reconcileFollowOrders({
        fromTimestamp: now - 60_000,
        toTimestamp: now + 60_000,
        limit: 20,
      });

      assert.strictEqual(result.summary.scannedOrders, 1);
      assert.strictEqual(result.summary.matched, 1);
      assert.strictEqual(result.orders[0].status, 'matched');

      const updated = await orderRepo.getById(order.id);
      assert.ok(updated);
      assert.strictEqual(updated.reconcileStatus, 'matched');
      assert.strictEqual(updated.txHash, 'tx-follow-self-match');
      assert.ok(typeof updated.executedSize === 'number');
      assert.ok(typeof updated.executedAmountUsd === 'number');
    } finally {
      cli.getTrades = originalGetTrades;
    }
  });

  it('should leave orders pending when no follower trade is found', async () => {
    const eventRepo = getEventRepo();
    const orderRepo = getOrderRepo();
    const cli = getPolymarketCLI() as ReturnType<typeof getPolymarketCLI> & {
      getTrades: (address: string, limit?: number) => Promise<TradeEvent[]>;
    };
    const originalGetTrades = cli.getTrades.bind(cli);
    const now = Date.now();

    const event = await eventRepo.save({
      leaderAddress: '0xleader-reconcile-miss',
      platform: 'polymarket',
      eventType: 'SELL',
      conditionId: 'cond-reconcile-miss',
      marketTitle: 'Reconcile Miss Market',
      outcome: 'NO',
      price: 0.4,
      quantity: 5,
      amountUsd: 2,
      followed: 1,
      createdAt: now,
      timestamp: now,
    });

    const order = await orderRepo.create({
      eventId: event.id,
      leaderAddress: event.leaderAddress,
      platform: 'polymarket',
      orderType: 'market',
      side: 'sell',
      tokenId: 'token-reconcile-miss',
      price: 0.4,
      size: 5,
      amountUsd: 2,
      status: 'executed',
      mode: 'live',
      createdAt: now,
    });

    cli.getTrades = async () => [];

    try {
      const result = await reconcileFollowOrders({
        fromTimestamp: now - 60_000,
        toTimestamp: now + 60_000,
        limit: 20,
      });

      assert.strictEqual(result.summary.pending, 1);
      assert.strictEqual(result.summary.notFound, 1);
      assert.strictEqual(result.orders[0].status, 'pending');

      const updated = await orderRepo.getById(order.id);
      assert.ok(updated);
      assert.strictEqual(updated.reconcileStatus, 'pending');
      assert.ok(updated.reconcileReason?.includes('No matching'));
    } finally {
      cli.getTrades = originalGetTrades;
    }
  });
});
