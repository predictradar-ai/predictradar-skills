/**
 * CopyHunter - Polymarket Data API Client
 *
 * Direct HTTP client for Polymarket Data API
 * Used as fallback when polymarket-cli is unavailable
 */

import type { TradeEvent, Position, ClosedPosition } from '../../core/types.js';
import { StructuredFailure, createFailureInfo } from '../../core/failures.js';
import { getTradeIdentityKey } from '../../core/trade-identity.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

export interface DataAPIOptions {
  timeout?: number;
}

export interface TradeHistoryWindowOptions {
  fromTimestamp: number;
  toTimestamp: number;
  pageLimit?: number;
  maxPages?: number;
  maxOffset?: number;
  anchor?: 'from' | 'to';
}

export interface TradeHistoryWindowResult {
  trades: TradeEvent[];
  pagesFetched: number;
  latestTimestamp: number | null;
  oldestTimestamp: number | null;
  windowComplete: boolean;
  pageBudgetReached: boolean;
  apiOffsetCapReached: boolean;
}

export class PolymarketDataAPI {
  private timeout: number;

  constructor(options: DataAPIOptions = {}) {
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Fetch with timeout
   */
  private async fetch<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const responseBody = await response.text().catch(() => '');
        throw new StructuredFailure(createFailureInfo({
          code: 'dependency_http_error',
          source: 'polymarket_data_api',
          operation: 'http_fetch',
          message: `Data API error: ${response.status} ${response.statusText}`,
          retryable: response.status >= 500 || response.status === 429,
          details: {
            status: response.status,
            url,
            responseBody: responseBody.slice(0, 500),
          },
        }));
      }

