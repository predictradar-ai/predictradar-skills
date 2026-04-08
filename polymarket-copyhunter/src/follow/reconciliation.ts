/**
 * CopyHunter - Follow Fill Reconciliation
 */

import type { FollowMode, OrderReconcileStatus } from '../core/types.js';

export interface FollowExecutionSnapshot {
  mode: Extract<FollowMode, 'shadow' | 'live'>;
  requestedPrice: number;
  requestedSize: number;
  requestedAmountUsd: number;
  executedPrice?: number;
  executedSize?: number;
  executedAmountUsd?: number;
}

export interface FollowExecutionReconciliation {
  status: OrderReconcileStatus;
  reason: string | null;
  metrics: {
    priceDriftAbs: number;
    priceDriftPct: number;
    sizeDriftAbs: number;
    sizeDriftPct: number;
    amountDriftUsd: number;
    amountDriftPct: number;
  };
}

const DRIFT_TOLERANCES = {
  priceAbs: 0.01,
  pricePct: 0.02,
  sizePct: 0.02,
  amountUsd: 0.5,
  amountPct: 0.02,
} as const;

function safePct(delta: number, base: number): number {
  if (!Number.isFinite(base) || base === 0) {
    return delta === 0 ? 0 : 1;
  }
  return delta / Math.abs(base);
}

function hasExecutedFillDetails(
  input: FollowExecutionSnapshot
): input is FollowExecutionSnapshot & {
  executedPrice: number;
  executedSize: number;
  executedAmountUsd: number;
} {
  return Number.isFinite(input.executedPrice)
    && Number.isFinite(input.executedSize)
    && Number.isFinite(input.executedAmountUsd);
}

export function reconcileFollowExecution(
  input: FollowExecutionSnapshot
): FollowExecutionReconciliation {
  if (input.mode === 'shadow') {
    return {
      status: 'simulated',
      reason: 'Shadow mode simulated fill.',
      metrics: {
        priceDriftAbs: 0,
        priceDriftPct: 0,
        sizeDriftAbs: 0,
        sizeDriftPct: 0,
        amountDriftUsd: 0,
        amountDriftPct: 0,
      },
    };
  }

  if (!hasExecutedFillDetails(input)) {
    return {
      status: 'estimated',
      reason: 'Executed fill details unavailable; using derived estimates.',
      metrics: {
        priceDriftAbs: 0,
        priceDriftPct: 0,
        sizeDriftAbs: 0,
        sizeDriftPct: 0,
        amountDriftUsd: 0,
        amountDriftPct: 0,
      },
    };
  }

  const { executedPrice, executedSize, executedAmountUsd } = input;
  const priceDriftAbs = Math.abs(executedPrice - input.requestedPrice);
  const priceDriftPct = safePct(priceDriftAbs, input.requestedPrice);
  const sizeDriftAbs = Math.abs(executedSize - input.requestedSize);
  const sizeDriftPct = safePct(sizeDriftAbs, input.requestedSize);
  const amountDriftUsd = Math.abs(executedAmountUsd - input.requestedAmountUsd);
  const amountDriftPct = safePct(amountDriftUsd, input.requestedAmountUsd);

  const reasons: string[] = [];
  if (
    priceDriftAbs > DRIFT_TOLERANCES.priceAbs
    || priceDriftPct > DRIFT_TOLERANCES.pricePct
  ) {
    reasons.push(`price drift ${input.requestedPrice.toFixed(4)} -> ${executedPrice.toFixed(4)}`);
  }
  if (sizeDriftPct > DRIFT_TOLERANCES.sizePct) {
    reasons.push(`size drift ${input.requestedSize.toFixed(4)} -> ${executedSize.toFixed(4)}`);
  }
  if (
    amountDriftUsd > DRIFT_TOLERANCES.amountUsd
    || amountDriftPct > DRIFT_TOLERANCES.amountPct
  ) {
    reasons.push(`amount drift ${input.requestedAmountUsd.toFixed(4)} -> ${executedAmountUsd.toFixed(4)}`);
  }

  return {
    status: reasons.length > 0 ? 'drifted' : 'matched',
    reason: reasons.length > 0 ? reasons.join('; ') : null,
    metrics: {
      priceDriftAbs,
      priceDriftPct,
      sizeDriftAbs,
      sizeDriftPct,
      amountDriftUsd,
      amountDriftPct,
    },
  };
}
