/**
 * CopyHunter - Leaders Command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getDb, leaders } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { getLeaderStatsUpdater } from '../../analysis/leader-stats-updater.js';
import type { Platform } from '../../core/types.js';
import {
  createJsonArrayResponse,
  isJsonOutput,
  markCommandFailed,
  printJson,
  printJsonError,
  printJsonSuccess,
} from '../json-output.js';

/**
 * Resolve a leader identifier to an address
 * Supports: full address, #number (1-based index), or alias
 */
async function resolveLeaderIdentifier(identifier: string): Promise<{ address: string; leader: any } | null> {
  const db = getDb();

  // Check if it's a number reference (#1, #2, etc. or just 1, 2)
  const numMatch = identifier.match(/^#?(\d+)$/);
  if (numMatch) {
    const index = parseInt(numMatch[1], 10) - 1; // Convert to 0-based
    const allLeaders = await db.query.leaders.findMany({
      orderBy: (leaders, { desc }) => [desc(leaders.totalPnl)],
    });
    if (index >= 0 && index < allLeaders.length) {
      return { address: allLeaders[index].address, leader: allLeaders[index] };
    }
    return null;
  }

  // Check if it's a full address (starts with 0x)
  if (identifier.toLowerCase().startsWith('0x')) {
    const leader = await db.query.leaders.findFirst({
      where: eq(leaders.address, identifier.toLowerCase()),
    });
    if (leader) {
      return { address: leader.address, leader };
    }
    return null;
  }

  // Try to find by alias (case-insensitive)
  const allLeaders = await db.query.leaders.findMany();
  const byAlias = allLeaders.find(
    (l) => l.alias && l.alias.toLowerCase() === identifier.toLowerCase()
  );
  if (byAlias) {
    return { address: byAlias.address, leader: byAlias };
  }

  return null;
}

export function createLeadersCommand(): Command {
  const cmd = new Command('leaders')
    .description('Manage leader addresses to follow');

  // leaders add
  cmd
    .command('add <address>')
    .description('Add a leader address to monitor')
    .option('-a, --alias <alias>', 'Friendly alias for the leader')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-p, --platform <platform>', 'Platform (polymarket)', 'polymarket')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (address: string, options) => {
      const jsonOutput = isJsonOutput(options);
      const spinner = jsonOutput ? null : ora('Adding leader...').start();

      try {
        const db = getDb();
        const now = Date.now();

        // Check if already exists
        const existing = await db.query.leaders.findFirst({
          where: eq(leaders.address, address.toLowerCase()),
        });

        if (existing) {
          if (jsonOutput) {
            printJsonError('leader_exists', `Leader ${address} already exists`, {
              address: address.toLowerCase(),
            });
            return;
          }
          markCommandFailed();
          spinner?.fail(`Leader ${address} already exists`);
          return;
        }

        // Insert new leader
        const normalizedAddress = address.toLowerCase();
        const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : null;
        await db.insert(leaders).values({
          address: normalizedAddress,
          alias: options.alias,
          tags: tags ? JSON.stringify(tags) : null,
          platform: options.platform as Platform,
          addedAt: now,
          updatedAt: now,
        });

        if (jsonOutput) {
          printJsonSuccess('leader_added', `Added leader: ${options.alias || address}`, {
            leader: {
              address: normalizedAddress,
              alias: options.alias ?? null,
              tags,
              platform: options.platform,
            },
          });
          return;
        }

        spinner?.succeed(`Added leader: ${options.alias || address}`);
      } catch (error) {
        if (jsonOutput) {
          printJsonError('leader_add_failed', error instanceof Error ? error.message : String(error), {
            address: address.toLowerCase(),
          });
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to add leader: ${error}`);
      }
    });

  // leaders remove
  cmd
    .command('remove <identifier>')
    .description('Remove a leader (by address, #number, or alias)')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (identifier: string, options) => {
      const jsonOutput = isJsonOutput(options);
      const spinner = jsonOutput ? null : ora('Removing leader...').start();

      try {
        const resolved = await resolveLeaderIdentifier(identifier);

        if (!resolved) {
          if (jsonOutput) {
            printJsonError('leader_not_found', `Leader not found: ${identifier}`, {
              identifier,
            });
            return;
          }
          markCommandFailed();
          spinner?.fail(`Leader not found: ${identifier}`);
          console.log(chalk.gray('\nUse address, #number (e.g. #1), or alias'));
          return;
        }

        const db = getDb();
        const result = await db.delete(leaders).where(eq(leaders.address, resolved.address));

        if (result.changes > 0) {
          const displayName = resolved.leader.alias || resolved.address;
          if (jsonOutput) {
            printJsonSuccess('leader_removed', `Removed leader: ${displayName}`, {
              identifier,
              leader: {
                address: resolved.address,
                alias: resolved.leader.alias ?? null,
              },
            });
            return;
          }
          spinner?.succeed(`Removed leader: ${displayName}`);
        } else {
          if (jsonOutput) {
            printJsonError('leader_remove_failed', 'Failed to remove leader', {
              identifier,
              address: resolved.address,
            });
            return;
          }
          markCommandFailed();
          spinner?.fail(`Failed to remove leader`);
        }
      } catch (error) {
        if (jsonOutput) {
          printJsonError('leader_remove_failed', error instanceof Error ? error.message : String(error), {
            identifier,
          });
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to remove leader: ${error}`);
      }
    });

  // leaders list
  cmd
    .command('list')
    .description('List all monitored leaders')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const db = getDb();
      const allLeaders = await db.query.leaders.findMany({
        orderBy: (leaders, { desc }) => [desc(leaders.totalPnl)],
      });

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('leaders', allLeaders));
        return;
      }

      if (allLeaders.length === 0) {
        console.log(chalk.yellow('No leaders found. Add one with: copyhunter leaders add <address>'));
        return;
      }

      const table = new Table({
        head: ['#', 'Alias', 'Address', 'Tags', 'Trades', 'Win%', 'PnL', 'Last'],
        colWidths: [4, 12, 14, 16, 7, 7, 10, 8],
      });

      allLeaders.forEach((leader, idx) => {
        const pnlColor = leader.totalPnl >= 0 ? chalk.green : chalk.red;
        const pnlStr = pnlColor(`$${leader.totalPnl.toFixed(2)}`);
        // Only show time ago if lastTradeAt is a valid recent timestamp (not 0 or epoch)
        const lastTrade = leader.lastTradeAt && leader.lastTradeAt > 1000000000000
          ? formatTimeAgo(leader.lastTradeAt)
          : '-';
        const tags = leader.tags ? JSON.parse(leader.tags).slice(0, 2).join(',') : '-';

        table.push([
          idx + 1,
          leader.alias || '-',
          `${leader.address.slice(0, 6)}...${leader.address.slice(-4)}`,
          tags.length > 14 ? tags.slice(0, 13) + '…' : tags,
          leader.totalTrades,
          `${leader.winRate.toFixed(0)}%`,
          pnlStr,
          lastTrade,
        ]);
      });

      console.log(table.toString());
      console.log(chalk.gray(`\nTotal: ${allLeaders.length} leaders`));
      console.log(chalk.gray('Tip: Use #number or alias for remove/stats (e.g. "copyhunter leaders stats #1")'));
    });

  // leaders stats
  cmd
    .command('stats <identifier>')
    .description('Show detailed stats for a leader (by address, #number, or alias)')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (identifier: string, options) => {
      const jsonOutput = isJsonOutput(options);
      const resolved = await resolveLeaderIdentifier(identifier);

      if (!resolved) {
        if (jsonOutput) {
          printJsonError('leader_not_found', `Leader not found: ${identifier}`, {
            identifier,
          });
          return;
        }
        console.log(chalk.red(`Leader not found: ${identifier}`));
        console.log(chalk.gray('\nUse address, #number (e.g. #1), or alias'));
        return;
      }

      const leader = resolved.leader;

      if (jsonOutput) {
        printJson(leader);
        return;
      }

      console.log(chalk.bold('\nLeader Stats\n'));
      console.log(`Address:      ${leader.address}`);
      console.log(`Alias:        ${leader.alias || '-'}`);
      console.log(`Platform:     ${leader.platform}`);
      console.log(`Tags:         ${leader.tags ? JSON.parse(leader.tags).join(', ') : '-'}`);
      console.log(`Total Trades: ${leader.totalTrades}`);
      console.log(`Win Rate:     ${leader.winRate.toFixed(1)}%`);
      const pnlColor = leader.totalPnl >= 0 ? chalk.green : chalk.red;
      console.log(`Total PnL:    ${pnlColor(`$${leader.totalPnl.toFixed(2)}`)}`);
      console.log(`Added:        ${new Date(leader.addedAt).toLocaleString()}`);
      console.log(`Last Trade:   ${leader.lastTradeAt && leader.lastTradeAt > 1000000000000 ? new Date(leader.lastTradeAt).toLocaleString() : '-'}`);
    });

  // leaders update (new command to update alias/tags)
  cmd
    .command('update <identifier>')
    .description('Update a leader (by address, #number, or alias)')
    .option('-a, --alias <alias>', 'New alias')
    .option('-t, --tags <tags>', 'New tags (comma-separated)')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (identifier: string, options) => {
      const jsonOutput = isJsonOutput(options);
      const spinner = jsonOutput ? null : ora('Updating leader...').start();

      try {
        const resolved = await resolveLeaderIdentifier(identifier);

        if (!resolved) {
          if (jsonOutput) {
            printJsonError('leader_not_found', `Leader not found: ${identifier}`, {
              identifier,
            });
            return;
          }
          markCommandFailed();
          spinner?.fail(`Leader not found: ${identifier}`);
          console.log(chalk.gray('\nUse address, #number (e.g. #1), or alias'));
          return;
        }

        if (!options.alias && !options.tags) {
          if (jsonOutput) {
            printJsonError('nothing_to_update', 'Nothing to update. Use --alias or --tags', {
              identifier,
            });
            return;
          }
          markCommandFailed();
          spinner?.fail('Nothing to update. Use --alias or --tags');
          return;
        }

        const db = getDb();
        const updates: any = { updatedAt: Date.now() };
        const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : undefined;

        if (options.alias) {
          updates.alias = options.alias;
        }
        if (tags) {
          updates.tags = JSON.stringify(tags);
        }

        await db.update(leaders).set(updates).where(eq(leaders.address, resolved.address));

        const displayName = options.alias || resolved.leader.alias || resolved.address;
        if (jsonOutput) {
          printJsonSuccess('leader_updated', `Updated leader: ${displayName}`, {
            identifier,
            leader: {
              address: resolved.address,
              alias: options.alias ?? resolved.leader.alias ?? null,
              tags: tags ?? (resolved.leader.tags ? JSON.parse(resolved.leader.tags) : null),
            },
          });
          return;
        }

        spinner?.succeed(`Updated leader: ${displayName}`);
      } catch (error) {
        if (jsonOutput) {
          printJsonError('leader_update_failed', error instanceof Error ? error.message : String(error), {
            identifier,
          });
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to update leader: ${error}`);
      }
    });

  // leaders import
  cmd
    .command('import')
    .description('Import leaders from Polymarket leaderboard')
    .option('-n, --top <n>', 'Number of top traders to import', '10')
    .option('-p, --period <period>', 'Period: weekly or monthly', 'monthly')
    .option('--dry-run', 'Preview without importing')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);
      const top = parseInt(options.top, 10);
      const period = options.period as 'weekly' | 'monthly';
      const validPeriods = ['weekly', 'monthly'];

      if (!Number.isInteger(top) || top < 1) {
        if (jsonOutput) {
          printJsonError('invalid_top', '--top must be a positive integer.', {
            top: options.top,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red('Error: --top must be a positive integer'));
        return;
      }

      if (!validPeriods.includes(period)) {
        if (jsonOutput) {
          printJsonError('invalid_period', `Invalid period '${options.period}'.`, {
            period: options.period,
            validPeriods,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Error: Invalid period '${options.period}'. Valid periods: ${validPeriods.join(', ')}`));
        return;
      }

      const spinner = jsonOutput
        ? null
        : ora(`Fetching top ${options.top} leaders from ${options.period} leaderboard...`).start();

      try {
        const { getPolymarketCLI } = await import('../../platforms/polymarket/cli-wrapper.js');
        const cli = getPolymarketCLI();

        const leaderboard = await cli.getLeaderboard(
          period,
          top
        );

        if (leaderboard.length === 0) {
          if (jsonOutput) {
            printJsonError('no_leaders_found', 'No leaders found on leaderboard', {
              period,
              top,
            });
            return;
          }
          markCommandFailed();
          spinner?.fail('No leaders found on leaderboard');
          return;
        }

        spinner?.succeed(`Found ${leaderboard.length} leaders`);

        // Show preview
        if (!jsonOutput) {
          const table = new Table({
            head: ['Rank', 'Alias', 'Address', 'PnL', 'Volume'],
            colWidths: [6, 20, 14, 16, 16],
          });

          for (const entry of leaderboard) {
            const pnlColor = entry.pnl >= 0 ? chalk.green : chalk.red;
            table.push([
              entry.rank,
              entry.alias || '-',
              `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`,
              pnlColor(`$${entry.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`),
              `$${entry.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
            ]);
          }

          console.log(table.toString());
        }

        if (options.dryRun) {
          if (jsonOutput) {
            printJsonSuccess('leaders_import_preview', `Previewed ${leaderboard.length} leaderboard leaders.`, {
              period,
              top,
              dryRun: true,
              leaders: leaderboard,
            });
            return;
          }
          console.log(chalk.yellow('\n--dry-run: No changes made'));
          return;
        }

        // Import leaders
        const importSpinner = jsonOutput ? null : ora('Importing leaders...').start();
        const db = getDb();
        const now = Date.now();
        let imported = 0;
        let skipped = 0;

        for (const entry of leaderboard) {
          const existing = await db.query.leaders.findFirst({
            where: eq(leaders.address, entry.address.toLowerCase()),
          });

          if (existing) {
            skipped++;
            continue;
          }

          await db.insert(leaders).values({
            address: entry.address.toLowerCase(),
            alias: entry.alias,
            tags: JSON.stringify(['imported', period]),
            platform: 'polymarket' as Platform,
            totalPnl: entry.pnl,
            addedAt: now,
            updatedAt: now,
          });

          imported++;
        }

        if (jsonOutput) {
          printJsonSuccess('leaders_imported', `Imported ${imported} leaders${skipped > 0 ? `, ${skipped} already existed` : ''}`, {
            period,
            top,
            dryRun: false,
            imported,
            skipped,
            totalFetched: leaderboard.length,
          });
          return;
        }

        importSpinner?.succeed(`Imported ${imported} leaders${skipped > 0 ? `, ${skipped} already existed` : ''}`);
      } catch (error) {
        if (jsonOutput) {
          printJsonError('leaders_import_failed', error instanceof Error ? error.message : String(error), {
            period,
            top,
          });
          return;
        }
        markCommandFailed();
        spinner?.fail(`Failed to import: ${error}`);
      }
    });

  // leaders refresh
  cmd
    .command('refresh [identifier]')
    .description('Refresh winRate and PnL stats from closed positions')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (identifier: string | undefined, options) => {
      const statsUpdater = getLeaderStatsUpdater();
      const jsonOutput = isJsonOutput(options);

      if (identifier) {
        // Refresh single leader
        const resolved = await resolveLeaderIdentifier(identifier);

        if (!resolved) {
          if (jsonOutput) {
            printJsonError('leader_not_found', `Leader not found: ${identifier}`, {
              identifier,
            });
            return;
          }
          console.log(chalk.red(`Leader not found: ${identifier}`));
          console.log(chalk.gray('\nUse address, #number (e.g. #1), or alias'));
          return;
        }

        const spinner = jsonOutput
          ? null
          : ora(`Refreshing stats for ${resolved.leader.alias || resolved.address.slice(0, 10)}...`).start();

        try {
          const result = await statsUpdater.updateLeader(resolved.address);

          if (result.error) {
            if (jsonOutput) {
              printJsonError('refresh_failed', result.error, {
                address: resolved.address,
              });
              return;
            }
            spinner?.fail(`Error: ${result.error}`);
            return;
          }

          spinner?.succeed('Stats refreshed');

          if (jsonOutput) {
            printJsonSuccess('leader_refreshed', 'Leader stats refreshed.', {
              result,
            });
            return;
          }

          console.log(chalk.bold('\nUpdated Stats\n'));
          console.log(`Closed Positions: ${result.closedPositions}`);
          console.log(`Wins:             ${result.wins}`);
          console.log(`Win Rate:         ${result.winRate.toFixed(1)}%`);
          const pnlColor = result.totalPnl >= 0 ? chalk.green : chalk.red;
          console.log(`Total PnL:        ${pnlColor(`$${result.totalPnl.toFixed(2)}`)}`);
        } catch (error) {
          if (jsonOutput) {
            printJsonError('refresh_failed', String(error), {
              address: resolved.address,
            });
            return;
          }
          spinner?.fail(`Failed: ${error}`);
        }
      } else {
        // Refresh all leaders
        const spinner = jsonOutput ? null : ora('Refreshing stats for all leaders...').start();

        try {
          const results = await statsUpdater.updateAll();

          const updated = results.filter(r => r.updated);
          const errors = results.filter(r => r.error);

          spinner?.succeed(`Refreshed ${updated.length} leaders${errors.length > 0 ? `, ${errors.length} errors` : ''}`);

          if (jsonOutput) {
            printJsonSuccess('leaders_refreshed', 'Leader stats refresh completed.', {
              results,
              updated: updated.length,
              errors: errors.length,
            });
            return;
          }

          if (updated.length > 0) {
            const table = new Table({
              head: ['Address', 'Closed', 'Wins', 'Win%', 'PnL'],
              colWidths: [14, 8, 6, 8, 14],
            });

            for (const r of updated) {
              const pnlColor = r.totalPnl >= 0 ? chalk.green : chalk.red;
              table.push([
                `${r.address.slice(0, 6)}...${r.address.slice(-4)}`,
                r.closedPositions,
                r.wins,
                `${r.winRate.toFixed(1)}%`,
                pnlColor(`$${r.totalPnl.toFixed(2)}`),
              ]);
            }

            console.log(table.toString());
          }

          if (errors.length > 0) {
            console.log(chalk.yellow(`\nErrors:`));
            for (const e of errors) {
              console.log(chalk.gray(`  ${e.address.slice(0, 10)}...: ${e.error}`));
            }
          }
        } catch (error) {
          if (jsonOutput) {
            printJsonError('refresh_failed', String(error));
            return;
          }
          spinner?.fail(`Failed: ${error}`);
        }
      }
    });

  return cmd;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
