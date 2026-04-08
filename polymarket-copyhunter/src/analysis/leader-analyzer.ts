/**
 * CopyHunter - Leader Analyzer
 *
 * Analyzes leader trading patterns and performance
 */

import { getLeaderRepo } from '../db/repositories/leader-repo.js';
import { getEventRepo } from '../db/repositories/event-repo.js';
import { getPositionRepo } from '../db/repositories/position-repo.js';
import type { LeaderRow, EventRow, PositionRow } from '../db/schema.js';

export interface LeaderMetrics {
  address: string;
  alias?: string | null;
  // Trading activity
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  // Volume
  totalVolume: number;
  avgTradeSize: number;
  maxTradeSize: number;
  // Performance
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  // Timing
  avgHoldDuration: number; // in hours
  lastTradeAt: number | null;
  tradingDays: number;
  // Position stats
  openPositions: number;
  closedPositions: number;
}

export interface LeaderComparison {
  leaders: LeaderMetrics[];
  best: {
    byPnl: LeaderMetrics | null;
    byWinRate: LeaderMetrics | null;
    byVolume: LeaderMetrics | null;
    byTrades: LeaderMetrics | null;
  };
  summary: {
    totalLeaders: number;
    totalTrades: number;
    totalVolume: number;
    avgWinRate: number;
    avgPnl: number;
  };
}

export interface TradeDistribution {
  leaderAddress: string;
  byOutcome: { YES: number; NO: number };
  byType: { BUY: number; SELL: number };
  byHour: number[]; // 24 hours
  byDayOfWeek: number[]; // 7 days (0 = Sunday)
  byPriceRange: {
    range: string;
    count: number;
  }[];
}

export class LeaderAnalyzer {
  private leaderRepo = getLeaderRepo();
  private eventRepo = getEventRepo();
  private positionRepo = getPositionRepo();

  /**
   * Get detailed metrics for a single leader
   */
  async getLeaderMetrics(address: string): Promise<LeaderMetrics | null> {
    const leader = await this.leaderRepo.getByAddress(address);
    if (!leader) return null;

    // Get all events for this leader
    const events = await this.eventRepo.find({ leaderAddress: address }, 10000);
    const openPositions = await this.positionRepo.getOpenByLeader(address);
    const closedPositions = await this.positionRepo.find({ leaderAddress: address, status: 'closed' });

    // Calculate metrics
    const buyTrades = events.filter(e => e.eventType === 'BUY').length;
    const sellTrades = events.filter(e => e.eventType === 'SELL').length;
    const totalVolume = events.reduce((sum, e) => sum + e.amountUsd, 0);
    const maxTradeSize = events.length > 0
      ? Math.max(...events.map(e => e.amountUsd))
      : 0;

    // Calculate PnL and win rate from closed positions
    const totalPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const profitablePositions = closedPositions.filter(p => p.realizedPnl > 0).length;
    const winRate = closedPositions.length > 0
      ? (profitablePositions / closedPositions.length) * 100
      : 0;

    // Calculate average hold duration
    let totalHoldDuration = 0;
    let positionsWithDuration = 0;

    for (const pos of closedPositions) {
      if (pos.closedAt && pos.createdAt) {
        totalHoldDuration += (pos.closedAt - pos.createdAt) / (1000 * 60 * 60); // hours
        positionsWithDuration++;
      }
    }

    const avgHoldDuration = positionsWithDuration > 0
      ? totalHoldDuration / positionsWithDuration
      : 0;

    // Count unique trading days
    const tradingDays = new Set(
      events.map(e => new Date(e.timestamp).toISOString().split('T')[0])
    ).size;

    return {
      address,
      alias: leader.alias,
      totalTrades: events.length,
      buyTrades,
      sellTrades,
      totalVolume,
      avgTradeSize: events.length > 0 ? totalVolume / events.length : 0,
      maxTradeSize,
      winRate,
      totalPnl,
      avgPnlPerTrade: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
      avgHoldDuration,
      lastTradeAt: events.length > 0 ? events[0].timestamp : null,
      tradingDays,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
    };
  }

