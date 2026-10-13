'use strict';

/**
 * HTTP 路由：静态文件 + REST 接口 + SSE 长连接。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const auth = require('./auth');
const store = require('./store');
const sse = require('./sseHub');
const world = require('./game/world');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ 静态文件

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 防目录穿越
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 开发期：改完刷新即生效
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ------------------------------------------------------------------ 路由

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // ---- 静态资源
  if (!p.startsWith('/api/')) {
    return serveStatic(req, res, p);
  }

  // ---- 注册 / 登录
  if (p === '/api/register' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const r = await auth.register(String(username || ''), String(password || ''));
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const r = await auth.login(String(username || ''), String(password || ''));
    return sendJson(res, r.ok ? 200 : 401, r);
  }

  // ---- 排行榜（无需登录）
  if (p === '/api/leaderboard') {
    const top = Number(url.searchParams.get('top') || 20);
    return sendJson(res, 200, { ok: true, list: await store.leaderboard(top) });
  }

  // ---- 以下接口需要 token
  // 注意：request body 只能读一次，所以 POST 先读 body 再取 token
  const body = req.method === 'POST' ? await readBody(req) : null;
  const token = url.searchParams.get('token') || (body && body.token);
  const who = auth.verify(token);

  if (p === '/api/stream') {
    if (!who) { res.writeHead(401); return res.end('unauthorized'); }
    const save = await store.loadSave(who.username);
    const s = world.getOrCreateSession(who.username, save);
    // 传 onDisconnect：连接一断就停掉残留操作，避免"人走了角色还在跑"
    sse.add(who.username, req, res, () => world.handleDisconnect(who.username));
    sse.send(who.username, 'init', world.buildInit(s));
    return undefined;
  }

  if (p === '/api/profile') {
    if (!who) return sendJson(res, 401, { ok: false, msg: '未登录或登录已过期' });
    const save = await store.loadSave(who.username);
    return sendJson(res, 200, { ok: true, username: who.username, save });
  }

  if (p === '/api/action' && req.method === 'POST') {
    if (!who) return sendJson(res, 401, { ok: false, msg: '未登录或登录已过期' });
    const r = world.handleAction(who.username, body || {});
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  return sendJson(res, 404, { ok: false, msg: '接口不存在' });
}

module.exports = { route };
