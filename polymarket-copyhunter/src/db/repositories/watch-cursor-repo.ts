/**
 * CopyHunter - Watch Cursor Repository
 */

import { eq } from 'drizzle-orm';
import { getDb, watchCursors } from '../index.js';
import type { WatchCursorRow } from '../schema.js';

export interface WatchCursorState {
  leaderAddress: string;
  platform: string;
  cursorTimestamp: number | null;
  cursorTradeKeys: string[];
  updatedAt: number;
}

export class WatchCursorRepository {
  private get db() {
    return getDb();
  }

  async getByLeader(address: string): Promise<WatchCursorState | undefined> {
    const row = await this.db.query.watchCursors.findFirst({
      where: eq(watchCursors.leaderAddress, address.toLowerCase()),
    });

    return row ? this.toState(row) : undefined;
  }

  async upsert(data: {
    leaderAddress: string;
    platform?: string;
    cursorTimestamp: number | null;
    cursorTradeKeys: string[];
  }): Promise<WatchCursorState> {
    const now = Date.now();
    const result = await this.db
      .insert(watchCursors)
      .values({
        leaderAddress: data.leaderAddress.toLowerCase(),
        platform: data.platform ?? 'polymarket',
        cursorTimestamp: data.cursorTimestamp,
        cursorTradeKeys: JSON.stringify(data.cursorTradeKeys),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: watchCursors.leaderAddress,
        set: {
          platform: data.platform ?? 'polymarket',
          cursorTimestamp: data.cursorTimestamp,
          cursorTradeKeys: JSON.stringify(data.cursorTradeKeys),
          updatedAt: now,
        },
      })
      .returning();

    return this.toState(result[0]);
  }

  async clear(address: string): Promise<void> {
    await this.db
      .delete(watchCursors)
      .where(eq(watchCursors.leaderAddress, address.toLowerCase()));
  }

  private toState(row: WatchCursorRow): WatchCursorState {
    let cursorTradeKeys: string[] = [];
    try {
      cursorTradeKeys = JSON.parse(row.cursorTradeKeys);
    } catch {
      cursorTradeKeys = [];
    }

    return {
      leaderAddress: row.leaderAddress,
      platform: row.platform,
      cursorTimestamp: row.cursorTimestamp,
      cursorTradeKeys,
      updatedAt: row.updatedAt,
    };
  }
}

let watchCursorRepo: WatchCursorRepository | null = null;

export function getWatchCursorRepo(): WatchCursorRepository {
  if (!watchCursorRepo) {
    watchCursorRepo = new WatchCursorRepository();
  }
  return watchCursorRepo;
}
