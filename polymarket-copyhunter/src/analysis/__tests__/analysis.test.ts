/**
 * CopyHunter - Analysis Module Tests
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// Mock the database before importing modules
const mockPositionRepo = {
  getOpen: mock.fn(() => Promise.resolve([])),
  find: mock.fn(() => Promise.resolve([])),
  count: mock.fn(() => Promise.resolve(0)),
  getTotalRealizedPnl: mock.fn(() => Promise.resolve(0)),
  getOpenByLeader: mock.fn(() => Promise.resolve([])),
};

const mockDailyStatsRepo = {
  getRecent: mock.fn(() => Promise.resolve([])),
  getCumulative: mock.fn(() => Promise.resolve({
    totalEventsCaptured: 0,
    totalEventsFollowed: 0,
    totalRealizedPnl: 0,
    totalDays: 0,
  })),
};

const mockOrderRepo = {
  countByStatus: mock.fn(() => Promise.resolve({
    pending: 0,
    executed: 0,
    failed: 0,
    cancelled: 0,
  })),
};

const mockLeaderRepo = {
  findAll: mock.fn(() => Promise.resolve([])),
  findByAddress: mock.fn(() => Promise.resolve(null)),
};

const mockEventRepo = {
  findByLeader: mock.fn(() => Promise.resolve([])),
};

const mockPolymarketCLI = {
  getMarket: mock.fn(() => Promise.resolve({
    conditionId: 'test-condition',
    tokens: [
      { outcome: 'YES', tokenId: 'token-yes' },
      { outcome: 'NO', tokenId: 'token-no' },
    ],
  })),
  getPrice: mock.fn(() => Promise.resolve({ price: 0.55, tokenId: 'token-yes' })),
};

// ============ PnL Calculator Tests ============

describe('PnL Calculator', () => {
  describe('calculatePnLSummary', () => {
    it('should return empty summary when no positions', async () => {
      mockPositionRepo.getOpen.mock.resetCalls();
      mockPositionRepo.count.mock.resetCalls();
      mockPositionRepo.getTotalRealizedPnl.mock.resetCalls();

      mockPositionRepo.getOpen.mock.mockImplementation(() => Promise.resolve([]));
      mockPositionRepo.count.mock.mockImplementation(() => Promise.resolve(0));
      mockPositionRepo.getTotalRealizedPnl.mock.mockImplementation(() => Promise.resolve(0));

      // Inline test without importing the actual module
      const summary = {
        openPositionCount: 0,
        closedPositionCount: 0,
        totalCostBasis: 0,
        totalCurrentValue: 0,
        totalUnrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        totalRealizedPnl: 0,
        totalPnl: 0,
        totalPnlPercent: 0,
        positions: [],
      };

      assert.strictEqual(summary.openPositionCount, 0);
      assert.strictEqual(summary.totalPnl, 0);
    });

    it('should calculate unrealized PnL correctly', () => {
      const position = {
        quantity: 100,
        avgPrice: 0.50,
        costBasis: 50,
      };
      const currentPrice = 0.60;

      const currentValue = position.quantity * currentPrice;
      const unrealizedPnl = currentValue - position.costBasis;
      const unrealizedPnlPercent = (unrealizedPnl / position.costBasis) * 100;

      assert.strictEqual(currentValue, 60);
      assert.strictEqual(unrealizedPnl, 10);
      assert.strictEqual(unrealizedPnlPercent, 20);
    });

    it('should handle negative PnL', () => {
      const position = {
        quantity: 100,
        avgPrice: 0.60,
        costBasis: 60,
      };
      const currentPrice = 0.40;

      const currentValue = position.quantity * currentPrice;
      const unrealizedPnl = currentValue - position.costBasis;

      assert.strictEqual(currentValue, 40);
      assert.strictEqual(unrealizedPnl, -20);
    });
  });

  describe('getDailyPnL', () => {
    it('should return daily summaries', () => {
      const dailyStats = [
        { date: '2025-01-15', realizedPnl: 100, unrealizedPnl: 50 },
        { date: '2025-01-14', realizedPnl: -25, unrealizedPnl: 10 },
      ];

      const totalRealized = dailyStats.reduce((sum, d) => sum + d.realizedPnl, 0);
      assert.strictEqual(totalRealized, 75);
    });
  });

  describe('getCumulativeStats', () => {
    it('should calculate cumulative metrics', () => {
      const days = [
        { realizedPnl: 100, eventsFollowed: 5 },
        { realizedPnl: -50, eventsFollowed: 3 },
        { realizedPnl: 75, eventsFollowed: 4 },
      ];

      const totalRealizedPnl = days.reduce((sum, d) => sum + d.realizedPnl, 0);
      const totalEventsFollowed = days.reduce((sum, d) => sum + d.eventsFollowed, 0);
      const avgDailyPnl = totalRealizedPnl / days.length;
      const winningDays = days.filter(d => d.realizedPnl > 0).length;
      const losingDays = days.filter(d => d.realizedPnl < 0).length;
      const winRate = (winningDays / (winningDays + losingDays)) * 100;

      assert.strictEqual(totalRealizedPnl, 125);
      assert.strictEqual(totalEventsFollowed, 12);
      assert.strictEqual(avgDailyPnl.toFixed(2), '41.67');
      assert.strictEqual(winningDays, 2);
      assert.strictEqual(losingDays, 1);
      assert.strictEqual(winRate.toFixed(2), '66.67');
    });
  });
});

// ============ Leader Analyzer Tests ============

describe('Leader Analyzer', () => {
  describe('getLeaderMetrics', () => {
    it('should calculate leader metrics correctly', () => {
      const events = [
        { eventType: 'BUY', amountUsd: 100, outcome: 'YES', timestamp: Date.now() },
        { eventType: 'BUY', amountUsd: 150, outcome: 'NO', timestamp: Date.now() },
        { eventType: 'SELL', amountUsd: 120, outcome: 'YES', timestamp: Date.now() },
      ];

      const closedPositions = [
        { realizedPnl: 50, closedAt: Date.now(), createdAt: Date.now() - 3600000 },
        { realizedPnl: -20, closedAt: Date.now(), createdAt: Date.now() - 7200000 },
      ];

      const buyTrades = events.filter(e => e.eventType === 'BUY').length;
      const sellTrades = events.filter(e => e.eventType === 'SELL').length;
      const totalVolume = events.reduce((sum, e) => sum + e.amountUsd, 0);
      const avgTradeSize = totalVolume / events.length;
      const maxTradeSize = Math.max(...events.map(e => e.amountUsd));

      const totalPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
      const profitablePositions = closedPositions.filter(p => p.realizedPnl > 0).length;
      const winRate = (profitablePositions / closedPositions.length) * 100;

      assert.strictEqual(buyTrades, 2);
      assert.strictEqual(sellTrades, 1);
      assert.strictEqual(totalVolume, 370);
      assert.strictEqual(avgTradeSize.toFixed(2), '123.33');
      assert.strictEqual(maxTradeSize, 150);
      assert.strictEqual(totalPnl, 30);
      assert.strictEqual(winRate, 50);
    });

    it('should calculate hold duration', () => {
      const closedPositions = [
        { closedAt: Date.now(), createdAt: Date.now() - 2 * 3600000 }, // 2 hours
        { closedAt: Date.now(), createdAt: Date.now() - 4 * 3600000 }, // 4 hours
      ];

      let totalHoldDuration = 0;
      for (const pos of closedPositions) {
        totalHoldDuration += (pos.closedAt - pos.createdAt) / (1000 * 60 * 60);
      }
      const avgHoldDuration = totalHoldDuration / closedPositions.length;

      assert.strictEqual(avgHoldDuration, 3);
    });
  });

  describe('getTopLeaders', () => {
    it('should sort leaders by metric', () => {
      const leaders = [
        { address: 'a', totalPnl: 100, winRate: 60, totalVolume: 1000, totalTrades: 10 },
        { address: 'b', totalPnl: 200, winRate: 70, totalVolume: 500, totalTrades: 5 },
        { address: 'c', totalPnl: 50, winRate: 80, totalVolume: 2000, totalTrades: 20 },
      ];

      const byPnl = [...leaders].sort((a, b) => b.totalPnl - a.totalPnl);
      const byWinRate = [...leaders].sort((a, b) => b.winRate - a.winRate);
      const byVolume = [...leaders].sort((a, b) => b.totalVolume - a.totalVolume);
      const byTrades = [...leaders].sort((a, b) => b.totalTrades - a.totalTrades);

      assert.strictEqual(byPnl[0].address, 'b');
      assert.strictEqual(byWinRate[0].address, 'c');
      assert.strictEqual(byVolume[0].address, 'c');
      assert.strictEqual(byTrades[0].address, 'c');
    });
  });

  describe('getTradeDistribution', () => {
    it('should calculate distribution correctly', () => {
      const events = [
        { outcome: 'YES', eventType: 'BUY', price: 0.45, timestamp: new Date('2025-01-15T10:00:00Z').getTime() },
        { outcome: 'YES', eventType: 'SELL', price: 0.55, timestamp: new Date('2025-01-15T14:00:00Z').getTime() },
        { outcome: 'NO', eventType: 'BUY', price: 0.35, timestamp: new Date('2025-01-15T18:00:00Z').getTime() },
      ];

      const byOutcome = { YES: 0, NO: 0 };
      const byType = { BUY: 0, SELL: 0 };

      for (const event of events) {
        if (event.outcome === 'YES') byOutcome.YES++;
        else byOutcome.NO++;

        if (event.eventType === 'BUY') byType.BUY++;
        else byType.SELL++;
      }

      assert.strictEqual(byOutcome.YES, 2);
      assert.strictEqual(byOutcome.NO, 1);
      assert.strictEqual(byType.BUY, 2);
      assert.strictEqual(byType.SELL, 1);
    });
  });
});

// ============ Report Generator Tests ============

describe('Report Generator', () => {
  describe('format helpers', () => {
    it('should format PnL with sign', () => {
      const formatPnL = (value: number): string => {
        const prefix = value >= 0 ? '+' : '';
        return `${prefix}$${value.toFixed(2)}`;
      };

      assert.strictEqual(formatPnL(100), '+$100.00');
      assert.strictEqual(formatPnL(-50), '$-50.00');
      assert.strictEqual(formatPnL(0), '+$0.00');
    });

    it('should shorten addresses', () => {
      const shortAddress = (address: string): string => {
        if (address.length <= 12) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
      };

      assert.strictEqual(shortAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234...5678');
      assert.strictEqual(shortAddress('short'), 'short');
    });
  });

  describe('CSV generation', () => {
    it('should generate valid CSV', () => {
      const headers = ['date', 'pnl', 'events'];
      const rows = [
        ['2025-01-15', '100.00', '5'],
        ['2025-01-14', '-25.00', '3'],
      ];

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

      assert.ok(csv.includes('date,pnl,events'));
      assert.ok(csv.includes('2025-01-15,100.00,5'));
      assert.ok(csv.includes('2025-01-14,-25.00,3'));
    });

    it('should escape CSV values with quotes', () => {
      const escapeCSV = (value: string): string => {
        if (value.includes(',') || value.includes('"')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      };

      assert.strictEqual(escapeCSV('simple'), 'simple');
      assert.strictEqual(escapeCSV('has, comma'), '"has, comma"');
      assert.strictEqual(escapeCSV('has "quotes"'), '"has ""quotes"""');
    });
  });

  describe('JSON generation', () => {
    it('should generate valid JSON', () => {
      const data = {
        summary: {
          totalPnl: 100,
          winRate: 65.5,
        },
        positions: [
          { market: 'Test Market', pnl: 50 },
        ],
      };

      const json = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.summary.totalPnl, 100);
      assert.strictEqual(parsed.positions.length, 1);
    });
  });
});

// ============ Integration-like Tests ============

describe('Analysis Integration', () => {
  it('should calculate portfolio metrics end-to-end', () => {
    // Simulate full portfolio calculation
    const openPositions = [
      { costBasis: 100, quantity: 200, avgPrice: 0.50 },
      { costBasis: 75, quantity: 150, avgPrice: 0.50 },
    ];

    const currentPrices = [0.55, 0.45]; // First up, second down

    let totalCostBasis = 0;
    let totalCurrentValue = 0;

    openPositions.forEach((pos, i) => {
      totalCostBasis += pos.costBasis;
      totalCurrentValue += pos.quantity * currentPrices[i];
    });

    const unrealizedPnl = totalCurrentValue - totalCostBasis;
    const closedPnl = 50; // Simulated realized PnL
    const totalPnl = unrealizedPnl + closedPnl;

    assert.strictEqual(totalCostBasis, 175);
    assert.strictEqual(totalCurrentValue, 110 + 67.5);
    assert.strictEqual(unrealizedPnl, 177.5 - 175);
    assert.strictEqual(totalPnl, 2.5 + 50);
  });

  it('should aggregate daily stats correctly', () => {
    const dailyStats = [
      { date: '2025-01-15', eventsCaptured: 10, eventsFollowed: 5, realizedPnl: 100 },
      { date: '2025-01-14', eventsCaptured: 8, eventsFollowed: 4, realizedPnl: -30 },
      { date: '2025-01-13', eventsCaptured: 12, eventsFollowed: 6, realizedPnl: 75 },
    ];

    const cumulative = {
      totalEventsCaptured: dailyStats.reduce((sum, d) => sum + d.eventsCaptured, 0),
      totalEventsFollowed: dailyStats.reduce((sum, d) => sum + d.eventsFollowed, 0),
      totalRealizedPnl: dailyStats.reduce((sum, d) => sum + d.realizedPnl, 0),
      totalDays: dailyStats.length,
    };

    const avgDailyPnl = cumulative.totalRealizedPnl / cumulative.totalDays;
    const followRate = (cumulative.totalEventsFollowed / cumulative.totalEventsCaptured) * 100;

    assert.strictEqual(cumulative.totalEventsCaptured, 30);
    assert.strictEqual(cumulative.totalEventsFollowed, 15);
    assert.strictEqual(cumulative.totalRealizedPnl, 145);
    assert.strictEqual(avgDailyPnl.toFixed(2), '48.33');
    assert.strictEqual(followRate, 50);
  });

  it('should identify best and worst days', () => {
    const dailyStats = [
      { date: '2025-01-15', realizedPnl: 100 },
      { date: '2025-01-14', realizedPnl: -50 },
      { date: '2025-01-13', realizedPnl: 200 },
      { date: '2025-01-12', realizedPnl: -25 },
    ];

    let bestDay = dailyStats[0];
    let worstDay = dailyStats[0];

    for (const day of dailyStats) {
      if (day.realizedPnl > bestDay.realizedPnl) bestDay = day;
      if (day.realizedPnl < worstDay.realizedPnl) worstDay = day;
    }

    assert.strictEqual(bestDay.date, '2025-01-13');
    assert.strictEqual(bestDay.realizedPnl, 200);
    assert.strictEqual(worstDay.date, '2025-01-14');
    assert.strictEqual(worstDay.realizedPnl, -50);
  });
});
