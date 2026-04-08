/**
 * CopyHunter - Watch Reconciliation
 */

import type { TradeEvent } from '../core/types.js';
import type { EventRow } from '../db/schema.js';

export interface ReconciliationTrade {
  leaderAddress: string;
  eventType: string;
  conditionId: string;
  outcome: string | null;
  price: number;
  quantity: number;
  amountUsd: number;
  timestamp: number;
  txHash: string | null;
  marketTitle: string | null;
  marketSlug: string | null;
}

export interface ReconciliationSummary {
  apiTrades: number;
  localTrades: number;
  matchedTrades: number;
  missingInLocal: number;
  localOnly: number;
  coveragePct: number;
}

export interface ReconciliationResult {
  summary: ReconciliationSummary;
  missingInLocal: ReconciliationTrade[];
  localOnly: ReconciliationTrade[];
}

export interface ReconciliationTradeWindow {
  count: number;
  latestTimestamp: number | null;
  oldestTimestamp: number | null;
}

export interface ReconciliationComparisonWindow {
  fromTimestamp: number;
  toTimestamp: number;
  hasOverlap: boolean;
}

export interface RequestedReconciliationWindow {
  fromTimestamp: number;
  toTimestamp: number;
  hours: number | null;
  lookbackMs: number;
}

const LOOKBACK_DURATION_PATTERN = /^(\d+)\s*([mhd])$/i;

function roundMetric(value: number, digits = 6): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function normalizeTimestamp(timestamp: number): number {
  return Math.floor(timestamp / 1000);
}

