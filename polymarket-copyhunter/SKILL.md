---
name: polymarket-copyhunter
description: Smart money copy trading skill for prediction markets. Use this skill when you need to track whale traders, monitor their positions, analyze trading performance, or execute copy trades on Polymarket. Supports shadow mode (simulation) and live trading with configurable risk limits. All data stays on your local machine for complete privacy and security, with no extra fees.
license: MIT
compatibility: Node.js 20+, macOS/Linux/Windows(WSL), requires polymarket-cli for live trading
metadata:
  version: 0.1.0
  author: predictradar.ai
  platforms: polymarket
  category: trading
---

# CopyHunter

Smart money copy trading terminal for prediction markets. Track whale traders, analyze their performance, and automatically follow their trades in shadow or live mode. All data stays on your local machine for complete privacy and security, with no extra fees.

The skill folder is `polymarket-copyhunter`. The CLI command remains `copyhunter`.

## Prerequisites

### System Requirements

- **Node.js**: Version 20.0.0 or higher
- **Operating System**: macOS, Linux, or Windows (WSL recommended for Windows)
- **Network**: Internet connection for API access

### Polymarket CLI (Required for Live Trading)

CopyHunter depends on [polymarket-cli](https://github.com/Polymarket/polymarket-cli) for executing trades on Polymarket.

#### Installation Options

**Option 1: Homebrew (macOS)**

```bash
brew tap Polymarket/polymarket-cli https://github.com/Polymarket/polymarket-cli
brew install polymarket
```

**Option 2: Shell Script**

```bash
curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh
```

**Option 3: Build from Source**

```bash
git clone https://github.com/Polymarket/polymarket-cli
cd polymarket-cli
cargo install --path .
```

**Windows Users**: Use WSL (Windows Subsystem for Linux) or build from source with Cargo. Native Windows support may have limited testing.

#### Wallet Setup

```bash
# Create a new wallet
polymarket wallet create

# Or import an existing wallet
polymarket wallet import 0xYOUR_PRIVATE_KEY

# Verify wallet address
polymarket wallet address
```

#### API Key Configuration

```bash
# Create API key for CLOB access
polymarket clob create-api-key

# List existing API keys
polymarket clob api-keys
```

Configuration is stored in `~/.config/polymarket/config.json`.

> **Security Warning**: Private keys are stored as plaintext in the config file. Use with caution and avoid storing large amounts of funds.

## Installation

```bash
# Clone or navigate to the skill directory
cd polymarket-copyhunter

# Install dependencies
npm install

# Run CLI
npm start

# Or use tsx directly
npx tsx bin/copyhunter.ts
```

## Quick Start

```bash
# 1. Add a leader (whale trader) to monitor
copyhunter leaders add 0x1234...abcd --alias "TopTrader" --tags "whale,consistent"

# 2. Enable shadow mode and configure sizing/risk
copyhunter follow shadow --sizing proportional --bankroll 1000 --max-per-trade 20

# 3. Configure the follower wallet used for live reconcile
copyhunter config set follow.followerAddress 0xYOUR_FOLLOWER_ADDRESS

# 4. Start the watch daemon with follow engine enabled
copyhunter watch start --follow

# 5. Inspect follow status / positions
copyhunter follow status
copyhunter follow positions

# 6. Check PnL performance
copyhunter pnl

# 7. When ready, enable live trading (requires polymarket-cli)
copyhunter follow live --sizing proportional --bankroll 1000 --max-per-trade 20 --daily-limit 500 --confirm
```

## Commands Reference

### Leaders Management

Manage the list of traders you want to monitor and follow.

```bash
# Add a leader with optional metadata
copyhunter leaders add <ADDRESS> [--alias <name>] [--tags <tag1,tag2>]

# List all monitored leaders
copyhunter leaders list
copyhunter leaders list -o json

# Show detailed stats for a leader
copyhunter leaders stats <ADDRESS>

# Remove a leader from monitoring
copyhunter leaders remove <ADDRESS>

# Import top traders from leaderboard
copyhunter leaders import --top 10 --period monthly
copyhunter leaders import --top 10 --period monthly --dry-run -o json

# Refresh cached stats from closed positions
copyhunter leaders refresh
copyhunter leaders refresh -o json
```

### Watch Mode

Monitor leader activities in real-time.

```bash
# Start monitoring in the background
copyhunter watch start [--interval <ms>] [--follow]

# Check watch status
copyhunter watch status

# Stream events in real-time
copyhunter watch stream
copyhunter watch stream -o json

# Run a single poll cycle
copyhunter watch poll
copyhunter watch poll -o json

# Reconcile local events against Polymarket trades
copyhunter watch reconcile <ADDRESS> --hours 24
copyhunter watch reconcile <ADDRESS> --from 2026-04-01T00:00:00Z --to 2026-04-02T00:00:00Z -n 500 -o json

# Stop monitoring
copyhunter watch stop
```

`watch start` only starts monitoring. To continuously shadow/live follow trades, use `watch start --follow`.

`watch status`, `watch stream`, `follow status`, and `follow audit` expose recent result summaries:

- by state: `OK / SKIP / FAIL / PEND`
- by category: `policy / risk / dependency / execution / runtime`
- top recent reasons for quick diagnosis

### Follow Mode

Configure how you follow leader trades.

```bash
# Shadow mode - simulate trades without executing
copyhunter follow shadow
copyhunter follow shadow --sizing proportional --bankroll 1000 --max-per-trade 20 --daily-limit 500

# Live mode - execute real trades (requires polymarket-cli)
copyhunter follow live --sizing fixed --max-per-trade <USD> --daily-limit <USD> --confirm
copyhunter follow live --sizing proportional --bankroll <USD> --max-per-trade <USD> --daily-limit <USD> --confirm

# Follow the latest trade from one leader (address / alias / #rank)
copyhunter follow once <IDENTIFIER> --dry-run -o json
copyhunter follow once <IDENTIFIER> --amount 15 --dry-run -o json

# Check follow status
copyhunter follow status
copyhunter follow status -o json

# Audit recent follow outcomes / reasons
copyhunter follow audit
copyhunter follow audit -n 100 -o json

# Show recent follow orders
copyhunter follow orders
copyhunter follow orders --status executed -n 50 -o json

# Show simulated/live positions
copyhunter follow positions
copyhunter follow positions --all -o json

# Reconcile executed live orders against follower wallet trades
copyhunter config set follow.followerAddress 0xYOUR_FOLLOWER_ADDRESS
copyhunter follow reconcile --hours 24
copyhunter follow reconcile --address 0xYOUR_FOLLOWER_ADDRESS -n 200 -o json

# Stop following
copyhunter follow stop
```

Sizing modes:

- `fixed`: use configured `follow.maxPerTrade`
- `proportional`: scale by leader trade exposure and follower `follow.bankrollUsd`, capped by `follow.maxPerTrade`

Recent follow outcomes use these states:

- `OK`: event was followed and an order was recorded
- `SKIP`: event was intentionally skipped by policy/risk checks
- `FAIL`: follow execution failed after evaluation
- `PEND`: event has no stored follow outcome yet

Recent follow outcome categories:

- `policy`: allowlist/blocklist/min amount/sizing config decisions
- `risk`: daily limit, max exposure, max positions, or missing local inventory for sell
- `dependency`: external dependency failures such as `polymarket-cli` / data API
- `execution`: follow execution pipeline failures after approval
- `runtime`: uncategorized runtime failures
- `uncategorized`: legacy stored reasons without a normalized category

### PnL & Analysis

Track performance and analyze trading results.

```bash
# Show PnL summary
copyhunter pnl
copyhunter pnl report -t summary -f json

# Show unrealized PnL for open positions
copyhunter pnl unrealized

# Show daily PnL history
copyhunter pnl daily [--days <N>]

# Show PnL breakdown by leader
copyhunter pnl leaders

# Analyze leader performance
copyhunter pnl analyze                        # Top 10 by PnL
copyhunter pnl analyze -m winRate -t 5        # Top 5 by win rate
copyhunter pnl analyze -a <ADDRESS>           # Specific leader

# Generate reports
copyhunter pnl report -t summary              # Text summary
copyhunter pnl report -t full -f json         # Full JSON report
copyhunter pnl report -t daily -f csv -o report.csv
copyhunter pnl report -t full -f json -o report.json --json

# Export data to file
copyhunter pnl export positions -f json
copyhunter pnl export leaders -f csv
copyhunter pnl export all -o backup.json
copyhunter pnl export positions -o positions.json --json
```

### TUI Dashboard

Interactive terminal UI for monitoring.

```bash
# Launch dashboard
copyhunter tui

# With custom refresh rate
copyhunter tui --refresh 10000
```

**Keyboard Shortcuts:**
| Key | Action |
|-----|--------|
| `1/2/3` | Switch tabs (Events/Leaders/Positions) |
| `w` | Toggle watch mode |
| `p` | Poll once |
| `?/h` | Show help |
| `q` | Quit |

### Configuration

Manage CopyHunter settings.

```bash
# Show current config
copyhunter config show
copyhunter config show -o json

# Set config values
copyhunter config set <key> <value>
copyhunter config set follow.sizingMode proportional
copyhunter config set follow.bankrollUsd 1000
copyhunter config set watch.filterMinUsd 0

# Reset to defaults
copyhunter config reset --confirm

# Show config file path
copyhunter config path
```

### Database Management

Manage local SQLite database.

```bash
# Show database statistics
copyhunter db stats
copyhunter db stats --json

# Show database file path
copyhunter db path

# Preview cleanup (dry-run)
copyhunter db prune --days 30 --dry-run

# Delete data older than N days
copyhunter db prune --days 30 --yes

# Delete specific tables only
copyhunter db prune --days 60 --tables events,orders --yes

# Optimize database
copyhunter db vacuum

# Danger: delete ALL local data
copyhunter db reset --confirm --yes-delete-all
```

> **Auto-Warning**: CLI warns when database exceeds 100MB (warning) or 500MB (critical).

## Configuration Options

| Key                       | Description                                  | Default    |
| ------------------------- | -------------------------------------------- | ---------- |
| `follow.mode`             | Trading mode: `shadow`, `live`, `disabled`   | `shadow`   |
| `follow.sizingMode`       | Sizing mode: `fixed`, `proportional`         | `fixed`    |
| `follow.bankrollUsd`      | Follower bankroll for proportional sizing    | `1000`     |
| `follow.maxPerTrade`      | Maximum USD per single trade                 | `50`       |
| `follow.dailyLimit`       | Maximum daily trading volume USD             | `500`      |
| `follow.allowlist`        | Only follow these leader addresses           | `[]`       |
| `follow.blocklist`        | Never follow these leader addresses          | `[]`       |
| `risk.maxExposure`        | Maximum total position exposure USD          | `1000`     |
| `risk.maxPositions`       | Maximum concurrent open positions            | `20`       |
| `risk.maxLossPerDay`      | Stop trading after daily loss USD            | `100`      |
| `risk.stopLossPercent`    | Auto-close position at loss %                | `20`       |
| `watch.interval`          | Polling interval in milliseconds             | `30000`    |
| `watch.sources`           | Data sources: `polling`, `websocket`         | `["polling"]` |
| `watch.filterMinUsd`      | Minimum trade size to capture USD            | `10`       |
| `display.theme`           | UI theme: `dark`, `light`                    | `dark`     |
| `display.refreshInterval` | TUI refresh rate in ms                       | `5000`     |

## Data Storage

All data is stored locally in `~/.copyhunter/`:

```
~/.copyhunter/
├── copyhunter.db    # SQLite database
├── config.json      # User configuration
└── logs/            # Log files
```

### Database Schema

| Table         | Description                                       |
| ------------- | ------------------------------------------------- |
| `leaders`     | Monitored addresses with cached performance stats |
| `events`      | Captured trade events from leaders                |
| `positions`   | Open and closed position tracking                 |
| `orders`      | Copy trade orders (shadow and live mode)          |
| `daily_stats` | Daily aggregated statistics                       |
| `watch_cursors` | Per-leader watch cursor state for recovery      |

### Database Maintenance

The database grows over time. Built-in size monitoring:

- **Warning (100MB)**: Suggests cleanup
- **Critical (500MB)**: Urgent cleanup needed

```bash
# Check database size
copyhunter db stats

# Clean old data
copyhunter db prune --days 30 --yes
```

## AI Agent Integration

Data queries and most action commands support JSON output for programmatic access:

```bash
# Leaders data
copyhunter leaders list -o json
copyhunter leaders refresh -o json

# Follow data
copyhunter follow status -o json
copyhunter follow audit -o json
copyhunter follow orders -o json
copyhunter follow positions -o json
copyhunter follow once <IDENTIFIER> --dry-run -o json

# PnL data
copyhunter pnl unrealized -o json
copyhunter pnl daily -o json
copyhunter pnl report -t full -f json
copyhunter pnl report -t full -f json -o report.json --json

# Real-time events
copyhunter watch stream -o json
copyhunter watch start -o json
copyhunter watch poll -o json
copyhunter watch reconcile <ADDRESS> -o json
copyhunter watch stop -o json

# Config
copyhunter config show -o json

# Database stats
copyhunter db stats --json
copyhunter db prune --days 30 --dry-run -o json
```

### Share Card Generation

To generate social share cards for your copy trading results, use the companion skill `polymarket-copyhunter-cards`:

```bash
# Install polymarket-copyhunter-cards (separate skill with image generation dependencies)
cd ../polymarket-copyhunter-cards && npm install

# Generate share card from copyhunter report
copyhunter pnl report -t full -f json | npx tsx ../polymarket-copyhunter-cards/bin/cli.ts pnl --stdin --output ./my-pnl.png

# Get base64 image for sending via Slack/Discord/Telegram
copyhunter pnl report -t full -f json | npx tsx ../polymarket-copyhunter-cards/bin/cli.ts pnl --stdin --json
```

See `polymarket-copyhunter-cards/SKILL.md` for more details.

### Example: Automated Monitoring Script

```bash
#!/bin/bash
# Get current PnL report as JSON
pnl=$(copyhunter pnl report -t summary -f json)

# Check if total PnL breached a threshold
total_pnl=$(echo "$pnl" | jq '.pnl.totalPnl')
if (( $(echo "$total_pnl < -100" | bc -l) )); then
  copyhunter follow stop
  echo "PnL threshold reached, stopping follow mode"
fi
```

## Shadow Test Acceptance

Use this checklist before moving from development into a longer shadow run or small live validation:

```bash
# 1. Inspect baseline
copyhunter db stats --json
copyhunter follow status -o json

# 2. Start watch + follow
copyhunter watch start --follow

# 3. During the run, inspect summaries
copyhunter watch status -o json
copyhunter watch stream -o json -n 50
copyhunter follow status -o json
copyhunter follow audit -o json -n 100

# 4. Stop and reconcile
copyhunter watch stop
copyhunter watch reconcile <ADDRESS> --window 30m -o json
copyhunter watch reconcile <ADDRESS> --window 60m -o json
```

Recommended acceptance questions:

- Did `watch reconcile` report missing trades?
- Are recent failures mostly `dependency`, `execution`, or `runtime`?
- Are most skipped trades expected `policy/risk` decisions?
- Did `follow audit` show one abnormal failure category dominating the run?

## Architecture

```
polymarket-copyhunter/
├── bin/                    # CLI entry point
├── src/
│   ├── cli/
│   │   └── commands/       # CLI command implementations
│   ├── core/               # Config, types, events, logger
│   ├── db/
│   │   └── repositories/   # Data access layer
│   ├── watch/              # Monitoring engine
│   ├── follow/             # Copy trading engine
│   ├── analysis/           # PnL calculation and reporting
│   ├── tui/                # Terminal UI (Ink/React)
│   └── platforms/
│       └── polymarket/     # Platform-specific adapters
└── tests/                  # Test suites
```

## Event System

CopyHunter uses an event-driven architecture for component coordination:

| Event              | Description                    |
| ------------------ | ------------------------------ |
| `system:ready`     | Application initialized        |
| `system:error`     | Error occurred                 |
| `watch:started`    | Watch mode activated           |
| `watch:stopped`    | Watch mode deactivated         |
| `watch:poll`       | Poll cycle completed           |
| `watch:healthy`    | Dependency health probe passed |
| `watch:error`      | Watch/runtime error captured   |
| `trade:detected`   | Trade detected from leader     |
| `trade:new`        | New trade persisted locally    |
| `trade:filtered`   | Trade seen but filtered out    |
| `follow:started`   | Follow engine activated        |
| `follow:stopped`   | Follow engine deactivated      |
| `follow:evaluating` | Trade under follow evaluation |
| `follow:executing` | Follow order about to execute  |
| `follow:executed`  | Copy trade executed            |
| `follow:skipped`   | Trade skipped (risk/filter)    |
| `follow:error`     | Follow execution failed        |
| `risk:limit_reached` | Risk gate blocked an action  |
| `stats:updated`    | Leader stats updated           |
| `stats:batch_updated` | Batch stats refresh finished |

## Platform Support

| Platform   | Status    | Notes                   |
| ---------- | --------- | ----------------------- |
| Polymarket | Supported | Requires polymarket-cli |
| Kalshi     | Planned   | -                       |
| Manifold   | Planned   | -                       |

## Troubleshooting

### Common Issues

**polymarket-cli not found**

```bash
# Verify installation
which polymarket

# If not found, reinstall
brew install polymarket
```

**Database locked error**

```bash
# Stop all copyhunter processes
pkill -f copyhunter

# Restart
copyhunter watch start
```

**API rate limiting**

```bash
# Increase polling interval
copyhunter config set watch.interval 120000
```

## Development

```bash
# Development mode with hot reload
npm run dev

# Run all tests
npm test

# Run specific test suites
npm run test:db
npm run test:watch
npm run test:follow
npm run test:core

# Build for production
npm run build
```

## License

MIT
