/**
 * CopyHunter Share Card - Type Definitions
 */

export interface CardData {
  // Copy trading mode
  mode: 'shadow' | 'live';

  // Follower's PnL data
  pnl: {
    total: number;           // Total profit/loss
    totalPercent: number;    // Return percentage
    realized: number;        // Realized PnL (closed positions)
    unrealized: number;      // Unrealized PnL (open positions)
  };

  // Follower's statistics
  stats: {
    winRate: number;              // Win rate percentage
    totalTrades: number;          // Total number of trades
    tradingDays: number;          // Active trading days
    openPositions: number;        // Current open positions
    closedPositions: number;      // Closed positions
    leadersFollowed: number;      // Number of leaders followed
  };

  // Daily PnL trend for chart
  trend: Array<{
    date: string;
    pnl: number;             // Cumulative PnL on that day
  }>;

  // Metadata
  meta?: {
    generatedAt: Date;
    periodStart: Date;
    periodEnd: Date;
  };
}

export interface CardOptions {
  width?: number;      // Default 1200
  height?: number;     // Default 630
  theme?: 'dark' | 'light';
  showChart?: boolean;
}

export interface CardResult {
  buffer: Buffer;
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  format: 'png';
}

export interface CardJsonOutput {
  success: boolean;
  card: {
    type: 'pnl';
    width: number;
    height: number;
    format: 'png';
    base64: string;
    dataUrl: string;
  };
  data: {
    mode: string;
    totalPnl: number;
    totalPnlPercent: number;
    realizedPnl: number;
    unrealizedPnl: number;
    winRate: number;
    totalTrades: number;
    tradingDays: number;
    openPositions: number;
    closedPositions: number;
    leadersFollowed: number;
  };
  generatedAt: string;
}

// Theme colors
export interface ThemeColors {
  bgGradientStart: string;
  bgGradientEnd: string;
  cardBg: string;
  primary: string;
  profit: string;
  loss: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  chartLine: string;
  chartArea: string;
}

// Dark theme (default)
export const DARK_THEME: ThemeColors = {
  bgGradientStart: '#0d1117',
  bgGradientEnd: '#161b22',
  cardBg: '#21262d',
  primary: '#6366f1',
  profit: '#22c55e',
  loss: '#ef4444',
  textPrimary: '#ffffff',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  border: '#30363d',
  chartLine: '#8b5cf6',
  chartArea: 'rgba(139, 92, 246, 0.2)',
};
