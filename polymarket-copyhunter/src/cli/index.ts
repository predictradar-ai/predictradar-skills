/**
 * CopyHunter - CLI Main Entry
 */

import { Command } from 'commander';
import { createLeadersCommand } from './commands/leaders.js';
import { createWatchCommand } from './commands/watch.js';
import { createFollowCommand } from './commands/follow.js';
import { createConfigCommand } from './commands/config.js';
import { createPnlCommand } from './commands/pnl.js';
import { createTuiCommand } from './commands/tui.js';
import { createDbCommand } from './commands/db.js';
import { closeDb, checkDbSize } from '../db/index.js';
import chalk from 'chalk';

export const program = new Command();

program
  .name('copyhunter')
  .description('Smart money copy trading terminal for prediction markets')
  .version('0.1.0')
  .option('-v, --verbose', 'Enable verbose logging', false);

// Register commands
program.addCommand(createLeadersCommand());
program.addCommand(createWatchCommand());
program.addCommand(createFollowCommand());
program.addCommand(createConfigCommand());
program.addCommand(createPnlCommand());
program.addCommand(createTuiCommand());
program.addCommand(createDbCommand());

// Check database size at startup and warn if needed
const dbSizeCheck = checkDbSize();
if (dbSizeCheck.shouldWarn && dbSizeCheck.message) {
  console.log(chalk.yellow(`\n⚠️  ${dbSizeCheck.message}\n`));
}

// Cleanup on exit
process.on('exit', () => {
  closeDb();
});

function registerDefaultSignalExit(signal: NodeJS.Signals): void {
  process.on(signal, () => {
    closeDb();

    // Let command-specific handlers perform their own cleanup when present.
    if (process.listenerCount(signal) > 1) {
      return;
    }

    process.exit(0);
  });
}

registerDefaultSignalExit('SIGINT');
registerDefaultSignalExit('SIGTERM');
