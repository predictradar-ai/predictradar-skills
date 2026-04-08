/**
 * CopyHunter - Report Generator
 *
 * Generates reports in various formats (text, JSON, CSV)
 */

import { getPnLCalculator, type PnLSummary, type CumulativeStats } from './pnl-calculator.js';
import { getLeaderAnalyzer, type LeaderComparison, type LeaderMetrics } from './leader-analyzer.js';
import { getDailyStatsRepo } from '../db/repositories/daily-stats-repo.js';
import { getPositionRepo } from '../db/repositories/position-repo.js';
import { getOrderRepo } from '../db/repositories/order-repo.js';

export type ReportFormat = 'text' | 'json' | 'csv';
export type ReportType = 'summary' | 'daily' | 'leaders' | 'positions' | 'full';

export interface ReportOptions {
  format: ReportFormat;
  days?: number;
  includePositions?: boolean;
  includeLeaders?: boolean;
}

export interface FullReport {
  generatedAt: string;
  period: {
    from: string;
    to: string;
    days: number;
  };
  pnl: PnLSummary;
  cumulative: CumulativeStats;
  leaders: LeaderComparison;
  orders: {
    total: number;
    executed: number;
    failed: number;
    pending: number;
  };
}

export class ReportGenerator {
  private pnlCalculator = getPnLCalculator();
  private leaderAnalyzer = getLeaderAnalyzer();
  private dailyStatsRepo = getDailyStatsRepo();
  private positionRepo = getPositionRepo();
  private orderRepo = getOrderRepo();

  /**
   * Generate a full report
   */
  async generateFullReport(days = 30): Promise<FullReport> {
    const [pnl, cumulative, leaders, orderCounts] = await Promise.all([
      this.pnlCalculator.calculatePnLSummary(),
      this.pnlCalculator.getCumulativeStats(),
      this.leaderAnalyzer.compareLeaders(),
      this.orderRepo.countByStatus(),
    ]);

    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    return {
      generatedAt: now.toISOString(),
      period: {
        from: from.toISOString().split('T')[0],
        to: now.toISOString().split('T')[0],
        days,
      },
      pnl,
      cumulative,
      leaders,
      orders: {
        total: orderCounts.executed + orderCounts.failed + orderCounts.pending + orderCounts.cancelled,
        executed: orderCounts.executed,
        failed: orderCounts.failed,
        pending: orderCounts.pending,
      },
    };
  }

  /**
   * Generate report in specified format
   */
  async generate(type: ReportType, options: ReportOptions): Promise<string> {
    switch (type) {
      case 'summary':
        return this.generateSummaryReport(options);
      case 'daily':
        return this.generateDailyReport(options);
      case 'leaders':
        return this.generateLeadersReport(options);
      case 'positions':
        return this.generatePositionsReport(options);
      case 'full':
        return this.generateFullReportFormatted(options);
      default:
        throw new Error(`Unknown report type: ${type}`);
    }
  }

  /**
   * Generate summary report
   */
  private async generateSummaryReport(options: ReportOptions): Promise<string> {
    const pnl = await this.pnlCalculator.calculatePnLSummary();
    const cumulative = await this.pnlCalculator.getCumulativeStats();

    if (options.format === 'json') {
      return JSON.stringify({ pnl, cumulative }, null, 2);
    }

    if (options.format === 'csv') {
      return this.summaryToCSV(pnl, cumulative);
    }

    return this.summaryToText(pnl, cumulative);
  }

