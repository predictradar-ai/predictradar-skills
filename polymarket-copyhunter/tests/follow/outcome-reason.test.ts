/**
 * CopyHunter - Follow Outcome Reason Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildStoredFollowOutcomeReason,
  classifyFollowErrorCategory,
  classifyFollowSkipCategory,
  parseStoredFollowOutcomeReason,
} from '../../src/follow/outcome-reason.js';

describe('Follow Outcome Reason Helpers', () => {
  it('should build normalized stored reasons', () => {
    assert.strictEqual(
      buildStoredFollowOutcomeReason('skipped', 'risk', 'Daily limit would be exceeded'),
      'skipped:risk: Daily limit would be exceeded'
    );
    assert.strictEqual(
      buildStoredFollowOutcomeReason('error', 'dependency', 'wallet unavailable'),
      'error:dependency: wallet unavailable'
    );
  });

  it('should classify skipped reasons into policy and risk buckets', () => {
    assert.strictEqual(classifyFollowSkipCategory('Leader not in allowlist'), 'policy');
    assert.strictEqual(classifyFollowSkipCategory('Daily limit would be exceeded: $0 + $20 > $10'), 'risk');
    assert.strictEqual(classifyFollowSkipCategory('No open position available to reduce for outcome "YES".'), 'risk');
  });

  it('should classify dependency and runtime follow errors', () => {
    assert.strictEqual(classifyFollowErrorCategory({
      code: 'dependency_unavailable',
      source: 'polymarket_cli',
      operation: 'market_order',
      message: 'wallet unavailable',
      retryable: false,
      occurredAt: 1,
    }), 'dependency');
    assert.strictEqual(classifyFollowErrorCategory({
      code: 'runtime_error',
      source: 'follow_engine',
      operation: 'handle_trade_event',
      message: 'boom',
      retryable: true,
      occurredAt: 1,
    }), 'execution');
  });

  it('should parse normalized and legacy stored reasons', () => {
    assert.deepStrictEqual(
      parseStoredFollowOutcomeReason('skipped:policy: Leader not in allowlist'),
      {
        kind: 'skipped',
        category: 'policy',
        message: 'Leader not in allowlist',
        raw: 'skipped:policy: Leader not in allowlist',
      }
    );
    assert.deepStrictEqual(
      parseStoredFollowOutcomeReason('error: wallet unavailable'),
      {
        kind: 'error',
        category: null,
        message: 'wallet unavailable',
        raw: 'error: wallet unavailable',
      }
    );
  });
});
