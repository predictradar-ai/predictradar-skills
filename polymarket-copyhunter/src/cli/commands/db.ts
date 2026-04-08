/**
 * CopyHunter - Database Command
 *
 * Provides database statistics, cleanup, and maintenance functions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getDbStats, pruneDb, DbStats } from '../../db/index.js';
import { getDbPath } from '../../core/config.js';
import {
  isJsonOutput,
  markCommandFailed,
  printJson,
  printJsonError,
  printJsonSuccess,
} from '../json-output.js';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} bytes`;
}

function getWarningColor(level: DbStats['warningLevel']): typeof chalk {
  switch (level) {
    case 'critical': return chalk.red;
    case 'warning': return chalk.yellow;
    default: return chalk.green;
  }
}

export function createDbCommand(): Command {
  const cmd = new Command('db')
    .description('Database management and maintenance');

  // db stats
  cmd
    .command('stats')
    .description('Show database statistics and size information')
    .option('--json', 'Output in JSON format', false)
    .action(async (options) => {
      const stats = getDbStats();

      if (isJsonOutput(options)) {
        printJson(stats);
        return;
      }

      console.log(chalk.bold('\n📊 Database Statistics\n'));

      // File info
      console.log(chalk.cyan('File:'));
      console.log(`  Path: ${getDbPath()}`);
      console.log(`  Size: ${formatBytes(stats.fileSizeBytes)}`);

      const warningColor = getWarningColor(stats.warningLevel);
      console.log(`  Status: ${warningColor(stats.warningLevel.toUpperCase())}`);

      if (stats.warningMessage) {
        console.log(`  ${warningColor('⚠ ' + stats.warningMessage)}`);
      }

      // Table stats
      console.log(chalk.cyan('\nTables:'));
      console.log('  ' + '-'.repeat(50));
      console.log(`  ${'Table'.padEnd(15)} ${'Rows'.padStart(10)} ${'Est. Size'.padStart(15)}`);
      console.log('  ' + '-'.repeat(50));

      for (const table of stats.tableStats) {
        console.log(
          `  ${table.name.padEnd(15)} ${table.rowCount.toString().padStart(10)} ${formatBytes(table.estimatedSizeBytes).padStart(15)}`
        );
      }

      console.log('  ' + '-'.repeat(50));
      console.log(
        `  ${'Total'.padEnd(15)} ${stats.totalRows.toString().padStart(10)}`
      );

      // Date range
      if (stats.oldestEventDate || stats.newestEventDate) {
        console.log(chalk.cyan('\nData Range:'));
        console.log(`  Oldest Event: ${stats.oldestEventDate || 'N/A'}`);
        console.log(`  Newest Event: ${stats.newestEventDate || 'N/A'}`);
      }

      // Cleanup suggestion
      if (stats.warningLevel !== 'ok') {
        console.log(chalk.cyan('\nCleanup:'));
        console.log(`  Run ${chalk.yellow('copyhunter db prune --days 30')} to delete data older than 30 days`);
        console.log(`  Use ${chalk.yellow('--dry-run')} to preview changes first`);
      }

      console.log('');
    });

  // db prune
  cmd
    .command('prune')
    .description('Delete old data to free up space')
    .requiredOption('-d, --days <number>', 'Delete data older than N days', parseInt)
    .option('--tables <tables>', 'Tables to prune: events,orders,daily_stats', 'events,orders,daily_stats')
    .option('--dry-run', 'Preview what would be deleted without making changes', false)
    .option('--yes', 'Skip confirmation prompt', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);
      const days = options.days;
      const tables = options.tables.split(',').map((t: string) => t.trim()) as ('events' | 'orders' | 'daily_stats')[];
      const dryRun = options.dryRun;

      // Validate days
      if (isNaN(days) || days < 1) {
        if (jsonOutput) {
          printJsonError('invalid_days', '--days must be a positive number', { days: options.days });
          return;
        }
        markCommandFailed();
        console.log(chalk.red('Error: --days must be a positive number'));
        return;
      }

      // Validate tables
      const validTables = ['events', 'orders', 'daily_stats'];
      for (const table of tables) {
        if (!validTables.includes(table)) {
          if (jsonOutput) {
            printJsonError('invalid_table', `Invalid table '${table}'.`, {
              table,
              validTables,
            });
            return;
          }
          markCommandFailed();
          console.log(chalk.red(`Error: Invalid table '${table}'. Valid tables: ${validTables.join(', ')}`));
          return;
        }
      }

      if (dryRun && !jsonOutput) {
        console.log(chalk.yellow('\n🔍 Dry Run - No changes will be made\n'));
      } else if (!jsonOutput) {
        console.log(chalk.bold('\n🗑️  Database Cleanup\n'));
      }

      if (!jsonOutput) {
        console.log(`  Deleting data older than: ${chalk.cyan(days + ' days')}`);
        console.log(`  Tables: ${chalk.cyan(tables.join(', '))}`);
        console.log('');
      }

      // Show confirmation for non-dry-run
      if (!dryRun && !options.yes) {
        if (jsonOutput) {
          printJsonError('confirmation_required', 'Database prune requires --yes unless --dry-run is used.', {
            days,
            tables,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.yellow('This operation cannot be undone.'));
        console.log(chalk.gray('Add --yes to skip this confirmation, or --dry-run to preview.'));
        console.log('');
        return;
      }

      // Execute prune
      const result = pruneDb({
        olderThanDays: days,
        tables,
        dryRun,
      });

      if (jsonOutput) {
        printJsonSuccess(
          dryRun ? 'db_prune_preview' : 'db_pruned',
          dryRun ? 'Database prune dry run completed.' : 'Database prune completed.',
          {
            days,
            tables,
            dryRun,
            result,
          }
        );
        return;
      }

      console.log(chalk.cyan('Results:'));
      console.log(`  Events deleted:     ${result.eventsDeleted}`);
      console.log(`  Orders deleted:     ${result.ordersDeleted}`);
      console.log(`  Daily stats deleted: ${result.dailyStatsDeleted}`);

      if (!dryRun) {
        console.log(`  Space freed:        ${result.spaceFreed}`);
        console.log(chalk.green('\n✓ Cleanup completed successfully'));
      } else {
        console.log(chalk.yellow('\n⚡ Run without --dry-run to apply changes'));
      }

      console.log('');
    });

  // db path
  cmd
    .command('path')
    .description('Show database file path')
    .action(async () => {
      console.log(getDbPath());
    });

  // db vacuum
  cmd
    .command('vacuum')
    .description('Optimize database and reclaim unused space')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      if (!jsonOutput) {
        console.log(chalk.bold('\n🔧 Optimizing Database...\n'));
      }

      const statsBefore = getDbStats();

      // Import sqlite to run vacuum
      const { getDb } = await import('../../db/index.js');
      getDb(); // Ensure db is initialized

      // Get raw sqlite connection for vacuum
      const { default: Database } = await import('better-sqlite3');
      const dbPath = getDbPath();
      const sqlite = new Database(dbPath);
      sqlite.exec('VACUUM');
      sqlite.close();

      const statsAfter = getDbStats();
      const freedBytes = statsBefore.fileSizeBytes - statsAfter.fileSizeBytes;

      if (jsonOutput) {
        printJsonSuccess('db_vacuumed', 'Database optimized.', {
          beforeBytes: statsBefore.fileSizeBytes,
          afterBytes: statsAfter.fileSizeBytes,
          spaceFreedBytes: freedBytes,
        });
        return;
      }

      console.log(`  Size before: ${formatBytes(statsBefore.fileSizeBytes)}`);
      console.log(`  Size after:  ${formatBytes(statsAfter.fileSizeBytes)}`);
      console.log(`  Space freed: ${formatBytes(freedBytes)}`);
      console.log(chalk.green('\n✓ Database optimized'));
      console.log('');
    });

  // db reset
  cmd
    .command('reset')
    .description('Delete ALL data and reset database (requires multiple confirmations)')
    .option('--confirm', 'First confirmation flag', false)
    .option('--yes-delete-all', 'Second confirmation flag', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);
      const stats = getDbStats();

      if (!jsonOutput) {
        console.log(chalk.bold.red('\n⚠️  DATABASE RESET WARNING ⚠️\n'));
        console.log(chalk.yellow('This will permanently delete ALL data:'));
        console.log(`  • ${stats.tableStats.find(t => t.name === 'leaders')?.rowCount || 0} leaders`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'events')?.rowCount || 0} events`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'positions')?.rowCount || 0} positions`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'position_lots')?.rowCount || 0} position lots`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'orders')?.rowCount || 0} orders`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'daily_stats')?.rowCount || 0} daily stats`);
        console.log(`  • ${stats.tableStats.find(t => t.name === 'watch_cursors')?.rowCount || 0} watch cursors`);
        console.log(`  • Total: ${stats.totalRows} rows\n`);
      }

      // Check first confirmation
      if (!options.confirm) {
        if (jsonOutput) {
          printJsonError('confirmation_required', 'Database reset requires --confirm.', {
            requiredFlags: ['--confirm', '--yes-delete-all'],
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red('Missing first confirmation flag.'));
        console.log(chalk.gray('Run: copyhunter db reset --confirm'));
        console.log('');
        return;
      }

      // Check second confirmation
      if (!options.yesDeleteAll) {
        if (jsonOutput) {
          printJsonError('confirmation_required', 'Database reset requires --yes-delete-all.', {
            requiredFlags: ['--confirm', '--yes-delete-all'],
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red('Missing second confirmation flag.'));
        console.log(chalk.gray('Run: copyhunter db reset --confirm --yes-delete-all'));
        console.log('');
        return;
      }

      if (!jsonOutput) {
        console.log(chalk.yellow('Resetting database...'));
      }

      try {
        const { default: Database } = await import('better-sqlite3');
        const dbPath = getDbPath();
        const sqlite = new Database(dbPath);

        // Delete all data from all tables
        sqlite.exec('DELETE FROM daily_stats');
        sqlite.exec('DELETE FROM orders');
        sqlite.exec('DELETE FROM position_lots');
        sqlite.exec('DELETE FROM positions');
        sqlite.exec('DELETE FROM events');
        sqlite.exec('DELETE FROM watch_cursors');
        sqlite.exec('DELETE FROM leaders');
        sqlite.exec('VACUUM');
        sqlite.close();

        const statsAfter = getDbStats();

        if (jsonOutput) {
          printJsonSuccess('db_reset', 'Database reset complete.', {
            rowsDeleted: stats.totalRows,
            newSizeBytes: statsAfter.fileSizeBytes,
          });
          return;
        }

        console.log(chalk.green('\n✓ Database reset complete'));
        console.log(`  Rows deleted: ${stats.totalRows}`);
        console.log(`  New size: ${formatBytes(statsAfter.fileSizeBytes)}`);
        console.log('');
      } catch (error) {
        if (jsonOutput) {
          printJsonError('db_reset_failed', error instanceof Error ? error.message : String(error));
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`\n✗ Reset failed: ${error instanceof Error ? error.message : error}`));
        console.log('');
      }
    });

  return cmd;
}
