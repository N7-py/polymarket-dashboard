/* ─────────────────────────────────────────────────────────────────────────────
   PolyRadar — app.js  (SPA: Scanner | Hot Bets | Leaderboard)
───────────────────────────────────────────────────────────────────────────── */

const API_BASE = '';
const REFRESH_INTERVAL = 60;

// ─── State ─────────────────────────────────────────────────────────────────────
let allMarkets = [];
let currentCategory = 'all';
let searchQuery = '';
let currentPage = 'scanner';
let minProb = 70;   // slider min (default matches old ≥70% filter)
let maxProb = 100;  // slider max
let hideEnded = false; // hide markets whose end date has passed

// Leaderboard state
let lbTimePeriod = 'ALL';
let lbCategory = 'OVERALL';
let lbLoading = false;

// Countdown
let secondsLeft = REFRESH_INTERVAL;
let countdownTimer = null;

// ─── Format helpers ────────────────────────────────────────────────────────────
function formatMoney(val) {
  if (!val || isNaN(val)) return '—';
  if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1_000) return '$' + (val / 1_000).toFixed(0) + 'K';
  return '$' + val.toFixed(0);
}

function formatMoneyNumber(val) {
  if (!val || isNaN(val)) return '0';
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1_000) return (val / 1_000).toFixed(0) + 'K';
  return val.toFixed(0);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return '—';
    const diff = d - Date.now();
    if (diff < 0) return 'Ended';
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 7) return `${days}d left`;
    if (days < 30) return `${Math.floor(days / 7)}w left`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return '—'; }
}

function probColor(pct) {
  if (pct >= 90) return '#00d4aa';
  if (pct >= 80) return '#6c63ff';
  return '#f7931a';
}

