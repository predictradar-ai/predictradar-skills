/**
 * CopyHunter - Follow Outcome Reason Helpers
 */

import type { FailureInfo } from '../core/failures.js';

export type FollowOutcomeKind = 'skipped' | 'error';
export type FollowOutcomeCategory = 'policy' | 'risk' | 'dependency' | 'runtime' | 'execution';

export interface ParsedFollowOutcomeReason {
  kind: FollowOutcomeKind | null;
  category: FollowOutcomeCategory | null;
  message: string | null;
  raw: string | null;
}

export function buildStoredFollowOutcomeReason(
  kind: FollowOutcomeKind,
  category: FollowOutcomeCategory,
  message: string
): string {
  return `${kind}:${category}: ${message}`.trim();
}

export function classifyFollowSkipCategory(reason: string): FollowOutcomeCategory {
  if (
    reason.startsWith('Daily limit would be exceeded')
    || reason.startsWith('Max exposure would be exceeded')
    || reason.startsWith('Max positions reached')
    || reason.startsWith('No open position available to reduce')
  ) {
    return 'risk';
  }

  return 'policy';
}

export function classifyFollowErrorCategory(detail?: FailureInfo | null): FollowOutcomeCategory {
  if (detail?.source === 'polymarket_cli' || detail?.source === 'polymarket_data_api') {
    return 'dependency';
  }

  if (detail?.operation === 'handle_trade_event') {
    return 'execution';
  }

  return 'runtime';
}

export function parseStoredFollowOutcomeReason(reason?: string | null): ParsedFollowOutcomeReason {
  const raw = reason?.trim() || null;
  if (!raw) {
    return {
      kind: null,
      category: null,
      message: null,
      raw: null,
    };
  }

  const normalized = raw.match(/^(skipped|error):(policy|risk|dependency|runtime|execution):\s*(.*)$/i);
  if (normalized) {
    return {
      kind: normalized[1].toLowerCase() as FollowOutcomeKind,
      category: normalized[2].toLowerCase() as FollowOutcomeCategory,
      message: normalized[3] || null,
      raw,
    };
  }

  const legacy = raw.match(/^(skipped|error):\s*(.*)$/i);
  if (legacy) {
    return {
      kind: legacy[1].toLowerCase() as FollowOutcomeKind,
      category: null,
      message: legacy[2] || null,
      raw,
    };
  }

  return {
    kind: null,
    category: null,
    message: raw,
    raw,
  };
}
