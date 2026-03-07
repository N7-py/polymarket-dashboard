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

// ─── Fetch & process markets ───────────────────────────────────────────────────
async function fetchMarkets() {
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { active: true, closed: false, limit: 500, order: 'volume24hr', ascending: false },
      timeout: 15000, headers: { Accept: 'application/json' }
    });
    const raw = res.data;
    const markets = Array.isArray(raw) ? raw : (raw.markets || raw.data || []);
    const filtered = [];
    for (const m of markets) {
      let prices = [];
      try { prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []); } catch { }
      let outcomes = [];
      try { outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []); } catch { }
      const numPrices = prices.map(p => parseFloat(p) || 0);
      const maxProb = Math.max(...numPrices);
      const maxIdx = numPrices.indexOf(maxProb);
      if (maxProb >= 0.50) {
        const title = m.question || m.title || '';
        // Skip markets with placeholder or unforecasted content
        const titleLower = title.toLowerCase();
        if (!title ||
          titleLower.includes("oops") ||
          titleLower.includes("didn't forecast") ||
          titleLower.includes("did not forecast") ||
          titleLower.includes("could not forecast") ||
          titleLower.includes("no forecast") ||
          titleLower.includes("unknown market") ||
          title.length < 10) continue;

        filtered.push({
          id: m.id, title,
          slug: m.slug || m.conditionId || m.id,
          category: detectCategory(title),
          probability: Math.round(maxProb * 1000) / 10,
          winningOutcome: outcomes[maxIdx] || 'Yes',
          volume: parseFloat(m.volume) || 0,
          volume24h: parseFloat(m.volume24hr) || 0,
          liquidity: parseFloat(m.liquidity) || 0,
          endDate: m.endDate || m.endDateIso || null,
          url: `https://polymarket.com/event/${m.slug || m.id}`,
          totalBets: parseInt(m.uniqueTraderCount) || 0,
        });
      }
    }
    filtered.sort((a, b) => b.probability - a.probability);
    return filtered;
  } catch (err) {
    console.error('Error fetching markets:', err.message);
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Dashboard running on http://localhost:${PORT}`);
  await refreshMarketsCache();
  await pollHotBets(); // first poll immediately
});