function catLabel(cat) {
  const map = { crypto: '₿ Crypto', sports: '⚽ Sports', politics: '🏛️ Politics', finance: '📈 Finance', technology: '💻 Technology', other: '🔮 Other' };
  return map[cat] || cat;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortenAddress(addr) {
  if (!addr || addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function openMarket(url) {
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

// ─── SPA navigation ────────────────────────────────────────────────────────────
function navigateTo(page) {
  ['scanner', 'hotbets', 'mypicks', 'leaderboard', 'portfolio', 'trader-profile'].forEach(p => {
    const el = document.getElementById(`page-${p}`);
    if (el) el.style.display = (p === page ? '' : 'none');
    const btn = document.querySelector(`[data-page="${p}"]`);
    if (btn) btn.classList.toggle('active', p === page);
  });
  currentPage = page;
  if (page === 'hotbets') loadHotBets();
  if (page === 'mypicks') loadMyPicks();
  if (page === 'leaderboard') loadLeaderboard();
  if (page === 'portfolio') {
    const container = document.getElementById('portfolioQuickAdd');
    if (container && container.innerHTML.includes('Loading leaderboard')) {
      loadDynamicPortfolioWhales();
    }
  }
}

// ─── TRADER PROFILE NAVIGATION ────────────────────────────────────────────────
window.viewTraderProfile = async function (address, name = null, pnl = null, volume = null, trades = null, winRate = null) {
  if (!address) return;

  // Navigate to custom profile page
  document.querySelectorAll('.page').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('page-trader-profile').style.display = 'block';
  currentPage = 'trader-profile';
  window.scrollTo(0, 0);

  // Set Profile Hero
  const displayName = name || shortenAddress(address);
  document.getElementById('tpName').textContent = displayName;
  document.getElementById('tpAddress').textContent = address;
  document.getElementById('tpAvatar').textContent = displayName.slice(0, 2).toUpperCase();
  document.getElementById('tpProfit').textContent = pnl ? `$${formatMoneyNumber(pnl)}` : 'N/A';

  // Set Advanced Stats
  document.getElementById('tpVolume').textContent = volume ? formatMoney(volume) : '—';
  document.getElementById('tpTrades').textContent = trades ? trades.toLocaleString() : '—';
  document.getElementById('tpWinRate').textContent = (winRate && winRate > 0) ? `${winRate.toFixed(1)}%` : '—';

  // Reset to Overview Tab
  window.switchTraderTab('overview');

  // Set loading state
  const tbody = document.getElementById('tpTableBody');
  tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:60px;color:var(--text-muted)">Loading positions for ${escHtml(displayName)} from Polymarket...</td></tr>`;
  document.getElementById('tpExposure').textContent = 'Loading...';

  try {
    const res = await fetch(`${API_BASE}/api/portfolio?addresses=${address}`);
    const data = await res.json();

    // Update Profit if backend can derive exposure
    if (!pnl && data.totalValue) {
      document.getElementById('tpProfit').textContent = formatMoney(data.totalValue) + ' (Exposure)';
    }

    // Update Overview Tab Exposure
    document.getElementById('tpExposure').textContent = formatMoney(data.totalValue || 0);

    if (!data.positions || data.positions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:60px;color:var(--text-dim)">No active positions open right now.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.positions.map(p => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.2s" class="portfolio-row" onclick="window.open('${escHtml(p.url)}', '_blank')">
        <td style="padding:16px 8px;font-weight:600;color:#fff;cursor:pointer">
          ${escHtml(p.title)}
        </td>
        <td style="padding:16px 8px;text-align:right">
          <span style="background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;font-size:0.85rem">${escHtml(p.outcome)}</span>
          <div style="font-size:0.8rem;color:var(--text-dim);margin-top:6px">${p.totalShares.toFixed(2)} shares @ ~${(p.avgPrice * 100).toFixed(1)}c</div>
        </td>
        <td style="padding:16px 8px;text-align:right;font-family:monospace;font-weight:700;color:var(--accent);font-size:1.1rem">
          ${formatMoney(p.totalValue)}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Trader Profile error:', err);
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:40px;color:#e74c3c">Failed to load trader data.</td></tr>`;
    document.getElementById('tpExposure').textContent = 'Error';
  }
};

window.switchTraderTab = function (tabName) {
  // Hide all tab content blocks
  ['overview', 'positions', 'pnl', 'categories', 'trades', 'funding'].forEach(t => {
    const el = document.getElementById(`tpTab-${t}`);
    if (el) el.style.display = 'none';
  });

  // Remove active styling from tab buttons
  document.querySelectorAll('#tpTabs .tab').forEach(btn => btn.classList.remove('active'));

  // Show selected tab content and style the active button
  const activeEl = document.getElementById(`tpTab-${tabName}`);
  if (activeEl) activeEl.style.display = 'block';

  const activeBtn = document.querySelector(`#tpTabs [data-tptab="${tabName}"]`);
  if (activeBtn) activeBtn.classList.add('active');
};

document.getElementById('mainNav').addEventListener('click', e => {
  const btn = e.target.closest('.nav-btn');
  if (btn) navigateTo(btn.dataset.page);
});

// ─── Probability Slider ────────────────────────────────────────────────────────
function updateSlider() {
  const sliderMin = document.getElementById('probMin');
  const sliderMax = document.getElementById('probMax');
  const fill = document.getElementById('rangeFill');
  const minDisplay = document.getElementById('probMinDisplay');
  const maxDisplay = document.getElementById('probMaxDisplay');
  if (!sliderMin || !sliderMax || !fill) return;

  const rangeMin = parseInt(sliderMin.min);
  const rangeMax = parseInt(sliderMin.max);
  let valMin = parseInt(sliderMin.value);
  let valMax = parseInt(sliderMax.value);

  // Prevent thumbs from crossing (min gap = 1)
  if (valMin > valMax - 1) {
    if (document.activeElement === sliderMin) valMin = valMax - 1;
    else valMax = valMin + 1;
    sliderMin.value = valMin;
    sliderMax.value = valMax;
  }

  // Update gradient fill position
  const pctMin = ((valMin - rangeMin) / (rangeMax - rangeMin)) * 100;
  const pctMax = ((valMax - rangeMin) / (rangeMax - rangeMin)) * 100;
  fill.style.left = pctMin + '%';
  fill.style.right = (100 - pctMax) + '%';

  // Update labels
  if (minDisplay) minDisplay.textContent = valMin;
  if (maxDisplay) maxDisplay.textContent = valMax;

  // Update state and re-filter
  minProb = valMin;
  maxProb = valMax;
  applyFilters();
}

// Init slider on page load after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const sliderMin = document.getElementById('probMin');
  const sliderMax = document.getElementById('probMax');
  if (sliderMin) sliderMin.addEventListener('input', updateSlider);
  if (sliderMax) sliderMax.addEventListener('input', updateSlider);
  updateSlider(); // set initial fill position
});


function renderMarkets(markets) {
  const grid = document.getElementById('marketsGrid');
  const empty = document.getElementById('emptyState');
  if (!markets || markets.length === 0) {
    grid.style.display = 'none'; empty.style.display = 'block'; return;
  }
  grid.style.display = 'grid'; empty.style.display = 'none';
  grid.innerHTML = markets.map(m => {
    const color = probColor(m.probability);
    return `
    <div class="market-card cat-${m.category}" onclick="openMarket('${escHtml(m.url)}')" role="button" tabindex="0">
      <div class="card-top">
        <div class="card-title">${escHtml(m.title)}</div>
        <span class="category-badge cat-${m.category}">${catLabel(m.category)}</span>
      </div>
      <div class="prob-row">
        <div>
          <div class="prob-label">Probability</div>
          <div class="prob-value" style="color:${color}">${m.probability}%</div>
        </div>
        <div class="prob-outcome" title="${escHtml(m.winningOutcome)}">
          <span style="font-size:0.65rem;display:block;color:var(--text-dim);margin-bottom:2px;">Top outcome</span>
          ${escHtml(m.winningOutcome)}
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${m.probability}%;background:${color}"></div>
      </div>
      <div class="card-stats">
        <div class="stat"><span class="stat-label">Volume</span><span class="stat-value">${formatMoney(m.volume)}</span></div>
        <div class="stat"><span class="stat-label">24h Vol</span><span class="stat-value">${formatMoney(m.volume24h)}</span></div>
        <div class="stat"><span class="stat-label">Liquidity</span><span class="stat-value">${formatMoney(m.liquidity)}</span></div>
        ${m.totalBets ? `<div class="stat"><span class="stat-label">Traders</span><span class="stat-value">${m.totalBets.toLocaleString()}</span></div>` : ''}
      </div>
      <div class="card-footer">
        <span class="end-date">⏱ ${formatDate(m.endDate)}</span>
        <span class="open-link">Open on Polymarket ↗</span>
      </div>
    </div>`;
  }).join('');
}

function applyFilters() {
  let result = allMarkets;
  if (currentCategory !== 'all') result = result.filter(m => m.category === currentCategory);
  if (searchQuery) { const q = searchQuery.toLowerCase(); result = result.filter(m => m.title.toLowerCase().includes(q) || m.category.includes(q)); }
  // Probability range filter
  result = result.filter(m => m.probability >= minProb && m.probability <= maxProb);
  // Hide ended markets
  if (hideEnded) result = result.filter(m => !m.endDate || new Date(m.endDate) > Date.now());
  renderMarkets(result);
  // Update stats pill with range info
  const totalPill = document.getElementById('totalCount');
  if (totalPill) totalPill.textContent = `${result.length} markets ${minProb}–${maxProb}%`;
}

async function loadMarkets() {
  try {
    const res = await fetch(`${API_BASE}/api/markets`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'API error');
    allMarkets = data.markets || [];
    updateSlider();   // apply initial prob range + update fill
    document.getElementById('totalCount').textContent = `${data.count} markets ≥70%`;
    const upd = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '—';
    document.getElementById('lastUpdated').textContent = `Last updated: ${upd}`;
    applyFilters();
  } catch (err) {
    console.error('Markets error:', err);
    document.getElementById('marketsGrid').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted)">
        <p style="font-size:2rem;margin-bottom:12px">⚠️</p><p>Could not fetch markets. Retrying…</p>
      </div>`;
  }
}

// Category tabs
document.getElementById('categoryTabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentCategory = tab.dataset.cat;
  applyFilters();
});

// Search
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
let searchDebounce = null;
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  searchClear.style.display = searchQuery ? 'block' : 'none';
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(applyFilters, 200);
});
searchClear.addEventListener('click', () => {
  searchInput.value = ''; searchQuery = '';
  searchClear.style.display = 'none';
  applyFilters(); searchInput.focus();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = ''; searchQuery = '';
    searchClear.style.display = 'none'; applyFilters();
  }
});

// Hide Ended toggle
const hideEndedChk = document.getElementById('hideEndedChk');
if (hideEndedChk) {
  hideEndedChk.addEventListener('change', () => {
    hideEnded = hideEndedChk.checked;
    applyFilters();
  });
}

// ─── HOT BETS ─────────────────────────────────────────────────────────────────
async function loadHotBets() {
  try {
    const res = await fetch(`${API_BASE}/api/hotbets?limit=20`);
    const data = await res.json();
    const upd = data.lastPoll ? new Date(data.lastPoll).toLocaleTimeString() : '—';
    document.getElementById('hotLastUpdated').textContent = `Last poll: ${upd}`;
    renderHotBets(data.hotBets || []);
  } catch (err) {
    console.error('Hot bets error:', err);
    document.getElementById('hotBetsGrid').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted)"><p>⚠️ Could not load hot bets.</p></div>`;
  }
}

function renderHotBets(bets) {
  const grid = document.getElementById('hotBetsGrid');
  const empty = document.getElementById('hotEmptyState');
  if (!bets || bets.length === 0) {
    grid.style.display = 'none'; empty.style.display = 'block'; return;
  }
  grid.style.display = 'grid'; empty.style.display = 'none';
  const maxCount = bets[0]?.count || 1;
  grid.innerHTML = bets.map(b => {
    const pct = Math.round((b.count / maxCount) * 100);
    return `
    <div class="hot-card cat-${b.category}" onclick="openMarket('${escHtml(b.url)}')" role="button" tabindex="0">
      <div class="hot-rank">#${b.rank}</div>
      <div class="card-top">
        <div class="card-title">${escHtml(b.title)}</div>
        <span class="category-badge cat-${b.category}">${catLabel(b.category)}</span>
      </div>
      <div class="hot-stats-row">
        <div class="hot-bet-count">
          <span class="fire-icon">🔥</span>
          <span class="hot-count-num">${b.count}</span>
          <span class="hot-count-label">bets (5 min)</span>
        </div>
        ${b.volume > 0 ? `<div class="hot-volume">${formatMoney(b.volume)} wagered</div>` : ''}
      </div>
      <div class="progress-wrap">
        <div class="progress-bar" style="width:${pct}%;background:linear-gradient(90deg,#ff6b6b,#f7931a)"></div>
      </div>
      <div class="card-footer">
        <span class="end-date">📅 Activity tracked live</span>
        <span class="open-link">View on Polymarket ↗</span>
      </div>
    </div>`;
  }).join('');
}

// ─── SMART MONEY PICKS ────────────────────────────────────────────────────────
let smartPicksLoaded = false;
let smartPicksLoading = false;
window.smartPicksData = null;

function toggleSmartPicks(event) {
  if (event && event.target.closest('.smart-filter')) return;
  const body = document.getElementById('smartBody');
  const btn = document.getElementById('smartExpandBtn');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? 'block' : 'none';
  btn.textContent = isHidden ? 'Hide Picks ▲' : 'Load Picks ▼';
  if (isHidden && !smartPicksLoaded) {
    loadSmartPicks();
  }
}

async function loadSmartPicks() {
  if (smartPicksLoading) return;
  smartPicksLoading = true;
  document.getElementById('smartPicksGrid').innerHTML = `<div class="skeleton-card" style="height:140px"></div>`.repeat(2);

  const streakSlider = document.getElementById('smartMinStreak');
  const topN = streakSlider ? parseInt(streakSlider.value) : 10;

  try {
    const res = await fetch(`${API_BASE}/api/smartpicks?minStreak=${topN}`);
    const data = await res.json();
    smartPicksLoaded = true;
    window.smartPicksData = data;
    renderSmartPicks(data);
  } catch (err) {
    console.error('Smart picks error:', err);
    document.getElementById('smartPicksGrid').innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:20px">⚠️ Failed to load Leaderboard Picks.</div>`;
  } finally {
    smartPicksLoading = false;
  }
}

function renderSmartPicks(data) {
  const strip = document.getElementById('smartStatStrip');
  const grid = document.getElementById('smartPicksGrid');
  const streakSlider = document.getElementById('smartMinStreak');
  const topN = streakSlider ? parseInt(streakSlider.value) : 10;

  const traders = data.topTraders || [];
  let picks = data.picks || [];

  if (traders.length === 0) {
    strip.innerHTML = `No top traders found right now.`;
    grid.innerHTML = '';
    return;
  }

  strip.innerHTML = `Analyzing the top <b>${traders.length}</b> most profitable traders globally this week. Found <b>${picks.length}</b> shared convictions with 2+ backers.`;

  if (picks.length === 0) {
    grid.innerHTML = `<div style="text-align:center;color:var(--text-dim);grid-column:1/-1;padding:20px">No shared markets found. Try expanding the slider to analyze more top traders.</div>`;
    return;
  }

  grid.innerHTML = picks.map(p => {
    return `
    <div class="smart-card" onclick="openMarket('${escHtml(p.url)}')" role="button" tabindex="0">
      <div class="smart-card-top">
        <span class="smart-rank">#${p.rank}</span>
        <div class="smart-title">${escHtml(p.title)}</div>
      </div>
      <div class="smart-card-mid">
        <div class="smart-outcome">
          <span style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.05em">Smart Money Bet</span>
          <span style="font-size:1.1rem;font-weight:900;color:var(--accent)">${escHtml(p.outcome)}</span>
        </div>
        <div class="smart-endorsers">
          <span class="smart-endorser-count">👥 ${p.endorserCount} top traders</span>
          <div class="smart-avatars">
            ${p.endorsers.map(e => `<span class="smart-ava tooltip" data-tip="${escHtml(e.name)}: $${formatMoneyNumber(e.pnl)} PNL">${(e.name || 'U').slice(0, 2).toUpperCase()}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="smart-card-bot">
        <span>💰 Total exposure: ${formatMoney(p.totalExposure)}</span>
        <span>Avg Prob: ${p.avgProbability ? p.avgProbability + '%' : '—'}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── MY FAVORITE BETS ─────────────────────────────────────────────────────────

let picksLoading = false;
async function loadMyPicks() {
  if (picksLoading) return;
  picksLoading = true;
  document.getElementById('picksGrid').innerHTML = `<div class="skeleton-card" style="height:260px"></div>`.repeat(4);
  try {
    const res = await fetch(`${API_BASE}/api/favoritebets`);
    const data = await res.json();
    renderMyPicks(data.favorites || []);
  } catch (err) {
    console.error('My picks error:', err);
    document.getElementById('picksGrid').innerHTML =
      `<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted)"><p>⚠️ Could not load picks.</p></div>`;
  } finally { picksLoading = false; }
}

function renderMyPicks(picks) {
  const grid = document.getElementById('picksGrid');
  const empty = document.getElementById('picksEmpty');
  if (!picks || picks.length === 0) {
    grid.style.display = 'none'; empty.style.display = 'block'; return;
  }
  grid.style.display = 'grid'; empty.style.display = 'none';
  grid.innerHTML = picks.map(p => {
    const scoreW = Math.round(p.safetyScore);

    // Determine BET direction label & styling
    const outcome = (p.winningOutcome || 'Yes').trim();
    const isYes = outcome.toLowerCase() === 'yes';
    const isNo = outcome.toLowerCase() === 'no';
    const betLabel = isYes ? 'BET YES' : isNo ? 'BET NO' : `BET: ${outcome}`;
    const betIcon = isYes ? '✅' : isNo ? '❌' : '🎯';
    const betBg = isYes ? 'rgba(0,212,170,0.12)' : isNo ? 'rgba(231,76,60,0.12)' : 'rgba(108,99,255,0.12)';
    const betBorder = isYes ? 'rgba(0,212,170,0.4)' : isNo ? 'rgba(231,76,60,0.4)' : 'rgba(108,99,255,0.4)';
    const betColor = isYes ? '#00d4aa' : isNo ? '#e74c3c' : '#6c63ff';

    return `
    <div class="pick-card" onclick="openMarket('${escHtml(p.url)}')" role="button" tabindex="0">
      <div class="pick-header">
        <div class="pick-rank">#${p.favoriteRank}</div>
        <span class="pick-tier-badge" style="border-color:${escHtml(p.tierColor)};color:${escHtml(p.tierColor)}">
          ${p.tierIcon} ${escHtml(p.tier)}
        </span>
        <div class="pick-score-pill" style="background:${escHtml(p.tierColor)}22;color:${escHtml(p.tierColor)};border-color:${escHtml(p.tierColor)}44">
          ${p.safetyScore}<span style="font-size:0.6rem;opacity:0.7">/100</span>
        </div>
      </div>

      <div class="pick-title">${escHtml(p.title)}</div>

      <!-- BET DIRECTION — most prominent element -->
      <div class="bet-direction" style="background:${betBg};border-color:${betBorder}">
        <span class="bet-icon">${betIcon}</span>
        <span class="bet-label" style="color:${betColor}">${escHtml(betLabel)}</span>
        <span class="bet-prob" style="color:${betColor}">${p.probability}% probability</span>
      </div>

      <div class="pick-prob-row">
        <div class="pick-prob-bar-wrap" style="flex:1">
          <div class="pick-prob-bar" style="width:${p.probability}%;background:${betColor}"></div>
        </div>
      </div>

      <div class="pick-score-row">
        <span class="pick-score-label">Safety Score</span>
        <div class="pick-score-track">
          <div class="pick-score-fill" style="width:${scoreW}%;background:linear-gradient(90deg,${escHtml(p.tierColor)},#6c63ff)"></div>
        </div>
        <span class="pick-score-val">${p.safetyScore}</span>
      </div>

      <div class="pick-reasoning">${escHtml(p.reasoning)}</div>

      <div class="pick-chips">
        <span class="pick-chip">💧 ${formatMoney(p.liquidity)}</span>
        <span class="pick-chip">📈 ${formatMoney(p.volume24h || p.volume)} vol</span>
        ${(p.totalBets || 0) > 0 ? `<span class="pick-chip">👥 ${p.totalBets.toLocaleString()}</span>` : ''}
        <span class="pick-chip cat-${p.category}">${catLabel(p.category)}</span>
      </div>
      <div class="pick-footer">
        <span class="end-date">⏱ ${formatDate(p.endDate)}</span>
        <span class="open-link">Bet on Polymarket ↗</span>
      </div>
    </div>`;
  }).join('');
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  if (lbLoading) return;
  lbLoading = true;
  document.getElementById('leaderboardBody').innerHTML = `<tr><td colspan="6" class="loading-row"><span class="lb-loading-text">Loading…</span></td></tr>`;
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard?timePeriod=${lbTimePeriod}&category=${lbCategory}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderLeaderboard(data.leaderboard || []);
  } catch (err) {
    console.error('Leaderboard error:', err);
    document.getElementById('leaderboardBody').innerHTML = `<tr><td colspan="6" class="loading-row">Could not load leaderboard</td></tr>`;
  } finally { lbLoading = false; }
}

function renderLeaderboard(users) {
  const tbody = document.getElementById('leaderboardBody');
  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">No data for this filter.</td></tr>`; return;
  }
  const rankMedals = ['🥇', '🥈', '🥉'];
  let html = '';
  users.forEach(u => {
    const rankClass = u.rank <= 3 ? `rank-${u.rank}` : 'rank-other';
    const rankDisplay = u.rank <= 3 ? rankMedals[u.rank - 1] : `#${u.rank}`;
    const initials = (u.name || 'U').slice(0, 2).toUpperCase();
    const pct = Math.min(100, Math.max(0, u.percentPositive || 0));
    const hasProfile = !!u.profileUrl;
    const hasPositions = u.positions && u.positions.length > 0;
    const panelId = `pred-panel-${u.rank}`;

    html += `
    <tr class="trader-main-row ${u.address ? 'clickable-row' : ''}"
        onclick="traderRowClick(event, '${escHtml(u.address || '')}', '${escHtml(u.name || '')}', ${u.profit || 0}, ${u.volume || 0}, ${u.tradesCount || 0}, ${pct || 0})"
        title="${u.address ? 'Click to view Trader Profile' : ''}">
      <td class="rank-cell ${rankClass}">${rankDisplay}</td>
      <td>
        <div class="trader-cell">
          <div class="trader-avatar">${initials}</div>
          <div>
            <div class="trader-name ${u.address ? 'trader-link' : ''}">${escHtml(u.name)}</div>
            ${u.address ? `<div class="trader-addr">${u.address.slice(0, 8)}…${u.address.slice(-4)}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="profit-value">+${formatMoney(u.profit)}</td>
      <td>
        <div class="win-rate-bar-wrap">
          <div class="win-rate-bar"><div class="win-rate-fill" style="width:${pct}%"></div></div>
          <span class="win-rate-pct">${pct > 0 ? pct.toFixed(1) + '%' : '—'}</span>
        </div>
      </td>
      <td>${u.tradesCount > 0 ? u.tradesCount.toLocaleString() : '—'}</td>
      <td class="expand-cell">
        ${hasPositions
        ? `<button class="expand-btn" onclick="togglePredictions(event,'${panelId}')" title="View upcoming predictions">
               <span class="expand-icon" id="icon-${panelId}">▶</span> View
             </button>`
        : `<span class="no-pos-badge">No open</span>`}
      </td>
    </tr>`;

    if (hasPositions) {
      html += `
      <tr class="pred-panel-row" id="${panelId}" style="display:none">
        <td colspan="6" class="pred-panel-cell">
          <div class="pred-panel">
            <div class="pred-panel-title">📌 Upcoming Predictions — ${escHtml(u.name)}</div>
            <div class="pred-list">
              ${u.positions.map(p => `
              <div class="pred-item ${p.pnl >= 0 ? 'pred-pos' : 'pred-neg'}"
                   onclick="${p.marketUrl ? `openMarket('${escHtml(p.marketUrl)}')` : ''}"
                   ${p.marketUrl ? 'style="cursor:pointer"' : ''}>
                <div class="pred-market-title">${escHtml(p.market)}</div>
                <div class="pred-meta">
                  <span class="pred-outcome-badge">${escHtml(p.outcome)}</span>
                  ${p.size ? `<span class="pred-size">$${p.size.toFixed(2)} position</span>` : ''}
                  ${p.curPrice ? `<span class="pred-price">@ ${(p.curPrice * 100).toFixed(1)}%</span>` : ''}
                  ${p.pnl !== 0 ? `<span class="pred-pnl ${p.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${p.pnl >= 0 ? '+' : ''}$${Math.abs(p.pnl).toFixed(2)} P&amp;L</span>` : ''}
                </div>
              </div>`).join('')}
            </div>
          </div>
        </td>
      </tr>`;
    }
  });
  tbody.innerHTML = html;
}

function traderRowClick(event, address, name, profit, volume, trades, winRate) {
  if (event.target.closest('.expand-btn')) return;
  if (address) {
    window.viewTraderProfile(address, name, profit, volume, trades, winRate);
  }
}

function togglePredictions(event, panelId) {
  event.stopPropagation();
  const panel = document.getElementById(panelId);
  const icon = document.getElementById('icon-' + panelId);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'table-row';
  if (icon) icon.textContent = isOpen ? '▶' : '▼';
}

// Leaderboard filter pills
document.getElementById('lbTimePills').addEventListener('click', e => {
  const pill = e.target.closest('.lb-pill');
  if (!pill) return;
  document.querySelectorAll('#lbTimePills .lb-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  lbTimePeriod = pill.dataset.tp;
  loadLeaderboard();
});

document.getElementById('lbCatPills').addEventListener('click', e => {
  const pill = e.target.closest('.lb-pill');
  if (!pill) return;
  document.querySelectorAll('#lbCatPills .lb-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  lbCategory = pill.dataset.cat;
  loadLeaderboard();
});

// ─── PORTFOLIO TRACKER ────────────────────────────────────────────────────────
window.portfolioAddresses = [];
let portfolioLoading = false;

window.addPortfolioAddress = function (address, defaultName = null) {
  if (!address || address.trim() === '') return;
  const addrStr = address.trim();

  if (window.portfolioAddresses.some(a => a.address.toLowerCase() === addrStr.toLowerCase())) {
    document.getElementById('portfolioInput').value = '';
    return; // Already added
  }

  window.portfolioAddresses.push({
    address: addrStr,
    name: defaultName || shortenAddress(addrStr)
  });

  document.getElementById('portfolioInput').value = '';
  renderPortfolioTags();
  loadPortfolioData();
};

window.removePortfolioAddress = function (address) {
  window.portfolioAddresses = window.portfolioAddresses.filter(a => a.address.toLowerCase() !== address.toLowerCase());
  renderPortfolioTags();
  loadPortfolioData();
};

function renderPortfolioTags() {
  const container = document.getElementById('portfolioTags');
  if (!container) return;

  if (window.portfolioAddresses.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = window.portfolioAddresses.map(a => `
    <div style="display:inline-flex;align-items:center;background:rgba(0,82,255,0.15);border:1px solid rgba(0,82,255,0.3);color:#fff;padding:6px 12px;border-radius:20px;font-size:0.85rem;font-weight:600">
      <span style="margin-right:8px;color:#0052FF">●</span>
      ${escHtml(a.name)}
      <button onclick="window.removePortfolioAddress('${a.address}')" style="background:none;border:none;color:var(--text-muted);margin-left:8px;cursor:pointer;padding:0;font-size:1rem;line-height:1">&times;</button>
    </div>
  `).join('');
}

window.switchPortfolioTab = function (tabName) {
  document.querySelectorAll('#portfolioTabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`#portfolioTabs .tab[data-tab="${tabName}"]`).classList.add('active');

  document.getElementById('portfolioOverview').style.display = tabName === 'overview' ? 'block' : 'none';
  document.getElementById('portfolioPositions').style.display = tabName === 'positions' ? 'block' : 'none';
};

async function loadPortfolioData() {
  const content = document.getElementById('portfolioContent');
  const empty = document.getElementById('portfolioEmptyState');
  const overview = document.getElementById('portfolioOverview');
  const posTab = document.getElementById('portfolioPositions');

  if (window.portfolioAddresses.length === 0) {
    empty.style.display = 'block';
    overview.style.display = 'none';
    posTab.style.display = 'none';
    document.getElementById('portfolioTotalValue').textContent = '$0.00';
    document.getElementById('portfolioTableBody').innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  const activeTab = document.querySelector('#portfolioTabs .tab.active').dataset.tab;
  window.switchPortfolioTab(activeTab); // Ensure correct display state

  document.getElementById('portfolioTableBody').innerHTML = `<tr><td colspan="3" style="text-align:center;padding:40px;color:var(--text-muted)">Loading positions from ${window.portfolioAddresses.length} wallet(s)...</td></tr>`;

  try {
    const addrString = window.portfolioAddresses.map(a => a.address).join(',');
    const res = await fetch(`${API_BASE}/api/portfolio?addresses=${addrString}`);
    const data = await res.json();

    // Update Overview
    document.getElementById('portfolioTotalValue').textContent = formatMoney(data.totalValue || 0);

    // Update Table
    const tbody = document.getElementById('portfolioTableBody');
    if (!data.positions || data.positions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:40px;color:var(--text-muted)">No active positions found across these wallets.</td></tr>`;
    } else {
      tbody.innerHTML = data.positions.map(p => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.2s" class="portfolio-row" onclick="window.open('${escHtml(p.url)}', '_blank')">
          <td style="padding:16px 8px;font-weight:600;color:#fff;cursor:pointer">
            ${escHtml(p.title)}
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;font-weight:400">
              Held by: ${p.wallets.map(w => {
        const found = window.portfolioAddresses.find(pa => pa.address.toLowerCase() === w.toLowerCase());
        return found ? found.name : shortenAddress(w);
      }).join(', ')}
            </div>
          </td>
          <td style="padding:16px 8px;text-align:right">
            <span style="background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;font-size:0.85rem">${escHtml(p.outcome)}</span>
            <div style="font-size:0.8rem;color:var(--text-dim);margin-top:6px">${p.totalShares.toFixed(2)} shares @ ~${(p.avgPrice * 100).toFixed(1)}c</div>
          </td>
          <td style="padding:16px 8px;text-align:right;font-family:monospace;font-weight:700;color:var(--accent);font-size:1.1rem">
            ${formatMoney(p.totalValue)}
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Portfolio error:', err);
    document.getElementById('portfolioTableBody').innerHTML = `<tr><td colspan="3" style="text-align:center;padding:40px;color:#e74c3c">Error loading portfolio data.</td></tr>`;
  }
}

// Dynamically load top 10 traders for Quick Add
async function loadDynamicPortfolioWhales() {
  const container = document.getElementById('portfolioQuickAdd');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard?period=WEEK&category=OVERALL`);
    const data = await res.json();
    const traders = data.leaderboard || [];
    const top10 = traders.filter(t => t.address).slice(0, 10);

    if (top10.length === 0) {
      container.innerHTML = `<span style="color:var(--text-muted)">No recent traders found</span>`;
      return;
    }

    container.innerHTML = top10.map(t => {
      const name = t.name || t.pseudonym || shortenAddress(t.address);
      const addr = t.address;
      return `<button class="portfolio-quick-btn tooltip" data-tip="Add ${escHtml(name)} ($${formatMoneyNumber(t.pnl)} PNL)" onclick="window.addPortfolioAddress('${addr}', '${escHtml(name)}')">${escHtml(name)}</button>`;
    }).join('');
  } catch (err) {
    console.error('Whales error:', err);
    container.innerHTML = `<span style="color:var(--text-muted)">Leaderboard unavailable</span>`;
  }
}

// Make sure quick buttons are styled correctly
const styleEl = document.createElement('style');
styleEl.textContent = `
  .portfolio-quick-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-main); padding: 4px 12px; border-radius: 12px; cursor: pointer; font-size: 0.8rem; transition: all 0.2s; white-space: nowrap; }
  .portfolio-quick-btn:hover { background: rgba(0,82,255,0.2); border-color: #0052FF; }
  .portfolio-row:hover { background: rgba(255,255,255,0.02); }
`;
document.head.appendChild(styleEl);


// ─── Countdown & auto-refresh ──────────────────────────────────────────────────
function startRefreshCycle() {
  secondsLeft = REFRESH_INTERVAL;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      secondsLeft = REFRESH_INTERVAL;
      loadMarkets();
      if (currentPage === 'hotbets') loadHotBets();
      if (currentPage === 'portfolio') loadPortfolioData();
    }
    const el = document.getElementById('refreshCountdown');
    if (el) el.textContent = `${secondsLeft}s`;
  }, 1000);
}

// ─── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  await loadMarkets();
  startRefreshCycle();
})();
