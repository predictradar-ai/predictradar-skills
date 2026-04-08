/**
 * CopyHunter - Follow Order Reconciliation
 */

import { getConfig } from '../core/config.js';
import type { TradeEvent } from '../core/types.js';
import { getEventRepo, getOrderRepo } from '../db/index.js';
import { getPolymarketCLI } from '../platforms/polymarket/index.js';
import { reconcileFollowExecution } from './reconciliation.js';

interface ReconcileableOrderContext {
  id: number;
  eventId: number;
  side: 'buy' | 'sell';
  amountUsd: number;
  price: number | null;
  size: number;
  txHash: string | null;
  createdAt: number;
  executedAt: number | null;
  reconcileStatus: string;
}

export interface FollowReconcileSummary {
  scannedOrders: number;
  reconciledOrders: number;
  matched: number;
  drifted: number;
  estimated: number;
  pending: number;
  notFound: number;
}

export interface FollowReconcileResultItem {
  orderId: number;
  eventId: number;
  status: 'matched' | 'drifted' | 'estimated' | 'pending';
  reason: string | null;
  txHash: string | null;
  executedPrice: number | null;
  executedSize: number | null;
  executedAmountUsd: number | null;
}

export interface FollowReconcileResult {
  followerAddress: string;
  window: {
    fromTimestamp: number;
    toTimestamp: number;
    limit: number;
  };
  summary: FollowReconcileSummary;
  orders: FollowReconcileResultItem[];
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function isTradeMatchCandidate(orderEvent: {
  conditionId: string;
  outcome: string | null;
  eventType: string;
}, trade: TradeEvent): boolean {
  return trade.conditionId === orderEvent.conditionId
    && (trade.outcome ?? null) === (orderEvent.outcome ?? null)
    && trade.eventType.toUpperCase() === orderEvent.eventType.toUpperCase();
}

function scoreTradeCandidate(params: {
  requestedAmountUsd: number;
  requestedSize: number;
  orderTimestamp: number;
  trade: TradeEvent;
}): number {
  const amountDiff = Math.abs(params.trade.amountUsd - params.requestedAmountUsd);
  const sizeDiff = Math.abs(params.trade.quantity - params.requestedSize);
  const timeDiffMs = Math.abs(params.trade.timestamp - params.orderTimestamp);
  return (amountDiff * 100) + (sizeDiff * 10) + (timeDiffMs / 1000);
}

function findBestTradeMatch(
  order: ReconcileableOrderContext,
  event: {
    conditionId: string;
    outcome: string | null;
    eventType: string;
  },
  trades: TradeEvent[]
): TradeEvent | undefined {
  const exactTx = order.txHash
    ? trades.find((trade) => trade.txHash?.toLowerCase() === order.txHash?.toLowerCase())
    : undefined;
  if (exactTx && isTradeMatchCandidate(event, exactTx)) {
    return exactTx;
  }

  const orderTimestamp = order.executedAt ?? order.createdAt;
  const candidates = trades.filter((trade) => isTradeMatchCandidate(event, trade));
  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort((a, b) => {
    const scoreA = scoreTradeCandidate({
      requestedAmountUsd: order.amountUsd,
      requestedSize: order.size,
      orderTimestamp,
      trade: a,
    });
    const scoreB = scoreTradeCandidate({
      requestedAmountUsd: order.amountUsd,
      requestedSize: order.size,
      orderTimestamp,
      trade: b,
    });
    return scoreA - scoreB;
  })[0];
}

export async function reconcileFollowOrders(params?: {
  followerAddress?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
}): Promise<FollowReconcileResult> {
  const config = getConfig();
  const followerAddress = normalizeAddress(params?.followerAddress || config.follow.followerAddress || '');
  if (!followerAddress) {
    throw new Error('follow.followerAddress is not configured.');
  }

  const toTimestamp = params?.toTimestamp ?? Date.now();
  const fromTimestamp = params?.fromTimestamp ?? (toTimestamp - (24 * 60 * 60 * 1000));
  const limit = params?.limit ?? 200;

  const orderRepo = getOrderRepo();
  const eventRepo = getEventRepo();
  const cli = getPolymarketCLI();

  const orders = (await orderRepo.find({
    status: 'executed',
    mode: 'live',
    fromTimestamp,
  }, limit)) as ReconcileableOrderContext[];
  const relevantOrders = orders.filter((order) =>
    order.createdAt <= toTimestamp
    && order.createdAt >= fromTimestamp
    && ['pending', 'estimated', 'drifted'].includes(order.reconcileStatus)
  );
  const events = await eventRepo.getByIds(relevantOrders.map((order) => order.eventId));
  const eventById = new Map(events.map((event) => [event.id, event]));
  const trades = (await cli.getTrades(followerAddress, limit)).filter((trade) =>
    trade.timestamp >= fromTimestamp && trade.timestamp <= toTimestamp
  );

  const summary: FollowReconcileSummary = {
    scannedOrders: relevantOrders.length,
    reconciledOrders: 0,
    matched: 0,
    drifted: 0,
    estimated: 0,
    pending: 0,
    notFound: 0,
  };
  const results: FollowReconcileResultItem[] = [];

  for (const order of relevantOrders) {
    const event = eventById.get(order.eventId);
    if (!event) {
      continue;
    }

    const matchedTrade = findBestTradeMatch(order, {
      conditionId: event.conditionId,
      outcome: event.outcome ?? null,
      eventType: event.eventType,
    }, trades);

    if (!matchedTrade) {
      await orderRepo.reconcileExecution(order.id, {
        txHash: order.txHash ?? undefined,
        executedPrice: order.price ?? undefined,
        executedSize: order.size,
        executedAmountUsd: order.amountUsd,
        reconcileStatus: 'pending',
        reconcileReason: 'No matching follower trade found in reconciliation window.',
        lastReconciledAt: Date.now(),
      });
      summary.pending += 1;
      summary.notFound += 1;
      summary.reconciledOrders += 1;
      results.push({
        orderId: order.id,
        eventId: order.eventId,
        status: 'pending',
        reason: 'No matching follower trade found in reconciliation window.',
        txHash: order.txHash,
        executedPrice: order.price,
        executedSize: order.size,
        executedAmountUsd: order.amountUsd,
      });
      continue;
    }

    const fillReconciliation = reconcileFollowExecution({
      mode: 'live',
      requestedPrice: event.price,
      requestedSize: order.size,
      requestedAmountUsd: order.amountUsd,
      executedPrice: matchedTrade.price,
      executedSize: matchedTrade.quantity,
      executedAmountUsd: matchedTrade.amountUsd,
    });

    await orderRepo.reconcileExecution(order.id, {
      txHash: matchedTrade.txHash ?? order.txHash ?? undefined,
      executedPrice: matchedTrade.price,
      executedSize: matchedTrade.quantity,
      executedAmountUsd: matchedTrade.amountUsd,
      reconcileStatus: fillReconciliation.status,
      reconcileReason: fillReconciliation.reason,
      lastReconciledAt: Date.now(),
    });

    summary.reconciledOrders += 1;
    if (fillReconciliation.status === 'matched') {
      summary.matched += 1;
    } else if (fillReconciliation.status === 'drifted') {
      summary.drifted += 1;
    } else if (fillReconciliation.status === 'estimated') {
      summary.estimated += 1;
    } else if (fillReconciliation.status === 'pending') {
      summary.pending += 1;
    }

    results.push({
      orderId: order.id,
      eventId: order.eventId,
      status: fillReconciliation.status as 'matched' | 'drifted' | 'estimated' | 'pending',
      reason: fillReconciliation.reason,
      txHash: matchedTrade.txHash ?? null,
      executedPrice: matchedTrade.price,
      executedSize: matchedTrade.quantity,
      executedAmountUsd: matchedTrade.amountUsd,
    });
  }

  return {
    followerAddress,
    window: {
      fromTimestamp,
      toTimestamp,
      limit,
    },
    summary,
    orders: results,
  };
}
