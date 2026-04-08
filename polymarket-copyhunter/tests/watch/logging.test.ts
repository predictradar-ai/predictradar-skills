import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldLogVerboseWatchRuntimeEvents } from '../../src/watch/logging.js';

describe('Watch Logging Tests', () => {
  it('should keep verbose runtime logs disabled by default', () => {
    assert.strictEqual(shouldLogVerboseWatchRuntimeEvents({}), false);
  });

  it('should enable verbose runtime logs when explicitly requested', () => {
    assert.strictEqual(shouldLogVerboseWatchRuntimeEvents({
      COPYHUNTER_VERBOSE_WATCH_LOGS: '1',
    }), true);
  });
});
