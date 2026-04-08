/**
 * CopyHunter - Position Repository
 */

import { eq, desc, and, sql } from 'drizzle-orm';
import { getDb, positionLots, positions } from '../index.js';
import type { PositionRow, NewPosition } from '../schema.js';

export interface PositionFilter {
  leaderAddress?: string;
  platform?: string;
  conditionId?: string;
  outcome?: string;
  status?: 'open' | 'closed';
}

export class PositionRepository {
  private get db() {
    return getDb();
  }

  /**
   * Upsert a position (update if exists, insert if not)
   */
  async upsert(data: {
    leaderAddress: string;
    platform: string;
    conditionId: string;
    marketSlug?: string;
    marketTitle?: string;
    outcome: string;
    quantity: number;
    avgPrice: number;
    costBasis: number;
  }): Promise<PositionRow> {
    const now = Date.now();

    // Check if exists
    const existing = await this.db.query.positions.findFirst({
      where: and(
        eq(positions.leaderAddress, data.leaderAddress.toLowerCase()),
        eq(positions.conditionId, data.conditionId),
        eq(positions.outcome, data.outcome)
      ),
    });

    if (existing) {
      // Update existing position
      const result = await this.db.update(positions)
        .set({
          quantity: data.quantity,
          avgPrice: data.avgPrice,
          costBasis: data.costBasis,
          marketSlug: data.marketSlug,
          marketTitle: data.marketTitle,
          updatedAt: now,
        })
        .where(eq(positions.id, existing.id))
        .returning();
      return result[0];
    }

    // Insert new position
    const result = await this.db.insert(positions).values({
      leaderAddress: data.leaderAddress.toLowerCase(),
      platform: data.platform,
      conditionId: data.conditionId,
      marketSlug: data.marketSlug,
      marketTitle: data.marketTitle,
      outcome: data.outcome,
      quantity: data.quantity,
      avgPrice: data.avgPrice,
      costBasis: data.costBasis,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }).returning();

    return result[0];
  }

