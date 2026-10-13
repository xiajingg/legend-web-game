'use strict';

/**
 * 移动/碰撞的离线测试：不启动 HTTP 服务，不干扰正在运行的 8099。
 *
 *   node scripts/test-move.js
 *
 * 覆盖：
 *   1) 全地图穷举——不存在"可站立但八个方向全走不动"的死点（这才是"卡住"的定义）
 *   2) 贴着墙斜着走能滑（单轴滑行），而不是硬生生停住
 *   3) 直着推墙不该横着漂移（滑行只剥分量，不引入玩家没按的方向）
 *   4) 斜向撞墙角会绕过去
 *   5) 随机走 2000 步：永远留在图内、且永远不卡进障碍
 *   6) 坐标卡进障碍时能自救挪出来
 *   7) 边界传送点可站立（回归：以前会被夹到 x=1 卡死，左侧回程门永远踩不到）
 *   8) 端到端：在草原从出生点一路向左走，能真的传回新手村（跑真实 tick）
 */

const path = require('node:path');
process.chdir(path.join(__dirname, '..'));

const assert = require('node:assert');
const { resolveMove, rescueIfStuck } = require('../server/game/move');
const { circleHitsWall } = require('../server/game/map');
const { TILE, MAPS } = require('../server/config');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ✅', label); };

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** 造一张测试地图：walls 传 [x, y] 数组 */
function makeMap(w, h, walls = []) {
  const tiles = [];
  for (let y = 0; y < h; y++) tiles.push(new Array(w).fill(TILE.EMPTY));
  for (const [x, y] of walls) tiles[y][x] = TILE.WALL;
  return { id: 'test', name: '测试', w, h, tiles, def: { portals: [], spawn: { x: 1, y: 1 } } };
}

// ================================================================ 1) 全地图死点穷举
const world = require('../server/game/world');
console.log('【1】全地图穷举：可站立的位置是否都能动');
for (const def of MAPS) {
  const map = world.MAPS_BUILT[def.id];
  const R = 0.3;
  const STEP = 0.2;

  // 先从出生点洪水填充，只检查"真的能走到"的格子 —— 避免把封闭小口袋里
  // 的位置误报成死点（那种格子玩家根本到不了）
  const seen = new Set();
  const q = [[Math.floor(def.spawn.x), Math.floor(def.spawn.y)]];
  seen.add(q[0][1] * map.w + q[0][0]);
  while (q.length) {
    const [cx, cy] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      if (map.tiles[ny][nx] === TILE.WALL) continue;
      const k = ny * map.w + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }

  const wedged = [];
  let standable = 0;
  for (let y = R; y <= map.h - R; y += STEP) {
    for (let x = R; x <= map.w - R; x += STEP) {
      if (!seen.has(Math.floor(y) * map.w + Math.floor(x))) continue;   // 到不了的格子跳过
      if (circleHitsWall(map, x, y, R)) continue;                        // 站不住的位置跳过
      standable++;
      let canMove = false;
      for (const [dx, dy] of DIRS) {
        if (resolveMove(map, x, y, dx, dy, 0.3, R)) { canMove = true; break; }
      }
      if (!canMove) wedged.push([+x.toFixed(2), +y.toFixed(2)]);
    }
  }
  console.log(`   ${def.name}：可站立采样点 ${standable}，死点 ${wedged.length}`);
  if (wedged.length) console.log('     死点示例:', wedged.slice(0, 5).map((p) => `(${p[0]},${p[1]})`).join(' '));
  ok(wedged.length === 0, `${def.name}：没有"站着但走不动"的死点`);
}

// ================================================================ 2) 贴墙滑行
console.log('\n【2】贴着墙斜着走：应该滑，不该停');
// 竖墙在 x=3 那一列（y 从 2 到 8），右侧留空
const vMap = makeMap(10, 10, [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 7], [3, 8]]);
// 站在墙左侧 (2.5, 5.5)，朝"右上"走 → x 被墙挡住，但 y 分量应该保住 → 向上滑
const slideUp = resolveMove(vMap, 2.5, 5.5, 1, -1, 0.3, 0.3);
console.log('   朝右上走 →', JSON.stringify(slideUp));
ok(slideUp && slideUp.y < 5.5, '斜向撞竖墙：纵向分量被保住（贴着墙往上滑）');
ok(slideUp && Math.abs(slideUp.x - 2.5) < 1e-9, '被挡住的那个分量没有被硬塞进去（没穿墙）');

