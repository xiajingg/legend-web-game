'use strict';

/**
 * 地图：逻辑上是正交 tile 网格（碰撞/AI 都简单），渲染时才投影成菱形（见 render/iso.js）。
 */

const { TILE } = require('../config');

/** 确定性随机（LCG），保证每次启动地图形状一致 */
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 从 (sx,sy) 出发的四连通洪水填充，返回可达性布尔网格 */
function floodFill(tiles, w, h, sx, sy) {
  const seen = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  seen[sy * w + sx] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = ny * w + nx;
      if (seen[i]) continue;
      if (tiles[ny][nx] === TILE.WALL) continue;
      seen[i] = 1;
      stack.push([nx, ny]);
    }
  }
  return seen;
}

/** 沿 L 形路径挖通（先走 x 再走 y），保证关键点可达 */
function carvePath(tiles, w, h, from, to) {
  let { x, y } = from;
  const stepX = to.x > x ? 1 : -1;
  while (x !== to.x) {
    x += stepX;
    if (tiles[y][x] === TILE.WALL) tiles[y][x] = TILE.EMPTY;
  }
  const stepY = to.y > y ? 1 : -1;
  while (y !== to.y) {
    y += stepY;
    if (tiles[y][x] === TILE.WALL) tiles[y][x] = TILE.EMPTY;
  }
}

/**
 * 构建一张地图实例（含 tiles 网格与运行时实体容器）。
 * @param {object} def config.js 中的地图定义
 */
function buildMap(def) {
  const { w, h } = def;
  const rng = makeRng(hashString(def.id));

  // 1) 全空地，四周一圈墙
  const tiles = [];
  for (let y = 0; y < h; y++) {
    const row = new Array(w).fill(TILE.EMPTY);
    if (y === 0 || y === h - 1) row.fill(TILE.WALL);
    else { row[0] = TILE.WALL; row[w - 1] = TILE.WALL; }
    tiles.push(row);
  }

  // 2) 随机撒障碍（避开出生点、传送点、刷怪点）
  const protectedCells = new Set();
  const protectAround = (x, y, r = 2) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) protectedCells.add(`${x + dx},${y + dy}`);
    }
  };
  protectAround(def.spawn.x, def.spawn.y, 2);
  for (const p of def.portals) protectAround(p.x, p.y, 1);
  for (const ms of def.monsterSpawns) protectAround(ms.x, ms.y, 2);

  // 2a) 结构化障碍：成块的"建筑残骸"，比纯随机撒点更像一张有人工痕迹的地图。
  //     形状是相对坐标的小模板，随机挑一个、随机放一个位置。
  //     密度由 def.clusterDensity 控制（每 tile 摊到多少个块），不填就用默认。
  const SHAPES = [
    [[0, 0], [1, 0], [0, 1], [1, 1]],                 // 2×2 方块（小屋残垣）
    [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]],         // L 形
    [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]],         // 凹形（能藏人的凹槽）
    [[0, 0], [1, 0], [2, 0], [3, 0]],                 // 横墙段
    [[0, 0], [0, 1], [0, 2], [0, 3]],                 // 竖墙段
    [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],         // 十字
    [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]], // 围一圈的"房间"
  ];
  const clusterCount = Math.round(def.w * def.h * (def.clusterDensity ?? 0.006));
  for (let i = 0; i < clusterCount; i++) {
    const sh = SHAPES[Math.floor(rng() * SHAPES.length)];
    const ox = 2 + Math.floor(rng() * Math.max(1, def.w - 6));
    const oy = 2 + Math.floor(rng() * Math.max(1, def.h - 6));
    for (const [dx, dy] of sh) {
      const x = ox + dx;
      const y = oy + dy;
      if (x <= 1 || y <= 1 || x >= def.w - 2 || y >= def.h - 2) continue;
      if (protectedCells.has(`${x},${y}`)) continue;
      tiles[y][x] = TILE.WALL;
    }
  }

  // 2b) 随机撒碎块，填补细节（原有的行为）
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (protectedCells.has(`${x},${y}`)) continue;
      if (tiles[y][x] === TILE.WALL) continue; // 已被结构块占据的不重复处理
      if (rng() < def.obstacleDensity) tiles[y][x] = TILE.WALL;
    }
  }

  // 3) 连通性保障：所有关键点必须从出生点可达
  const targets = [
    ...def.portals.map((p) => ({ x: p.x, y: p.y })),
    ...def.monsterSpawns.map((m) => ({ x: m.x, y: m.y })),
  ];
  for (const t of targets) {
    let seen = floodFill(tiles, w, h, def.spawn.x, def.spawn.y);
    if (!seen[t.y * w + t.x]) {
      carvePath(tiles, w, h, def.spawn, t);
      seen = floodFill(tiles, w, h, def.spawn.x, def.spawn.y);
    }
  }

  // 4) 标出传送点
  for (const p of def.portals) tiles[p.y][p.x] = TILE.PORTAL;

  return {
    id: def.id,
    name: def.name,
    w, h,
    tiles,
    def,
  };
}

/** 某格是否可走（可走 = 非墙；传送点可走） */
function isWalkable(map, x, y) {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  if (gx < 0 || gy < 0 || gx >= map.w || gy >= map.h) return false;
  return map.tiles[gy][gx] !== TILE.WALL;
}

/** 圆形碰撞检测：以 (x,y) 为圆心、r 为半径的圆是否碰到墙 */
function circleHitsWall(map, x, y, r) {
  const minX = Math.floor(x - r), maxX = Math.floor(x + r);
  const minY = Math.floor(y - r), maxY = Math.floor(y + r);
  for (let gy = minY; gy <= maxY; gy++) {
    for (let gx = minX; gx <= maxX; gx++) {
      if (gx < 0 || gy < 0 || gx >= map.w || gy >= map.h) return true;
      if (map.tiles[gy][gx] !== TILE.WALL) continue;
      // 圆 vs 轴对齐方格 的最近距离判定
      const nx = Math.max(gx, Math.min(x, gx + 1));
      const ny = Math.max(gy, Math.min(y, gy + 1));
      const dx = x - nx, dy = y - ny;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

/** 找到玩家脚下的传送点定义，没有则返回 null */
function portalAt(map, x, y) {
  const gx = Math.floor(x), gy = Math.floor(y);
  if (gx < 0 || gy < 0 || gx >= map.w || gy >= map.h) return null;
  if (map.tiles[gy][gx] !== TILE.PORTAL) return null;
  return map.def.portals.find((p) => p.x === gx && p.y === gy) || null;
}

module.exports = { buildMap, isWalkable, circleHitsWall, portalAt };
