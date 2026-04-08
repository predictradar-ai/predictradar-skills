/**
 * CopyHunter - Event Repository
 */

import { eq, desc, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { getDb, events } from '../index.js';
import type { EventRow, NewEvent } from '../schema.js';
import { getTradeIdentityKey, type TradeIdentityLike } from '../../core/trade-identity.js';

export interface EventFilter {
  leaderAddress?: string;
  platform?: string;
  eventType?: 'BUY' | 'SELL';
  conditionId?: string;
  txHash?: string;
  followed?: boolean;
  fromTimestamp?: number;
  toTimestamp?: number;
  minAmountUsd?: number;
}

export interface EventCursorSnapshot {
  cursorTimestamp: number | null;
  cursorTradeKeys: string[];
}

export class EventRepository {
  private static readonly MAX_BATCH_INSERT_ROWS = 50;

  private get db() {
    return getDb();
  }

  /**
   * Save a new event
   */
  async save(data: NewEvent): Promise<EventRow> {
    const result = await this.db.insert(events).values({
      ...data,
      createdAt: Date.now(),
    }).returning();
    return result[0];
  }

  /**
   * Save multiple events (batch insert)
   */
  async saveBatch(dataList: NewEvent[]): Promise<EventRow[]> {
    if (dataList.length === 0) return [];

    const now = Date.now();
    const savedRows: EventRow[] = [];

    for (let offset = 0; offset < dataList.length; offset += EventRepository.MAX_BATCH_INSERT_ROWS) {
      const batch = dataList.slice(offset, offset + EventRepository.MAX_BATCH_INSERT_ROWS);
      const result = await this.db.insert(events)
        .values(batch.map((data) => ({ ...data, createdAt: now })))
        .returning();
      savedRows.push(...result);
    }

    return savedRows;
  }

  /**
   * Get an event by ID
   */
  async getById(id: number): Promise<EventRow | undefined> {
    return this.db.query.events.findFirst({
      where: eq(events.id, id),
    });
  }

  /**
   * Get events with filters
   */
  async find(filter: EventFilter, limit = 100, offset = 0): Promise<EventRow[]> {
    const conditions = [];

    if (filter.leaderAddress) {
      conditions.push(eq(events.leaderAddress, filter.leaderAddress.toLowerCase()));
    }
    if (filter.platform) {
      conditions.push(eq(events.platform, filter.platform));
    }
    if (filter.eventType) {
      conditions.push(eq(events.eventType, filter.eventType));
    }
    if (filter.conditionId) {
      conditions.push(eq(events.conditionId, filter.conditionId));
    }
    if (filter.txHash) {
      conditions.push(eq(events.txHash, filter.txHash));
    }
    if (filter.followed !== undefined) {
      conditions.push(eq(events.followed, filter.followed ? 1 : 0));
    }
    if (filter.fromTimestamp) {
      conditions.push(gte(events.timestamp, filter.fromTimestamp));
    }
    if (filter.toTimestamp) {
      conditions.push(lte(events.timestamp, filter.toTimestamp));
    }
    if (filter.minAmountUsd) {
      conditions.push(gte(events.amountUsd, filter.minAmountUsd));
    }

    return this.db.query.events.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(events.timestamp)],
      limit,
      offset,
    });
  }

  /**
   * Get recent events for a leader
   */
  async getRecentByLeader(address: string, limit = 20): Promise<EventRow[]> {
    return this.find({ leaderAddress: address }, limit);
  }

  /**
   * Get unfollowed events
   */
  async getUnfollowed(limit = 50): Promise<EventRow[]> {
    return this.find({ followed: false }, limit);
  }

  /**
   * Mark an event as followed
   */
  async markFollowed(id: number, reason?: string): Promise<void> {
    await this.db.update(events)
      .set({
        followed: 1,
        followReason: reason,
      })
      .where(eq(events.id, id));
  }

  async markFollowSkipped(id: number, reason?: string): Promise<void> {
    const storedReason = reason?.startsWith('skipped:') ? reason : (reason ? `skipped: ${reason}` : 'skipped');
    await this.db.update(events)
      .set({
        followed: 0,
        followReason: storedReason,
      })
      .where(eq(events.id, id));
  }

  async markFollowFailed(id: number, reason?: string): Promise<void> {
    const storedReason = reason?.startsWith('error:') ? reason : (reason ? `error: ${reason}` : 'error');
    await this.db.update(events)
      .set({
        followed: 0,
        followReason: storedReason,
      })
      .where(eq(events.id, id));
  }

  /**
   * Check if event already exists by full trade identity.
   * Falls back to txHash-only lookup when callers do not have enough fields.
   */
  async exists(
    txHash?: string,
    leaderAddress?: string,
    conditionId?: string,
    timestamp?: number,
    eventType?: 'BUY' | 'SELL',
    outcome?: string,
    price?: number,
    quantity?: number
  ): Promise<boolean> {
    if (
      leaderAddress
      && conditionId
      && timestamp !== undefined
      && eventType
      && price !== undefined
      && quantity !== undefined
    ) {
      const conditions = [
        eq(events.leaderAddress, leaderAddress.toLowerCase()),
        eq(events.conditionId, conditionId),
        eq(events.timestamp, timestamp),
        eq(events.eventType, eventType),
        eq(events.price, price),
        eq(events.quantity, quantity),
      ];

      if (outcome !== undefined) {
        conditions.push(eq(events.outcome, outcome));
      }
      if (txHash) {
        conditions.push(eq(events.txHash, txHash));
      }

      const existing = await this.db.query.events.findFirst({
        where: and(...conditions),
      });
      return !!existing;
    }

    if (txHash) {
      const existing = await this.db.query.events.findFirst({
        where: eq(events.txHash, txHash),
      });
      return !!existing;
    }

    return false;
  }

  /**
   * Find which trade identity keys already exist locally for the provided trades.
   * Uses leader + timestamp window scans to avoid per-trade existence probes.
   */
  async findExistingTradeKeys(trades: TradeIdentityLike[]): Promise<Set<string>> {
    if (trades.length === 0) {
      return new Set();
    }

    const tradeKeys = new Set(trades.map((trade) => getTradeIdentityKey({
      ...trade,
      leaderAddress: trade.leaderAddress.toLowerCase(),
      txHash: trade.txHash?.toLowerCase(),
    })));
    const existingKeys = new Set<string>();
    const tradesByLeader = new Map<string, TradeIdentityLike[]>();

    for (const trade of trades) {
      const leaderAddress = trade.leaderAddress.toLowerCase();
      const leaderTrades = tradesByLeader.get(leaderAddress) ?? [];
      leaderTrades.push({
        ...trade,
        leaderAddress,
        txHash: trade.txHash?.toLowerCase(),
      });
      tradesByLeader.set(leaderAddress, leaderTrades);
    }

    for (const [leaderAddress, leaderTrades] of tradesByLeader) {
      const timestamps = leaderTrades.map((trade) => trade.timestamp);
      const fromTimestamp = Math.min(...timestamps);
      const toTimestamp = Math.max(...timestamps);

      const rows = await this.db.query.events.findMany({
        where: and(
          eq(events.leaderAddress, leaderAddress),
          gte(events.timestamp, fromTimestamp),
          lte(events.timestamp, toTimestamp),
        ),
      });

      for (const row of rows) {
        const key = getTradeIdentityKey({
          leaderAddress: row.leaderAddress,
          conditionId: row.conditionId,
          eventType: row.eventType as 'BUY' | 'SELL',
          outcome: row.outcome ?? undefined,
          timestamp: row.timestamp,
          price: row.price,
          quantity: row.quantity,
          txHash: row.txHash ?? undefined,
        });

        if (tradeKeys.has(key)) {
          existingKeys.add(key);
        }
      }
    }

    return existingKeys;
  }

  /**
   * Get latest event timestamp for a leader
   */
  async getLatestTimestamp(address: string): Promise<number | null> {
    const result = await this.db.query.events.findFirst({
      where: eq(events.leaderAddress, address.toLowerCase()),
      orderBy: [desc(events.timestamp)],
    });
    return result?.timestamp ?? null;
  }

  /**
   * Build cursor state from the latest locally persisted event frontier.
   */
  async getLatestCursorSnapshot(address: string): Promise<EventCursorSnapshot> {
    const latestTimestamp = await this.getLatestTimestamp(address);
    if (latestTimestamp === null) {
      return {
        cursorTimestamp: null,
        cursorTradeKeys: [],
      };
    }

    const latestEvents = await this.db.query.events.findMany({
      where: and(
        eq(events.leaderAddress, address.toLowerCase()),
        eq(events.timestamp, latestTimestamp)
      ),
      orderBy: [desc(events.id)],
    });

    return {
      cursorTimestamp: latestTimestamp,
      cursorTradeKeys: latestEvents.map((event) => getTradeIdentityKey({
        leaderAddress: event.leaderAddress,
        conditionId: event.conditionId,
        eventType: event.eventType as 'BUY' | 'SELL',
        outcome: event.outcome ?? undefined,
        timestamp: event.timestamp,
        price: event.price,
        quantity: event.quantity,
        txHash: event.txHash ?? undefined,
      })),
    };
  }

  /**
   * Count events with filters
   */
  async count(filter?: EventFilter): Promise<number> {
    const conditions = [];

    if (filter?.leaderAddress) {
      conditions.push(eq(events.leaderAddress, filter.leaderAddress.toLowerCase()));
    }
    if (filter?.followed !== undefined) {
      conditions.push(eq(events.followed, filter.followed ? 1 : 0));
    }

    const result = await this.db.select({ count: sql<number>`count(*)` })
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return result[0].count;
  }

  /**
   * Get events by IDs
   */
  async getByIds(ids: number[]): Promise<EventRow[]> {
    if (ids.length === 0) return [];
    return this.db.query.events.findMany({
      where: inArray(events.id, ids),
    });
  }
}

// Singleton
let eventRepo: EventRepository | null = null;

export function getEventRepo(): EventRepository {
  if (!eventRepo) {
    eventRepo = new EventRepository();
  }
  return eventRepo;
}