  /**
   * Compare all leaders
   */
  async compareLeaders(): Promise<LeaderComparison> {
    const leaders = await this.leaderRepo.getAll();
    const metrics: LeaderMetrics[] = [];

    for (const leader of leaders) {
      const m = await this.getLeaderMetrics(leader.address);
      if (m) metrics.push(m);
    }

    // Find best performers
    let byPnl: LeaderMetrics | null = null;
    let byWinRate: LeaderMetrics | null = null;
    let byVolume: LeaderMetrics | null = null;
    let byTrades: LeaderMetrics | null = null;

    for (const m of metrics) {
      if (!byPnl || m.totalPnl > byPnl.totalPnl) byPnl = m;
      if (!byWinRate || m.winRate > byWinRate.winRate) byWinRate = m;
      if (!byVolume || m.totalVolume > byVolume.totalVolume) byVolume = m;
      if (!byTrades || m.totalTrades > byTrades.totalTrades) byTrades = m;
    }

    // Calculate summary
    const totalTrades = metrics.reduce((sum, m) => sum + m.totalTrades, 0);
    const totalVolume = metrics.reduce((sum, m) => sum + m.totalVolume, 0);
    const avgWinRate = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.winRate, 0) / metrics.length
      : 0;
    const avgPnl = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.totalPnl, 0) / metrics.length
      : 0;

    return {
      leaders: metrics,
      best: { byPnl, byWinRate, byVolume, byTrades },
      summary: {
        totalLeaders: metrics.length,
        totalTrades,
        totalVolume,
        avgWinRate,
        avgPnl,
      },
    };
  }

  /**
   * Get trade distribution for a leader
   */
  async getTradeDistribution(address: string): Promise<TradeDistribution> {
    const events = await this.eventRepo.find({ leaderAddress: address }, 10000);

    const byOutcome = { YES: 0, NO: 0 };
    const byType = { BUY: 0, SELL: 0 };
    const byHour = new Array(24).fill(0);
    const byDayOfWeek = new Array(7).fill(0);
    const priceRanges: Record<string, number> = {
      '0-0.1': 0,
      '0.1-0.2': 0,
      '0.2-0.3': 0,
      '0.3-0.4': 0,
      '0.4-0.5': 0,
      '0.5-0.6': 0,
      '0.6-0.7': 0,
      '0.7-0.8': 0,
      '0.8-0.9': 0,
      '0.9-1.0': 0,
    };

    for (const event of events) {
      // By outcome
      if (event.outcome === 'YES') byOutcome.YES++;
      else if (event.outcome === 'NO') byOutcome.NO++;

      // By type
      if (event.eventType === 'BUY') byType.BUY++;
      else byType.SELL++;

      // By hour
      const date = new Date(event.timestamp);
      byHour[date.getUTCHours()]++;
      byDayOfWeek[date.getUTCDay()]++;

      // By price range
      const price = event.price;
      if (price < 0.1) priceRanges['0-0.1']++;
      else if (price < 0.2) priceRanges['0.1-0.2']++;
      else if (price < 0.3) priceRanges['0.2-0.3']++;
      else if (price < 0.4) priceRanges['0.3-0.4']++;
      else if (price < 0.5) priceRanges['0.4-0.5']++;
      else if (price < 0.6) priceRanges['0.5-0.6']++;
      else if (price < 0.7) priceRanges['0.6-0.7']++;
      else if (price < 0.8) priceRanges['0.7-0.8']++;
      else if (price < 0.9) priceRanges['0.8-0.9']++;
      else priceRanges['0.9-1.0']++;
    }

    return {
      leaderAddress: address,
      byOutcome,
      byType,
      byHour,
      byDayOfWeek,
      byPriceRange: Object.entries(priceRanges).map(([range, count]) => ({
        range,
        count,
      })),
    };
  }

  /**
   * Get top N leaders by specific metric
   */
  async getTopLeaders(
    metric: 'pnl' | 'winRate' | 'volume' | 'trades',
    limit = 10
  ): Promise<LeaderMetrics[]> {
    const comparison = await this.compareLeaders();

    return [...comparison.leaders]
      .sort((a, b) => {
        switch (metric) {
          case 'pnl':
            return b.totalPnl - a.totalPnl;
          case 'winRate':
            return b.winRate - a.winRate;
          case 'volume':
            return b.totalVolume - a.totalVolume;
          case 'trades':
            return b.totalTrades - a.totalTrades;
        }
      })
      .slice(0, limit);
  }

  /**
   * Get recently active leaders
   */
  async getActiveLeaders(withinHours = 24): Promise<LeaderMetrics[]> {
    const comparison = await this.compareLeaders();
    const cutoff = Date.now() - (withinHours * 60 * 60 * 1000);

    return comparison.leaders.filter(
      m => m.lastTradeAt && m.lastTradeAt > cutoff
    );
  }
}

// Singleton
let analyzer: LeaderAnalyzer | null = null;

export function getLeaderAnalyzer(): LeaderAnalyzer {
  if (!analyzer) {
    analyzer = new LeaderAnalyzer();
  }
  return analyzer;
}
