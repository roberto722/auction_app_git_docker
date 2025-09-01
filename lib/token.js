// lib/token.js
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function sign(payload, secret, { expSec = 60*60*24*30 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expSec })).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verify(token, secret) {
  const [h,b,s] = String(token).split('.');
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(s))) throw new Error('bad-signature');
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now()/1000);
  if (payload.exp && payload.exp < now) throw new Error('expired');
  return payload;
}
module.exports = { sign, verify };
