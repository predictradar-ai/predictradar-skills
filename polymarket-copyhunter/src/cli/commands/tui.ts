/**
 * CopyHunter - TUI Command
 */

import { Command } from 'commander';

export function createTuiCommand(): Command {
  const cmd = new Command('tui')
    .description('Launch interactive TUI dashboard')
    .option('-r, --refresh <ms>', 'Refresh interval in milliseconds', '5000')
    .action(async (options) => {
      // Dynamic import to avoid loading React unless needed
      const { startTui } = await import('../../tui/index.js');
      startTui({
        refreshInterval: parseInt(options.refresh),
      });
    });

  return cmd;
}
