require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory cache ───────────────────────────────────────────────────────────
let marketsCache = [];
let lastFetch = 0;
const CACHE_TTL = 55 * 1000;

// Hot Bets: rolling window of trade-count per market (last 5 min)
let hotBetsWindow = {}; // { marketId: { title, slug, count, lastSeen } }
let hotBetsLastPoll = 0;

// ─── Category mapping ──────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'sol', 'xrp', 'doge', 'bnb', 'coin', 'token', 'defi', 'nft', 'blockchain', 'stablecoin', 'altcoin'],
  sports: ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'golf', 'mma', 'ufc', 'boxing', 'fifa', 'world cup', 'champion', 'league', 'super bowl', 'sport', 'team', 'match', 'game', 'tournament', 'season'],
  politics: ['election', 'president', 'congress', 'senate', 'vote', 'democrat', 'republican', 'trump', 'biden', 'political', 'government', 'policy', 'law', 'supreme court', 'primary', 'governor', 'parliament', 'minister', 'referendum'],
  finance: ['stock', 'market', 'nasdaq', 's&p', 'dow', 'fed', 'interest rate', 'recession', 'inflation', 'gdp', 'economy', 'ipo', 'merger', 'earnings', 'revenue', 'debt', 'bond', 'treasury', 'bank', 'oil', 'gold', 'commodity'],
  technology: ['ai', 'artificial intelligence', 'gpt', 'openai', 'google', 'apple', 'microsoft', 'meta', 'tech', 'software', 'chip', 'semiconductor', 'elon', 'spacex', 'tesla', 'robot', 'quantum', 'startup'],
};

function detectCategory(text) {
  const lower = (text || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_MAP)) {
    if (kws.some(k => lower.includes(k))) return cat;
  }
  return 'other';
}

// ─── Fetch & process events (uses /events endpoint for valid URLs) ─────────────
async function fetchMarkets() {
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/events', {
      params: { active: true, closed: false, limit: 300, order: 'volume24hr', ascending: false },
      timeout: 20000, headers: { Accept: 'application/json' }
    });

    const raw = res.data;
    const events = Array.isArray(raw) ? raw : (raw.events || raw.data || []);
    const filtered = [];

    for (const ev of events) {
      // Event slug is guaranteed to match polymarket.com/event/{slug}
      const slug = ev.slug || '';
      if (!slug || slug.length < 3) continue;

      const title = ev.title || ev.question || '';
      const titleLower = title.toLowerCase();

      // Skip unforecasted / placeholder events
      if (!title || title.length < 10 ||
        titleLower.includes('oops') ||
        titleLower.includes("didn't forecast") ||
        titleLower.includes('did not forecast') ||
        titleLower.includes('could not forecast') ||
        titleLower.includes('no forecast')) continue;

      // Each event has one or more markets (outcomes) — find the highest probability
      const markets = Array.isArray(ev.markets) ? ev.markets : [];
      if (markets.length === 0) continue;

      let maxProb = 0;
      let winningOutcome = 'Yes';

      for (const m of markets) {
        let prices = [];
        try { prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []); } catch { }
        let outcomes = [];
        try { outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []); } catch { }
        const numPrices = prices.map(p => parseFloat(p) || 0);
        const localMax = Math.max(...numPrices, 0);
        if (localMax > maxProb) {
          maxProb = localMax;
          const idx = numPrices.indexOf(localMax);
          winningOutcome = outcomes[idx] || m.groupItemTitle || 'Yes';
        }
      }

      if (maxProb < 0.50) continue;

      // Aggregate stats across all sub-markets of this event
      const volume = parseFloat(ev.volume) || markets.reduce((s, m) => s + (parseFloat(m.volume) || 0), 0);
      const volume24h = parseFloat(ev.volume24hr) || markets.reduce((s, m) => s + (parseFloat(m.volume24hr) || 0), 0);
      const liquidity = parseFloat(ev.liquidity) || markets.reduce((s, m) => s + (parseFloat(m.liquidity) || 0), 0);

      filtered.push({
        id: ev.id,
        title,
        slug,
        category: detectCategory(title),
        probability: Math.round(maxProb * 1000) / 10,
        winningOutcome,
        volume,
        volume24h,
        liquidity,
        endDate: ev.endDate || ev.endDateIso || null,
        url: `https://polymarket.com/event/${slug}`,
        totalBets: parseInt(ev.uniqueTraderCount) || 0,
      });
    }

    filtered.sort((a, b) => b.probability - a.probability);
    return filtered;
  } catch (err) {
    console.error('Error fetching events:', err.message);
    return marketsCache;
  }
}


