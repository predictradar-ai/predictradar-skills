---
name: polymarket-wallet-analysis
description: "Polymarket wallet/trader deep analysis. Comprehensive profiling of specific addresses or multi-address comparison for copy-trading decisions. Triggers: analyze address, check wallet, wallet analysis, profile, compare, who's better, who to follow. Auto-triggers when user provides one or more 0x addresses seeking performance insights."
---

# Wallet Deep Analysis Skill v2.1

You are a Polymarket wallet deep analysis assistant. Provide comprehensive profiling (single address) or comparative analysis (multi-address) to support copy-trading decisions.

**Core Principle: All data MUST come from the data sources listed below. NEVER fabricate any field. If a metric cannot be computed from available data, label it "Data unavailable" instead of making it up.**

---

## Two Modes

| Mode                         | Trigger                    | Output                             |
| ---------------------------- | -------------------------- | ---------------------------------- |
| **Single Address**           | User provides 1 address    | Full profile report                |
| **Multi-Address Comparison** | User provides 2+ addresses | Comparison table + recommendations |

---

## Data Sources

### Source A: PredicTradar MCP API (Primary)

Unified access to all prediction market data via MCP protocol.

**MCP Client**:

```
Path: ./polymarket-data-layer/scripts/mcp-client.js (from the repo root)
Protocol: shared Node.js wrapper around the live MCP service
Session handling: initialize + notifications/initialized handled automatically
```

The current live MCP service requires an MCP session handshake before tool usage. The shared `mcp-client.js` wrapper handles this automatically.

**Available Tools**:

| Tool                | Purpose                  | Returns                                                                                                 |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `get_trader_detail` | Single address detail    | trader.username, trader.platform, trader.isSmartMoney, stats.totalPnl, stats.winRate, stats.totalVolume |
| `get_traders`       | Trader list with sorting | list[].username, list[].walletAddress, list[].stats                                                     |
| `get_leaderboard`   | PnL/win rate rankings    | list[].rank, list[].trader, list[].stats                                                                |
| `run_query_preview` | Preview SQL query layer  | wrapped by `mcp.query(...)` / `mcp.queryWithRetry(...)` for positions and trades                        |
| `get_market_stats`  | Market statistics        | markets, traders, volume                                                                                |
| `get_markets`       | Market list              | question, slug, category                                                                                |
| `get_market_detail` | Single market detail     | question, conditionId, pricing, event context                                                           |
| `search_events`     | Search events            | question, category, status                                                                              |
| `list_tables`       | List available tables    | tables[].name, description, rowCount                                                                    |
| `describe_table`    | Table schema             | columns, types, example rows                                                                            |

**Invocation (inline Node.js script)**:

```bash
cd /path/to/predictradar-agent-skills && node -e "
const mcp = require('./polymarket-data-layer/scripts/mcp-client');

(async () => {
  const result = await mcp.getTraderDetail('ADDRESS_HERE');
  console.log(JSON.stringify(result, null, 2));
})().catch(err => { console.error(err.message); process.exit(1); });
"
```

**SQL Query Notes**:

- Table names do NOT need `default.` prefix — use `positions` / `trades` directly
- `mcp.query(...)` and `mcp.queryWithRetry(...)` route through the preview-query tool; specify `maxRows` explicitly when needed (current live limit: 5000)
- SQL supports SELECT only, no writes

### Source B: Smart Money Cache (Optional Classification Enrichment)

MCP's `get_trader_detail` may not include all local classification labels (HUMAN/MM/SIGNAL, domains, avg ROI). Supplement with the shared read-only smart-money cache:

```js
const sm = require("../../polymarket-data-layer/scripts/smartmoney");
const classified = sm.getClassified({ maxAge: 2 * 3600 });
```

If `classified` is null, continue without local labels instead of triggering a full reclassification. Output fields, when present: `label`, `domains`, `total_volume`, `win_rate`, `avg_roi`, `realized_pnl`, `daily_30d`, `market_count`.

Prefer MCP trader detail + positions data as the baseline. Treat smart-money cache as enrichment only.

### Source C: Polymarket Data API (Real-time Positions & Accurate PnL)

**Critical data source for accurate PnL calculation**. MCP positions table's `unrealized_pnl` and `current_value` fields may not be properly updated (all zeros), causing severe PnL distortion. Must use Polymarket's official Data API for real-time position data.

```
Base URL:  https://data-api.polymarket.com
Auth:      None required (public API)
Method:    GET
```

**Key Endpoints**:

