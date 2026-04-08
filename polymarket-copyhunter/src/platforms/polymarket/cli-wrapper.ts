/**
 * CopyHunter - Polymarket CLI Wrapper
 *
 * Wraps the polymarket-cli Rust binary for trading and data queries
 * Falls back to Data API when CLI is unavailable
 */

import { execSync } from 'child_process';
import type {
  PlatformAdapter,
  PriceResult,
  Position,
  ClosedPosition,
  CreateOrderParams,
  MarketOrderParams,
  OrderResult,
  Balance,
  LeaderboardEntry,
  TradeEvent,
} from '../types.js';
import { getPolymarketDataAPI } from './data-api.js';
import { StructuredFailure, createFailureInfo } from '../../core/failures.js';
import { getTradeIdentityKey } from '../../core/trade-identity.js';

interface PolymarketCLIOptions {
  timeout?: number;
  tradeFreshnessWindowMs?: number;
  tradeFreshnessDriftMs?: number;
}

export class PolymarketCLI implements PlatformAdapter {
  readonly name = 'polymarket' as const;
  private baseCmd = 'polymarket';
  private timeout: number;
  private tradeFreshnessWindowMs: number;
  private tradeFreshnessDriftMs: number;

  constructor(options: PolymarketCLIOptions = {}) {
    this.timeout = options.timeout ?? 30000;
    this.tradeFreshnessWindowMs = options.tradeFreshnessWindowMs ?? 60 * 1000;
    this.tradeFreshnessDriftMs = options.tradeFreshnessDriftMs ?? 60 * 1000;
  }

  /**
   * Execute a polymarket-cli command and return JSON result
   */
  private exec<T>(args: string): T {
    const operation = `polymarket ${args}`;

    try {
      const result = execSync(`${this.baseCmd} ${args} -o json`, {
        encoding: 'utf-8',
        timeout: this.timeout,
      });

      try {
        return JSON.parse(result);
      } catch (error) {
        throw new StructuredFailure(
          createFailureInfo({
            code: 'dependency_invalid_response',
            source: 'polymarket_cli',
            operation,
            message: 'polymarket-cli returned invalid JSON output.',
            retryable: true,
          }),
          error
        );
      }
    } catch (error) {
      if (error instanceof StructuredFailure) {
        throw error;
      }

      const execError = error as NodeJS.ErrnoException & {
        status?: number;
        signal?: string;
        stderr?: Buffer | string;
      };
      const stderr = typeof execError.stderr === 'string'
        ? execError.stderr.trim()
        : execError.stderr?.toString().trim();
      const rawMessage = stderr || execError.message || String(error);
      const lowerMessage = rawMessage.toLowerCase();

      let code: ReturnType<typeof createFailureInfo>['code'] = 'dependency_command_failed';
      let retryable = true;

      if (execError.code === 'ENOENT' || lowerMessage.includes('not found')) {
        code = 'dependency_unavailable';
        retryable = false;
      } else if (
        execError.code === 'ETIMEDOUT'
        || execError.signal === 'SIGTERM'
        || lowerMessage.includes('timed out')
      ) {
        code = 'dependency_timeout';
      }

      if (error instanceof Error) {
        throw new StructuredFailure(
          createFailureInfo({
            code,
            source: 'polymarket_cli',
            operation,
            message: `polymarket-cli error: ${rawMessage}`,
            retryable,
            details: {
              status: execError.status ?? null,
            },
          }),
          error
        );
      }
      throw error;
    }
  }

  /**
   * Check if polymarket-cli is installed and configured
   */
  async checkHealth(): Promise<boolean> {
    try {
      const result = this.exec<{ ok: boolean }>('status');
      return result.ok;
    } catch {
      return false;
    }
  }

  // ============ Price Queries ============

  async getPrice(tokenId: string, side: 'buy' | 'sell' = 'buy'): Promise<PriceResult> {
    try {
      const result = this.exec<{ price: number; timestamp: string }>(
        `clob price --side ${side} ${tokenId}`
      );
      return {
        tokenId,
        price: result.price,
        timestamp: Date.now(),
      };
    } catch {
      // Fallback to midpoint if price query fails
      const midpoint = await this.getMidpoint(tokenId);
      return {
        tokenId,
        price: midpoint,
        timestamp: Date.now(),
      };
    }
  }

  async getPrices(tokenIds: string[]): Promise<PriceResult[]> {
    // Use midpoints for batch prices (more reliable)
    try {
      const ids = tokenIds.join(',');
      const result = this.exec<Array<{ token_id: string; mid: number }>>(
        `clob midpoints ${ids}`
      );
      return result.map(r => ({
        tokenId: r.token_id,
        price: r.mid,
        timestamp: Date.now(),
      }));
    } catch {
      // Fallback to individual calls
      const results: PriceResult[] = [];
      for (const tokenId of tokenIds) {
        try {
          const price = await this.getMidpoint(tokenId);
          results.push({ tokenId, price, timestamp: Date.now() });
        } catch {
          // Skip failed tokens
        }
      }
      return results;
    }
  }

