const crypto = require('crypto');

const COOKIE = 'monitor_sid';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertUsername(username) {
  if (typeof username !== 'string') {
    throw httpError(400, 'Benutzername fehlt');
  }
  const name = username.trim();
  if (name.length < 1 || name.length > 64 || /[\u0000-\u001F]/.test(name)) {
    throw httpError(400, 'Benutzername ungültig');
  }
  return name;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw httpError(400, 'Passwort muss mindestens 8 Zeichen haben');
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = {
  COOKIE,
  SESSION_MS,
  hashPassword,
  verifyPassword,
  hashToken,
  newToken,
  newSessionId,
  assertUsername,
  assertPassword,
  httpError,
  readCookie,
};