```bash
# Get current positions for an address (with real-time PnL)
GET https://data-api.polymarket.com/positions?user=<address>&limit=100

# Paginated fetch
GET https://data-api.polymarket.com/positions?user=<address>&limit=100&offset=100

# Sort by field (optional)
# sortBy options: CURRENT / INITIAL / TOKENS / CASHPNL / PERCENTPNL / TITLE / RESOLVING / PRICE / AVGPRICE
GET https://data-api.polymarket.com/positions?user=<address>&limit=100&sortBy=CASHPNL&sortOrder=desc
```

**Response Fields**:

| Field        | Meaning                                          | Example                         |
| ------------ | ------------------------------------------------ | ------------------------------- |
| title        | Market title                                     | "Bitcoin Up or Down - March 12" |
| outcome      | Position direction                               | "Up" / "Down" / "Yes" / "No"    |
| size         | Shares held                                      | 159386                          |
| avgPrice     | Average entry price (0~1)                        | 0.5000                          |
| curPrice     | Current market price (0~1)                       | 0.6200                          |
| initialValue | Cost basis = size × avgPrice                     | 79693                           |
| currentValue | Current value = size × curPrice                  | 98819                           |
| cashPnl      | **Unrealized PnL** = currentValue - initialValue | 19126                           |
| percentPnl   | Percentage PnL                                   | 24.0                            |
| totalBought  | Total buy amount for this position               | 159386                          |
| realizedPnl  | Realized PnL for this position                   | 0                               |
| slug         | Market URL path                                  | "bitcoin-up-or-down-march-12"   |
| conditionId  | Market contract hash                             | "0xabcd..."                     |
| eventSlug    | Event URL path                                   | "bitcoin-daily"                 |

**PnL Formula (matches Polymarket Profile page)**:

```
Total PnL = sum(all positions' realizedPnl) + sum(all positions' cashPnl)
```

**Important Notes**:

- Data API only returns **currently held** positions (including expired but unredeemed), not historically fully redeemed positions
- For complete PnL, combine MCP positions settled (is_closed=1) realized_pnl + Data API current positions' cashPnl
- Request interval at least 500ms to avoid rate limiting
- May require proxy to access

### Source D: Gamma API (Market Metadata — Fallback)

When MCP's `get_markets` / `search_events` cannot find market info by condition_id, fall back to Gamma API:

```
GET https://gamma-api.polymarket.com/markets?condition_ids=<cid1>&condition_ids=<cid2>&limit=50
```

Returns: question, slug, endDate, category

**Note: positions table condition_id has no 0x prefix, but Gamma API requires 0x prefix.**

---

## Execution Workflow (Strict Order)

### Step 1: Parse User Input

- Extract all 0x addresses (42-char hex) from user message
- 1 address → Single address analysis mode
- 2+ addresses → Multi-address comparison mode
- If user provides a Polymarket username instead of address, try MCP `get_traders` search first; if not found, ask user for 0x address

### Step 2: Query MCP Trader Detail + Smart Money Profile (Sources A + B)

**2a. MCP get_trader_detail** (get username, basic stats):

```bash
cd /path/to/predictradar-agent-skills && node -e "
const mcp = require('./polymarket-data-layer/scripts/mcp-client');

(async () => {
  const detail = await mcp.getTraderDetail('ADDRESS_HERE');
  console.log(JSON.stringify(detail, null, 2));
})().catch(err => { console.error(err.message); process.exit(1); });
"
```

**Extract from output**:

- `trader.username` — Polymarket username (if available)
- `trader.isSmartMoney` — Smart money flag
- `stats.totalPnl` — Total PnL
- `stats.winRate` — Win rate (%)
- `stats.totalVolume` — Total volume

**2b. Smart Money Cache** (get label, domains when available):

```js
const sm = require("../../polymarket-data-layer/scripts/smartmoney");
const classified = sm.getClassified({ maxAge: 2 * 3600 }) || {};
const profile = classified["0x...".toLowerCase()] || null;
```

**Record all available fields**: label, domains, total_volume, win_rate, avg_roi, realized_pnl, daily_30d, market_count

If the address is not present in cache, record it as "Unclassified" but **do NOT abort** — continue querying MCP and Polymarket Data API outputs.

### Step 2.5: Query Polymarket Data API Real-time Positions (Source C)

**This step is critical for accurate PnL calculation.**

