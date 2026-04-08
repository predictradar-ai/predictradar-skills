/**
 * CopyHunter - Leader Repository
 */

import { eq, desc, sql } from 'drizzle-orm';
import { getDb, leaders } from '../index.js';
import type { LeaderRow, NewLeader } from '../schema.js';

export interface LeaderStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  lastTradeAt: number | null;
}

export class LeaderRepository {
  private get db() {
    return getDb();
  }

  /**
   * Add a new leader
   */
  async add(data: {
    address: string;
    alias?: string;
    tags?: string[];
    platform?: string;
  }): Promise<LeaderRow> {
    const now = Date.now();
    const result = await this.db.insert(leaders).values({
      address: data.address.toLowerCase(),
      alias: data.alias,
      tags: data.tags ? JSON.stringify(data.tags) : null,
      platform: data.platform ?? 'polymarket',
      addedAt: now,
      updatedAt: now,
    }).returning();
    return result[0];
  }

  /**
   * Get a leader by address
   */
  async getByAddress(address: string): Promise<LeaderRow | undefined> {
    return this.db.query.leaders.findFirst({
      where: eq(leaders.address, address.toLowerCase()),
    });
  }

  /**
   * Get all leaders
   */
  async getAll(): Promise<LeaderRow[]> {
    return this.db.query.leaders.findMany({
      orderBy: [desc(leaders.addedAt)],
    });
  }

  /**
   * Get active leaders for monitoring
   */
  async getActive(platform?: string): Promise<LeaderRow[]> {
    if (platform) {
      return this.db.query.leaders.findMany({
        where: eq(leaders.platform, platform),
      });
    }
    return this.db.query.leaders.findMany();
  }

  /**
   * Update leader info
   */
  async update(address: string, data: Partial<{
    alias: string;
    tags: string[];
  }>): Promise<LeaderRow | undefined> {
    const result = await this.db.update(leaders)
      .set({
        alias: data.alias,
        tags: data.tags ? JSON.stringify(data.tags) : undefined,
        updatedAt: Date.now(),
      })
      .where(eq(leaders.address, address.toLowerCase()))
      .returning();
    return result[0];
  }

  /**
   * Update leader stats
   */
  async updateStats(address: string, stats: LeaderStats): Promise<void> {
    await this.db.update(leaders)
      .set({
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        lastTradeAt: stats.lastTradeAt,
        updatedAt: Date.now(),
      })
      .where(eq(leaders.address, address.toLowerCase()));
  }

  /**
   * Remove a leader
   */
  async remove(address: string): Promise<boolean> {
    const result = await this.db.delete(leaders)
      .where(eq(leaders.address, address.toLowerCase()))
      .returning();
    return result.length > 0;
  }

  /**
   * Check if a leader exists
   */
  async exists(address: string): Promise<boolean> {
    const leader = await this.getByAddress(address);
    return !!leader;
  }

  /**
   * Get leader count
   */
  async count(): Promise<number> {
    const result = await this.db.select({ count: sql<number>`count(*)` })
      .from(leaders);
    return result[0].count;
  }
}

// Singleton
let leaderRepo: LeaderRepository | null = null;

export function getLeaderRepo(): LeaderRepository {
  if (!leaderRepo) {
    leaderRepo = new LeaderRepository();
  }
  return leaderRepo;
}