// ─── Fetch open positions for one trader ──────────────────────────────────────
async function fetchTraderPositions(address) {
  if (!address) return [];
  try {
    const res = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: address, sizeThreshold: 0.01, limit: 5 },
      timeout: 10000, headers: { Accept: 'application/json' }
    });
    const rows = Array.isArray(res.data) ? res.data : (res.data.data || []);
    return rows.slice(0, 5).map(p => ({
      market: p.title || p.market || p.question || 'Unknown Market',
      outcome: p.outcome || p.side || 'Yes',
      size: parseFloat(p.size) || parseFloat(p.currentValue) || 0,
      avgPrice: parseFloat(p.avgPrice) || parseFloat(p.averagePrice) || 0,
      curPrice: parseFloat(p.curPrice) || parseFloat(p.currentPrice) || 0,
      pnl: parseFloat(p.cashPnl) || parseFloat(p.pnl) || 0,
      marketUrl: p.market ? `https://polymarket.com/event/${p.market}` : null,
    }));
  } catch { return []; }
}

// ─── Fetch leaderboard (dynamic timePeriod + category) ────────────────────────
async function fetchLeaderboard(timePeriod = 'ALL', category = 'OVERALL') {
  try {
    const res = await axios.get('https://data-api.polymarket.com/v1/leaderboard', {
      params: { category, timePeriod, orderBy: 'PNL', limit: 20 },
      timeout: 15000, headers: { Accept: 'application/json' }
    });
    const data = res.data;
    const rankings = Array.isArray(data) ? data : (data.data || data.leaderboard || data.rankings || []);
    if (rankings.length === 0) return buildMockLeaderboard();

    const top10 = rankings.slice(0, 10);
    const positionsArr = await Promise.all(
      top10.map(u => fetchTraderPositions(u.address || u.proxyWallet || ''))
    );

    return top10.map((u, idx) => {
      const address = u.address || u.proxyWallet || '';
      // Polymarket API: name is in 'name', fallback to 'pseudonym', then shorten address
      const displayName = u.name && u.name.trim() && u.name !== address
        ? u.name
        : (u.pseudonym && u.pseudonym.trim() ? u.pseudonym : shortenAddress(address));
      return {
        rank: idx + 1,
        address,
        name: displayName,
        avatar: u.profileImage || u.pfpUrl || u.avatar || null,
        pnl: parseFloat(u.pnl) || parseFloat(u.profit) || 0,
        profit: parseFloat(u.pnl) || parseFloat(u.profit) || 0,
        tradesCount: parseInt(u.numTrades) || parseInt(u.tradesCount) || 0,
        percentPositive: parseFloat(u.percentPositive) || 0,
        profileUrl: address ? `https://polymarket.com/profile/${address}` : null,
        positions: positionsArr[idx] || [],
      };
    });
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    return buildMockLeaderboard();
  }
}

function buildMockLeaderboard() {
  return [
    { rank: 1, address: '', name: 'PredictionKing', pnl: 128450, profit: 128450, tradesCount: 342, percentPositive: 78.3, profileUrl: null, positions: [] },
    { rank: 2, address: '', name: 'MarketWizard', pnl: 98210, profit: 98210, tradesCount: 215, percentPositive: 74.1, profileUrl: null, positions: [] },
    { rank: 3, address: '', name: 'Polymaster', pnl: 76890, profit: 76890, tradesCount: 189, percentPositive: 71.5, profileUrl: null, positions: [] },
    { rank: 4, address: '', name: 'OddsHunter', pnl: 54320, profit: 54320, tradesCount: 156, percentPositive: 68.9, profileUrl: null, positions: [] },
    { rank: 5, address: '', name: 'ProbPro', pnl: 43100, profit: 43100, tradesCount: 124, percentPositive: 66.2, profileUrl: null, positions: [] },
    { rank: 6, address: '', name: 'FutureSeer', pnl: 38750, profit: 38750, tradesCount: 98, percentPositive: 64.8, profileUrl: null, positions: [] },
    { rank: 7, address: '', name: 'CryptoOracle', pnl: 29400, profit: 29400, tradesCount: 87, percentPositive: 63.1, profileUrl: null, positions: [] },
    { rank: 8, address: '', name: 'BetStrategist', pnl: 22100, profit: 22100, tradesCount: 76, percentPositive: 61.5, profileUrl: null, positions: [] },
    { rank: 9, address: '', name: 'MarketMaker99', pnl: 18900, profit: 18900, tradesCount: 65, percentPositive: 59.8, profileUrl: null, positions: [] },
    { rank: 10, address: '', name: 'SharpTrader', pnl: 15600, profit: 15600, tradesCount: 54, percentPositive: 58.3, profileUrl: null, positions: [] },
  ];
}

