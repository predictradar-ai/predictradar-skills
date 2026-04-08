/**
 * CopyHunter - Leader Stats Updater
 *
 * Updates leader winRate and totalPnl from closed positions
 */

import { getLeaderRepo } from '../db/repositories/leader-repo.js';
import { getEventRepo } from '../db/repositories/event-repo.js';
import { getPolymarketCLI } from '../platforms/polymarket/cli-wrapper.js';
import { eventBus } from '../core/events.js';
import type { ClosedPosition } from '../core/types.js';

export interface LeaderStatsResult {
  address: string;
  totalTrades: number;
  closedPositions: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  lastTradeAt: number | null;
  updated: boolean;
  error?: string;
}

export class LeaderStatsUpdater {
  private cli = getPolymarketCLI();
  private leaderRepo = getLeaderRepo();
  private eventRepo = getEventRepo();

  /**
   * Update stats for a single leader
   */
  async updateLeader(address: string): Promise<LeaderStatsResult> {
    const result: LeaderStatsResult = {
      address,
      totalTrades: 0,
      closedPositions: 0,
      wins: 0,
      winRate: 0,
      totalPnl: 0,
      lastTradeAt: null,
      updated: false,
    };

    try {
      // Get closed positions from CLI (max 50 per API limit)
      const closedPositions = await this.cli.getClosedPositions(address, 50);

      // Get trade count from events table
      const events = await this.eventRepo.find({ leaderAddress: address }, 1000);
      result.totalTrades = events.length;

      // Calculate stats from closed positions
      result.closedPositions = closedPositions.length;
      result.wins = closedPositions.filter(p => p.won).length;
      result.winRate = result.closedPositions > 0
        ? (result.wins / result.closedPositions) * 100
        : 0;
      result.totalPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);

      // Get last trade timestamp
      if (events.length > 0) {
        result.lastTradeAt = events[0].timestamp;
      }

      // Update database
      await this.leaderRepo.updateStats(address, {
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalPnl: result.totalPnl,
        lastTradeAt: result.lastTradeAt,
      });

      result.updated = true;

      eventBus.emit('stats:updated', {
        address,
        winRate: result.winRate,
        totalPnl: result.totalPnl,
      });

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      eventBus.emit('stats:error', { address, error: result.error });
    }

    return result;
  }

  /**
   * Update stats for all leaders
   */
  async updateAll(): Promise<LeaderStatsResult[]> {
    const leaders = await this.leaderRepo.getAll();
    const results: LeaderStatsResult[] = [];

    for (const leader of leaders) {
      const result = await this.updateLeader(leader.address);
      results.push(result);
    }

    return results;
  }

  /**
   * Get leader stats without updating database (dry run)
   */
  async getLeaderStats(address: string): Promise<{
    closedPositions: ClosedPosition[];
    stats: {
      total: number;
      wins: number;
      losses: number;
      winRate: number;
      totalPnl: number;
      avgPnl: number;
    };
  }> {
    const closedPositions = await this.cli.getClosedPositions(address, 50);

    const wins = closedPositions.filter(p => p.won).length;
    const losses = closedPositions.length - wins;
    const totalPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);

    return {
      closedPositions,
      stats: {
        total: closedPositions.length,
        wins,
        losses,
        winRate: closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0,
        totalPnl,
        avgPnl: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
      },
    };
  }
}

// Singleton
let updater: LeaderStatsUpdater | null = null;

export function getLeaderStatsUpdater(): LeaderStatsUpdater {
  if (!updater) {
    updater = new LeaderStatsUpdater();
  }
  return updater;
}
