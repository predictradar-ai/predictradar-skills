/**
 * CopyHunter - Drizzle ORM Schema
 */

import { sqliteTable, text, integer, real, unique, index } from 'drizzle-orm/sqlite-core';

// ============ Leaders Table ============

export const leaders = sqliteTable('leaders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  address: text('address').notNull().unique(),
  alias: text('alias'),
  tags: text('tags'), // JSON string array
  platform: text('platform').notNull().default('polymarket'),
  addedAt: integer('added_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // Stats cache
  totalTrades: integer('total_trades').notNull().default(0),
  winRate: real('win_rate').notNull().default(0),
  totalPnl: real('total_pnl').notNull().default(0),
  lastTradeAt: integer('last_trade_at'),
});

// ============ Events Table ============

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leaderAddress: text('leader_address').notNull(),
  platform: text('platform').notNull(),
  eventType: text('event_type').notNull(), // 'BUY' | 'SELL'
  conditionId: text('condition_id').notNull(),
  marketSlug: text('market_slug'),
  marketTitle: text('market_title'),
  outcome: text('outcome'), // 'YES' | 'NO'
  price: real('price').notNull(),
  quantity: real('quantity').notNull(),
  amountUsd: real('amount_usd').notNull(),
  txHash: text('tx_hash'),
  blockNumber: integer('block_number'),
  timestamp: integer('timestamp').notNull(),
  // Follow status
  followed: integer('followed').notNull().default(0), // 0=not followed, 1=followed
  followReason: text('follow_reason'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  leaderIdx: index('idx_events_leader').on(table.leaderAddress),
  timestampIdx: index('idx_events_timestamp').on(table.timestamp),
  leaderTimestampIdx: index('idx_events_leader_timestamp').on(table.leaderAddress, table.timestamp),
  conditionIdx: index('idx_events_condition').on(table.conditionId),
}));

// ============ Positions Table ============

export const positions = sqliteTable('positions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leaderAddress: text('leader_address').notNull(),
  platform: text('platform').notNull(),
  conditionId: text('condition_id').notNull(),
  marketSlug: text('market_slug'),
  marketTitle: text('market_title'),
  outcome: text('outcome').notNull(), // 'YES' | 'NO'
  // Position data
  quantity: real('quantity').notNull(),
  avgPrice: real('avg_price').notNull(),
  costBasis: real('cost_basis').notNull(),
  // Status
  status: text('status').notNull().default('open'), // 'open' | 'closed'
  realizedPnl: real('realized_pnl').notNull().default(0),
  closedAt: integer('closed_at'),
  // Metadata
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  uniquePosition: unique('uniq_position').on(table.leaderAddress, table.conditionId, table.outcome),
  statusIdx: index('idx_positions_status').on(table.status),
  leaderIdx: index('idx_positions_leader').on(table.leaderAddress),
}));

// ============ Position Lots Table ============

export const positionLots = sqliteTable('position_lots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leaderAddress: text('leader_address').notNull(),
  platform: text('platform').notNull(),
  conditionId: text('condition_id').notNull(),
  marketSlug: text('market_slug'),
  marketTitle: text('market_title'),
  outcome: text('outcome').notNull(),
  entryQuantity: real('entry_quantity').notNull(),
  remainingQuantity: real('remaining_quantity').notNull(),
  avgPrice: real('avg_price').notNull(),
  costBasis: real('cost_basis').notNull(),
  realizedPnl: real('realized_pnl').notNull().default(0),
  status: text('status').notNull().default('open'), // 'open' | 'closed'
  openedOrderId: integer('opened_order_id'),
  closedAt: integer('closed_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  statusIdx: index('idx_position_lots_status').on(table.status),
  marketIdx: index('idx_position_lots_market').on(
    table.leaderAddress,
    table.conditionId,
    table.outcome,
    table.status,
    table.createdAt
  ),
}));

// ============ Orders Table ============

export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: integer('event_id').notNull(),
  leaderAddress: text('leader_address').notNull(),
  platform: text('platform').notNull(),
  // Order info
  orderType: text('order_type').notNull(), // 'market' | 'limit'
  side: text('side').notNull(), // 'buy' | 'sell'
  tokenId: text('token_id').notNull(),
  price: real('price'),
  size: real('size').notNull(),
  amountUsd: real('amount_usd').notNull(),
  // Execution status
  status: text('status').notNull().default('pending'), // 'pending' | 'executed' | 'failed' | 'cancelled'
  txHash: text('tx_hash'),
  executedPrice: real('executed_price'),
  executedSize: real('executed_size'),
  executedAmountUsd: real('executed_amount_usd'),
  executedAt: integer('executed_at'),
  reconcileStatus: text('reconcile_status').notNull().default('pending'),
  reconcileReason: text('reconcile_reason'),
  lastReconciledAt: integer('last_reconciled_at'),
  errorMessage: text('error_message'),
  // Metadata
  mode: text('mode').notNull(), // 'shadow' | 'live'
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  statusIdx: index('idx_orders_status').on(table.status),
  eventIdx: index('idx_orders_event').on(table.eventId),
}));

// ============ Daily Stats Table ============

export const dailyStats = sqliteTable('daily_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(), // 'YYYY-MM-DD'
  platform: text('platform').notNull(),
  // Watch stats
  eventsCaptured: integer('events_captured').notNull().default(0),
  eventsFollowed: integer('events_followed').notNull().default(0),
  eventsSkipped: integer('events_skipped').notNull().default(0),
  // PnL stats
  realizedPnl: real('realized_pnl').notNull().default(0),
  unrealizedPnl: real('unrealized_pnl').notNull().default(0),
  // Risk stats
  totalExposure: real('total_exposure').notNull().default(0),
  maxExposure: real('max_exposure').notNull().default(0),
  positionsOpened: integer('positions_opened').notNull().default(0),
  positionsClosed: integer('positions_closed').notNull().default(0),
}, (table) => ({
  uniqueDate: unique('uniq_daily_stats').on(table.date, table.platform),
  dateIdx: index('idx_daily_stats_date').on(table.date),
}));

// ============ Watch Cursors Table ============

export const watchCursors = sqliteTable('watch_cursors', {
  leaderAddress: text('leader_address').primaryKey(),
  platform: text('platform').notNull(),
  cursorTimestamp: integer('cursor_timestamp'),
  cursorTradeKeys: text('cursor_trade_keys').notNull().default('[]'),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  platformIdx: index('idx_watch_cursors_platform').on(table.platform),
  updatedAtIdx: index('idx_watch_cursors_updated_at').on(table.updatedAt),
}));

// ============ Type Exports ============

export type LeaderRow = typeof leaders.$inferSelect;
export type NewLeader = typeof leaders.$inferInsert;

export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type PositionRow = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;

export type PositionLotRow = typeof positionLots.$inferSelect;
export type NewPositionLot = typeof positionLots.$inferInsert;

export type OrderRow = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type DailyStatsRow = typeof dailyStats.$inferSelect;
export type NewDailyStats = typeof dailyStats.$inferInsert;

export type WatchCursorRow = typeof watchCursors.$inferSelect;
export type NewWatchCursor = typeof watchCursors.$inferInsert;
