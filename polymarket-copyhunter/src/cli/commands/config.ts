/**
 * CopyHunter - Config Command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { getConfig, getConfigPath, setConfigValue, resetConfig } from '../../core/config.js';
import { getDataDir, getDbPath } from '../../core/config.js';
import { isJsonOutput, markCommandFailed, printJson, printJsonError, printJsonSuccess } from '../json-output.js';

function getNestedValue(target: unknown, path: string): unknown {
  let current = target;

  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function parseConfigInputValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (!isNaN(Number(value))) return Number(value);

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function waitForPersistedConfigValue(path: string, expectedValue: unknown): Promise<void> {
  const deadline = Date.now() + 1000;

  while (Date.now() <= deadline) {
    try {
      const configFile = readFileSync(getConfigPath(), 'utf8');
      const persistedValue = getNestedValue(JSON.parse(configFile), path);

      if (isDeepStrictEqual(persistedValue, expectedValue)) {
        return;
      }
    } catch {
      // Keep polling until the config file becomes visible and contains the expected value.
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for "${path}" to persist to disk.`);
}

export function createConfigCommand(): Command {
  const cmd = new Command('config')
    .description('Manage configuration');

  // config show
  cmd
    .command('show')
    .description('Show current configuration')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const config = getConfig();

      if (isJsonOutput(options)) {
        printJson(config);
        return;
      }

      console.log(chalk.bold('\n⚙️  CopyHunter Configuration\n'));

      console.log(chalk.cyan('Paths:'));
      console.log(`  Data Dir:    ${getDataDir()}`);
      console.log(`  Config File: ${getConfigPath()}`);
      console.log(`  Database:    ${getDbPath()}`);

      console.log(chalk.cyan('\nLeaders:'));
      console.log(`  Auto Import:   ${config.leaders.autoImport}`);
      console.log(`  Import Top:    ${config.leaders.importTop}`);
      console.log(`  Import Period: ${config.leaders.importPeriod}`);

      console.log(chalk.cyan('\nWatch:'));
      console.log(`  Interval:      ${config.watch.interval}ms`);
      console.log(`  Sources:       ${config.watch.sources.join(', ')}`);
      console.log(`  Min Trade USD: $${config.watch.filterMinUsd}`);

      console.log(chalk.cyan('\nFollow:'));
      console.log(`  Mode:          ${config.follow.mode}`);
      console.log(`  Follower Addr: ${config.follow.followerAddress || '(not set)'}`);
      console.log(`  Sizing Mode:   ${config.follow.sizingMode}`);
      console.log(`  Bankroll USD:  $${config.follow.bankrollUsd}`);
      console.log(`  Max Per Trade: $${config.follow.maxPerTrade}`);
      console.log(`  Daily Limit:   $${config.follow.dailyLimit}`);
      console.log(`  Allowlist:     ${config.follow.allowlist.length} addresses`);
      console.log(`  Blocklist:     ${config.follow.blocklist.length} addresses`);

      console.log(chalk.cyan('\nRisk:'));
      console.log(`  Max Exposure:  $${config.risk.maxExposure}`);
      console.log(`  Max Positions: ${config.risk.maxPositions}`);
      console.log(`  Max Loss/Day:  $${config.risk.maxLossPerDay}`);
      console.log(`  Stop Loss:     ${(config.risk.stopLossPercent * 100).toFixed(0)}%`);

      console.log(chalk.cyan('\nDisplay:'));
      console.log(`  Theme:         ${config.display.theme}`);
      console.log(`  Refresh:       ${config.display.refreshInterval}ms`);
    });

  // config set
  cmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (key: string, value: string, options) => {
      const jsonOutput = isJsonOutput(options);

      try {
        const parsedValue = parseConfigInputValue(value);
        setConfigValue(key, parsedValue);
        await waitForPersistedConfigValue(key, parsedValue);

        if (jsonOutput) {
          printJsonSuccess('config_updated', `Set ${key} = ${value}`, {
            key,
            value: parsedValue,
          });
          return;
        }

        console.log(chalk.green(`✓ Set ${key} = ${value}`));
      } catch (error) {
        if (jsonOutput) {
          printJsonError('config_update_failed', error instanceof Error ? error.message : String(error), {
            key,
            value,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Failed to set config: ${error}`));
      }
    });

  // config reset
  cmd
    .command('reset')
    .description('Reset configuration to defaults')
    .option('--confirm', 'Confirm reset', false)
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const jsonOutput = isJsonOutput(options);

      if (!options.confirm) {
        if (jsonOutput) {
          printJsonError('confirmation_required', 'Configuration reset requires --confirm.', {
            command: 'copyhunter config reset --confirm',
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.yellow('This will reset all configuration to defaults.'));
        console.log(chalk.gray('\nTo confirm: copyhunter config reset --confirm'));
        return;
      }

      resetConfig();

      if (jsonOutput) {
        printJsonSuccess('config_reset', 'Configuration reset to defaults');
        return;
      }

      console.log(chalk.green('✓ Configuration reset to defaults'));
    });

  // config path
  cmd
    .command('path')
    .description('Show configuration file path')
    .action(async () => {
      console.log(getConfigPath());
    });

  return cmd;
}
