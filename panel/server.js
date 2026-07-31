// AzerothCore admin panel - http://localhost:8080
//
// Bound to 127.0.0.1 ONLY. It can create GM-level accounts, so it must never
// listen on 0.0.0.0 - this machine has 3724/8085 forwarded from the internet.
//
// Mutations go through the worldserver console via the cmd.txt relay that
// run-worldserver.ps1 pumps into the process's stdin. Every mutation is then
// VERIFIED against the database, because the console reports success for
// things that silently did not happen (see createAccount below).

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const mysql = require('mysql2/promise');

const PORT = 8080;
// Derived from this file's own location (panel\server.js -> wow\), so the panel
// follows the project to a new machine or drive with no edit. WOW_BASE
// overrides it if the panel is ever run from somewhere else.
const BASE = process.env.WOW_BASE || path.resolve(__dirname, '..');
const CMD_FILE = path.join(BASE, 'server', 'cmd.txt');
const CONSOLE_LOG = path.join(BASE, 'server', 'logs', 'worldserver-console.log');
const DB_PASS = fs.readFileSync(path.join(BASE, 'setup', 'db-password.txt'), 'utf8').trim();

const dbCfg = (database) => ({
  host: '127.0.0.1', port: 3306, user: 'acore', password: DB_PASS, database, connectTimeout: 4000,
});

const RACES = { 1:'Human',2:'Orc',3:'Dwarf',4:'Night Elf',5:'Undead',6:'Tauren',7:'Gnome',8:'Troll',10:'Blood Elf',11:'Draenei' };
const CLASSES = { 1:'Warrior',2:'Paladin',3:'Hunter',4:'Rogue',5:'Priest',6:'Death Knight',7:'Shaman',8:'Mage',9:'Warlock',11:'Druid' };
const MAPS = { 0:'Eastern Kingdoms',1:'Kalimdor',530:'Outland',571:'Northrend' };
const GM_NAMES = { 0:'Играч', 1:'Модератор', 2:'Game Master', 3:'Администратор' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- validation
// These commands are written as a line to worldserver's stdin and parsed with
// strtok on spaces. A space smuggles an extra argument; a newline smuggles an
// entire additional console command. Both are rejected outright.
const RE_USER = /^[A-Za-z0-9_-]{1,16}$/;
const RE_PASS = /^[\x21-\x7E]{1,16}$/;          // printable ASCII, no space

function badUser(u) {
  if (typeof u !== 'string' || !RE_USER.test(u))
    return 'Потребителското име: 1-16 знака, само A-Z a-z 0-9 _ - (без интервали).';
  return null;
}
function badPass(p) {
  if (typeof p !== 'string' || !RE_PASS.test(p))
    return 'Паролата: 1-16 печатаеми знака без интервал.';
  return null;
}
function badLevel(l) {
  return Number.isInteger(l) && l >= 0 && l <= 3 ? null : 'GM нивото трябва да е 0-3.';
}

// ------------------------------------------------------------------ database
async function q(database, sql, params = []) {
  let conn;
  try {
    conn = await mysql.createConnection(dbCfg(database));
    const [rows] = await conn.execute(sql, params);
    return rows;
  } catch (e) {
    return { __error: String(e.message || e) };
  } finally {
    if (conn) try { await conn.end(); } catch (e) {}
  }
}

async function getAccount(username) {
  const r = await q('acore_auth',
    `SELECT a.id, a.username, IFNULL(aa.gmlevel,0) AS gmlevel
     FROM account a LEFT JOIN account_access aa ON aa.id = a.id
     WHERE a.username = ?`, [username.toUpperCase()]);
  return Array.isArray(r) && r.length ? r[0] : null;
}

// ------------------------------------------------------------- console relay
function relayAlive() {
  // If the relay is down, cmd.txt is never consumed and every command silently
  // queues forever. Detect that instead of hanging.
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(1200);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(8085, '127.0.0.1');
  });
}

async function waitUntil(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function logSize() {
  try { return fs.statSync(CONSOLE_LOG).size; } catch (e) { return 0; }
}
function logSince(offset) {
  try {
    const fd = fs.openSync(CONSOLE_LOG, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !/Update time diff|diffs summary|^\|-/.test(l))
      .slice(-12).join('\n');
  } catch (e) { return ''; }
}

async function runCommand(cmd) {
  if (/[\r\n]/.test(cmd)) throw new Error('Невалидна команда.');
  if (!(await relayAlive())) throw new Error('worldserver не отговаря на порт 8085 - командата не може да бъде изпълнена.');

  // Serialise: wait for any previous command to be picked up first.
  if (!(await waitUntil(async () => !fs.existsSync(CMD_FILE), 6000)))
    throw new Error('Предишна команда още чака - релето не я е поело.');

  const before = logSize();
  fs.writeFileSync(CMD_FILE, cmd + '\r\n', 'ascii');

  if (!(await waitUntil(async () => !fs.existsSync(CMD_FILE), 10000)))
    throw new Error('Командата не беше поета от релето за 10s.');

  await sleep(1400);               // give the console time to emit its reply
  return logSince(before);
}

// ------------------------------------------------------------------- actions
async function createAccount(username, password, gmlevel) {
  const existing = await getAccount(username);
  if (existing) return { ok: false, msg: `Акаунт "${username}" вече съществува (id ${existing.id}).` };

  const log1 = await runCommand(`account create ${username} ${password}`);

  // CRITICAL: account creation goes through an ASYNC database queue. Issuing
  // "account set gmlevel" immediately resolves the name to id 0, writes an
  // orphan access row, and still prints success. So poll until the row exists.
  let acc = null;
  await waitUntil(async () => { acc = await getAccount(username); return !!acc; }, 12000, 400);
  if (!acc) return { ok: false, msg: 'Акаунтът не се появи в базата.', log: log1 };

  let log2 = '';
  if (gmlevel > 0) {
    log2 = await runCommand(`account set gmlevel ${username} ${gmlevel} -1`);
    const after = await getAccount(username);
    if (!after || after.gmlevel !== gmlevel)
      return { ok: false, msg: `Акаунтът е създаден (id ${acc.id}), но GM нивото не се приложи.`, log: log1 + '\n' + log2 };
  }
  return { ok: true, msg: `Създаден "${username}" (id ${acc.id})${gmlevel > 0 ? `, GM ${gmlevel}` : ''}.`, log: (log1 + '\n' + log2).trim() };
}

async function setGmLevel(username, gmlevel) {
  const acc = await getAccount(username);
  if (!acc) return { ok: false, msg: `Няма акаунт "${username}".` };

  // realmid -1 wipes every access row for the account first, then inserts one
  // (or none, when level is 0). That makes GetSecurity deterministic and is
  // also what Remote Access requires.
  const log = await runCommand(`account set gmlevel ${username} ${gmlevel} -1`);
  const after = await getAccount(username);
  if (!after || after.gmlevel !== gmlevel)
    return { ok: false, msg: `Промяната не се приложи (в базата е ${after ? after.gmlevel : '?'}).`, log };
  return { ok: true, msg: gmlevel === 0 ? `Правата на "${username}" са отнети.` : `"${username}" вече е GM ${gmlevel}.`, log };
}

async function setPassword(username, password) {
  const acc = await getAccount(username);
  if (!acc) return { ok: false, msg: `Няма акаунт "${username}".` };

  const before = await q('acore_auth', 'SELECT SHA2(HEX(verifier),256) AS v FROM account WHERE id=?', [acc.id]);
  const log = await runCommand(`account set password ${username} ${password} ${password}`);
  const after = await q('acore_auth', 'SELECT SHA2(HEX(verifier),256) AS v FROM account WHERE id=?', [acc.id]);

  // The SRP6 verifier must actually change - that proves it was recomputed
  // rather than the command quietly failing.
  const changed = Array.isArray(before) && Array.isArray(after) && before[0] && after[0] && before[0].v !== after[0].v;
  return changed
    ? { ok: true, msg: `Паролата на "${username}" е сменена.`, log }
    : { ok: false, msg: 'Паролата не се промени (verifier е същият).', log };
}

async function deleteAccount(username) {
  const acc = await getAccount(username);
  if (!acc) return { ok: false, msg: `Няма акаунт "${username}".` };
  const log = await runCommand(`account delete ${username}`);
  const after = await getAccount(username);
  return after
    ? { ok: false, msg: 'Акаунтът още съществува.', log }
    : { ok: true, msg: `Акаунт "${username}" е изтрит.`, log };
}

// -------------------------------------------------------------------- status
function checkPort(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

// --------------------------------------------------------------- live sync
// The `characters` table is only written on PlayerSaveInterval (15 min by
// default) or logout, so an ONLINE character's level/money/position in the DB
// lag reality. "saveall" flushes every in-game player to the DB, which is what
// makes the panel show real values instead of a 15-minute-old snapshot.
let lastSync = 0, syncing = false, lastSyncErr = null;

async function syncNow(force) {
  if (syncing) return { ok: false, msg: 'Синхронизация вече тече.' };
  if (!force && Date.now() - lastSync < 25000) return { ok: true, msg: 'скоро синхронизирано' };
  if (!(await checkPort(8085))) { lastSyncErr = 'worldserver не работи'; return { ok: false, msg: lastSyncErr }; }
  syncing = true;
  try {
    const log = await runCommand('saveall');
    lastSync = Date.now(); lastSyncErr = null;
    return { ok: true, msg: 'Данните са синхронизирани от сървъра.', log };
  } catch (e) {
    lastSyncErr = String(e.message);
    return { ok: false, msg: lastSyncErr };
  } finally { syncing = false; }
}

// Background flush so the dashboard is never more than ~30s behind. Skipped
// when nobody is online, to avoid pointless DB writes.
setInterval(async () => {
  try {
    if (syncing) return;
    if (!(await checkPort(8085))) return;
    const r = await q('acore_characters', 'SELECT IFNULL(SUM(online),0) AS n FROM characters');
    if (Array.isArray(r) && r[0] && +r[0].n > 0) await syncNow(true);
  } catch (e) {}
}, 30000);

// ------------------------------------------------------- process / OS stats
// Spawning PowerShell is ~200ms, so cache it - the dashboard polls every 5s.
let procCache = { at: 0, data: [] };
function processStats() {
  return new Promise((resolve) => {
    if (Date.now() - procCache.at < 4000) return resolve(procCache.data);
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       "Get-Process worldserver,authserver,mysqld -ErrorAction SilentlyContinue | " +
       "Select-Object Name,Id,WorkingSet64,CPU,StartTime | ConvertTo-Json -Compress"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        let data = [];
        if (!err && stdout && stdout.trim()) {
          try { const p = JSON.parse(stdout); data = Array.isArray(p) ? p : [p]; } catch (e) {}
        }
        procCache = { at: Date.now(), data };
        resolve(data);
      });
  });
}