  /**
   * Generate daily report
   */
  private async generateDailyReport(options: ReportOptions): Promise<string> {
    const days = options.days ?? 7;
    const dailyPnl = await this.pnlCalculator.getDailyPnL(days);

    if (options.format === 'json') {
      return JSON.stringify({ daily: dailyPnl }, null, 2);
    }

    if (options.format === 'csv') {
      const headers = ['date', 'realized_pnl', 'unrealized_pnl', 'events_captured', 'events_followed', 'positions_opened', 'positions_closed'];
      const rows = dailyPnl.map(d => [
        d.date,
        d.realizedPnl.toFixed(2),
        d.unrealizedPnl.toFixed(2),
        d.eventsCaptured.toString(),
        d.eventsFollowed.toString(),
        d.positionsOpened.toString(),
        d.positionsClosed.toString(),
      ]);
      return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    return this.dailyToText(dailyPnl);
  }

  /**
   * Generate leaders report
   */
  private async generateLeadersReport(options: ReportOptions): Promise<string> {
    const comparison = await this.leaderAnalyzer.compareLeaders();

    if (options.format === 'json') {
      return JSON.stringify(comparison, null, 2);
    }

    if (options.format === 'csv') {
      return this.leadersToCSV(comparison.leaders);
    }

    return this.leadersToText(comparison);
  }

  /**
   * Generate positions report
   */
  private async generatePositionsReport(options: ReportOptions): Promise<string> {
    const pnl = await this.pnlCalculator.calculatePnLSummary();

    if (options.format === 'json') {
      return JSON.stringify({ positions: pnl.positions }, null, 2);
    }

    if (options.format === 'csv') {
      return this.positionsToCSV(pnl);
    }

    return this.positionsToText(pnl);
  }

  /**
   * Generate full report formatted
   */
  private async generateFullReportFormatted(options: ReportOptions): Promise<string> {
    const report = await this.generateFullReport(options.days);

    if (options.format === 'json') {
      return JSON.stringify(report, null, 2);
    }

    if (options.format === 'csv') {
      // Full report doesn't make sense as CSV, return JSON
      return JSON.stringify(report, null, 2);
    }

    return this.fullReportToText(report);
  }

  // ============ Text Formatters ============

  private summaryToText(pnl: PnLSummary, cumulative: CumulativeStats): string {
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════════════════════════',
      '                           COPYHUNTER PNL REPORT                               ',
      '═══════════════════════════════════════════════════════════════════════════════',
      '',
      '📊 PORTFOLIO SUMMARY',
      '───────────────────────────────────────────────────────────────────────────────',
      `  Open Positions:     ${pnl.openPositionCount}`,
      `  Closed Positions:   ${pnl.closedPositionCount}`,
      `  Total Cost Basis:   $${pnl.totalCostBasis.toFixed(2)}`,
      `  Current Value:      $${pnl.totalCurrentValue.toFixed(2)}`,
      '',
      '💰 PNL BREAKDOWN',
      '───────────────────────────────────────────────────────────────────────────────',
      `  Unrealized PnL:     ${this.formatPnL(pnl.totalUnrealizedPnl)} (${pnl.unrealizedPnlPercent.toFixed(2)}%)`,
      `  Realized PnL:       ${this.formatPnL(pnl.totalRealizedPnl)}`,
      `  Total PnL:          ${this.formatPnL(pnl.totalPnl)} (${pnl.totalPnlPercent.toFixed(2)}%)`,
      '',
      '📈 CUMULATIVE STATS',
      '───────────────────────────────────────────────────────────────────────────────',
      `  Trading Days:       ${cumulative.totalDays}`,
      `  Events Captured:    ${cumulative.totalEventsCaptured}`,
      `  Events Followed:    ${cumulative.totalEventsFollowed}`,
      `  Avg Daily PnL:      ${this.formatPnL(cumulative.avgDailyPnl)}`,
      `  Win Rate:           ${cumulative.winRate.toFixed(1)}% (${cumulative.winningDays}W / ${cumulative.losingDays}L)`,
      '',
    ];

    if (cumulative.bestDay) {
      lines.push(`  Best Day:           ${cumulative.bestDay.date} (${this.formatPnL(cumulative.bestDay.realizedPnl)})`);
    }
    if (cumulative.worstDay) {
      lines.push(`  Worst Day:          ${cumulative.worstDay.date} (${this.formatPnL(cumulative.worstDay.realizedPnl)})`);
    }

    lines.push('═══════════════════════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  private dailyToText(daily: Array<{ date: string; realizedPnl: number; eventsCaptured: number; eventsFollowed: number }>): string {
    const lines: string[] = [
      '📅 DAILY PNL',
      '───────────────────────────────────────────────────────────────────────────────',
      '  Date         │  PnL        │  Events   │  Followed',
      '───────────────────────────────────────────────────────────────────────────────',
    ];

    for (const day of daily) {
      const pnlStr = this.formatPnL(day.realizedPnl).padEnd(12);
      lines.push(`  ${day.date}   │  ${pnlStr}│  ${day.eventsCaptured.toString().padEnd(9)}│  ${day.eventsFollowed}`);
    }

    lines.push('───────────────────────────────────────────────────────────────────────────────');
    return lines.join('\n');
  }

  private leadersToText(comparison: LeaderComparison): string {
    const lines: string[] = [
      '👥 LEADERS ANALYSIS',
      '═══════════════════════════════════════════════════════════════════════════════',
      '',
      `  Total Leaders:      ${comparison.summary.totalLeaders}`,
      `  Total Trades:       ${comparison.summary.totalTrades}`,
      `  Total Volume:       $${comparison.summary.totalVolume.toFixed(2)}`,
      `  Avg Win Rate:       ${comparison.summary.avgWinRate.toFixed(1)}%`,
      `  Avg PnL:            ${this.formatPnL(comparison.summary.avgPnl)}`,
      '',
      '🏆 TOP PERFORMERS',
      '───────────────────────────────────────────────────────────────────────────────',
    ];

    if (comparison.best.byPnl) {
      lines.push(`  Best by PnL:        ${this.shortAddress(comparison.best.byPnl.address)} (${this.formatPnL(comparison.best.byPnl.totalPnl)})`);
    }
    if (comparison.best.byWinRate) {
      lines.push(`  Best Win Rate:      ${this.shortAddress(comparison.best.byWinRate.address)} (${comparison.best.byWinRate.winRate.toFixed(1)}%)`);
    }
    if (comparison.best.byVolume) {
      lines.push(`  Highest Volume:     ${this.shortAddress(comparison.best.byVolume.address)} ($${comparison.best.byVolume.totalVolume.toFixed(2)})`);
    }
    if (comparison.best.byTrades) {
      lines.push(`  Most Active:        ${this.shortAddress(comparison.best.byTrades.address)} (${comparison.best.byTrades.totalTrades} trades)`);
    }

    lines.push('');
    lines.push('📋 ALL LEADERS');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('  Address        │  Trades  │  Volume      │  Win%   │  PnL');
    lines.push('───────────────────────────────────────────────────────────────────────────────');

    for (const leader of comparison.leaders.slice(0, 20)) {
      lines.push(
        `  ${this.shortAddress(leader.address).padEnd(14)}│  ${leader.totalTrades.toString().padEnd(8)}│  $${leader.totalVolume.toFixed(0).padEnd(10)}│  ${leader.winRate.toFixed(1).padEnd(7)}│  ${this.formatPnL(leader.totalPnl)}`
      );
    }

    lines.push('═══════════════════════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  private positionsToText(pnl: PnLSummary): string {
    const lines: string[] = [
      '📦 OPEN POSITIONS',
      '═══════════════════════════════════════════════════════════════════════════════',
    ];

    if (pnl.positions.length === 0) {
      lines.push('  No open positions.');
    } else {
      lines.push('  Market                         │  Side │  Qty     │  Cost    │  Value   │  PnL');
      lines.push('───────────────────────────────────────────────────────────────────────────────');

      for (const pos of pnl.positions) {
        const title = (pos.position.marketTitle || pos.position.conditionId).slice(0, 30).padEnd(30);
        lines.push(
          `  ${title}│  ${pos.position.outcome.padEnd(5)}│  ${pos.position.quantity.toFixed(1).padEnd(8)}│  $${pos.position.costBasis.toFixed(0).padEnd(6)}│  $${pos.currentValue.toFixed(0).padEnd(6)}│  ${this.formatPnL(pos.unrealizedPnl)}`
        );
      }
    }

    lines.push('═══════════════════════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  private fullReportToText(report: FullReport): string {
    const pnlText = this.summaryToText(report.pnl, report.cumulative);
    const leadersText = this.leadersToText(report.leaders);
    const positionsText = this.positionsToText(report.pnl);

    const orderLines = [
      '',
      '📝 ORDERS',
      '───────────────────────────────────────────────────────────────────────────────',
      `  Total:     ${report.orders.total}`,
      `  Executed:  ${report.orders.executed}`,
      `  Failed:    ${report.orders.failed}`,
      `  Pending:   ${report.orders.pending}`,
      '',
    ];

    return [
      `Generated: ${report.generatedAt}`,
      `Period: ${report.period.from} to ${report.period.to} (${report.period.days} days)`,
      '',
      pnlText,
      '',
      leadersText,
      '',
      positionsText,
      orderLines.join('\n'),
    ].join('\n');
  }

  // ============ CSV Formatters ============

  private summaryToCSV(pnl: PnLSummary, cumulative: CumulativeStats): string {
    const lines = [
      'metric,value',
      `open_positions,${pnl.openPositionCount}`,
      `closed_positions,${pnl.closedPositionCount}`,
      `total_cost_basis,${pnl.totalCostBasis.toFixed(2)}`,
      `total_current_value,${pnl.totalCurrentValue.toFixed(2)}`,
      `unrealized_pnl,${pnl.totalUnrealizedPnl.toFixed(2)}`,
      `unrealized_pnl_percent,${pnl.unrealizedPnlPercent.toFixed(2)}`,
      `realized_pnl,${pnl.totalRealizedPnl.toFixed(2)}`,
      `total_pnl,${pnl.totalPnl.toFixed(2)}`,
      `total_pnl_percent,${pnl.totalPnlPercent.toFixed(2)}`,
      `trading_days,${cumulative.totalDays}`,
      `events_captured,${cumulative.totalEventsCaptured}`,
      `events_followed,${cumulative.totalEventsFollowed}`,
      `avg_daily_pnl,${cumulative.avgDailyPnl.toFixed(2)}`,
      `win_rate,${cumulative.winRate.toFixed(2)}`,
      `winning_days,${cumulative.winningDays}`,
      `losing_days,${cumulative.losingDays}`,
    ];
    return lines.join('\n');
  }

  private leadersToCSV(leaders: LeaderMetrics[]): string {
    const headers = [
      'address',
      'alias',
      'total_trades',
      'buy_trades',
      'sell_trades',
      'total_volume',
      'avg_trade_size',
      'win_rate',
      'total_pnl',
      'avg_pnl_per_trade',
      'avg_hold_duration_hours',
      'open_positions',
      'closed_positions',
    ];

    const rows = leaders.map(l => [
      l.address,
      l.alias || '',
      l.totalTrades,
      l.buyTrades,
      l.sellTrades,
      l.totalVolume.toFixed(2),
      l.avgTradeSize.toFixed(2),
      l.winRate.toFixed(2),
      l.totalPnl.toFixed(2),
      l.avgPnlPerTrade.toFixed(2),
      l.avgHoldDuration.toFixed(2),
      l.openPositions,
      l.closedPositions,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  private positionsToCSV(pnl: PnLSummary): string {
    const headers = [
      'condition_id',
      'market_title',
      'outcome',
      'quantity',
      'avg_price',
      'cost_basis',
      'current_price',
      'current_value',
      'unrealized_pnl',
      'unrealized_pnl_percent',
      'leader_address',
    ];

    const rows = pnl.positions.map(p => [
      p.position.conditionId,
      `"${(p.position.marketTitle || '').replace(/"/g, '""')}"`,
      p.position.outcome,
      p.position.quantity.toFixed(4),
      p.position.avgPrice.toFixed(4),
      p.position.costBasis.toFixed(2),
      p.currentPrice.toFixed(4),
      p.currentValue.toFixed(2),
      p.unrealizedPnl.toFixed(2),
      p.unrealizedPnlPercent.toFixed(2),
      p.position.leaderAddress,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  // ============ Helpers ============

  private formatPnL(value: number): string {
    const prefix = value >= 0 ? '+' : '';
    return `${prefix}$${value.toFixed(2)}`;
  }

  private shortAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

// Singleton
let generator: ReportGenerator | null = null;

export function getReportGenerator(): ReportGenerator {
  if (!generator) {
    generator = new ReportGenerator();
  }
  return generator;
}