// 横墙：y=3 那一行
const hMap = makeMap(10, 10, [[2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3]]);
// 站在墙下方 (5.5, 4.5)，朝"右上"走 → y 被挡，x 分量应该保住 → 向右滑
const slideRight = resolveMove(hMap, 5.5, 4.5, 1, -1, 0.3, 0.3);
console.log('   朝右上走 →', JSON.stringify(slideRight));
ok(slideRight && slideRight.x > 5.5, '斜向撞横墙：横向分量被保住（贴着墙往右滑）');

// ================================================================ 3) 直推墙不该横着漂
console.log('\n【3】直着推墙：不能自己横着漂（滑行只剥分量，不凭空加方向）');
const pushIn = resolveMove(vMap, 2.5, 5.5, 1, 0, 0.3, 0.3);
console.log('   朝正右推墙 →', JSON.stringify(pushIn));
ok(pushIn === null, '正对墙推：停住，不会被"滑"到上下（否则玩家会觉得人自己动了）');

const pushOut = resolveMove(vMap, 2.5, 5.5, -1, 0, 0.3, 0.3);
console.log('   朝正左（背离墙）→', JSON.stringify(pushOut));
ok(pushOut && pushOut.x < 2.5, '背离墙的方向照常能走');

// ================================================================ 4) 内凹角 & 凸角
console.log('\n【4】墙角行为');
// 内凹角：右 (4,3) 与上 (3,2) 都是墙，站在 (3.5,3.5)
const cMap = makeMap(10, 10, [[4, 3], [3, 2]]);
const intoCorner = resolveMove(cMap, 3.5, 3.5, 1, -1, 0.3, 0.3);
console.log('   朝右上撞内凹角 →', JSON.stringify(intoCorner));
ok(intoCorner === null, '撞内凹角：停住（这两个方向物理上就是被挡的，不该硬走）');
// 但绝不能"卡死"——其它方向必须还能走
const escapes = DIRS.filter(([dx, dy]) => resolveMove(cMap, 3.5, 3.5, dx, dy, 0.3, 0.3));
console.log('   还能走的方向数 →', escapes.length);
ok(escapes.length >= 4, '内凹角处仍有多条退路，不是死局');

// 凸角：斜着擦过墙角不该被"勾住"（圆心到墙角对角线 0.288×√2≈0.41 > 半径 0.3）
const bMap = makeMap(10, 10, [[3, 3]]);
const pastCorner = resolveMove(bMap, 3.5, 2.5, -1, 1, 0.3, 0.3);
console.log('   斜着擦过凸角 →', JSON.stringify(pastCorner));
ok(pastCorner !== null, '斜着擦过凸出的墙角：能顺畅过去，不会被勾住');