  /**
   * Get positions with filters
   */
  async find(filter: PositionFilter, limit = 100): Promise<PositionRow[]> {
    const conditions = [];

    if (filter.leaderAddress) {
      conditions.push(eq(positions.leaderAddress, filter.leaderAddress.toLowerCase()));
    }
    if (filter.platform) {
      conditions.push(eq(positions.platform, filter.platform));
    }
    if (filter.conditionId) {
      conditions.push(eq(positions.conditionId, filter.conditionId));
    }
    if (filter.outcome) {
      conditions.push(eq(positions.outcome, filter.outcome));
    }
    if (filter.status) {
      conditions.push(eq(positions.status, filter.status));
    }

    return this.db.query.positions.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(positions.updatedAt)],
      limit,
    });
  }

  /**
   * Get all open positions
   */
  async getOpen(): Promise<PositionRow[]> {
    return this.find({ status: 'open' });
  }

  /**
   * Get open positions for a leader
   */
  async getOpenByLeader(address: string): Promise<PositionRow[]> {
    return this.find({ leaderAddress: address, status: 'open' });
  }

  async getByKey(params: {
    leaderAddress: string;
    conditionId: string;
    outcome: string;
  }): Promise<PositionRow | undefined> {
    return this.db.query.positions.findFirst({
      where: and(
        eq(positions.leaderAddress, params.leaderAddress.toLowerCase()),
        eq(positions.conditionId, params.conditionId),
        eq(positions.outcome, params.outcome)
      ),
    });
  }

  async syncAggregateFromLots(params: {
    leaderAddress: string;
    platform: string;
    conditionId: string;
    outcome: string;
    marketSlug?: string;
    marketTitle?: string;
    closedAt?: number | null;
  }): Promise<PositionRow | undefined> {
    const leaderAddress = params.leaderAddress.toLowerCase();
    const existing = await this.getByKey({
      leaderAddress,
      conditionId: params.conditionId,
      outcome: params.outcome,
    });

    const [openSummary] = await this.db
      .select({
        quantity: sql<number>`COALESCE(SUM(${positionLots.remainingQuantity}), 0)`,
        costBasis: sql<number>`COALESCE(SUM(${positionLots.remainingQuantity} * ${positionLots.avgPrice}), 0)`,
      })
      .from(positionLots)
      .where(and(
        eq(positionLots.leaderAddress, leaderAddress),
        eq(positionLots.platform, params.platform),
        eq(positionLots.conditionId, params.conditionId),
        eq(positionLots.outcome, params.outcome),
        eq(positionLots.status, 'open'),
      ));

    const [realizedSummary] = await this.db
      .select({
        realizedPnl: sql<number>`COALESCE(SUM(${positionLots.realizedPnl}), 0)`,
      })
      .from(positionLots)
      .where(and(
        eq(positionLots.leaderAddress, leaderAddress),
        eq(positionLots.platform, params.platform),
        eq(positionLots.conditionId, params.conditionId),
        eq(positionLots.outcome, params.outcome),
      ));

    const quantity = openSummary.quantity;
    const costBasis = openSummary.costBasis;
    const avgPrice = quantity > 0 ? costBasis / quantity : 0;
    const now = Date.now();
    const status = quantity > 0 ? 'open' : 'closed';
    const closedAt = quantity > 0 ? null : (params.closedAt ?? now);

    if (existing) {
      const result = await this.db.update(positions)
        .set({
          platform: params.platform,
          marketSlug: params.marketSlug ?? existing.marketSlug,
          marketTitle: params.marketTitle ?? existing.marketTitle,
          quantity,
          avgPrice,
          costBasis,
          status,
          realizedPnl: realizedSummary.realizedPnl,
          closedAt,
          updatedAt: now,
        })
        .where(eq(positions.id, existing.id))
        .returning();
      return result[0];
    }

    if (quantity <= 0 && realizedSummary.realizedPnl === 0) {
      return undefined;
    }

    const result = await this.db.insert(positions).values({
      leaderAddress,
      platform: params.platform,
      conditionId: params.conditionId,
      marketSlug: params.marketSlug,
      marketTitle: params.marketTitle,
      outcome: params.outcome,
      quantity,
      avgPrice,
      costBasis,
      status,
      realizedPnl: realizedSummary.realizedPnl,
      closedAt,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [positions.leaderAddress, positions.conditionId, positions.outcome],
      set: {
        platform: params.platform,
        marketSlug: params.marketSlug,
        marketTitle: params.marketTitle,
        quantity,
        avgPrice,
        costBasis,
        status,
        realizedPnl: realizedSummary.realizedPnl,
        closedAt,
        updatedAt: now,
      },
    }).returning();
    return result[0];
  }

  /**
   * Close a position
   */
  async close(id: number, realizedPnl: number): Promise<PositionRow | undefined> {
    const now = Date.now();
    const result = await this.db.update(positions)
      .set({
        status: 'closed',
        realizedPnl,
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(positions.id, id))
      .returning();
    return result[0];
  }

  /**
   * Update position quantity
   */
  async updateQuantity(
    id: number,
    quantity: number,
    avgPrice: number,
    costBasis: number
  ): Promise<void> {
    await this.db.update(positions)
      .set({
        quantity,
        avgPrice,
        costBasis,
        updatedAt: Date.now(),
      })
      .where(eq(positions.id, id));
  }

  /**
   * Get total exposure (sum of open position cost basis)
   */
  async getTotalExposure(): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(cost_basis), 0)` })
      .from(positions)
      .where(eq(positions.status, 'open'));
    return result[0].total;
  }

  /**
   * Get position count
   */
  async count(filter?: PositionFilter): Promise<number> {
    const conditions = [];

    if (filter?.status) {
      conditions.push(eq(positions.status, filter.status));
    }
    if (filter?.leaderAddress) {
      conditions.push(eq(positions.leaderAddress, filter.leaderAddress.toLowerCase()));
    }

    const result = await this.db.select({ count: sql<number>`count(*)` })
      .from(positions)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return result[0].count;
  }

  /**
   * Get realized PnL total
   */
  async getTotalRealizedPnl(): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(realized_pnl), 0)` })
      .from(positions)
      .where(eq(positions.status, 'closed'));
    return result[0].total;
  }
}

// Singleton
let positionRepo: PositionRepository | null = null;

export function getPositionRepo(): PositionRepository {
  if (!positionRepo) {
    positionRepo = new PositionRepository();
  }
  return positionRepo;
}
