/**
 * CopyHunter - Event Emitter
 *
 * Type-safe event emitter for component communication
 */

import { EventEmitter } from 'events';
import type { TradeEvent, Position, Order } from './types.js';
import type { FailureInfo } from './failures.js';

/**
 * Event types and their payloads
 */
export interface CopyHunterEvents {
  // Watch events
  'watch:started': { leadersCount: number };
  'watch:stopped': {};
  'watch:poll': { count: number };
  'watch:healthy': { pollCount: number; lastSuccessfulPollAt: number; consecutiveErrors: number };
  'watch:error': { error: Error; detail?: FailureInfo };

  // Trade events
  'trade:detected': { event: TradeEvent };
  'trade:new': { event: TradeEvent; isNew: boolean };
  'trade:filtered': { event: TradeEvent; reason: string };

  // Follow events
  'follow:started': { mode: 'shadow' | 'live' };
  'follow:stopped': {};
  'follow:evaluating': { event: TradeEvent };
  'follow:executing': { event: TradeEvent; order: Partial<Order> };
  'follow:executed': { event: TradeEvent; order: Order };
  'follow:skipped': { event: TradeEvent; reason: string };
  'follow:error': { event: TradeEvent; error: Error; detail?: FailureInfo };

  // Position events
  'position:opened': { position: Position };
  'position:updated': { position: Position };
  'position:closed': { position: Position; pnl: number };

  // Risk events
  'risk:limit_reached': { type: 'daily' | 'exposure' | 'position'; current: number; limit: number };
  'risk:stop_loss': { position: Position; loss: number };

  // Stats events
  'stats:updated': { address: string; winRate: number; totalPnl: number };
  'stats:batch_updated': { updated: number; errors: number };
  'stats:error': { address: string; error: string };

  // System events
  'system:ready': {};
  'system:shutdown': {};
  'system:error': { error: Error; context?: string };
}

type EventName = keyof CopyHunterEvents;
type EventPayload<T extends EventName> = CopyHunterEvents[T];
type EventHandler<T extends EventName> = (payload: EventPayload<T>) => void;

/**
 * Type-safe event bus for CopyHunter
 */
class CopyHunterEventBus {
  private emitter: EventEmitter;
  private debugMode: boolean;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
    this.debugMode = process.env.DEBUG === 'copyhunter';
  }

  /**
   * Enable/disable debug mode
   */
  setDebug(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Emit an event
   */
  emit<T extends EventName>(event: T, payload: EventPayload<T>): void {
    if (this.debugMode) {
      console.log(`[EventBus] ${event}`, JSON.stringify(payload).slice(0, 200));
    }
    this.emitter.emit(event, payload);
  }

  /**
   * Listen for an event
   */
  on<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.emitter.on(event, handler);
  }

  /**
   * Listen for an event once
   */
  once<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.emitter.once(event, handler);
  }

  /**
   * Remove an event listener
   */
  off<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.emitter.off(event, handler);
  }

  /**
   * Remove all listeners for an event (or all events)
   */
  removeAllListeners(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Get listener count for an event
   */
  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }

  /**
   * Wait for an event (promise-based)
   */
  waitFor<T extends EventName>(
    event: T,
    timeoutMs?: number
  ): Promise<EventPayload<T>> {
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
            this.off(event, handler);
            reject(new Error(`Timeout waiting for event: ${event}`));
          }, timeoutMs)
        : null;

      const handler: EventHandler<T> = (payload) => {
        if (timeout) clearTimeout(timeout);
        resolve(payload);
      };

      this.once(event, handler);
    });
  }
}

// Singleton instance
const eventBus = new CopyHunterEventBus();

export { eventBus, CopyHunterEventBus };
export type { EventName, EventPayload, EventHandler };
