/**
 * CopyHunter - Polymarket CLI Wrapper Tests
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { PolymarketCLI } from '../../../src/platforms/polymarket/cli-wrapper.js';
import { getPolymarketDataAPI } from '../../../src/platforms/polymarket/data-api.js';
import type { TradeEvent } from '../../../src/core/types.js';

function makeTrade(params: {
  leaderAddress?: string;
  txHash: string;
  timestamp: number;
  amountUsd?: number;
}): TradeEvent {
  return {
    leaderAddress: params.leaderAddress ?? '0xleader',
    platform: 'polymarket',
    eventType: 'BUY',
    conditionId: `cond-${params.txHash}`,
    marketTitle: `Market ${params.txHash}`,
    outcome: 'YES',
    price: 0.5,
    quantity: (params.amountUsd ?? 10) / 0.5,
    amountUsd: params.amountUsd ?? 10,
    txHash: params.txHash,
    timestamp: params.timestamp,
    followed: false,
    createdAt: params.timestamp,
  };
}

describe('PolymarketCLI getTrades()', () => {
  const dataApi = getPolymarketDataAPI();
  const originalDataApiGetTrades = dataApi.getTrades.bind(dataApi);

  afterEach(() => {
    dataApi.getTrades = originalDataApiGetTrades;
  });

  it('should fall back to Data API when polymarket-cli fails', async () => {
    const cli = new PolymarketCLI();
    const apiTrade = makeTrade({
      txHash: 'api-fallback',
      timestamp: Date.now(),
    });

    (cli as any).exec = () => {
      throw new Error('cli unavailable');
    };
    dataApi.getTrades = async () => [apiTrade];

    const trades = await cli.getTrades('0xleader', 5);

    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].txHash, 'api-fallback');
  });

  it('should prefer fresher Data API trades when CLI data is stale', async () => {
    const now = Date.now();
    const cli = new PolymarketCLI({
      tradeFreshnessWindowMs: 60_000,
      tradeFreshnessDriftMs: 60_000,
    });

    (cli as any).exec = () => [{
      condition_id: 'cond-cli-stale',
      side: 'buy',
      outcome: 'YES',
      price: '0.5',
      size: '20',
      transaction_hash: 'cli-stale',
      timestamp: Math.floor((now - (48 * 60 * 60 * 1000)) / 1000),
    }];

    const apiTrade = makeTrade({
      txHash: 'api-fresh',
      timestamp: now,
    });

    dataApi.getTrades = async () => [apiTrade];

    const trades = await cli.getTrades('0xleader', 5);

    assert.strictEqual(trades[0].txHash, 'api-fresh');
    assert.ok(trades.some((trade) => trade.txHash === 'cli-stale'));
  });

  it('should keep CLI trades without probing Data API when they are fresh', async () => {
    const now = Date.now();
    const cli = new PolymarketCLI({
      tradeFreshnessWindowMs: 60 * 60 * 1000,
    });
    let dataApiCalled = false;

    (cli as any).exec = () => [{
      condition_id: 'cond-cli-fresh',
      side: 'buy',
      outcome: 'YES',
      price: '0.5',
      size: '20',
      transaction_hash: 'cli-fresh',
      timestamp: Math.floor(now / 1000),
    }];

    dataApi.getTrades = async () => {
      dataApiCalled = true;
      return [makeTrade({ txHash: 'api-should-not-run', timestamp: now })];
    };

    const trades = await cli.getTrades('0xleader', 5);

    assert.strictEqual(dataApiCalled, false);
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].txHash, 'cli-fresh');
  });

  it('should probe Data API by default when CLI trades are more than one minute old', async () => {
    const now = Date.now();
    const cli = new PolymarketCLI();

    (cli as any).exec = () => [{
      condition_id: 'cond-cli-delayed',
      side: 'buy',
      outcome: 'YES',
      price: '0.5',
      size: '20',
      transaction_hash: 'cli-delayed',
      timestamp: Math.floor((now - (2 * 60 * 1000)) / 1000),
    }];

    const apiTrade = makeTrade({
      txHash: 'api-current',
      timestamp: now,
    });
    let dataApiCalled = false;

    dataApi.getTrades = async () => {
      dataApiCalled = true;
      return [apiTrade];
    };

    const trades = await cli.getTrades('0xleader', 5);

    assert.strictEqual(dataApiCalled, true);
    assert.strictEqual(trades[0].txHash, 'api-current');
    assert.ok(trades.some((trade) => trade.txHash === 'cli-delayed'));
  });
});
