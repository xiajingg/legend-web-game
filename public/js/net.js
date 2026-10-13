'use strict';

/**
 * SSE 封装：服务端 → 客户端（EventSource，浏览器自带断线重连）
 * POST    ：客户端 → 服务端（只发意图，且只在状态变化时发）
 */

let es = null;

const handlers = new Map();

export function on(event, fn) {
  handlers.set(event, fn);
}

function emit(event, data) {
  const fn = handlers.get(event);
  if (fn) fn(data);
}

/** 建立 SSE 长连接 */
export function connect(token) {
  if (es) es.close();
  es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

  es.onopen = () => emit('open');
  es.onerror = () => emit('error'); // EventSource 会自动重连，这里只做提示

  for (const ev of ['init', 'state', 'combat', 'loot', 'levelup', 'inventory', 'message', 'map', 'revive']) {
    es.addEventListener(ev, (e) => {
      try {
        emit(ev, JSON.parse(e.data));
      } catch (err) {
        console.warn('[net] 解析事件失败', ev, err);
      }
    });
  }
  return es;
}

export function close() {
  if (es) { es.close(); es = null; }
}

/** 发送一个操作意图。只在状态变化时调用，不要每帧调。 */
export async function send(action) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...action, token: getToken() }),
    });
    const data = await res.json();
    if (!data.ok && data.msg) emit('error', data);
    return data;
  } catch (err) {
    console.warn('[net] 发送失败', action.type, err);
    return { ok: false };
  }
}

let _token = null;
export function setToken(t) { _token = t; }
export function getToken() { return _token; }

export async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
