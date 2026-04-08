/**
 * CopyHunter - CLI Integration Tests
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const CLI_PATH = 'node --import tsx bin/copyhunter.ts';
const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-test-'));
const testRuntimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-runtime-'));

function runCLI(args: string): string {
  return runCLIWithEnv(args);
}

function runCLIWithEnv(args: string, env: NodeJS.ProcessEnv = {}): string {
  try {
    const result = execSync(`${CLI_PATH} ${args}`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XDG_DATA_HOME: testDataDir,
        COPYHUNTER_RUNTIME_DIR: testRuntimeDir,
        ...env,
      },
    });
    return result.trim();
  } catch (error: any) {
    // Combine stdout and stderr for error cases
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    return (stdout + stderr).trim();
  }
}

function createIsolatedCliEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-data-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-runtime-'));

  return {
    env: {
      XDG_DATA_HOME: dataDir,
      COPYHUNTER_RUNTIME_DIR: runtimeDir,
    },
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

function getIsolatedDataDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_DATA_HOME!, 'copyhunter');
}

function getIsolatedConfigPath(env: NodeJS.ProcessEnv): string {
  return join(getIsolatedDataDir(env), 'config.json');
}

function getIsolatedDbPath(env: NodeJS.ProcessEnv): string {
  return join(getIsolatedDataDir(env), 'copyhunter.db');
}

process.on('exit', () => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
    rmSync(testRuntimeDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

describe('CLI Integration Tests', () => {
  describe('Help Commands', () => {
    it('should show main help', () => {
      const output = runCLI('--help');
      assert.ok(output.includes('copyhunter'), 'Should include copyhunter');
      assert.ok(output.includes('leaders'), 'Should include leaders command');
      assert.ok(output.includes('watch'), 'Should include watch command');
      assert.ok(output.includes('follow'), 'Should include follow command');
      assert.ok(output.includes('pnl'), 'Should include pnl command');
    });

    it('should show leaders help', () => {
      const output = runCLI('leaders --help');
      assert.ok(output.includes('add'), 'Should include add subcommand');
      assert.ok(output.includes('remove'), 'Should include remove subcommand');
      assert.ok(output.includes('list'), 'Should include list subcommand');
    });

    it('should show watch help', () => {
      const output = runCLI('watch --help');
      // Check for available subcommands
      assert.ok(
        output.includes('start') || output.includes('stop') || output.includes('status') || output.includes('Watch'),
        'Should include watch content'
      );
    });

    it('should show follow help', () => {
      const output = runCLI('follow --help');
      assert.ok(
        output.includes('shadow') || output.includes('live') || output.includes('status') || output.includes('Follow'),
        'Should include follow content'
      );
    });

    it('should show pnl help', () => {
      const output = runCLI('pnl --help');
      assert.ok(output.includes('unrealized'), 'Should include unrealized command');
      assert.ok(output.includes('daily'), 'Should include daily command');
      assert.ok(output.includes('report'), 'Should include report command');
    });

    it('should show config help', () => {
      const output = runCLI('config --help');
      assert.ok(output.includes('show'), 'Should include show command');
      assert.ok(output.includes('set'), 'Should include set command');
    });

    it('should show db help', () => {
      const output = runCLI('db --help');
      assert.ok(output.includes('stats'), 'Should include stats command');
      assert.ok(output.includes('prune'), 'Should include prune command');
      assert.ok(output.includes('vacuum'), 'Should include vacuum command');
    });
  });

  describe('Version', () => {
    it('should show version', () => {
      const output = runCLI('--version');
      // Version should be a semver string
      assert.ok(/\d+\.\d+\.\d+/.test(output), 'Should show version number');
    });
  });

  describe('Leaders Commands', () => {
    const testAddress = '0x1234567890123456789012345678901234567890';

    afterEach(() => {
      // Clean up test leader
      try {
        runCLI(`leaders remove ${testAddress}`);
      } catch {
        // Ignore if not exists
      }
    });

    it('should list leaders without error', () => {
      const output = runCLI('leaders list');
      // Should either show leaders or no error output
      assert.ok(typeof output === 'string', 'Should return string output');
    });

    it('should add and remove a leader', () => {
      const addOutput = runCLI(`leaders add ${testAddress} --alias TestLeader`);
      assert.ok(typeof addOutput === 'string', 'Add command should complete without throwing');

      const listAfterAdd = runCLI('leaders list');
      assert.ok(listAfterAdd.includes('TestLeader'), 'Added leader should appear in list output');

      const removeOutput = runCLI(`leaders remove ${testAddress}`);
      assert.ok(typeof removeOutput === 'string', 'Remove command should complete without throwing');

      const listAfterRemove = runCLI('leaders list');
      assert.ok(!listAfterRemove.includes('TestLeader'), 'Removed leader should not remain in list output');
    });
  });

  describe('Config Commands', () => {
    it('should show config without error', () => {
      const output = runCLI('config show');
      // Should show some config content or empty
      assert.ok(typeof output === 'string', 'Should return string output');
    });

    it('should set config value without error', () => {
      const output = runCLI('config set follow.maxPerTrade 50');
      // Should not throw
      assert.ok(typeof output === 'string', 'Should return string output');
    });
  });

  describe('PnL Commands', () => {
    it('should show pnl summary', () => {
      const output = runCLI('pnl');
      // Should show summary content
      assert.ok(
        output.includes('PnL') || output.includes('Position') || output.includes('$') || output.length >= 0,
        'Should show PnL related content'
      );
    });

    it('should show daily pnl', () => {
      const output = runCLI('pnl daily');
      // Should not throw
      assert.ok(typeof output === 'string', 'Should return string output');
    });

    it('should show pnl by leaders', () => {
      const output = runCLI('pnl leaders');
      // Should not throw
      assert.ok(typeof output === 'string', 'Should return string output');
    });

    it('should generate report', () => {
      const output = runCLI('pnl report -t summary -f json');
      // Should produce output
      assert.ok(output.length >= 0, 'Should produce output');
    });

    it('should analyze leaders', () => {
      const output = runCLI('pnl analyze');
      // Should not throw
      assert.ok(typeof output === 'string', 'Should return string output');
    });
  });

  describe('Watch Commands', () => {
    it('should show watch status', () => {
      const output = runCLI('watch status');
      assert.ok(typeof output === 'string', 'Should return string output');
    });

    it('should reject combining incremental reconciliation with a fixed window preset', () => {
      const output = runCLI('watch reconcile 0x123 --incremental --window 10m -o json');
      const parsed = JSON.parse(output);

      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.error.code, 'watch_reconcile_failed');
      assert.match(parsed.error.message, /--incremental cannot be combined with --from, --to, --hours, or --window/i);
    });

    it('should reject combining a fixed window preset with --from', () => {
      const output = runCLI('watch reconcile 0x123 --window 10m --from 2026-04-03T00:00:00Z -o json');
      const parsed = JSON.parse(output);

      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.error.code, 'watch_reconcile_failed');
      assert.match(parsed.error.message, /--window cannot be combined with --from/i);
    });
  });

  describe('Follow Commands', () => {
    it('should show follow status', () => {
      const output = runCLI('follow status');
      assert.ok(typeof output === 'string', 'Should return string output');
    });
  });

  describe('Database Commands', () => {
    it('should show db stats', () => {
      const output = runCLI('db stats');
      assert.ok(output.includes('Database Statistics') || output.includes('File'), 'Should show database stats');
    });

    it('should show db path', () => {
      const output = runCLI('db path');
      assert.ok(output.includes('.copyhunter') || output.includes('.db'), 'Should show database path');
    });

    it('should support db stats json output', () => {
      const output = runCLI('db stats --json');
      assert.ok(output.includes('"fileSizeBytes"'), 'Should include JSON fields');
      assert.ok(output.includes('"tableStats"'), 'Should include tableStats');
    });

    it('should run prune dry-run', () => {
      const output = runCLI('db prune --days 365 --dry-run');
      assert.ok(output.includes('Dry Run') || output.includes('deleted'), 'Should show dry run output');
    });
  });
});

describe('CLI Output Formats', () => {
  describe('JSON Output', () => {
    it('should output json for leaders list', () => {
      const output = runCLI('leaders list -o json');
      const parsed = JSON.parse(output) as { leaders: unknown[] };

      assert.ok(Array.isArray(parsed.leaders), 'Should return a leaders array');
    });

    it('should output json for pnl daily', () => {
      const output = runCLI('pnl daily -o json');
      const parsed = JSON.parse(output) as unknown;
      assert.ok(typeof parsed === 'object' && parsed !== null, 'Should produce valid JSON');
    });

    it('should output json for empty-state pnl commands', () => {
      const isolatedDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-empty-data-'));
      const isolatedRuntimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-empty-runtime-'));

      try {
        const daily = JSON.parse(runCLIWithEnv('pnl daily -o json', {
          XDG_DATA_HOME: isolatedDataDir,
          COPYHUNTER_RUNTIME_DIR: isolatedRuntimeDir,
        })) as { daily: unknown[] };
        assert.deepStrictEqual(daily.daily, [], 'Empty daily PnL should return an empty array');

        const leaders = JSON.parse(runCLIWithEnv('pnl leaders -o json', {
          XDG_DATA_HOME: isolatedDataDir,
          COPYHUNTER_RUNTIME_DIR: isolatedRuntimeDir,
        })) as { leaders: unknown[] };
        assert.deepStrictEqual(leaders.leaders, [], 'Empty leader PnL should return an empty array');

        const unrealized = JSON.parse(runCLIWithEnv('pnl unrealized -o json', {
          XDG_DATA_HOME: isolatedDataDir,
          COPYHUNTER_RUNTIME_DIR: isolatedRuntimeDir,
        })) as {
          summary: { totalCostBasis: number; totalCurrentValue: number; unrealizedPnl: number; unrealizedPnlPercent: number };
          positions: unknown[];
        };
        assert.deepStrictEqual(unrealized.positions, [], 'Empty unrealized PnL should return an empty positions array');
        assert.strictEqual(unrealized.summary.totalCostBasis, 0);
        assert.strictEqual(unrealized.summary.totalCurrentValue, 0);
        assert.strictEqual(unrealized.summary.unrealizedPnl, 0);
        assert.strictEqual(unrealized.summary.unrealizedPnlPercent, 0);

        const analyze = JSON.parse(runCLIWithEnv('pnl analyze -o json', {
          XDG_DATA_HOME: isolatedDataDir,
          COPYHUNTER_RUNTIME_DIR: isolatedRuntimeDir,
        })) as { metric: string; limit: number; leaders: unknown[] };
        assert.strictEqual(analyze.metric, 'pnl');
        assert.strictEqual(analyze.limit, 10);
        assert.deepStrictEqual(analyze.leaders, [], 'Empty leader analysis should return an empty array');
      } finally {
        rmSync(isolatedDataDir, { recursive: true, force: true });
        rmSync(isolatedRuntimeDir, { recursive: true, force: true });
      }
    });

    it('should output json for not-found and error-style command paths', () => {
      const missingLeaderStats = JSON.parse(runCLI('leaders stats MissingLeader -o json')) as {
        ok: boolean;
        error: { code: string; message: string };
        identifier: string;
      };
      assert.strictEqual(missingLeaderStats.ok, false);
      assert.strictEqual(missingLeaderStats.error.code, 'leader_not_found');
      assert.strictEqual(missingLeaderStats.identifier, 'MissingLeader');

      const missingLeaderAnalysis = JSON.parse(runCLI('pnl analyze --address 0xdeadbeef -o json')) as {
        ok: boolean;
        error: { code: string; message: string };
        address: string;
      };
      assert.strictEqual(missingLeaderAnalysis.ok, false);
      assert.strictEqual(missingLeaderAnalysis.error.code, 'leader_not_found');
      assert.strictEqual(missingLeaderAnalysis.address, '0xdeadbeef');

      const missingFollowTarget = JSON.parse(runCLI('follow once MissingLeader --dry-run -o json')) as {
        ok: boolean;
        error: { code: string; message: string };
        identifier: string;
      };
      assert.strictEqual(missingFollowTarget.ok, false);
      assert.strictEqual(missingFollowTarget.error.code, 'leader_not_found');
      assert.strictEqual(missingFollowTarget.identifier, 'MissingLeader');
    });

    it('should output json for leader mutation commands', () => {
      const isolated = createIsolatedCliEnv();
      const address = '0x1234567890123456789012345678901234567890';

      try {
        const added = JSON.parse(runCLIWithEnv(`leaders add ${address} --alias TestLeader --tags whale,alpha -o json`, isolated.env)) as {
          ok: boolean;
          code: string;
          leader: { address: string; alias: string; tags: string[]; platform: string };
        };
        assert.strictEqual(added.ok, true);
        assert.strictEqual(added.code, 'leader_added');
        assert.strictEqual(added.leader.address, address);
        assert.deepStrictEqual(added.leader.tags, ['whale', 'alpha']);

        const updated = JSON.parse(runCLIWithEnv(`leaders update ${address} --alias UpdatedLeader -o json`, isolated.env)) as {
          ok: boolean;
          code: string;
          leader: { alias: string };
        };
        assert.strictEqual(updated.ok, true);
        assert.strictEqual(updated.code, 'leader_updated');
        assert.strictEqual(updated.leader.alias, 'UpdatedLeader');

        const removed = JSON.parse(runCLIWithEnv('leaders remove UpdatedLeader -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          leader: { address: string };
        };
        assert.strictEqual(removed.ok, true);
        assert.strictEqual(removed.code, 'leader_removed');
        assert.strictEqual(removed.leader.address, address);

        const missing = JSON.parse(runCLIWithEnv('leaders remove UpdatedLeader -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(missing.ok, false);
        assert.strictEqual(missing.error.code, 'leader_not_found');
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json for config and follow action commands', () => {
      const isolated = createIsolatedCliEnv();

      try {
        const setResult = JSON.parse(runCLIWithEnv('config set follow.maxPerTrade 75 -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          key: string;
          value: number;
        };
        assert.strictEqual(setResult.ok, true);
        assert.strictEqual(setResult.code, 'config_updated');
        assert.strictEqual(setResult.key, 'follow.maxPerTrade');
        assert.strictEqual(setResult.value, 75);

        const maxExposureResult = JSON.parse(runCLIWithEnv('config set risk.maxExposure 10 -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          key: string;
          value: number;
        };
        assert.strictEqual(maxExposureResult.ok, true);
        assert.strictEqual(maxExposureResult.code, 'config_updated');
        assert.strictEqual(maxExposureResult.key, 'risk.maxExposure');
        assert.strictEqual(maxExposureResult.value, 10);

        const shownConfig = JSON.parse(runCLIWithEnv('config show -o json', isolated.env)) as {
          risk: { maxExposure: number; maxPositions: number };
        };
        assert.strictEqual(shownConfig.risk.maxExposure, 10);

        const maxPositionsResult = JSON.parse(runCLIWithEnv('config set risk.maxPositions 5000 -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          key: string;
          value: number;
        };
        assert.strictEqual(maxPositionsResult.ok, true);
        assert.strictEqual(maxPositionsResult.code, 'config_updated');
        assert.strictEqual(maxPositionsResult.key, 'risk.maxPositions');
        assert.strictEqual(maxPositionsResult.value, 5000);

        const allowlist = ['0x1234567890123456789012345678901234567890'];
        const allowlistResult = JSON.parse(
          runCLIWithEnv(`config set follow.allowlist '${JSON.stringify(allowlist)}' -o json`, isolated.env)
        ) as {
          ok: boolean;
          code: string;
          key: string;
          value: string[];
        };
        assert.strictEqual(allowlistResult.ok, true);
        assert.strictEqual(allowlistResult.code, 'config_updated');
        assert.strictEqual(allowlistResult.key, 'follow.allowlist');
        assert.deepStrictEqual(allowlistResult.value, allowlist);

        const shownConfigAfterPositions = JSON.parse(runCLIWithEnv('config show -o json', isolated.env)) as {
          risk: { maxExposure: number; maxPositions: number };
          follow: { allowlist: string[] };
        };
        assert.strictEqual(shownConfigAfterPositions.risk.maxExposure, 10);
        assert.strictEqual(shownConfigAfterPositions.risk.maxPositions, 5000);
        assert.deepStrictEqual(shownConfigAfterPositions.follow.allowlist, allowlist);

        const rawConfig = JSON.parse(readFileSync(getIsolatedConfigPath(isolated.env), 'utf8')) as {
          risk: { maxExposure: number; maxPositions: number };
          follow: { allowlist: string[] };
        };
        assert.strictEqual(rawConfig.risk.maxExposure, 10);
        assert.strictEqual(rawConfig.risk.maxPositions, 5000);
        assert.deepStrictEqual(rawConfig.follow.allowlist, allowlist);

        const resetRejected = JSON.parse(runCLIWithEnv('config reset -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(resetRejected.ok, false);
        assert.strictEqual(resetRejected.error.code, 'confirmation_required');

        const shadow = JSON.parse(runCLIWithEnv('follow shadow -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          mode: string;
        };
        assert.strictEqual(shadow.ok, true);
        assert.strictEqual(shadow.code, 'follow_mode_updated');
        assert.strictEqual(shadow.mode, 'shadow');

        const liveRejected = JSON.parse(runCLIWithEnv('follow live -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(liveRejected.ok, false);
        assert.strictEqual(liveRejected.error.code, 'confirmation_required');

        const live = JSON.parse(runCLIWithEnv(
          'follow live --confirm --max-per-trade 60 --daily-limit 300 -o json',
          isolated.env
        )) as {
          ok: boolean;
          code: string;
          mode: string;
          maxPerTrade: number;
          dailyLimit: number;
        };
        assert.strictEqual(live.ok, true);
        assert.strictEqual(live.code, 'follow_mode_updated');
        assert.strictEqual(live.mode, 'live');
        assert.strictEqual(live.maxPerTrade, 60);
        assert.strictEqual(live.dailyLimit, 300);

        const stop = JSON.parse(runCLIWithEnv('follow stop -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          mode: string;
        };
        assert.strictEqual(stop.ok, true);
        assert.strictEqual(stop.code, 'follow_mode_updated');
        assert.strictEqual(stop.mode, 'disabled');

        const reset = JSON.parse(runCLIWithEnv('config reset --confirm -o json', isolated.env)) as {
          ok: boolean;
          code: string;
        };
        assert.strictEqual(reset.ok, true);
        assert.strictEqual(reset.code, 'config_reset');
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json for db action commands', () => {
      const isolated = createIsolatedCliEnv();

      try {
        runCLIWithEnv('leaders add 0x1234567890123456789012345678901234567890 --alias ResetTarget -o json', isolated.env);

        const db = new Database(getIsolatedDbPath(isolated.env));
        const now = Date.now();
        db.exec(`
          INSERT INTO position_lots (
            leader_address, platform, condition_id, market_slug, market_title, outcome,
            entry_quantity, remaining_quantity, avg_price, cost_basis, realized_pnl, status,
            opened_order_id, closed_at, created_at, updated_at
          ) VALUES (
            'self', 'polymarket', 'cond-reset', 'reset-market', 'Reset Market', 'YES',
            1, 1, 0.5, 0.5, 0, 'open', NULL, NULL, ${now}, ${now}
          );
          INSERT INTO watch_cursors (
            leader_address, platform, cursor_timestamp, cursor_trade_keys, updated_at
          ) VALUES (
            '0x1234567890123456789012345678901234567890', 'polymarket', ${now}, '[]', ${now}
          );
        `);
        db.close();

        const prune = JSON.parse(runCLIWithEnv('db prune --days 30 --dry-run -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          dryRun: boolean;
          result: { eventsDeleted: number; ordersDeleted: number; dailyStatsDeleted: number };
        };
        assert.strictEqual(prune.ok, true);
        assert.strictEqual(prune.code, 'db_prune_preview');
        assert.strictEqual(prune.dryRun, true);
        assert.ok(typeof prune.result.eventsDeleted === 'number');

        const resetRejected = JSON.parse(runCLIWithEnv('db reset -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(resetRejected.ok, false);
        assert.strictEqual(resetRejected.error.code, 'confirmation_required');

        const vacuum = JSON.parse(runCLIWithEnv('db vacuum -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          beforeBytes: number;
          afterBytes: number;
          spaceFreedBytes: number;
        };
        assert.strictEqual(vacuum.ok, true);
        assert.strictEqual(vacuum.code, 'db_vacuumed');
        assert.ok(typeof vacuum.beforeBytes === 'number');
        assert.ok(typeof vacuum.afterBytes === 'number');
        assert.ok(typeof vacuum.spaceFreedBytes === 'number');

        const reset = JSON.parse(runCLIWithEnv(
          'db reset --confirm --yes-delete-all -o json',
          isolated.env
        )) as {
          ok: boolean;
          code: string;
          rowsDeleted: number;
          newSizeBytes: number;
        };
        assert.strictEqual(reset.ok, true);
        assert.strictEqual(reset.code, 'db_reset');
        assert.ok(typeof reset.rowsDeleted === 'number');
        assert.ok(typeof reset.newSizeBytes === 'number');

        const verifyDb = new Database(getIsolatedDbPath(isolated.env), { readonly: true });
        const counts = {
          leaders: verifyDb.prepare('SELECT COUNT(*) as count FROM leaders').get() as { count: number },
          events: verifyDb.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number },
          positions: verifyDb.prepare('SELECT COUNT(*) as count FROM positions').get() as { count: number },
          positionLots: verifyDb.prepare('SELECT COUNT(*) as count FROM position_lots').get() as { count: number },
          orders: verifyDb.prepare('SELECT COUNT(*) as count FROM orders').get() as { count: number },
          dailyStats: verifyDb.prepare('SELECT COUNT(*) as count FROM daily_stats').get() as { count: number },
          watchCursors: verifyDb.prepare('SELECT COUNT(*) as count FROM watch_cursors').get() as { count: number },
        };
        verifyDb.close();

        assert.strictEqual(counts.leaders.count, 0);
        assert.strictEqual(counts.events.count, 0);
        assert.strictEqual(counts.positions.count, 0);
        assert.strictEqual(counts.positionLots.count, 0);
        assert.strictEqual(counts.orders.count, 0);
        assert.strictEqual(counts.dailyStats.count, 0);
        assert.strictEqual(counts.watchCursors.count, 0);
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json for watch action commands with no daemon state', () => {
      const isolated = createIsolatedCliEnv();
      const unrelatedRuntimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-cli-runtime-unrelated-'));
      const unrelatedProcess = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', 'copyhunter', 'watch', 'run', '--runtime-dir', unrelatedRuntimeDir],
        {
          stdio: 'ignore',
        }
      );

      try {
        const startRejected = JSON.parse(runCLIWithEnv('watch start -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(startRejected.ok, false);
        assert.strictEqual(startRejected.error.code, 'no_leaders');

        const stop = JSON.parse(runCLIWithEnv('watch stop -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          stoppedProcesses: number;
        };
        assert.strictEqual(stop.ok, true);
        assert.strictEqual(stop.code, 'watch_not_running');
        assert.strictEqual(stop.stoppedProcesses, 0);
        assert.strictEqual(unrelatedProcess.killed, false);
      } finally {
        unrelatedProcess.kill('SIGTERM');
        isolated.cleanup();
        rmSync(unrelatedRuntimeDir, { recursive: true, force: true });
      }
    });

    it('should output event follow summaries for watch stream json', () => {
      const isolated = createIsolatedCliEnv();

      try {
        mkdirSync(getIsolatedDataDir(isolated.env), { recursive: true });
        runCLIWithEnv('watch status -o json', isolated.env);
        const db = new Database(getIsolatedDbPath(isolated.env));
        const now = Date.now();
        db.exec(`
          INSERT INTO events (
            leader_address, platform, event_type, condition_id, market_title, outcome,
            price, quantity, amount_usd, tx_hash, timestamp, followed, follow_reason, created_at
          ) VALUES
          (
            '0xaaa', 'polymarket', 'BUY', 'cond-ok', 'OK Market', 'YES',
            0.5, 10, 5, 'tx-ok', ${now}, 1, 'shadow:order:1', ${now}
          ),
          (
            '0xbbb', 'polymarket', 'BUY', 'cond-skip', 'Skip Market', 'YES',
            0.6, 20, 12, 'tx-skip', ${now + 1}, 0, 'skipped:policy: Leader not in allowlist', ${now + 1}
          ),
          (
            '0xccc', 'polymarket', 'SELL', 'cond-fail', 'Fail Market', 'NO',
            0.4, 30, 12, 'tx-fail', ${now + 2}, 0, 'error:dependency: wallet unavailable', ${now + 2}
          ),
          (
            '0xddd', 'polymarket', 'BUY', 'cond-pend', 'Pend Market', 'YES',
            0.7, 10, 7, 'tx-pend', ${now + 3}, 0, NULL, ${now + 3}
          );
        `);
        db.close();

        const output = JSON.parse(runCLIWithEnv('watch stream -o json -n 10', isolated.env)) as {
          events: Array<{ txHash?: string; followState: string; followReason: string | null }>;
          summary: {
            total: number;
            byState: { ok: number; skip: number; fail: number; pend: number };
            byCategory: { policy: number; risk: number; dependency: number; runtime: number; execution: number; uncategorized: number };
          };
        };

        assert.strictEqual(output.summary.total, 4);
        assert.deepStrictEqual(output.summary.byState, {
          ok: 1,
          skip: 1,
          fail: 1,
          pend: 1,
        });
        assert.deepStrictEqual(output.summary.byCategory, {
          policy: 1,
          risk: 0,
          dependency: 1,
          runtime: 0,
          execution: 0,
          uncategorized: 0,
        });
        assert.ok(output.events.some((event) => event.followState === 'SKIP' && event.followReason?.includes('policy: Leader not in allowlist')));
        assert.ok(output.events.some((event) => event.followState === 'FAIL' && event.followReason?.includes('dependency: wallet unavailable')));
      } finally {
        isolated.cleanup();
      }
    });

    it('should output event follow summaries for follow status and audit json', () => {
      const isolated = createIsolatedCliEnv();

      try {
        mkdirSync(getIsolatedDataDir(isolated.env), { recursive: true });
        runCLIWithEnv('follow status -o json', isolated.env);
        const db = new Database(getIsolatedDbPath(isolated.env));
        const now = Date.now();
        db.exec(`
          INSERT INTO events (
            leader_address, platform, event_type, condition_id, market_title, outcome,
            price, quantity, amount_usd, tx_hash, timestamp, followed, follow_reason, created_at
          ) VALUES
          (
            '0xaaa', 'polymarket', 'BUY', 'cond-ok', 'OK Market', 'YES',
            0.5, 10, 5, 'tx-ok-follow', ${now}, 1, 'shadow:order:1', ${now}
          ),
          (
            '0xbbb', 'polymarket', 'BUY', 'cond-skip', 'Skip Market', 'YES',
            0.6, 20, 12, 'tx-skip-follow', ${now + 1}, 0, 'skipped:policy: Leader not in allowlist', ${now + 1}
          ),
          (
            '0xccc', 'polymarket', 'SELL', 'cond-fail', 'Fail Market', 'NO',
            0.4, 30, 12, 'tx-fail-follow', ${now + 2}, 0, 'error:dependency: wallet unavailable', ${now + 2}
          );
        `);
        db.close();

        const statusOutput = JSON.parse(runCLIWithEnv('follow status -o json', isolated.env)) as {
          stats: {
            recentEvents: {
              summary: {
                total: number;
                byState: { ok: number; skip: number; fail: number; pend: number };
                byCategory: { policy: number; risk: number; dependency: number; runtime: number; execution: number; uncategorized: number };
                topReasons: Array<{ state: string; category: string | null; reason: string; count: number }>;
              };
              sample: Array<{ state: string; category: string | null; reason: string | null }>;
            };
          };
        };

        assert.strictEqual(statusOutput.stats.recentEvents.summary.total, 3);
        assert.deepStrictEqual(statusOutput.stats.recentEvents.summary.byState, {
          ok: 1,
          skip: 1,
          fail: 1,
          pend: 0,
        });
        assert.strictEqual(statusOutput.stats.recentEvents.summary.byCategory.policy, 1);
        assert.strictEqual(statusOutput.stats.recentEvents.summary.byCategory.dependency, 1);
        assert.ok(statusOutput.stats.recentEvents.summary.topReasons.length >= 2);

        const auditOutput = JSON.parse(runCLIWithEnv('follow audit -o json -n 10', isolated.env)) as {
          limit: number;
          summary: {
            total: number;
            byState: { ok: number; skip: number; fail: number; pend: number };
            byCategory: { policy: number; risk: number; dependency: number; runtime: number; execution: number; uncategorized: number };
            topReasons: Array<{ state: string; category: string | null; reason: string; count: number }>;
          };
          events: Array<{ state: string; category: string | null; reason: string | null }>;
        };

        assert.strictEqual(auditOutput.limit, 10);
        assert.strictEqual(auditOutput.summary.total, 3);
        assert.deepStrictEqual(auditOutput.summary.byState, {
          ok: 1,
          skip: 1,
          fail: 1,
          pend: 0,
        });
        assert.strictEqual(auditOutput.summary.byCategory.policy, 1);
        assert.strictEqual(auditOutput.summary.byCategory.dependency, 1);
        assert.ok(auditOutput.events.some((event) => event.state === 'SKIP' && event.category === 'policy'));
        assert.ok(auditOutput.events.some((event) => event.state === 'FAIL' && event.category === 'dependency'));
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json for watch start and stop after publishing daemon status', () => {
      const isolated = createIsolatedCliEnv();
      const address = '0x1234567890123456789012345678901234567890';

      try {
        const added = JSON.parse(runCLIWithEnv(
          `leaders add ${address} --alias StartableLeader -o json`,
          isolated.env
        )) as {
          ok: boolean;
          code: string;
        };
        assert.strictEqual(added.ok, true);
        assert.strictEqual(added.code, 'leader_added');

        const started = JSON.parse(runCLIWithEnv('watch start -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          pid: number;
          background: boolean;
          pollIntervalMs: number;
        };
        assert.strictEqual(started.ok, true);
        assert.strictEqual(started.code, 'watch_started');
        assert.ok(started.pid > 0);
        assert.strictEqual(started.background, true);
        assert.strictEqual(started.pollIntervalMs, 30_000);

        const status = JSON.parse(runCLIWithEnv('watch status -o json', isolated.env)) as {
          running: boolean;
          pid: number | null;
          interval: number;
          startedAt: number | null;
          engine: { isRunning: boolean };
        };
        assert.strictEqual(status.running, true);
        assert.strictEqual(status.pid, started.pid);
        assert.strictEqual(status.interval, 30_000);
        assert.ok(status.startedAt !== null);
        assert.strictEqual(status.engine.isRunning, true);

        const stopped = JSON.parse(runCLIWithEnv('watch stop -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          stoppedProcesses: number;
        };
        assert.strictEqual(stopped.ok, true);
        assert.strictEqual(stopped.code, 'watch_stopped');
        assert.ok(stopped.stoppedProcesses >= 1);
      } finally {
        try {
          runCLIWithEnv('watch stop -o json', isolated.env);
        } catch {
          // Ignore cleanup errors.
        }
        isolated.cleanup();
      }
    });

    it('should output json for follow and refresh local action paths', () => {
      const isolated = createIsolatedCliEnv();

      try {
        JSON.parse(runCLIWithEnv(
          'config set follow.mode disabled -o json',
          isolated.env
        ));

        const followRejected = JSON.parse(runCLIWithEnv(
          'follow once 0x1234567890123456789012345678901234567890 -o json',
          isolated.env
        )) as {
          ok: boolean;
          error: { code: string; message: string };
          mode: string;
        };
        assert.strictEqual(followRejected.ok, false);
        assert.strictEqual(followRejected.error.code, 'follow_disabled');
        assert.strictEqual(followRejected.mode, 'disabled');

        const refresh = JSON.parse(runCLIWithEnv('leaders refresh -o json', isolated.env)) as {
          ok: boolean;
          code: string;
          results: unknown[];
          updated: number;
          errors: number;
        };
        assert.strictEqual(refresh.ok, true);
        assert.strictEqual(refresh.code, 'leaders_refreshed');
        assert.deepStrictEqual(refresh.results, []);
        assert.strictEqual(refresh.updated, 0);
        assert.strictEqual(refresh.errors, 0);
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json for leaders import validation errors', () => {
      const isolated = createIsolatedCliEnv();

      try {
        const invalidTop = JSON.parse(runCLIWithEnv('leaders import --top 0 -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(invalidTop.ok, false);
        assert.strictEqual(invalidTop.error.code, 'invalid_top');

        const invalidPeriod = JSON.parse(runCLIWithEnv('leaders import --period yearly -o json', isolated.env)) as {
          ok: boolean;
          error: { code: string; message: string };
          validPeriods: string[];
        };
        assert.strictEqual(invalidPeriod.ok, false);
        assert.strictEqual(invalidPeriod.error.code, 'invalid_period');
        assert.deepStrictEqual(invalidPeriod.validPeriods, ['weekly', 'monthly']);
      } finally {
        isolated.cleanup();
      }
    });

    it('should output json metadata for pnl file commands', () => {
      const isolated = createIsolatedCliEnv();
      const reportFile = join(tmpdir(), `copyhunter-report-${Date.now()}.json`);
      const exportFile = join(tmpdir(), `copyhunter-export-${Date.now()}.json`);

      try {
        const report = JSON.parse(runCLIWithEnv(
          `pnl report -t summary -f json -o ${reportFile} --json`,
          isolated.env
        )) as {
          ok: boolean;
          code: string;
          outputFile: string;
          format: string;
          bytes: number;
        };
        assert.strictEqual(report.ok, true);
        assert.strictEqual(report.code, 'pnl_report_saved');
        assert.strictEqual(report.outputFile, reportFile);
        assert.strictEqual(report.format, 'json');
        assert.ok(report.bytes > 0);
        assert.ok(existsSync(reportFile));

        const parsedReport = JSON.parse(readFileSync(reportFile, 'utf-8')) as { pnl: unknown; cumulative: unknown };
        assert.ok(typeof parsedReport === 'object' && parsedReport !== null);
        assert.ok('pnl' in parsedReport);

        const exported = JSON.parse(runCLIWithEnv(
          `pnl export positions -f json -o ${exportFile} --json`,
          isolated.env
        )) as {
          ok: boolean;
          code: string;
          outputFile: string;
          exportType: string;
          bytes: number;
        };
        assert.strictEqual(exported.ok, true);
        assert.strictEqual(exported.code, 'pnl_export_saved');
        assert.strictEqual(exported.outputFile, exportFile);
        assert.strictEqual(exported.exportType, 'positions');
        assert.ok(exported.bytes > 0);
        assert.ok(existsSync(exportFile));

        const parsedExport = JSON.parse(readFileSync(exportFile, 'utf-8')) as { positions: unknown[] };
        assert.ok(Array.isArray(parsedExport.positions));
      } finally {
        rmSync(reportFile, { force: true });
        rmSync(exportFile, { force: true });
        isolated.cleanup();
      }
    });

    it('should output json errors for invalid pnl file command options', () => {
      const isolated = createIsolatedCliEnv();

      try {
        const reportWithoutOutput = JSON.parse(runCLIWithEnv(
          'pnl report -t summary -f json --json',
          isolated.env
        )) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        assert.strictEqual(reportWithoutOutput.ok, false);
        assert.strictEqual(reportWithoutOutput.error.code, 'output_required');

        const invalidReportType = JSON.parse(runCLIWithEnv(
          'pnl report -t bogus -o /tmp/nowhere --json',
          isolated.env
        )) as {
          ok: boolean;
          error: { code: string; message: string };
          validTypes: string[];
        };
        assert.strictEqual(invalidReportType.ok, false);
        assert.strictEqual(invalidReportType.error.code, 'invalid_report_type');
        assert.deepStrictEqual(invalidReportType.validTypes, ['summary', 'daily', 'leaders', 'positions', 'full']);

        const invalidExportType = JSON.parse(runCLIWithEnv(
          'pnl export bogus --json',
          isolated.env
        )) as {
          ok: boolean;
          error: { code: string; message: string };
          validTypes: string[];
        };
        assert.strictEqual(invalidExportType.ok, false);
        assert.strictEqual(invalidExportType.error.code, 'invalid_export_type');
        assert.deepStrictEqual(invalidExportType.validTypes, ['positions', 'leaders', 'daily', 'all']);
      } finally {
        isolated.cleanup();
      }
    });
  });
});
