// Furry of Madness — home-side cloud agent.
//
// Bridges the game server (this machine) to Supabase using OUTBOUND requests
// only. Nothing dials in, so no extra port is opened and the dynamic home IP
// does not matter.
//
//   every PUSH_INTERVAL   : read MySQL  → push status + leaderboard to Supabase
//   every POLL_INTERVAL   : pull pending registrations → create accounts locally
//
// Account creation goes through the same worldserver console relay the panel
// uses (cmd.txt), because AzerothCore derives an SRP6 verifier from the
// plaintext password - it cannot be inserted straight into the DB.
//
// Config comes from .env (see .env.example). Never commit that file.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ── config ────────────────────────────────────────────────────────────────
function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SERVER_DIR    = process.env.SERVER_DIR    || 'C:\\Users\\DomiJesusa\\Desktop\\wow\\server';
const DB_PASS_FILE  = process.env.DB_PASS_FILE  || 'C:\\Users\\DomiJesusa\\Desktop\\wow\\setup\\db-password.txt';
const DB_USER       = process.env.DB_USER       || 'acore';
const DB_HOST       = process.env.DB_HOST       || '127.0.0.1';
const PUSH_INTERVAL = +(process.env.PUSH_INTERVAL_MS || 30000);
const POLL_INTERVAL = +(process.env.POLL_INTERVAL_MS || 15000);
const PANEL_URL     = process.env.PANEL_URL     || 'http://localhost:8080';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Copy .env.example to .env first.');
  process.exit(1);
}

const DB_PASS = fs.existsSync(DB_PASS_FILE) ? fs.readFileSync(DB_PASS_FILE, 'utf8').trim() : process.env.DB_PASS;
const CMD_FILE = path.join(SERVER_DIR, 'cmd.txt');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── supabase REST (no SDK: one dependency less to keep current) ───────────
async function sb(method, pathAndQuery, body, extraHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── mysql ────────────────────────────────────────────────────────────────
async function q(database, sql, params = []) {
  const conn = await mysql.createConnection({
    host: DB_HOST, port: 3306, user: DB_USER, password: DB_PASS, database, connectTimeout: 5000,
  });
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    try { await conn.end(); } catch (e) {}
  }
}

