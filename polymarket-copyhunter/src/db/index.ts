/**
 * CopyHunter - Database Initialization
 */

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import { getDbPath } from '../core/config.js';
import * as schema from './schema.js';

let db: BetterSQLite3Database<typeof schema> | null = null;
let sqlite: Database.Database | null = null;

// Size thresholds in bytes
const SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB
const SIZE_CRITICAL_THRESHOLD = 500 * 1024 * 1024; // 500MB

export interface DbStats {
  fileSizeBytes: number;
  fileSizeMB: number;
  tableStats: {
    name: string;
    rowCount: number;
    estimatedSizeBytes: number;
  }[];
  totalRows: number;
  oldestEventDate: string | null;
  newestEventDate: string | null;
  warningLevel: 'ok' | 'warning' | 'critical';
  warningMessage: string | null;
}

/**
 * Get the database instance (singleton)
 */
export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) {
    const dbPath = getDbPath();
    sqlite = new Database(dbPath);

    // Enable WAL mode for better write performance
    sqlite.pragma('journal_mode = WAL');
    // Enable foreign keys
    sqlite.pragma('foreign_keys = ON');

    db = drizzle(sqlite, { schema });

    // Run migrations on first connection
    runMigrations(sqlite);
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

/**
 * Run database migrations
 */
function runMigrations(sqlite: Database.Database): void {
  // Create tables if they don't exist
  sqlite.exec(`
    -- Leaders table
    CREATE TABLE IF NOT EXISTS leaders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      alias TEXT,
      tags TEXT,
      platform TEXT NOT NULL DEFAULT 'polymarket',
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      total_trades INTEGER NOT NULL DEFAULT 0,
      win_rate REAL NOT NULL DEFAULT 0,
      total_pnl REAL NOT NULL DEFAULT 0,
      last_trade_at INTEGER
    );

    -- Events table
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_address TEXT NOT NULL,
      platform TEXT NOT NULL,
      event_type TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_slug TEXT,
      market_title TEXT,
      outcome TEXT,
      price REAL NOT NULL,
      quantity REAL NOT NULL,
      amount_usd REAL NOT NULL,
      tx_hash TEXT,
      block_number INTEGER,
      timestamp INTEGER NOT NULL,
      followed INTEGER NOT NULL DEFAULT 0,
      follow_reason TEXT,
      created_at INTEGER NOT NULL
    );

    -- Positions table
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_address TEXT NOT NULL,
      platform TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_slug TEXT,
      market_title TEXT,
      outcome TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_price REAL NOT NULL,
      cost_basis REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      realized_pnl REAL NOT NULL DEFAULT 0,
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(leader_address, condition_id, outcome)
    );

    -- Position lots table
    CREATE TABLE IF NOT EXISTS position_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_address TEXT NOT NULL,
      platform TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_slug TEXT,
      market_title TEXT,
      outcome TEXT NOT NULL,
      entry_quantity REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      avg_price REAL NOT NULL,
      cost_basis REAL NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      opened_order_id INTEGER,
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Orders table
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      leader_address TEXT NOT NULL,
      platform TEXT NOT NULL,
      order_type TEXT NOT NULL,
      side TEXT NOT NULL,
      token_id TEXT NOT NULL,
      price REAL,
      size REAL NOT NULL,
      amount_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      executed_price REAL,
      executed_size REAL,
      executed_amount_usd REAL,
      executed_at INTEGER,
      reconcile_status TEXT NOT NULL DEFAULT 'pending',
      reconcile_reason TEXT,
      last_reconciled_at INTEGER,
      error_message TEXT,
      mode TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Daily stats table
    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      platform TEXT NOT NULL,
      events_captured INTEGER NOT NULL DEFAULT 0,
      events_followed INTEGER NOT NULL DEFAULT 0,
      events_skipped INTEGER NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      unrealized_pnl REAL NOT NULL DEFAULT 0,
      total_exposure REAL NOT NULL DEFAULT 0,
      max_exposure REAL NOT NULL DEFAULT 0,
      positions_opened INTEGER NOT NULL DEFAULT 0,
      positions_closed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, platform)
    );

    -- Watch cursors table
    CREATE TABLE IF NOT EXISTS watch_cursors (
      leader_address TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      cursor_timestamp INTEGER,
      cursor_trade_keys TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_events_leader ON events(leader_address);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_leader_timestamp ON events(leader_address, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_condition ON events(condition_id);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_leader ON positions(leader_address);
    CREATE INDEX IF NOT EXISTS idx_position_lots_status ON position_lots(status);
    CREATE INDEX IF NOT EXISTS idx_position_lots_market ON position_lots(
      leader_address,
      condition_id,
      outcome,
      status,
      created_at
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id);
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date DESC);
    CREATE INDEX IF NOT EXISTS idx_watch_cursors_platform ON watch_cursors(platform);
    CREATE INDEX IF NOT EXISTS idx_watch_cursors_updated_at ON watch_cursors(updated_at DESC);
  `);

  ensureColumnExists(sqlite, 'orders', 'executed_size', 'REAL');
  ensureColumnExists(sqlite, 'orders', 'executed_amount_usd', 'REAL');
  ensureColumnExists(sqlite, 'orders', 'reconcile_status', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumnExists(sqlite, 'orders', 'reconcile_reason', 'TEXT');
  ensureColumnExists(sqlite, 'orders', 'last_reconciled_at', 'INTEGER');
}

function ensureColumnExists(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

// Re-export schema
export * from './schema.js';

// Re-export repositories
export * from './repositories/index.js';

/**
 * Get database statistics and size information
 */
export function getDbStats(): DbStats {
  const dbPath = getDbPath();

  // Get file size
  let fileSizeBytes = 0;
  try {
    const stat = fs.statSync(dbPath);
    fileSizeBytes = stat.size;
  } catch {
    // File doesn't exist yet
  }

  // Ensure db is initialized
  getDb();

  if (!sqlite) {
    return {
      fileSizeBytes: 0,
      fileSizeMB: 0,
      tableStats: [],
      totalRows: 0,
      oldestEventDate: null,
      newestEventDate: null,
      warningLevel: 'ok',
      warningMessage: null,
    };
  }

  // Get row counts for each table
  const tables = ['leaders', 'events', 'positions', 'position_lots', 'orders', 'daily_stats', 'watch_cursors'];
  const tableStats: DbStats['tableStats'] = [];
  let totalRows = 0;

  for (const table of tables) {
    try {
      const result = sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
      const rowCount = result.count;
      totalRows += rowCount;

      // Estimate size: roughly 100-500 bytes per row depending on table
      const avgRowSize = table === 'events'
        ? 300
        : table === 'orders'
          ? 250
          : table === 'position_lots'
            ? 200
            : 150;
      tableStats.push({
        name: table,
        rowCount,
        estimatedSizeBytes: rowCount * avgRowSize,
      });
    } catch {
      tableStats.push({ name: table, rowCount: 0, estimatedSizeBytes: 0 });
    }
  }

  // Get oldest and newest event dates
  let oldestEventDate: string | null = null;
  let newestEventDate: string | null = null;

  try {
    const oldest = sqlite.prepare('SELECT MIN(timestamp) as ts FROM events').get() as { ts: number | null };
    const newest = sqlite.prepare('SELECT MAX(timestamp) as ts FROM events').get() as { ts: number | null };

    if (oldest.ts) {
      oldestEventDate = new Date(oldest.ts).toISOString().split('T')[0];
    }
    if (newest.ts) {
      newestEventDate = new Date(newest.ts).toISOString().split('T')[0];
    }
  } catch {
    // Ignore errors
  }

  // Determine warning level
  let warningLevel: DbStats['warningLevel'] = 'ok';
  let warningMessage: string | null = null;

  if (fileSizeBytes >= SIZE_CRITICAL_THRESHOLD) {
    warningLevel = 'critical';
    warningMessage = `Database size (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds 500MB. Run 'copyhunter db prune' to clean old data.`;
  } else if (fileSizeBytes >= SIZE_WARNING_THRESHOLD) {
    warningLevel = 'warning';
    warningMessage = `Database size (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds 100MB. Consider running 'copyhunter db prune' to clean old data.`;
  }

  return {
    fileSizeBytes,
    fileSizeMB: fileSizeBytes / 1024 / 1024,
    tableStats,
    totalRows,
    oldestEventDate,
    newestEventDate,
    warningLevel,
    warningMessage,
  };
}

/**
 * Prune old data from the database
 */
export function pruneDb(options: {
  olderThanDays: number;
  tables?: ('events' | 'orders' | 'daily_stats')[];
  dryRun?: boolean;
}): {
  eventsDeleted: number;
  ordersDeleted: number;
  dailyStatsDeleted: number;
  spaceFreed: string;
} {
  const { olderThanDays, tables = ['events', 'orders', 'daily_stats'], dryRun = false } = options;

  // Ensure db is initialized
  getDb();

  if (!sqlite) {
    return { eventsDeleted: 0, ordersDeleted: 0, dailyStatsDeleted: 0, spaceFreed: '0 KB' };
  }

  const cutoffTimestamp = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const cutoffDate = new Date(cutoffTimestamp).toISOString().split('T')[0];

  let eventsDeleted = 0;
  let ordersDeleted = 0;
  let dailyStatsDeleted = 0;

  // Get initial size
  const dbPath = getDbPath();
  let initialSize = 0;
  try {
    initialSize = fs.statSync(dbPath).size;
  } catch {
    // Ignore
  }

  if (dryRun) {
    // Just count what would be deleted
    if (tables.includes('events')) {
      const result = sqlite.prepare('SELECT COUNT(*) as count FROM events WHERE timestamp < ?').get(cutoffTimestamp) as { count: number };
      eventsDeleted = result.count;
    }
    if (tables.includes('orders')) {
      const result = sqlite.prepare('SELECT COUNT(*) as count FROM orders WHERE created_at < ?').get(cutoffTimestamp) as { count: number };
      ordersDeleted = result.count;
    }
    if (tables.includes('daily_stats')) {
      const result = sqlite.prepare('SELECT COUNT(*) as count FROM daily_stats WHERE date < ?').get(cutoffDate) as { count: number };
      dailyStatsDeleted = result.count;
    }

    return {
      eventsDeleted,
      ordersDeleted,
      dailyStatsDeleted,
      spaceFreed: '(dry run)',
    };
  }

  // Actually delete
  if (tables.includes('events')) {
    const result = sqlite.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoffTimestamp);
    eventsDeleted = result.changes;
  }

  if (tables.includes('orders')) {
    const result = sqlite.prepare('DELETE FROM orders WHERE created_at < ?').run(cutoffTimestamp);
    ordersDeleted = result.changes;
  }

  if (tables.includes('daily_stats')) {
    const result = sqlite.prepare('DELETE FROM daily_stats WHERE date < ?').run(cutoffDate);
    dailyStatsDeleted = result.changes;
  }

  // Vacuum to reclaim space
  sqlite.exec('VACUUM');

  // Calculate space freed
  let finalSize = 0;
  try {
    finalSize = fs.statSync(dbPath).size;
  } catch {
    // Ignore
  }

  const freedBytes = initialSize - finalSize;
  let spaceFreed: string;
  if (freedBytes > 1024 * 1024) {
    spaceFreed = `${(freedBytes / 1024 / 1024).toFixed(2)} MB`;
  } else if (freedBytes > 1024) {
    spaceFreed = `${(freedBytes / 1024).toFixed(2)} KB`;
  } else {
    spaceFreed = `${freedBytes} bytes`;
  }

  return {
    eventsDeleted,
    ordersDeleted,
    dailyStatsDeleted,
    spaceFreed,
  };
}

/**
 * Check database size and return warning if needed
 * Call this at startup
 */
export function checkDbSize(): { shouldWarn: boolean; message: string | null } {
  const dbPath = getDbPath();
  let fileSizeBytes = 0;

  try {
    fileSizeBytes = fs.statSync(dbPath).size;
  } catch {
    return {
      shouldWarn: false,
      message: null,
    };
  }

  let warningMessage: string | null = null;

  if (fileSizeBytes >= SIZE_CRITICAL_THRESHOLD) {
    warningMessage = `Database size (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds 500MB. Run 'copyhunter db prune' to clean old data.`;
  } else if (fileSizeBytes >= SIZE_WARNING_THRESHOLD) {
    warningMessage = `Database size (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds 100MB. Consider running 'copyhunter db prune' to clean old data.`;
  }

  return {
    shouldWarn: warningMessage !== null,
    message: warningMessage,
  };
}
