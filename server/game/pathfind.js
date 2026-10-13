'use strict';

/**
 * A* 网格寻路 + 路径跟随。怪物与宠物共用。
 *
 * 为什么需要：之前的移动只有"朝目标直走 + 撞墙沿墙滑"（见 move.js），
 * 遇到 U 形障碍、凹角、或者需要绕远的地形就会一直贴着墙滑、永远到不了。
 * 玩家自己会绕，AI 不会，所以要给它一条能绕开障碍的路。
 *
 * 设计要点：
 *   - 判定能不能站，用的是**和移动完全一致的** circleHitsWall（半径 r 的圆能不能放下），
 *     保证"算出来的路真能走通"，不会出现走到一半卡住。
 *   - 斜向禁止穿墙角（两个正交邻格都必须能走），否则会贴着墙角"切"过去。
 *   - 有直线视野就直走，只在需要绕的时候才寻路 —— 开阔地是最常见的情况，这样最省。
 *   - 寻路限流（每单位最短间隔 + 全局预算），避免一群单位同一 tick 一起算。
 */

const { circleHitsWall } = require('./map');

// ------------------------------------------------------------------ 搜索预算

const BUDGET = { windowMs: 50, max: 4, stamps: [] };

/** 短窗口内限制 A* 次数：同一 tick 里 20 个单位同时要路径时不会卡住整个 tick */
function budgetOk(now) {
  const s = BUDGET.stamps;
  while (s.length && now - s[0] > BUDGET.windowMs) s.shift();
  if (s.length >= BUDGET.max) return false;
  s.push(now);
  return true;
}

// ------------------------------------------------------------------ 小顶堆

class MinHeap {
  constructor() { this.a = []; }

  get size() { return this.a.length; }

  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------------ 基础判定

/** 八方向：dx, dy, 代价（斜向 √2） */
const DIRS8 = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** 该格能不能站：以格子中心放一个半径 r 的圆，看会不会碰到墙 */
function walkable(map, gx, gy, r) {
  if (gx < 0 || gy < 0 || gx >= map.w || gy >= map.h) return false;
  return !circleHitsWall(map, gx + 0.5, gy + 0.5, r);
}

/** 目标格站不住时（比如玩家贴着墙站着），就近找一个能站的格子代替 */
function nearestWalkable(map, gx, gy, r, maxR = 6) {
  if (walkable(map, gx, gy, r)) return { gx, gy };
  for (let rr = 1; rr <= maxR; rr++) {
    for (let dy = -rr; dy <= rr; dy++) {
      for (let dx = -rr; dx <= rr; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
        if (walkable(map, gx + dx, gy + dy, r)) return { gx: gx + dx, gy: gy + dy };
      }
    }
  }
  return null;
}

/** 两点之间是否"直线可达"（沿线采样，没碰到墙就算通） */
function losClear(map, x0, y0, x1, y1, r, maxSamples = 40) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d < 1e-6) return true;
  const steps = Math.min(maxSamples, Math.max(1, Math.ceil(d / 0.25)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (circleHitsWall(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ A*

/**
 * 求一条从 (sx,sy) 到 (tx,ty) 的路（返回格子中心点数组，不含起点）。
 * 走不通（完全封死）返回 null。
 */
function findPath(map, sx, sy, tx, ty, r = 0.3, maxNodes = 1500) {
  const s = nearestWalkable(map, Math.floor(sx), Math.floor(sy), r);
  const g = nearestWalkable(map, Math.floor(tx), Math.floor(ty), r);
  if (!s || !g) return null;
  if (s.gx === g.gx && s.gy === g.gy) return null; // 同一格，不用找

  const W = map.w;
  const key = (x, y) => y * W + x;

  const open = new MinHeap();
  const gScore = new Map();
  const came = new Map();
  const closed = new Set();
  const startK = key(s.gx, s.gy);

  gScore.set(startK, 0);
  open.push({ k: startK, x: s.gx, y: s.gy, f: 0 });

  let visited = 0;
  while (open.size && visited++ < maxNodes) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);

    if (cur.x === g.gx && cur.y === g.gy) {
      const path = [];
      let k = cur.k;
      let guard = 0;
      while (k !== startK && guard++ < 5000) {
        path.push({ x: (k % W) + 0.5, y: Math.floor(k / W) + 0.5 });
        const pk = came.get(k);
        if (pk === undefined) break;
        k = pk;
      }
      path.reverse();
      return smooth(map, path, r);
    }

    const cg = gScore.has(cur.k) ? gScore.get(cur.k) : Infinity;
    for (const [dx, dy, cost] of DIRS8) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!walkable(map, nx, ny, r)) continue;
      // 斜向不许穿墙角：两侧的正交邻格都得能走，否则会从墙角"切"过去
      if (dx !== 0 && dy !== 0
        && (!walkable(map, cur.x + dx, cur.y, r) || !walkable(map, cur.x, cur.y + dy, r))) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = cg + cost;
      if (ng >= (gScore.has(nk) ? gScore.get(nk) : Infinity)) continue;
      gScore.set(nk, ng);
      came.set(nk, cur.k);
      open.push({ k: nk, x: nx, y: ny, f: ng + Math.hypot(nx - g.gx, ny - g.gy) });
    }
  }
  return null;
}

