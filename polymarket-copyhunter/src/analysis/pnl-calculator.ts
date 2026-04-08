/**
 * CopyHunter - PnL Calculator
 *
 * Calculates realized and unrealized PnL for positions
 */

import { getPositionRepo } from '../db/repositories/position-repo.js';
import { getOrderRepo } from '../db/repositories/order-repo.js';
import { getDailyStatsRepo } from '../db/repositories/daily-stats-repo.js';
import { getPolymarketCLI } from '../platforms/polymarket/cli-wrapper.js';
import type { PositionRow } from '../db/schema.js';

export interface PositionPnL {
  position: PositionRow;
  currentPrice: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface PnLSummary {
  // Open positions
  openPositionCount: number;
  totalCostBasis: number;
  totalCurrentValue: number;
  totalUnrealizedPnl: number;
  unrealizedPnlPercent: number;

  // Closed positions
  closedPositionCount: number;
  totalRealizedPnl: number;

  // Combined
  totalPnl: number;
  totalPnlPercent: number;

  // Positions with details
  positions: PositionPnL[];
}

export interface DailyPnLSummary {
  date: string;
  realizedPnl: number;
  unrealizedPnl: number;
  eventsCaptured: number;
  eventsFollowed: number;
  positionsOpened: number;
  positionsClosed: number;
  totalExposure: number;
  maxExposure: number;
}

export interface CumulativeStats {
  totalDays: number;
  totalEventsCaptured: number;
  totalEventsFollowed: number;
  totalRealizedPnl: number;
  avgDailyPnl: number;
  bestDay: DailyPnLSummary | null;
  worstDay: DailyPnLSummary | null;
  winningDays: number;
  losingDays: number;
  winRate: number;
}

export class PnLCalculator {
  private positionRepo = getPositionRepo();
  private orderRepo = getOrderRepo();
  private dailyStatsRepo = getDailyStatsRepo();
  private cli = getPolymarketCLI();

  /**
   * Calculate unrealized PnL for a single position
   */
  async calculatePositionPnL(position: PositionRow): Promise<PositionPnL> {
    let currentPrice: number;

    try {
      // Try to get current market price
      // For polymarket, we need the token ID which we may not have
      // Fall back to avgPrice if we can't get current price
      const market = await this.cli.getMarket(position.conditionId);
      const token = market.tokens.find(t => t.outcome === position.outcome);

      if (token) {
        const priceResult = await this.cli.getPrice(token.tokenId);
        currentPrice = priceResult.price;
      } else {
        currentPrice = position.avgPrice;
      }
    } catch {
      // If we can't get current price, use avg price (no unrealized PnL)
      currentPrice = position.avgPrice;
    }

    const currentValue = position.quantity * currentPrice;
    const unrealizedPnl = currentValue - position.costBasis;
    const unrealizedPnlPercent = position.costBasis > 0
      ? (unrealizedPnl / position.costBasis) * 100
      : 0;

    return {
      position,
      currentPrice,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPercent,
    };
  }

  /**
   * Calculate PnL summary for all positions
   */
  async calculatePnLSummary(): Promise<PnLSummary> {
    // Get open positions
    const openPositions = await this.positionRepo.getOpen();

    // Calculate unrealized PnL for each position
    const positionPnls: PositionPnL[] = [];
    let totalCostBasis = 0;
    let totalCurrentValue = 0;

    for (const position of openPositions) {
      const pnl = await this.calculatePositionPnL(position);
      positionPnls.push(pnl);
      totalCostBasis += position.costBasis;
      totalCurrentValue += pnl.currentValue;
    }

    const totalUnrealizedPnl = totalCurrentValue - totalCostBasis;
    const unrealizedPnlPercent = totalCostBasis > 0
      ? (totalUnrealizedPnl / totalCostBasis) * 100
      : 0;

    // Get realized PnL
    const totalRealizedPnl = await this.positionRepo.getTotalRealizedPnl();
    const closedCount = await this.positionRepo.count({ status: 'closed' });

    // Combined
    const totalPnl = totalRealizedPnl + totalUnrealizedPnl;
    const totalInvested = totalCostBasis + Math.abs(totalRealizedPnl);
    const totalPnlPercent = totalInvested > 0
      ? (totalPnl / totalInvested) * 100
      : 0;

    return {
      openPositionCount: openPositions.length,
      totalCostBasis,
      totalCurrentValue,
      totalUnrealizedPnl,
      unrealizedPnlPercent,
      closedPositionCount: closedCount,
      totalRealizedPnl,
      totalPnl,
      totalPnlPercent,
      positions: positionPnls,
    };
  }

