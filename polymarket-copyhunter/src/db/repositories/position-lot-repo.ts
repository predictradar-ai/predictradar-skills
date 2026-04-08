/**
 * CopyHunter - Position Lot Repository
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb, positionLots } from '../index.js';
import type { NewPositionLot, PositionLotRow } from '../schema.js';

export interface PositionLotFilter {
  leaderAddress?: string;
  platform?: string;
  conditionId?: string;
  outcome?: string;
  status?: 'open' | 'closed';
}

export interface PositionLotSummary {
  openLots: number;
  closedLots: number;
  totalLots: number;
  totalExposure: number;
  realizedPnl: number;
}

export interface PositionLotGroupSummary extends PositionLotSummary {
  leaderAddress: string;
  platform: string;
  conditionId: string;
  outcome: string;
}

export class PositionLotRepository {
  private get db() {
    return getDb();
  }

  async create(data: NewPositionLot): Promise<PositionLotRow> {
    const now = Date.now();
    const result = await this.db.insert(positionLots).values({
      ...data,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    }).returning();
    return result[0];
  }

  async find(
    filter: PositionLotFilter,
    limit = 1000,
    order: 'asc' | 'desc' = 'desc'
  ): Promise<PositionLotRow[]> {
    const conditions = [];

    if (filter.leaderAddress) {
      conditions.push(eq(positionLots.leaderAddress, filter.leaderAddress.toLowerCase()));
    }
    if (filter.platform) {
      conditions.push(eq(positionLots.platform, filter.platform));
    }
    if (filter.conditionId) {
      conditions.push(eq(positionLots.conditionId, filter.conditionId));
    }
    if (filter.outcome) {
      conditions.push(eq(positionLots.outcome, filter.outcome));
    }
    if (filter.status) {
      conditions.push(eq(positionLots.status, filter.status));
    }

    return this.db.query.positionLots.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [order === 'asc' ? asc(positionLots.createdAt) : desc(positionLots.createdAt)],
      limit,
    });
  }

  async getOpenLots(params: {
    leaderAddress: string;
    platform: string;
    conditionId: string;
    outcome: string;
  }): Promise<PositionLotRow[]> {
    return this.find({
      leaderAddress: params.leaderAddress,
      platform: params.platform,
      conditionId: params.conditionId,
      outcome: params.outcome,
      status: 'open',
    }, 1000, 'asc');
  }

  async update(
    id: number,
    patch: Partial<Pick<PositionLotRow, 'remainingQuantity' | 'realizedPnl' | 'status' | 'closedAt'>>
  ): Promise<PositionLotRow | undefined> {
    const result = await this.db.update(positionLots)
      .set({
        remainingQuantity: patch.remainingQuantity,
        realizedPnl: patch.realizedPnl,
        status: patch.status,
        closedAt: patch.closedAt,
        updatedAt: Date.now(),
      })
      .where(eq(positionLots.id, id))
      .returning();
    return result[0];
  }

  async getOpenQuantity(params: {
    leaderAddress: string;
    platform: string;
    conditionId: string;
    outcome: string;
  }): Promise<number> {
    const result = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${positionLots.remainingQuantity}), 0)`,
      })
      .from(positionLots)
      .where(and(
        eq(positionLots.leaderAddress, params.leaderAddress.toLowerCase()),
        eq(positionLots.platform, params.platform),
        eq(positionLots.conditionId, params.conditionId),
        eq(positionLots.outcome, params.outcome),
        eq(positionLots.status, 'open'),
      ));
    return result[0].total;
  }

  async getRealizedPnlTotal(params: {
    leaderAddress: string;
    platform: string;
    conditionId: string;
    outcome: string;
  }): Promise<number> {
    const result = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${positionLots.realizedPnl}), 0)`,
      })
      .from(positionLots)
      .where(and(
        eq(positionLots.leaderAddress, params.leaderAddress.toLowerCase()),
        eq(positionLots.platform, params.platform),
        eq(positionLots.conditionId, params.conditionId),
        eq(positionLots.outcome, params.outcome),
      ));
    return result[0].total;
  }

  async summarize(filter: PositionLotFilter = {}): Promise<PositionLotSummary> {
    const lots = await this.find(filter, 10_000, 'asc');
    return lots.reduce<PositionLotSummary>((summary, lot) => {
      summary.totalLots += 1;
      summary.realizedPnl += lot.realizedPnl;

      if (lot.status === 'open') {
        summary.openLots += 1;
        summary.totalExposure += lot.remainingQuantity * lot.avgPrice;
      } else {
        summary.closedLots += 1;
      }

      return summary;
    }, {
      openLots: 0,
      closedLots: 0,
      totalLots: 0,
      totalExposure: 0,
      realizedPnl: 0,
    });
  }

  async summarizeByMarket(filter: PositionLotFilter = {}): Promise<PositionLotGroupSummary[]> {
    const lots = await this.find(filter, 10_000, 'asc');
    const grouped = new Map<string, PositionLotGroupSummary>();

    for (const lot of lots) {
      const key = [
        lot.leaderAddress,
        lot.platform,
        lot.conditionId,
        lot.outcome,
      ].join(':');

      const existing = grouped.get(key) ?? {
        leaderAddress: lot.leaderAddress,
        platform: lot.platform,
        conditionId: lot.conditionId,
        outcome: lot.outcome,
        openLots: 0,
        closedLots: 0,
        totalLots: 0,
        totalExposure: 0,
        realizedPnl: 0,
      };

      existing.totalLots += 1;
      existing.realizedPnl += lot.realizedPnl;

      if (lot.status === 'open') {
        existing.openLots += 1;
        existing.totalExposure += lot.remainingQuantity * lot.avgPrice;
      } else {
        existing.closedLots += 1;
      }

      grouped.set(key, existing);
    }

    return Array.from(grouped.values());
  }
}

let positionLotRepo: PositionLotRepository | null = null;

export function getPositionLotRepo(): PositionLotRepository {
  if (!positionLotRepo) {
    positionLotRepo = new PositionLotRepository();
  }
  return positionLotRepo;
}
