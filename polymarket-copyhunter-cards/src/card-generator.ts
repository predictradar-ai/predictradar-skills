/**
 * CopyHunter Share Card Generator
 *
 * Generate social sharing cards for copy trading results using pure Canvas 2D
 */

import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { CardData, CardOptions, CardResult, ThemeColors } from './types.js';
import { DARK_THEME } from './types.js';

// Default card dimensions (Twitter/Open Graph standard)
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 630;

/**
 * Draw a rounded rectangle path
 */
function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Format PnL value for display
 */
function formatPnL(value: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Draw trend chart using Canvas 2D
 */
function drawTrendChart(
  ctx: SKRSContext2D,
  data: Array<{ date: string; pnl: number }>,
  x: number,
  y: number,
  width: number,
  height: number,
  colors: ThemeColors
): void {
  const padding = { left: 50, right: 20, top: 20, bottom: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Calculate data range
  const pnlValues = data.map((d) => d.pnl);
  const minPnl = Math.min(...pnlValues, 0);
  const maxPnl = Math.max(...pnlValues, 0);
  const range = maxPnl - minPnl || 1;

  // Draw grid lines
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);

  for (let i = 0; i <= 4; i++) {
    const gridY = y + padding.top + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(x + padding.left, gridY);
    ctx.lineTo(x + width - padding.right, gridY);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draw zero line if applicable
  if (minPnl < 0 && maxPnl > 0) {
    const zeroY = y + padding.top + chartHeight * (maxPnl / range);
    ctx.strokeStyle = colors.textMuted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + padding.left, zeroY);
    ctx.lineTo(x + width - padding.right, zeroY);
    ctx.stroke();
  }

  // Calculate point coordinates
  const points = data.map((d, i) => ({
    x: x + padding.left + (chartWidth / (data.length - 1)) * i,
    y: y + padding.top + chartHeight * ((maxPnl - d.pnl) / range),
    pnl: d.pnl,
  }));

  // Draw filled area
  ctx.beginPath();
  ctx.moveTo(points[0].x, y + padding.top + chartHeight);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, y + padding.top + chartHeight);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(
    0,
    y + padding.top,
    0,
    y + height - padding.bottom
  );
  gradient.addColorStop(0, 'rgba(139, 92, 246, 0.3)');
  gradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw line
  ctx.strokeStyle = colors.chartLine;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  // Draw end point
  const lastPoint = points[points.length - 1];
  ctx.fillStyle = lastPoint.pnl >= 0 ? colors.profit : colors.loss;
  ctx.beginPath();
  ctx.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw Y-axis labels
  ctx.fillStyle = colors.textMuted;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yLabels = [maxPnl, maxPnl * 0.5, 0, minPnl * 0.5, minPnl];
  yLabels.forEach((val, i) => {
    const labelY = y + padding.top + (chartHeight / 4) * i;
    ctx.fillText(formatPnL(val), x + padding.left - 8, labelY);
  });

  // Draw X-axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const firstDate = data[0].date;
  const lastDate = data[data.length - 1].date;
  ctx.fillText(firstDate, x + padding.left, y + height - padding.bottom + 8);
  ctx.fillText(lastDate, x + width - padding.right, y + height - padding.bottom + 8);
}

/**
 * Generate PnL share card
 */