/** 拉直：能直着跳过去就跳过中间路点，避免贴着格子走出锯齿形 */
function smooth(map, path, r) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  let i = 0;
  let guard = 0;
  while (i < path.length - 1 && guard++ < 2000) {
    let j = path.length - 1;
    for (; j > i + 1; j--) {
      if (losClear(map, path[i].x, path[i].y, path[j].x, path[j].y, r)) break;
    }
    out.push(path[j]);
    i = j;
  }
  return out;
}

// ------------------------------------------------------------------ 路径跟随

/** 一个单位两次重算路径之间的最短间隔（ms） */
const REPATH_MS = 300;

/**
 * 朝 (tx,ty) 走一步：有直线视野就直走，否则沿 A* 路径绕过去。
 * 寻路状态直接挂在 unit._pf 上，调用方不用管。
 *
 * @returns {boolean} 是否真的移动了
 */
function moveToward(u, map, tx, ty, speed, radius, now) {
  const { resolveMove } = require('./move');
  const st = u._pf || (u._pf = { path: null, to: null, nextAt: 0, blocked: 0 });

  // 目标挪地方了 → 旧路径作废
  if (st.to && Math.hypot(st.to.x - tx, st.to.y - ty) > 1.5) {
    st.path = null;
    st.to = null;
  }

  // ---- 1) 直线能过去就直走（开阔地最常见，也最省）
  if (losClear(map, u.x, u.y, tx, ty, radius)) {
    st.path = null;
    st.to = null;
    const nx = resolveMove(map, u.x, u.y, tx - u.x, ty - u.y, speed, radius);
    if (nx) { u.x = nx.x; u.y = nx.y; return true; }
    return false;
  }

  // ---- 2) 需要绕：算一条路（限流 + 全局预算）
  if (!st.path || !st.path.length) {
    // 还没到重算时间，或预算用完了：先用原来的滑行顶一下，等下一次再算
    if (now < st.nextAt || !budgetOk(now)) {
      const nx = resolveMove(map, u.x, u.y, tx - u.x, ty - u.y, speed, radius);
      if (nx) { u.x = nx.x; u.y = nx.y; return true; }
      return false;
    }
    st.nextAt = now + REPATH_MS;
    st.path = findPath(map, u.x, u.y, tx, ty, radius);
    st.to = { x: tx, y: ty };
    if (!st.path) {
      // 完全走不通：退回滑行（至少还能沿墙动一动）
      const nx = resolveMove(map, u.x, u.y, tx - u.x, ty - u.y, speed, radius);
      if (nx) { u.x = nx.x; u.y = nx.y; return true; }
      return false;
    }
  }

  // ---- 3) 朝当前路点走；走到就换下一个
  while (st.path.length && Math.hypot(st.path[0].x - u.x, st.path[0].y - u.y) < 0.28) {
    st.path.shift();
  }
  if (!st.path.length) { st.path = null; return false; }

  const wp = st.path[0];
  const nx = resolveMove(map, u.x, u.y, wp.x - u.x, wp.y - u.y, speed, radius);
  if (!nx) {
    // 路点走不动（可能被临时挤住）：丢掉路径，下次重算
    st.path = null;
    st.nextAt = 0;
    return false;
  }
  u.x = nx.x;
  u.y = nx.y;
  return true;
}

/** 传送/切图后调用，清掉残留路径（否则会拿着旧地图的路点走） */
function clearPath(u) {
  if (u._pf) u._pf.path = null;
}

module.exports = { findPath, moveToward, clearPath, walkable, losClear, smooth };
