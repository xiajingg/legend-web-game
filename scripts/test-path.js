'use strict';

/**
 * 寻路（A*）的离线测试：不启动 HTTP 服务，不干扰正在运行的 8099。
 *
 *   node scripts/test-path.js
 *
 * 核心是证明一件事：**以前会被墙卡住的地方，现在能绕过去**。
 * 所以除了单测 findPath，还会真的"跑 tick"把一个单位从起点走到终点，
 * 并拿"只滑行不寻路"的旧行为做对照。
 */

const path = require('node:path');
process.chdir(path.join(__dirname, '..'));

const assert = require('node:assert');
const { findPath, moveToward, walkable, losClear, clearPath } = require('../server/game/pathfind');
const { resolveMove } = require('../server/game/move');
const { circleHitsWall } = require('../server/game/map');
const { TILE, MAPS } = require('../server/config');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ✅', label); };

const R = 0.3;

/** 造测试地图：walls 传 [x,y] */
function makeMap(w, h, walls = []) {
  const tiles = [];
  for (let y = 0; y < h; y++) tiles.push(new Array(w).fill(TILE.EMPTY));
  for (const [x, y] of walls) tiles[y][x] = TILE.WALL;
  return { id: 'test', name: '测试', w, h, tiles, def: { portals: [], spawn: { x: 1, y: 1 } } };
}

// 一堵竖墙（x=7），只有最下面三行是通的 → 想过去必须绕到底下
const U_MAP = makeMap(15, 11, [
  [7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7],
]);
const START = { x: 3.5, y: 3.5 };
const GOAL = { x: 11.5, y: 3.5 };

// ================================================================ 1) 直线被挡
console.log('【1】直线被墙挡住：必须绕');
ok(!losClear(U_MAP, START.x, START.y, GOAL.x, GOAL.y, R), '起点到终点没有直线视野（确实要绕）');
const p1 = findPath(U_MAP, START.x, START.y, GOAL.x, GOAL.y, R);
console.log('   路径点数:', p1 ? p1.length : 'null');
ok(p1 && p1.length > 0, 'A* 找到了一条路');
const detour = p1 && p1.some((w) => w.y >= 8.5);
ok(detour, '路径确实绕到了墙下方的通道（y ≥ 8.5）');

// ================================================================ 2) 路径可用
console.log('\n【2】算出来的路每一步都得能走（不能走到一半卡住）');
ok(p1.every((w) => !circleHitsWall(U_MAP, w.x, w.y, R)), '所有路点本身都能站');
let losAllOk = true;
for (let i = 1; i < p1.length; i++) {
  if (!losClear(U_MAP, p1[i - 1].x, p1[i - 1].y, p1[i].x, p1[i].y, R)) losAllOk = false;
}
ok(losAllOk, '相邻路点之间都是直线可达（平滑后不会穿墙）');
ok(!circleHitsWall(U_MAP, p1[p1.length - 1].x, p1[p1.length - 1].y, R), '终点路点可站');

// ================================================================ 3) 真走一遍（对比旧行为）
console.log('\n【3】真的走一遍：新（带寻路） vs 旧（只滑行）');

/** 模拟若干 tick 走向目标，返回 {到达, 用掉tick, 最终距离} */
function walk(map, usePath, maxTicks = 400) {
  const u = { x: START.x, y: START.y, _pf: { path: null, to: null, nextAt: 0 } };
  let now = 0;
  for (let t = 0; t < maxTicks; t++) {
    now += 100;
    const d0 = Math.hypot(GOAL.x - u.x, GOAL.y - u.y);
    if (d0 < 0.5) return { arrived: true, ticks: t, dist: d0 };
    if (usePath) {
      moveToward(u, map, GOAL.x, GOAL.y, 0.22, R, now);
    } else {
      // 旧行为：直走 + 沿墙滑，没有寻路
      const nx = resolveMove(map, u.x, u.y, GOAL.x - u.x, GOAL.y - u.y, 0.22, R);
      if (nx) { u.x = nx.x; u.y = nx.y; }
    }
  }
  return { arrived: false, ticks: maxTicks, dist: Math.hypot(GOAL.x - u.x, GOAL.y - u.y) };
}

const old = walk(U_MAP, false);
const neu = walk(U_MAP, true);
console.log(`   旧（只滑行）：到达=${old.arrived} 用了${old.ticks}tick 最终距离=${old.dist.toFixed(2)}`);
console.log(`   新（带寻路）：到达=${neu.arrived} 用了${neu.ticks}tick 最终距离=${neu.dist.toFixed(2)}`);
ok(!old.arrived, '旧行为确实走不到（被墙卡住，这正是要修的问题）');
ok(neu.arrived, '新行为成功绕过障碍到达终点');
ok(old.dist - neu.dist > 3,
  `差距明显（旧卡在 ${old.dist.toFixed(2)}，新走到 ${neu.dist.toFixed(2)}，改善 ${(old.dist - neu.dist).toFixed(2)}）`);