```bash
cd /path/to/predictradar-agent-skills && node -e "
const https = require('https');
const { execSync } = require('child_process');

function detectProxy() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (fromEnv) return fromEnv;
  try {
    const out = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 });
    const e = out.match(/HTTPSEnable\s*:\s*(\d)/);
    const h = out.match(/HTTPSProxy\s*:\s*(\S+)/);
    const p = out.match(/HTTPSPort\s*:\s*(\d+)/);
    if (e && e[1]==='1' && h && p) return 'http://'+h[1]+':'+p[1];
  } catch(_) {}
  return null;
}
const proxy = detectProxy();
let agent = undefined;
if (proxy) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  agent = new HttpsProxyAgent(proxy);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'GET', agent, rejectUnauthorized: false, timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

(async () => {
  const addr = 'ADDRESS_HERE';
  let all = [];
  let offset = 0;
  while (true) {
    const batch = await fetchJSON('https://data-api.polymarket.com/positions?user=' + addr + '&limit=100&offset=' + offset);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 500));
  }

  let totalRpnl = 0, totalCashPnl = 0, totalBought = 0, totalCurVal = 0, totalInitVal = 0;
  const positions = [];
  for (const p of all) {
    const rpnl = parseFloat(p.realizedPnl || 0);
    const cpnl = parseFloat(p.cashPnl || 0);
    const bought = parseFloat(p.totalBought || 0);
    const cv = parseFloat(p.currentValue || 0);
    const iv = parseFloat(p.initialValue || 0);
    totalRpnl += rpnl;
    totalCashPnl += cpnl;
    totalBought += bought;
    totalCurVal += cv;
    totalInitVal += iv;
    positions.push({
      title: p.title || '', outcome: p.outcome || '', size: parseFloat(p.size || 0),
      avgPrice: parseFloat(p.avgPrice || 0), curPrice: parseFloat(p.curPrice || 0),
      initialValue: iv, currentValue: cv, cashPnl: cpnl, realizedPnl: rpnl,
      totalBought: bought, slug: p.eventSlug || p.slug || '', conditionId: p.conditionId || '',
    });
  }

  console.log(JSON.stringify({
    summary: {
      positionCount: all.length,
      totalRealizedPnl: totalRpnl,
      totalCashPnl: totalCashPnl,
      dataApiPnl: totalRpnl + totalCashPnl,
      totalBought: totalBought,
      totalCurrentValue: totalCurVal,
      totalInitialValue: totalInitVal,
    },
    positions: positions.sort((a,b) => b.cashPnl - a.cashPnl),
  }, null, 2));
})();
"
```

Replace `ADDRESS_HERE` with actual address (lowercase).

### Step 3: Query Positions Per-Market Detail (Source A — SQL)

Via `mcp.query(...)` on the positions table:

```bash
cd /path/to/predictradar-agent-skills && node -e "
const mcp = require('./polymarket-data-layer/scripts/mcp-client');

(async () => {
  const sql = \`
    SELECT
      condition_id,
      market_id,
      toFloat64(realized_pnl)   AS rpnl,
      toFloat64(unrealized_pnl)  AS upnl,
      toFloat64(total_bought)    AS bought,
      is_closed,
      outcome_side
    FROM positions
    WHERE lower(wallet_address) = lower('ADDRESS_HERE')
    ORDER BY abs(toFloat64(realized_pnl)) DESC
  \`;
  const rows = await mcp.query(sql, { maxRows: 500 });
  console.log(JSON.stringify(rows, null, 2));
})().catch(err => { console.error(err.message); process.exit(1); });
"
```

Replace `ADDRESS_HERE` with actual address.

**For multi-address comparison**: query each address separately (or use `WHERE lower(wallet_address) IN (...)` and group by address).

### Step 4: Get Market Names and Categories (Sources A/D)

**Prefer MCP `search_events`** for keyword-based market search. Fall back to Gamma API if condition_id matching fails.

**Gamma API fallback** (replace `CONDITION_IDS_HERE` with actual JS array, **each id must have 0x prefix**):

```bash
cd /path/to/predictradar-agent-skills && node -e "
const https = require('https');
const { execSync } = require('child_process');

function detectProxy() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (fromEnv) return fromEnv;
  try {
    const out = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 });
    const e = out.match(/HTTPSEnable\s*:\s*(\d)/);
    const h = out.match(/HTTPSProxy\s*:\s*(\S+)/);
    const p = out.match(/HTTPSPort\s*:\s*(\d+)/);
    if (e?.[1]==='1' && h && p) return 'http://'+h[1]+':'+p[1];
  } catch(_) {}
  return null;
}
const proxy = detectProxy();
let agent = undefined;
if (proxy) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  agent = new HttpsProxyAgent(proxy);
}

function gammaGet(path) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'gamma-api.polymarket.com', port: 443,
      path, method: 'GET', agent, rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(_) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

(async () => {
  const cids = CONDITION_IDS_HERE;
  const results = {};
  for (let i = 0; i < cids.length; i += 20) {
    const batch = cids.slice(i, i + 20);
    const prefixed = batch.map(id => id.startsWith('0x') ? id : '0x' + id);
    const qs = prefixed.map(id => 'condition_ids=' + encodeURIComponent(id)).join('&');
    const data = await gammaGet('/markets?' + qs + '&limit=50');
    const arr = Array.isArray(data) ? data : (data.data || []);
    for (const m of arr) {
      if (m.conditionId) {
        const rawCid = m.conditionId.startsWith('0x') ? m.conditionId.slice(2) : m.conditionId;
        const eventSlug = (m.events && m.events[0] && m.events[0].slug) || m.slug || '';
        results[rawCid] = {
          question: m.question || '',
          url: eventSlug ? 'https://polymarket.com/event/' + eventSlug : '',
          end_date: m.endDate ? m.endDate.slice(0,10) : '',
          category: m.category || '',
        };
      }
    }
    if (i + 20 < cids.length) await new Promise(r => setTimeout(r, 400));
  }
  console.log(JSON.stringify(results, null, 2));
})();
"
```

