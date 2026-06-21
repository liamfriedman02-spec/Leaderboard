require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const INTERVAL_MS = 15 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Load/Save data ─────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { token: null, affiliateCode: null, affiliateName: null, players: [], totalTurnover: 0, lastSync: null, prizes: DEFAULT_PRIZES, competition: DEFAULT_COMPETITION };
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

const DEFAULT_PRIZES = [
  { rank:1, prize:'$2,500' }, { rank:2, prize:'$1,500' }, { rank:3, prize:'$1,000' },
  { rank:4, prize:'$700' },   { rank:5, prize:'$500' },   { rank:6, prize:'$325' },
  { rank:7, prize:'$250' },   { rank:8, prize:'$200' },   { rank:9, prize:'$150' },
  { rank:10, prize:'$125' },  { rank:11, prize:'$75' },   { rank:12, prize:'$75' },
  { rank:13, prize:'$50' },   { rank:14, prize:'$25' },   { rank:15, prize:'$25' },
];

const DEFAULT_COMPETITION = {
  name: 'Bi-Weekly Wager Race',
  totalPrize: '$10,000',
  startDate: new Date().toISOString().split('T')[0],
  endDate: new Date(Date.now() + 14*86400000).toISOString().split('T')[0],
};

let state = loadData();
let syncTimer = null;

// ── Playblock API helper ────────────────────────────────────────────
function playblockPost(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.playblock.io',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Length': '0',
        'Accept': 'application/json',
        'Origin': 'https://sharker.com',
        'Referer': 'https://sharker.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: null, raw: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Scrape affiliate data ───────────────────────────────────────────
async function scrapeAffiliate(token) {
  const today = new Date().toISOString().split('T')[0];
  const startDate = state.competition?.startDate || new Date(Date.now()-14*86400000).toISOString().split('T')[0];

  console.log(`[Scraper] Fetching data from ${startDate} to ${today}...`);

  try {
    const result = await playblockPost(
      `/v2/sap/dashboard/stats/summary?from=${startDate}&to=${today}`,
      token
    );

    if (result.status !== 200 || !result.data?._data) {
      console.log('[Scraper] Summary API failed:', result.status, result.raw?.substring(0,100));
      return { success: false, error: `API returned ${result.status}` };
    }

    const campaigns = result.data._data.campaigns || [];
    console.log(`[Scraper] Got ${campaigns.length} campaigns`);

    // Aggregate all campaigns
    let totalTurnover = 0;
    let totalPlayers = 0;
    let affiliateCode = null;
    let affiliateName = null;

    campaigns.forEach(c => {
      totalTurnover += c.turnover || 0;
      totalPlayers += c.players || 0;
      if (!affiliateCode) {
        affiliateCode = c.code;
        affiliateName = c.title;
      }
    });

    console.log(`[Scraper] Total turnover: G${totalTurnover} | Players: ${totalPlayers}`);

    // Try to get per-player data from network endpoint
    const networkResult = await playblockPost(
      `/v2/sap/dashboard/stats/network?from=${startDate}&to=${today}`,
      token
    ).catch(() => null);

    let players = [];

    if (networkResult?.status === 200 && networkResult.data?._data) {
      const networkData = networkResult.data._data;
      players = (networkData.players || networkData.list || networkData.network || []).map((p, i) => ({
        rank: i + 1,
        username: maskWallet(p.wallet || p.address || p.username || `Player${i+1}`),
        wallet: p.wallet || p.address || '',
        totalWager: p.turnover || p.volume || p.wager || 0,
        prize: getPrize(i + 1, state.prizes),
      })).sort((a, b) => b.totalWager - a.totalWager).map((p, i) => ({ ...p, rank: i+1, prize: getPrize(i+1, state.prizes) }));
    }

    // If no per-player data, show aggregate as single entry
    if (players.length === 0 && totalTurnover > 0) {
      players = [{
        rank: 1,
        username: affiliateName || 'Your Players',
        wallet: '',
        totalWager: totalTurnover,
        prize: getPrize(1, state.prizes),
        isAggregate: true,
      }];
    }

    return {
      success: true,
      affiliateCode,
      affiliateName,
      totalTurnover,
      totalPlayers,
      players,
      scrapedAt: new Date().toISOString(),
    };

  } catch(err) {
    console.error('[Scraper] Error:', err.message);
    return { success: false, error: err.message };
  }
}

function maskWallet(w) {
  if (!w) return 'Player****';
  const c = w.replace(/\s/g, '');
  if (c.startsWith('0x') && c.length > 10) return c.slice(0,6) + '****' + c.slice(-4);
  if (c.length > 8) return c.slice(0,4) + '****' + c.slice(-4);
  return c.slice(0,3) + '****';
}

function getPrize(rank, prizes) {
  const p = (prizes || DEFAULT_PRIZES).find(p => p.rank === rank);
  return p ? p.prize : '—';
}

// ── Auto-sync loop ──────────────────────────────────────────────────
async function runSync() {
  if (!state.token) return;
  console.log('[Server] Running sync...');
  const result = await scrapeAffiliate(state.token);
  if (result.success) {
    state.players = result.players;
    state.totalTurnover = result.totalTurnover;
    state.affiliateCode = result.affiliateCode;
    state.affiliateName = result.affiliateName;
    state.lastSync = result.scrapedAt;
    saveData(state);
    console.log(`[Server] ✓ Synced ${result.players.length} players`);
  } else {
    console.error('[Server] Sync failed:', result.error);
    if (result.error?.includes('401') || result.error?.includes('403')) {
      console.log('[Server] Token expired — needs refresh');
      state.tokenExpired = true;
      saveData(state);
    }
  }
}

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  runSync();
  syncTimer = setInterval(runSync, INTERVAL_MS);
}