// ================================================================ 5) 随机暴走
console.log('\n【5】随机走 2000 步：不出图、不卡进障碍');
for (const def of MAPS) {
  const map = world.MAPS_BUILT[def.id];
  const R = 0.3;
  const pos = { x: def.spawn.x, y: def.spawn.y };
  let dir = [1, 0];
  let bad = null;
  for (let i = 0; i < 2000; i++) {
    if (i % 7 === 0) {
      const a = Math.random() * Math.PI * 2;
      dir = [Math.cos(a), Math.sin(a)];
    }
    const next = resolveMove(map, pos.x, pos.y, dir[0], dir[1], 0.3, R);
    if (!next) continue;
    pos.x = next.x;
    pos.y = next.y;
    if (pos.x < 0 || pos.y < 0 || pos.x > map.w || pos.y > map.h) { bad = ['出图', pos.x, pos.y]; break; }
    if (circleHitsWall(map, pos.x, pos.y, R)) { bad = ['卡进障碍', pos.x, pos.y]; break; }
  }
  console.log(`   ${def.name}：终点 (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
  ok(!bad, `${def.name}：2000 步随机走不会出图、也不会卡进障碍`);
}

// ================================================================ 6) 卡住自救
console.log('\n【6】坐标已经卡进障碍时能自救');
const stuckMap = makeMap(10, 10, [[5, 5], [4, 5], [6, 5], [5, 4], [5, 6]]);
const lost = { x: 5.5, y: 5.5 }; // 正好在墙格中心
ok(circleHitsWall(stuckMap, lost.x, lost.y, 0.3), '构造的坐标确实卡在墙里');
const moved = rescueIfStuck(stuckMap, lost, 0.3);
console.log('   挪到 →', `(${lost.x.toFixed(2)}, ${lost.y.toFixed(2)})`);
ok(moved && !circleHitsWall(stuckMap, lost.x, lost.y, 0.3), '自救后会落在能站的位置上');

// ================================================================ 7) 边界传送点可站立
console.log('\n【7】边界传送点：以前踩不到（被夹到 x=1），现在要能站上去');
for (const def of MAPS) {
  const map = world.MAPS_BUILT[def.id];
  const edgePortals = def.portals.filter((p) => p.x === 0 || p.y === 0 || p.x === def.w - 1 || p.y === def.h - 1);
  for (const p of edgePortals) {
    const px = p.x + 0.5, py = p.y + 0.5;
    console.log(`   ${def.name} 传送点 (${p.x},${p.y}) → 圆心 (${px},${py})`);
    ok(!circleHitsWall(map, px, py, 0.3), `${def.name} (${p.x},${p.y}) 传送点上可以站（不被判成墙）`);
    const r = resolveMove(map, p.x + 1.5, py, -1, 0, 0.3, 0.3);
    ok(!!r, `${def.name} 从右侧可以走进这个边界传送点（以前会被夹住走不动）`);
  }
}
// 所有传送点都应该能站
let allPortalOk = true;
for (const def of MAPS) {
  const map = world.MAPS_BUILT[def.id];
  for (const p of def.portals) {
    if (circleHitsWall(map, p.x + 0.5, p.y + 0.5, 0.3)) allPortalOk = false;
  }
}
ok(allPortalOk, '全部传送点（含边界上的）都可站立');

// ================================================================ 8) 端到端：向左走能传回上一张图
console.log('\n【8】端到端：草原出生点一路向左，应真的传回新手村（跑真实 tick）');
const store = require('../server/store');
const U = 'MOVETEST_' + Date.now();

(async () => {
  await store.loadAccounts();
  const save = store.newSave(U);
  save.character.mapId = 'grassland';
  // ★ 别写死坐标：地图尺寸/出生点在 config 里调过好几轮了，直接取配置
  const grassDef = MAPS.find((m) => m.id === 'grassland');
  save.character.x = grassDef.spawn.x;
  save.character.y = grassDef.spawn.y;
  save.character.level = 20;
  save.character.hp = 1000;
  const s = world.getOrCreateSession(U, save);
  s.refreshStats();
  s.ch.hp = s.stats.maxHp;

  s.map = world.MAPS_BUILT.grassland;
  s.monsters = [];            // 清掉怪，免得测试中途被打死
  ok(s.map.id === 'grassland', '起点在草原');

  world.startLoops();
  // 一路向左按（等价于一直发 move 意图）
  s.moveDir = [-1, 0];
  const t0 = Date.now();
  while (s.map.id === 'grassland' && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`   走了 ${((Date.now() - t0) / 1000).toFixed(1)}s 后到达 ${s.map.name}（${s.map.id}）`);
  ok(s.map.id === 'village', '向左走到边界传送点后成功传回新手村（边界不再卡人）');
  ok(!circleHitsWall(s.map, s.ch.x, s.ch.y, 0.3), '落点合法（没被塞进墙里）');

  console.log(`\n全部通过：${pass} 项断言 ✅`);
  try { require('fs').rmSync(store.SAVES_DIR + `/${U}.json`, { force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