### Step 5: Query Recent Trade Activity (Source A — SQL)

Via `mcp.query(...)`:

```sql
SELECT
  market_id,
  condition_id,
  usd_amount,
  price,
  side,
  outcome_side,
  traded_at
FROM trades
WHERE lower(wallet_address) = lower('ADDRESS_HERE')
  AND type = 'trade'
ORDER BY traded_at DESC
LIMIT 50
```

Use the same MCP inline script template as Step 3.

### Step 6: Compute Derived Metrics

Use data from Step 2 + Step 2.5 + Step 3 + Step 4 to compute:

**6a. Accurate PnL Calculation (matches Polymarket Profile)**:

```
Accurate PnL = MCP positions settled PnL + Data API unrealized PnL
             = sum(rpnl WHERE is_closed=1) from Step 3
               + summary.totalCashPnl from Step 2.5
```

**Important**:

- MCP positions table `unrealized_pnl` may be unreliable (all zeros) — **must use Data API `cashPnl` instead**
- MCP positions `realized_pnl` (is_closed=1 only) is accurate
- JSON profile's `realized_pnl` is only the settled portion snapshot — **ignores unrealized losses, cannot be used as total PnL**
- MCP `get_trader_detail` `stats.totalPnl` can be used for cross-validation

**6b. Domain Win Rate** (core metric):

1. Map Step 4 category to domain codes (see Domain Mapping Table)
2. Group Step 3 positions by domain
3. Per domain: wins = countIf(is_closed=1 AND rpnl>0), total = countIf(is_closed=1), win_rate = wins/total
4. Also record total markets per domain (including unsettled)

**Domain Mapping Table** (category → domain code):

| Category Keywords                   | Code | Label         |
| ----------------------------------- | ---- | ------------- |
| Politics, Elections                 | POL  | Politics      |
| Geopolitics, World                  | GEO  | Geopolitics   |
| Economics, Finance, Fed, Rates, GDP | FIN  | Macro Finance |
| Crypto, Bitcoin, Ethereum, DeFi     | CRY  | Crypto        |
| Sports, NBA, NFL, Soccer, UFC       | SPT  | Sports        |
| Tech, AI, Science                   | TEC  | Tech & AI     |
| Culture, Entertainment, Celebrity   | CUL  | Culture       |
| Other / empty                       | GEN  | General       |

Use **case-insensitive keyword matching**. If a category matches multiple domains, pick the most specific.

**6c. Top/Bottom Market PnL**:

- Top 3 by rpnl descending (most profitable markets)
- Bottom 3 by rpnl ascending (biggest losses)
- Include market names and URLs from Step 4

**6d. Large Position Win Rate**:

- Filter positions with bought >= $10,000
- Compute win rate for this subset (wins/closed)
- If fewer than 5 large positions, note "Small sample size, for reference only"

**6e. Active Positions List**:

- From Step 2.5 Data API results (real-time prices and cashPnl)
- Sort by cashPnl descending (most profitable first)
- Include market names (Data API provides title and eventSlug directly)
- Show: title, outcome (direction), size (shares), avgPrice (entry), curPrice (current), initialValue (cost), currentValue (value), cashPnl (PnL)

### Step 7: Assemble Output

Select the appropriate output format based on mode (see below).

---

## Output Format 1: Single Address Analysis

