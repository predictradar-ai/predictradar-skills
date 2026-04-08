/**
 * CopyHunter - Watch Module Exports
 */

export { WatchEngine, getWatchEngine, type WatchEngineOptions, type WatchEngineStats } from './engine.js';
export {
  buildWatchDaemonLaunchSpec,
  buildWatchDaemonProcessPattern,
  type WatchDaemonLaunchOptions,
  type WatchDaemonLaunchSpec,
} from './launcher.js';
export {
  createWatchRuntimeStateManager,
  getWatchRuntimeStateManager,
  getDefaultWatchRuntimePaths,
  isWatchStatusStale,
  type WatchRuntimeStateManager,
  type WatchRuntimePaths,
  type WatchStatusSnapshot,
} from './runtime-state.js';
export {
  calculateWatchBackoffMs,
  createInitialWatchRecoveryState,
  shouldScheduleDependencyRecovery,
  type DependencyHealthSnapshot,
  type WatchRecoveryState,
} from './recovery.js';
export {
  buildWatchDisplayStatus,
  collectUnhealthyDependencies,
  formatUnhealthyDependencySummary,
  resolveActiveWatchSnapshot,
  type WatchDisplayStatus,
} from './status-display.js';
export {
  buildReconciliationTradeKey,
  normalizeReconciliationTrade,
  reconcileTradeSets,
  resolveReconciliationComparisonWindow,
  summarizeReconciliationTradeWindow,
  type ReconciliationComparisonWindow,
  type ReconciliationResult,
  type ReconciliationSummary,
  type ReconciliationTrade,
  type ReconciliationTradeWindow,
} from './reconciliation.js';
