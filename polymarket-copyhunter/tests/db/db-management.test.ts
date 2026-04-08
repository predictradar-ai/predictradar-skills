/**
 * CopyHunter - Database Management Tests
 *
 * Tests for database statistics, pruning, and size monitoring
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-db-mgmt-test-'));
process.env.XDG_DATA_HOME = testDataDir;

import { getDbStats, pruneDb, checkDbSize, closeDb } from '../../src/db/index.js';
import { getEventRepo } from '../../src/db/repositories/event-repo.js';

after(() => {
  closeDb();
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

describe('Database Management Tests', () => {
  describe('getDbStats()', () => {
    it('should return database statistics', () => {
      const stats = getDbStats();

      assert.ok(typeof stats.fileSizeBytes === 'number');
      assert.ok(typeof stats.fileSizeMB === 'number');
      assert.ok(Array.isArray(stats.tableStats));
      assert.ok(typeof stats.totalRows === 'number');
      assert.ok(['ok', 'warning', 'critical'].includes(stats.warningLevel));
    });

    it('should include all expected tables', () => {
      const stats = getDbStats();
      const tableNames = stats.tableStats.map(t => t.name);

      assert.ok(tableNames.includes('leaders'));
      assert.ok(tableNames.includes('events'));
      assert.ok(tableNames.includes('positions'));
      assert.ok(tableNames.includes('orders'));
      assert.ok(tableNames.includes('daily_stats'));
    });

    it('should have correct table stats structure', () => {
      const stats = getDbStats();

      for (const table of stats.tableStats) {
        assert.ok(typeof table.name === 'string');
        assert.ok(typeof table.rowCount === 'number');
        assert.ok(table.rowCount >= 0);
        assert.ok(typeof table.estimatedSizeBytes === 'number');
      }
    });
  });

  describe('checkDbSize()', () => {
    it('should return size check result', () => {
      const result = checkDbSize();

      assert.ok(typeof result.shouldWarn === 'boolean');
      assert.ok(result.message === null || typeof result.message === 'string');
    });

    it('should not warn for small databases', () => {
      const result = checkDbSize();

      // Our test database should be small
      if (getDbStats().fileSizeBytes < 100 * 1024 * 1024) {
        assert.strictEqual(result.shouldWarn, false);
      }
    });
  });

  describe('pruneDb()', () => {
    it('should support dry run mode', () => {
      const result = pruneDb({
        olderThanDays: 1,
        dryRun: true,
      });

      assert.ok(typeof result.eventsDeleted === 'number');
      assert.ok(typeof result.ordersDeleted === 'number');
      assert.ok(typeof result.dailyStatsDeleted === 'number');
      assert.strictEqual(result.spaceFreed, '(dry run)');
    });

    it('should accept specific tables', () => {
      const result = pruneDb({
        olderThanDays: 365,
        tables: ['events'],
        dryRun: true,
      });

      assert.ok(typeof result.eventsDeleted === 'number');
    });

    it('should prune old data', async () => {
      const eventRepo = getEventRepo();

      // Create an old event (400 days ago)
      const oldTimestamp = Date.now() - (400 * 24 * 60 * 60 * 1000);
      const oldEvent = await eventRepo.save({
        leaderAddress: '0xtest_prune_' + Date.now(),
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'test-prune-condition',
        outcome: 'YES',
        price: 0.5,
        quantity: 100,
        amountUsd: 50,
        timestamp: oldTimestamp,
        followed: 0,
      });

      // Dry run should find it
      const dryResult = pruneDb({
        olderThanDays: 365,
        tables: ['events'],
        dryRun: true,
      });

      assert.ok(dryResult.eventsDeleted >= 1, 'Should find at least one old event');

      // Actually prune
      const result = pruneDb({
        olderThanDays: 365,
        tables: ['events'],
        dryRun: false,
      });

      assert.ok(result.eventsDeleted >= 1, 'Should delete at least one old event');
      assert.ok(typeof result.spaceFreed === 'string');
      assert.notStrictEqual(result.spaceFreed, '(dry run)');
    });
  });

  describe('Database size thresholds', () => {
    it('should have warning threshold at 100MB', () => {
      // This is implicitly tested through the warning system
      const stats = getDbStats();

      if (stats.fileSizeBytes >= 100 * 1024 * 1024) {
        assert.ok(['warning', 'critical'].includes(stats.warningLevel));
      } else {
        assert.strictEqual(stats.warningLevel, 'ok');
      }
    });

    it('should provide cleanup message when warning', () => {
      const stats = getDbStats();

      if (stats.warningLevel !== 'ok') {
        assert.ok(stats.warningMessage !== null);
        assert.ok(stats.warningMessage.includes('prune'));
      }
    });
  });
});
