/**
 * CopyHunter - Event Follow Outcome Display Helpers
 */

import { parseStoredFollowOutcomeReason } from './outcome-reason.js';

export interface EventFollowOutcomeLike {
  followed: boolean | number;
  followReason?: string | null;
}

export interface EventFollowDisplay {
  label: 'OK' | 'SKIP' | 'FAIL' | 'PEND';
  color: 'green' | 'cyan' | 'red' | 'gray';
  category: string | null;
  detail: string | null;
}

export interface EventFollowDisplaySummary {
  total: number;
  byState: {
    ok: number;
    skip: number;
    fail: number;
    pend: number;
  };
  byCategory: {
    policy: number;
    risk: number;
    dependency: number;
    runtime: number;
    execution: number;
    uncategorized: number;
  };
  topReasons: Array<{
    state: 'OK' | 'SKIP' | 'FAIL' | 'PEND';
    category: string | null;
    reason: string;
    count: number;
  }>;
}

export function buildEventFollowDisplay(event: EventFollowOutcomeLike): EventFollowDisplay {
  const followed = Boolean(event.followed);
  const followReason = event.followReason?.trim() || null;

  if (followed) {
    return {
      label: 'OK',
      color: 'green',
      category: null,
      detail: followReason,
    };
  }

  if (!followReason) {
    return {
      label: 'PEND',
      color: 'gray',
      category: null,
      detail: null,
    };
  }

  const parsed = parseStoredFollowOutcomeReason(followReason);
  if (parsed.kind && parsed.category) {
    const isSkipped = parsed.kind === 'skipped';
    return {
      label: isSkipped ? 'SKIP' : 'FAIL',
      color: isSkipped ? 'cyan' : 'red',
      category: parsed.category,
      detail: parsed.message ? `${parsed.category}: ${parsed.message}` : parsed.category,
    };
  }

  if (parsed.kind === 'skipped') {
    return {
      label: 'SKIP',
      color: 'cyan',
      category: null,
      detail: parsed.message,
    };
  }

  if (parsed.kind === 'error') {
    return {
      label: 'FAIL',
      color: 'red',
      category: null,
      detail: parsed.message,
    };
  }

  return {
    label: 'PEND',
    color: 'gray',
    category: null,
    detail: followReason,
  };
}

export function summarizeEventFollowDisplays(
  events: EventFollowOutcomeLike[],
  topReasonLimit = 5
): EventFollowDisplaySummary {
  const summary: EventFollowDisplaySummary = {
    total: events.length,
    byState: {
      ok: 0,
      skip: 0,
      fail: 0,
      pend: 0,
    },
    byCategory: {
      policy: 0,
      risk: 0,
      dependency: 0,
      runtime: 0,
      execution: 0,
      uncategorized: 0,
    },
    topReasons: [],
  };
  const reasonCounts = new Map<string, { state: 'OK' | 'SKIP' | 'FAIL' | 'PEND'; category: string | null; reason: string; count: number }>();

  for (const event of events) {
    const display = buildEventFollowDisplay(event);
    switch (display.label) {
      case 'OK':
        summary.byState.ok += 1;
        break;
      case 'SKIP':
        summary.byState.skip += 1;
        break;
      case 'FAIL':
        summary.byState.fail += 1;
        break;
      case 'PEND':
        summary.byState.pend += 1;
        break;
    }

    if ((display.label === 'SKIP' || display.label === 'FAIL') && display.category) {
      const category = display.category as keyof EventFollowDisplaySummary['byCategory'];
      if (summary.byCategory[category] !== undefined) {
        summary.byCategory[category] += 1;
      }
    } else if ((display.label === 'SKIP' || display.label === 'FAIL') && !display.category) {
      summary.byCategory.uncategorized += 1;
    }

    if (display.detail) {
      const key = `${display.label}:${display.category ?? ''}:${display.detail}`;
      const existing = reasonCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        reasonCounts.set(key, {
          state: display.label,
          category: display.category,
          reason: display.detail,
          count: 1,
        });
      }
    }
  }

  summary.topReasons = Array.from(reasonCounts.values())
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.reason.localeCompare(b.reason);
    })
    .slice(0, Math.max(0, topReasonLimit));

  return summary;
}
