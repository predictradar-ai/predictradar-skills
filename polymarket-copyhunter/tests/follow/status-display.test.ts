/**
 * CopyHunter - Follow Status Display Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildFollowDisplayStatus } from '../../src/follow/status-display.js';
import type { FollowEngineStats } from '../../src/follow/engine.js';

function createStats(overrides: Partial<FollowEngineStats> = {}): FollowEngineStats {
  return {
    eventsEnqueued: 0,
    eventsEvaluated: 0,
    eventsFollowed: 0,
    eventsSkipped: 0,
    ordersExecuted: 0,
    ordersFailed: 0,
    totalAmountUsd: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    lastEvaluatedAt: null,
    lastDecisionAt: null,
    lastDecisionReason: null,
    lastDecisionShouldFollow: null,
    lastExecutedAt: null,
    lastSkippedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('Follow Status Display Helpers', () => {
  it('should mark disabled mode as disabled', () => {
    const display = buildFollowDisplayStatus({
      mode: 'disabled',
      listening: false,
      stats: createStats(),
    });

    assert.strictEqual(display.label, 'DISABLED');
    assert.strictEqual(display.color, 'gray');
    assert.strictEqual(display.detail, null);
  });

  it('should prioritize follow execution errors', () => {
    const display = buildFollowDisplayStatus({
      mode: 'shadow',
      listening: true,
      stats: createStats({
        lastError: {
          code: 'dependency_timeout',
          source: 'polymarket_cli',
          operation: 'market_order',
          message: 'order timed out',
          retryable: true,
          occurredAt: 1_700_000_000_000,
        },
      }),
    });

    assert.strictEqual(display.label, 'ERROR');
    assert.strictEqual(display.color, 'red');
    assert.strictEqual(display.detail, 'order timed out');
  });

  it('should mark queued work as busy', () => {
    const display = buildFollowDisplayStatus({
      mode: 'shadow',
      listening: true,
      stats: createStats({
        queueDepth: 3,
        maxQueueDepth: 5,
      }),
    });

    assert.strictEqual(display.label, 'BUSY');
    assert.strictEqual(display.color, 'yellow');
    assert.match(display.detail ?? '', /Queue 3, peak 5/);
  });

  it('should mark rejected decisions as filtering', () => {
    const display = buildFollowDisplayStatus({
      mode: 'shadow',
      listening: true,
      stats: createStats({
        lastDecisionShouldFollow: false,
        lastDecisionReason: 'Daily limit would be exceeded',
      }),
    });

    assert.strictEqual(display.label, 'FILTERING');
    assert.strictEqual(display.color, 'cyan');
    assert.strictEqual(display.detail, 'Daily limit would be exceeded');
  });
});