// worldserver reports its tick time to the console; the last line is the most
// recent health signal. Judge by the MAX, not the mean - that is what the
// playerbots SmartScale throttle reads.
function lastDiff() {
  try {
    const size = fs.statSync(CONSOLE_LOG).size;
    const start = Math.max(0, size - 60000);
    const fd = fs.openSync(CONSOLE_LOG, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    // Two shapes: the core drops the "with N players online" tail when nobody
    // real is connected, and only then. Matching the old shape alone meant the
    // panel showed a blank tick for the entire time the realm was bot-only,
    // which is exactly when someone is most likely to be watching it.
    const diffs = [...txt.matchAll(/Update time diff:\s*(\d+)ms(?: with (\d+) players online)?/g)];
    const pct = [...txt.matchAll(/Percentiles \(95, 99, max\):\s*(\d+)ms,\s*(\d+)ms,\s*(\d+)ms/g)];
    const last = diffs.length ? diffs[diffs.length - 1] : null;
    const lastPct = pct.length ? pct[pct.length - 1] : null;
    return {
      diff: last ? +last[1] : null,
      players: last ? +last[2] : null,
      p95: lastPct ? +lastPct[1] : null,
      p99: lastPct ? +lastPct[2] : null,
      max: lastPct ? +lastPct[3] : null,
    };
  } catch (e) { return { diff: null, players: null, p95: null, p99: null, max: null }; }
}

async function collect() {
  const [auth, world, my] = await Promise.all([checkPort(3724), checkPort(8085), checkPort(3306)]);
  const [realm, accounts, chars, counts, bots] = await Promise.all([
    q('acore_auth', 'SELECT id,name,address,localAddress,port,gamebuild FROM realmlist'),
    q('acore_auth', `SELECT a.id,a.username,a.last_login,a.last_ip,a.online,a.failed_logins,
                            IFNULL(aa.gmlevel,0) AS gmlevel
                     FROM account a LEFT JOIN account_access aa ON aa.id=a.id
                     WHERE a.username NOT LIKE 'rndbot%' AND a.username NOT LIKE 'addclass%'
                     ORDER BY a.id LIMIT 100`),
    q('acore_characters', 'SELECT guid,name,race,class,level,online,map,totaltime,account FROM characters ORDER BY online DESC, level DESC LIMIT 60'),
    // characters and accounts live in different schemas, so "is this a bot" is
    // resolved by account-name prefix on the auth side rather than a JOIN.
    q('acore_characters', 'SELECT COUNT(*) AS total, IFNULL(SUM(online),0) AS online FROM characters'),
    q('acore_auth', "SELECT COUNT(*) AS bots FROM account WHERE username LIKE 'rndbot%'"),
  ]);
  // Characters live in acore_characters but accounts in acore_auth - separate
  // schemas, so the owner is joined in code rather than in SQL.
  if (Array.isArray(chars) && Array.isArray(accounts)) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const ch of chars) {
      const a = byId.get(ch.account);
      ch.acc_name = a ? a.username : null;
      ch.acc_gm = a ? a.gmlevel : 0;
    }
  }

  // Split online characters into real players vs bots. The bot account ids come
  // from acore_auth, so the split is done here rather than in one query.
  let botsOnline = 0, playersOnline = 0;
  {
    const botIds = await q('acore_auth',
      "SELECT id FROM account WHERE username LIKE 'rndbot%' OR username LIKE 'addclass%'");
    if (Array.isArray(botIds) && Array.isArray(chars)) {
      const bset = new Set(botIds.map((r) => r.id));
      // `chars` is capped at 60 rows, so count online per-group from the DB instead.
      const onl = await q('acore_characters', 'SELECT account FROM characters WHERE online = 1');
      if (Array.isArray(onl)) {
        for (const r of onl) (bset.has(r.account) ? botsOnline++ : playersOnline++);
      }
    }
  }

  const procs = await processStats();
  const pick = (n) => procs.find((p) => p && String(p.Name).toLowerCase() === n) || null;
  const psDate = (d) => {
    // PowerShell ConvertTo-Json renders DateTime as "/Date(1690000000000)/"
    if (!d) return null;
    const m = String(d).match(/\/Date\((\d+)/);
    return m ? +m[1] : (isNaN(Date.parse(d)) ? null : Date.parse(d));
  };
  const proc = (n) => {
    const p = pick(n);
    if (!p) return null;
    const started = psDate(p.StartTime);
    return {
      pid: p.Id,
      ramMB: Math.round((p.WorkingSet64 || 0) / 1048576),
      cpuSec: p.CPU != null ? Math.round(p.CPU) : null,
      uptimeSec: started ? Math.round((Date.now() - started) / 1000) : null,
    };
  };

  return {
    ts: new Date().toISOString(),
    services: { authserver: auth, worldserver: world, mysql: my },
    realm: Array.isArray(realm) ? realm[0] : realm,
    accounts, chars,
    counts: Array.isArray(counts) ? counts[0] : counts,
    bots: Array.isArray(bots) && bots[0] ? bots[0].bots : 0,
    botsOnline, playersOnline,
    perf: lastDiff(),
    sync: { at: lastSync || null, ageSec: lastSync ? Math.round((Date.now() - lastSync) / 1000) : null, err: lastSyncErr },
    proc: {
      worldserver: proc('worldserver'),
      authserver: proc('authserver'),
      mysqld: proc('mysqld'),
    },
    host: {
      totalMB: Math.round(os.totalmem() / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
      cpus: os.cpus().length,
      upSec: Math.round(os.uptime()),
    },
  };
}

// -------------------------------------------------------- server start/stop
function psRun(args, detached = false) {
  return new Promise((resolve) => {
    if (detached) {
      const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
        { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      return resolve('стартирано във фонов режим');
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => resolve(((stdout || '') + (stderr || '')).trim() || (err ? String(err.message) : 'ok')));
  });
}

async function startServers() {
  if (await checkPort(8085)) return { ok: false, msg: 'worldserver вече работи.' };
  await psRun(['-File', path.join(BASE, 'setup', 'run-worldserver.ps1')], true);
  const up = await waitUntil(() => checkPort(8085), 180000, 2000);
  if (!up) return { ok: false, msg: 'worldserver не се вдигна за 3 минути. Виж logs\\worldserver-console.log' };
  if (!(await checkPort(3724))) {
    await psRun(['-File', path.join(BASE, 'setup', 'run-authserver.ps1')]);
    await waitUntil(() => checkPort(3724), 30000, 1000);
  }
  return { ok: true, msg: 'Сървърите са стартирани.' };
}

async function stopServers() {
  if (!(await checkPort(8085)) && !(await checkPort(3724)))
    return { ok: false, msg: 'Сървърите вече са спрени.' };

  // Graceful first: "server shutdown" flushes player data to the DB. Killing
  // the process instead risks losing anything not yet saved.
  let log = '';
  if (await checkPort(8085)) {
    try { log = await runCommand('server shutdown 1'); } catch (e) { log = String(e.message); }
    await waitUntil(async () => !(await checkPort(8085)), 60000, 1500);
  }
  await psRun(['-Command', 'Get-Process authserver -ErrorAction SilentlyContinue | Stop-Process -Force']);
  await sleep(2000);
  const stillWorld = await checkPort(8085), stillAuth = await checkPort(3724);
  return stillWorld || stillAuth
    ? { ok: false, msg: `Не спряха напълно (world=${stillWorld} auth=${stillAuth}).`, log }
    : { ok: true, msg: 'Сървърите са спрени.', log };
}

// ------------------------------------------------------------------- realm
// realmlist.name is what players see in the realm list; .address is what the
// auth server hands them for the world connection. Both are re-read by
// authserver every RealmsStateUpdateDelay (20s), so no restart is needed.
async function setRealm(fields) {
  const cur = await q('acore_auth', 'SELECT id,name,address,localAddress,port FROM realmlist WHERE id=1');
  if (!Array.isArray(cur) || !cur.length) return { ok: false, msg: 'Няма realm с id 1.' };
  const now = cur[0];

  const sets = [], vals = [], changed = [];

  if (typeof fields.name === 'string') {
    const n = fields.name.trim();
    if (!n || n.length > 32) return { ok: false, msg: 'Името: 1-32 знака.' };
    if (/[\x00-\x1F]/.test(n)) return { ok: false, msg: 'Името съдържа невалидни знаци.' };
    if (n !== now.name) { sets.push('name=?'); vals.push(n); changed.push(`име: "${now.name}" → "${n}"`); }
  }
  if (typeof fields.address === 'string') {
    const a = fields.address.trim();
    if (!a || a.length > 255) return { ok: false, msg: 'Адресът: 1-255 знака.' };
    if (/\s/.test(a)) return { ok: false, msg: 'Адресът не може да съдържа интервали.' };
    if (a !== now.address) { sets.push('address=?'); vals.push(a); changed.push(`адрес: ${now.address} → ${a}`); }
  }
  if (typeof fields.localAddress === 'string') {
    const l = fields.localAddress.trim();
    if (!l || /\s/.test(l)) return { ok: false, msg: 'LAN адресът е невалиден.' };
    if (l !== now.localAddress) { sets.push('localAddress=?'); vals.push(l); changed.push(`LAN адрес: ${now.localAddress} → ${l}`); }
  }

  if (!sets.length) return { ok: false, msg: 'Няма промени.' };

  vals.push(1);
  const r = await q('acore_auth', `UPDATE realmlist SET ${sets.join(', ')} WHERE id=?`, vals);
  if (r && r.__error) {
    // name is UNIQUE - a duplicate is the realistic failure here.
    return { ok: false, msg: 'Записът се провали: ' + r.__error };
  }
  const after = await q('acore_auth', 'SELECT name,address,localAddress FROM realmlist WHERE id=1');
  return {
    ok: true,
    msg: 'Записано:\n  ' + changed.join('\n  ')
       + '\n\nauthserver презарежда realm-а до 20 секунди — рестарт не е нужен.'
       + '\nИграчите трябва да рестартират клиента, за да видят новото име.',
    after: Array.isArray(after) ? after[0] : null,
  };
}

// ------------------------------------------------------------------- rates
// AzerothCore keeps rates in worldserver.conf, NOT in a database table - there
// is no DB-driven rate system to hook into. So the conf stays the source of
// truth (it is what the server actually reads), we apply changes live with
// "reload config", and every change is journalled to acore_auth.panel_rate_history
// so the settings are DB-backed, auditable and restorable.
const WS_CONF = path.join(BASE, 'server', 'configs', 'worldserver.conf');

const RATE_GROUPS = [
  { key: 'xp', title: 'Опит (XP)', note: 'Множител за получавания опит.', items: [
    ['Rate.XP.Kill', 'Опит от убиване на мобове'],
    ['Rate.XP.Quest', 'Опит от куестове'],
    ['Rate.XP.Quest.DF', 'Опит от куестове през Dungeon Finder'],
    ['Rate.XP.Explore', 'Опит от откриване на нови зони'],
    ['Rate.XP.Pet', 'Опит за домашния любимец (hunter/warlock)'],
    ['Rate.XP.BattlegroundBonus', 'Бонус опит в бойните полета'],
  ]},
  { key: 'drop', title: 'Дроп', note: 'Шанс за падане на предмети по качество.', items: [
    ['Rate.Drop.Money', 'Количество злато от мобове'],
    ['Rate.Drop.Item.Poor', 'Сиви предмети (Poor)'],
    ['Rate.Drop.Item.Normal', 'Бели предмети (Normal)'],
    ['Rate.Drop.Item.Uncommon', 'Зелени предмети (Uncommon)'],
    ['Rate.Drop.Item.Rare', 'Сини предмети (Rare)'],
    ['Rate.Drop.Item.Epic', 'Лилави предмети (Epic)'],
    ['Rate.Drop.Item.Legendary', 'Оранжеви предмети (Legendary)'],
    ['Rate.Drop.Item.Artifact', 'Артефакти'],
    ['Rate.Drop.Item.Referenced', 'Предмети от referenced loot таблици'],
  ]},
  { key: 'prof', title: 'Професии и умения', note: 'Скорост на качване на скилове.', items: [
    ['SkillGain.Crafting', 'Крафтърски професии (Blacksmithing, Tailoring…)'],
    ['SkillGain.Gathering', 'Събирателски професии (Mining, Herbalism, Skinning)'],
    ['SkillGain.Defense', 'Defense умение'],
    ['SkillGain.Weapon', 'Оръжейни умения'],
    ['Rate.Skill.Discovery', 'Шанс за откриване на нови рецепти'],
  ]},
];
const RATE_KEYS = RATE_GROUPS.flatMap((g) => g.items.map((i) => i[0]));

function readRates() {
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(WS_CONF, 'utf8').split(/\r?\n/); } catch (e) { return { __error: String(e.message) }; }
  for (const k of RATE_KEYS) {
    const re = new RegExp('^\\s*' + k.replace(/\./g, '\\.') + '\\s*=\\s*(.+?)\\s*$');
    for (const l of lines) { const m = l.match(re); if (m) { out[k] = m[1].trim(); break; } }
    if (!(k in out)) out[k] = null;
  }
  return out;
}

async function writeRates(changes) {
  const current = readRates();
  if (current.__error) return { ok: false, msg: 'Не мога да прочета worldserver.conf: ' + current.__error };

  const applied = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!RATE_KEYS.includes(k)) return { ok: false, msg: `Непозната настройка: ${k}` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return { ok: false, msg: `${k}: стойността трябва да е число 0-10000.` };
    if (String(current[k]) !== String(n)) applied.push([k, current[k], String(n)]);
  }
  if (!applied.length) return { ok: false, msg: 'Няма промени.' };

  let text;
  try { text = fs.readFileSync(WS_CONF, 'utf8'); } catch (e) { return { ok: false, msg: String(e.message) }; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  for (const [k, , nv] of applied) {
    const re = new RegExp('^(\\s*' + k.replace(/\./g, '\\.') + '\\s*=\\s*).+$');
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { lines[i] = lines[i].replace(re, '$1' + nv); hit = true; break; }
    }
    if (!hit) return { ok: false, msg: `Не намерих реда за ${k} в worldserver.conf.` };
  }
  // UTF-8 WITHOUT BOM - a BOM makes AzerothCore log
  // "Failure to read line number 1 ... Skip this line" on every boot.
  fs.writeFileSync(WS_CONF, lines.join(eol), { encoding: 'utf8' });

  // Journal to the DB before reloading, so the record exists even if the
  // reload fails.
  for (const [k, ov, nv] of applied) {
    await q('acore_auth', 'INSERT INTO panel_rate_history (setting, old_value, new_value) VALUES (?,?,?)', [k, ov, nv]);
  }

  let log = '';
  let reloaded = false;
  try { log = await runCommand('reload config'); reloaded = true; } catch (e) { log = String(e.message); }

  const after = readRates();
  const bad = applied.filter(([k, , nv]) => String(after[k]) !== nv);
  if (bad.length) return { ok: false, msg: 'Файлът не се записа коректно: ' + bad.map((b) => b[0]).join(', '), log };

  return {
    ok: true,
    msg: `Записани ${applied.length} промени:\n` + applied.map(([k, o, n]) => `  ${k}: ${o} → ${n}`).join('\n')
       + (reloaded ? '\n\nПриложено с "reload config".' : '\n\nВНИМАНИЕ: reload не мина - нужен е рестарт.'),
    log,
  };
}