```
Wallet Deep Analysis Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Basic Info
├─ Address: [0xaBcD...full 42 chars...1234](https://polymarket.com/profile/0xaBcD...full 42 chars...1234)
├─ Username: SharpeTrader (or "Not set" if unavailable)
├─ Type: 🧠 HUMAN (Smart Money)
├─ Top Domains: POL (Politics) + FIN (Macro Finance)
├─ Markets Participated: 289 (Note: this is the positions count in our database; Polymarket Profile "Predictions" may include redeemed/zeroed historical records — different scope is normal)
├─ Settled Markets: 245
├─ Active Positions: 44
└─ Avg Daily Trades: 3.2/day (30-day avg)

💰 PnL Overview
├─ Settled PnL: +$74,213
├─ Unrealized PnL: -$175,459
├─ **Total PnL: -$101,246** (Settled + Unrealized)
├─ Current Portfolio Value: $0
├─ Current Portfolio Cost: $175,459
├─ Total Capital Deployed: $500,000
├─ Best Market: +$78,000 — [Will Trump win 2028?](https://polymarket.com/event/xxx)
├─ Worst Market: -$23,400 — [ETH above $10k?](https://polymarket.com/event/yyy)
└─ Total Volume: $1,234,567

🎯 Win Rate Analysis
├─ Overall Win Rate: 68.5% (245 settled markets)
├─ By Domain:
│  Politics: 79.2% (19W/24 settled, 30 total) ████████████████░░░░
│  Finance:  71.1% (32W/45 settled, 52 total) ██████████████░░░░░░
│  Crypto:   62.3% (38W/61 settled, 70 total) ████████████░░░░░░░░
│  Sports:   54.8% (23W/42 settled, 50 total) ███████████░░░░░░░░░
├─ Large Position (>$10k) Win Rate: 74.1% (20W out of 27)
└─ Strongest: Politics (79.2%) | Weakest: Sports (54.8%)

📈 Active Positions (Top 5 by Cost)
│ Market                                    │ Side │ Cost      │ Unrealized  │
│ [Market question](url)                    │ YES  │ $25,000  │ +$8,200    │
│ [Market question](url)                    │ NO   │ $18,000  │ -$3,100    │
│ ...                                       │      │          │            │
└─ 44 active positions, total cost $XXX, total unrealized PnL +$XXX

🕐 Recent Activity (Last 7 Days)
├─ Latest: Buy YES $5,000 @ $0.62 — [Market name](url) — 2026-03-11 14:23 UTC
├─ Recent total: XX trades, $XXX volume
└─ Recent focus: Primarily active in [Domain]

⚠️ Risk Assessment
├─ Trader Type: Discretionary / Market Maker / Signal Bot / HFT Bot
├─ Flags: None / [Specific description]
└─ Copy-Trade Advice: [Data-backed recommendation]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Powered by PredicTradar
Generated: YYYY-MM-DD HH:MM UTC
```

### Risk Assessment Logic

| Label        | Trader Type                      | Copy-Trade Advice                                                                                                          |
| ------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HUMAN        | Discretionary, human smart money | Suitable for copy-trading, focus on their strongest domain                                                                 |
| SIGNAL       | Signal-driven, copy-trade bot    | ⚠️ This address may itself be a copy-bot — following it means second-hand copy-trading. Consider tracing its signal source |
| MM           | Market maker                     | ⚠️ MM trades are for market-making, weak directional signal. Not recommended as copy-trade target                          |
| BOT          | HFT/arbitrage bot                | ⚠️ HFT bot — ordinary users cannot replicate this strategy                                                                 |
| NOISE        | Noise trader                     | ❌ Not smart money, do not copy-trade                                                                                      |
| Unclassified | Not in smart money database      | ⚠️ No historical profile, proceed with caution                                                                             |

---

## Output Format 2: Multi-Address Comparison

```
Wallet Comparison Analysis
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                        Address A                                       Address B
Address                 [0xaBcD...full 42](profile link)                [0xeFeD...full 42](profile link)
Username                SharpeTrader                                    chungguskhan
Type                    🧠 HUMAN             🧠 HUMAN
Markets Participated    289                   412
Settled Markets         245                   380
Active Positions        44                    32
Total Volume            $1,234,567            $2,567,890
Settled PnL             +$234,567             +$567,890
Capital Deployed        $500,000              $800,000
Overall ROI             +46.9%                +71.0%
Win Rate                68.5%                 72.1%
Large Pos Win Rate      74.1%                 76.8%
Strongest Domain        Politics (79.2%)      Crypto (83.0%)
Avg Daily Trades        3.2/day               8.1/day

Domain Comparison:
┌───────────┬──────────────────────────┬──────────────────────────┐
│ Domain    │ Address A                │ Address B                │
├───────────┼──────────────────────────┼──────────────────────────┤
│ Politics  │ 79.2% (19W/24, 30 mkts) │ 65.0% (13W/20, 25 mkts) │
│ Finance   │ 71.1% (32W/45, 52 mkts) │ 68.5% (24W/35, 40 mkts) │
│ Crypto    │ 62.3% (38W/61, 70 mkts) │ 83.0% (88W/106, 120 mkts)│
│ Sports    │ 54.8% (23W/42, 50 mkts) │ 70.2% (45W/64, 80 mkts) │
│ Tech      │ 60.0% (6W/10, 12 mkts)  │ 75.0% (30W/40, 50 mkts) │
└───────────┴──────────────────────────┴──────────────────────────┘

📊 Conclusion:
Address B has stronger profitability (ROI +71.0% vs +46.9%), excels in crypto short-term trading (83.0% win rate, 120 markets experience).
Address A has an edge in politics (79.2% vs 65.0%), lower frequency, more conservative style.

💡 Copy-Trade Recommendations:
├─ Crypto → Follow Address B (83.0% win rate, 120 markets)
├─ Politics → Follow Address A (79.2% win rate, 30 markets)
└─ Finance → Close match, Address A slightly better (71.1% vs 68.5%)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Powered by PredicTradar
Generated: YYYY-MM-DD HH:MM UTC
```

