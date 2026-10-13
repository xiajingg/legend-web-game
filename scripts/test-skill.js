'use strict';

/**
 * 主动技能「小火球」的离线测试：不启动 HTTP 服务，直接调 world.handleAction，
 * 所以完全不会干扰正在运行的 8099 实例。
 *
 *   node scripts/test-skill.js
 *
 * 覆盖：耗蓝、冷却、射程、伤害倍率、落点溅射、以及"不会把玩家拽去贴脸"。
 */

const path = require('node:path');
process.chdir(path.join(__dirname, '..'));

const assert = require('node:assert');
const store = require('../server/store');
const world = require('../server/game/world');
const { createMonster } = require('../server/game/entities');
const { SKILLS, baseStatsByLevel, expNext } = require('../server/config');

const U = 'SKILLTEST_' + Date.now();
const SK = SKILLS.fireball;
let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ✅', label); };

(async () => {
  await store.loadAccounts();

  const LEVEL = 10;
  const save = store.newSave(U);
  save.character.mapId = 'grassland';
  save.character.level = LEVEL;
  save.character.expNext = expNext(LEVEL);
  save.character.mp = 100;
  const base = baseStatsByLevel(LEVEL);
  save.character.hp = base.maxHp;

  const s = world.getOrCreateSession(U, save);
  s.refreshStats();
  s.ch.hp = s.stats.maxHp;
  s.ch.mp = 100;
  // 关掉命中/暴击的随机性，否则伤害断言会偶发失败
  s.stats.hit = 1;
  s.stats.crit = 0;

  const P = { x: 10, y: 10 };
  s.ch.x = P.x; s.ch.y = P.y;

  // 三只怪：主目标 / 主目标旁边的溅射目标 / 远处打不到
  const main = createMonster('boss', P.x + 3, P.y, P.x + 3, P.y, 1);
  const near = createMonster('boss', P.x + 3.8, P.y, P.x + 3, P.y, 1);
  const far = createMonster('slime', P.x + 20, P.y, P.x + 20, P.y, 1);
  for (const m of [main, near, far]) m.dodge = 0;
  s.monsters = [main, near, far];

  console.log(`技能：${SK.name}（${SK.hotkey}）耗蓝 ${SK.mpCost} 冷却 ${SK.cooldown}ms `
    + `射程 ${SK.range} 倍率 ${SK.damageMult} 溅射 r=${SK.splashRadius}×${SK.splashRatio}`);
  console.log(`角色 Lv${LEVEL}：攻击 ${s.stats.atk}，魔法 ${s.ch.mp}/${s.stats.maxMp}\n`);

  // ---------------------------------------------------------------- 1) 没目标
  console.log('【1】射程内没有怪');
  const savedMonsters = s.monsters;
  s.monsters = [];
  console.log('  执行:', JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'fireball' })));
  ok(s.ch.mp === 100, '打空时不扣蓝');
  ok(s.nextSkillAt === 0, '打空时不进冷却');
  s.monsters = savedMonsters;

  // ---------------------------------------------------------------- 2) 正常施放
  console.log('\n【2】正常施放');
  const mpBefore = s.ch.mp;
  const mainHpBefore = main.hp;
  const nearHpBefore = near.hp;
  const farHpBefore = far.hp;
  const r = world.handleAction(U, { type: 'castSkill', skill: 'fireball' });
  ok(r.ok === true, `施放成功 ${JSON.stringify(r)}`);
  ok(s.ch.mp === mpBefore - SK.mpCost, `扣蓝 ${SK.mpCost}（${mpBefore} → ${s.ch.mp}）`);
  ok(s.nextSkillAt > 0, `进入冷却（${SK.cooldown}ms）`);

  const mainDmg = mainHpBefore - main.hp;
  const nearDmg = nearHpBefore - near.hp;
  console.log(`   主目标受伤 ${mainDmg} / 溅射目标受伤 ${nearDmg} / 远处目标受伤 ${farHpBefore - far.hp}`);

  // 期望伤害 = 攻击 × 倍率 - 防御 / 2；伤害公式里还有 ±10% 的随机浮动，容差要放进去
  const rawMain = Math.max(1, s.stats.atk * SK.damageMult - main.def / 2);
  const loMain = Math.round(rawMain * 0.9) - 1;
  const hiMain = Math.round(rawMain * 1.1) + 1;
  ok(mainDmg >= loMain && mainDmg <= hiMain,
    `主目标伤害在 攻击×${SK.damageMult} - 防御/2 的 ±10% 内（${loMain}~${hiMain}，实测 ${mainDmg}）`);
  ok(mainDmg > s.stats.atk, `明显强于普通攻击（普攻约 ${s.stats.atk}，火球 ${mainDmg}）`);
  const rawNear = Math.max(1, s.stats.atk * SK.damageMult * SK.splashRatio - near.def / 2);
  ok(nearDmg > 0 && nearDmg < mainDmg, `旁边那只吃了溅射伤害 ${nearDmg}（小于主目标）`);
  ok(nearDmg >= Math.round(rawNear * 0.9) - 1 && nearDmg <= Math.round(rawNear * 1.1) + 1,
    `溅射伤害约为主目标的 ${SK.splashRatio * 100}%（实测 ${nearDmg}）`);
  ok(farHpBefore - far.hp === 0, '射程外的怪没被误伤');

  // 事件字段：前端靠这些字段播火球
  const evs = s.out.combat.filter((e) => e.skill === 'fireball');
  const evMain = evs.find((e) => e.targetId === main.id);
  ok(!!evMain, '发出了带 skill=fireball 的战斗事件（客户端据此播弹道）');
  ok(evMain.flightMs === SK.flightMs, `事件带 flightMs=${SK.flightMs}（前端据此延后命中表现）`);
  ok(evMain.ax === P.x && evMain.ay === P.y, '事件带施法者坐标（弹道起点）');
  const evNear = evs.find((e) => e.targetId === near.id);
  ok(!!evNear && evNear.splash === true, '溅射事件标记了 splash（前端不重复播弹道）');
  ok(evNear.ax === main.x && evNear.ay === main.y, '溅射的起点是落点（从炸开处算）');

  // 关键：不能把玩家拽去贴脸，否则远程技能就白做了
  ok(!s.attackTargetId, '施法不会设置攻击目标 → 玩家不会被自动拽上去贴脸（远程成立）');

  // ---------------------------------------------------------------- 3) 冷却
  console.log('\n【3】冷却拦截');
  const mpAfterCast = s.ch.mp;
  console.log('  执行:', JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'fireball' })));
  ok(s.ch.mp === mpAfterCast, '冷却期间再按：不扣蓝');
  ok(main.hp === mainHpBefore - mainDmg, '冷却期间再按：没有造成第二次伤害');

  s.nextSkillAt = Date.now() - 1; // 把冷却拨到过去，验证冷却结束后能再放
  console.log('  （把冷却拨到过去后）执行:',
    JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'fireball' })));
  ok(main.hp < mainHpBefore - mainDmg, '冷却结束后可以再次施放');
  ok(s.ch.mp < mpAfterCast, '并且正常扣蓝');

  // ---------------------------------------------------------------- 4) 蓝不够
  console.log('\n【4】魔法值不足');
  s.nextSkillAt = 0;
  s.ch.mp = SK.mpCost - 1;
  const hpBeforePoor = main.hp;
  console.log('  执行:', JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'fireball' })));
  ok(main.hp === hpBeforePoor, '蓝不够时不造成伤害');
  ok(s.ch.mp === SK.mpCost - 1, '蓝不够时不会把蓝扣成负数');
  ok(s.nextSkillAt === 0, '蓝不够时不进冷却');

  // ---------------------------------------------------------------- 5) 边界
  console.log('\n【5】边界');
  s.ch.mp = 100;
  console.log('  不存在的技能:', JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'meteor' })));
  s.ch.hp = 0;
  s.nextSkillAt = 0;
  console.log('  阵亡时施法:', JSON.stringify(world.handleAction(U, { type: 'castSkill', skill: 'fireball' })));
  ok(s.ch.mp === 100, '阵亡时施法不扣蓝');

  console.log(`\n全部通过：${pass} 项断言 ✅`);
  try { require('fs').rmSync(store.SAVES_DIR + `/${U}.json`, { force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
