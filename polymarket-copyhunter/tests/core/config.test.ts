/**
 * CopyHunter - Config Tests
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirs: string[] = [];

function createTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copyhunter-config-test-'));
  tempDirs.push(dir);
  return dir;
}

async function importFreshConfigModule() {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/core/config.ts')).href;
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  delete process.env.XDG_DATA_HOME;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Config Tests', () => {
  it('should persist zero-valued nested config updates to disk', async () => {
    const dataDir = createTempDataDir();
    process.env.XDG_DATA_HOME = dataDir;

    const config = await importFreshConfigModule();

    config.setConfigValue('watch.filterMinUsd', 0);

    assert.strictEqual(config.getConfig().watch.filterMinUsd, 0);
    assert.strictEqual(config.getConfigValue('watch.filterMinUsd'), 0);

    const persistedConfig = JSON.parse(readFileSync(config.getConfigPath(), 'utf8')) as {
      watch: { filterMinUsd: number };
    };

    assert.strictEqual(persistedConfig.watch.filterMinUsd, 0);
  });

  it('should persist repeated risk config updates after prior nested writes', async () => {
    const dataDir = createTempDataDir();
    process.env.XDG_DATA_HOME = dataDir;

    const config = await importFreshConfigModule();

    config.setConfigValue('follow.dailyLimit', 1000000);
    config.setConfigValue('watch.filterMinUsd', 1);
    config.setConfigValue('risk.maxExposure', 250000);
    config.setConfigValue('risk.maxPositions', 5000);

    const current = config.getConfig();
    assert.strictEqual(current.follow.dailyLimit, 1000000);
    assert.strictEqual(current.watch.filterMinUsd, 1);
    assert.strictEqual(current.risk.maxExposure, 250000);
    assert.strictEqual(current.risk.maxPositions, 5000);

    const persistedConfig = JSON.parse(readFileSync(config.getConfigPath(), 'utf8')) as {
      follow: { dailyLimit: number };
      watch: { filterMinUsd: number };
      risk: { maxExposure: number; maxPositions: number };
    };

    assert.strictEqual(persistedConfig.follow.dailyLimit, 1000000);
    assert.strictEqual(persistedConfig.watch.filterMinUsd, 1);
    assert.strictEqual(persistedConfig.risk.maxExposure, 250000);
    assert.strictEqual(persistedConfig.risk.maxPositions, 5000);
  });

  it('should persist clearing follow allowlist after setting a non-empty array', async () => {
    const dataDir = createTempDataDir();
    process.env.XDG_DATA_HOME = dataDir;

    const config = await importFreshConfigModule();

    config.setConfigValue('follow.allowlist', ['0x0000000000000000000000000000000000000001']);
    config.setConfigValue('follow.allowlist', []);

    assert.deepStrictEqual(config.getConfig().follow.allowlist, []);
    assert.deepStrictEqual(config.getConfigValue('follow.allowlist'), []);

    const persistedConfig = JSON.parse(readFileSync(config.getConfigPath(), 'utf8')) as {
      follow?: { allowlist?: string[] };
    };

    assert.deepStrictEqual(persistedConfig.follow?.allowlist ?? [], []);
  });
});
