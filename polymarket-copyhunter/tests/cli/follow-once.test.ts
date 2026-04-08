/**
 * CopyHunter - Follow Once CLI Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = 'node --import tsx bin/copyhunter.ts';
const TEST_LEADER = '0x1111111111111111111111111111111111111111';

function assertNearlyEqual(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function createIsolatedCliEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void; binDir: string } {
  const baseDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-once-'));
  const dataDir = join(baseDir, 'data');
  const runtimeDir = join(baseDir, 'runtime');
  const binDir = join(baseDir, 'bin');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  return {
    env: {
      XDG_DATA_HOME: dataDir,
      COPYHUNTER_RUNTIME_DIR: runtimeDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    binDir,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function installFakePolymarket(binDir: string): void {
  const scriptPath = join(binDir, 'polymarket');
  const nowSec = Math.floor(Date.now() / 1000);
  const script = `#!/bin/sh
mode="\${COPYHUNTER_FAKE_POLY_MODE:-buy}"

if [ "$1" = "data" ] && [ "$2" = "trades" ] && [ "$3" = "${TEST_LEADER}" ]; then
  if [ "$mode" = "sell" ]; then
    cat <<'JSON'
[{"condition_id":"cond-shadow-1","slug":"shadow-market-1","title":"Shadow Market 1","outcome":"YES","side":"sell","price":"0.70","size":"50","transaction_hash":"tx-shadow-sell","timestamp":${nowSec + 10}}]
JSON
  else
    cat <<'JSON'
[{"condition_id":"cond-shadow-1","slug":"shadow-market-1","title":"Shadow Market 1","outcome":"YES","side":"buy","price":"0.42","size":"50","transaction_hash":"tx-shadow-buy","timestamp":${nowSec}}]
JSON
  fi
  exit 0
fi

if [ "$1" = "status" ]; then
  echo '{"ok":true}'
  exit 0
fi

echo '[]'
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
}

function runCLIWithEnv(args: string, env: NodeJS.ProcessEnv): string {
  return execSync(`${CLI_PATH} ${args}`, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
    },
  }).trim();
}

describe('Follow Once CLI Tests', () => {
  it('should preview shadow follow without persisting orders or positions', () => {
    const isolated = createIsolatedCliEnv();
    installFakePolymarket(isolated.binDir);

    try {
      JSON.parse(runCLIWithEnv('follow shadow --max-per-trade 15 --daily-limit 50 -o json', isolated.env));
      JSON.parse(runCLIWithEnv(`leaders add ${TEST_LEADER} --alias Whale1 -o json`, isolated.env));

      const preview = JSON.parse(
        runCLIWithEnv('follow once Whale1 --dry-run -o json', {
          ...isolated.env,
          COPYHUNTER_FAKE_POLY_MODE: 'buy',
        })
      ) as {
        ok: boolean;
        code: string;
        trade: { txHash: string };
        followPlan: {
          mode: string;
          amount: number;
          dryRun: boolean;
        };
      };

      const orders = JSON.parse(runCLIWithEnv('follow orders -o json', isolated.env)) as {
        summary: {
          returned: number;
          byStatus: {
            executed: number;
          };
        };
      };

      const positions = JSON.parse(runCLIWithEnv('follow positions -o json', isolated.env)) as {
        summary: {
          returned: number;
          openPositions: number;
        };
      };

      const status = JSON.parse(runCLIWithEnv('follow status -o json', isolated.env)) as {
        stats: {
          recentEvents: {
            summary: {
              total: number;
            };
          };
          orders: {
            executed: number;
          };
        };
      };

      assert.strictEqual(preview.ok, true);
      assert.strictEqual(preview.code, 'follow_once_preview');
      assert.strictEqual(preview.trade.txHash, 'tx-shadow-buy');
      assert.strictEqual(preview.followPlan.mode, 'shadow');
      assert.strictEqual(preview.followPlan.amount, 15);
      assert.strictEqual(preview.followPlan.dryRun, true);

      assert.strictEqual(orders.summary.returned, 0);
      assert.strictEqual(orders.summary.byStatus.executed, 0);
      assert.strictEqual(positions.summary.returned, 0);
      assert.strictEqual(positions.summary.openPositions, 0);
      assert.strictEqual(status.stats.recentEvents.summary.total, 0);
      assert.strictEqual(status.stats.orders.executed, 0);
    } finally {
      isolated.cleanup();
    }
  });

  it('should execute shadow follow lifecycle from buy to full sell close', () => {
    const isolated = createIsolatedCliEnv();
    installFakePolymarket(isolated.binDir);

    try {
      JSON.parse(runCLIWithEnv('follow shadow --max-per-trade 50 --daily-limit 100 -o json', isolated.env));
      JSON.parse(runCLIWithEnv(`leaders add ${TEST_LEADER} --alias Whale1 -o json`, isolated.env));

      const buy = JSON.parse(
        runCLIWithEnv('follow once Whale1 -o json', {
          ...isolated.env,
          COPYHUNTER_FAKE_POLY_MODE: 'buy',
        })
      ) as {
        ok: boolean;
        code: string;
        order: {
          status: string;
          mode: string;
          reconcileStatus: string;
        };
      };

      const sell = JSON.parse(
        runCLIWithEnv('follow once Whale1 -o json', {
          ...isolated.env,
          COPYHUNTER_FAKE_POLY_MODE: 'sell',
        })
      ) as {
        ok: boolean;
        code: string;
        order: {
          status: string;
          mode: string;
          reconcileStatus: string;
        };
      };

      const positions = JSON.parse(runCLIWithEnv('follow positions --all -o json', isolated.env)) as {
        summary: {
          returned: number;
          openPositions: number;
          closedPositions: number;
          openLots: number;
          closedLots: number;
          totalExposure: number;
          realizedPnl: number;
        };
        positions: Array<{
          status: string;
          quantity: number;
          realizedPnl: number;
          lotSummary: {
            openLots: number;
            closedLots: number;
            totalLots: number;
          };
        }>;
      };

      const orders = JSON.parse(runCLIWithEnv('follow orders -o json', isolated.env)) as {
        summary: {
          returned: number;
          executedAmountUsd: number;
          byStatus: {
            executed: number;
          };
          byReconcileStatus: {
            simulated: number;
          };
        };
      };

      const status = JSON.parse(runCLIWithEnv('follow status -o json', isolated.env)) as {
        mode: string;
        stats: {
          positions: number;
          exposure: number;
          dailySpent: number;
          recentEvents: {
            summary: {
              total: number;
              byState: {
                ok: number;
              };
            };
          };
          ledger: {
            openPositions: number;
            closedPositions: number;
            totalExposure: number;
            realizedPnl: number;
          };
          orderReconciliation: {
            simulated: number;
          };
        };
      };

      assert.strictEqual(buy.ok, true);
      assert.strictEqual(buy.code, 'follow_once_executed');
      assert.strictEqual(buy.order.status, 'executed');
      assert.strictEqual(buy.order.mode, 'shadow');
      assert.strictEqual(buy.order.reconcileStatus, 'simulated');

      assert.strictEqual(sell.ok, true);
      assert.strictEqual(sell.code, 'follow_once_executed');
      assert.strictEqual(sell.order.status, 'executed');
      assert.strictEqual(sell.order.mode, 'shadow');
      assert.strictEqual(sell.order.reconcileStatus, 'simulated');

      assert.strictEqual(positions.summary.returned, 1);
      assert.strictEqual(positions.summary.openPositions, 0);
      assert.strictEqual(positions.summary.closedPositions, 1);
      assert.strictEqual(positions.summary.openLots, 0);
      assert.strictEqual(positions.summary.closedLots, 1);
      assertNearlyEqual(positions.summary.totalExposure, 0);
      assertNearlyEqual(positions.summary.realizedPnl, 14);
      assert.strictEqual(positions.positions[0]?.status, 'closed');
      assertNearlyEqual(positions.positions[0]?.quantity ?? Number.NaN, 0);
      assertNearlyEqual(positions.positions[0]?.realizedPnl ?? Number.NaN, 14);
      assert.deepStrictEqual(positions.positions[0]?.lotSummary, {
        openLots: 0,
        closedLots: 1,
        totalLots: 1,
      });

      assert.strictEqual(orders.summary.returned, 2);
      assertNearlyEqual(orders.summary.executedAmountUsd, 56);
      assert.strictEqual(orders.summary.byStatus.executed, 2);
      assert.strictEqual(orders.summary.byReconcileStatus.simulated, 2);

      assert.strictEqual(status.mode, 'shadow');
      assert.strictEqual(status.stats.positions, 0);
      assertNearlyEqual(status.stats.exposure, 0);
      assertNearlyEqual(status.stats.dailySpent, 21);
      assert.strictEqual(status.stats.recentEvents.summary.total, 2);
      assert.strictEqual(status.stats.recentEvents.summary.byState.ok, 2);
      assert.strictEqual(status.stats.ledger.openPositions, 0);
      assert.strictEqual(status.stats.ledger.closedPositions, 1);
      assertNearlyEqual(status.stats.ledger.totalExposure, 0);
      assertNearlyEqual(status.stats.ledger.realizedPnl, 14);
      assert.strictEqual(status.stats.orderReconciliation.simulated, 2);
    } finally {
      isolated.cleanup();
    }
  });
});
