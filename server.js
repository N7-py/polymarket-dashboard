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
let leaderboardCache = [];
let lastFetch = 0;
const CACHE_TTL = 55 * 1000; // 55 seconds

// ─── Category mapping by keywords ─────────────────────────────────────────────
const CATEGORY_MAP = {
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'sol', 'xrp', 'dogecoin', 'doge', 'bnb', 'coin', 'token', 'defi', 'nft', 'blockchain', 'stablecoin', 'altcoin'],
  sports: ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'golf', 'mma', 'ufc', 'boxing', 'fifa', 'world cup', 'champion', 'league', 'superbowl', 'super bowl', 'sport', 'team', 'player', 'match', 'game', 'tournament', 'win', 'season'],
  politics: ['election', 'president', 'congress', 'senate', 'vote', 'democrat', 'republican', 'trump', 'biden', 'political', 'government', 'policy', 'law', 'supreme court', 'primary', 'governor', 'mayor', 'parliament', 'minister', 'referendum', 'poll'],
  finance: ['stock', 'market', 'nasdaq', 's&p', 'dow', 'fed', 'interest rate', 'recession', 'inflation', 'gdp', 'economy', 'ipo', 'merger', 'acquisition', 'earnings', 'revenue', 'debt', 'bond', 'treasury', 'financial', 'bank', 'oil', 'gold', 'commodity'],
  technology: ['ai', 'artificial intelligence', 'gpt', 'openai', 'google', 'apple', 'microsoft', 'meta', 'tech', 'software', 'hardware', 'chip', 'semiconductor', 'elon', 'spacex', 'tesla', 'robot', 'automation', 'quantum', 'startup', 'ipo tech'],
};

function detectCategory(text) {
  const lower = (text || '').toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  return 'other';
}

// ─── Fetch & process markets ──────────────────────────────────────────────────
async function fetchMarkets() {
  try {
    const response = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: {
        active: true,
        closed: false,
        limit: 500,
        order: 'volume24hr',
        ascending: false,
      },
      timeout: 15000,
      headers: { 'Accept': 'application/json' }
    });

    const raw = response.data;
    const markets = Array.isArray(raw) ? raw : (raw.markets || raw.data || []);

    const filtered = [];

    for (const m of markets) {
      // Parse outcome prices - they come as array of string numbers like ["0.72","0.28"]
      let prices = [];
      try {
        if (typeof m.outcomePrices === 'string') {
          prices = JSON.parse(m.outcomePrices);
        } else if (Array.isArray(m.outcomePrices)) {
          prices = m.outcomePrices;
        }
      } catch (e) {
        prices = [];
      }

      let outcomes = [];
      try {
        if (typeof m.outcomes === 'string') {
          outcomes = JSON.parse(m.outcomes);
        } else if (Array.isArray(m.outcomes)) {
          outcomes = m.outcomes;
        }
      } catch (e) {
        outcomes = [];
      }

      // Find highest probability outcome
      const numPrices = prices.map(p => parseFloat(p) || 0);
      const maxProb = Math.max(...numPrices);
      const maxIdx = numPrices.indexOf(maxProb);
      const winningOutcome = outcomes[maxIdx] || 'Yes';

      if (maxProb >= 0.70) {
        const title = m.question || m.title || 'Unknown Market';
        const category = detectCategory(title);

        filtered.push({
          id: m.id,
          title,
          slug: m.slug || m.conditionId || m.id,
          category,
          probability: Math.round(maxProb * 1000) / 10, // e.g. 72.5
          winningOutcome,
          volume: parseFloat(m.volume) || parseFloat(m.volumeNum) || 0,
          volume24h: parseFloat(m.volume24hr) || 0,
          liquidity: parseFloat(m.liquidity) || parseFloat(m.liquidityNum) || 0,
          endDate: m.endDate || m.endDateIso || null,
          startDate: m.startDate || m.startDateIso || null,
          url: `https://polymarket.com/event/${m.slug || m.id}`,
          image: m.image || null,
          description: m.description || '',
          totalBets: parseInt(m.uniqueTraderCount) || 0,
        });
      }
    }

    // Sort by probability descending
    filtered.sort((a, b) => b.probability - a.probability);
    return filtered;
  } catch (err) {
    console.error('Error fetching markets:', err.message);
    return marketsCache; // Return stale cache on error
  }
}

// ─── Fetch open positions for a single trader ─────────────────────────────────
async function fetchTraderPositions(address) {
  if (!address || address === '0x...') return [];
  try {
    const res = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: address, sizeThreshold: 0.01, limit: 5 },
      timeout: 10000,
      headers: { 'Accept': 'application/json' }
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
  } catch (e) {
    return [];
  }
}

// ─── Fetch leaderboard ────────────────────────────────────────────────────────
async function fetchLeaderboard() {
  try {
    const response = await axios.get('https://data-api.polymarket.com/v1/leaderboard', {
      params: { category: 'OVERALL', timePeriod: 'ALL', orderBy: 'PNL', limit: 20 },
      timeout: 15000,
      headers: { 'Accept': 'application/json' }
    });

    const data = response.data;
    const rankings = Array.isArray(data) ? data : (data.data || data.leaderboard || data.rankings || []);
    if (rankings.length === 0) return buildMockLeaderboard();

    const top10 = rankings.slice(0, 10);

    // Fetch positions for all top-10 traders in parallel
    const positionsArr = await Promise.all(
      top10.map(u => fetchTraderPositions(u.address || u.proxyWallet || ''))
    );

    return top10.map((u, idx) => {
      const address = u.address || u.proxyWallet || '';
      return {
        rank: idx + 1,
        address,
        name: u.name || u.pseudonym || u.username || shortenAddress(address),
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
    console.error('Error fetching leaderboard:', err.message);
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
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ─── Cache refresh logic ──────────────────────────────────────────────────────
async function refreshCache() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL && marketsCache.length > 0) return;
  console.log('🔄 Refreshing markets cache...');
  marketsCache = await fetchMarkets();
  leaderboardCache = await fetchLeaderboard();
  lastFetch = Date.now();
  console.log(`✅ Cached ${marketsCache.length} markets with ≥70% probability`);
}

// ─── API Routes ──────────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    await refreshCache();
    let result = [...marketsCache];

    // Category filter
    const cat = (req.query.category || '').toLowerCase();
    if (cat && cat !== 'all') {
      result = result.filter(m => m.category === cat);
    }

    // Search filter
    const search = (req.query.search || '').toLowerCase().trim();
    if (search) {
      result = result.filter(m =>
        m.title.toLowerCase().includes(search) ||
        m.category.toLowerCase().includes(search)
      );
    }

    res.json({
      success: true,
      count: result.length,
      total: marketsCache.length,
      lastUpdated: new Date(lastFetch).toISOString(),
      markets: result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    await refreshCache();
    res.json({ success: true, leaderboard: leaderboardCache });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// On-demand positions for a single trader
app.get('/api/trader/:address/positions', async (req, res) => {
  try {
    const positions = await fetchTraderPositions(req.params.address);
    res.json({ success: true, positions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    cachedMarkets: marketsCache.length,
    lastUpdated: lastFetch ? new Date(lastFetch).toISOString() : null,
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Polymarket Dashboard server running on http://localhost:${PORT}`);
  console.log('📡 Fetching initial market data...');
  await refreshCache();
});
