/**
 * CopyHunter - Watch Runtime State
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { WatchEngineStats } from './engine.js';
import type { FollowEngineStats } from '../follow/engine.js';
import type { FailureInfo } from '../core/failures.js';
import type { WatchRecoveryState } from './recovery.js';

export interface FollowRuntimeSnapshot {
  listening: boolean;
  mode: 'shadow' | 'live' | 'disabled';
  stats: FollowEngineStats;
}

export interface WatchStatusSnapshot {
  running: boolean;
  pid: number | null;
  startedAt: number;
  updatedAt: number;
  pollIntervalMs: number;
  lastError: string | null;
  lastErrorInfo?: FailureInfo | null;
  consecutiveErrors: number;
  engine: WatchEngineStats;
  follow?: FollowRuntimeSnapshot | null;
  recovery?: WatchRecoveryState | null;
}

export interface WatchRuntimePaths {
  lockFile: string;
  statusFile: string;
}

interface WatchRuntimeStateDeps {
  isProcessRunning?: (pid: number) => boolean;
}

export interface WatchRuntimeStateManager {
  paths: WatchRuntimePaths;
  getRunningPid(): number | null;
  createLockFile(pid: number): void;
  removeLockFile(pid: number): void;
  writeStatus(snapshot: WatchStatusSnapshot): void;
  readStatus(): WatchStatusSnapshot | null;
  removeStatusFile(): void;
  cleanupStaleState(): number | null;
}

export function isWatchStatusStale(
  snapshot: WatchStatusSnapshot | null,
  runningPid: number | null,
  now = Date.now()
): boolean {
  if (!runningPid || !snapshot || snapshot.pid !== runningPid) {
    return !!runningPid;
  }

  const staleAfterMs = Math.max(snapshot.pollIntervalMs * 3, 15_000);
  return now - snapshot.updatedAt > staleAfterMs;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getDefaultWatchRuntimePaths(): WatchRuntimePaths {
  const runtimeDir = process.env.COPYHUNTER_RUNTIME_DIR || os.tmpdir();
  return {
    lockFile: path.join(runtimeDir, 'copyhunter-watch.pid'),
    statusFile: path.join(runtimeDir, 'copyhunter-watch.status.json'),
  };
}

export function createWatchRuntimeStateManager(
  paths: WatchRuntimePaths = getDefaultWatchRuntimePaths(),
  deps: WatchRuntimeStateDeps = {}
): WatchRuntimeStateManager {
  const checkProcess = deps.isProcessRunning ?? isProcessRunning;

  const removeFile = (filePath: string): void => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore errors during cleanup.
    }
  };

  const parsePid = (): number | null => {
    if (!fs.existsSync(paths.lockFile)) {
      return null;
    }

    try {
      const pid = parseInt(fs.readFileSync(paths.lockFile, 'utf-8').trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  };

  return {
    paths,

    getRunningPid(): number | null {
      const pid = parsePid();
      if (pid === null) {
        return null;
      }

      if (checkProcess(pid)) {
        return pid;
      }

      removeFile(paths.lockFile);
      removeFile(paths.statusFile);
      return null;
    },

    createLockFile(pid: number): void {
      fs.writeFileSync(paths.lockFile, pid.toString());
    },

    removeLockFile(pid: number): void {
      const existingPid = parsePid();
      if (existingPid === pid) {
        removeFile(paths.lockFile);
      }
    },

    writeStatus(snapshot: WatchStatusSnapshot): void {
      fs.writeFileSync(paths.statusFile, JSON.stringify(snapshot, null, 2));
    },

    readStatus(): WatchStatusSnapshot | null {
      if (!fs.existsSync(paths.statusFile)) {
        return null;
      }

      try {
        return JSON.parse(fs.readFileSync(paths.statusFile, 'utf-8')) as WatchStatusSnapshot;
      } catch {
        return null;
      }
    },

    removeStatusFile(): void {
      removeFile(paths.statusFile);
    },

    cleanupStaleState(): number | null {
      return this.getRunningPid();
    },
  };
}

let runtimeStateManager: WatchRuntimeStateManager | null = null;

export function getWatchRuntimeStateManager(): WatchRuntimeStateManager {
  if (!runtimeStateManager) {
    runtimeStateManager = createWatchRuntimeStateManager();
  }
  return runtimeStateManager;
}
