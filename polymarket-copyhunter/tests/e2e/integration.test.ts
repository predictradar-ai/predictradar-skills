/**
 * CopyHunter - End-to-End Integration Tests
 *
 * Tests the complete workflow from adding leaders to following trades
 */

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopyHunterEventBus } from '../../src/core/events.js';
import { closeDb } from '../../src/db/index.js';
import { getLeaderRepo } from '../../src/db/repositories/leader-repo.js';
import { getEventRepo } from '../../src/db/repositories/event-repo.js';
import { getPositionRepo } from '../../src/db/repositories/position-repo.js';
import { getDailyStatsRepo } from '../../src/db/repositories/daily-stats-repo.js';

const testDataDir = mkdtempSync(join(tmpdir(), 'copyhunter-e2e-test-'));
process.env.XDG_DATA_HOME = testDataDir;

describe('E2E Integration Tests', () => {
  const eventBus = new CopyHunterEventBus();
  const leaderRepo = getLeaderRepo();
  const eventRepo = getEventRepo();
  const positionRepo = getPositionRepo();
  const dailyStatsRepo = getDailyStatsRepo();

  const testLeader = '0xe2e_test_leader_' + Date.now();

  afterEach(async () => {
    // Cleanup
    await leaderRepo.remove(testLeader);
  });

  after(() => {
    closeDb();
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  describe('Leader Management Flow', () => {
    it('should add, update, and remove a leader', async () => {
      // Add leader
      const leader = await leaderRepo.add({
        address: testLeader,
        alias: 'E2E Test Leader',
        tags: ['test', 'e2e'],
      });

      assert.ok(leader.id);
      assert.strictEqual(leader.address, testLeader.toLowerCase());
      assert.strictEqual(leader.alias, 'E2E Test Leader');

      // Update leader
      const updated = await leaderRepo.update(testLeader, {
        alias: 'Updated Leader',
      });

      assert.strictEqual(updated?.alias, 'Updated Leader');

      // Check exists
      const exists = await leaderRepo.exists(testLeader);
      assert.strictEqual(exists, true);

      // Get by address
      const found = await leaderRepo.getByAddress(testLeader);
      assert.ok(found);
      assert.strictEqual(found.alias, 'Updated Leader');

      // Remove
      const removed = await leaderRepo.remove(testLeader);
      assert.strictEqual(removed, true);

      // Verify removed
      const notFound = await leaderRepo.getByAddress(testLeader);
      assert.strictEqual(notFound, undefined);
    });
  });

  describe('Event Capture Flow', () => {
    it('should save and retrieve trade events', async () => {
      // Add leader first
      await leaderRepo.add({ address: testLeader });

      // Save events
      const event1 = await eventRepo.save({
        leaderAddress: testLeader,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'test-condition-1',
        marketTitle: 'Test Market',
        outcome: 'YES',
        price: 0.55,
        quantity: 100,
        amountUsd: 55,
        timestamp: Date.now(),
        followed: 0,
      });

      const event2 = await eventRepo.save({
        leaderAddress: testLeader,
        platform: 'polymarket',
        eventType: 'BUY',
        conditionId: 'test-condition-2',
        marketTitle: 'Another Market',
        outcome: 'NO',
        price: 0.45,
        quantity: 200,
        amountUsd: 90,
        timestamp: Date.now() + 1000,
        followed: 0,
      });

      // Find events
      const events = await eventRepo.find({ leaderAddress: testLeader });
      assert.strictEqual(events.length, 2);

      // Mark as followed
      await eventRepo.markFollowed(event1.id!, 'shadow mode');

      const followedEvent = await eventRepo.getById(event1.id!);
      assert.strictEqual(followedEvent?.followed, 1);
      assert.strictEqual(followedEvent?.followReason, 'shadow mode');

      // Get unfollowed
      const unfollowed = await eventRepo.getUnfollowed();
      const found = unfollowed.find(e => e.id === event2.id);
      assert.ok(found);
    });
  });

  describe('Position Management Flow', () => {
    it('should create, update, and close positions', async () => {
      await leaderRepo.add({ address: testLeader });

      // Create position
      const position = await positionRepo.upsert({
        leaderAddress: testLeader,
        platform: 'polymarket',
        conditionId: 'test-position-condition',
        marketTitle: 'Position Test Market',
        outcome: 'YES',
        quantity: 100,
        avgPrice: 0.50,
        costBasis: 50,
      });

      assert.ok(position.id);
      assert.strictEqual(position.status, 'open');

      // Update position (add more)
      const updated = await positionRepo.upsert({
        leaderAddress: testLeader,
        platform: 'polymarket',
        conditionId: 'test-position-condition',
        marketTitle: 'Position Test Market',
        outcome: 'YES',
        quantity: 200,
        avgPrice: 0.52,
        costBasis: 104,
      });

      assert.strictEqual(updated.id, position.id); // Same position
      assert.strictEqual(updated.quantity, 200);

      // Get open positions
      const openPositions = await positionRepo.getOpen();
      const found = openPositions.find(p => p.id === position.id);
      assert.ok(found);

      // Calculate exposure
      const exposure = await positionRepo.getTotalExposure();
      assert.ok(exposure >= 104);

      // Close position
      const closed = await positionRepo.close(position.id!, 20);
      assert.strictEqual(closed?.status, 'closed');
      assert.strictEqual(closed?.realizedPnl, 20);

      // Verify closed
      const closedPositions = await positionRepo.find({ status: 'closed' });
      const foundClosed = closedPositions.find(p => p.id === position.id);
      assert.ok(foundClosed);
    });
  });

  describe('Daily Stats Flow', () => {
    it('should track daily statistics', async () => {
      // Get or create today
      const today = await dailyStatsRepo.getOrCreateToday();
      assert.ok(today.id);
      assert.ok(today.date);

      // Increment events captured
      await dailyStatsRepo.incrementEventsCaptured(5);
      await dailyStatsRepo.incrementEventsFollowed(3);
      await dailyStatsRepo.incrementPositionsOpened(2);
      await dailyStatsRepo.addRealizedPnl(25.50);

      // Get updated stats
      const updated = await dailyStatsRepo.getByDate(today.date);
      assert.ok(updated);
      assert.ok(updated.eventsCaptured >= 5);
      assert.ok(updated.eventsFollowed >= 3);
      assert.ok(updated.positionsOpened >= 2);
      assert.ok(updated.realizedPnl >= 25.50);

      // Get cumulative
      const cumulative = await dailyStatsRepo.getCumulative();
      assert.ok(cumulative.totalDays >= 1);
      assert.ok(cumulative.totalEventsCaptured >= 5);
    });
  });

  describe('EventBus Integration', () => {
    it('should coordinate components via events', async () => {
      const receivedEvents: string[] = [];

      // Setup listeners
      eventBus.on('watch:event', (payload) => {
        receivedEvents.push('watch:event');
      });

      eventBus.on('follow:executed', (payload) => {
        receivedEvents.push('follow:executed');
      });

      // Simulate watch finding an event
      eventBus.emit('watch:event', {
        event: {
          leaderAddress: testLeader,
          eventType: 'BUY',
          amountUsd: 100,
        },
      });

      // Simulate follow executing
      eventBus.emit('follow:executed', {
        event: { id: 1 },
        order: { id: 1, status: 'executed' },
      });

      // Verify events received
      assert.ok(receivedEvents.includes('watch:event'));
      assert.ok(receivedEvents.includes('follow:executed'));

      // Cleanup
      eventBus.removeAllListeners();
    });

    it('should support waitFor pattern', async () => {
      const promise = eventBus.waitFor('test:complete', 1000);

      setTimeout(() => {
        eventBus.emit('test:complete', { success: true });
      }, 50);

      const result = await promise;
      assert.strictEqual((result as any).success, true);
    });
  });
});

describe('Workflow Scenarios', () => {
  const leaderRepo = getLeaderRepo();
  const eventRepo = getEventRepo();
  const positionRepo = getPositionRepo();

  const scenarioLeader = '0xscenario_' + Date.now();

  afterEach(async () => {
    await leaderRepo.remove(scenarioLeader);
  });

  it('should simulate complete copy trading workflow', async () => {
    // 1. Add a leader
    await leaderRepo.add({
      address: scenarioLeader,
      alias: 'Top Trader',
    });

    // 2. Capture a trade event
    const tradeEvent = await eventRepo.save({
      leaderAddress: scenarioLeader,
      platform: 'polymarket',
      eventType: 'BUY',
      conditionId: 'election-2024',
      marketTitle: 'Will X win the election?',
      outcome: 'YES',
      price: 0.45,
      quantity: 500,
      amountUsd: 225,
      timestamp: Date.now(),
      followed: 0,
    });

    // 3. Evaluate and follow (shadow mode)
    // In shadow mode, we just mark as followed
    await eventRepo.markFollowed(tradeEvent.id!, 'shadow:evaluated');

    // 4. Track position
    await positionRepo.upsert({
      leaderAddress: scenarioLeader,
      platform: 'polymarket',
      conditionId: 'election-2024',
      marketTitle: 'Will X win the election?',
      outcome: 'YES',
      quantity: 500,
      avgPrice: 0.45,
      costBasis: 225,
    });

    // 5. Simulate price movement and closing
    // Leader sells, price went up
    const sellEvent = await eventRepo.save({
      leaderAddress: scenarioLeader,
      platform: 'polymarket',
      eventType: 'SELL',
      conditionId: 'election-2024',
      outcome: 'YES',
      price: 0.65,
      quantity: 500,
      amountUsd: 325,
      timestamp: Date.now() + 86400000,
      followed: 0,
    });

    await eventRepo.markFollowed(sellEvent.id!, 'shadow:evaluated');

    // 6. Close position with profit
    const positions = await positionRepo.find({
      leaderAddress: scenarioLeader,
      conditionId: 'election-2024',
      status: 'open',
    });

    if (positions.length > 0) {
      const profit = (0.65 - 0.45) * 500; // $100 profit
      await positionRepo.close(positions[0].id!, profit);
    }

    // 7. Verify final state
    const finalPosition = await positionRepo.find({
      leaderAddress: scenarioLeader,
      status: 'closed',
    });

    assert.strictEqual(finalPosition.length, 1);
    assert.strictEqual(finalPosition[0].realizedPnl, 100);

    // 8. Update leader stats
    await leaderRepo.updateStats(scenarioLeader, {
      totalTrades: 2,
      winRate: 100,
      totalPnl: 100,
      lastTradeAt: Date.now(),
    });

    const leader = await leaderRepo.getByAddress(scenarioLeader);
    assert.strictEqual(leader?.totalTrades, 2);
    assert.strictEqual(leader?.totalPnl, 100);
  });
});
