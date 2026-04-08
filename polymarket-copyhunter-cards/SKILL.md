---
name: polymarket-copyhunter-cards
description: Social share card generator for CopyHunter copy trading results. Use this skill when you need to generate PNG image cards showing copy trading performance (PnL, win rate, trade statistics) for sharing on social media or IM platforms (Slack, Discord, Telegram).
license: MIT
compatibility: Node.js 18+, macOS/Linux/Windows
metadata:
  version: 1.0.0
  author: predictradar.ai
  category: visualization
  related: polymarket-copyhunter
---

# CopyHunter Share

Social share card generator for copy trading results. Generate PNG image cards showing your copy trading performance for sharing on social media or sending via IM platforms.

> **Note**: This is a companion skill to `polymarket-copyhunter`. Install this skill separately when you need image generation capabilities. The `@napi-rs/canvas` dependency (~50MB) is intentionally separate to keep the main `copyhunter` CLI lightweight.

The skill folder is `polymarket-copyhunter-cards`. The CLI command remains `copyhunter-share`.

## Prerequisites

### System Requirements

- **Node.js**: Version 18.0.0 or higher
- **Operating System**: macOS, Linux, or Windows

### Related Skills

- **polymarket-copyhunter**: Main copy trading skill (required for real data)

## Installation

```bash
# Navigate to the skill directory
cd polymarket-copyhunter-cards

# Install dependencies
npm install

# Test with mock data
npx tsx bin/cli.ts pnl --mock --output ./test-card.png
```

## Quick Start

```bash
# Generate card with mock data
npx tsx bin/cli.ts pnl --mock --output ./my-card.png

# Generate card from copyhunter report
copyhunter pnl report -t full -f json | npx tsx bin/cli.ts pnl --stdin --output ./my-card.png

# Output JSON with base64 image (for AI Agent)
npx tsx bin/cli.ts pnl --mock --json
```

## Commands Reference

### Generate PnL Card

```bash
# Using mock data (for testing)
copyhunter-share pnl --mock [--days <N>]

# From stdin (pipe from copyhunter)
copyhunter-share pnl --stdin

# Save to file
copyhunter-share pnl --mock --output ./card.png

# JSON output with base64 (for AI Agent)
copyhunter-share pnl --mock --json
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--stdin` | Read card data from stdin (JSON) | - |
| `--mock` | Use mock data for testing | - |
| `--days <N>` | Number of days for mock data | `30` |
| `-o, --output <path>` | Save PNG to file | `./share-card.png` |
| `--json` | Output JSON with base64 image | - |

## Input Data Format

When using `--stdin`, provide JSON in this format:

```json
{
  "mode": "shadow",
  "pnl": {
    "total": 1234.56,
    "totalPercent": 15.8,
    "realized": 800.00,
    "unrealized": 434.56
  },
  "stats": {
    "winRate": 72.5,
    "totalTrades": 156,
    "tradingDays": 30,
    "openPositions": 12,
    "closedPositions": 89,
    "leadersFollowed": 5
  },
  "trend": [
    { "date": "2024-01-01", "pnl": 100.00 },
    { "date": "2024-01-02", "pnl": 250.00 }
  ]
}
```

## Output JSON Format

When using `--json`, output includes base64 encoded image:

```json
{
  "success": true,
  "card": {
    "type": "pnl",
    "width": 1200,
    "height": 630,
    "format": "png",
    "base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  },
  "data": {
    "mode": "shadow",
    "totalPnl": 1234.56,
    "totalPnlPercent": 15.8,
    "winRate": 72.5,
    "totalTrades": 156
  },
  "generatedAt": "2024-01-15T14:30:00Z"
}
```

## Integration with CopyHunter

```bash
# Generate report from copyhunter, pipe to share card generator
copyhunter pnl report -t full -f json | copyhunter-share pnl --stdin --json

# Save the card image directly
copyhunter pnl report -t full -f json | copyhunter-share pnl --stdin --output ./pnl-card.png
```

## AI Agent Integration

### Sending to Slack

```bash
# Generate card and upload to Slack
copyhunter pnl report -t full -f json | copyhunter-share pnl --stdin --output /tmp/pnl.png

curl -F file=@/tmp/pnl.png \
     -F channels=$SLACK_CHANNEL \
     -H "Authorization: Bearer $SLACK_TOKEN" \
     https://slack.com/api/files.upload
```

### Using Base64 Output

```bash
# Get base64 image for programmatic use
result=$(copyhunter-share pnl --mock --json)
base64_image=$(echo $result | jq -r '.card.base64')
```

## Card Specifications

| Property | Value |
|----------|-------|
| Width | 1200 px |
| Height | 630 px |
| Format | PNG |
| Theme | Dark (gradient background) |
| Standard | Twitter/Open Graph compatible |

## Architecture

```
polymarket-copyhunter-cards/
├── bin/
│   └── cli.ts              # CLI entry point
├── src/
│   ├── index.ts            # Exports
│   ├── types.ts            # Type definitions
│   └── card-generator.ts   # Canvas rendering logic
└── package.json
```

## Why Separate Skill?

- `@napi-rs/canvas` is ~50MB (precompiled Rust binary)
- Main `polymarket-copyhunter` skill stays lightweight for fast installation
- Users who don't need image generation don't pay the dependency cost
- AI Agent can selectively install this skill when needed

## License

MIT
