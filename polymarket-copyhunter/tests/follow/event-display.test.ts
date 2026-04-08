/**
 * CopyHunter - Event Follow Display Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildEventFollowDisplay, summarizeEventFollowDisplays } from '../../src/follow/event-display.js';

describe('Event Follow Display Helpers', () => {
  it('should render followed events as OK', () => {
    const display = buildEventFollowDisplay({
      followed: true,
      followReason: 'shadow:order:12',
    });

    assert.strictEqual(display.label, 'OK');
    assert.strictEqual(display.color, 'green');
    assert.strictEqual(display.detail, 'shadow:order:12');
  });

  it('should render skipped events as SKIP', () => {
    const display = buildEventFollowDisplay({
      followed: false,
      followReason: 'skipped:risk: Daily limit would be exceeded',
    });

    assert.strictEqual(display.label, 'SKIP');
    assert.strictEqual(display.color, 'cyan');
    assert.strictEqual(display.category, 'risk');
    assert.strictEqual(display.detail, 'risk: Daily limit would be exceeded');
  });

  it('should render failed events as FAIL', () => {
    const display = buildEventFollowDisplay({
      followed: false,
      followReason: 'error:dependency: wallet unavailable',
    });

    assert.strictEqual(display.label, 'FAIL');
    assert.strictEqual(display.color, 'red');
    assert.strictEqual(display.category, 'dependency');
    assert.strictEqual(display.detail, 'dependency: wallet unavailable');
  });

  it('should render untouched events as PEND', () => {
    const display = buildEventFollowDisplay({
      followed: false,
      followReason: null,
    });

    assert.strictEqual(display.label, 'PEND');
    assert.strictEqual(display.color, 'gray');
    assert.strictEqual(display.detail, null);
  });

  it('should remain backward compatible with legacy skipped/error reasons', () => {
    const skipped = buildEventFollowDisplay({
      followed: false,
      followReason: 'skipped: legacy reason',
    });
    const failed = buildEventFollowDisplay({
      followed: false,
      followReason: 'error: legacy failure',
    });

    assert.strictEqual(skipped.label, 'SKIP');
    assert.strictEqual(skipped.category, null);
    assert.strictEqual(skipped.detail, 'legacy reason');
    assert.strictEqual(failed.label, 'FAIL');
    assert.strictEqual(failed.category, null);
    assert.strictEqual(failed.detail, 'legacy failure');
  });

  it('should summarize recent follow outcomes by state and category', () => {
    const summary = summarizeEventFollowDisplays([
      { followed: true, followReason: 'shadow:order:1' },
      { followed: false, followReason: 'skipped:policy: Leader not in allowlist' },
      { followed: false, followReason: 'skipped:risk: Daily limit would be exceeded' },
      { followed: false, followReason: 'error:dependency: wallet unavailable' },
      { followed: false, followReason: null },
      { followed: false, followReason: 'error: legacy failure' },
    ]);

    assert.deepStrictEqual(summary.byState, {
      ok: 1,
      skip: 2,
      fail: 2,
      pend: 1,
    });
    assert.deepStrictEqual(summary.byCategory, {
      policy: 1,
      risk: 1,
      dependency: 1,
      runtime: 0,
      execution: 0,
      uncategorized: 1,
    });
  });
});
