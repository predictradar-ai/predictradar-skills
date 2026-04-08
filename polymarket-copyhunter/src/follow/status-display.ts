/**
 * CopyHunter - Follow Status Display Helpers
 */

import type { FollowMode } from '../core/types.js';
import type { FollowEngineStats } from './engine.js';

export interface FollowDisplayStatus {
  label: 'DISABLED' | 'STOPPED' | 'RUNNING' | 'BUSY' | 'FILTERING' | 'ERROR';
  color: 'gray' | 'green' | 'yellow' | 'cyan' | 'red';
  detail: string | null;
}

export function buildFollowDisplayStatus(input: {
  mode: FollowMode;
  listening: boolean;
  stats: FollowEngineStats;
}): FollowDisplayStatus {
  if (input.mode === 'disabled') {
    return {
      label: 'DISABLED',
      color: 'gray',
      detail: null,
    };
  }

  if (input.stats.lastError) {
    return {
      label: 'ERROR',
      color: 'red',
      detail: input.stats.lastError.message,
    };
  }

  if (input.stats.queueDepth > 0) {
    return {
      label: 'BUSY',
      color: 'yellow',
      detail: `Queue ${input.stats.queueDepth}, peak ${input.stats.maxQueueDepth}`,
    };
  }

  if (input.stats.lastDecisionShouldFollow === false && input.stats.lastDecisionReason) {
    return {
      label: 'FILTERING',
      color: 'cyan',
      detail: input.stats.lastDecisionReason,
    };
  }

  if (input.listening) {
    return {
      label: 'RUNNING',
      color: 'green',
      detail: input.stats.eventsEvaluated > 0
        ? `Eval ${input.stats.eventsEvaluated}, follow ${input.stats.eventsFollowed}, skip ${input.stats.eventsSkipped}`
        : null,
    };
  }

  return {
    label: 'STOPPED',
    color: 'gray',
    detail: input.stats.ordersFailed > 0
      ? `Orders failed ${input.stats.ordersFailed}`
      : null,
  };
}