      try {
        return await response.json() as T;
      } catch (error) {
        throw new StructuredFailure(
          createFailureInfo({
            code: 'dependency_invalid_response',
            source: 'polymarket_data_api',
            operation: 'http_fetch',
            message: 'Polymarket Data API returned invalid JSON.',
            retryable: true,
            details: { url },
          }),
          error
        );
      }
    } catch (error) {
      if (error instanceof StructuredFailure) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new StructuredFailure(
          createFailureInfo({
            code: 'dependency_timeout',
            source: 'polymarket_data_api',
            operation: 'http_fetch',
            message: `Polymarket Data API request timed out: ${url}`,
            retryable: true,
            details: { url },
          }),
          error
        );
      }

      throw new StructuredFailure(
        createFailureInfo({
          code: 'dependency_network_error',
          source: 'polymarket_data_api',
          operation: 'http_fetch',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          details: { url },
        }),
        error
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============ Trade Queries ============

  /**
   * Get trades for an address
   */
  async getTrades(address: string, limit = 100): Promise<TradeEvent[]> {
    return this.getTradesPage(address, limit, 0);
  }

  async getTradesPage(address: string, limit = 100, offset = 0): Promise<TradeEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const safeOffset = Math.max(0, offset);
    const url = `${DATA_API_BASE}/trades?maker=${address}&limit=${safeLimit}&offset=${safeOffset}`;

    const trades = await this.fetch<Array<{
      proxyWallet: string;
      side: string;
      asset: string;
      conditionId: string;
      size: number | string;
      price: number | string;
      timestamp: number;
      title?: string;
      slug?: string;
      outcome?: string;
      outcomeIndex?: number;
      transactionHash?: string;
    }>>(url);

    return trades.map(t => {
      const price = typeof t.price === 'string' ? parseFloat(t.price) : t.price;
      const size = typeof t.size === 'string' ? parseFloat(t.size) : t.size;
      return {
        leaderAddress: address,
        platform: 'polymarket' as const,
        eventType: t.side.toUpperCase() as 'BUY' | 'SELL',
        conditionId: t.conditionId || t.asset,
        marketSlug: t.slug,
        marketTitle: t.title || t.slug || t.asset.slice(0, 20),
        outcome: t.outcome || (t.outcomeIndex === 0 ? 'YES' : 'NO'),
        price,
        quantity: size,
        amountUsd: price * size,
        txHash: t.transactionHash || `${t.timestamp}-${t.asset.slice(0, 8)}`,
        timestamp: t.timestamp * 1000, // API returns seconds, convert to ms
        followed: false,
        createdAt: Date.now(),
      };
    });
  }

  async getTradesWindow(address: string, options: TradeHistoryWindowOptions): Promise<TradeHistoryWindowResult> {
    const anchor = options.anchor ?? 'to';
    const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 1000, 1000));
    const derivedMaxPages = options.maxOffset !== undefined
      ? Math.floor(Math.max(0, options.maxOffset) / pageLimit) + 1
      : undefined;
    const maxPages = Math.max(1, options.maxPages ?? derivedMaxPages ?? 50);
    const trades: TradeEvent[] = [];
    const seenKeys = new Set<string>();
    const pageCache = new Map<number, TradeEvent[]>();
    let pagesFetched = 0;
    let latestTimestamp: number | null = null;
    let oldestTimestamp: number | null = null;
    let pageBudgetReached = false;
    let apiOffsetCapReached = false;
    let lastPageCount = 0;
    let collectedPages = 0;
    let windowComplete = false;

    const getPageRange = (page: TradeEvent[]) => ({
      latestTimestamp: page[0]?.timestamp ?? null,
      oldestTimestamp: page[page.length - 1]?.timestamp ?? null,
    });

    const rememberPageCoverage = (page: TradeEvent[]) => {
      if (page.length === 0) {
        return;
      }
      const range = getPageRange(page);
      latestTimestamp = latestTimestamp === null
        ? range.latestTimestamp
        : Math.max(latestTimestamp, range.latestTimestamp ?? latestTimestamp);
      oldestTimestamp = oldestTimestamp === null
        ? range.oldestTimestamp
        : Math.min(oldestTimestamp, range.oldestTimestamp ?? oldestTimestamp);
    };

    const fetchPageByIndex = async (pageIndex: number): Promise<TradeEvent[]> => {
      const cached = pageCache.get(pageIndex);
      if (cached) {
        return cached;
      }

      const offset = pageIndex * pageLimit;
      let page: TradeEvent[];
      try {
        page = await this.getTradesPage(address, pageLimit, offset);
      } catch (error) {
        if (this.isHistoricalOffsetCapError(error)) {
          apiOffsetCapReached = true;
          page = [];
        } else {
          throw error;
        }
      }

      pagesFetched += 1;
      pageCache.set(pageIndex, page);
      rememberPageCoverage(page);
      return page;
    };

    const addTradesFromPage = (page: TradeEvent[]) => {
      for (const trade of page) {
        if (trade.timestamp < options.fromTimestamp || trade.timestamp > options.toTimestamp) {
          continue;
        }

        const tradeKey = getTradeIdentityKey(trade);

        if (seenKeys.has(tradeKey)) {
          continue;
        }

        seenKeys.add(tradeKey);
        trades.push(trade);
      }
    };

    const findStartPageIndex = async (targetTimestamp: number): Promise<number> => {
      const firstPage = await fetchPageByIndex(0);
      if (firstPage.length === 0) {
        return 0;
      }

      const firstRange = getPageRange(firstPage);
      if ((firstRange.oldestTimestamp ?? Number.NEGATIVE_INFINITY) <= targetTimestamp) {
        return 0;
      }

      let low = 0;
      let high = 1;
      let highPage = await fetchPageByIndex(high);
      const searchBudget = Math.max(12, Math.ceil(Math.log2(maxPages + 1)) + 4);
      let searchRequests = 1;

      while (
        highPage.length > 0
        && (getPageRange(highPage).oldestTimestamp ?? Number.POSITIVE_INFINITY) > targetTimestamp
        && !apiOffsetCapReached
        && searchRequests < searchBudget
      ) {
        low = high;
        high *= 2;
        highPage = await fetchPageByIndex(high);
        searchRequests += 1;
      }

      while (high - low > 1 && !apiOffsetCapReached && searchRequests < searchBudget) {
        const mid = Math.floor((low + high) / 2);
        const midPage = await fetchPageByIndex(mid);
        searchRequests += 1;

        if (
          midPage.length === 0
          || (getPageRange(midPage).oldestTimestamp ?? Number.NEGATIVE_INFINITY) <= targetTimestamp
        ) {
          high = mid;
          highPage = midPage;
          continue;
        }

        low = mid;
      }

      if (
        highPage.length === 0
        || (getPageRange(highPage).oldestTimestamp ?? Number.POSITIVE_INFINITY) > targetTimestamp
      ) {
        return low;
      }

      return high;
    };

    const startPageIndex = await findStartPageIndex(anchor === 'from' ? options.fromTimestamp : options.toTimestamp);

    if (anchor === 'from') {
      for (let pageIndex = startPageIndex; pageIndex >= 0 && collectedPages < maxPages; pageIndex -= 1) {
        const page = await fetchPageByIndex(pageIndex);
        collectedPages += 1;
        lastPageCount = page.length;

        if (page.length === 0) {
          windowComplete = true;
          break;
        }

        addTradesFromPage(page);
        const pageRange = getPageRange(page);

        if (pageIndex === 0) {
          windowComplete = true;
          break;
        }

        if ((pageRange.latestTimestamp ?? Number.NEGATIVE_INFINITY) > options.toTimestamp) {
          windowComplete = true;
          break;
        }
      }
    } else {
      for (let pageIndex = startPageIndex; collectedPages < maxPages; pageIndex += 1) {
        const page = await fetchPageByIndex(pageIndex);
        collectedPages += 1;
        lastPageCount = page.length;

        if (page.length === 0) {
          windowComplete = true;
          break;
        }

        addTradesFromPage(page);

        if (page.length < pageLimit) {
          windowComplete = true;
          break;
        }

        const pageRange = getPageRange(page);
        if ((pageRange.oldestTimestamp ?? Number.NEGATIVE_INFINITY) < options.fromTimestamp) {
          windowComplete = true;
          break;
        }
      }
    }

    if (!windowComplete && collectedPages >= maxPages) {
      pageBudgetReached = true;
    }

    trades.sort((a, b) => b.timestamp - a.timestamp);

    return {
      trades,
      pagesFetched,
      latestTimestamp,
      oldestTimestamp,
      windowComplete: windowComplete || (
        anchor === 'from'
          ? latestTimestamp === null || latestTimestamp >= options.toTimestamp || (startPageIndex === 0 && lastPageCount > 0)
          : oldestTimestamp === null || oldestTimestamp <= options.fromTimestamp || lastPageCount < pageLimit
      ),
      pageBudgetReached,
      apiOffsetCapReached,
    };
  }

  private isHistoricalOffsetCapError(error: unknown): boolean {
    if (!(error instanceof StructuredFailure)) {
      return false;
    }

    const responseBody = String(error.info.details?.responseBody ?? '').toLowerCase();
    return error.info.code === 'dependency_http_error'
      && error.info.details?.status === 400
      && responseBody.includes('max historical activity offset');
  }

  /**
   * Get recent trades (global, not address-specific)
   */
  async getRecentTrades(limit = 100): Promise<TradeEvent[]> {
    const url = `${DATA_API_BASE}/trades?limit=${limit}&takerOnly=true`;

    const trades = await this.fetch<Array<{
      maker: string;
      side: string;
      asset: string;
      conditionId: string;
      size: number | string;
      price: number | string;
      timestamp: number;
      title?: string;
      slug?: string;
      outcome?: string;
      outcomeIndex?: number;
      transactionHash?: string;
    }>>(url);

    return trades.map(t => {
      const price = typeof t.price === 'string' ? parseFloat(t.price) : t.price;
      const size = typeof t.size === 'string' ? parseFloat(t.size) : t.size;
      return {
        leaderAddress: t.maker,
        platform: 'polymarket' as const,
        eventType: t.side.toUpperCase() as 'BUY' | 'SELL',
        conditionId: t.conditionId || t.asset,
        marketSlug: t.slug,
        marketTitle: t.title || t.slug || t.asset.slice(0, 20),
        outcome: t.outcome || (t.outcomeIndex === 0 ? 'YES' : 'NO'),
        price,
        quantity: size,
        amountUsd: price * size,
        txHash: t.transactionHash || `${t.timestamp}-${t.asset.slice(0, 8)}`,
        timestamp: t.timestamp * 1000,
        followed: false,
        createdAt: Date.now(),
      };
    });
  }

  // ============ Position Queries ============

  /**
   * Get open positions for an address
   */
  async getPositions(address: string): Promise<Position[]> {
    const url = `${DATA_API_BASE}/positions?user=${address}`;

    const positions = await this.fetch<Array<{
      conditionId: string;
      asset: string;
      slug?: string;
      title?: string;
      outcome: string;
      outcomeIndex?: number;
      size: number | string;
      avgPrice?: number | string;
      currentPrice?: number | string;
    }>>(url);

    return positions.map(p => {
      const size = typeof p.size === 'string' ? parseFloat(p.size) : p.size;
      const avgPrice = typeof p.avgPrice === 'string' ? parseFloat(p.avgPrice) : (p.avgPrice ?? 0);

      return {
        leaderAddress: address,
        platform: 'polymarket' as const,
        conditionId: p.conditionId || p.asset,
        marketSlug: p.slug,
        marketTitle: p.title || p.slug,
        outcome: p.outcome || (p.outcomeIndex === 0 ? 'YES' : 'NO'),
        quantity: size,
        avgPrice,
        costBasis: size * avgPrice,
        status: 'open' as const,
        realizedPnl: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
  }

  /**
   * Get closed positions for an address (fallback - Data API doesn't have direct endpoint)
   * Uses activity endpoint to find resolved markets
   */
  async getClosedPositions(address: string, limit = 100): Promise<ClosedPosition[]> {
    // Data API doesn't have a direct closed-positions endpoint
    // This is a stub that returns empty array - CLI should be primary source
    // TODO: Could parse activity endpoint for redemptions
    try {
      const url = `${DATA_API_BASE}/activity?user=${address}&type=REDEEM&limit=${limit}`;
      const activities = await this.fetch<Array<{
        conditionId: string;
        slug?: string;
        title?: string;
        outcome: string;
        outcomeIndex: number;
        price: number | string;
        size: number | string;
        timestamp: number;
        pnl?: number | string;
      }>>(url);

      return activities.map(a => {
        const avgPrice = typeof a.price === 'string' ? parseFloat(a.price) : a.price;
        const size = typeof a.size === 'string' ? parseFloat(a.size) : a.size;
        const pnl = a.pnl ? (typeof a.pnl === 'string' ? parseFloat(a.pnl) : a.pnl) : 0;

        return {
          leaderAddress: address,
          platform: 'polymarket' as const,
          conditionId: a.conditionId,
          marketSlug: a.slug,
          marketTitle: a.title,
          outcome: a.outcome || (a.outcomeIndex === 0 ? 'YES' : 'NO'),
          outcomeIndex: a.outcomeIndex,
          avgPrice,
          curPrice: 1, // Redeemed = won
          totalBought: size * avgPrice,
          realizedPnl: pnl,
          won: true,
          closedAt: a.timestamp * 1000,
        };
      });
    } catch {
      // Return empty array if API doesn't support this
      return [];
    }
  }

  // ============ Price Queries ============

  /**
   * Get midpoint price for a token from CLOB API
   */
  async getMidpoint(tokenId: string): Promise<number> {
    try {
      const url = `${CLOB_API_BASE}/midpoint?token_id=${tokenId}`;
      const result = await this.fetch<{ mid: string }>(url);
      return parseFloat(result.mid);
    } catch {
      return 0;
    }
  }

  /**
   * Get spread for a token from CLOB API
   */
  async getSpread(tokenId: string): Promise<{ bid: number; ask: number }> {
    const url = `${CLOB_API_BASE}/spread?token_id=${tokenId}`;
    const result = await this.fetch<{ bid: string; ask: string }>(url);
    return {
      bid: parseFloat(result.bid),
      ask: parseFloat(result.ask),
    };
  }

  /**
   * Get price (uses midpoint)
   */
  async getPrice(tokenId: string): Promise<number> {
    return this.getMidpoint(tokenId);
  }

  /**
   * Batch get midpoints for multiple tokens
   */
  async getMidpoints(tokenIds: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    // CLOB API doesn't have batch endpoint, fetch individually
    await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const price = await this.getMidpoint(tokenId);
          results.set(tokenId, price);
        } catch {
          results.set(tokenId, 0);
        }
      })
    );

    return results;
  }

  // ============ Market Queries ============

  /**
   * Get market info by condition ID
   */
  async getMarket(conditionId: string): Promise<{
    conditionId: string;
    slug: string;
    title: string;
    outcomes: string[];
    tokens: Array<{ outcome: string; tokenId: string }>;
  } | null> {
    try {
      const url = `${DATA_API_BASE}/markets?condition_id=${conditionId}`;
      const markets = await this.fetch<Array<{
        condition_id: string;
        market_slug: string;
        question: string;
        outcomes: string;
        tokens: Array<{ outcome: string; token_id: string }>;
      }>>(url);

      if (markets.length === 0) return null;

      const market = markets[0];
      return {
        conditionId: market.condition_id,
        slug: market.market_slug,
        title: market.question,
        outcomes: JSON.parse(market.outcomes),
        tokens: market.tokens?.map(t => ({
          outcome: t.outcome,
          tokenId: t.token_id,
        })) ?? [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Get active traders (for leader discovery)
   */
  async getActiveTraders(limit = 50): Promise<Array<{
    address: string;
    tradeCount: number;
    volume: number;
  }>> {
    const trades = await this.getRecentTrades(500);

    // Aggregate by maker address
    const traderMap = new Map<string, { count: number; volume: number }>();

    for (const trade of trades) {
      const existing = traderMap.get(trade.leaderAddress) || { count: 0, volume: 0 };
      traderMap.set(trade.leaderAddress, {
        count: existing.count + 1,
        volume: existing.volume + trade.amountUsd,
      });
    }

    // Convert to array and sort by trade count
    return Array.from(traderMap.entries())
      .map(([address, stats]) => ({
        address,
        tradeCount: stats.count,
        volume: stats.volume,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount)
      .slice(0, limit);
  }

  /**
   * Check API health
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.fetch(`${DATA_API_BASE}/trades?limit=1`);
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let instance: PolymarketDataAPI | null = null;

export function getPolymarketDataAPI(): PolymarketDataAPI {
  if (!instance) {
    instance = new PolymarketDataAPI();
  }
  return instance;
}
