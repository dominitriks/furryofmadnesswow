// SRP6 for AzerothCore (WotLK 3.3.5a).
//
// The account table never stores a password - only `salt` and `verifier`. The
// verifier is g^x mod N, where x comes from the password. That is a one-way
// step, so the server can CHECK a password by recomputing the verifier, but can
// never read one back out.
//
// Doing this here rather than through the worldserver console (`account create`)
// matters for more than convenience: the console route means the plaintext
// password has to travel to wherever the console is, and the cloud queue kept a
// copy. Computing salt+verifier locally means the password never leaves the
// process that received it.
//
// Byte order is the trap. AzerothCore builds its bignums with SetBinary, which
// reads LITTLE-endian, while N is written as a big-endian hex string. Get one of
// those backwards and every verifier is wrong in a way that looks like "bad
// password" forever.

const crypto = require('crypto');

// The SRP6 group WoW 3.3.5a uses. Big-endian hex, exactly as the core spells it.
const N = BigInt('0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7');
const g = 7n;

function leToBigInt(buf) {
  let out = 0n;
  for (let i = buf.length - 1; i >= 0; i--) out = (out << 8n) | BigInt(buf[i]);
  return out;
}

function bigIntToLe(value, length) {
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const sha1 = (...parts) => {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};

// Account names and passwords are case-insensitive: the core uppercases both
// before hashing, so "Admin"/"ADMIN" must produce the same verifier.
const upper = (s) => String(s).toUpperCase();

/** verifier for a given salt. Same salt + same password => same verifier. */
function computeVerifier(username, password, salt) {
  const h1 = sha1(Buffer.from(`${upper(username)}:${upper(password)}`, 'utf8'));
  const h2 = sha1(salt, h1);
  const x = leToBigInt(h2);
  return bigIntToLe(modPow(g, x, N), 32);
}

/** Fresh credentials for a new account or a password change. */
function makeCredentials(username, password) {
  const salt = crypto.randomBytes(32);
  return { salt, verifier: computeVerifier(username, password, salt) };
}

/**
 * True when `password` is the one behind this salt/verifier pair.
 * timingSafeEqual, because a byte-by-byte compare leaks how much of a guess was
 * right to anyone who can measure the reply.
 */
function verifyPassword(username, password, salt, verifier) {
  const candidate = computeVerifier(username, password, salt);
  if (candidate.length !== verifier.length) return false;
  return crypto.timingSafeEqual(candidate, verifier);
}

module.exports = { computeVerifier, makeCredentials, verifyPassword };
