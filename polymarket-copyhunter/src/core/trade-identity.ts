import type { TradeEvent } from './types.js';

export type TradeIdentityLike = Pick<
  TradeEvent,
  'leaderAddress' | 'conditionId' | 'eventType' | 'outcome' | 'timestamp' | 'price' | 'quantity' | 'txHash'
>;

export function getTradeIdentityKey(trade: TradeIdentityLike): string {
  return [
    trade.leaderAddress.toLowerCase(),
    trade.conditionId,
    trade.eventType,
    trade.outcome ?? '',
    trade.timestamp,
    trade.price.toFixed(6),
    trade.quantity.toFixed(6),
    trade.txHash?.toLowerCase() ?? '',
  ].join(':');
}
