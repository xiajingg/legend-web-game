'use strict';

/**
 * 离线自检：无尽闯关（每张地图 = 一层，循环加强）。
 *
 *   node scripts/test-layer.js
 *
 * 覆盖三件事：
 *   1. 层号折算：第 N 层 ↔ 第 N+地图数 层 是不是同一张地图
 *   2. 数值成长：怪物血量/攻击/防御/等级、金币、经验 是否随循环次数正确放大
 *   3. 闯关门：没打魔王时挡住、打完魔王后放行并进入下一层（跑真实 tick，不是纯算数）
 *
 * 全程只用一个专用测试账号，不碰其他玩家的存档。
 */

const assert = require('node:assert');
const {
  MAPS, LAYER, layerScale, layerMonsterLevel, floorNo, FLOORS_PER_CYCLE, MONSTERS,
} = require('../server/config');
const { monsterStats } = require('../server/game/combat');
const { rollDrops, dropRewardMult } = require('../server/game/drops');

const USER = 'layertest_' + Date.now();
let pass = 0;
const ok = (cond, label) => {
  assert.ok(cond, label);
  pass++;
  console.log('  ✅', label);
};

console.log(`地图数 = ${MAPS.length}（= 一个循环的层数），BOSS 每 ${FLOORS_PER_CYCLE} 层出现一次\n`);

// ---------------------------------------------------------------- 1) 层号折算
console.log('【1】层号折算：第 N 层与第 N+地图数 层是同一张地图');
for (let i = 0; i < MAPS.length; i++) {
  const f1 = floorNo(1, MAPS[i].id);
  const f2 = floorNo(2, MAPS[i].id);
  console.log(`   ${MAPS[i].name.padEnd(6)} → 第 ${f1} 层 / 第 ${f2} 层`);
  ok(f2 === f1 + MAPS.length, `${MAPS[i].name}：第 ${f1} 层与第 ${f2} 层是同一张地图`);
}
ok(floorNo(1, 'village') === 1, '第 1 层是新手村');
ok(floorNo(1, 'cave') === MAPS.length, `第 ${MAPS.length} 层是魔王洞穴（BOSS 层）`);
ok(floorNo(2, 'village') === MAPS.length + 1, `第 ${MAPS.length + 1} 层回到新手村`);

// ---------------------------------------------------------------- 2) 数值成长
console.log('\n【2】数值成长（以魔王为例）');
const boss = MONSTERS.boss;
const rows = [1, 2, 3, 5, 10].map((L) => {
  const st = monsterStats(boss, L);
  return {
    层: floorNo(L, 'cave'),
    hp: st.maxHp,
    atk: st.atk,
    def: st.def,
    等级: layerMonsterLevel(boss.level, L),
    金币倍率: dropRewardMult(L).toFixed(2),
  };
});
console.table(rows);

const s1 = monsterStats(boss, 1);
ok(s1.maxHp === boss.hp && s1.atk === boss.atk && s1.def === boss.def, '第 1 层数值 = 原始模板数值（不放大）');

const s2 = monsterStats(boss, 2);
ok(s2.maxHp === Math.round(boss.hp * (1 + LAYER.hp)), `第 2 层血量 = 原始 × ${1 + LAYER.hp}`);
ok(s2.atk === Math.round(boss.atk * (1 + LAYER.atk)), `第 2 层攻击 = 原始 × ${1 + LAYER.atk}`);
ok(s2.def === Math.round(boss.def * (1 + LAYER.def)), `第 2 层防御 = 原始 × ${1 + LAYER.def}`);

const s3 = monsterStats(boss, 3);
ok(s3.maxHp === Math.round(boss.hp * (1 + LAYER.hp * 2)), '成长是加法（每层累加），不是复利');
ok(layerScale(1, LAYER.hp) === 1, '第 1 层系数恒为 1');
ok(dropRewardMult(1) === 1, '第 1 层奖励倍率为 1');

// 所有怪物类型都要跟着长大
let allGrow = true;
for (const key of Object.keys(MONSTERS)) {
  const a = monsterStats(MONSTERS[key], 1);
  const b = monsterStats(MONSTERS[key], 4);
  if (!(b.maxHp > a.maxHp && b.atk > a.atk)) allGrow = false;
}
ok(allGrow, '所有怪物类型（含小怪与 BOSS）都会随层数变强');