// ------------------------------------------------------------- GM commands
// Pulled from acore_world.command - the server's own table, so the list is
// complete and the required security level is authoritative.
let cmdCache = { at: 0, rows: null };
async function commands() {
  if (cmdCache.rows && Date.now() - cmdCache.at < 300000) return cmdCache.rows;
  const rows = await q('acore_world', 'SELECT name, security, help FROM command ORDER BY name');
  if (!Array.isArray(rows)) return rows;
  cmdCache = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------------- HTML
const HTML = `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AzerothCore Admin</title><style>
:root{--bg:#0f1216;--panel:#171c23;--line:#252d38;--fg:#e8edf4;--dim:#9aa7b8;--ok:#31c48d;--bad:#f05252;--warn:#e3a008;--acc:#4f9cf9;--inp:#0c1015}
@media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--panel:#fff;--line:#e2e7ef;--fg:#141a22;--dim:#5d6b7f;--inp:#fff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:20;flex-wrap:wrap}
h1{font-size:17px;margin:0;font-weight:650}.grow{flex:1}
.stamp{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
main{padding:20px;display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));max-width:1600px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim);margin:0;padding:13px 16px;border-bottom:1px solid var(--line);font-weight:600}
.body{padding:14px 16px}.wide{grid-column:1/-1}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}.k{color:var(--dim)}.v{font-weight:600;text-align:right;word-break:break-all}
.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-weight:650;font-size:12px}
.up{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.down{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.stat .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:640px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.6px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}tr:last-child td{border-bottom:0}
.on{color:var(--ok);font-weight:650}.off{color:var(--dim)}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px;font-weight:600}
input,select{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--inp);color:var(--fg);font:inherit;font-size:13px}
input:focus,select:focus{outline:2px solid color-mix(in srgb,var(--acc) 55%,transparent);outline-offset:1px;border-color:var(--acc)}
button{padding:9px 15px;border-radius:8px;border:1px solid transparent;background:var(--acc);color:#04121f;font:inherit;font-weight:650;cursor:pointer;font-size:13px}
button:hover{filter:brightness(1.09)}button:disabled{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;border-color:var(--line);color:var(--fg)}
button.danger{background:var(--bad);color:#fff}
button.sm{padding:5px 10px;font-size:12px;border-radius:6px}
.hint{color:var(--dim);font-size:11.5px;margin-top:6px}
.acts{display:flex;gap:6px;align-items:center;flex-wrap:nowrap}
.acts select{width:auto;padding:5px 8px;font-size:12px}
#toast{position:fixed;right:18px;bottom:18px;z-index:100;display:flex;flex-direction:column;gap:8px;max-width:min(460px,92vw)}
.msg{padding:11px 14px;border-radius:10px;font-size:13px;border:1px solid var(--line);background:var(--panel);box-shadow:0 8px 26px rgba(0,0,0,.3);white-space:pre-wrap}
.msg.good{border-color:var(--ok);color:var(--ok)}.msg.bad{border-color:var(--bad);color:var(--bad)}
.gm3{background:color-mix(in srgb,var(--bad) 20%,transparent);color:var(--bad);padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700}
.gm2{background:color-mix(in srgb,var(--warn) 22%,transparent);color:var(--warn);padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700}
.gm1{background:color-mix(in srgb,var(--acc) 20%,transparent);color:var(--acc);padding:1px 7px;border-radius:5px;font-size:11px;font-weight:700}
.err{color:var(--bad);font-size:12px}
code{background:var(--bg);padding:2px 6px;border-radius:5px;border:1px solid var(--line);font-size:12px}
.bar{height:6px;background:var(--bg);border:1px solid var(--line);border-radius:99px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--acc)}
.bar i.hot{background:var(--warn)} .bar i.crit{background:var(--bad)}
.ctl{display:flex;gap:8px;flex-wrap:wrap}
.cmdbox{max-height:520px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.cmd{border-bottom:1px solid var(--line);padding:9px 12px}
.cmd:last-child{border-bottom:0}
.cmd b{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--acc)}
.cmd .lvl{font-size:10.5px;padding:1px 6px;border-radius:4px;margin-left:8px;font-weight:700;vertical-align:1px}
.cmd pre{margin:5px 0 0;color:var(--dim);font-size:11.5px;white-space:pre-wrap;font-family:inherit;line-height:1.45}
.grp{padding:7px 12px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;
     font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);font-weight:700}
</style></head><body>
<header><h1>AzerothCore &mdash; администрация</h1><div class="grow"></div><span class="stamp" id="stamp">зареждане…</span></header>
<main id="app"></main><div id="toast"></div>
<script>
const RACES=${JSON.stringify(RACES)},CLASSES=${JSON.stringify(CLASSES)},MAPS=${JSON.stringify(MAPS)},GMN=${JSON.stringify(GM_NAMES)};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pill=(ok,t)=>'<span class="pill '+(ok?'up':'down')+'"><i class="dot"></i>'+t+'</span>';
const dur=s=>{s=+s||0;const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'ч '+m+'м':m+'м';};
let busy=false;

function toast(ok,text){
  const d=document.createElement('div');d.className='msg '+(ok?'good':'bad');d.textContent=text;
  document.getElementById('toast').appendChild(d);
  setTimeout(()=>d.remove(),9000);
}
async function call(url,payload){
  if(busy){toast(false,'Изчакай предишната операция.');return null;}
  busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json();
    toast(j.ok,(j.msg||'')+(j.log?'\\n\\n'+j.log:''));
    return j;
  }catch(e){toast(false,'Мрежова грешка: '+e.message);return null;}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);tick();}
}

async function doCreate(){
  const u=document.getElementById('nu').value.trim();
  const p=document.getElementById('np').value;
  const g=parseInt(document.getElementById('ng').value,10);
  if(!u||!p){toast(false,'Попълни име и парола.');return;}
  const j=await call('/api/account/create',{username:u,password:p,gmlevel:g});
  if(j&&j.ok){document.getElementById('nu').value='';document.getElementById('np').value='';}
}
async function doGm(u,sel){ await call('/api/account/gmlevel',{username:u,gmlevel:parseInt(sel.value,10)}); }
async function doPass(u){
  const p=prompt('Нова парола за "'+u+'" (до 16 знака, без интервал):');
  if(p) await call('/api/account/password',{username:u,password:p});
}
async function doDel(u){
  if(prompt('Ще изтрие акаунта "'+u+'" и всичките му характери.\\nНапиши името за потвърждение:')!==u){
    toast(false,'Отказано.');return;
  }
  await call('/api/account/delete',{username:u});
}

function gmBadge(l){ return l>0?'<span class="gm'+l+'">'+esc(GMN[l]||('GM '+l))+'</span>':'<span class="off">—</span>'; }

async function srv(act,label){
  if(act!=='start'&&!confirm('Сигурен ли си: '+label+'?'))return;
  toast(true,label+'… може да отнеме до 3 минути.');
  await call('/api/server/'+act,{});
}
async function doSync(){ await call('/api/sync',{}); }
async function saveRealm(){
  await call('/api/realm',{
    name:document.getElementById('rname').value,
    address:document.getElementById('raddr').value,
    localAddress:document.getElementById('rlocal').value});
}
async function resetRealm(){
  try{
    const d=await (await fetch('/api/status',{cache:'no-store'})).json();
    const r=d.realm||{};
    document.getElementById('rname').value=r.name||'';
    document.getElementById('raddr').value=r.address||'';
    document.getElementById('rlocal').value=r.localAddress||'';
  }catch(e){}
}
async function sendCmd(){
  const i=document.getElementById('cc');
  const v=i.value.trim(); if(!v){toast(false,'Въведи команда.');return;}
  const j=await call('/api/console',{cmd:v});
  if(j&&j.ok)i.value='';
}

// The commands panel is rendered ONCE and never touched by the 5s refresh -
// rebuilding it was what reset the scroll position mid-scroll.
let CMDS=null,CMDQ='',CMDCAT='',CMDSORT='name';
async function loadCmds(){
  if(CMDS)return CMDS;
  try{ CMDS=await (await fetch('/api/commands')).json(); }catch(e){ CMDS=[]; }
  if(!Array.isArray(CMDS))CMDS=[];
  buildCatList();
  return CMDS;
}
function catOf(c){ return String(c.name).split(' ')[0]; }
function buildCatList(){
  const sel=document.getElementById('ccat'); if(!sel)return;
  const counts={};
  for(const c of CMDS) counts[catOf(c)]=(counts[catOf(c)]||0)+1;
  const cats=Object.keys(counts).sort();
  sel.innerHTML='<option value="">Всички категории ('+CMDS.length+')</option>'
    +cats.map(c=>'<option value="'+esc(c)+'"'+(c===CMDCAT?' selected':'')+'>'+esc(c)+' ('+counts[c]+')</option>').join('');
}
function renderCmds(){
  const box=document.getElementById('cmdbox'); if(!box||!CMDS)return;
  const q=CMDQ.toLowerCase();
  let list=CMDS.filter(c=>{
    if(CMDCAT&&catOf(c)!==CMDCAT)return false;
    if(!q)return true;
    return c.name.toLowerCase().includes(q)||String(c.help||'').toLowerCase().includes(q);
  });

  if(CMDSORT==='level'){
    list=list.slice().sort((a,b)=>(b.security-a.security)||a.name.localeCompare(b.name));
  }else if(CMDSORT==='levelasc'){
    list=list.slice().sort((a,b)=>(a.security-b.security)||a.name.localeCompare(b.name));
  }else{
    list=list.slice().sort((a,b)=>a.name.localeCompare(b.name));
  }

  const cnt=document.getElementById('cmdcount');
  if(cnt)cnt.textContent=list.length+' / '+CMDS.length;
  if(!list.length){box.innerHTML='<div class="cmd"><span class="off">няма съвпадения</span></div>';return;}

  let html='',grp=null;
  for(const c of list){
    // Header shows category when sorting by name, GM level when sorting by level.
    const g=(CMDSORT==='name')?catOf(c):('ниво '+(c.security|0)+' — '+(GMN[c.security|0]||''));
    if(g!==grp){grp=g;html+='<div class="grp">'+esc(g)+'</div>';}
    const lv=c.security|0;
    const cls=lv>=3?'gm3':lv===2?'gm2':lv===1?'gm1':'off';
    html+='<div class="cmd"><b>.'+esc(c.name)+'</b>'
      +'<span class="lvl '+cls+'">ниво '+lv+'</span>'
      +(c.help?'<pre>'+esc(String(c.help).trim())+'</pre>':'')
      +'</div>';
  }
  box.innerHTML=html;
  box.scrollTop=0;   // only on an explicit filter/sort change, never on refresh
}

function render(d){
  document.getElementById('stamp').textContent='обновено '+new Date(d.ts).toLocaleTimeString('bg-BG');
  const s=d.services,c=d.counts||{},r=d.realm||{};
  const svc='<div class="card"><h2>Услуги</h2><div class="body">'
    +'<div class="row"><span class="k">authserver <code>3724</code></span><span class="v">'+pill(s.authserver,s.authserver?'работи':'спрян')+'</span></div>'
    +'<div class="row"><span class="k">worldserver <code>8085</code></span><span class="v">'+pill(s.worldserver,s.worldserver?'работи':'спрян')+'</span></div>'
    +'<div class="row"><span class="k">MySQL <code>3306</code></span><span class="v">'+pill(s.mysql,s.mysql?'работи':'спрян')+'</span></div>'
    +'</div></div>';
  const realm='<div class="card"><h2>Realm</h2><div class="body">'
    +'<div class="row"><span class="k">Порт</span><span class="v">'+esc(r.port)+'</span></div>'
    +'<div class="row"><span class="k">Gamebuild</span><span class="v">'+esc(r.gamebuild)+' (3.3.5a)</span></div>'
    +'<div class="row"><span class="k">Активно име</span><span class="v">'+esc(r.name)+'</span></div>'
    +'</div></div>';
  const stats='<div class="card"><h2>Обобщено</h2><div class="body"><div class="stats">'
    +'<div class="stat"><div class="n">'+(c.online||0)+'</div><div class="l">в света</div></div>'
    +'<div class="stat"><div class="n">'+(c.total||0)+'</div><div class="l">характери</div></div>'
    +'<div class="stat"><div class="n">'+((d.accounts||[]).length||0)+'</div><div class="l">акаунти</div></div>'
    +'<div class="stat"><div class="n">'+(d.bots||0)+'</div><div class="l">ботове</div></div>'
    +'</div></div></div>';

  // ---- управление + статистики
  const anyUp=s.worldserver||s.authserver;
  const ctl='<div class="card"><h2>Управление</h2><div class="body">'
    +'<div class="ctl">'
      +'<button onclick="srv(\\'start\\',\\'Пускане на сървъра\\')" '+(s.worldserver?'disabled':'')+'>▶ Пусни</button>'
      +'<button class="danger" onclick="srv(\\'stop\\',\\'Спиране на сървъра\\')" '+(anyUp?'':'disabled')+'>■ Спри</button>'
      +'<button class="ghost" onclick="srv(\\'restart\\',\\'Рестарт на сървъра\\')" '+(anyUp?'':'disabled')+'>⟳ Рестарт</button>'
    +'</div>'
    +'<div class="hint">Спирането е коректно (<code>server shutdown</code>) — записва данните на играчите. '
    +'Пускането отнема ~40 секунди за зареждане на света.</div>'
    +'<label>Конзолна команда</label>'
    +'<div class="acts"><input id="cc" placeholder="напр. server info" onkeydown="if(event.key===\\'Enter\\')sendCmd()" autocomplete="off">'
    +'<button onclick="sendCmd()">Изпълни</button></div>'
    +'</div></div>';

  const pf=d.perf||{},pr=d.proc||{},h=d.host||{};
  const w=pr.worldserver,a=pr.authserver,mq=pr.mysqld;
  const usedPct=h.totalMB?Math.round((h.totalMB-h.freeMB)/h.totalMB*100):0;
  const diffCls=(pf.max==null)?'':(pf.max>=200?'crit':pf.max>=50?'hot':'');
  const prow=(n,p)=>p?('<div class="row"><span class="k">'+n+'</span><span class="v">'+p.ramMB+' MB · PID '+p.pid
      +(p.uptimeSec!=null?' · '+dur(p.uptimeSec):'')+'</span></div>')
      :('<div class="row"><span class="k">'+n+'</span><span class="v off">не работи</span></div>');
  const perf='<div class="card"><h2>Статистики</h2><div class="body">'
    +prow('worldserver',w)+prow('authserver',a)+prow('MySQL',mq)
    +'<div class="row"><span class="k">Tick (последен)</span><span class="v">'+(pf.diff!=null?pf.diff+' ms':'—')+'</span></div>'
    +'<div class="row"><span class="k">Tick p95 / p99 / max</span><span class="v">'
      +(pf.p95!=null?pf.p95+' / '+pf.p99+' / '+pf.max+' ms':'—')+'</span></div>'
    +'<div class="bar"><i class="'+diffCls+'" style="width:'+Math.min(100,(pf.max||0)/3)+'%"></i></div>'
    +'<div class="hint">Здравословно е <b>max ≤ 50 ms</b>. Над 200 ms модулът за ботове спира неактивните.</div>'
    +'<div class="row" style="margin-top:8px"><span class="k">RAM на машината</span><span class="v">'
      +(h.totalMB?((h.totalMB-h.freeMB)+' / '+h.totalMB+' MB ('+usedPct+'%)'):'—')+'</span></div>'
    +'<div class="bar"><i class="'+(usedPct>90?'crit':usedPct>75?'hot':'')+'" style="width:'+usedPct+'%"></i></div>'
    +'<div class="row" style="margin-top:8px"><span class="k">CPU ядра</span><span class="v">'+(h.cpus||'—')+'</span></div>'
    +'<div class="row"><span class="k">Windows uptime</span><span class="v">'+(h.upSec?dur(h.upSec):'—')+'</span></div>'
    +'</div></div>';

  const create='<div class="card"><h2>Създай акаунт</h2><div class="body">'
    +'<label>Потребителско име</label><input id="nu" maxlength="16" placeholder="напр. igrach1" autocomplete="off">'
    +'<label>Парола</label><input id="np" maxlength="16" placeholder="до 16 знака" autocomplete="new-password">'
    +'<label>Ниво на достъп</label><select id="ng">'
      +'<option value="0">0 — Играч</option><option value="1">1 — Модератор</option>'
      +'<option value="2">2 — Game Master</option><option value="3">3 — Администратор</option></select>'
    +'<div style="margin-top:14px"><button onclick="doCreate()">Създай</button></div>'
    +'<div class="hint">Име: A-Z a-z 0-9 _ - (до 16). Парола: до 16 знака без интервал. '
    +'Имената и паролите не различават малки/главни букви.</div></div></div>';

  let acc='<div class="card wide"><h2>Акаунти</h2><div class="body scroll">';
  if(d.accounts&&d.accounts.__error){acc+='<div class="err">'+esc(d.accounts.__error)+'</div>';}
  else{
    acc+='<table><tr><th>ID</th><th>Потребител</th><th>Достъп</th><th>Последен вход</th><th>IP</th><th>Статус</th><th>Действия</th></tr>';
    for(const a of (d.accounts||[])){
      const u=esc(a.username);
      let opts='';for(let i=0;i<=3;i++){opts+='<option value="'+i+'"'+(a.gmlevel===i?' selected':'')+'>'+i+' — '+esc(GMN[i])+'</option>';}
      acc+='<tr><td>'+esc(a.id)+'</td><td><b>'+u+'</b></td><td>'+gmBadge(a.gmlevel)+'</td>'
        +'<td>'+esc(a.last_login||'—')+'</td><td>'+esc(a.last_ip||'—')+'</td>'
        +'<td class="'+(a.online?'on':'off')+'">'+(a.online?'● логнат':'офлайн')+'</td>'
        +'<td><div class="acts">'
          +'<select onchange="doGm(\\''+u+'\\',this)">'+opts+'</select>'
          +'<button class="ghost sm" onclick="doPass(\\''+u+'\\')">Парола</button>'
          +'<button class="danger sm" onclick="doDel(\\''+u+'\\')">Изтрий</button>'
        +'</div></td></tr>';
    }
    acc+='</table>';
  }
  acc+='</div></div>';

  const sy=d.sync||{};
  const syTxt=sy.ageSec==null?'никога':(sy.ageSec<60?('преди '+sy.ageSec+' сек'):('преди '+Math.round(sy.ageSec/60)+' мин'));
  const syStale=sy.ageSec==null||sy.ageSec>90;
  let chars='<div class="card wide"><h2>Характери</h2><div class="body">'
    +'<div class="acts" style="margin-bottom:10px;flex-wrap:wrap">'
      +'<button class="ghost sm" onclick="doSync()">⟳ Синхронизирай от сървъра</button>'
      +'<span class="hint" style="margin:0">Последно: <b class="'+(syStale?'off':'on')+'">'+esc(syTxt)+'</b>'
      +(sy.err?' — <span class="err">'+esc(sy.err)+'</span>':'')+'</span>'
    +'</div>'
    +'<div class="hint" style="margin:0 0 10px">Стойностите за играчи <b>в света</b> идват от базата, а тя се '
    +'обновява само на <code>PlayerSaveInterval</code> (15 мин) или при излизане. Панелът пуска '
    +'<code>saveall</code> на всеки 30 сек, докато има играчи онлайн, за да са актуални.</div>'
    +'<div class="scroll">';
  if(!d.chars||!d.chars.length){chars+='<span class="off">няма характери</span>';}
  else{
    chars+='<table><tr><th>Име</th><th>Раса</th><th>Клас</th><th>Ниво</th><th>Карта</th><th>Изиграно</th><th>Акаунт</th><th>Статус</th></tr>';
    for(const ch of d.chars){
      chars+='<tr><td><b>'+esc(ch.name)+'</b></td><td>'+esc(RACES[ch.race]||ch.race)+'</td><td>'+esc(CLASSES[ch.class]||ch.class)+'</td>'
        +'<td><b>'+esc(ch.level)+'</b></td><td>'+esc(MAPS[ch.map]||('map '+ch.map))+'</td><td>'+dur(ch.totaltime)+'</td>'
        +'<td class="off">'+esc(ch.acc_name||'—')+(ch.acc_gm>0?' <span class="gm'+ch.acc_gm+'">GM'+ch.acc_gm+'</span>':'')+'</td>'
        +'<td class="'+(ch.online?'on':'off')+'">'+(ch.online?'● в света':'офлайн')+'</td></tr>';
    }
    chars+='</table>';
  }
  chars+='</div></div></div>';

  // Split the page: #live is rebuilt every 5s, #static is built ONCE.
  // The create form, rates and command browser live in #static so typing,
  // scrolling and filtering are never interrupted by the refresh.
  if(!document.getElementById('live')){
    document.getElementById('app').innerHTML=
      '<div id="live" style="display:contents"></div><div id="static" style="display:contents"></div>';
    document.getElementById('static').innerHTML=
      '<div class="card"><h2>Настройки на realm</h2><div class="body">'
        +'<label>Име на realm <span class="off">(вижда се в списъка при вход)</span></label>'
        +'<input id="rname" maxlength="32" value="'+esc(r.name||'')+'" autocomplete="off">'
        +'<label>Адрес за клиента <span class="off">(публичен IP или домейн)</span></label>'
        +'<input id="raddr" maxlength="255" value="'+esc(r.address||'')+'" autocomplete="off">'
        +'<label>LAN адрес <span class="off">(за играчи в локалната мрежа)</span></label>'
        +'<input id="rlocal" maxlength="255" value="'+esc(r.localAddress||'')+'" autocomplete="off">'
        +'<div style="margin-top:14px" class="ctl"><button onclick="saveRealm()">Запази</button>'
        +'<button class="ghost" onclick="resetRealm()">Върни</button></div>'
        +'<div class="hint">Прилага се до 20 сек без рестарт. Играчите трябва да рестартират клиента, '
        +'за да видят новото име. Ако публичното IP се смени, тук се оправя.</div>'
      +'</div></div>'
      +create
      +'<div class="card wide"><h2>Рейтове</h2><div class="body" id="ratebox">зареждане…</div></div>'
      +'<div class="card wide"><h2>GM команди</h2><div class="body">'
        +'<div class="acts" style="flex-wrap:wrap">'
          +'<input id="cq" placeholder="търси команда или описание…" style="flex:1;min-width:200px" '
            +'oninput="CMDQ=this.value;renderCmds()" autocomplete="off">'
          +'<select id="ccat" style="width:auto" onchange="CMDCAT=this.value;renderCmds()"></select>'
          +'<select id="csort" style="width:auto" onchange="CMDSORT=this.value;renderCmds()">'
            +'<option value="name">Подредба: по категория</option>'
            +'<option value="level">Подредба: ниво (високо→ниско)</option>'
            +'<option value="levelasc">Подредба: ниво (ниско→високо)</option>'
          +'</select>'
          +'<span class="hint" id="cmdcount" style="margin:0;white-space:nowrap"></span>'
        +'</div>'
        +'<div class="hint">Списъкът идва от <code>acore_world.command</code> на самия сървър. '
        +'В играта се пишат с точка отпред. „ниво“ = минималното GM ниво.</div>'
        +'<div class="cmdbox" id="cmdbox" style="margin-top:10px"></div></div></div>';
    buildCatList(); renderCmds(); loadRates();
  }
  // Only touch the DOM when something actually changed, so an open dropdown
  // in the accounts table is not closed by an idle refresh.
  const html=svc+realm+ctl+perf+stats+acc+chars;
  const live=document.getElementById('live');
  if(live.__last!==html){ live.__last=html; live.innerHTML=html; }
}

// ---- рейтове
let RATES=null;
async function loadRates(force){
  if(RATES&&!force){renderRates();return;}
  try{ RATES=await (await fetch('/api/rates',{cache:'no-store'})).json(); }catch(e){ return; }
  renderRates();
}
function renderRates(){
  const box=document.getElementById('ratebox'); if(!box||!RATES)return;
  const v=RATES.values||{};
  let html='<div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">';
  for(const g of (RATES.groups||[])){
    html+='<div><div style="font-weight:700;margin-bottom:2px">'+esc(g.title)+'</div>'
      +'<div class="hint" style="margin:0 0 8px">'+esc(g.note)+'</div>';
    for(const [k,desc] of g.items){
      html+='<label title="'+esc(k)+'">'+esc(desc)+' <code style="font-size:10.5px">'+esc(k)+'</code></label>'
        +'<input type="number" step="0.1" min="0" max="10000" data-rate="'+esc(k)+'" value="'+esc(v[k]==null?'':v[k])+'">';
    }
    html+='</div>';
  }
  html+='</div><div style="margin-top:16px" class="ctl">'
    +'<button onclick="saveRates()">Запази и приложи</button>'
    +'<button class="ghost" onclick="loadRates(true)">Върни стойностите</button></div>'
    +'<div class="hint">1 = нормално, 2 = двойно. Прилага се веднага с <code>reload config</code>; '
    +'вече заредени обекти може да пазят старата стойност до рестарт. '
    +'Всяка промяна се записва в <code>acore_auth.panel_rate_history</code>.</div>';
  if(RATES.history&&RATES.history.length){
    html+='<div style="margin-top:14px"><div style="font-weight:700;margin-bottom:6px">Последни промени</div><div class="scroll">'
      +'<table style="min-width:420px"><tr><th>Кога</th><th>Настройка</th><th>Беше</th><th>Стана</th></tr>';
    for(const r of RATES.history){
      html+='<tr><td>'+esc(String(r.changed_at).replace('T',' ').slice(0,19))+'</td><td><code>'+esc(r.setting)+'</code></td>'
        +'<td class="off">'+esc(r.old_value)+'</td><td><b>'+esc(r.new_value)+'</b></td></tr>';
    }
    html+='</table></div></div>';
  }
  box.innerHTML=html;
}
async function saveRates(){
  const changes={};
  document.querySelectorAll('[data-rate]').forEach(i=>{ changes[i.dataset.rate]=i.value; });
  const j=await call('/api/rates',{changes});
  if(j&&j.ok){ RATES=null; loadRates(true); }
}

async function tick(){
  if(busy)return;
  try{ render(await (await fetch('/api/status',{cache:'no-store'})).json()); }
  catch(e){ document.getElementById('stamp').textContent='грешка: '+e.message; }
}
loadCmds().then(renderCmds);
tick();setInterval(tick,5000);
</script></body></html>`;

// ----------------------------------------------------------------------- HUD
// Compact at-a-glance status board, meant to sit on a second monitor. No charts:
// the data's job here is "current state", which is stat tiles + status, not a plot.
// Status colours always ship with an icon AND a label, so meaning is never
// carried by hue alone.
const HUD_HTML = `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AzerothCore HUD</title><style>
:root{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
  --border:rgba(255,255,255,0.10); --rule:#2c2c2a;
  --good:#0ca30c; --warn:#fab219; --serious:#ec835a; --crit:#d03b3b;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
     font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));max-width:1200px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.card.span{grid-column:1/-1}
.lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.8px;font-weight:650}
.big{font-size:44px;font-weight:700;line-height:1.05;margin-top:4px}
.sub{color:var(--ink2);font-size:12px;margin-top:3px}
.svc{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--rule)}
.svc:last-child{border-bottom:0}
.svc .n{color:var(--ink2);font-size:13px}
.badge{display:inline-flex;align-items:center;gap:7px;font-weight:700;font-size:12.5px}
.ico{width:15px;height:15px;flex:none}
.meter{height:7px;background:var(--plane);border:1px solid var(--border);border-radius:99px;overflow:hidden;margin-top:9px}
.meter i{display:block;height:100%;border-radius:99px}
.row{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13px}
.row .k{color:var(--muted)} .row .v{color:var(--ink2);font-weight:600;text-align:right;word-break:break-all}
.stamp{text-align:center;color:var(--muted);font-size:11px;margin-top:12px}
.tab{font-variant-numeric:tabular-nums}
nav{display:flex;gap:10px;align-items:center;max-width:1200px;margin:0 auto 12px;flex-wrap:wrap}
nav a{color:var(--ink2);text-decoration:none;font-size:12.5px;font-weight:650;padding:6px 12px;
      border:1px solid var(--border);border-radius:8px}
nav a.on{background:var(--surface);color:var(--ink)}
button{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:#2a2a28;color:var(--ink);
       font:inherit;font-weight:650;font-size:12.5px;cursor:pointer}
button:hover{filter:brightness(1.25)} button:disabled{opacity:.45;cursor:not-allowed}
button.go{background:var(--good);color:#04120a;border-color:transparent}
button.stop{background:var(--crit);color:#fff;border-color:transparent}
input,select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);
             background:var(--plane);color:var(--ink);font:inherit;font-size:12.5px;margin-top:5px}
.ctl{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.cmdbox{max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:9px;
        background:var(--plane);margin-top:9px}
.cmd{padding:7px 11px;border-bottom:1px solid var(--rule)} .cmd:last-child{border-bottom:0}
.cmd b{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#3987e5}
.cmd pre{margin:4px 0 0;color:var(--muted);font-size:11px;white-space:pre-wrap;font-family:inherit}
.grp{padding:6px 11px;background:var(--surface);border-bottom:1px solid var(--rule);position:sticky;top:0;
     font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700}
.lvl{font-size:10px;padding:1px 6px;border-radius:4px;margin-left:7px;font-weight:700;
     background:rgba(255,255,255,.08);color:var(--ink2)}
#toast{position:fixed;right:14px;bottom:14px;display:flex;flex-direction:column;gap:7px;max-width:min(430px,92vw);z-index:50}
.msg{padding:10px 13px;border-radius:9px;font-size:12.5px;border:1px solid var(--border);
     background:var(--surface);white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.msg.ok{border-color:var(--good);color:var(--good)} .msg.bad{border-color:var(--crit);color:var(--crit)}
</style></head><body>
<nav>
  <a href="/hud" class="on">HUD</a>
  <a href="/">Пълен панел</a>
  <span style="color:var(--muted);font-size:11.5px">localhost:8080</span>
</nav>
<div class="grid" id="app"><div class="card span"><span class="lbl">зареждане…</span></div></div>
<div class="stamp" id="stamp"></div>
<div id="toast"></div>
<script>
var G="var(--good)",W="var(--warn)",S="var(--serious)",C="var(--crit)";
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
// icon + label: status is never colour-alone
function ico(ok){return ok
  ?'<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4.5L6 12L2.5 8.5"/></svg>'
  :'<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 4L4 12M4 4l8 8"/></svg>';}
function warnIco(){return '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8L15 14H1L8 1.8z"/><path d="M8 6.4v3.4"/><path d="M8 11.9v.1"/></svg>';}
function svc(name,ok){return '<div class="svc"><span class="n">'+esc(name)+'</span>'
  +'<span class="badge" style="color:'+(ok?G:C)+'">'+ico(ok)+(ok?'работи':'СПРЯН')+'</span></div>';}
function dur(s){s=+s||0;var h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'ч '+m+'м':m+'м';}

function render(d){
  var s=d.services||{},c=d.counts||{},pf=d.perf||{},h=d.host||{},w=(d.proc||{}).worldserver,r=d.realm||{};
  var allUp=s.authserver&&s.worldserver&&s.mysql;

  // Thresholds are the playerbots SmartScale ones: <=50 fine, 50-200 throttling
  // begins, >=200 it parks idle bots.
  var mx=pf.max, tc=(mx==null)?'var(--muted)':(mx>=200?C:(mx>=50?W:G));
  var tl=(mx==null)?'няма данни':(mx>=200?'претоварен':(mx>=50?'натоварен':'здрав'));
  var tIco=(mx==null)?'':(mx>=50?warnIco():ico(true));

  var usedPct=h.totalMB?Math.round((h.totalMB-h.freeMB)/h.totalMB*100):0;
  var rc=usedPct>=90?C:(usedPct>=75?W:G);
  var rl=usedPct>=90?'критично':(usedPct>=75?'високо':'нормално');

  var players=(d.playersOnline!=null?d.playersOnline:(c.online||0)), bots=d.botsOnline||0;

  var html=''
   +'<div class="card"><span class="lbl">Състояние</span>'
     +'<div class="big" style="color:'+(allUp?G:C)+'">'+(allUp?'ОНЛАЙН':'ПРОБЛЕМ')+'</div>'
     +'<div style="margin-top:10px">'+svc('authserver 3724',!!s.authserver)+svc('worldserver 8085',!!s.worldserver)+svc('MySQL 3306',!!s.mysql)+'</div>'
   +'</div>'

   +'<div class="card"><span class="lbl">Играчи в света</span>'
     +'<div class="big tab">'+players+'</div>'
     +'<div class="sub">'+bots+' бота онлайн · '+(c.total||0)+' характера общо</div>'
   +'</div>'

   +'<div class="card"><span class="lbl">Tick (max)</span>'
     +'<div class="big tab" style="color:'+tc+'">'+(mx==null?'—':mx+' <span style="font-size:18px">ms</span>')+'</div>'
     +'<div class="badge" style="color:'+tc+';margin-top:4px">'+tIco+esc(tl)+'</div>'
     +'<div class="meter"><i style="width:'+Math.min(100,(mx||0)/3)+'%;background:'+tc+'"></i></div>'
     +'<div class="sub">p95 '+(pf.p95==null?'—':pf.p95+' ms')+' · праг 200 ms</div>'
   +'</div>'

   +'<div class="card"><span class="lbl">Памет</span>'
     +'<div class="big tab" style="color:'+rc+'">'+usedPct+'<span style="font-size:18px">%</span></div>'
     +'<div class="badge" style="color:'+rc+';margin-top:4px">'+(usedPct>=75?warnIco():ico(true))+esc(rl)+'</div>'
     +'<div class="meter"><i style="width:'+usedPct+'%;background:'+rc+'"></i></div>'
     +'<div class="sub">worldserver '+(w?w.ramMB+' MB':'—')+' · свободни '+(h.freeMB||0)+' MB</div>'
   +'</div>'

   +'<div class="card span"><span class="lbl">Realm</span>'
     +'<div class="row"><span class="k">Адрес за клиента</span><span class="v">'+esc(r.address)+'</span></div>'
     +'<div class="row"><span class="k">LAN адрес</span><span class="v">'+esc(r.localAddress)+'</span></div>'
     +'<div class="row"><span class="k">Име · порт</span><span class="v">'+esc(r.name)+' · '+esc(r.port)+'</span></div>'
     +'<div class="row"><span class="k">worldserver uptime</span><span class="v">'+(w&&w.uptimeSec!=null?dur(w.uptimeSec):'—')+'</span></div>'
   +'</div>';

  // #live is rewritten every 3s; #static is built ONCE. The account form and the
  // command list live in #static so typing and scrolling are never interrupted.
  if(!document.getElementById('live')){
    document.getElementById('app').innerHTML=
      '<div id="live" style="display:contents"></div><div id="static" style="display:contents"></div>';
    document.getElementById('static').innerHTML=
       '<div class="card"><span class="lbl">Управление</span>'
         +'<div class="ctl">'
           +'<button class="go" id="bStart" onclick="srv(\\'start\\')">▶ Пусни</button>'
           +'<button class="stop" id="bStop" onclick="srv(\\'stop\\')">■ Спри</button>'
           +'<button id="bRestart" onclick="srv(\\'restart\\')">⟳ Рестарт</button>'
         +'</div>'
         +'<div class="sub" style="margin-top:9px">Спирането е коректно — записва данните на играчите.</div>'
       +'</div>'
      +'<div class="card"><span class="lbl">Нов акаунт</span>'
         +'<input id="hu" maxlength="16" placeholder="потребител" autocomplete="off">'
         +'<input id="hp" maxlength="16" placeholder="парола" autocomplete="new-password">'
         +'<select id="hg"><option value="0">0 — Играч</option><option value="1">1 — Модератор</option>'
           +'<option value="2">2 — Game Master</option><option value="3">3 — Администратор</option></select>'
         +'<div class="ctl"><button onclick="mkacc()">Създай</button></div>'
       +'</div>'
      +'<div class="card span"><span class="lbl">GM команди</span>'
         +'<div class="ctl">'
           +'<input id="hq" placeholder="търси…" style="flex:1;min-width:150px;margin-top:0" oninput="HQ=this.value;drawCmds()">'
           +'<select id="hcat" style="width:auto;margin-top:0" onchange="HCAT=this.value;drawCmds()"></select>'
           +'<span class="sub" id="hcount" style="margin:0;align-self:center"></span>'
         +'</div>'
         +'<div class="cmdbox" id="hcmds"></div>'
       +'</div>';
    buildCats(); drawCmds();
  }

  var live=document.getElementById('live');
  if(live.__last!==html){ live.__last=html; live.innerHTML=html; }

  // Button availability follows service state without rebuilding the card.
  var anyUp=!!(s.worldserver||s.authserver);
  var bs=document.getElementById('bStart'), bt=document.getElementById('bStop'), br=document.getElementById('bRestart');
  if(bs&&!BUSY){bs.disabled=!!s.worldserver;} if(bt&&!BUSY){bt.disabled=!anyUp;} if(br&&!BUSY){br.disabled=!anyUp;}

  document.getElementById('stamp').textContent='обновено '+new Date(d.ts).toLocaleTimeString('bg-BG');
}

function toast(ok,t){var e=document.createElement('div');e.className='msg '+(ok?'ok':'bad');e.textContent=t;
  document.getElementById('toast').appendChild(e);setTimeout(function(){e.remove()},9000);}
var BUSY=false;
function post(url,payload,label){
  if(BUSY){toast(false,'Изчакай предишната операция.');return Promise.resolve(null);}
  BUSY=true;
  if(label)toast(true,label);
  return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json()})
    .then(function(j){toast(j.ok,(j.msg||'')+(j.log?'\\n\\n'+j.log:''));return j})
    .catch(function(e){toast(false,'Грешка: '+e.message);return null})
    .then(function(j){BUSY=false;tick();return j});
}
function srv(a){
  if(a!=='start'&&!confirm('Сигурен ли си: '+a+'?'))return;
  post('/api/server/'+a,{},'Изпълнявам "'+a+'" — може да отнеме до 3 минути.');
}
function mkacc(){
  var u=document.getElementById('hu').value.trim(),p=document.getElementById('hp').value,
      g=parseInt(document.getElementById('hg').value,10);
  if(!u||!p){toast(false,'Попълни име и парола.');return;}
  post('/api/account/create',{username:u,password:p,gmlevel:g}).then(function(j){
    if(j&&j.ok){document.getElementById('hu').value='';document.getElementById('hp').value='';}});
}

// --- GM команди (зареждат се веднъж) ---
var CMDS=null,HQ='',HCAT='';
function catOf(c){return String(c.name).split(' ')[0];}
function buildCats(){
  var sel=document.getElementById('hcat'); if(!sel||!CMDS||sel.options.length)return;
  var cnt={};CMDS.forEach(function(c){cnt[catOf(c)]=(cnt[catOf(c)]||0)+1});
  var keys=Object.keys(cnt).sort();
  sel.innerHTML='<option value="">Всички ('+CMDS.length+')</option>'
    +keys.map(function(k){return '<option value="'+esc(k)+'">'+esc(k)+' ('+cnt[k]+')</option>'}).join('');
  sel.value=HCAT;
}
function drawCmds(){
  var box=document.getElementById('hcmds'); if(!box||!CMDS)return;
  var q=HQ.toLowerCase();
  var list=CMDS.filter(function(c){
    if(HCAT&&catOf(c)!==HCAT)return false;
    if(!q)return true;
    return c.name.toLowerCase().indexOf(q)>=0||String(c.help||'').toLowerCase().indexOf(q)>=0;
  }).sort(function(a,b){return a.name.localeCompare(b.name)});
  var cn=document.getElementById('hcount'); if(cn)cn.textContent=list.length+' / '+CMDS.length;
  if(!list.length){box.innerHTML='<div class="cmd"><span class="sub">няма съвпадения</span></div>';return;}
  var html='',grp=null;
  list.forEach(function(c){
    var g=catOf(c);
    if(g!==grp){grp=g;html+='<div class="grp">'+esc(g)+'</div>';}
    html+='<div class="cmd"><b>.'+esc(c.name)+'</b><span class="lvl">ниво '+(c.security|0)+'</span>'
      +(c.help?'<pre>'+esc(String(c.help).trim())+'</pre>':'')+'</div>';
  });
  box.innerHTML=html;
}
fetch('/api/commands').then(function(r){return r.json()}).then(function(j){
  CMDS=Array.isArray(j)?j:[];buildCats();drawCmds();}).catch(function(){CMDS=[];});

function tick(){if(BUSY)return;fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json()}).then(render)
  .catch(function(e){document.getElementById('stamp').textContent='грешка: '+e.message});}
tick();setInterval(tick,3000);
</script></body></html>`;

// -------------------------------------------------------------------- server
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/hud' || req.url.startsWith('/hud?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HUD_HTML);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/status')) return json(res, 200, await collect());
    if (req.method === 'GET' && req.url.startsWith('/api/commands')) return json(res, 200, await commands());
    if (req.method === 'POST' && req.url.startsWith('/api/sync')) return json(res, 200, await syncNow(true));
    if (req.method === 'POST' && req.url.startsWith('/api/realm')) return json(res, 200, await setRealm(await body(req)));

    if (req.method === 'GET' && req.url.startsWith('/api/rates')) {
      const hist = await q('acore_auth',
        'SELECT setting, old_value, new_value, changed_at FROM panel_rate_history ORDER BY id DESC LIMIT 15');
      return json(res, 200, { groups: RATE_GROUPS, values: readRates(), history: hist });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/rates')) {
      const b = await body(req);
      if (!b || typeof b !== 'object' || !b.changes) return json(res, 400, { ok: false, msg: 'Няма данни.' });
      return json(res, 200, await writeRates(b.changes));
    }

    if (req.method === 'POST' && req.url.startsWith('/api/server/')) {
      const act = req.url.split('/')[3].split('?')[0];
      if (act === 'start') return json(res, 200, await startServers());
      if (act === 'stop') return json(res, 200, await stopServers());
      if (act === 'restart') {
        const s = await stopServers();
        await sleep(3000);
        const t = await startServers();
        return json(res, 200, { ok: t.ok, msg: `Спиране: ${s.msg}\nПускане: ${t.msg}` });
      }
      return json(res, 404, { ok: false, msg: 'Непознато действие.' });
    }

    if (req.method === 'POST' && req.url.startsWith('/api/console')) {
      const b = await body(req);
      if (typeof b.cmd !== 'string' || !b.cmd.trim()) return json(res, 400, { ok: false, msg: 'Празна команда.' });
      if (/[\r\n]/.test(b.cmd)) return json(res, 400, { ok: false, msg: 'Само една команда наведнъж.' });
      try {
        const out = await runCommand(b.cmd.trim().replace(/^\./, ''));
        return json(res, 200, { ok: true, msg: 'Изпълнено.', log: out || '(без изход)' });
      } catch (e) { return json(res, 200, { ok: false, msg: String(e.message) }); }
    }

    if (req.method === 'POST' && req.url.startsWith('/api/account/')) {
      const b = await body(req);
      const act = req.url.split('/')[3].split('?')[0];
      const ue = badUser(b.username);
      if (ue) return json(res, 400, { ok: false, msg: ue });

      if (act === 'create') {
        const pe = badPass(b.password); if (pe) return json(res, 400, { ok: false, msg: pe });
        const le = badLevel(b.gmlevel); if (le) return json(res, 400, { ok: false, msg: le });
        return json(res, 200, await createAccount(b.username, b.password, b.gmlevel));
      }
      if (act === 'gmlevel') {
        const le = badLevel(b.gmlevel); if (le) return json(res, 400, { ok: false, msg: le });
        return json(res, 200, await setGmLevel(b.username, b.gmlevel));
      }
      if (act === 'password') {
        const pe = badPass(b.password); if (pe) return json(res, 400, { ok: false, msg: pe });
        return json(res, 200, await setPassword(b.username, b.password));
      }
      if (act === 'delete') return json(res, 200, await deleteAccount(b.username));
      return json(res, 404, { ok: false, msg: 'Непознато действие.' });
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } catch (e) {
    json(res, 500, { ok: false, msg: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('Panel: http://localhost:' + PORT));