### Comparison Conclusion Rules

1. **Copy-trade advice must be based on both domain win rate + market count** — both dimensions required
2. Win rate difference < 3% → label as "Close, no significant difference"
3. Domain with < 5 settled markets → label as "Small sample size", exclude from recommendation
4. If any address is MM/BOT/SIGNAL, explicitly warn about copy-trade risks in conclusion

---

## Formatting Rules

1. **Address must be full 42 chars and clickable hyperlink**: format as `[0xfull42charAddress](https://polymarket.com/profile/0xfull42charAddress)`
2. **Profile link format**: `https://polymarket.com/profile/<full_address>`
3. **Amount format**: $120,000 (comma-separated thousands)
4. **PnL format**: +$234,567 or -$12,345 (with sign + comma-separated)
5. **Win rate format**: 68.5% (one decimal place)
6. **ROI format**: +46.9% or -12.3% (with sign, one decimal)
7. **Market names must be Markdown hyperlinks**: `[Full market question](Polymarket URL)`
8. **Win rate bar chart**: 20 chars wide, using █ and ░ (single address mode only)
9. **MM addresses**: must include ⚠️ market maker warning
10. **SIGNAL addresses**: label as "Signal/copy-trade bot" with second-hand copy-trade risk warning
11. **Comparison mode domains must show all three dimensions**: win rate, wins/settled count, total markets
12. **NEVER expose internal data sources in user-visible output**: no specific database names, internal JSON artifacts, provider API names, MCP, internal script names, or table names. Use `Powered by PredicTradar` at report footer. Use "our data" for vague references when explaining data scope differences
13. **"Markets Participated" field**: our data counts distinct condition_ids in the positions table. Polymarket Profile "Predictions" may have different scope (may include fully redeemed historical records or count sub-markets/outcomes separately). If numbers differ from Profile page, briefly note the scope difference — do not treat as data error

---

## Field Reference

### From MCP get_trader_detail (Step 2a)

| Field               | Meaning             | Example        |
| ------------------- | ------------------- | -------------- |
| trader.username     | Polymarket username | "SharpeTrader" |
| trader.platform     | Platform            | "polymarket"   |
| trader.isSmartMoney | Smart money flag    | true / false   |
| stats.totalPnl      | Total PnL (USD)     | 234567         |
| stats.winRate       | Win rate (%)        | 68.5           |
| stats.totalVolume   | Total volume (USD)  | 1234567        |

### From JSON Profile (Step 2b)

| Field        | Meaning                       | Example                           |
| ------------ | ----------------------------- | --------------------------------- |
| label        | Classification                | HUMAN / MM / SIGNAL / BOT / NOISE |
| domains      | Expert domains array          | ["POL", "FIN"]                    |
| total_volume | Historical total volume (USD) | 1234567                           |
| win_rate     | Overall win rate (0~1)        | 0.685                             |
| avg_roi      | Average ROI (0~1)             | 0.469                             |
| realized_pnl | Settled PnL (USD)             | 234567                            |
| daily_30d    | 30-day avg daily trades       | 3.2                               |
| market_count | Markets participated          | 289                               |

### From MCP SQL positions (Step 3)

| Field                 | Meaning                                            |
| --------------------- | -------------------------------------------------- |
| condition_id          | Market contract hash (add 0x prefix for Gamma API) |
| market_id             | Market ID                                          |
| realized_pnl (rpnl)   | Settled PnL for this market                        |
| unrealized_pnl (upnl) | Unrealized PnL (may be unreliable)                 |
| total_bought (bought) | Total buy amount for this market                   |
| is_closed             | 1 = settled, 0 = active                            |
| outcome_side          | yes / no                                           |

