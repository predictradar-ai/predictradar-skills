/**
 * CopyHunter - Watch Daemon Launcher
 */

import path from 'path';

export interface WatchDaemonLaunchOptions {
  entryPath: string;
  nodePath?: string;
  interval?: number;
  follow?: boolean;
  runtimeDir?: string;
}

export interface WatchDaemonLaunchSpec {
  command: string;
  args: string[];
}

export function buildWatchDaemonLaunchSpec(
  options: WatchDaemonLaunchOptions
): WatchDaemonLaunchSpec {
  const {
    entryPath,
    nodePath = process.execPath,
    interval,
    follow = false,
    runtimeDir,
  } = options;

  const args: string[] = [];
  const entryExt = path.extname(entryPath);

  if (entryExt === '.ts') {
    args.push('--import', 'tsx');
  }

  args.push(entryPath, 'watch', 'run');

  if (interval !== undefined) {
    args.push('--interval', String(interval));
  }

  if (follow) {
    args.push('--follow');
  }

  if (runtimeDir) {
    args.push('--runtime-dir', runtimeDir);
  }

  return {
    command: nodePath,
    args,
  };
}

export function buildWatchDaemonProcessPattern(runtimeDir?: string): string {
  const basePattern = 'copyhunter.*watch run';
  if (!runtimeDir) {
    return basePattern;
  }

  return `${basePattern}.*--runtime-dir ${escapeRegExp(runtimeDir)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
