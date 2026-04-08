# PredictRadar Agent Skills

A repository of MCP-first agent skills and supporting tools for Polymarket intelligence.

This repo is not a single application. It combines:

- instruction-first skills built around `SKILL.md`
- a shared market data layer in `polymarket-data-layer`
- a few executable utilities such as `polymarket-copyhunter`

Most skills focus on one job: probability moves, whale activity, wallet analysis, market discovery, settlement risk, news impact, or daily anomaly reporting.

---

## Repository Map

```text
predictradar-agent-skills/
├── polymarket-data-layer/      # Shared MCP, Gamma, cache, and query helpers
├── polymarket-market-movers/           # Probability movement detection
├── polymarket-whale-alert/          # Large-order and smart-money monitoring
├── polymarket-smart-money-rankings/ # Smart-money ranking and address analysis
├── polymarket-domain-leaders/         # Domain-specialized trader discovery
├── polymarket-wallet-analysis/      # Deep wallet profiling and comparison
├── polymarket-market-discovery/         # Trending and newly active market discovery
├── polymarket-news-impact/    # Breaking news to market-impact analysis
├── polymarket-settlement-risk/      # Resolution and dispute-risk analysis
├── polymarket-market-ripple/    # Correlated market and ripple-effect analysis
├── polymarket-daily-anomalies/         # Daily anomaly reporting
├── polymarket-copyhunter/       # Copy-trading terminal
└── polymarket-copyhunter-cards/ # Share-card generator for CopyHunter
```

---

## Skill Overview

### Shared Data Layer

| Skill | What it does |
|-------|---------------|
| `polymarket-data-layer` | Shared access layer for MCP, Gamma lookups, smart-money cache, and reusable query helpers. Most other skills depend on this layer. |

### Market Intelligence

| Skill | What it does |
|-------|---------------|
| `polymarket-market-movers` | Detects significant probability moves over configurable windows. |
| `polymarket-market-discovery` | Surfaces trending markets, new markets, and category-level browsing. |
| `polymarket-news-impact` | Connects breaking news to active markets and recent market reactions. |
| `polymarket-daily-anomalies` | Produces a daily anomaly report across Black Swan, Whale Wars, and Insider Watch patterns. |

### Smart Money And Trader Discovery

| Skill | What it does |
|-------|---------------|
| `polymarket-whale-alert` | Finds large recent orders and filters for verified smart-money-style activity. |
| `polymarket-smart-money-rankings` | Ranks and classifies high-signal traders. |
| `polymarket-domain-leaders` | Finds strong traders by domain such as crypto, politics, finance, or sports. |
| `polymarket-wallet-analysis` | Profiles one wallet deeply or compares multiple wallets side by side. |

### Risk And Correlation

| Skill | What it does |
|-------|---------------|
| `polymarket-settlement-risk` | Flags markets with elevated resolution or dispute risk. |
| `polymarket-market-ripple` | Maps direct and indirect effects across related markets after a news event or settlement. |

### Trading Utilities

| Tool | What it does |
|------|---------------|
| `polymarket-copyhunter` | Terminal workflow for monitoring and following trader behavior. The CLI command remains `copyhunter`. |
| `polymarket-copyhunter-cards` | Generates visual share cards for CopyHunter results. The CLI command remains `copyhunter-share`. |

---

## How The Repo Works

### 1. MCP-first by default

The repository is organized around the shared MCP wrapper in:

`polymarket-data-layer/scripts/mcp-client.js`

For most skill work, that wrapper should be the first choice for:

- session-aware MCP calls
- preview SQL queries
- market and trader tool calls
- table discovery and schema inspection

Gamma lookups and smart-money cache enrichment are layered on top when needed.

### 2. Warmup is optional, not mandatory

`polymarket-data-layer/scripts/init.js` can warm caches and smart-money classification ahead of time, but it is not a required first step for every skill invocation.

Useful commands:

```bash
cd polymarket-data-layer
node scripts/init.js
node scripts/init.js --no-domains
node scripts/init.js --fresh
```

Use warmup when you want faster repeated local analysis or fresh cache state. Skip it when you only need a one-off MCP-backed task.

### 3. Skills are a mix of prompt modules and utilities

Some folders are primarily instruction-driven skills with a `SKILL.md`.

Some also include local scripts, for example:

- `polymarket-daily-anomalies/scripts/content-analysis.js`
- `polymarket-data-layer/scripts/*.js`
- `polymarket-copyhunter/` CLI code

That means this repo should be read as a skill library plus supporting tooling, not as a single runnable product.

---

## Example Prompts

```text
Which markets are moving the most right now?
Any large smart-money orders in the past 24 hours?
Analyze wallet 0xabc...def123
Who are the best crypto traders on Polymarket?
Generate today's anomaly report
Fed just cut rates. Which markets are affected?
Which markets settling soon look risky?
What are the hottest political markets right now?
```

---

## Data Source Priority

The intended data-source order in this repo is:

```text
1. PredicTradar MCP Server   https://api.predictradar.ai/api/mcp/v2
2. polymarket-cli            fallback during service degradation
3. Polymarket Data API       final fallback for selected use cases
```

In practice, most updated skills now assume the shared MCP wrapper first, then use Gamma or the Data API only where they add something MCP does not provide directly.

---

## Domain Codes

| Code | Domain |
|------|--------|
| `POL` | Politics and elections |
| `GEO` | Geopolitics |
| `FIN` | Finance and macro |
| `CRY` | Crypto |
| `SPT` | Sports |
| `TEC` | Tech and AI |
| `CUL` | Culture and entertainment |
| `GEN` | General |

## Smart Money Labels

| Label | Meaning |
|-------|---------|
| `HUMAN` | Human trader with strong win rate and moderate frequency |
| `SIGNAL` | Signal-following bot or burst trader |
| `MM` | Market maker with high bilateral activity |
| `BOT` | High-frequency automated trader |
| `COPYBOT` | Copy-trading bot |
| `NOISE` | Low-signal address |

---

## Testing And Validation

This repo does not have a single unified test command.

Current validation surfaces include:

- `polymarket-copyhunter`: runnable package with tests via `npm test`
- `polymarket-market-movers/evals/evals.json`: evaluation fixture data
- `polymarket-settlement-risk/evals/evals.json`: evaluation fixture data
- local MCP verification through `polymarket-data-layer/scripts/mcp-client.js`

Example:

```bash
cd polymarket-copyhunter
npm install
npm test
```

If you are updating a skill doc, the most important validation is usually:

- the referenced script paths still exist
- the MCP wrapper methods still match live behavior
- the described tables and fields still exist

---

## Publishing

The repo now includes a manual GitHub Actions workflow for ClawHub publishing:

- file: `.github/workflows/publish-skills.yml`
- trigger: `workflow_dispatch`
- modes:
  - publish a specific skill
  - auto-detect changed skills since the last tag

Successful publishing still depends on each target skill meeting the current ClawHub packaging requirements.

---

## Key Conventions

- Wallet addresses should be stored and displayed in full 42-character format.
- Event-level slugs are preferred for Polymarket URLs.
- `condition_id` is the main cross-system market key.
- Price fields are probabilities from `0` to `1`, not USD amounts.
- Trade size fields such as `amount` and `usd_amount` represent notional trade size.
- User-facing output should not expose internal infrastructure details unless the task explicitly requires debugging.

---

## License

MIT
