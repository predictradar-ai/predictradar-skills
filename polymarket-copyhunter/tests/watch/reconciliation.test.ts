/**
 * CopyHunter - Watch Reconciliation Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { TradeEvent } from '../../src/core/types.js';
import {
  buildReconciliationTradeKey,
  parseReconciliationLookback,
  reconcileTradeSets,
  resolveRequestedReconciliationWindow,
  resolveIncrementalReconciliationComparisonWindow,
  resolveReconciliationComparisonWindow,
} from '../../src/watch/reconciliation.js';

describe('Watch Reconciliation', () => {
  const baseTrade: TradeEvent = {
    leaderAddress: '0xleader123',
    platform: 'polymarket',
    eventType: 'BUY',
    conditionId: 'cond-1',
    marketTitle: 'Test Market',
    outcome: 'YES',
    price: 0.42,
    quantity: 100,
    amountUsd: 42,
    txHash: '0xabc',
    timestamp: 1_710_000_000_000,
    followed: false,
    createdAt: 1_710_000_000_000,
  };

  it('should treat tx hash matches as the same trade', () => {
    const keyA = buildReconciliationTradeKey(baseTrade as any);
    const keyB = buildReconciliationTradeKey({
      ...baseTrade,
      leaderAddress: '0xLEADER123',
      txHash: '0xABC',
    } as any);

    assert.strictEqual(keyA, keyB);
  });

  it('should report trades missing from local storage', () => {
    const result = reconcileTradeSets({
      apiTrades: [
        baseTrade,
        {
          ...baseTrade,
          txHash: '0xdef',
          timestamp: baseTrade.timestamp + 1000,
        },
      ],
      localTrades: [baseTrade],
    });

    assert.strictEqual(result.summary.apiTrades, 2);
    assert.strictEqual(result.summary.localTrades, 1);
    assert.strictEqual(result.summary.matchedTrades, 1);
    assert.strictEqual(result.summary.missingInLocal, 1);
    assert.strictEqual(result.summary.localOnly, 0);
    assert.strictEqual(result.summary.coveragePct, 50);
    assert.strictEqual(result.missingInLocal[0].txHash, '0xdef');
  });

  it('should account for duplicate fills with the same key', () => {
    const duplicateA = {
      ...baseTrade,
      txHash: undefined,
      timestamp: baseTrade.timestamp + 5,
    };
    const duplicateB = {
      ...baseTrade,
      txHash: undefined,
      timestamp: baseTrade.timestamp + 600,
    };

    const result = reconcileTradeSets({
      apiTrades: [duplicateA, duplicateB],
      localTrades: [duplicateA],
    });

    assert.strictEqual(result.summary.matchedTrades, 1);
    assert.strictEqual(result.summary.missingInLocal, 1);
    assert.strictEqual(result.summary.localOnly, 0);
  });

  it('should report local-only trades when local capture has extras', () => {
    const result = reconcileTradeSets({
      apiTrades: [baseTrade],
      localTrades: [
        baseTrade,
        {
          ...baseTrade,
          txHash: '0xextra',
          timestamp: baseTrade.timestamp + 1000,
        },
      ],
    });

    assert.strictEqual(result.summary.missingInLocal, 0);
    assert.strictEqual(result.summary.localOnly, 1);
    assert.strictEqual(result.localOnly[0].txHash, '0xextra');
  });

  it('should detect when api and local windows do not overlap', () => {
    const window = resolveReconciliationComparisonWindow({
      requestedFromTimestamp: baseTrade.timestamp,
      requestedToTimestamp: baseTrade.timestamp + 60_000,
      apiTrades: [
        {
          ...baseTrade,
          txHash: '0xapi-only',
          timestamp: baseTrade.timestamp + 50_000,
        },
      ],
      localTrades: [
        {
          ...baseTrade,
          txHash: '0xlocal-only',
          timestamp: baseTrade.timestamp + 10_000,
        },
      ],
    });

    assert.strictEqual(window.hasOverlap, false);
    assert.strictEqual(window.fromTimestamp, baseTrade.timestamp + 50_000);
    assert.strictEqual(window.toTimestamp, baseTrade.timestamp + 10_000);
  });

  it('should resolve the latest overlapping slice in incremental mode', () => {
    const window = resolveIncrementalReconciliationComparisonWindow({
      apiTrades: [
        {
          ...baseTrade,
          txHash: '0xapi-newest',
          timestamp: baseTrade.timestamp + 70_000,
        },
        {
          ...baseTrade,
          txHash: '0xapi-oldest',
          timestamp: baseTrade.timestamp + 50_000,
        },
      ],
      localTrades: [
        {
          ...baseTrade,
          txHash: '0xlocal-newest',
          timestamp: baseTrade.timestamp + 65_000,
        },
        {
          ...baseTrade,
          txHash: '0xlocal-oldest',
          timestamp: baseTrade.timestamp + 45_000,
        },
      ],
    });

    assert.strictEqual(window.hasOverlap, true);
    assert.strictEqual(window.fromTimestamp, baseTrade.timestamp + 50_000);
    assert.strictEqual(window.toTimestamp, baseTrade.timestamp + 65_000);
  });

  it('should parse fixed reconciliation lookback presets', () => {
    assert.strictEqual(parseReconciliationLookback('10m'), 10 * 60_000);
    assert.strictEqual(parseReconciliationLookback('30m'), 30 * 60_000);
    assert.strictEqual(parseReconciliationLookback('2h'), 2 * 60 * 60_000);
    assert.strictEqual(parseReconciliationLookback('1d'), 24 * 60 * 60_000);
  });

  it('should reject invalid reconciliation lookback presets', () => {
    assert.throws(
      () => parseReconciliationLookback('10'),
      /window must use a duration like 10m, 30m, 2h, or 1d/i
    );
  });

  it('should resolve a fixed trailing reconciliation window', () => {
    const resolved = resolveRequestedReconciliationWindow({
      toTimestamp: baseTrade.timestamp,
      lookbackMs: 10 * 60_000,
    });

    assert.strictEqual(resolved.toTimestamp, baseTrade.timestamp);
    assert.strictEqual(resolved.fromTimestamp, baseTrade.timestamp - (10 * 60_000));
    assert.strictEqual(resolved.hours, null);
    assert.strictEqual(resolved.lookbackMs, 10 * 60_000);
  });

  it('should resolve an hour-based reconciliation window by default', () => {
    const resolved = resolveRequestedReconciliationWindow({
      toTimestamp: baseTrade.timestamp,
      hours: 24,
    });

    assert.strictEqual(resolved.toTimestamp, baseTrade.timestamp);
    assert.strictEqual(resolved.fromTimestamp, baseTrade.timestamp - (24 * 60 * 60_000));
    assert.strictEqual(resolved.hours, 24);
    assert.strictEqual(resolved.lookbackMs, 24 * 60 * 60_000);
  });
});
