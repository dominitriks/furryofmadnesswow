// Proves the SRP6 implementation matches what the live server accepts, WITHOUT
// putting a single password in this repo - it is public.
//
//   npm run test:srp6
//
// Two halves:
//   1. Self-consistency, no database, no secrets. Catches every byte-order and
//      case-folding mistake.
//   2. A live cross-check against acore_auth. The positive case needs a real
//      password, so it is read from setup\CREDENTIALS.txt (gitignored) and
//      skipped when that file is absent. The negative case always runs: a wrong
//      password must fail against a REAL salt/verifier pair, which is what
//      proves the check is doing work rather than returning true.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { verifyPassword, makeCredentials, computeVerifier } = require('./srp6');

const SETUP = path.join(__dirname, '..', '..', 'setup');
let ok = true;
const check = (name, pass) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
};

// ── 1. self-consistency ───────────────────────────────────────────────────
console.log('self-consistency:');
{
  const { salt, verifier } = makeCredentials('TestUser', 'hunter2');
  check('correct password verifies', verifyPassword('TestUser', 'hunter2', salt, verifier));
  check('wrong password rejected', !verifyPassword('TestUser', 'hunter3', salt, verifier));
  check('username case ignored', verifyPassword('testuser', 'hunter2', salt, verifier));
  check('password case ignored', verifyPassword('TestUser', 'HUNTER2', salt, verifier));
  check('wrong username rejected', !verifyPassword('OtherUser', 'hunter2', salt, verifier));
  check('same salt is deterministic', computeVerifier('TestUser', 'hunter2', salt).equals(verifier));
  check('fresh salt each time',
    !makeCredentials('TestUser', 'hunter2').salt.equals(salt));
  check('verifier is 32 bytes', verifier.length === 32);
}

// ── 2. live cross-check ───────────────────────────────────────────────────
(async () => {
  console.log('\nagainst acore_auth:');
  let conn;
  try {
    conn = await mysql.createConnection({
      host: '127.0.0.1',
      user: 'acore',
      password: fs.readFileSync(path.join(SETUP, 'db-password.txt'), 'utf8').trim(),
      database: 'acore_auth',
      connectTimeout: 5000,
    });
  } catch (e) {
    console.log('  skipped - database unreachable:', e.message);
    process.exit(ok ? 0 : 1);
  }

  const [rows] = await conn.execute(
    "SELECT username, salt, verifier FROM account WHERE username NOT LIKE 'RNDBOT%' AND username NOT LIKE 'ADDCLASS%' LIMIT 1");
  if (!rows.length) {
    console.log('  skipped - no real accounts in the database');
  } else {
    const r = rows[0];
    // Always runs: a random string must not verify against real credentials.
    check(`wrong password rejected for a real account (${r.username})`,
      !verifyPassword(r.username, 'nope-' + Math.random(), r.salt, r.verifier));

    // Positive case, only when the local credentials file is there.
    const credFile = path.join(SETUP, 'CREDENTIALS.txt');
    if (fs.existsSync(credFile)) {
      const text = fs.readFileSync(credFile, 'utf8');
      const [, known] = text.match(
        new RegExp(`username:\\s*${r.username}\\s*\\n\\s*password:\\s*(\\S+)`, 'i')) || [];
      if (known) {
        check(`documented password verifies (${r.username})`,
          verifyPassword(r.username, known, r.salt, r.verifier));
      } else {
        console.log(`  skipped - CREDENTIALS.txt has no entry for ${r.username}`);
      }
    } else {
      console.log('  skipped positive check - setup\\CREDENTIALS.txt not on this machine');
    }
  }

  await conn.end();
  console.log(ok ? '\nSRP6 OK' : '\nSRP6 FAILED');
  process.exit(ok ? 0 : 1);
})();
