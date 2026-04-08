/**
 * CopyHunter - Polymarket Adapter
 *
 * High-level adapter that uses the CLI wrapper
 */

import { PolymarketCLI, getPolymarketCLI } from './cli-wrapper.js';
import { getPolymarketDataAPI } from './data-api.js';
import type { TradeEvent } from '../../core/types.js';

export interface PolymarketTradeFilter {
  minAmountUsd?: number;
  maxAmountUsd?: number;
  outcomes?: string[];
  eventTypes?: ('BUY' | 'SELL')[];
}

export class PolymarketAdapter {
  private cli: PolymarketCLI;

  constructor() {
    this.cli = getPolymarketCLI();
  }

  /**
   * Fetch recent trades for an address with optional filtering
   */
  async fetchTrades(
    address: string,
    limit = 100,
    filter?: PolymarketTradeFilter
  ): Promise<TradeEvent[]> {
    const trades = await this.cli.getTrades(address, limit);

    if (!filter) return trades;

    return trades.filter(trade => {
      if (filter.minAmountUsd && trade.amountUsd < filter.minAmountUsd) return false;
      if (filter.maxAmountUsd && trade.amountUsd > filter.maxAmountUsd) return false;
      if (filter.outcomes && trade.outcome && !filter.outcomes.includes(trade.outcome)) return false;
      if (filter.eventTypes && !filter.eventTypes.includes(trade.eventType)) return false;
      return true;
    });
  }

  /**
   * Get current positions for an address
   */
  async fetchPositions(address: string) {
    try {
      return await this.cli.getPositions(address);
    } catch {
      return getPolymarketDataAPI().getPositions(address);
    }
  }

  /**
   * Get leaderboard traders
   */
  async fetchLeaders(period: 'weekly' | 'monthly' = 'monthly', top = 10) {
    const leaderboard = await this.cli.getLeaderboard(period);
    return leaderboard.slice(0, top);
  }

  /**
   * Execute a copy trade
   */
  async executeCopyTrade(params: {
    tokenId: string;
    side: 'buy' | 'sell';
    amount: number;
    useMarketOrder?: boolean;
    limitPrice?: number;
  }) {
    if (params.useMarketOrder || !params.limitPrice) {
      return this.cli.marketOrder({
        tokenId: params.tokenId,
        side: params.side,
        amount: params.amount,
      });
    }

    return this.cli.createOrder({
      tokenId: params.tokenId,
      side: params.side,
      size: params.amount / params.limitPrice,
      price: params.limitPrice,
    });
  }

  /**
   * Get market info for a condition
   */
  async getMarketInfo(conditionId: string) {
    return this.cli.getMarket(conditionId);
  }

  /**
   * Get token ID for a specific outcome
   */
  async getTokenIdForOutcome(conditionId: string, outcome: string): Promise<string | null> {
    try {
      const market = await this.cli.getMarket(conditionId);
      const normalizedOutcome = outcome.trim().toLowerCase();
      const token = market.tokens.find((candidate) => {
        const candidateOutcome = candidate.outcome.trim().toLowerCase();
        if (candidateOutcome === normalizedOutcome) {
          return true;
        }

        if (normalizedOutcome === 'yes' && candidateOutcome === 'yes') {
          return true;
        }

        if (normalizedOutcome === 'no' && candidateOutcome === 'no') {
          return true;
        }

        return false;
      });
      return token?.tokenId ?? null;
    } catch {
      // Market query failed, return null
      return null;
    }
  }

  /**
   * Get current price for a token
   */
  async getPrice(tokenId: string) {
    return this.cli.getPrice(tokenId);
  }

  /**
   * Get account balance
   */
  async getBalance() {
    return this.cli.getBalance();
  }

  /**
   * Check if CLI is available
   */
  async checkHealth() {
    return this.cli.checkHealth();
  }
}

// Singleton
let adapter: PolymarketAdapter | null = null;

export function getPolymarketAdapter(): PolymarketAdapter {
  if (!adapter) {
    adapter = new PolymarketAdapter();
  }
  return adapter;
}