async function panelUp() {
  try {
    const r = await fetch(`${PANEL_URL}/api/status`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch (e) { return false; }
}

// ── push: status + leaderboard ───────────────────────────────────────────
async function pushStatus() {
  let status = null;
  try {
    const r = await fetch(`${PANEL_URL}/api/status`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) status = await r.json();
  } catch (e) { /* panel down - fall through to "offline" */ }

  const svc = status?.services || {};
  const row = {
    id: 1,
    updated_at: new Date().toISOString(),
    online: !!(svc.authserver && svc.worldserver),
    players_online: status?.playersOnline ?? 0,
    bots_online: status?.botsOnline ?? 0,
    characters_total: status?.counts?.total ?? 0,
    realm_address: status?.realm?.address ?? null,
    realm_name: status?.realm?.name ?? null,
    uptime_sec: status?.proc?.worldserver?.uptimeSec ?? null,
    tick_max_ms: status?.perf?.max ?? null,
  };

  await sb('POST', 'server_status', row, { Prefer: 'resolution=merge-duplicates' });
  return row;
}

async function pushLeaderboard() {
  // Only real players - bot accounts would swamp a public leaderboard.
  const botAccounts = await q('acore_auth',
    "SELECT id FROM account WHERE username LIKE 'rndbot%' OR username LIKE 'addclass%'");
  const botIds = new Set(botAccounts.map((r) => r.id));

  const chars = await q('acore_characters',
    'SELECT guid, name, level, race, class, totaltime, account FROM characters ORDER BY level DESC, totaltime DESC LIMIT 200');

  const rows = chars
    .filter((c) => !botIds.has(c.account))
    .slice(0, 50)
    .map((c) => ({
      guid: c.guid, name: c.name, level: c.level, race: c.race, class: c.class,
      played_sec: c.totaltime, is_bot: false, updated_at: new Date().toISOString(),
    }));

  if (rows.length) await sb('POST', 'leaderboard', rows, { Prefer: 'resolution=merge-duplicates' });
  return rows.length;
}

// ── pull: registration queue ─────────────────────────────────────────────
const RE_USER = /^[A-Za-z0-9_-]{1,16}$/;
const RE_PASS = /^[\x21-\x7E]{1,16}$/;

async function relaySend(cmd) {
  if (/[\r\n]/.test(cmd)) throw new Error('invalid command');
  // Wait for the previous command to be consumed by run-worldserver.ps1.
  for (let i = 0; i < 30 && fs.existsSync(CMD_FILE); i++) await sleep(200);
  if (fs.existsSync(CMD_FILE)) throw new Error('console relay busy');
  fs.writeFileSync(CMD_FILE, cmd + '\r\n', 'ascii');
  for (let i = 0; i < 50 && fs.existsSync(CMD_FILE); i++) await sleep(200);
  if (fs.existsSync(CMD_FILE)) throw new Error('console relay did not pick the command up');
}

async function accountExists(username) {
  const r = await q('acore_auth', 'SELECT id FROM account WHERE username = ?', [username.toUpperCase()]);
  return r.length ? r[0].id : null;
}

async function processRegistrations() {
  const pending = await sb('GET', 'registrations?status=eq.pending&select=id,username,password&limit=10');
  if (!pending || !pending.length) return 0;

  let done = 0;
  for (const r of pending) {
    const fail = async (msg) => {
      log('registration failed:', r.username, '-', msg);
      // Clear the password even on failure - it must not linger in the cloud.
      await sb('PATCH', `registrations?id=eq.${r.id}`,
        { status: 'error', error: msg, password: null, processed_at: new Date().toISOString() });
    };

    if (!RE_USER.test(r.username || '')) { await fail('invalid username'); continue; }
    if (!RE_PASS.test(r.password || '')) { await fail('invalid password'); continue; }

    if (await accountExists(r.username)) { await fail('account already exists'); continue; }
    if (!(await panelUp())) { log('panel/worldserver down - leaving', r.username, 'pending'); continue; }

    try {
      await relaySend(`account create ${r.username} ${r.password}`);

      // Account creation goes through an ASYNC database queue, so poll for the
      // row instead of trusting the console's immediate reply.
      let id = null;
      for (let i = 0; i < 30 && !id; i++) { await sleep(400); id = await accountExists(r.username); }
      if (!id) { await fail('account did not appear in the database'); continue; }

      await sb('PATCH', `registrations?id=eq.${r.id}`,
        { status: 'done', password: null, processed_at: new Date().toISOString() });
      log('account created:', r.username, `(id ${id})`);
      done++;
    } catch (e) {
      await fail(String(e.message || e));
    }
  }
  return done;
}

// ── loops ────────────────────────────────────────────────────────────────
async function pushLoop() {
  for (;;) {
    try {
      const s = await pushStatus();
      const n = await pushLeaderboard();
      log(`pushed status (online=${s.online} players=${s.players_online} bots=${s.bots_online}) + ${n} leaderboard rows`);
    } catch (e) {
      log('push failed:', e.message);
    }
    await sleep(PUSH_INTERVAL);
  }
}

async function pollLoop() {
  for (;;) {
    try {
      const n = await processRegistrations();
      if (n) log(`processed ${n} registration(s)`);
    } catch (e) {
      log('registration poll failed:', e.message);
    }
    await sleep(POLL_INTERVAL);
  }
}

log('agent starting');
log('  supabase :', SUPABASE_URL);
log('  server   :', SERVER_DIR);
log('  push     : every', PUSH_INTERVAL / 1000, 's');
log('  poll     : every', POLL_INTERVAL / 1000, 's');
pushLoop();
pollLoop();
