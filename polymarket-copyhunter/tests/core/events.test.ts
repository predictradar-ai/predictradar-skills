/**
 * CopyHunter - Event Bus Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CopyHunterEventBus } from '../../src/core/events.js';

describe('EventBus Tests', () => {
  let eventBus: CopyHunterEventBus;

  beforeEach(() => {
    eventBus = new CopyHunterEventBus();
  });

  describe('emit and on', () => {
    it('should emit and receive events', (_, done) => {
      eventBus.on('system:ready', (payload) => {
        assert.deepStrictEqual(payload, {});
        done();
      });

      eventBus.emit('system:ready', {});
    });

    it('should pass payload correctly', (_, done) => {
      const testPayload = { leadersCount: 5 };

      eventBus.on('watch:started', (payload) => {
        assert.strictEqual(payload.leadersCount, 5);
        done();
      });

      eventBus.emit('watch:started', testPayload);
    });
  });

  describe('once', () => {
    it('should only trigger once', () => {
      let callCount = 0;

      eventBus.once('system:ready', () => {
        callCount++;
      });

      eventBus.emit('system:ready', {});
      eventBus.emit('system:ready', {});

      assert.strictEqual(callCount, 1);
    });
  });

  describe('off', () => {
    it('should remove listener', () => {
      let callCount = 0;

      const handler = () => {
        callCount++;
      };

      eventBus.on('system:ready', handler);
      eventBus.emit('system:ready', {});

      eventBus.off('system:ready', handler);
      eventBus.emit('system:ready', {});

      assert.strictEqual(callCount, 1);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for an event', () => {
      let callCount = 0;

      eventBus.on('system:ready', () => callCount++);
      eventBus.on('system:ready', () => callCount++);

      eventBus.removeAllListeners('system:ready');
      eventBus.emit('system:ready', {});

      assert.strictEqual(callCount, 0);
    });

    it('should remove all listeners when no event specified', () => {
      let readyCount = 0;
      let errorCount = 0;

      eventBus.on('system:ready', () => readyCount++);
      eventBus.on('system:error', () => errorCount++);

      eventBus.removeAllListeners();
      eventBus.emit('system:ready', {});
      eventBus.emit('system:error', { error: new Error('test') });

      assert.strictEqual(readyCount, 0);
      assert.strictEqual(errorCount, 0);
    });
  });

  describe('listenerCount', () => {
    it('should return correct count', () => {
      assert.strictEqual(eventBus.listenerCount('system:ready'), 0);

      eventBus.on('system:ready', () => {});
      assert.strictEqual(eventBus.listenerCount('system:ready'), 1);

      eventBus.on('system:ready', () => {});
      assert.strictEqual(eventBus.listenerCount('system:ready'), 2);
    });
  });

  describe('waitFor', () => {
    it('should resolve when event is emitted', async () => {
      const promise = eventBus.waitFor('watch:started');

      // Emit after a small delay
      setTimeout(() => {
        eventBus.emit('watch:started', { leadersCount: 3 });
      }, 10);

      const result = await promise;
      assert.strictEqual(result.leadersCount, 3);
    });

    it('should timeout if event not emitted', async () => {
      await assert.rejects(
        async () => {
          await eventBus.waitFor('watch:started', 50);
        },
        {
          message: /Timeout waiting for event/,
        }
      );
    });
  });

  describe('setDebug', () => {
    it('should not throw when setting debug mode', () => {
      eventBus.setDebug(true);
      eventBus.setDebug(false);
      assert.ok(true);
    });
  });
});
