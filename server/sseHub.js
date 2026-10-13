'use strict';

/**
 * SSE 连接管理。
 * 对外只暴露 send() / has() / close() / size()，将来若换成 WebSocket，
 * 只需重写本文件并保持相同接口，其余模块零改动。
 */

/** @type {Map<string, import('node:http').ServerResponse>} username -> res */
const clients = new Map();

/**
 * @param {string} username
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {() => void} [onDisconnect] 连接断开时的回调（用于让上层清掉残留操作状态）
 */
function add(username, req, res, onDisconnect) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', // no-transform 防止中间层压缩缓冲
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',                 // 防 Nginx 缓冲导致收不到
  });
  res.flushHeaders();
  res.write(': connected\n\n');                // 注释行，立即把流打通

  // 同一账号重复连接（比如开了两个标签页），踢掉旧连接
  if (clients.has(username)) {
    try { clients.get(username).end(); } catch (_) { /* 已断开 */ }
  }
  clients.set(username, res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; // close 与 error 可能都触发，只处理一次
    cleaned = true;
    // 只有"当前这条连接"的断开才算掉线；被新连接踢掉的旧连接不用管
    if (clients.get(username) === res) {
      clients.delete(username);
      if (onDisconnect) {
        try { onDisconnect(); } catch (e) { console.error('[sse] onDisconnect 异常:', e); }
      }
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup); // SSE 长连接断开时，响应侧同样能感知
  res.on('error', cleanup);
}

/**
 * 向某个玩家推一个事件。
 * @param {string} username
 * @param {string} event 事件名
 * @param {object} data  载荷
 */
function send(username, event, data) {
  const res = clients.get(username);
  if (!res || res.writableEnded) return false;
  try {
    // SSE 格式：event: xxx\ndata: {json}\n\n
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (_) {
    clients.delete(username);
    return false;
  }
}

function broadcast(event, data) {
  for (const u of clients.keys()) send(u, event, data);
}

function has(username) {
  return clients.has(username);
}

function close(username) {
  const res = clients.get(username);
  if (res) {
    try { res.end(); } catch (_) { /* 已断开 */ }
    clients.delete(username);
  }
}

function closeAll() {
  for (const res of clients.values()) {
    try { res.end(); } catch (_) { /* 已断开 */ }
  }
  clients.clear();
}

module.exports = { add, send, broadcast, has, close, closeAll, size: () => clients.size };
