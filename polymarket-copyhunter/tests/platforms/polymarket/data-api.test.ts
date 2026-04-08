/**
 * CopyHunter - Polymarket Data API Tests
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PolymarketDataAPI,
  type TradeHistoryWindowOptions,
} from '../../../src/platforms/polymarket/data-api.js';

describe('PolymarketDataAPI getTradesWindow()', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockTrade(timestampSeconds: number, txHash: string) {
    return {
      proxyWallet: '0xleader',
      side: 'buy',
      asset: `asset-${txHash}`,
      conditionId: `cond-${txHash}`,
      size: '10',
      price: '0.5',
      timestamp: timestampSeconds,
      title: `Market ${txHash}`,
      outcome: 'YES',
      transactionHash: txHash,
    };
  }

  function installFetchMock(pages: Record<number, unknown>) {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      const body = pages[offset] ?? [];
      const status = typeof body === 'object' && body !== null && 'status' in body
        ? Number((body as { status: number }).status)
        : 200;
      const payload = typeof body === 'object' && body !== null && 'body' in body
        ? (body as { body: unknown }).body
        : body;
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  function createApi() {
    return new PolymarketDataAPI({ timeout: 100 });
  }

  function createWindow(options: Partial<TradeHistoryWindowOptions> = {}): TradeHistoryWindowOptions {
    return {
      fromTimestamp: 2_500,
      toTimestamp: 4_500,
      pageLimit: 2,
      maxPages: 3,
      ...options,
    };
  }

  it('should page until it covers the requested window', async () => {
    installFetchMock({
      0: [mockTrade(5, 'tx-5'), mockTrade(4, 'tx-4')],
      2: [mockTrade(3, 'tx-3'), mockTrade(2, 'tx-2')],
      4: [mockTrade(1, 'tx-1')],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow());

    assert.strictEqual(result.pagesFetched, 2);
    assert.strictEqual(result.latestTimestamp, 5_000);
    assert.strictEqual(result.oldestTimestamp, 2_000);
    assert.strictEqual(result.windowComplete, true);
    assert.strictEqual(result.pageBudgetReached, false);
    assert.deepStrictEqual(result.trades.map((trade) => trade.txHash), ['tx-4', 'tx-3']);
  });

  it('should continue fetching past the old fixed offset depth when page budget allows it', async () => {
    installFetchMock({
      0: [mockTrade(9, 'tx-9'), mockTrade(8, 'tx-8')],
      2: [mockTrade(7, 'tx-7'), mockTrade(6, 'tx-6')],
      4: [mockTrade(5, 'tx-5'), mockTrade(4, 'tx-4')],
      6: [mockTrade(3, 'tx-3'), mockTrade(1, 'tx-1')],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 1_500,
      toTimestamp: 9_500,
      maxPages: 4,
    }));

    assert.strictEqual(result.pagesFetched, 4);
    assert.strictEqual(result.latestTimestamp, 9_000);
    assert.strictEqual(result.oldestTimestamp, 1_000);
    assert.strictEqual(result.windowComplete, true);
    assert.strictEqual(result.pageBudgetReached, false);
    assert.deepStrictEqual(
      result.trades.map((trade) => trade.txHash),
      ['tx-9', 'tx-8', 'tx-7', 'tx-6', 'tx-5', 'tx-4', 'tx-3']
    );
  });

  it('should seek to the requested fixed window instead of only scanning from the newest page', async () => {
    installFetchMock({
      0: [mockTrade(12, 'tx-12'), mockTrade(11, 'tx-11')],
      2: [mockTrade(10, 'tx-10'), mockTrade(9, 'tx-9')],
      4: [mockTrade(8, 'tx-8'), mockTrade(7, 'tx-7')],
      6: [mockTrade(6, 'tx-6'), mockTrade(5, 'tx-5')],
      8: [mockTrade(4, 'tx-4'), mockTrade(3, 'tx-3')],
      10: [mockTrade(2, 'tx-2'), mockTrade(1, 'tx-1')],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 3_500,
      toTimestamp: 4_500,
      maxPages: 2,
    }));

    assert.strictEqual(result.windowComplete, true);
    assert.strictEqual(result.pageBudgetReached, false);
    assert.ok(result.pagesFetched >= 3);
    assert.deepStrictEqual(result.trades.map((trade) => trade.txHash), ['tx-4']);
  });

  it('should anchor catch-up fetches from the requested start when requested', async () => {
    installFetchMock({
      0: [mockTrade(12, 'tx-12'), mockTrade(11, 'tx-11')],
      2: [mockTrade(10, 'tx-10'), mockTrade(9, 'tx-9')],
      4: [mockTrade(8, 'tx-8'), mockTrade(7, 'tx-7')],
      6: [mockTrade(6, 'tx-6'), mockTrade(5, 'tx-5')],
      8: [mockTrade(4, 'tx-4'), mockTrade(3, 'tx-3')],
      10: [mockTrade(2, 'tx-2'), mockTrade(1, 'tx-1')],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 3_500,
      toTimestamp: 12_500,
      maxPages: 2,
      anchor: 'from',
    }));

    assert.strictEqual(result.windowComplete, false);
    assert.strictEqual(result.pageBudgetReached, true);
    assert.strictEqual(result.apiOffsetCapReached, false);
    assert.ok(result.latestTimestamp !== null && result.latestTimestamp >= 6_000);
    assert.strictEqual(result.oldestTimestamp, 3_000);
    assert.deepStrictEqual(result.trades.map((trade) => trade.txHash), ['tx-6', 'tx-5', 'tx-4']);
  });

  it('should report incomplete history when the page budget is reached first', async () => {
    installFetchMock({
      0: [mockTrade(9, 'tx-9'), mockTrade(8, 'tx-8')],
      2: [mockTrade(7, 'tx-7'), mockTrade(6, 'tx-6')],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 1_000,
      toTimestamp: 9_500,
      maxPages: 2,
    }));

    assert.strictEqual(result.pagesFetched, 2);
    assert.strictEqual(result.latestTimestamp, 9_000);
    assert.strictEqual(result.oldestTimestamp, 6_000);
    assert.strictEqual(result.windowComplete, false);
    assert.strictEqual(result.pageBudgetReached, true);
    assert.deepStrictEqual(result.trades.map((trade) => trade.txHash), ['tx-9', 'tx-8', 'tx-7', 'tx-6']);
  });

  it('should stop gracefully when the api offset cap is reached', async () => {
    installFetchMock({
      0: [mockTrade(9, 'tx-9'), mockTrade(8, 'tx-8')],
      2: [mockTrade(7, 'tx-7'), mockTrade(6, 'tx-6')],
      4: {
        status: 400,
        body: { error: 'max historical activity offset of 3000 exceeded' },
      },
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 1_000,
      toTimestamp: 9_500,
      maxPages: 4,
    }));

    assert.ok(result.pagesFetched >= 2);
    assert.strictEqual(result.windowComplete, true);
    assert.strictEqual(result.pageBudgetReached, false);
    assert.strictEqual(result.apiOffsetCapReached, true);
    assert.deepStrictEqual(result.trades.map((trade) => trade.txHash), ['tx-9', 'tx-8', 'tx-7', 'tx-6']);
  });

  it('should keep distinct fills that share the same tx hash', async () => {
    installFetchMock({
      0: [
        {
          ...mockTrade(5, 'tx-shared'),
          asset: 'asset-a',
          conditionId: 'cond-a',
          size: '10',
        },
        {
          ...mockTrade(5, 'tx-shared'),
          asset: 'asset-b',
          conditionId: 'cond-b',
          size: '20',
        },
      ],
    });

    const result = await createApi().getTradesWindow('0xleader', createWindow({
      fromTimestamp: 4_500,
      toTimestamp: 5_500,
      pageLimit: 2,
      maxPages: 1,
    }));

    assert.strictEqual(result.trades.length, 2);
    assert.deepStrictEqual(
      result.trades.map((trade) => trade.conditionId).sort(),
      ['cond-a', 'cond-b']
    );
  });
});