// ================================================================ 4) 开阔地不该走弯路
console.log('\n【4】开阔地：有直线视野就应该直走，不浪费寻路');
const openMap = makeMap(15, 11, []);
ok(losClear(openMap, START.x, START.y, GOAL.x, GOAL.y, R), '空地图上直线可达');
const u2 = { x: START.x, y: START.y, _pf: { path: null, to: null, nextAt: 0 } };
moveToward(u2, openMap, GOAL.x, GOAL.y, 0.3, R, 1000);
console.log('   走一步后:', `(${u2.x.toFixed(2)}, ${u2.y.toFixed(2)})`);
ok(u2.x > START.x && Math.abs(u2.y - START.y) < 0.05, '笔直朝目标走，没有绕');
ok(u2._pf.path === null, '没有生成路径（省掉了寻路开销）');

// ================================================================ 5) 完全封死
console.log('\n【5】目标被完全封死：应返回 null，且不崩');
const sealed = makeMap(11, 11, [
  // 把 (5,5) 围成一圈
  [4, 4], [5, 4], [6, 4], [4, 5], [6, 5], [4, 6], [5, 6], [6, 6],
]);
const p2 = findPath(sealed, 1.5, 1.5, 5.5, 5.5, R);
console.log('   findPath 结果:', p2 === null ? 'null' : `${p2.length} 点`);
ok(p2 === null, '找不到路时返回 null（而不是给一条穿墙的路）');
const u3 = { x: 1.5, y: 1.5, _pf: { path: null, to: null, nextAt: 0 } };
let moved3 = false;
for (let i = 0; i < 5; i++) moved3 = moveToward(u3, sealed, 5.5, 5.5, 0.22, R, 1000 + i * 100) || moved3;
ok(true, '走不通时 moveToward 不抛异常（退回滑行）');

// ================================================================ 6) 真实地图抽样
console.log('\n【6】真实地图抽样：随机起点/终点，路径必须可用');
const world = require('../server/game/world');
let tried = 0;
let solved = 0;
let badPath = 0;
for (const def of MAPS) {
  const map = world.MAPS_BUILT[def.id];
  for (let i = 0; i < 60; i++) {
    const a = { x: 1 + Math.random() * (map.w - 2), y: 1 + Math.random() * (map.h - 2) };
    const b = { x: 1 + Math.random() * (map.w - 2), y: 1 + Math.random() * (map.h - 2) };
    if (circleHitsWall(map, a.x, a.y, R) || circleHitsWall(map, b.x, b.y, R)) continue;
    tried += 1;
    const p = findPath(map, a.x, a.y, b.x, b.y, R);
    if (!p) continue;
    solved += 1;
    for (let k = 0; k < p.length; k++) {
      if (circleHitsWall(map, p[k].x, p[k].y, R)) { badPath += 1; break; }
      if (k > 0 && !losClear(map, p[k - 1].x, p[k - 1].y, p[k].x, p[k].y, R)) { badPath += 1; break; }
    }
  }
  console.log(`   ${def.name}：抽样 ${tried} 组，算出路径 ${solved} 条，有问题的 ${badPath} 条`);
}
ok(tried > 100, `抽样数量足够（${tried} 组）`);
ok(badPath === 0, '算出来的路径没有一条会撞墙或走不通');

// ================================================================ 7) 斜向不穿墙角
console.log('\n【7】斜向禁止穿墙角');
// 两个墙格斜相邻，中间那条对角缝不能钻
const corner = makeMap(8, 8, [[3, 3], [4, 4]]);
ok(!walkable(corner, 3, 3, R) && !walkable(corner, 4, 4, R), '两个墙格确实站不了');
// 从 (3,4) 到 (4,3) 的对角移动，两侧正交邻格 (4,4) 和 (3,3) 都是墙 → 必须被禁止
const p4 = findPath(corner, 3.5, 4.5, 4.5, 3.5, R);
if (p4) {
  const cuts = p4.some((w, i) => {
    if (i === 0) return false;
    const prev = p4[i - 1];
    return Math.abs(w.x - prev.x) > 0.9 && Math.abs(w.y - prev.y) > 0.9;
  });
  ok(!cuts, '路径里没有"贴着墙角斜切"的那一步');
} else {
  ok(true, '这条路直接被判为不可达（也没让它穿墙角）');
}

// ================================================================ 8) clearPath
console.log('\n【8】清路径（切图/复活时要清，否则会拿旧地图的坐标当路点）');
const u5 = { x: 1.5, y: 1.5, _pf: { path: [{ x: 2, y: 2 }], to: null, nextAt: 0 } };
clearPath(u5);
ok(u5._pf.path === null, 'clearPath 后路径被清空');

console.log(`\n全部通过：${pass} 项断言 ✅`);
process.exit(0);
