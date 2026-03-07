/* ─────────────────────────────────────────────────────────────────────────────
   PolyRadar — app.js
   Handles: API fetching, category filtering, search, auto-refresh, leaderboard
───────────────────────────────────────────────────────────────────────────── */

const API_BASE = '';
const REFRESH_INTERVAL = 60; // seconds

let allMarkets = [];
let currentCategory = 'all';
let searchQuery = '';
let secondsLeft = REFRESH_INTERVAL;
let countdownTimer = null;
let refreshTimer = null;

// ─── Format helpers ─────────────────────────────────────────────────────────────
function formatMoney(val) {
    if (!val || isNaN(val)) return '—';
    if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(1) + 'M';
    if (val >= 1_000) return '$' + (val / 1_000).toFixed(0) + 'K';
    return '$' + val.toFixed(0);
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr);
        if (isNaN(d)) return '—';
        const now = new Date();
        const diff = d - now;
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
    if (pct >= 70) return '#f7931a';
    return '#aaa';
}

function catLabel(cat) {
    const labels = { crypto: '₿ Crypto', sports: '⚽ Sports', politics: '🏛️ Politics', finance: '📈 Finance', technology: '💻 Technology', other: '🔮 Other' };
    return labels[cat] || cat;
}

// ─── Render markets ─────────────────────────────────────────────────────────────
function renderMarkets(markets) {
    const grid = document.getElementById('marketsGrid');
    const empty = document.getElementById('emptyState');

    if (!markets || markets.length === 0) {
        grid.style.display = 'none';
        empty.style.display = 'block';
        return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    grid.innerHTML = markets.map(m => {
        const color = probColor(m.probability);
        return `
    <div class="market-card cat-${m.category}" onclick="openMarket('${escHtml(m.url)}')" role="button" tabindex="0" aria-label="Open ${escHtml(m.title)} on Polymarket">
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
        <div class="stat">
          <span class="stat-label">Volume</span>
          <span class="stat-value">${formatMoney(m.volume)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">24h Volume</span>
          <span class="stat-value">${formatMoney(m.volume24h)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Liquidity</span>
          <span class="stat-value">${formatMoney(m.liquidity)}</span>
        </div>
        ${m.totalBets ? `<div class="stat"><span class="stat-label">Traders</span><span class="stat-value">${m.totalBets.toLocaleString()}</span></div>` : ''}
      </div>

      <div class="card-footer">
        <span class="end-date">⏱ ${formatDate(m.endDate)}</span>
        <span class="open-link">Open on Polymarket ↗</span>
      </div>
    </div>`;
    }).join('');
}

function openMarket(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Filter & search ─────────────────────────────────────────────────────────────
function applyFilters() {
    let result = allMarkets;
    if (currentCategory !== 'all') {
        result = result.filter(m => m.category === currentCategory);
    }
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        result = result.filter(m => m.title.toLowerCase().includes(q) || m.category.toLowerCase().includes(q));
    }
    renderMarkets(result);
}

// ─── Fetch markets from backend ─────────────────────────────────────────────────
async function loadMarkets() {
    try {
        const res = await fetch(`${API_BASE}/api/markets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'API error');

        allMarkets = data.markets || [];

        // Update UI counters
        document.getElementById('totalCount').textContent = `${data.count} markets ≥70%`;
        const upd = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '—';
        document.getElementById('lastUpdated').textContent = `Last updated: ${upd}`;

        applyFilters();
    } catch (err) {
        console.error('Failed to load markets:', err);
        document.getElementById('marketsGrid').innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-muted)">
        <p style="font-size:2rem;margin-bottom:12px">⚠️</p>
        <p>Could not fetch markets. Retrying…</p>
        <p style="font-size:0.78rem;margin-top:8px;color:var(--text-dim)">${err.message}</p>
      </div>`;
    }
}

// ─── Fetch leaderboard ─────────────────────────────────────────────────────────
async function loadLeaderboard() {
    try {
        const res = await fetch(`${API_BASE}/api/leaderboard`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const users = data.leaderboard || [];
        renderLeaderboard(users);
    } catch (err) {
        console.error('Leaderboard error:', err);
        document.getElementById('leaderboardBody').innerHTML = `<tr><td colspan="5" class="loading-row">Could not load leaderboard</td></tr>`;
    }
}

function renderLeaderboard(users) {
    const tbody = document.getElementById('leaderboardBody');
    if (!users || users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="loading-row">No leaderboard data available</td></tr>`;
        return;
    }

    const rankMedals = ['🥇', '🥈', '🥉'];
    tbody.innerHTML = users.map(u => {
        const rankClass = u.rank <= 3 ? `rank-${u.rank}` : 'rank-other';
        const rankDisplay = u.rank <= 3 ? rankMedals[u.rank - 1] : `#${u.rank}`;
        const initials = (u.name || 'U').slice(0, 2).toUpperCase();
        const pct = Math.min(100, Math.max(0, u.percentPositive));

        return `
    <tr>
      <td class="rank-cell ${rankClass}">${rankDisplay}</td>
      <td>
        <div class="trader-cell">
          <div class="trader-avatar">${initials}</div>
          <div>
            <div class="trader-name">${escHtml(u.name)}</div>
            ${u.address && u.address !== '0x...' ? `<div class="trader-addr">${u.address.slice(0, 8)}…${u.address.slice(-4)}</div>` : ''}
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
    </tr>`;
    }).join('');
}

// ─── Countdown & auto-refresh ───────────────────────────────────────────────────
function startRefreshCycle() {
    secondsLeft = REFRESH_INTERVAL;
    updateCountdown();

    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        secondsLeft--;
        if (secondsLeft <= 0) {
            secondsLeft = REFRESH_INTERVAL;
            loadMarkets();
        }
        updateCountdown();
    }, 1000);
}

function updateCountdown() {
    const el = document.getElementById('refreshCountdown');
    if (el) el.textContent = `${secondsLeft}s`;
}

// ─── Category tabs ──────────────────────────────────────────────────────────────
document.getElementById('categoryTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.cat;
    applyFilters();
});

// ─── Search ─────────────────────────────────────────────────────────────────────
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
    searchInput.value = '';
    searchQuery = '';
    searchClear.style.display = 'none';
    applyFilters();
    searchInput.focus();
});

// Keyboard: press Escape to clear search
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.activeElement === searchInput) {
        searchInput.value = '';
        searchQuery = '';
        searchClear.style.display = 'none';
        applyFilters();
    }
});

// ─── Init ───────────────────────────────────────────────────────────────────────
(async function init() {
    await Promise.all([loadMarkets(), loadLeaderboard()]);
    startRefreshCycle();
})();
