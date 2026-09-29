// Login protection (browser username/password prompt).
// Users are set in Render → Environment as APP_USERS, for example:
//   APP_USERS = sahil:StrongPass1,ramesh:AnotherPass2
// The username is recorded against every change in the audit log.
// This is a starting point; proper user accounts with roles come in a later module.

const crypto = require('crypto');

function loadUsers() {
  const raw = process.env.APP_USERS || '';
  const users = new Map();
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim().toLowerCase();
    const pass = pair.slice(i + 1).trim();
    if (name && pass) users.set(name, pass);
  }
  return users;
}

const USERS = loadUsers();

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireLogin(req, res, next) {
  if (req.path === '/healthz') return next();

  if (USERS.size === 0) {
    return res
      .status(503)
      .send('Login is not configured. Add APP_USERS in Render → Environment (e.g. sahil:YourPassword).');
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      const name = decoded.slice(0, i).trim().toLowerCase();
      const pass = decoded.slice(i + 1);
      const expected = USERS.get(name);
      if (expected && safeEqual(pass, expected)) {
        req.user = name;
        return next();
      }
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="RK Warehouse", charset="UTF-8"');
  return res.status(401).send('Sign in required.');
}

module.exports = { requireLogin };
