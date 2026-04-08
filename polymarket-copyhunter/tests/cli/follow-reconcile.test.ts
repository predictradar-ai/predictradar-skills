/**
 * CopyHunter - Follow Reconcile CLI Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, execSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI_PATH = 'node --import tsx bin/copyhunter.ts';

function createIsolatedCliEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void; dataDir: string; runtimeDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-reconcile-data-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'copyhunter-follow-reconcile-runtime-'));

  return {
    dataDir,
    runtimeDir,
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

function seedReconcileFixture(env: NodeJS.ProcessEnv): number {
  const script = `
    const { getEventRepo, getOrderRepo } = await import('./src/db/index.js');
    const { setConfigValue } = await import('./src/core/config.js');
    const now = Date.now();
    setConfigValue('follow.followerAddress', '0xself-reconcile');

    const event = await getEventRepo().save({
      leaderAddress: '0xleader-cli',
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: 'cond-cli-reconcile',
      marketTitle: 'CLI Reconcile Market',
      outcome: 'YES',
      price: 0.5,
      quantity: 20,
      amountUsd: 10,
      followed: 1,
      createdAt: now,
      timestamp: now,
    });

    const order = await getOrderRepo().create({
      eventId: event.id,
      leaderAddress: event.leaderAddress,
      platform: 'polymarket',
      orderType: 'market',
      side: 'buy',
      tokenId: 'token-cli-reconcile',
      price: 0.5,
      size: 20,
      amountUsd: 10,
      status: 'executed',
      mode: 'live',
      createdAt: now,
    });

    await getOrderRepo().reconcileExecution(order.id, {
      reconcileStatus: 'estimated',
      reconcileReason: 'Executed fill details unavailable; using derived estimates.',
      lastReconciledAt: now,
    });

    console.log(String(now));
  `;

  return Number(execFileSync('node', ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
    },
  }).trim());
}

function installFakePolymarket(now: number): string {
  const binDir = mkdtempSync(join(tmpdir(), 'copyhunter-fake-poly-'));
  const scriptPath = join(binDir, 'polymarket');
  const script = `#!/bin/sh
if [ "$1" = "data" ] && [ "$2" = "trades" ] && [ "$3" = "0xself-reconcile" ]; then
  cat <<'JSON'
[{"condition_id":"cond-cli-reconcile","slug":"cli-reconcile-market","title":"CLI Reconcile Market","outcome":"YES","side":"BUY","price":"0.5001","size":"20.02","transaction_hash":"tx-cli-reconcile","timestamp":${Math.floor(now / 1000)}}]
JSON
  exit 0
fi
echo "[]"
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return binDir;
}

describe('Follow Reconcile CLI Tests', () => {
  it('should reconcile live follow orders via CLI and return json summary', () => {
    const isolated = createIsolatedCliEnv();

    try {
      const now = seedReconcileFixture(isolated.env);
      const fakeBinDir = installFakePolymarket(now);

      const output = JSON.parse(runCLIWithEnv(
        'follow reconcile --hours 1 --limit 20 -o json',
        {
          ...isolated.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        }
      )) as {
        ok: boolean;
        code: string;
        followerAddress: string;
        summary: {
          scannedOrders: number;
          matched: number;
          drifted: number;
        };
        orders: Array<{
          status: string;
          txHash: string | null;
        }>;
      };

      assert.strictEqual(output.ok, true);
      assert.strictEqual(output.code, 'follow_reconciled');
      assert.strictEqual(output.followerAddress, '0xself-reconcile');
      assert.strictEqual(output.summary.scannedOrders, 1);
      assert.strictEqual(output.summary.matched, 1);
      assert.strictEqual(output.summary.drifted, 0);
      assert.strictEqual(output.orders[0].status, 'matched');
      assert.strictEqual(output.orders[0].txHash, 'tx-cli-reconcile');
    } finally {
      isolated.cleanup();
    }
  });
});