// 掉落：金币更多、装备等级更高
const goldOf = (layer) => {
  let sum = 0;
  for (let i = 0; i < 400; i++) {
    for (const d of rollDrops(boss, 3, layer)) if (d.type === 'gold') sum += d.amount;
  }
  return sum / 400;
};
const g1 = goldOf(1), g6 = goldOf(6);
console.log(`   金币均值：第 1 层 ${g1.toFixed(1)} → 第 6 层 ${g6.toFixed(1)}（×${(g6 / g1).toFixed(2)}）`);
ok(g6 > g1 * 2, '深层数金币明显更多');

let maxDropLevel = 0;
for (let i = 0; i < 2000; i++) {
  for (const d of rollDrops(boss, 3, 3)) {
    if (d.type === 'equipment') maxDropLevel = Math.max(maxDropLevel, d.level);
  }
}
ok(maxDropLevel > boss.level + 2, `第 3 层掉落装备等级会超过 BOSS 模板等级（实测最高 Lv${maxDropLevel}）`);

// ---------------------------------------------------------------- 3) 闯关门（跑真实 tick）
console.log('\n【3】闯关门：先打魔王才能进下一层');
const store = require('../server/store');
const world = require('../server/game/world');

(async () => {
  await store.loadAccounts();
  const save = store.newSave(USER);
  save.character.mapId = 'cave';
  save.character.x = 2;
  save.character.y = 12;
  save.character.level = 20;
  save.character.expNext = require('../server/config').expNext(20);

  const s = world.getOrCreateSession(USER, save);
  s.refreshStats();
  s.ch.hp = s.stats.maxHp;
  s.ch.mp = s.stats.maxMp;

  ok(s.ch.layer === 1 && floorNo(s.ch.layer, s.map.id) === MAPS.length,
    `初始在第 ${MAPS.length} 层（魔王洞穴），循环 1`);

  // 把角色直接放到闯关门上，跑真实 tick 看会不会被放行
  const portal = s.map.def.portals.find((p) => p.nextLayer);
  ok(!!portal, `闯关传送门已存在（x=${portal && portal.x}, y=${portal && portal.y}）`);

  // 拦截 SSE 推送：world 每帧会把消息队列发出去并清空，
  // 直接读 s.out.messages 会因为时序不稳定而读不到，所以在这里抓推送内容。
  const sse = require('../server/sseHub');
  const pushed = [];
  const origSend = sse.send;
  sse.send = (user, event, data) => {
    pushed.push({ user, event, data });
    try { return origSend.call(sse, user, event, data); } catch (_) { return undefined; }
  };

  world.startLoops();
  const tickOnce = () => new Promise((r) => setTimeout(r, 250));

  s.ch.x = portal.x;
  s.ch.y = portal.y;
  await tickOnce();
  ok(s.ch.layer === 1, '魔王未死时踩门：不会进入下一层（正确挡住）');
  const hint = pushed
    .filter((p) => p.event === 'message')
    .flatMap((p) => p.data.items || [])
    .find((m) => m.text.includes('魔王'));
  ok(!!hint, `并给出了提示：「${hint ? hint.text : '(缺失)'}」`);

  // 打穿魔王 → 再踩门
  s.ch.bossCleared = true;
  s.ch.x = portal.x;
  s.ch.y = portal.y;
  pushed.length = 0;
  await tickOnce();
  ok(s.ch.layer === 2, '魔王已死后踩门：进入循环 2');
  ok(s.map.id === 'village', `被送回第一张图（${s.map.name}）`);
  ok(floorNo(s.ch.layer, s.map.id) === MAPS.length + 1,
    `层号连续递增到第 ${MAPS.length + 1} 层，而不是重新从第 1 层开始`);
  ok(s.ch.bossCleared === false, '新循环的魔王标记已重置（下一层还得重新打魔王）');

  const enterMsg = pushed
    .filter((p) => p.event === 'message')
    .flatMap((p) => p.data.items || [])
    .find((m) => m.text.includes('进入第'));
  ok(!!enterMsg, `进入下一层时有明确提示：「${enterMsg ? enterMsg.text : '(缺失)'}」`);

  sse.send = origSend;

  const m0 = s.monsters.find((m) => m.type === 'slime');
  const baseSlime = monsterStats(MONSTERS.slime, 1);
  ok(m0 && m0.maxHp === Math.round(MONSTERS.slime.hp * (1 + LAYER.hp)),
    `新循环里的怪已是加强版（史莱姆 ${baseSlime.maxHp} → ${m0 && m0.maxHp} 血）`);

  console.log(`\n全部通过：${pass} 项断言 ✅`);
  console.log('（已清理测试账号）');
  try { require('fs').rmSync(store.SAVES_DIR + `/${USER}.json`, { force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
