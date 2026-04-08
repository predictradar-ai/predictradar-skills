/**
 * CopyHunter - Follow Fill Reconciliation Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { reconcileFollowExecution } from '../../src/follow/reconciliation.js';

describe('Follow Fill Reconciliation', () => {
  it('should classify close fills as matched', () => {
    const result = reconcileFollowExecution({
      mode: 'live',
      requestedPrice: 0.5,
      requestedSize: 20,
      requestedAmountUsd: 10,
      executedPrice: 0.5002,
      executedSize: 20.1,
      executedAmountUsd: 10.05402,
    });

    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.reason, null);
    assert.ok(result.metrics.amountDriftUsd < 0.1);
  });

  it('should classify materially different fills as drifted', () => {
    const result = reconcileFollowExecution({
      mode: 'live',
      requestedPrice: 0.5,
      requestedSize: 20,
      requestedAmountUsd: 10,
      executedPrice: 0.62,
      executedSize: 15,
      executedAmountUsd: 9.3,
    });

    assert.strictEqual(result.status, 'drifted');
    assert.ok(result.reason?.includes('size'));
    assert.ok(result.reason?.includes('price'));
    assert.ok(result.metrics.sizeDriftPct > 0.2);
  });

  it('should mark missing live fill fields as estimated', () => {
    const result = reconcileFollowExecution({
      mode: 'live',
      requestedPrice: 0.5,
      requestedSize: 20,
      requestedAmountUsd: 10,
      executedPrice: undefined,
      executedSize: undefined,
      executedAmountUsd: undefined,
    });

    assert.strictEqual(result.status, 'estimated');
    assert.ok(result.reason?.includes('unavailable'));
  });

  it('should mark shadow fills as simulated', () => {
    const result = reconcileFollowExecution({
      mode: 'shadow',
      requestedPrice: 0.5,
      requestedSize: 20,
      requestedAmountUsd: 10,
      executedPrice: 0.5,
      executedSize: 20,
      executedAmountUsd: 10,
    });

    assert.strictEqual(result.status, 'simulated');
    assert.ok(result.reason?.includes('Shadow'));
  });
});