  async getMidpoint(tokenId: string): Promise<number> {
    try {
      const result = this.exec<{ mid: number }>(`clob midpoint ${tokenId}`);
      return result.mid;
    } catch {
      // Fallback to spread and calculate midpoint
      try {
        const spread = await this.getSpread(tokenId);
        return (spread.bid + spread.ask) / 2;
      } catch {
        // Return 0 if all methods fail
        return 0;
      }
    }
  }

  async getSpread(tokenId: string): Promise<{ bid: number; ask: number }> {
    const result = this.exec<{ bid: number; ask: number }>(
      `clob spread ${tokenId}`
    );
    return result;
  }

  // ============ Position Queries ============

  async getPositions(address: string): Promise<Position[]> {
    const result = this.exec<Array<{
      condition_id: string;
      market_slug?: string;
      title?: string;
      outcome: string;
      size: number;
      avg_price: number;
      current_value: number;
    }>>(`data positions ${address}`);

    return result.map(p => ({
      leaderAddress: address,
      platform: 'polymarket',
      conditionId: p.condition_id,
      marketSlug: p.market_slug,
      marketTitle: p.title,
      outcome: p.outcome,
      quantity: p.size,
      avgPrice: p.avg_price,
      costBasis: p.size * p.avg_price,
      status: 'open' as const,
      realizedPnl: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }

  async getClosedPositions(address: string, limit = 50): Promise<ClosedPosition[]> {
    // API limit is max 50
    const actualLimit = Math.min(limit, 50);
    try {
      const result = this.exec<Array<{
        condition_id: string;
        slug?: string;
        title?: string;
        outcome: string;
        outcome_index: number;
        avg_price: string;
        cur_price: string;
        total_bought: string;
        realized_pnl: string;
        timestamp: number;
      }> | { error: string }>(`data closed-positions ${address} --limit ${actualLimit}`);

      // Check for error response
      if (!Array.isArray(result)) {
        if ('error' in result) {
          throw new Error(result.error);
        }
        return [];
      }

      return result.map(p => {
        const avgPrice = parseFloat(p.avg_price);
        const curPrice = parseFloat(p.cur_price);
        const totalBought = parseFloat(p.total_bought);
        const realizedPnl = parseFloat(p.realized_pnl);
        // Win condition: curPrice == 1 means this outcome is the winner
        const won = curPrice === 1;

        return {
          leaderAddress: address,
          platform: 'polymarket' as const,
          conditionId: p.condition_id,
          marketSlug: p.slug,
          marketTitle: p.title,
          outcome: p.outcome,
          outcomeIndex: p.outcome_index,
          avgPrice,
          curPrice,
          totalBought,
          realizedPnl,
          won,
          closedAt: p.timestamp * 1000, // CLI returns seconds
        };
      });
    } catch {
      // Fallback to Data API
      const dataApi = getPolymarketDataAPI();
      return dataApi.getClosedPositions(address, limit);
    }
  }

  // ============ Trading ============

  async createOrder(params: CreateOrderParams): Promise<OrderResult> {
    const { tokenId, side, size, price } = params;
    const result = this.exec<{
      order_id: string;
      status: string;
      tx_hash?: string;
    }>(`clob create-order ${tokenId} ${side} ${size} ${price}`);

    return {
      orderId: result.order_id,
      status: result.status as OrderResult['status'],
      txHash: result.tx_hash,
    };
  }

  async marketOrder(params: MarketOrderParams): Promise<OrderResult> {
    const { tokenId, side, amount } = params;
    const result = this.exec<{
      order_id: string;
      status: string;
      tx_hash?: string;
      executed_price?: number;
      executed_size?: number;
    }>(`clob market-order ${tokenId} ${side} ${amount}`);

    return {
      orderId: result.order_id,
      status: result.status as OrderResult['status'],
      txHash: result.tx_hash,
      executedPrice: result.executed_price,
      executedSize: result.executed_size,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.exec(`clob cancel ${orderId}`);
  }

  async cancelAllOrders(): Promise<void> {
    this.exec('clob cancel-all');
  }

  // ============ Account ============

  async getBalance(): Promise<Balance> {
    const result = this.exec<{
      available: number;
      locked: number;
      total: number;
    }>('clob balance');

    return result;
  }

  // ============ Discovery ============

  async getLeaderboard(period: 'weekly' | 'monthly' = 'monthly', limit = 10): Promise<LeaderboardEntry[]> {
    // CLI uses 'week' and 'month' instead of 'weekly' and 'monthly'
    const cliPeriod = period === 'weekly' ? 'week' : 'month';
    const result = this.exec<Array<{
      rank: number;
      proxy_wallet: string;
      user_name?: string;
      pnl: string;
      volume: string;
    }>>(`data leaderboard --period ${cliPeriod} --limit ${limit}`);

    return result.map(r => ({
      rank: r.rank,
      address: r.proxy_wallet,
      alias: r.user_name,
      pnl: parseFloat(r.pnl),
      volume: parseFloat(r.volume),
      trades: 0, // Not provided by CLI
    }));
  }

  async getTrades(address: string, limit = 100): Promise<TradeEvent[]> {
    const dataApi = getPolymarketDataAPI();

    // Try polymarket-cli first (more accurate data)
    try {
      const result = this.exec<Array<{
        condition_id: string;
        slug?: string;
        title?: string;
        outcome: string;
        outcome_index?: number;
        side: string;
        price: string;
        size: string;
        transaction_hash?: string;
        timestamp: number;
      }>>(`data trades ${address} --limit ${limit}`);

      const cliTrades = this.normalizeTrades(result.map(t => ({
        leaderAddress: address,
        platform: 'polymarket' as const,
        eventType: t.side.toUpperCase() as 'BUY' | 'SELL',
        conditionId: t.condition_id,
        marketSlug: t.slug,
        marketTitle: t.title || t.slug,
        outcome: t.outcome || (t.outcome_index === 0 ? 'YES' : 'NO'),
        price: parseFloat(t.price),
        quantity: parseFloat(t.size),
        amountUsd: parseFloat(t.price) * parseFloat(t.size),
        txHash: t.transaction_hash,
        timestamp: t.timestamp * 1000, // CLI returns seconds, convert to ms
        followed: false,
        createdAt: Date.now(),
      })));

      if (!this.shouldValidateTradesWithDataApi(cliTrades)) {
        return cliTrades;
      }

      try {
        const apiTrades = this.normalizeTrades(await dataApi.getTrades(address, limit));
        return this.selectPreferredTrades(cliTrades, apiTrades, limit);
      } catch {
        return cliTrades;
      }
    } catch {
      // Fallback to Data API
      return dataApi.getTrades(address, limit);
    }
  }

  private shouldValidateTradesWithDataApi(trades: TradeEvent[]): boolean {
    if (trades.length === 0) {
      return true;
    }

    const latestTimestamp = trades[0]?.timestamp ?? null;
    if (!latestTimestamp) {
      return true;
    }

    return Date.now() - latestTimestamp > this.tradeFreshnessWindowMs;
  }

  private selectPreferredTrades(
    cliTrades: TradeEvent[],
    apiTrades: TradeEvent[],
    limit: number
  ): TradeEvent[] {
    if (apiTrades.length === 0) {
      return cliTrades;
    }

    if (cliTrades.length === 0) {
      return apiTrades;
    }

    const cliLatestTimestamp = cliTrades[0]?.timestamp ?? 0;
    const apiLatestTimestamp = apiTrades[0]?.timestamp ?? 0;

    if (apiLatestTimestamp > cliLatestTimestamp + this.tradeFreshnessDriftMs) {
      return this.mergeTrades(apiTrades, cliTrades, limit);
    }

    if (cliLatestTimestamp > apiLatestTimestamp + this.tradeFreshnessDriftMs) {
      return cliTrades;
    }

    return this.mergeTrades(cliTrades, apiTrades, limit);
  }

  private mergeTrades(primaryTrades: TradeEvent[], secondaryTrades: TradeEvent[], limit: number): TradeEvent[] {
    const merged = new Map<string, TradeEvent>();

    for (const trade of [...primaryTrades, ...secondaryTrades]) {
      merged.set(this.getTradeKey(trade), trade);
    }

    return this.normalizeTrades([...merged.values()]).slice(0, limit);
  }

  private normalizeTrades(trades: TradeEvent[]): TradeEvent[] {
    return [...trades].sort((a, b) => {
      if (b.timestamp !== a.timestamp) {
        return b.timestamp - a.timestamp;
      }

      return this.getTradeKey(a).localeCompare(this.getTradeKey(b));
    });
  }

  private getTradeKey(trade: TradeEvent): string {
    return getTradeIdentityKey(trade);
  }

  // ============ Market Data ============

  async getMarket(conditionId: string): Promise<{
    conditionId: string;
    slug: string;
    title: string;
    outcomes: string[];
    tokens: Array<{ outcome: string; tokenId: string }>;
  }> {
    const result = this.exec<{
      condition_id: string;
      market_slug: string;
      question: string;
      outcomes: string[];
      tokens: Array<{ outcome: string; token_id: string }>;
    }>(`clob market ${conditionId}`);

    return {
      conditionId: result.condition_id,
      slug: result.market_slug,
      title: result.question,
      outcomes: result.outcomes,
      tokens: result.tokens.map(t => ({
        outcome: t.outcome,
        tokenId: t.token_id,
      })),
    };
  }

  async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }> {
    const result = this.exec<{
      bids: Array<{ price: number; size: number }>;
      asks: Array<{ price: number; size: number }>;
    }>(`clob book ${tokenId}`);

    return result;
  }

  async getPriceHistory(
    tokenId: string,
    interval: '1m' | '1h' | '6h' | '1d' | '1w' = '1h'
  ): Promise<Array<{ timestamp: number; price: number }>> {
    const result = this.exec<Array<{ t: number; p: number }>>(
      `clob price-history ${tokenId} --interval ${interval}`
    );

    return result.map(r => ({
      timestamp: r.t,
      price: r.p,
    }));
  }
}

// Singleton instance
let instance: PolymarketCLI | null = null;

export function getPolymarketCLI(): PolymarketCLI {
  if (!instance) {
    instance = new PolymarketCLI();
  }
  return instance;
}