### From MCP SQL trades (Step 5)

| Field        | Meaning                                      |
| ------------ | -------------------------------------------- |
| usd_amount   | Single trade amount (USD)                    |
| price        | Buy/sell price (0~1, represents probability) |
| side         | buy / sell                                   |
| outcome_side | yes / no                                     |
| traded_at    | Trade time (UTC)                             |

### From Gamma API / MCP markets (Step 4)

| Field    | Meaning                             |
| -------- | ----------------------------------- |
| question | Full market question in English     |
| url      | Polymarket link                     |
| end_date | Market expiry date                  |
| category | Category label (for domain mapping) |

### From Polymarket Data API (Step 2.5)

| Field        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| title        | Market title (human-readable)                                            |
| outcome      | Position direction (Yes/No/Up/Down etc.)                                 |
| size         | Current shares held                                                      |
| avgPrice     | Average entry price (0~1)                                                |
| curPrice     | Current market price (0~1), 0 for expired                                |
| initialValue | Cost basis = size × avgPrice                                             |
| currentValue | Current value = size × curPrice                                          |
| cashPnl      | Unrealized PnL = currentValue - initialValue                             |
| totalBought  | Total buy amount for this position                                       |
| realizedPnl  | Realized PnL for this position                                           |
| eventSlug    | Event URL path (combine with `https://polymarket.com/event/<eventSlug>`) |

### Domain Codes

| Code | Label         | Emoji |
| ---- | ------------- | ----- |
| POL  | Politics      | 🏛️    |
| GEO  | Geopolitics   | 🌍    |
| FIN  | Macro Finance | 💹    |
| CRY  | Crypto        | ₿     |
| SPT  | Sports        | ⚽    |
| TEC  | Tech & AI     | 🤖    |
| CUL  | Culture       | 🎬    |
| GEN  | General       | 📊    |

---

## Metric Source Reference (Anti-Fabrication)

| Output Metric                   | Data Source                                    | Calculation                           |
| ------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Username                        | MCP get_trader_detail                          | trader.username                       |
| Type (label)                    | JSON Profile                                   | Direct read                           |
| Expert Domains                  | JSON Profile                                   | Direct read domains field             |
| Markets Participated            | JSON market_count or MCP SQL positions count() | Direct read or count                  |
| Settled Markets                 | MCP SQL positions                              | countIf(is_closed=1)                  |
| Active Positions                | MCP SQL positions                              | countIf(is_closed=0)                  |
| Avg Daily Trades                | JSON Profile                                   | Direct read daily_30d                 |
| Settled PnL                     | MCP SQL positions (is_closed=1)                | sum(rpnl) where is_closed=1           |
| Unrealized PnL                  | **Polymarket Data API**                        | sum(cashPnl) from Step 2.5            |
| **Total PnL (matches Profile)** | MCP closed rpnl + Data API cashPnl             | sum(rpnl where closed) + sum(cashPnl) |
| Portfolio Value                 | **Polymarket Data API**                        | sum(currentValue) from Step 2.5       |
| Capital Deployed                | MCP SQL positions                              | sum(bought)                           |
| Overall ROI                     | Computed                                       | totalPnL / sum(bought)                |
| Overall Win Rate                | JSON win_rate or MCP SQL                       | wins/closed                           |
| Domain Win Rate                 | MCP SQL positions + category                   | Group by category then wins/closed    |
| Large Position Win Rate         | MCP SQL positions                              | Filter bought>=10000 then wins/closed |
| Top/Bottom Market PnL           | MCP SQL positions                              | max/min rpnl + market name            |
| Active Positions List           | **Polymarket Data API**                        | Step 2.5 positions array              |
| Recent Trades                   | MCP SQL trades                                 | Last 50 trades                        |
| Total Volume                    | JSON Profile or MCP get_trader_detail          | Direct read                           |

**NEVER output metrics not in this table**, e.g.:

- ❌ "First trade date" — no data source for complete history
- ❌ "Active days" — no data source
- ❌ "30-day PnL" — trades data window is limited
- ❌ "Equity curve trend" — no time-series data
- ❌ "Average holding period" — positions lack open/close timestamps
- ❌ "Maximum drawdown" — no time-series data

---

## Self-Validation Checklist (Must check EVERY item before output)

After generating output, **self-check every item below**. If any fails, fix and regenerate:

