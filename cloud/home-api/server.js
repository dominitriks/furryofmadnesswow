// Player-facing API for the AzerothCore server.
//
// The website (Vercel) cannot reach this machine directly - it is behind NAT on
// a dynamic address. So this listens on loopback only and Cloudflare's tunnel
// publishes it as wow-api.level8.bg, exactly the arrangement the MU server uses.
// Binding to 127.0.0.1 means the port stays unreachable even if a firewall rule
// is widened by mistake: the tunnel is the only door.
//
// What lives here and not in the cloud queue: anything a PLAYER does. Those need
// an answer now (a login cannot be queued), and they need the password, which
// must never travel to Supabase. Admin actions stay in the queue - they are rare,
// asynchronous, and want the audit trail.
//
// Config comes from .env - see .env.example. Never commit that file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { makeCredentials, verifyPassword } = require('./srp6');

// ── config ────────────────────────────────────────────────────────────────
function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = +(process.env.PORT || 8091);
const SITE_KEY = process.env.SITE_API_KEY;
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const DB_USER = process.env.DB_USER || 'acore';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PASS_FILE = process.env.DB_PASS_FILE
  || path.join(__dirname, '..', '..', 'setup', 'db-password.txt');
const REALM_ID = +(process.env.REALM_ID || 1);

if (!SITE_KEY || SITE_KEY.length < 24) {
  console.error('SITE_API_KEY missing or too short (needs 24+ chars). Copy .env.example to .env.');
  process.exit(1);
}
if (!TOKEN_SECRET || TOKEN_SECRET.length < 32) {
  console.error('TOKEN_SECRET missing or too short (needs 32+ chars).');
  process.exit(1);
}
const DB_PASS = fs.existsSync(DB_PASS_FILE)
  ? fs.readFileSync(DB_PASS_FILE, 'utf8').trim()
  : process.env.DB_PASS;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── database ──────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: DB_HOST, port: 3306, user: DB_USER, password: DB_PASS,
  waitForConnections: true, connectionLimit: 8, charset: 'utf8mb4',
});
// No default schema is set: auth and characters live in separate databases and
// the pool is shared, so every query names its table as db.table.

// ── throttling ────────────────────────────────────────────────────────────
// Password guessing is the only realistic attack on this surface, and the game
// ports are open to the internet, so a working account is worth guessing.
const attempts = new Map();
function throttled(key, limit, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > windowMs) {
    attempts.set(key, { first: now, n: 1 });
    return false;
  }
  rec.n++;
  return rec.n > limit;
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
}, 10 * 60 * 1000).unref();

// ── sessions ──────────────────────────────────────────────────────────────
// The signature mixes in the account's current verifier, so changing the
// password invalidates every existing token without needing a session table.
const b64 = (b) => Buffer.from(b).toString('base64url');

