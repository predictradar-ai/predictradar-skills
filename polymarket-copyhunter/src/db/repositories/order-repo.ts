/**
 * CopyHunter - Order Repository
 */

import { eq, desc, and, sql, gte } from 'drizzle-orm';
import { getDb, orders } from '../index.js';
import type { OrderRow, NewOrder } from '../schema.js';
import type { OrderReconcileStatus } from '../../core/types.js';

export type OrderStatus = 'pending' | 'executed' | 'failed' | 'cancelled';
export type OrderReconciliationCounts = Record<OrderReconcileStatus, number>;

export interface OrderFilter {
  eventId?: number;
  leaderAddress?: string;
  status?: OrderStatus;
  mode?: 'shadow' | 'live';
  fromTimestamp?: number;
  reconcileStatus?: OrderReconcileStatus;
}

export class OrderRepository {
  private get db() {
    return getDb();
  }

  /**
   * Create a new order
   */
  async create(data: NewOrder): Promise<OrderRow> {
    const result = await this.db.insert(orders).values({
      ...data,
      createdAt: Date.now(),
    }).returning();
    return result[0];
  }

  /**
   * Get an order by ID
   */
  async getById(id: number): Promise<OrderRow | undefined> {
    return this.db.query.orders.findFirst({
      where: eq(orders.id, id),
    });
  }

  /**
   * Get orders with filters
   */
  async find(filter: OrderFilter, limit = 100): Promise<OrderRow[]> {
    const conditions = [];

    if (filter.eventId) {
      conditions.push(eq(orders.eventId, filter.eventId));
    }
    if (filter.leaderAddress) {
      conditions.push(eq(orders.leaderAddress, filter.leaderAddress.toLowerCase()));
    }
    if (filter.status) {
      conditions.push(eq(orders.status, filter.status));
    }
    if (filter.mode) {
      conditions.push(eq(orders.mode, filter.mode));
    }
    if (filter.reconcileStatus) {
      conditions.push(eq(orders.reconcileStatus, filter.reconcileStatus));
    }
    if (filter.fromTimestamp) {
      conditions.push(gte(orders.createdAt, filter.fromTimestamp));
    }

    return this.db.query.orders.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(orders.createdAt)],
      limit,
    });
  }

  /**
   * Update order status
   */
  async updateStatus(
    id: number,
    status: OrderStatus,
    extra?: {
      txHash?: string;
      executedPrice?: number;
      executedSize?: number;
      executedAmountUsd?: number;
      reconcileStatus?: OrderReconcileStatus;
      reconcileReason?: string | null;
      lastReconciledAt?: number | null;
      errorMessage?: string;
    }
  ): Promise<void> {
    await this.db.update(orders)
      .set({
        status,
        txHash: extra?.txHash,
        executedPrice: extra?.executedPrice,
        executedSize: extra?.executedSize,
        executedAmountUsd: extra?.executedAmountUsd,
        executedAt: status === 'executed' ? Date.now() : undefined,
        reconcileStatus: extra?.reconcileStatus,
        reconcileReason: extra?.reconcileReason,
        lastReconciledAt: extra?.lastReconciledAt,
        errorMessage: extra?.errorMessage,
      })
      .where(eq(orders.id, id));
  }

  /**
   * Mark order as executed
   */
  async markExecuted(
    id: number,
    txHash: string,
    executedPrice: number,
    extra?: {
      executedSize?: number;
      executedAmountUsd?: number;
      reconcileStatus?: OrderReconcileStatus;
      reconcileReason?: string | null;
      lastReconciledAt?: number | null;
    }
  ): Promise<void> {
    await this.updateStatus(id, 'executed', {
      txHash,
      executedPrice,
      executedSize: extra?.executedSize,
      executedAmountUsd: extra?.executedAmountUsd,
      reconcileStatus: extra?.reconcileStatus,
      reconcileReason: extra?.reconcileReason,
      lastReconciledAt: extra?.lastReconciledAt,
    });
  }

  /**
   * Mark order as failed
   */
  async markFailed(id: number, errorMessage: string): Promise<void> {
    await this.updateStatus(id, 'failed', {
      errorMessage,
      reconcileStatus: 'not_applicable',
      reconcileReason: 'Order failed before fill reconciliation.',
      lastReconciledAt: Date.now(),
    });
  }

  /**
   * Get pending orders
   */
  async getPending(): Promise<OrderRow[]> {
    return this.find({ status: 'pending' });
  }

  /**
   * Get today's orders
   */
  async getTodayOrders(mode?: 'shadow' | 'live'): Promise<OrderRow[]> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return this.find({
      mode,
      fromTimestamp: todayStart.getTime(),
    });
  }

  /**
   * Get daily USD spent on executed orders.
   * By default this tracks buy-side capital deployed, which is the metric
   * enforced by follow.dailyLimit and surfaced in follow status.
   */
  async getDailySpent(
    mode?: 'shadow' | 'live',
    side: 'buy' | 'sell' | 'all' = 'buy'
  ): Promise<number> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const conditions = [
      eq(orders.status, 'executed'),
      gte(orders.createdAt, todayStart.getTime()),
    ];

    if (mode) {
      conditions.push(eq(orders.mode, mode));
    }
    if (side !== 'all') {
      conditions.push(eq(orders.side, side));
    }

    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(amount_usd), 0)` })
      .from(orders)
      .where(and(...conditions));

    return result[0].total;
  }

  /**
   * Count orders by status
   */
  async countByStatus(): Promise<Record<OrderStatus, number>> {
    const result = await this.db
      .select({
        status: orders.status,
        count: sql<number>`count(*)`,
      })
      .from(orders)
      .groupBy(orders.status);

    const counts: Record<OrderStatus, number> = {
      pending: 0,
      executed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of result) {
      counts[row.status as OrderStatus] = row.count;
    }

    return counts;
  }

  async countByReconcileStatus(): Promise<OrderReconciliationCounts> {
    const result = await this.db
      .select({
        reconcileStatus: orders.reconcileStatus,
        count: sql<number>`count(*)`,
      })
      .from(orders)
      .groupBy(orders.reconcileStatus);

    const counts: OrderReconciliationCounts = {
      pending: 0,
      not_applicable: 0,
      simulated: 0,
      estimated: 0,
      matched: 0,
      drifted: 0,
    };

    for (const row of result) {
      counts[row.reconcileStatus as OrderReconcileStatus] = row.count;
    }

    return counts;
  }

  async reconcileExecution(
    id: number,
    patch: {
      txHash?: string;
      executedPrice?: number;
      executedSize?: number;
      executedAmountUsd?: number;
      reconcileStatus: OrderReconcileStatus;
      reconcileReason?: string | null;
      lastReconciledAt: number;
    }
  ): Promise<void> {
    await this.db.update(orders)
      .set({
        txHash: patch.txHash,
        executedPrice: patch.executedPrice,
        executedSize: patch.executedSize,
        executedAmountUsd: patch.executedAmountUsd,
        reconcileStatus: patch.reconcileStatus,
        reconcileReason: patch.reconcileReason,
        lastReconciledAt: patch.lastReconciledAt,
      })
      .where(eq(orders.id, id));
  }
}

// Singleton
let orderRepo: OrderRepository | null = null;

export function getOrderRepo(): OrderRepository {
  if (!orderRepo) {
    orderRepo = new OrderRepository();
  }
  return orderRepo;
}
