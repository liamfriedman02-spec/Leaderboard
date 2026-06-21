require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const INTERVAL_MS = 15 * 60 * 1000;
const DATABASE_URL = process.env.DATABASE_URL;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { token: null, authStore: null, web3Auth: 'auth', players: [], totalVolume: 0, lastSync: null, prizes: DEFAULT_PRIZES, competition: DEFAULT_COMPETITION };
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
let isSyncing = false;

// ── DB helper ───────────────────────────────────────────────────────
async function getFromDB(affiliateId) {
  if (!DATABASE_URL) return null;
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const players = await client.query(
      'SELECT * FROM leaderboard WHERE affiliate_id=$1 ORDER BY rank ASC',
      [affiliateId || 'default']
    );
    const comp = await client.query(
      'SELECT * FROM competition WHERE affiliate_id=$1',
      [affiliateId || 'default']
    );
    return { players: players.rows, competition: comp.rows[0] };
  } catch(e) {
    console.error('[DB] Read error:', e.message);
    return null;
  } finally {
    await client.end();
  }
}

async function pushToDB(players, state) {
  if (!DATABASE_URL) return;
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS leaderboard (
      id SERIAL PRIMARY KEY, affiliate_id TEXT NOT NULL, rank INTEGER,
      username TEXT, wallet TEXT, total_wager FLOAT, prize TEXT, updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS competition (
      affiliate_id TEXT PRIMARY KEY, name TEXT, total_prize TEXT,
      start_date TEXT, end_date TEXT, last_sync TIMESTAMP, prizes JSONB
    )`);
    const affiliateId = state.affiliateCode || 'default';
    await client.query('DELETE FROM leaderboard WHERE affiliate_id=$1', [affiliateId]);
    for (const p of players) {
      await client.query(
        'INSERT INTO leaderboard (affiliate_id, rank, username, wallet, total_wager, prize) VALUES ($1,$2,$3,$4,$5,$6)',
        [affiliateId, p.rank, p.username, p.wallet, p.totalWager, p.prize]
      );
    }
    const comp = state.competition || {};
    await client.query(`
      INSERT INTO competition (affiliate_id, name, total_prize, start_date, end_date, last_sync, prizes)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6)
      ON CONFLICT (affiliate_id) DO UPDATE SET name=$2, total_prize=$3, start_date=$4, end_date=$5, last_sync=NOW(), prizes=$6
    `, [affiliateId, comp.name, comp.totalPrize, comp.startDate, comp.endDate, JSON.stringify(state.prizes)]);
    console.log(`[DB] ✓ Pushed ${players.length} players to database`);
  } catch(e) {
    console.error('[DB] Push error:', e.message);
  } finally {
    await client.end();
  }
}

// ── Sync ────────────────────────────────────────────────────────────
async function runSync() {
  if (!state.token) return;
  if (isSyncing) return;
  isSyncing = true;
  console.log('[Server] Running sync...');
  return new Promise((resolve) => {
    execFile('node', [path.join(__dirname, 'scraper.js')], async (err, stdout, stderr) => {
      isSyncing = false;
      if (err) { console.error('[Server] Scrape failed:', err.message); }
      else {
        console.log(stdout);
        state = loadData();
        if (state.players?.length > 0) await pushToDB(state.players, state);
      }
      resolve();
    });
  });
}

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  runSync();
  syncTimer = setInterval(runSync, INTERVAL_MS);
}

// ── Routes ──────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  // Try DB first, fall back to local data
  const dbData = await getFromDB(state.affiliateCode || 'default');

  if (dbData?.players?.length > 0) {
    const comp = dbData.competition;
    res.json({
      success: true,
      configured: true,
      players: dbData.players.map(p => ({
        rank: p.rank,
        username: p.username,
        wallet: p.wallet,
        totalWager: p.total_wager,
        prize: p.prize,
      })),
      totalTurnover: dbData.players.reduce((s, p) => s + (p.total_wager || 0), 0),
      competition: comp ? {
        name: comp.name,
        totalPrize: comp.total_prize,
        startDate: comp.start_date,
        endDate: comp.end_date,
      } : DEFAULT_COMPETITION,
      prizes: comp?.prizes || DEFAULT_PRIZES,
      lastSync: comp?.last_sync,
    });
  } else {
    res.json({
      success: !!state.token,
      configured: !!state.token,
      players: state.players || [],
      totalTurnover: state.totalVolume || 0,
      competition: state.competition || DEFAULT_COMPETITION,
      prizes: state.prizes || DEFAULT_PRIZES,
      lastSync: state.lastSync,
    });
  }
});

app.post('/api/setup', async (req, res) => {
  const { token, authStore, web3Auth, adminPassword } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.token = token;
  state.authStore = authStore || null;
  state.web3Auth = web3Auth || 'auth';
  state.tokenExpired = false;
  saveData(state);
  startSyncLoop();
  res.json({ success: true });
});

app.post('/api/refresh-token', async (req, res) => {
  const { token, authStore, web3Auth, adminPassword } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.token = token;
  state.authStore = authStore || state.authStore;
  state.web3Auth = web3Auth || state.web3Auth;
  state.tokenExpired = false;
  saveData(state);
  startSyncLoop();
  res.json({ success: true });
});

app.post('/api/sync', async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  res.json({ success: true });
  runSync();
});

app.post('/api/competition', (req, res) => {
  const { adminPassword, competition } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.competition = { ...DEFAULT_COMPETITION, ...competition };
  saveData(state);
  res.json({ success: true });
});

app.post('/api/prizes', (req, res) => {
  const { adminPassword, prizes } = req.body;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  state.prizes = prizes;
  saveData(state);
  res.json({ success: true });
});

app.get('/api/admin/status', (req, res) => {
  const pw = req.query.password;
  if (pw !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    configured: !!state.token,
    playerCount: state.players?.length || 0,
    lastSync: state.lastSync,
    competition: state.competition,
    prizes: state.prizes,
  });
});

app.listen(PORT, () => {
  console.log(`\n🦈 Sharker Leaderboard → http://localhost:${PORT}`);
  console.log(`⚙  Admin → http://localhost:${PORT}/admin.html`);
  console.log(`🔧 Setup → http://localhost:${PORT}/setup.html\n`);
  if (state.token) {
    console.log('[Server] Session found — starting sync...');
    startSyncLoop();
  } else {
    console.log('[Server] No session — visit /setup.html');
  }
});
