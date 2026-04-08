/**
 * CopyHunter - Follow CLI Ledger Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI_PATH = 'node --import tsx bin/copyhunter.ts';

function assertNearlyEqual(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function createIsolatedCliEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-cli-data-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-cli-runtime-'));

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

function seedFollowLedger(env: NodeJS.ProcessEnv): void {
  const script = `
    const { getOrderRepo, getPositionLotRepo, getPositionRepo, getDailyStatsRepo } = await import('./src/db/index.js');

    const now = Date.now();
    const orderRepo = getOrderRepo();
    const lotRepo = getPositionLotRepo();
    const positionRepo = getPositionRepo();
    const statsRepo = getDailyStatsRepo();

    const executedOrder = await orderRepo.create({
      eventId: 1,
      leaderAddress: 'self',
      platform: 'polymarket',
      orderType: 'market',
      side: 'buy',
      tokenId: 'token-1',
      price: 0.4,
      size: 10,
      amountUsd: 4,
      status: 'pending',
      mode: 'shadow',
      createdAt: now,
    });
    await orderRepo.markExecuted(executedOrder.id, 'shadow-fill-1', 0.41, {
      executedSize: 10,
      executedAmountUsd: 4.1,
      reconcileStatus: 'simulated',
      reconcileReason: 'Shadow mode simulated fill.',
      lastReconciledAt: now,
    });

    await orderRepo.create({
      eventId: 2,
      leaderAddress: 'self',
      platform: 'polymarket',
      orderType: 'market',
      side: 'sell',
      tokenId: 'token-2',
      price: 0.55,
      size: 4,
      amountUsd: 2.2,
      status: 'failed',
      reconcileStatus: 'not_applicable',
      reconcileReason: 'Order failed before fill reconciliation.',
      errorMessage: 'exchange unavailable',
      mode: 'shadow',
      createdAt: now + 1,
    });

    await lotRepo.create({
      leaderAddress: 'self',
      platform: 'polymarket',
      conditionId: 'cond-1',
      marketSlug: 'market-1',
      marketTitle: 'Market 1',
      outcome: 'YES',
      entryQuantity: 10,
      remainingQuantity: 4,
      avgPrice: 0.4,
      costBasis: 4,
      realizedPnl: 1.2,
      status: 'open',
      openedOrderId: executedOrder.id,
      createdAt: now,
      updatedAt: now,
    });

    await lotRepo.create({
      leaderAddress: 'self',
      platform: 'polymarket',
      conditionId: 'cond-1',
      marketSlug: 'market-1',
      marketTitle: 'Market 1',
      outcome: 'YES',
      entryQuantity: 6,
      remainingQuantity: 0,
      avgPrice: 0.3,
      costBasis: 1.8,
      realizedPnl: 0.2,
      status: 'closed',
      openedOrderId: executedOrder.id,
      closedAt: now + 2,
      createdAt: now + 1,
      updatedAt: now + 2,
    });

    await lotRepo.create({
      leaderAddress: 'self',
      platform: 'polymarket',
      conditionId: 'cond-2',
      marketSlug: 'market-2',
      marketTitle: 'Market 2',
      outcome: 'NO',
      entryQuantity: 3,
      remainingQuantity: 3,
      avgPrice: 0.4,
      costBasis: 1.2,
      realizedPnl: 0,
      status: 'open',
      openedOrderId: executedOrder.id,
      createdAt: now + 3,
      updatedAt: now + 3,
    });

    await positionRepo.syncAggregateFromLots({
      leaderAddress: 'self',
      platform: 'polymarket',
      conditionId: 'cond-1',
      outcome: 'YES',
      marketSlug: 'market-1',
      marketTitle: 'Market 1',
    });

    await positionRepo.syncAggregateFromLots({
      leaderAddress: 'self',
      platform: 'polymarket',
      conditionId: 'cond-2',
      outcome: 'NO',
      marketSlug: 'market-2',
      marketTitle: 'Market 2',
    });

    await statsRepo.incrementPositionsOpened(3);
    await statsRepo.incrementPositionsClosed(1);
    await statsRepo.addRealizedPnl(1.4);
    await statsRepo.updateExposure(2.8);
  `;

  execFileSync('node', ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe('Follow CLI Ledger Tests', () => {
  it('should expose lot-backed position summary in follow positions json output', () => {
    const isolated = createIsolatedCliEnv();

    try {
      seedFollowLedger(isolated.env);

      const output = JSON.parse(runCLIWithEnv('follow positions -o json', isolated.env)) as {
        positions: Array<{
          conditionId: string;
          quantity: number;
          realizedPnl: number;
          lotSummary: {
            openLots: number;
            closedLots: number;
            totalLots: number;
          };
        }>;
        summary: {
          returned: number;
          openPositions: number;
          closedPositions: number;
          openLots: number;
          closedLots: number;
          totalLots: number;
          totalExposure: number;
          realizedPnl: number;
        };
      };

      assert.strictEqual(output.summary.returned, 2);
      assert.strictEqual(output.summary.openPositions, 2);
      assert.strictEqual(output.summary.closedPositions, 0);
      assert.strictEqual(output.summary.openLots, 2);
      assert.strictEqual(output.summary.closedLots, 1);
      assert.strictEqual(output.summary.totalLots, 3);
      assertNearlyEqual(output.summary.totalExposure, 2.8);
      assertNearlyEqual(output.summary.realizedPnl, 1.4);

      const primary = output.positions.find((position) => position.conditionId === 'cond-1');
      assert.ok(primary);
      assertNearlyEqual(primary.quantity, 4);
      assertNearlyEqual(primary.realizedPnl, 1.4);
      assert.deepStrictEqual(primary.lotSummary, {
        openLots: 1,
        closedLots: 1,
        totalLots: 2,
      });
    } finally {
      isolated.cleanup();
    }
  });

  it('should expose order execution summary in follow orders json output', () => {
    const isolated = createIsolatedCliEnv();

    try {
      seedFollowLedger(isolated.env);

      const output = JSON.parse(runCLIWithEnv('follow orders -o json', isolated.env)) as {
        orders: Array<{
          status: string;
          txHash: string | null;
          executedPrice: number | null;
          executedSize: number | null;
          executedAmountUsd: number | null;
          reconcileStatus: string;
          reconcileReason: string | null;
          executedAt: number | null;
          errorMessage: string | null;
        }>;
        summary: {
          returned: number;
          requestedAmountUsd: number;
          executedAmountUsd: number;
          byStatus: {
            pending: number;
            executed: number;
            failed: number;
            cancelled: number;
          };
          byReconcileStatus: {
            pending: number;
            notApplicable: number;
            simulated: number;
            estimated: number;
            matched: number;
            drifted: number;
          };
        };
      };

      assert.strictEqual(output.summary.returned, 2);
      assertNearlyEqual(output.summary.requestedAmountUsd, 6.2);
      assertNearlyEqual(output.summary.executedAmountUsd, 4.1);
      assert.deepStrictEqual(output.summary.byStatus, {
        pending: 0,
        executed: 1,
        failed: 1,
        cancelled: 0,
      });
      assert.deepStrictEqual(output.summary.byReconcileStatus, {
        pending: 0,
        notApplicable: 1,
        simulated: 1,
        estimated: 0,
        matched: 0,
        drifted: 0,
      });

      const executed = output.orders.find((order) => order.status === 'executed');
      assert.ok(executed);
      assert.strictEqual(executed.txHash, 'shadow-fill-1');
      assertNearlyEqual(executed.executedPrice!, 0.41);
      assertNearlyEqual(executed.executedSize!, 10);
      assertNearlyEqual(executed.executedAmountUsd!, 4.1);
      assert.strictEqual(executed.reconcileStatus, 'simulated');
      assert.ok(typeof executed.executedAt === 'number');

      const failed = output.orders.find((order) => order.status === 'failed');
      assert.ok(failed);
      assert.strictEqual(failed.errorMessage, 'exchange unavailable');
      assert.strictEqual(failed.reconcileStatus, 'not_applicable');
    } finally {
      isolated.cleanup();
    }
  });

  it('should expose ledger summary in follow status json output', () => {
    const isolated = createIsolatedCliEnv();

    try {
      seedFollowLedger(isolated.env);

      const output = JSON.parse(runCLIWithEnv('follow status -o json', isolated.env)) as {
        stats: {
          positions: number;
          exposure: number;
          orderReconciliation: {
            pending: number;
            notApplicable: number;
            simulated: number;
            estimated: number;
            matched: number;
            drifted: number;
          };
          ledger: {
            openPositions: number;
            closedPositions: number;
            openLots: number;
            closedLots: number;
            totalLots: number;
            totalExposure: number;
            realizedPnl: number;
          };
        };
      };

      assert.strictEqual(output.stats.positions, 2);
      assertNearlyEqual(output.stats.exposure, 2.8);
      assert.deepStrictEqual(output.stats.orderReconciliation, {
        pending: 0,
        notApplicable: 1,
        simulated: 1,
        estimated: 0,
        matched: 0,
        drifted: 0,
      });
      assert.strictEqual(output.stats.ledger.openPositions, 2);
      assert.strictEqual(output.stats.ledger.closedPositions, 0);
      assert.strictEqual(output.stats.ledger.openLots, 2);
      assert.strictEqual(output.stats.ledger.closedLots, 1);
      assert.strictEqual(output.stats.ledger.totalLots, 3);
      assertNearlyEqual(output.stats.ledger.totalExposure, 2.8);
      assertNearlyEqual(output.stats.ledger.realizedPnl, 1.4);
    } finally {
      isolated.cleanup();
    }
  });
});
