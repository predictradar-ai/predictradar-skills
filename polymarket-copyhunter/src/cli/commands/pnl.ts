/**
 * CopyHunter - PnL Command
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getPnLCalculator } from '../../analysis/pnl-calculator.js';
import { getLeaderAnalyzer } from '../../analysis/leader-analyzer.js';
import { getReportGenerator } from '../../analysis/report-generator.js';
import type { ReportFormat, ReportType } from '../../analysis/report-generator.js';
import {
  createJsonArrayResponse,
  isJsonOutput,
  markCommandFailed,
  printJson,
  printJsonError,
  printJsonSuccess,
} from '../json-output.js';

const VALID_REPORT_TYPES: ReportType[] = ['summary', 'daily', 'leaders', 'positions', 'full'];
const VALID_REPORT_FORMATS: ReportFormat[] = ['text', 'json', 'csv'];
const VALID_EXPORT_TYPES = ['positions', 'leaders', 'daily', 'all'] as const;
type ExportType = typeof VALID_EXPORT_TYPES[number];

function isJsonMetadataOutput(options: { json?: boolean }): boolean {
  return options.json === true;
}

export function createPnlCommand(): Command {
  const cmd = new Command('pnl')
    .description('View profit and loss');

  // pnl (default - summary)
  cmd
    .action(async () => {
      const calculator = getPnLCalculator();
      const summary = await calculator.calculatePnLSummary();
      const cumulative = await calculator.getCumulativeStats();

      console.log(chalk.bold('\n💰 PnL Summary\n'));

      // Portfolio overview
      console.log(chalk.cyan('Portfolio:'));
      console.log(`  Open Positions:     ${summary.openPositionCount}`);
      console.log(`  Closed Positions:   ${summary.closedPositionCount}`);
      console.log(`  Total Cost Basis:   $${summary.totalCostBasis.toFixed(2)}`);
      console.log(`  Current Value:      $${summary.totalCurrentValue.toFixed(2)}`);

      // PnL breakdown
      console.log(chalk.cyan('\nPnL Breakdown:'));
      const unrealizedColor = summary.totalUnrealizedPnl >= 0 ? chalk.green : chalk.red;
      const realizedColor = summary.totalRealizedPnl >= 0 ? chalk.green : chalk.red;
      const totalColor = summary.totalPnl >= 0 ? chalk.green : chalk.red;

      console.log(`  Unrealized PnL:     ${unrealizedColor(`$${summary.totalUnrealizedPnl.toFixed(2)}`)} (${summary.unrealizedPnlPercent.toFixed(2)}%)`);
      console.log(`  Realized PnL:       ${realizedColor(`$${summary.totalRealizedPnl.toFixed(2)}`)}`);
      console.log(`  Total PnL:          ${totalColor(`$${summary.totalPnl.toFixed(2)}`)} (${summary.totalPnlPercent.toFixed(2)}%)`);

      // Cumulative stats
      if (cumulative.totalDays > 0) {
        console.log(chalk.cyan('\nCumulative Stats:'));
        console.log(`  Trading Days:       ${cumulative.totalDays}`);
        console.log(`  Events Captured:    ${cumulative.totalEventsCaptured}`);
        console.log(`  Events Followed:    ${cumulative.totalEventsFollowed}`);
        const avgColor = cumulative.avgDailyPnl >= 0 ? chalk.green : chalk.red;
        console.log(`  Avg Daily PnL:      ${avgColor(`$${cumulative.avgDailyPnl.toFixed(2)}`)}`);
        console.log(`  Win Rate:           ${cumulative.winRate.toFixed(1)}% (${cumulative.winningDays}W/${cumulative.losingDays}L)`);
      }

      // Open positions table
      if (summary.positions.length > 0) {
        console.log(chalk.bold('\n📦 Open Positions:\n'));
        const table = new Table({
          head: ['Market', 'Side', 'Qty', 'Avg Price', 'Curr Price', 'PnL'],
          colWidths: [32, 6, 10, 12, 12, 14],
        });

        for (const pos of summary.positions) {
          const pnlColor = pos.unrealizedPnl >= 0 ? chalk.green : chalk.red;
          const currentPrice = typeof pos.currentPrice === 'number' ? pos.currentPrice : pos.position.avgPrice;
          const qty = typeof pos.position.quantity === 'number' ? pos.position.quantity : 0;
          const avgPrice = typeof pos.position.avgPrice === 'number' ? pos.position.avgPrice : 0;
          const unrealizedPnl = typeof pos.unrealizedPnl === 'number' ? pos.unrealizedPnl : 0;

          table.push([
            (pos.position.marketTitle || pos.position.conditionId).slice(0, 30),
            pos.position.outcome,
            qty.toFixed(2),
            `$${avgPrice.toFixed(4)}`,
            `$${currentPrice.toFixed(4)}`,
            pnlColor(`$${unrealizedPnl.toFixed(2)}`),
          ]);
        }

        console.log(table.toString());
      } else {
        console.log(chalk.gray('\nNo open positions.'));
      }
    });

  // pnl unrealized
  cmd
    .command('unrealized')
    .description('Show unrealized PnL with current prices')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const calculator = getPnLCalculator();
      const summary = await calculator.calculatePnLSummary();

      if (isJsonOutput(options)) {
        printJson({
          summary: {
            totalCostBasis: summary.totalCostBasis,
            totalCurrentValue: summary.totalCurrentValue,
            unrealizedPnl: summary.totalUnrealizedPnl,
            unrealizedPnlPercent: summary.unrealizedPnlPercent,
          },
          positions: summary.positions.map(p => ({
            conditionId: p.position.conditionId,
            marketTitle: p.position.marketTitle,
            outcome: p.position.outcome,
            quantity: p.position.quantity,
            avgPrice: p.position.avgPrice,
            currentPrice: p.currentPrice,
            costBasis: p.position.costBasis,
            currentValue: p.currentValue,
            unrealizedPnl: p.unrealizedPnl,
            unrealizedPnlPercent: p.unrealizedPnlPercent,
          })),
        });
        return;
      }

      if (summary.positions.length === 0) {
        console.log(chalk.gray('No open positions.'));
        return;
      }

      console.log(chalk.bold('\n📊 Unrealized PnL\n'));
      console.log(`Total Cost Basis:   $${summary.totalCostBasis.toFixed(2)}`);
      console.log(`Current Value:      $${summary.totalCurrentValue.toFixed(2)}`);

      const pnlColor = summary.totalUnrealizedPnl >= 0 ? chalk.green : chalk.red;
      console.log(`Unrealized PnL:     ${pnlColor(`$${summary.totalUnrealizedPnl.toFixed(2)}`)} (${summary.unrealizedPnlPercent.toFixed(2)}%)\n`);

      const table = new Table({
        head: ['Market', 'Side', 'Qty', 'Entry', 'Current', 'Value', 'PnL', '%'],
        colWidths: [28, 5, 8, 8, 8, 10, 10, 8],
      });

      for (const pos of summary.positions) {
        const pnlColor = pos.unrealizedPnl >= 0 ? chalk.green : chalk.red;
        table.push([
          (pos.position.marketTitle || pos.position.conditionId).slice(0, 26),
          pos.position.outcome,
          pos.position.quantity.toFixed(1),
          `$${pos.position.avgPrice.toFixed(3)}`,
          `$${pos.currentPrice.toFixed(3)}`,
          `$${pos.currentValue.toFixed(2)}`,
          pnlColor(`$${pos.unrealizedPnl.toFixed(2)}`),
          pnlColor(`${pos.unrealizedPnlPercent.toFixed(1)}%`),
        ]);
      }

      console.log(table.toString());
    });

  // pnl daily
  cmd
    .command('daily')
    .description('Show daily PnL history')
    .option('-n, --days <n>', 'Number of days', '7')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const calculator = getPnLCalculator();
      const days = parseInt(options.days);
      const dailyPnl = await calculator.getDailyPnL(days);

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('daily', dailyPnl));
        return;
      }

      if (dailyPnl.length === 0) {
        console.log(chalk.gray('No daily stats recorded yet.'));
        return;
      }

      console.log(chalk.bold('\n📈 Daily PnL\n'));

      const table = new Table({
        head: ['Date', 'Events', 'Followed', 'Realized', 'Exposure', 'Positions'],
        colWidths: [12, 10, 10, 14, 12, 12],
      });

      let totalRealized = 0;
      for (const day of dailyPnl) {
        const pnlColor = day.realizedPnl >= 0 ? chalk.green : chalk.red;
        totalRealized += day.realizedPnl;
        table.push([
          day.date,
          day.eventsCaptured,
          day.eventsFollowed,
          pnlColor(`$${day.realizedPnl.toFixed(2)}`),
          `$${day.totalExposure.toFixed(0)}`,
          `+${day.positionsOpened}/-${day.positionsClosed}`,
        ]);
      }

      console.log(table.toString());
      const totalColor = totalRealized >= 0 ? chalk.green : chalk.red;
      console.log(`\nTotal: ${totalColor(`$${totalRealized.toFixed(2)}`)}`);
    });

  // pnl leaders
  cmd
    .command('leaders')
    .description('Show PnL by leader')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const calculator = getPnLCalculator();
      const leaderPnl = await calculator.getPnLByLeader();

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('leaders', leaderPnl));
        return;
      }

      if (leaderPnl.length === 0) {
        console.log(chalk.gray('No leader data available.'));
        return;
      }

      console.log(chalk.bold('\n👥 PnL by Leader\n'));

      const table = new Table({
        head: ['Leader', 'Open', 'Closed', 'Cost', 'Realized', 'Unrealized', 'Total'],
        colWidths: [14, 6, 8, 10, 12, 12, 12],
      });

      for (const leader of leaderPnl) {
        const totalColor = leader.totalPnl >= 0 ? chalk.green : chalk.red;
        table.push([
          `${leader.leaderAddress.slice(0, 6)}...${leader.leaderAddress.slice(-4)}`,
          leader.openPositions,
          leader.closedPositions,
          `$${leader.totalCostBasis.toFixed(0)}`,
          `$${leader.realizedPnl.toFixed(2)}`,
          `$${leader.unrealizedPnl.toFixed(2)}`,
          totalColor(`$${leader.totalPnl.toFixed(2)}`),
        ]);
      }

      console.log(table.toString());
    });

  // pnl analyze
  cmd
    .command('analyze')
    .description('Analyze leader performance')
    .option('-a, --address <address>', 'Analyze specific leader')
    .option('-t, --top <n>', 'Show top N leaders', '10')
    .option('-m, --metric <metric>', 'Sort by: pnl, winRate, volume, trades', 'pnl')
    .option('-o, --output <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const analyzer = getLeaderAnalyzer();

      if (options.address) {
        // Analyze specific leader
        const metrics = await analyzer.getLeaderMetrics(options.address);

        if (!metrics) {
          if (isJsonOutput(options)) {
            printJsonError('leader_not_found', `Leader not found: ${options.address}`, {
              address: options.address,
            });
            return;
          }
          console.log(chalk.red(`Leader not found: ${options.address}`));
          return;
        }

        if (isJsonOutput(options)) {
          printJson(metrics);
          return;
        }

        console.log(chalk.bold(`\n📊 Leader Analysis: ${metrics.alias || metrics.address.slice(0, 10)}...\n`));
        console.log(chalk.cyan('Trading Activity:'));
        console.log(`  Total Trades:       ${metrics.totalTrades}`);
        console.log(`  Buy Trades:         ${metrics.buyTrades}`);
        console.log(`  Sell Trades:        ${metrics.sellTrades}`);
        console.log(`  Trading Days:       ${metrics.tradingDays}`);

        console.log(chalk.cyan('\nVolume:'));
        console.log(`  Total Volume:       $${metrics.totalVolume.toFixed(2)}`);
        console.log(`  Avg Trade Size:     $${metrics.avgTradeSize.toFixed(2)}`);
        console.log(`  Max Trade Size:     $${metrics.maxTradeSize.toFixed(2)}`);

        console.log(chalk.cyan('\nPerformance:'));
        const pnlColor = metrics.totalPnl >= 0 ? chalk.green : chalk.red;
        console.log(`  Win Rate:           ${metrics.winRate.toFixed(1)}%`);
        console.log(`  Total PnL:          ${pnlColor(`$${metrics.totalPnl.toFixed(2)}`)}`);
        console.log(`  Avg PnL/Trade:      $${metrics.avgPnlPerTrade.toFixed(2)}`);
        console.log(`  Avg Hold Duration:  ${metrics.avgHoldDuration.toFixed(1)} hours`);

        console.log(chalk.cyan('\nPositions:'));
        console.log(`  Open:               ${metrics.openPositions}`);
        console.log(`  Closed:             ${metrics.closedPositions}`);

        // Get trade distribution
        const distribution = await analyzer.getTradeDistribution(options.address);

        console.log(chalk.cyan('\nTrade Distribution:'));
        console.log(`  By Outcome:         YES: ${distribution.byOutcome.YES}, NO: ${distribution.byOutcome.NO}`);
        console.log(`  By Type:            BUY: ${distribution.byType.BUY}, SELL: ${distribution.byType.SELL}`);

        return;
      }

      // Compare all leaders
      const limit = parseInt(options.top);
      const metric = options.metric as 'pnl' | 'winRate' | 'volume' | 'trades';
      const topLeaders = await analyzer.getTopLeaders(metric, limit);

      if (isJsonOutput(options)) {
        printJson(createJsonArrayResponse('leaders', topLeaders, { metric, limit }));
        return;
      }

      if (topLeaders.length === 0) {
        console.log(chalk.gray('No leader data available.'));
        return;
      }

      console.log(chalk.bold(`\n🏆 Top ${limit} Leaders by ${metric}\n`));

      const table = new Table({
        head: ['#', 'Leader', 'Trades', 'Volume', 'Win%', 'PnL', 'Avg Hold'],
        colWidths: [4, 14, 8, 12, 8, 12, 10],
      });

      topLeaders.forEach((leader, index) => {
        const pnlColor = leader.totalPnl >= 0 ? chalk.green : chalk.red;
        table.push([
          index + 1,
          `${leader.address.slice(0, 6)}...${leader.address.slice(-4)}`,
          leader.totalTrades,
          `$${leader.totalVolume.toFixed(0)}`,
          `${leader.winRate.toFixed(1)}%`,
          pnlColor(`$${leader.totalPnl.toFixed(2)}`),
          `${leader.avgHoldDuration.toFixed(1)}h`,
        ]);
      });

      console.log(table.toString());
    });

  // pnl report
  cmd
    .command('report')
    .description('Generate detailed report')
    .option('-t, --type <type>', 'Report type: summary, daily, leaders, positions, full', 'summary')
    .option('-f, --format <format>', 'Output format: text, json, csv', 'text')
    .option('-n, --days <n>', 'Number of days for report', '30')
    .option('-o, --output <file>', 'Output to file (optional)')
    .option('--json', 'Print file-operation metadata as JSON', false)
    .action(async (options) => {
      const generator = getReportGenerator();
      const jsonMetadata = isJsonMetadataOutput(options);

      const reportType = options.type as ReportType;
      const format = options.format as ReportFormat;
      const days = parseInt(options.days);

      if (!VALID_REPORT_TYPES.includes(reportType)) {
        if (jsonMetadata) {
          printJsonError('invalid_report_type', `Unknown report type: ${options.type}`, {
            type: options.type,
            validTypes: VALID_REPORT_TYPES,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Unknown report type: ${options.type}`));
        console.log(`Available types: ${VALID_REPORT_TYPES.join(', ')}`);
        return;
      }

      if (!VALID_REPORT_FORMATS.includes(format)) {
        if (jsonMetadata) {
          printJsonError('invalid_report_format', `Unknown report format: ${options.format}`, {
            format: options.format,
            validFormats: VALID_REPORT_FORMATS,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Unknown report format: ${options.format}`));
        console.log(`Available formats: ${VALID_REPORT_FORMATS.join(', ')}`);
        return;
      }

      if ((Number.isNaN(days) || days < 1) && jsonMetadata) {
        printJsonError('invalid_days', '--days must be a positive integer.', {
          days: options.days,
        });
        return;
      }

      if (Number.isNaN(days) || days < 1) {
        markCommandFailed();
        console.log(chalk.red('Error: --days must be a positive integer'));
        return;
      }

      if (jsonMetadata && !options.output) {
        printJsonError('output_required', '--json requires --output for pnl report.', {
          command: 'copyhunter pnl report --output <file> --json',
        });
        return;
      }

      try {
        const report = await generator.generate(reportType, {
          format,
          days,
        });

        if (options.output) {
          const fs = await import('fs');
          fs.writeFileSync(options.output, report);

          if (jsonMetadata) {
            printJsonSuccess('pnl_report_saved', `Report saved to: ${options.output}`, {
              type: reportType,
              format,
              days,
              outputFile: options.output,
              bytes: Buffer.byteLength(report, 'utf-8'),
            });
            return;
          }

          console.log(chalk.green(`Report saved to: ${options.output}`));
          return;
        }

        console.log(report);
      } catch (error) {
        if (jsonMetadata) {
          printJsonError('pnl_report_failed', error instanceof Error ? error.message : String(error), {
            type: reportType,
            format,
            days,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Failed to generate report: ${error instanceof Error ? error.message : error}`));
      }
    });

  // pnl export
  cmd
    .command('export')
    .description('Export data to file')
    .argument('<type>', 'Data type: positions, leaders, daily, all')
    .option('-f, --format <format>', 'Output format: json, csv', 'json')
    .option('-o, --output <file>', 'Output file path')
    .option('--json', 'Print file-operation metadata as JSON', false)
    .action(async (type, options) => {
      const generator = getReportGenerator();
      const format = options.format as ReportFormat;
      const jsonMetadata = isJsonMetadataOutput(options);

      if (!VALID_EXPORT_TYPES.includes(type as ExportType)) {
        if (jsonMetadata) {
          printJsonError('invalid_export_type', `Unknown type: ${type}`, {
            type,
            validTypes: VALID_EXPORT_TYPES,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Unknown type: ${type}`));
        console.log(`Available types: ${VALID_EXPORT_TYPES.join(', ')}`);
        return;
      }

      if (format !== 'json' && format !== 'csv') {
        if (jsonMetadata) {
          printJsonError('invalid_export_format', `Unknown export format: ${options.format}`, {
            format: options.format,
            validFormats: ['json', 'csv'],
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Unknown export format: ${options.format}`));
        console.log('Available formats: json, csv');
        return;
      }

      let data: string;

      try {
        switch (type as ExportType) {
        case 'positions':
          data = await generator.generate('positions', { format });
          break;
        case 'leaders':
          data = await generator.generate('leaders', { format });
          break;
        case 'daily':
          data = await generator.generate('daily', { format, days: 365 });
          break;
        case 'all':
          data = await generator.generate('full', { format });
          break;
        }

        const outputFile = options.output || `copyhunter-${type}-${Date.now()}.${format}`;

        const fs = await import('fs');
        fs.writeFileSync(outputFile, data);

        if (jsonMetadata) {
          printJsonSuccess('pnl_export_saved', `Exported to: ${outputFile}`, {
            exportType: type,
            format,
            outputFile,
            bytes: Buffer.byteLength(data, 'utf-8'),
          });
          return;
        }

        console.log(chalk.green(`Exported to: ${outputFile}`));
      } catch (error) {
        if (jsonMetadata) {
          printJsonError('pnl_export_failed', error instanceof Error ? error.message : String(error), {
            exportType: type,
            format,
          });
          return;
        }
        markCommandFailed();
        console.log(chalk.red(`Failed to export data: ${error instanceof Error ? error.message : error}`));
      }
    });

  return cmd;
}
