/**
 * CopyHunter - Watch Launcher Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildWatchDaemonLaunchSpec, buildWatchDaemonProcessPattern } from '../../src/watch/launcher.js';

describe('Watch Launcher Tests', () => {
  it('should build a tsx launch spec for TypeScript entrypoints', () => {
    const spec = buildWatchDaemonLaunchSpec({
      entryPath: '/tmp/copyhunter/bin/copyhunter.ts',
      nodePath: '/usr/local/bin/node',
      interval: 15000,
      follow: true,
      runtimeDir: '/tmp/copyhunter-runtime',
    });

    assert.strictEqual(spec.command, '/usr/local/bin/node');
    assert.deepStrictEqual(spec.args, [
      '--import',
      'tsx',
      '/tmp/copyhunter/bin/copyhunter.ts',
      'watch',
      'run',
      '--interval',
      '15000',
      '--follow',
      '--runtime-dir',
      '/tmp/copyhunter-runtime',
    ]);
  });

  it('should build a node launch spec for JavaScript entrypoints', () => {
    const spec = buildWatchDaemonLaunchSpec({
      entryPath: '/tmp/copyhunter/dist/bin/copyhunter.js',
      nodePath: '/usr/local/bin/node',
    });

    assert.strictEqual(spec.command, '/usr/local/bin/node');
    assert.deepStrictEqual(spec.args, [
      '/tmp/copyhunter/dist/bin/copyhunter.js',
      'watch',
      'run',
    ]);
  });

  it('should build a runtime-scoped process pattern', () => {
    assert.strictEqual(
      buildWatchDaemonProcessPattern('/tmp/copyhunter-runtime.1'),
      'copyhunter.*watch run.*--runtime-dir /tmp/copyhunter-runtime\\.1'
    );
    assert.strictEqual(buildWatchDaemonProcessPattern(), 'copyhunter.*watch run');
  });
});
