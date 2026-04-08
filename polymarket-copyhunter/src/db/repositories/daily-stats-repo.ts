/**
 * CopyHunter - Daily Stats Repository
 */

import { eq, desc, and, sql } from 'drizzle-orm';
import { getDb, dailyStats } from '../index.js';
import type { DailyStatsRow } from '../schema.js';

export class DailyStatsRepository {
  private get db() {
    return getDb();
  }

  /**
   * Get today's date string
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  private async ensureTodayExists(date: string, platform: string): Promise<void> {
    await this.db.insert(dailyStats)
      .values({
        date,
        platform,
      })
      .onConflictDoNothing({
        target: [dailyStats.date, dailyStats.platform],
      });
  }

  private whereToday(date: string, platform: string) {
    return and(
      eq(dailyStats.date, date),
      eq(dailyStats.platform, platform)
    );
  }

  /**
   * Get or create today's stats
   */
  async getOrCreateToday(platform = 'polymarket'): Promise<DailyStatsRow> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);

    const stats = await this.db.query.dailyStats.findFirst({
      where: this.whereToday(date, platform),
    });

    if (!stats) {
      throw new Error(`Failed to load daily stats for ${platform} on ${date}.`);
    }

    return stats;
  }

  /**
   * Increment events captured
   */
  async incrementEventsCaptured(count = 1, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        eventsCaptured: sql`${dailyStats.eventsCaptured} + ${count}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Increment events followed
   */
  async incrementEventsFollowed(count = 1, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        eventsFollowed: sql`${dailyStats.eventsFollowed} + ${count}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Increment events skipped
   */
  async incrementEventsSkipped(count = 1, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        eventsSkipped: sql`${dailyStats.eventsSkipped} + ${count}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Increment positions opened
   */
  async incrementPositionsOpened(count = 1, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        positionsOpened: sql`${dailyStats.positionsOpened} + ${count}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Increment positions closed
   */
  async incrementPositionsClosed(count = 1, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        positionsClosed: sql`${dailyStats.positionsClosed} + ${count}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Add to realized PnL
   */
  async addRealizedPnl(amount: number, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        realizedPnl: sql`${dailyStats.realizedPnl} + ${amount}`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Update exposure
   */
  async updateExposure(totalExposure: number, platform = 'polymarket'): Promise<void> {
    const date = this.getTodayDate();
    await this.ensureTodayExists(date, platform);
    await this.db.update(dailyStats)
      .set({
        totalExposure,
        maxExposure: sql`max(${dailyStats.maxExposure}, ${totalExposure})`,
      })
      .where(this.whereToday(date, platform));
  }

  /**
   * Get recent daily stats
   */
  async getRecent(days = 7, platform?: string): Promise<DailyStatsRow[]> {
    const conditions = [];

    if (platform) {
      conditions.push(eq(dailyStats.platform, platform));
    }

    return this.db.query.dailyStats.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(dailyStats.date)],
      limit: days,
    });
  }

  /**
   * Get stats for a specific date
   */
  async getByDate(date: string, platform = 'polymarket'): Promise<DailyStatsRow | undefined> {
    return this.db.query.dailyStats.findFirst({
      where: and(
        eq(dailyStats.date, date),
        eq(dailyStats.platform, platform)
      ),
    });
  }

  /**
   * Get cumulative stats
   */
  async getCumulative(platform?: string): Promise<{
    totalEventsCaptured: number;
    totalEventsFollowed: number;
    totalRealizedPnl: number;
    totalDays: number;
  }> {
    const conditions = platform ? [eq(dailyStats.platform, platform)] : [];

    const result = await this.db
      .select({
        totalEventsCaptured: sql<number>`COALESCE(SUM(events_captured), 0)`,
        totalEventsFollowed: sql<number>`COALESCE(SUM(events_followed), 0)`,
        totalRealizedPnl: sql<number>`COALESCE(SUM(realized_pnl), 0)`,
        totalDays: sql<number>`COUNT(*)`,
      })
      .from(dailyStats)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return {
      totalEventsCaptured: result[0].totalEventsCaptured,
      totalEventsFollowed: result[0].totalEventsFollowed,
      totalRealizedPnl: result[0].totalRealizedPnl,
      totalDays: result[0].totalDays,
    };
  }
}

// Singleton
let statsRepo: DailyStatsRepository | null = null;

export function getDailyStatsRepo(): DailyStatsRepository {
  if (!statsRepo) {
    statsRepo = new DailyStatsRepository();
  }
  return statsRepo;
}