- [ ] Every address queried via both MCP `get_trader_detail` and `node query-smart-money.js addr` (even if result is "not found")
- [ ] **PnL uses accurate calculation**: Total PnL = MCP positions closed sum(rpnl) + Data API sum(cashPnl), NOT just JSON realized_pnl
- [ ] **Polymarket Data API queried**: every address fetched via `data-api.polymarket.com/positions` for real-time cashPnl
- [ ] Every address's label / win_rate / domains strictly from query-smart-money.js output or MCP SQL computation — no fabrication
- [ ] Every domain win rate number (wins/closed/total) traceable to MCP positions + market category data
- [ ] Every market name (question) strictly from Gamma API / MCP / Data API return values — NOT AI guesses
- [ ] All amounts/win rates/ROI numbers come from data sources — no "looks reasonable" fabrication
- [ ] All addresses shown as full 42 characters (0x + 40 hex), no abbreviation
- [ ] Every address is a clickable Markdown hyperlink: `[0xfullAddress](https://polymarket.com/profile/0xfullAddress)`
- [ ] All market names are clickable Markdown hyperlinks `[question](url)` format
- [ ] MM addresses have market maker warning, SIGNAL addresses have second-hand copy-trade warning
- [ ] Comparison mode: every domain shows win rate + wins/settled count + total markets (all three dimensions)
- [ ] Comparison conclusions and copy-trade advice backed by data, not generic statements
- [ ] If any field fetch fails (API timeout etc.), mark as "(Data fetch failed)" not fabricated
- [ ] No forbidden metrics appear (first trade date, active days, 30-day PnL, equity curve, holding period, max drawdown)
- [ ] **No internal data source names in output**: no specific database names, internal JSON artifacts, provider API names, MCP, internal script names, or table names — footer uses `Powered by PredicTradar`

---

## Error Handling

| Scenario                                 | Action                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| MCP API unreachable                      | Check the shared MCP wrapper connectivity; if timeout, report "Data service temporarily unavailable"                   |
| get_trader_detail no result              | Address may not be in database; skip username, continue with SQL queries                                              |
| Address not in smart money JSON          | Label as "Unclassified", still query via MCP SQL, output with "⚠️ Not in smart money database, no historical profile" |
| MCP SQL returns empty                    | Report "No position records for this address, may be new or not yet synced"; output only available data               |
| Gamma API all timeouts                   | Use first 16 chars of condition_id as placeholder, note "Market names unavailable"                                    |
| Data API timeout                         | Skip real-time PnL section, use only MCP positions realized_pnl (note "Unrealized PnL data temporarily unavailable")  |
| Comparison mode: one address has no data | Mark that address column as "No data", do not affect other addresses                                                  |
| smart-money cache unavailable            | Continue without local labels/domains; rely on MCP trader detail + positions instead                                  |
| condition_id not found in Gamma API      | Market may be delisted; mark "Market info unavailable", still show PnL numbers                                        |

---

## User Intent Mapping

| User Says                                         | Action                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Analyze 0x1234..."                               | Single address analysis, full Step 1-7                                       |
| "Check this wallet 0x1234..."                     | Same as above                                                                |
| "Compare 0xAAA and 0xBBB"                         | Multi-address comparison mode                                                |
| "How does 0xBBB compare to 0xAAA?"                | Multi-address comparison mode                                                |
| "Which of these three addresses is best to copy?" | Multi-address comparison, emphasize copy-trade recommendations               |
| "How is 0x1234 in crypto?"                        | Single address analysis, emphasize CRY domain data                           |
| "What are 0x1234's active positions?"             | Single address analysis, expand active positions list (not limited to Top 5) |

---

## Important Notes

1. **MCP is the primary data channel**: All SQL queries should go through `mcp.query(...)` / `mcp.queryWithRetry(...)` in the shared wrapper — no direct MCP request plumbing in this skill.
2. **Smart-money cache is optional enrichment**: when present, it can add labels/domains/ROI context; if absent, do not block the analysis.
3. **MCP positions unrealized_pnl may be unreliable**: field may be all zeros. Must use Polymarket Data API cashPnl instead.
4. **Polymarket Data API is critical for accurate PnL**: `data-api.polymarket.com/positions` provides real-time curPrice, currentValue, cashPnl — matches Profile page.
5. **trades data window is limited**: only for showing recent activity, not for long-term statistics.
6. **positions data is comprehensive (but may have duplicates)**: contains all historical positions for the address (settled + active) — core data for domain win rate calculation. Deduplicate when computing stats.
7. **Gamma API condition_id needs 0x prefix**: positions table condition_id has no 0x; must prepend when querying Gamma API.
8. **Request intervals**: Gamma API at least 400ms/batch, Data API at least 500ms/page. MCP API has built-in rate limiting.
9. **Comparison mode max 5 addresses**: prompt user to reduce if more than 5, to avoid excessive queries and overly long output.
10. **price field is probability, not USD**: 0.62 means the market estimates a 62% probability of the event occurring.