function signToken(accountId, verifier, ttlMs = 12 * 60 * 60 * 1000) {
  const body = b64(JSON.stringify({ id: accountId, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(body + '.' + verifier.toString('hex')).digest('base64url');
  return body + '.' + sig;
}

async function accountFromToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let claim;
  try { claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!claim || !claim.id || !claim.exp || claim.exp < Date.now()) return null;

  const rows = await pool.execute(
    'SELECT id, username, verifier, email, joindate, last_login, locked, mutetime FROM acore_auth.account WHERE id = ?',
    [claim.id]).then(([r]) => r);
  if (!rows.length) return null;

  const expected = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(body + '.' + rows[0].verifier.toString('hex')).digest('base64url');
  const a = Buffer.from(sig || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return rows[0];
}

// ── validation ────────────────────────────────────────────────────────────
// The client itself only ever sends these, and the account table is varchar(32)
// / the password is folded to uppercase before hashing.
const RE_USER = /^[A-Za-z0-9]{3,16}$/;
const RE_EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;
const okPassword = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 16
  && /^[\x21-\x7E]+$/.test(p);

// ── helpers ───────────────────────────────────────────────────────────────
async function accountExists(username) {
  const rows = await pool.execute(
    'SELECT id FROM acore_auth.account WHERE username = ?', [username.toUpperCase()])
    .then(([r]) => r);
  return rows.length ? rows[0].id : null;
}

async function charactersOf(accountId) {
  return pool.execute(
    `SELECT c.guid, c.name, c.race, c.class, c.gender, c.level, c.money, c.online,
            c.map, c.zone, c.totaltime, c.leveltime, c.at_login,
            g.name AS guild
       FROM acore_characters.characters c
       LEFT JOIN acore_characters.guild_member gm ON gm.guid = c.guid
       LEFT JOIN acore_characters.guild g ON g.guildid = gm.guildid
      WHERE c.account = ? AND c.deleteDate IS NULL
      ORDER BY c.level DESC, c.totaltime DESC`, [accountId]).then(([r]) => r);
}

// ── request plumbing ──────────────────────────────────────────────────────
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      // A player request is a few hundred bytes; anything larger is not one.
      if (data.length > 8192) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) =>
  (req.headers['cf-connecting-ip']
    || String(req.headers['x-forwarded-for'] || '').split(',')[0]
    || '').trim() || 'unknown';

// ── routes ────────────────────────────────────────────────────────────────
const routes = {
  'GET /api/status': async () => {
    const realm = await pool.execute(
      'SELECT name, address, port FROM acore_auth.realmlist WHERE id = ?', [REALM_ID])
      .then(([r]) => r[0] || null);
    const online = await pool.execute(
      `SELECT COUNT(*) n FROM acore_characters.characters c
         JOIN acore_auth.account a ON a.id = c.account
        WHERE c.online = 1 AND a.username NOT LIKE 'RNDBOT%' AND a.username NOT LIKE 'ADDCLASS%'`)
      .then(([r]) => r[0].n);
    const bots = await pool.execute(
      `SELECT COUNT(*) n FROM acore_characters.characters c
         JOIN acore_auth.account a ON a.id = c.account
        WHERE c.online = 1 AND (a.username LIKE 'RNDBOT%' OR a.username LIKE 'ADDCLASS%')`)
      .then(([r]) => r[0].n);
    const chars = await pool.execute(
      'SELECT COUNT(*) n FROM acore_characters.characters WHERE deleteDate IS NULL')
      .then(([r]) => r[0].n);
    return { ok: true, realm, playersOnline: online, botsOnline: bots, charactersTotal: chars };
  },

  'GET /api/rankings': async () => {
    const rows = await pool.execute(
      `SELECT c.name, c.race, c.class, c.gender, c.level, c.totaltime, g.name AS guild
         FROM acore_characters.characters c
         JOIN acore_auth.account a ON a.id = c.account
         LEFT JOIN acore_characters.guild_member gm ON gm.guid = c.guid
         LEFT JOIN acore_characters.guild g ON g.guildid = gm.guildid
        WHERE c.deleteDate IS NULL
          AND a.username NOT LIKE 'RNDBOT%' AND a.username NOT LIKE 'ADDCLASS%'
        ORDER BY c.level DESC, c.totaltime DESC
        LIMIT 50`).then(([r]) => r);
    return { ok: true, characters: rows };
  },

  'POST /api/auth/register': async (body, req) => {
    const ip = clientIp(req);
    if (throttled('reg:' + ip, 5, 60 * 60 * 1000)) {
      return { status: 429, body: { error: 'too many registrations from this address' } };
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = String(body.email || '').trim();

    if (!RE_USER.test(username)) return { status: 400, body: { error: 'invalid username' } };
    if (!okPassword(password)) return { status: 400, body: { error: 'invalid password' } };
    if (email && !RE_EMAIL.test(email)) return { status: 400, body: { error: 'invalid email' } };
    if (await accountExists(username)) {
      return { status: 409, body: { error: 'username already taken' } };
    }

    const { salt, verifier } = makeCredentials(username, password);
    // expansion 2 = WotLK. Without it the client is offered nothing to log into.
    const [result] = await pool.execute(
      `INSERT INTO acore_auth.account (username, salt, verifier, email, reg_mail, expansion, joindate)
       VALUES (?, ?, ?, ?, ?, 2, NOW())`,
      [username.toUpperCase(), salt, verifier, email, email]);

    log('registered', username, 'from', ip);
    return {
      status: 201,
      body: { ok: true, token: signToken(result.insertId, verifier), username: username.toUpperCase() },
    };
  },

  'POST /api/auth/login': async (body, req) => {
    const ip = clientIp(req);
    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    // Throttle by address AND by account: one stops a spray, the other stops a
    // distributed attack on a single known name.
    if (throttled('login:' + ip, 10, 15 * 60 * 1000)
        || throttled('acct:' + login.toUpperCase(), 10, 15 * 60 * 1000)) {
      return { status: 429, body: { error: 'too many failed attempts, try again later' } };
    }
    if (!RE_USER.test(login) || !password) {
      return { status: 401, body: { error: 'invalid credentials' } };
    }

    const rows = await pool.execute(
      'SELECT id, username, salt, verifier, locked FROM acore_auth.account WHERE username = ?',
      [login.toUpperCase()]).then(([r]) => r);
    if (!rows.length || !verifyPassword(login, password, rows[0].salt, rows[0].verifier)) {
      return { status: 401, body: { error: 'invalid credentials' } };
    }
    if (rows[0].locked) return { status: 403, body: { error: 'account is banned' } };

    const banned = await pool.execute(
      'SELECT 1 FROM acore_auth.account_banned WHERE id = ? AND active = 1 LIMIT 1', [rows[0].id])
      .then(([r]) => r.length > 0);
    if (banned) return { status: 403, body: { error: 'account is banned' } };

    return { body: { ok: true, token: signToken(rows[0].id, rows[0].verifier), username: rows[0].username } };
  },

  'GET /api/account': async (_body, _req, account) => {
    const gm = await pool.execute(
      'SELECT gmlevel FROM acore_auth.account_access WHERE id = ? AND (RealmID = ? OR RealmID = -1)',
      [account.id, REALM_ID]).then(([r]) => (r.length ? r[0].gmlevel : 0));
    const ban = await pool.execute(
      'SELECT bandate, unbandate, banreason FROM acore_auth.account_banned WHERE id = ? AND active = 1 LIMIT 1',
      [account.id]).then(([r]) => r[0] || null);
    return {
      body: {
        ok: true,
        account: {
          username: account.username,
          email: account.email || null,
          joined: account.joindate,
          lastLogin: account.last_login,
          gmLevel: gm,
          muted: Number(account.mutetime) > Date.now() / 1000,
          ban,
        },
        characters: await charactersOf(account.id),
      },
    };
  },

  'POST /api/account/password': async (body, req, account) => {
    if (throttled('pw:' + account.id, 5, 60 * 60 * 1000)) {
      return { status: 429, body: { error: 'too many attempts, try again later' } };
    }
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (!okPassword(next)) return { status: 400, body: { error: 'new password must be 6-16 characters' } };

    const row = await pool.execute(
      'SELECT salt, verifier FROM acore_auth.account WHERE id = ?', [account.id])
      .then(([r]) => r[0]);
    if (!verifyPassword(account.username, current, row.salt, row.verifier)) {
      return { status: 403, body: { error: 'current password is wrong' } };
    }

    const fresh = makeCredentials(account.username, next);
    await pool.execute(
      'UPDATE acore_auth.account SET salt = ?, verifier = ?, session_key = NULL WHERE id = ?',
      [fresh.salt, fresh.verifier, account.id]);
    log('password changed for', account.username, 'from', clientIp(req));
    // Every old token dies with the old verifier, so hand back a fresh one.
    return { body: { ok: true, token: signToken(account.id, fresh.verifier) } };
  },

  'POST /api/account/email': async (body, _req, account) => {
    const password = String(body.password || '');
    const email = String(body.email || '').trim();
    if (!RE_EMAIL.test(email)) return { status: 400, body: { error: 'invalid email' } };

    const row = await pool.execute(
      'SELECT salt, verifier FROM acore_auth.account WHERE id = ?', [account.id])
      .then(([r]) => r[0]);
    if (!verifyPassword(account.username, password, row.salt, row.verifier)) {
      return { status: 403, body: { error: 'current password is wrong' } };
    }
    await pool.execute('UPDATE acore_auth.account SET email = ?, reg_mail = ? WHERE id = ?',
      [email, email, account.id]);
    return { body: { ok: true } };
  },

  // Unstuck: put a character back at its own hearthstone. Only works while the
  // character is OFFLINE - worldserver keeps position in memory and writes it
  // out on logout, so moving a logged-in character in the database achieves
  // nothing except confusion when the save overwrites it.
  'POST /api/account/unstuck': async (body, req, account) => {
    const guid = Number(body.guid);
    if (!Number.isInteger(guid)) return { status: 400, body: { error: 'invalid character' } };
    if (throttled('unstuck:' + account.id, 6, 60 * 60 * 1000)) {
      return { status: 429, body: { error: 'unstuck used too often, try again later' } };
    }

    const ch = await pool.execute(
      'SELECT guid, name, online FROM acore_characters.characters WHERE guid = ? AND account = ? AND deleteDate IS NULL',
      [guid, account.id]).then(([r]) => r[0]);
    if (!ch) return { status: 404, body: { error: 'character not found on this account' } };
    if (ch.online) return { status: 409, body: { error: 'log the character out first' } };

    const home = await pool.execute(
      'SELECT mapId, zoneId, posX, posY, posZ FROM acore_characters.character_homebind WHERE guid = ?',
      [guid]).then(([r]) => r[0]);
    if (!home) return { status: 500, body: { error: 'this character has no home location' } };

    await pool.execute(
      `UPDATE acore_characters.characters
          SET map = ?, zone = ?, position_x = ?, position_y = ?, position_z = ?,
              orientation = 0, transguid = 0, taxi_path = ''
        WHERE guid = ?`,
      [home.mapId, home.zoneId, home.posX, home.posY, home.posZ, guid]);

    log('unstuck', ch.name, 'for', account.username, 'from', clientIp(req));
    return { body: { ok: true, character: ch.name } };
  },
};

const PUBLIC = new Set(['GET /api/status', 'GET /api/rankings',
  'POST /api/auth/register', 'POST /api/auth/login']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'not found' });

  // The site's shared key gates the whole surface. It is NOT identity - it only
  // says "this came from our website"; who the player is comes from the token.
  const given = req.headers['x-api-key'];
  const expected = SITE_KEY;
  if (typeof given !== 'string' || given.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return send(res, 401, { error: 'unauthorized' });
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};

    let account = null;
    if (!PUBLIC.has(key)) {
      const auth = String(req.headers.authorization || '');
      account = await accountFromToken(auth.startsWith('Bearer ') ? auth.slice(7) : null);
      if (!account) return send(res, 401, { error: 'not signed in' });
    }

    const out = await handler(body, req, account);
    if (out && out.body) return send(res, out.status || 200, out.body);
    return send(res, 200, out);
  } catch (e) {
    log('ERROR', key, e.message);
    // Never echo the database's own error text back to the internet.
    return send(res, 500, { error: 'server error' });
  }
});

// Loopback only: the Cloudflare tunnel is the single way in.
server.listen(PORT, '127.0.0.1', () => {
  log(`wow home api on 127.0.0.1:${PORT}`);
  log(`  realm ${REALM_ID}, db ${DB_USER}@${DB_HOST}`);
});