  /**
   * Get daily PnL summaries
   */
  async getDailyPnL(days = 7): Promise<DailyPnLSummary[]> {
    const stats = await this.dailyStatsRepo.getRecent(days);

    return stats.map(s => ({
      date: s.date,
      realizedPnl: s.realizedPnl,
      unrealizedPnl: s.unrealizedPnl,
      eventsCaptured: s.eventsCaptured,
      eventsFollowed: s.eventsFollowed,
      positionsOpened: s.positionsOpened,
      positionsClosed: s.positionsClosed,
      totalExposure: s.totalExposure,
      maxExposure: s.maxExposure,
    }));
  }

  /**
   * Get cumulative statistics
   */
  async getCumulativeStats(): Promise<CumulativeStats> {
    const cumulative = await this.dailyStatsRepo.getCumulative();
    const allDays = await this.dailyStatsRepo.getRecent(365);

    // Find best and worst days
    let bestDay: DailyPnLSummary | null = null;
    let worstDay: DailyPnLSummary | null = null;
    let winningDays = 0;
    let losingDays = 0;

    for (const day of allDays) {
      const daySummary: DailyPnLSummary = {
        date: day.date,
        realizedPnl: day.realizedPnl,
        unrealizedPnl: day.unrealizedPnl,
        eventsCaptured: day.eventsCaptured,
        eventsFollowed: day.eventsFollowed,
        positionsOpened: day.positionsOpened,
        positionsClosed: day.positionsClosed,
        totalExposure: day.totalExposure,
        maxExposure: day.maxExposure,
      };

      if (day.realizedPnl > 0) {
        winningDays++;
      } else if (day.realizedPnl < 0) {
        losingDays++;
      }

      if (!bestDay || day.realizedPnl > bestDay.realizedPnl) {
        bestDay = daySummary;
      }
      if (!worstDay || day.realizedPnl < worstDay.realizedPnl) {
        worstDay = daySummary;
      }
    }

    const avgDailyPnl = cumulative.totalDays > 0
      ? cumulative.totalRealizedPnl / cumulative.totalDays
      : 0;

    const totalDaysWithPnl = winningDays + losingDays;
    const winRate = totalDaysWithPnl > 0
      ? (winningDays / totalDaysWithPnl) * 100
      : 0;

    return {
      totalDays: cumulative.totalDays,
      totalEventsCaptured: cumulative.totalEventsCaptured,
      totalEventsFollowed: cumulative.totalEventsFollowed,
      totalRealizedPnl: cumulative.totalRealizedPnl,
      avgDailyPnl,
      bestDay,
      worstDay,
      winningDays,
      losingDays,
      winRate,
    };
  }

  /**
   * Calculate PnL by leader
   */
  async getPnLByLeader(): Promise<Array<{
    leaderAddress: string;
    openPositions: number;
    closedPositions: number;
    totalCostBasis: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
  }>> {
    const openPositions = await this.positionRepo.getOpen();
    const closedPositions = await this.positionRepo.find({ status: 'closed' });

    // Group by leader
    const leaderMap = new Map<string, {
      openPositions: PositionRow[];
      closedPositions: PositionRow[];
    }>();

    for (const pos of openPositions) {
      const entry = leaderMap.get(pos.leaderAddress) || { openPositions: [], closedPositions: [] };
      entry.openPositions.push(pos);
      leaderMap.set(pos.leaderAddress, entry);
    }

    for (const pos of closedPositions) {
      const entry = leaderMap.get(pos.leaderAddress) || { openPositions: [], closedPositions: [] };
      entry.closedPositions.push(pos);
      leaderMap.set(pos.leaderAddress, entry);
    }

    // Calculate PnL for each leader
    const results: Array<{
      leaderAddress: string;
      openPositions: number;
      closedPositions: number;
      totalCostBasis: number;
      realizedPnl: number;
      unrealizedPnl: number;
      totalPnl: number;
    }> = [];

    for (const [leaderAddress, { openPositions: open, closedPositions: closed }] of leaderMap) {
      let totalCostBasis = 0;
      let unrealizedPnl = 0;

      for (const pos of open) {
        const pnl = await this.calculatePositionPnL(pos);
        totalCostBasis += pos.costBasis;
        unrealizedPnl += pnl.unrealizedPnl;
      }

      const realizedPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0);

      results.push({
        leaderAddress,
        openPositions: open.length,
        closedPositions: closed.length,
        totalCostBasis,
        realizedPnl,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
      });
    }

    // Sort by total PnL
    results.sort((a, b) => b.totalPnl - a.totalPnl);

    return results;
  }
}

// Singleton
let calculator: PnLCalculator | null = null;

export function getPnLCalculator(): PnLCalculator {
  if (!calculator) {
    calculator = new PnLCalculator();
  }
  return calculator;
}
