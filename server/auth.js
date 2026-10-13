'use strict';

/**
 * 账号：scrypt 慢哈希存密码 + HMAC-SHA256 自包含 token（无状态，免 session 存储）。
 */

const crypto = require('node:crypto');
const store = require('./store');

const SECRET = process.env.GAME_SECRET || 'change-me-dev-secret';
if (!process.env.GAME_SECRET) {
  console.warn(
    '[auth] 未设置 GAME_SECRET，正在使用内置开发密钥。' +
      '部署到公网前请设置环境变量 GAME_SECRET（任意长随机串），否则任何人都能伪造登录 token。'
  );
}
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7 天

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

// ------------------------------------------------------------------ 密码

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(pw, saltHex, hashHex) {
  try {
    const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    // timingSafeEqual 要求长度一致，长度不符说明被篡改
    if (h.length !== expected.length) return false;
    return crypto.timingSafeEqual(h, expected);
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------------ Token

function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${s}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const p = token.slice(0, idx);
  const s = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (s.length !== expect.length) return null;
  // 定长比较，防时序侧信道
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function issueToken(username) {
  return sign({ uid: username, username, exp: Date.now() + TOKEN_TTL });
}

// ------------------------------------------------------------------ 业务

async function register(username, password) {
  if (!USERNAME_RE.test(username)) {
    return { ok: false, msg: '用户名需为 3-16 位字母、数字或下划线' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { ok: false, msg: '密码至少 6 位' };
  }
  if (store.getAccount(username)) {
    return { ok: false, msg: '用户名已被占用' };
  }
  const { salt, hash } = hashPassword(password);
  await store.putAccount(username, salt, hash);
  await store.saveSave(username, store.newSave(username));
  return { ok: true, token: issueToken(username), username };
}

async function login(username, password) {
  const acc = store.getAccount(username);
  // 统一失败文案，不泄露是"用户名不存在"还是"密码错误"
  if (!acc || !verifyPassword(password, acc.salt, acc.pwHash)) {
    return { ok: false, msg: '用户名或密码错误' };
  }
  return { ok: true, token: issueToken(username), username };
}

module.exports = { register, login, verify, issueToken, sign };