export async function generatePnLCard(
  data: CardData,
  options: CardOptions = {}
): Promise<CardResult> {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const colors = DARK_THEME; // TODO: support light theme

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ============ Background ============
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, colors.bgGradientStart);
  bgGradient.addColorStop(1, colors.bgGradientEnd);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // ============ Header ============
  const headerY = 30;

  // Logo text
  ctx.fillStyle = colors.primary;
  ctx.font = 'bold 28px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('COPYHUNTER', 40, headerY);

  // Subtitle
  ctx.fillStyle = colors.textSecondary;
  ctx.font = '16px sans-serif';
  ctx.fillText('My Copy Trading Results', 40, headerY + 36);

  // Mode badge
  const modeText = data.mode.toUpperCase() + ' MODE';
  ctx.fillStyle = data.mode === 'live' ? colors.profit : colors.primary;
  ctx.font = 'bold 14px sans-serif';
  const modeWidth = ctx.measureText(modeText).width;
  roundRect(ctx, width - 40 - modeWidth - 20, headerY, modeWidth + 20, 28, 14);
  ctx.fillStyle =
    data.mode === 'live' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(99, 102, 241, 0.2)';
  ctx.fill();
  ctx.fillStyle = data.mode === 'live' ? colors.profit : colors.primary;
  ctx.textAlign = 'center';
  ctx.fillText(modeText, width - 40 - modeWidth / 2 - 10, headerY + 7);
  ctx.textAlign = 'left';

  // ============ PnL Cards ============
  const cardY = 100;
  const cardHeight = 120;
  const cardWidth = 280;
  const cardGap = 40;

  // Left card - Total PnL
  roundRect(ctx, 40, cardY, cardWidth, cardHeight, 12);
  ctx.fillStyle = colors.cardBg;
  ctx.fill();

  ctx.fillStyle = colors.textSecondary;
  ctx.font = '14px sans-serif';
  ctx.fillText('MY TOTAL PNL', 60, cardY + 24);

  const pnlColor = data.pnl.total >= 0 ? colors.profit : colors.loss;
  ctx.fillStyle = pnlColor;
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(formatPnL(data.pnl.total), 60, cardY + 50);

  ctx.font = 'bold 18px sans-serif';
  const percentText = `(${data.pnl.total >= 0 ? '+' : ''}${data.pnl.totalPercent.toFixed(1)}%)`;
  ctx.fillText(percentText, 60, cardY + 92);

  // Right card - Performance
  roundRect(ctx, 40 + cardWidth + cardGap, cardY, cardWidth, cardHeight, 12);
  ctx.fillStyle = colors.cardBg;
  ctx.fill();

  ctx.fillStyle = colors.textSecondary;
  ctx.font = '14px sans-serif';
  ctx.fillText('MY PERFORMANCE', 60 + cardWidth + cardGap, cardY + 24);

  ctx.fillStyle = colors.textPrimary;
  ctx.font = '16px sans-serif';
  const perfX = 60 + cardWidth + cardGap;
  ctx.fillText(`Win Rate:  ${data.stats.winRate.toFixed(1)}%`, perfX, cardY + 52);
  ctx.fillText(`Trades:    ${data.stats.totalTrades}`, perfX, cardY + 76);
  ctx.fillText(`Days:      ${data.stats.tradingDays}`, perfX, cardY + 100);

  // ============ Chart Area ============
  const chartY = cardY + cardHeight + 30;
  const chartHeight2 = 200;
  const chartWidth2 = width - 80;

  // Chart background
  roundRect(ctx, 40, chartY, chartWidth2, chartHeight2, 12);
  ctx.fillStyle = colors.cardBg;
  ctx.fill();

  // Chart title
  ctx.fillStyle = colors.textSecondary;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(
    `PNL TREND (${data.stats.tradingDays} DAYS)`,
    width - 60,
    chartY + 18
  );
  ctx.textAlign = 'left';

  // Draw trend chart
  if (data.trend && data.trend.length > 1) {
    drawTrendChart(
      ctx,
      data.trend,
      50,
      chartY + 5,
      chartWidth2 - 20,
      chartHeight2 - 15,
      colors
    );
  }

  // ============ Footer Stats ============
  const footerY = chartY + chartHeight2 + 20;
  const footerHeight = 60;

  roundRect(ctx, 40, footerY, width - 80, footerHeight, 12);
  ctx.fillStyle = colors.cardBg;
  ctx.fill();

  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';

  const statItems = [
    { label: 'Following', value: `${data.stats.leadersFollowed} Leaders` },
    { label: 'Open', value: data.stats.openPositions.toString() },
    { label: 'Closed', value: data.stats.closedPositions.toString() },
  ];

  const statWidth = (width - 80) / statItems.length;
  statItems.forEach((stat, i) => {
    const statX = 40 + statWidth * i + statWidth / 2;
    ctx.fillStyle = colors.textSecondary;
    ctx.fillText(stat.label, statX, footerY + 20);
    ctx.fillStyle = colors.textPrimary;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(stat.value, statX, footerY + 42);
    ctx.font = '14px sans-serif';
  });

  // ============ Footer ============
  ctx.textAlign = 'left';
  ctx.fillStyle = colors.textMuted;
  ctx.font = '12px sans-serif';
  const generatedAt = data.meta?.generatedAt ?? new Date();
  ctx.fillText(
    `Generated: ${generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    40,
    height - 20
  );

  ctx.textAlign = 'right';
  ctx.fillText('copyhunter.predictradar', width - 40, height - 20);

  // Export
  const buffer = canvas.toBuffer('image/png');
  const base64 = buffer.toString('base64');

  return {
    buffer,
    base64,
    dataUrl: `data:image/png;base64,${base64}`,
    width,
    height,
    format: 'png',
  };
}

/**
 * Generate mock data for testing
 */
export function generateMockData(days: number = 30): CardData {
  const targetPnl = 1234.56;
  const trend: Array<{ date: string; pnl: number }> = [];
  let cumulative = 0;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    const dailyPnl = (Math.random() - 0.35) * 100;
    cumulative += dailyPnl;

    trend.push({
      date: date.toISOString().split('T')[0],
      pnl: Math.round(cumulative * 100) / 100,
    });
  }

  // Scale to target
  const lastPnl = trend[trend.length - 1].pnl;
  const scale = targetPnl / (lastPnl || 1);
  trend.forEach((t) => (t.pnl = Math.round(t.pnl * scale * 100) / 100));

  return {
    mode: 'shadow',
    pnl: {
      total: targetPnl,
      totalPercent: 15.8,
      realized: 800.0,
      unrealized: 434.56,
    },
    stats: {
      winRate: 72.5,
      totalTrades: 156,
      tradingDays: days,
      openPositions: 12,
      closedPositions: 89,
      leadersFollowed: 5,
    },
    trend,
    meta: {
      generatedAt: new Date(),
      periodStart: startDate,
      periodEnd: new Date(),
    },
  };
}