export function parseReconciliationLookback(value: string, label = 'window'): number {
  const trimmed = value.trim();
  const match = LOOKBACK_DURATION_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`${label} must use a duration like 10m, 30m, 2h, or 1d.`);
  }

  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive duration like 10m or 2h.`);
  }

  const unit = match[2]!.toLowerCase();
  const multiplier = unit === 'm'
    ? 60_000
    : unit === 'h'
      ? 60 * 60_000
      : 24 * 60 * 60_000;

  return amount * multiplier;
}

export function resolveRequestedReconciliationWindow(input: {
  fromTimestamp?: number;
  toTimestamp?: number;
  hours?: number;
  lookbackMs?: number;
  now?: number;
}): RequestedReconciliationWindow {
  const toTimestamp = input.toTimestamp ?? input.now ?? Date.now();

  if (input.lookbackMs !== undefined) {
    return {
      fromTimestamp: toTimestamp - input.lookbackMs,
      toTimestamp,
      hours: null,
      lookbackMs: input.lookbackMs,
    };
  }

  const hours = input.hours ?? 24;
  const fromTimestamp = input.fromTimestamp ?? toTimestamp - (hours * 60 * 60 * 1000);

  return {
    fromTimestamp,
    toTimestamp,
    hours,
    lookbackMs: toTimestamp - fromTimestamp,
  };
}

export function normalizeReconciliationTrade(
  trade: TradeEvent | EventRow
): ReconciliationTrade {
  return {
    leaderAddress: trade.leaderAddress.toLowerCase(),
    eventType: trade.eventType.toUpperCase(),
    conditionId: trade.conditionId,
    outcome: trade.outcome ?? null,
    price: trade.price,
    quantity: trade.quantity,
    amountUsd: trade.amountUsd,
    timestamp: trade.timestamp,
    txHash: trade.txHash?.toLowerCase() ?? null,
    marketTitle: trade.marketTitle ?? null,
    marketSlug: trade.marketSlug ?? null,
  };
}

export function buildReconciliationTradeKey(trade: ReconciliationTrade): string {
  const timestampKey = normalizeTimestamp(trade.timestamp);
  const outcomeKey = (trade.outcome ?? 'unknown').toUpperCase();
  const eventTypeKey = trade.eventType.toUpperCase();
  const txHashKey = trade.txHash?.toLowerCase() ?? null;

  if (txHashKey) {
    return [
      'tx',
      txHashKey,
      trade.conditionId,
      eventTypeKey,
      outcomeKey,
      roundMetric(trade.price),
      roundMetric(trade.quantity),
    ].join('|');
  }

  return [
    'fill',
    trade.leaderAddress.toLowerCase(),
    trade.conditionId,
    eventTypeKey,
    outcomeKey,
    roundMetric(trade.price),
    roundMetric(trade.quantity),
    roundMetric(trade.amountUsd),
    String(timestampKey),
  ].join('|');
}

export function summarizeReconciliationTradeWindow(
  trades: Array<TradeEvent | EventRow>
): ReconciliationTradeWindow {
  if (trades.length === 0) {
    return {
      count: 0,
      latestTimestamp: null,
      oldestTimestamp: null,
    };
  }

  let latestTimestamp = trades[0]!.timestamp;
  let oldestTimestamp = trades[0]!.timestamp;

  for (const trade of trades) {
    if (trade.timestamp > latestTimestamp) {
      latestTimestamp = trade.timestamp;
    }
    if (trade.timestamp < oldestTimestamp) {
      oldestTimestamp = trade.timestamp;
    }
  }

  return {
    count: trades.length,
    latestTimestamp,
    oldestTimestamp,
  };
}

export function resolveReconciliationComparisonWindow(input: {
  requestedFromTimestamp: number;
  requestedToTimestamp: number;
  apiTrades: Array<TradeEvent | EventRow>;
  localTrades: Array<TradeEvent | EventRow>;
}): ReconciliationComparisonWindow {
  const apiWindow = summarizeReconciliationTradeWindow(input.apiTrades);
  const localWindow = summarizeReconciliationTradeWindow(input.localTrades);

  const fromTimestamp = Math.max(
    input.requestedFromTimestamp,
    apiWindow.oldestTimestamp ?? input.requestedFromTimestamp,
    localWindow.oldestTimestamp ?? input.requestedFromTimestamp
  );
  const toTimestamp = Math.min(
    input.requestedToTimestamp,
    apiWindow.latestTimestamp ?? input.requestedToTimestamp,
    localWindow.latestTimestamp ?? input.requestedToTimestamp
  );

  return {
    fromTimestamp,
    toTimestamp,
    hasOverlap: apiWindow.count > 0 && localWindow.count > 0 && fromTimestamp <= toTimestamp,
  };
}

export function resolveIncrementalReconciliationComparisonWindow(input: {
  apiTrades: Array<TradeEvent | EventRow>;
  localTrades: Array<TradeEvent | EventRow>;
}): ReconciliationComparisonWindow {
  const apiWindow = summarizeReconciliationTradeWindow(input.apiTrades);
  const localWindow = summarizeReconciliationTradeWindow(input.localTrades);

  const requestedFromTimestamp = Math.min(
    apiWindow.oldestTimestamp ?? Number.MAX_SAFE_INTEGER,
    localWindow.oldestTimestamp ?? Number.MAX_SAFE_INTEGER
  );
  const requestedToTimestamp = Math.max(
    apiWindow.latestTimestamp ?? Number.MIN_SAFE_INTEGER,
    localWindow.latestTimestamp ?? Number.MIN_SAFE_INTEGER
  );

  if (!Number.isFinite(requestedFromTimestamp) || !Number.isFinite(requestedToTimestamp)) {
    return {
      fromTimestamp: 0,
      toTimestamp: 0,
      hasOverlap: false,
    };
  }

  return resolveReconciliationComparisonWindow({
    requestedFromTimestamp,
    requestedToTimestamp,
    apiTrades: input.apiTrades,
    localTrades: input.localTrades,
  });
}

function groupTradesByKey(trades: ReconciliationTrade[]): Map<string, ReconciliationTrade[]> {
  const grouped = new Map<string, ReconciliationTrade[]>();

  for (const trade of trades) {
    const key = buildReconciliationTradeKey(trade);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(trade);
      continue;
    }
    grouped.set(key, [trade]);
  }

  return grouped;
}

export function reconcileTradeSets(input: {
  apiTrades: Array<TradeEvent | EventRow>;
  localTrades: Array<TradeEvent | EventRow>;
}): ReconciliationResult {
  const apiTrades = input.apiTrades.map(normalizeReconciliationTrade);
  const localTrades = input.localTrades.map(normalizeReconciliationTrade);
  const apiMap = groupTradesByKey(apiTrades);
  const localMap = groupTradesByKey(localTrades);

  const missingInLocal: ReconciliationTrade[] = [];
  const localOnly: ReconciliationTrade[] = [];
  let matchedTrades = 0;

  const allKeys = new Set([...apiMap.keys(), ...localMap.keys()]);
  for (const key of allKeys) {
    const apiBucket = [...(apiMap.get(key) ?? [])];
    const localBucket = [...(localMap.get(key) ?? [])];
    const matched = Math.min(apiBucket.length, localBucket.length);
    matchedTrades += matched;

    if (apiBucket.length > matched) {
      missingInLocal.push(...apiBucket.slice(matched));
    }
    if (localBucket.length > matched) {
      localOnly.push(...localBucket.slice(matched));
    }
  }

  return {
    summary: {
      apiTrades: apiTrades.length,
      localTrades: localTrades.length,
      matchedTrades,
      missingInLocal: missingInLocal.length,
      localOnly: localOnly.length,
      coveragePct: apiTrades.length === 0 ? 100 : Number(((matchedTrades / apiTrades.length) * 100).toFixed(2)),
    },
    missingInLocal: missingInLocal.sort((a, b) => b.timestamp - a.timestamp),
    localOnly: localOnly.sort((a, b) => b.timestamp - a.timestamp),
  };
}