// ── Routes ──────────────────────────────────────────────────────────

// Public leaderboard data
app.get('/api/leaderboard', (req, res) => {
  res.json({
    success: !!state.token,
    configured: !!state.token,
    tokenExpired: state.tokenExpired || false,
    players: state.players || [],
    totalTurnover: state.totalTurnover || 0,
    affiliateCode: state.affiliateCode,
    affiliateName: state.affiliateName,
    competition: state.competition || DEFAULT_COMPETITION,
    prizes: state.prizes || DEFAULT_PRIZES,
    lastSync: state.lastSync,
    nextSync: state.lastSync ? new Date(new Date(state.lastSync).getTime() + INTERVAL_MS).toISOString() : null,
  });
});

// Setup — affiliate pastes their token
app.post('/api/setup', async (req, res) => {
  const { token, adminPassword } = req.body;

  if (!token) return res.status(400).json({ error: 'Token required' });
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }

  // Validate token
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  const test = await playblockPost(`/v2/sap/dashboard/stats/summary?from=${weekAgo}&to=${today}`, token);

  if (test.status !== 200) {
    return res.status(400).json({ error: 'Invalid or expired token. Please get a fresh token from your Sharker dashboard.' });
  }

  const campaigns = test.data?._data?.campaigns || [];
  if (!campaigns.length) {
    return res.status(400).json({ error: 'No affiliate campaigns found for this token.' });
  }

  state.token = token;
  state.tokenExpired = false;
  state.affiliateCode = campaigns[0].code;
  state.affiliateName = campaigns[0].title;
  saveData(state);

  startSyncLoop();
  res.json({ success: true, affiliateName: campaigns[0].title, campaigns: campaigns.length });
});

// Refresh token
app.post('/api/refresh-token', async (req, res) => {
  const { token, adminPassword } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.token = token;
  state.tokenExpired = false;
  saveData(state);
  startSyncLoop();
  res.json({ success: true });
});

// Manual sync trigger
app.post('/api/sync', async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  res.json({ success: true, message: 'Sync triggered' });
  runSync();
});

// Update competition settings
app.post('/api/competition', (req, res) => {
  const { adminPassword, competition } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.competition = { ...DEFAULT_COMPETITION, ...competition };
  saveData(state);
  res.json({ success: true });
});

// Update prizes
app.post('/api/prizes', (req, res) => {
  const { adminPassword, prizes } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.prizes = prizes;
  state.players = state.players.map((p, i) => ({ ...p, prize: getPrize(i+1, prizes) }));
  saveData(state);
  res.json({ success: true });
});

// Admin status
app.get('/api/admin/status', (req, res) => {
  const pw = req.query.password;
  if (pw !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    configured: !!state.token,
    tokenExpired: state.tokenExpired,
    affiliateCode: state.affiliateCode,
    affiliateName: state.affiliateName,
    playerCount: state.players?.length || 0,
    totalTurnover: state.totalTurnover,
    lastSync: state.lastSync,
    competition: state.competition,
    prizes: state.prizes,
  });
});

// ── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🦈 Sharker Leaderboard → http://localhost:${PORT}`);
  console.log(`⚙  Admin panel → http://localhost:${PORT}/admin.html`);
  console.log(`🔧 Setup → http://localhost:${PORT}/setup.html\n`);
  if (state.token) {
    console.log('[Server] Token found — starting sync...');
    startSyncLoop();
  } else {
    console.log('[Server] No token set — visit /setup.html to configure');
  }
});
