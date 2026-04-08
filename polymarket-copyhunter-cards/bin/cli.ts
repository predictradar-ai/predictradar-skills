#!/usr/bin/env node

/**
 * CopyHunter Share Card CLI
 *
 * Generate social sharing cards for copy trading results.
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generatePnLCard, generateMockData } from '../src/card-generator.js';
import type { CardData, CardJsonOutput } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command();

program
  .name('copyhunter-share')
  .description('Generate social sharing cards for copy trading results')
  .version(pkg.version);

// pnl command - generate PnL share card
program
  .command('pnl')
  .description('Generate PnL share card')
  .option('--stdin', 'Read card data from stdin (JSON)')
  .option('--mock', 'Use mock data for testing')
  .option('--days <number>', 'Number of days for mock data', '30')
  .option('-o, --output <path>', 'Save PNG to file')
  .option('--json', 'Output JSON with base64 image (for AI Agent)')
  .action(async (options) => {
    try {
      let data: CardData;

      if (options.stdin) {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        const input = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(input);

        // Handle both direct CardData and copyhunter report output
        if (parsed.pnl && parsed.stats) {
          data = parsed as CardData;
        } else if (parsed.summary) {
          // Convert copyhunter report format to CardData
          data = {
            mode: parsed.mode || 'shadow',
            pnl: {
              total: parsed.summary.totalPnl || 0,
              totalPercent: parsed.summary.totalPnlPercent || 0,
              realized: parsed.summary.realizedPnl || 0,
              unrealized: parsed.summary.unrealizedPnl || 0,
            },
            stats: {
              winRate: parsed.summary.winRate || 0,
              totalTrades: parsed.summary.totalTrades || 0,
              tradingDays: parsed.summary.tradingDays || 0,
              openPositions: parsed.summary.openPositions || 0,
              closedPositions: parsed.summary.closedPositions || 0,
              leadersFollowed: parsed.summary.leadersFollowed || 0,
            },
            trend: parsed.dailyPnl || [],
            meta: {
              generatedAt: new Date(),
              periodStart: new Date(parsed.periodStart || Date.now() - 30 * 24 * 60 * 60 * 1000),
              periodEnd: new Date(parsed.periodEnd || Date.now()),
            },
          };
        } else {
          throw new Error('Invalid input format. Expected CardData or copyhunter report JSON.');
        }
      } else if (options.mock) {
        // Generate mock data
        const days = parseInt(options.days, 10) || 30;
        data = generateMockData(days);
      } else {
        console.error('Error: Please provide --stdin or --mock option');
        process.exit(1);
      }

      // Generate card
      const result = await generatePnLCard(data);

      // Output
      if (options.output) {
        // Save to file
        const outputPath = path.resolve(options.output);
        fs.writeFileSync(outputPath, result.buffer);
        console.log(`Card saved to: ${outputPath}`);
        console.log(`Size: ${result.buffer.length} bytes (${(result.buffer.length / 1024).toFixed(1)} KB)`);
      } else if (options.json) {
        // JSON output for AI Agent
        const output: CardJsonOutput = {
          success: true,
          card: {
            type: 'pnl',
            width: result.width,
            height: result.height,
            format: result.format,
            base64: result.base64,
            dataUrl: result.dataUrl,
          },
          data: {
            mode: data.mode,
            totalPnl: data.pnl.total,
            totalPnlPercent: data.pnl.totalPercent,
            realizedPnl: data.pnl.realized,
            unrealizedPnl: data.pnl.unrealized,
            winRate: data.stats.winRate,
            totalTrades: data.stats.totalTrades,
            tradingDays: data.stats.tradingDays,
            openPositions: data.stats.openPositions,
            closedPositions: data.stats.closedPositions,
            leadersFollowed: data.stats.leadersFollowed,
          },
          generatedAt: new Date().toISOString(),
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        // Default: save to current directory
        const outputPath = path.join(process.cwd(), 'share-card.png');
        fs.writeFileSync(outputPath, result.buffer);
        console.log(`Card saved to: ${outputPath}`);
        console.log(`Size: ${result.buffer.length} bytes (${(result.buffer.length / 1024).toFixed(1)} KB)`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
