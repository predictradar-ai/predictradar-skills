/**
 * CopyHunter - Core Types
 */

// ============ Platform Types ============

export type Platform = 'polymarket' | 'kalshi' | 'manifold';

export type EventType = 'BUY' | 'SELL';

export type Outcome = string;

export type OrderType = 'market' | 'limit';

export type OrderSide = 'buy' | 'sell';

export type OrderStatus = 'pending' | 'executed' | 'failed' | 'cancelled';
export type OrderReconcileStatus = 'pending' | 'not_applicable' | 'simulated' | 'estimated' | 'matched' | 'drifted';

export type PositionStatus = 'open' | 'closed';

export type FollowMode = 'shadow' | 'live' | 'disabled';
export type FollowSizingMode = 'fixed' | 'proportional';

// ============ Leader Types ============

export interface Leader {
  id?: number;
  address: string;
  alias?: string;
  tags?: string[];
  platform: Platform;
  addedAt: number;
  updatedAt: number;
  // Stats cache
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  lastTradeAt?: number;
}

export interface LeaderStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgTradeSize: number;
  profitableTrades: number;
  losingTrades: number;
}

// ============ Event Types ============

export interface TradeEvent {
  id?: number;
  leaderAddress: string;
  platform: Platform;
  eventType: EventType;
  conditionId: string;
  marketSlug?: string;
  marketTitle?: string;
  outcome?: Outcome;
  price: number;
  quantity: number;
  amountUsd: number;
  txHash?: string;
  blockNumber?: number;
  timestamp: number;
  // Follow status
  followed: boolean;
  followReason?: string;
  createdAt: number;
}

// ============ Position Types ============

export interface Position {
  id?: number;
  leaderAddress: string;
  platform: Platform;
  conditionId: string;
  marketSlug?: string;
  marketTitle?: string;
  outcome: Outcome;
  quantity: number;
  avgPrice: number;
  costBasis: number;
  status: PositionStatus;
  realizedPnl: number;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ClosedPosition {
  leaderAddress: string;
  platform: Platform;
  conditionId: string;
  marketSlug?: string;
  marketTitle?: string;
  outcome: Outcome;
  outcomeIndex: number;
  avgPrice: number;
  curPrice: number;
  totalBought: number;
  realizedPnl: number;
  won: boolean;
  closedAt: number;
}

// ============ Order Types ============

export interface Order {
  id?: number;
  eventId: number;
  leaderAddress: string;
  platform: Platform;
  orderType: OrderType;
  side: OrderSide;
  tokenId: string;
  price?: number;
  size: number;
  amountUsd: number;
  status: OrderStatus;
  txHash?: string;
  executedPrice?: number;
  executedSize?: number;
  executedAmountUsd?: number;
  executedAt?: number;
  reconcileStatus?: OrderReconcileStatus;
  reconcileReason?: string | null;
  lastReconciledAt?: number | null;
  errorMessage?: string;
  mode: FollowMode;
  createdAt: number;
}

// ============ Stats Types ============

export interface DailyStats {
  id?: number;
  date: string; // 'YYYY-MM-DD'
  platform: Platform;
  eventsCaptured: number;
  eventsFollowed: number;
  eventsSkipped: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalExposure: number;
  maxExposure: number;
  positionsOpened: number;
  positionsClosed: number;
}

// ============ Config Types ============

export interface LeadersConfig {
  autoImport: boolean;
  importTop: number;
  importPeriod: 'weekly' | 'monthly';
}

export interface WatchConfig {
  interval: number;
  sources: ('polling' | 'websocket')[];
  filterMinUsd: number;
}

export interface FollowConfig {
  mode: FollowMode;
  followerAddress?: string;
  sizingMode: FollowSizingMode;
  bankrollUsd: number;
  maxPerTrade: number;
  dailyLimit: number;
  allowlist: string[];
  blocklist: string[];
}

export interface RiskConfig {
  maxExposure: number;
  maxPositions: number;
  maxLossPerDay: number;
  stopLossPercent: number;
}

export interface DisplayConfig {
  theme: 'dark' | 'light';
  refreshInterval: number;
}

export interface AppConfig {
  leaders: LeadersConfig;
  watch: WatchConfig;
  follow: FollowConfig;
  risk: RiskConfig;
  display: DisplayConfig;
}

// ============ CLI Types ============

export type OutputFormat = 'table' | 'json';

export interface CLIContext {
  output: OutputFormat;
  verbose: boolean;
}

// ============ Platform Adapter Types ============

export interface PlatformAdapter {
  name: Platform;

  // Price queries
  getPrice(tokenId: string): Promise<PriceResult>;
  getPrices(tokenIds: string[]): Promise<PriceResult[]>;

  // Position queries
  getPositions(address: string): Promise<Position[]>;

  // Trading
  createOrder(params: CreateOrderParams): Promise<OrderResult>;
  marketOrder(params: MarketOrderParams): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;

  // Account
  getBalance(): Promise<Balance>;

  // Discovery
  getLeaderboard(period: 'weekly' | 'monthly'): Promise<LeaderboardEntry[]>;
  getTrades(address: string, limit?: number): Promise<TradeEvent[]>;
}

export interface PriceResult {
  tokenId: string;
  price: number;
  timestamp: number;
}

export interface CreateOrderParams {
  tokenId: string;
  side: OrderSide;
  size: number;
  price: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: OrderSide;
  amount: number;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  txHash?: string;
  executedPrice?: number;
  executedSize?: number;
}

export interface Balance {
  available: number;
  locked: number;
  total: number;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  alias?: string;
  pnl: number;
  volume: number;
  trades: number;
}