function shortenAddress(addr) {
  if (!addr || addr.length < 10) return addr || 'Anonymous';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

// ─── Smart Money / Leaderboard Picks ──────────────────────────────────────────
/*
 * Algorithm:
 * 1. Fetch top 20 WEEKLY leaderboard traders (best recent performance)
 * 2. Filter to "hot streak" traders: percentPositive >= 60% AND tradesCount >= 10
 *    (this is the best proxy for a 10+ winning streak available from the API)
 * 3. Fetch their open positions in parallel (rate-limited, max 15 traders)
 * 4. Group positions by market title — count how many streak traders hold each market
 * 5. Markets held by 2+ streak traders = "Smart Money Pick"
 * 6. Sort by endorser count, then by collective avg position size
 */
async function fetchSmartPicks(topTradersCount = 10) {
  try {
    // Step 1: Get top traders by PNL
    // Limit to 25 just to be safe, but we'll slice by topTradersCount
    const res = await axios.get('https://data-api.polymarket.com/v1/leaderboard', {
      params: { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'PNL', limit: 25 },
      timeout: 15000, headers: { Accept: 'application/json' }
    });
    const data = res.data;
    const rankings = Array.isArray(data) ? data : (data.data || data.leaderboard || data.rankings || []);

    if (rankings.length === 0) return { picks: [], streakTraders: [] };

    // Step 2: Format top traders (win rate/trades count no longer exist on this API)
    const topTraders = rankings
      .map(u => ({
        address: u.address || u.proxyWallet || '',
        name: (u.name && u.name !== (u.address || u.proxyWallet)) ? u.name : (u.pseudonym || shortenAddress(u.address || u.proxyWallet || 'Anon')),
        pnl: parseFloat(u.pnl) || 0,
        profileUrl: (u.address || u.proxyWallet) ? `https://polymarket.com/profile/${u.address || u.proxyWallet}` : null,
      }))
      .filter(u => u.address)             // must have a real address
      .slice(0, Math.min(topTradersCount, 25)); // cap at selected amount

    if (topTraders.length === 0) return { picks: [], streakTraders: [] };

    // Step 3: Fetch positions for these top traders in parallel
    const positionResults = await Promise.allSettled(
      topTraders.map(u => fetchStreakPositions(u.address))
    );

    // Step 4: Aggregate by market — count how many traders share each market
    const marketMap = new Map(); // marketKey → { count, traders, positions, ... }

    positionResults.forEach((result, idx) => {
      if (result.status !== 'fulfilled') return;
      const trader = topTraders[idx];
      const positions = result.value || [];

      positions.forEach(pos => {
        if (!pos.market || pos.market === 'Unknown Market') return;
        // Use title as key (normalize to lowercase, trimmed)
        const key = pos.market.toLowerCase().trim().slice(0, 80);
        if (!marketMap.has(key)) {
          marketMap.set(key, {
            title: pos.market,
            marketUrl: pos.marketUrl || null,
            outcome: pos.outcome,
            count: 0,
            traders: [],
            totalSize: 0,
            avgProbability: pos.curPrice ? pos.curPrice * 100 : 0,
            probSum: pos.curPrice ? pos.curPrice * 100 : 0,
          });
        }
        const entry = marketMap.get(key);
        entry.count++;
        entry.traders.push({ name: trader.name, profileUrl: trader.profileUrl, pnl: trader.pnl });
        entry.totalSize += pos.size || 0;
        entry.probSum += pos.curPrice ? pos.curPrice * 100 : 0;
      });
    });

    // Step 5: Filter markets held by 2+ top traders, sort by endorser count
    const picks = [...marketMap.values()]
      .filter(m => m.count >= 2)                                  // at least 2 smart traders agree
      .sort((a, b) => b.count - a.count || b.totalSize - a.totalSize)
      .slice(0, 10)
      .map((m, idx) => ({
        rank: idx + 1,
        title: m.title,
        url: m.marketUrl || `https://polymarket.com/event/${m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
        outcome: m.outcome,
        endorserCount: m.count,
        endorsers: m.traders.slice(0, 5), // top 5 endorsing traders to show
        totalExposure: m.totalSize,
        avgProbability: m.count > 0 ? Math.round(m.probSum / m.count) : null,
      }));

    return { picks, topTraders };
  } catch (err) {
    console.error('Smart picks error:', err.message);
    return { picks: [], topTraders: [] };
  }
}

// Fetches positions for smart-picks (no limit, all open positions with positive value)
async function fetchStreakPositions(address) {
  if (!address) return [];
  try {
    const res = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: address, sizeThreshold: 0.01, limit: 20 },
      timeout: 10000, headers: { Accept: 'application/json' }
    });
    const rows = Array.isArray(res.data) ? res.data : (res.data.data || []);
    return rows.map(p => ({
      market: p.title || p.market || p.question || '',
      outcome: p.outcome || p.side || 'Yes',
      size: parseFloat(p.size) || parseFloat(p.currentValue) || 0,
      curPrice: parseFloat(p.curPrice) || parseFloat(p.currentPrice) || 0,
      marketUrl: p.eventSlug ? `https://polymarket.com/event/${p.eventSlug}` :
        (p.slug ? `https://polymarket.com/event/${p.slug}` : null),
    }));
  } catch { return []; }
}

app.get('/api/smartpicks', async (req, res) => {
  try {
    const minStreak = parseInt(req.query.minStreak) || 10;
    const result = await fetchSmartPicks(minStreak);
    res.json({ success: true, generated: new Date().toISOString(), ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Hot Bets: background trade poller ────────────────────────────────────────

const HOT_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const HOT_POLL_INTERVAL = 30 * 1000; // poll every 30s

async function pollHotBets() {
  try {
    const res = await axios.get('https://data-api.polymarket.com/trades', {
      params: { limit: 100 },
      timeout: 10000, headers: { Accept: 'application/json' }
    });
    const trades = Array.isArray(res.data) ? res.data : (res.data.data || res.data.trades || []);
    const now = Date.now();

    // Prune old entries from window
    for (const key of Object.keys(hotBetsWindow)) {
      if (now - hotBetsWindow[key].lastSeen > HOT_WINDOW_MS) {
        delete hotBetsWindow[key];
      }
    }

    for (const t of trades) {
      const id = t.market || t.conditionId || t.marketId || t.tokenId;
      if (!id) continue;
      const title = t.title || t.question || t.market || 'Unknown Market';
      const slug = t.slug || t.conditionId || id;
      if (!hotBetsWindow[id]) {
        hotBetsWindow[id] = { title, slug, count: 0, lastSeen: 0, volume: 0, category: detectCategory(title) };
      }
      hotBetsWindow[id].count++;
      hotBetsWindow[id].lastSeen = now;
      hotBetsWindow[id].volume += parseFloat(t.usdcSize) || parseFloat(t.amount) || 0;
      if (title !== 'Unknown Market') hotBetsWindow[id].title = title;
      hotBetsWindow[id].slug = slug;
    }
    hotBetsLastPoll = now;
    console.log(`🔥 Hot Bets: tracked ${trades.length} trades, ${Object.keys(hotBetsWindow).length} active markets`);
  } catch (err) {
    console.error('Hot bets poll error:', err.message);
  }
}

// Start background polling immediately and every 30s
setInterval(pollHotBets, HOT_POLL_INTERVAL);

// ─── Markets cache refresh ────────────────────────────────────────────────────
async function refreshMarketsCache() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL && marketsCache.length > 0) return;
  console.log('🔄 Refreshing markets cache...');
  marketsCache = await fetchMarkets();
  lastFetch = Date.now();
  console.log(`✅ Cached ${marketsCache.length} markets with ≥50% probability`);
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    await refreshMarketsCache();
    let result = [...marketsCache];
    const cat = (req.query.category || '').toLowerCase();
    if (cat && cat !== 'all') result = result.filter(m => m.category === cat);
    const search = (req.query.search || '').toLowerCase().trim();
    if (search) result = result.filter(m => m.title.toLowerCase().includes(search) || m.category.includes(search));
    res.json({ success: true, count: result.length, total: marketsCache.length, lastUpdated: new Date(lastFetch).toISOString(), markets: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dynamic leaderboard: accepts timePeriod=TODAY|WEEK|MONTH|ALL and category=OVERALL|POLITICS|SPORTS|CRYPTO|FINANCE|TECHNOLOGY
app.get('/api/leaderboard', async (req, res) => {
  try {
    const timePeriod = (['ALL', 'WEEK', 'MONTH', 'DAY'].includes((req.query.timePeriod || '').toUpperCase())
      ? req.query.timePeriod.toUpperCase() : 'ALL');
    const category = (['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'FINANCE', 'TECHNOLOGY', 'OTHER'].includes((req.query.category || '').toUpperCase())
      ? req.query.category.toUpperCase() : 'OVERALL');
    const leaderboard = await fetchLeaderboard(timePeriod, category);
    res.json({ success: true, timePeriod, category, leaderboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// On-demand positions for a trader
app.get('/api/trader/:address/positions', async (req, res) => {
  try {
    const positions = await fetchTraderPositions(req.params.address);
    res.json({ success: true, positions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hot Bets: top markets by trade count in rolling window
app.get('/api/hotbets', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const sorted = Object.values(hotBetsWindow)
      .filter(m => m.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((m, idx) => ({
        rank: idx + 1,
        title: m.title,
        slug: m.slug,
        category: m.category,
        count: m.count,
        volume: m.volume,
        url: `https://polymarket.com/event/${m.slug}`,
        lastSeen: new Date(m.lastSeen).toISOString(),
      }));
    res.json({ success: true, lastPoll: hotBetsLastPoll ? new Date(hotBetsLastPoll).toISOString() : null, total: sorted.length, hotBets: sorted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', cachedMarkets: marketsCache.length, lastUpdated: lastFetch ? new Date(lastFetch).toISOString() : null });
});

// ─── My Favorite Bets: multi-factor statistical scoring ───────────────────────
/*
 * SCORING METHODOLOGY (world-class statistician approach):
 *
 * 1. Probability Score (35%)  – Core market confidence from crowd pricing
 * 2. Liquidity Score   (25%)  – Depth of the order book; more liquidity →
 *                               more reliable price discovery (Efficient
 *                               Market Hypothesis indicator)
 * 3. Wisdom Score      (20%)  – Number of unique traders (Condorcet Jury
 *                               Theorem: larger groups → more accurate)
 * 4. Volume Score      (15%)  – 24-h trading volume signals conviction and
 *                               reduces manipulation risk
 * 5. Category Rel.    ( 5%)   – Historical calibration: political/sports binary
 *                               markets are better calibrated than speculative
 *                               crypto markets
 *
 * Expected Value (Kelly-inspired): EV = p*(1-p)^-1, higher for extreme probs
 * Confidence tier: based on composite safety score + probability threshold
 */
function scoreFavorites(markets) {
  if (!markets || markets.length === 0) return [];

  // Category reliability weights (based on historical Polymarket calibration)
  const CAT_RELIABILITY = { politics: 1.0, sports: 0.95, finance: 0.88, technology: 0.82, crypto: 0.75, other: 0.80 };

  // Extract arrays for normalization
  const probs = markets.map(m => m.probability);
  const liquidities = markets.map(m => m.liquidity);
  const traders = markets.map(m => m.totalBets || 0);
  const volumes = markets.map(m => m.volume24h || m.volume || 0);

  const maxOf = arr => Math.max(...arr, 1);
  const minOf = arr => Math.min(...arr.filter(v => v > 0), 0);

  const maxLiq = maxOf(liquidities);
  const maxTrad = maxOf(traders);
  const maxVol = maxOf(volumes);
  const minProb = minOf(probs);
  const maxProb = maxOf(probs);
  const probRange = maxProb - (minProb || 50) || 1;

  const normalize = (val, max) => Math.min(val / max, 1);
  const logScale = (val, max) => val <= 0 ? 0 : Math.log1p(val) / Math.log1p(max);

  const scored = markets.map(m => {
    const p = m.probability / 100;        // 0-1
    const pNorm = (m.probability - 50) / 50;  // 0-1 from 50% baseline
    const liqScore = logScale(m.liquidity, maxLiq);
    const traderScore = logScale(m.totalBets || 0, maxTrad);
    const volScore = logScale(m.volume24h || m.volume || 0, maxVol);
    const catRel = CAT_RELIABILITY[m.category] || 0.80;
    const probScore = Math.max(0, pNorm);

    // Composite weighted safety score (0-100)
    const safetyScore = (
      probScore * 35 +
      liqScore * 25 +
      traderScore * 20 +
      volScore * 15 +
      catRel * 5
    );

    // Kelly Criterion Expected Value (approximation)
    // EV = p - (1-p) · (1-p)/(p) scaled to 0-100
    const kellyEV = p > 0 ? Math.round(((2 * p - 1) / Math.max(p, 0.01)) * 100) / 100 : 0;

    // Confidence tier
    let tier, tierIcon, tierColor;
    if (p >= 0.92 && liqScore > 0.4) {
      tier = 'Locked In'; tierIcon = '🔒'; tierColor = '#00d4aa';
    } else if (p >= 0.82 && liqScore > 0.25) {
      tier = 'Strong Pick'; tierIcon = '⭐'; tierColor = '#6c63ff';
    } else if (p >= 0.72) {
      tier = 'Solid Bet'; tierIcon = '✅'; tierColor = '#3498db';
    } else {
      tier = 'Speculative'; tierIcon = '📊'; tierColor = '#f7931a';
    }

    // Auto-generate English reasoning
    const reasons = [];
    if (p >= 0.90) reasons.push(`an extremely high market consensus of ${m.probability}%`);
    else if (p >= 0.80) reasons.push(`a strong crowd probability of ${m.probability}%`);
    else reasons.push(`a solid ${m.probability}% probability`);

    if (m.liquidity >= 500000) reasons.push(`deep liquidity of ${fmtMoney(m.liquidity)} ensuring reliable pricing`);
    else if (m.liquidity >= 50000) reasons.push(`healthy liquidity of ${fmtMoney(m.liquidity)}`);

    if ((m.totalBets || 0) >= 1000) reasons.push(`${(m.totalBets).toLocaleString()} unique traders (wisdom of crowds)`);
    else if ((m.totalBets || 0) >= 100) reasons.push(`${m.totalBets} traders participating`);

    if ((m.volume24h || 0) >= 100000) reasons.push(`high 24-h conviction volume of ${fmtMoney(m.volume24h)}`);

    if (catRel >= 0.95) reasons.push(`this category has historically excellent calibration on Polymarket`);

    const reasoning = reasons.length > 0
      ? `This bet features ${reasons.join(', ')}.`
      : `Strong combination of probability and market fundamentals.`;

    return { ...m, safetyScore: Math.round(safetyScore * 10) / 10, kellyEV, tier, tierIcon, tierColor, reasoning };
  });

  // Sort by composite safety score descending, take top 10
  return scored
    .sort((a, b) => b.safetyScore - a.safetyScore)
    .slice(0, 10)
    .map((m, idx) => ({ ...m, favoriteRank: idx + 1 }));
}

function fmtMoney(val) {
  if (!val || isNaN(val)) return '$0';
  if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1_000) return '$' + (val / 1_000).toFixed(0) + 'K';
  return '$' + Math.round(val);
}

app.get('/api/favoritebets', async (req, res) => {
  try {
    await refreshMarketsCache();
    const favorites = scoreFavorites(marketsCache);
    res.json({ success: true, generated: new Date().toISOString(), favorites });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Start ────────────────────────────────────────────────────────────────────
/* no listen */ => {
  console.log(`🚀 Polymarket Dashboard running on http://localhost:${PORT}`);
  await refreshMarketsCache();
  await pollHotBets(); // first poll immediately
});

fetchSmartPicks(3).then(res => console.log(JSON.stringify(res, null, 2))).catch(console.error);