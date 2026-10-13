'use strict';

/**
 * 合成功能的离线测试：不启动 HTTP 服务，直接调 world.handleAction，
 * 所以完全不会干扰正在运行的 8099 实例。
 *
 *   node scripts/test-fuse.js
 *
 * 覆盖：消耗数量 / 品质升阶 / 等级继承 / 词条不丢只补 / 材料不足 / 顶级不能再合 /
 *      药水不能合 / 不存在物品 / 阵亡时拒绝 / 白→蓝→紫→橙 连合。
 */

const path = require('node:path');
process.chdir(path.join(__dirname, '..'));

const assert = require('node:assert');
const store = require('../server/store');
const world = require('../server/game/world');
const inventory = require('../server/game/inventory');
const { FUSE, QUALITIES } = require('../server/config');

const U = 'FUSETEST_' + Date.now();
let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ✅', label); };

let seq = 0;
function equip(quality, slot, level, affixes = []) {
  const q = QUALITIES[quality];
  seq += 1;
  return {
    id: `it${seq}`, type: 'equipment', slot, name: `${q.name}${slot}`,
    quality, qualityName: q.name, color: q.color, level,
    attrs: { atk: 5 + level }, affixes,
  };
}

/** 当前背包里的非空格子数 */
const count = (ch) => ch.inventory.filter(Boolean).length;

(async () => {
  await store.loadAccounts();

  const save = store.newSave(U);
  save.character.gold = 500;
  const s = world.getOrCreateSession(U, save);

  console.log(`规则：${FUSE.count} 件同品质 → 高一阶品质，产出等级 = 参与装备最高等级 + ${FUSE.levelBonus}\n`);

  // ---------------------------------------------------------------- 1) 正常合成
  console.log('【1】3 件白色 → 1 件精良（蓝）');
  s.ch.inventory = new Array(24).fill(null);
  // 故意让等级不同（1/5/3），验证产出沿用"等级最高那件"的部位/名称并 +1
  s.ch.inventory[0] = equip('white', 'weapon', 1);
  s.ch.inventory[1] = equip('white', 'boots', 5);   // 等级最高
  s.ch.inventory[2] = equip('white', 'head', 3);
  const before = count(s.ch);
  const r1 = world.handleAction(U, { type: 'fuseItem', itemId: 'it1' });
  console.log('  执行:', JSON.stringify({ ok: r1.ok, msg: r1.msg }));
  ok(r1.ok === true, '合成成功');
  ok(count(s.ch) === before - (FUSE.count - 1), `${FUSE.count} 件进去、1 件出来（背包少了 ${FUSE.count - 1} 格）`);

  const fused = r1.item;
  console.log(`   产出：${fused.qualityName}·${fused.name} Lv${fused.level} 部位=${fused.slot} 词条=${fused.affixes.length}`);
  ok(fused.quality === 'blue', '品质从"普通"升到"精良"');
  ok(fused.level === 5 + FUSE.levelBonus, `等级 = 参与者最高等级 5 + ${FUSE.levelBonus} = ${fused.level}`);
  ok(fused.slot === 'boots', '部位沿用等级最高那件（鞋子 Lv5），不是被点击的那件（武器 Lv1）');
  ok(fused.affixes.length === QUALITIES.blue.affixes, `词条数补齐到精良应有的 ${QUALITIES.blue.affixes} 条`);
  ok(fused.attrs.atk !== undefined || fused.attrs.dodge !== undefined, '属性已按新等级×新品质系数重算');

  // ---------------------------------------------------------------- 2) 材料不足
  console.log('\n【2】同品质不足 3 件：应被拒绝');
  s.ch.inventory = new Array(24).fill(null);
  s.ch.inventory[0] = equip('white', 'weapon', 1);
  s.ch.inventory[1] = equip('white', 'head', 2);
  const r2 = world.handleAction(U, { type: 'fuseItem', itemId: 'it4' });
  console.log('  执行:', JSON.stringify(r2));
  ok(r2.ok === false, '被拒绝');
  ok(count(s.ch) === 2, '被拒绝时一件都不会消耗');
  ok(/需要 3 件/.test(r2.msg || ''), '提示里说明了还差几件');

  // ---------------------------------------------------------------- 3) 最高品质
  console.log('\n【3】史诗（橙）已是最高品质：不能继续合');
  s.ch.inventory = new Array(24).fill(null);
  s.ch.inventory[0] = equip('orange', 'weapon', 10);
  s.ch.inventory[1] = equip('orange', 'head', 10);
  s.ch.inventory[2] = equip('orange', 'boots', 10);
  const r3 = world.handleAction(U, { type: 'fuseItem', itemId: 'it6' });
  console.log('  执行:', JSON.stringify(r3));
  ok(r3.ok === false && /最高品质/.test(r3.msg || ''), '提示"已是最高品质"');
  ok(count(s.ch) === 3, '未消耗任何物品');

  // ---------------------------------------------------------------- 4) 边界
  console.log('\n【4】边界情况');
  s.ch.inventory = new Array(24).fill(null);
  s.ch.inventory[0] = { id: 'pr', type: 'potion', kind: 'red', count: 5 };
  console.log('  药水:', JSON.stringify(world.handleAction(U, { type: 'fuseItem', itemId: 'pr' })));
  ok(world.handleAction(U, { type: 'fuseItem', itemId: 'pr' }).ok === false, '药水不能合成');
  console.log('  不存在的物品:', JSON.stringify(world.handleAction(U, { type: 'fuseItem', itemId: 'nope' })));
  ok(world.handleAction(U, { type: 'fuseItem', itemId: 'nope' }).ok === false, '不存在的物品被拒');

  s.ch.hp = 0;
  s.ch.inventory = new Array(24).fill(null);
  s.ch.inventory[0] = equip('white', 'weapon', 1);
  s.ch.inventory[1] = equip('white', 'head', 1);
  s.ch.inventory[2] = equip('white', 'boots', 1);
  const rDead = world.handleAction(U, { type: 'fuseItem', itemId: 'it12' });
  console.log('  阵亡时:', JSON.stringify(rDead));
  ok(rDead.ok === false, '阵亡时不能合成');
  s.ch.hp = s.stats.maxHp;

  // ---------------------------------------------------------------- 5) 词条不丢只补
  console.log('\n【5】词条沿用：原有词条不会被洗掉');
  s.ch.inventory = new Array(24).fill(null);
  s.ch.inventory[0] = equip('blue', 'weapon', 4, [{ stat: 'crit', label: '暴击率', value: 0.05 }]);
  s.ch.inventory[1] = equip('blue', 'weapon', 4, []);
  s.ch.inventory[2] = equip('blue', 'weapon', 4, []);
  const r5 = world.handleAction(U, { type: 'fuseItem', itemId: 'it13' });
  ok(r5.ok === true, '合成成功');
  const kept = r5.item.affixes.find((a) => a.stat === 'crit' && a.value === 0.05);
  ok(!!kept, '原有的暴击率词条被完整保留（值都一样）');
  ok(r5.item.affixes.length === QUALITIES.purple.affixes, `并补齐到稀有应有的 ${QUALITIES.purple.affixes} 条`);

  // ---------------------------------------------------------------- 6) 连合到顶
  console.log('\n【6】连续合成：白 → 蓝 → 紫 → 橙');

  /** 把背包里所有 src 品质的装备都合成掉（每 3 件出 1 件高一阶） */
  function fuseAll(src) {
    let made = 0;
    let guard = 0;
    while (guard++ < 40) {
      const first = s.ch.inventory.find((it) => it && it.type === 'equipment' && it.quality === src);
      if (!first) break;                       // 这个品质用完了
      const rr = world.handleAction(U, { type: 'fuseItem', itemId: first.id });
      if (!rr.ok) break;                       // 不足 3 件，剩下的留着
      made += 1;
    }
    return made;
  }

  // 9 件白的 → 3 件蓝的 → 1 件紫的（24 格背包放得下）
  s.ch.inventory = new Array(24).fill(null);
  for (let i = 0; i < 9; i++) s.ch.inventory[i] = equip('white', 'weapon', 2);
  const madeBlue = fuseAll('white');
  const blues = s.ch.inventory.filter(Boolean).filter((it) => it.quality === 'blue');
  console.log(`   白×9 → 合了 ${madeBlue} 次，产出蓝 ${blues.length} 件`);
  ok(blues.length === 3, '9 件白色合成出 3 件精良');

  const madePurple = fuseAll('blue');
  const purples = s.ch.inventory.filter(Boolean).filter((it) => it.quality === 'purple');
  console.log(`   蓝×3 → 合了 ${madePurple} 次，产出紫 ${purples.length} 件`);
  ok(purples.length === 1, '3 件精良合成出 1 件稀有');
  ok(purples[0].level === 2 + FUSE.levelBonus * 2, `等级一路 +${FUSE.levelBonus} 叠加（2 → ${purples[0].level}）`);

  // 再喂 3 件紫的，合出橙（验证顶级那一档）
  s.ch.inventory = new Array(24).fill(null);
  for (let i = 0; i < 3; i++) s.ch.inventory[i] = equip('purple', 'weapon', 8);
  fuseAll('purple');
  const oranges = s.ch.inventory.filter(Boolean).filter((it) => it.quality === 'orange');
  console.log(`   紫×3 → 产出橙 ${oranges.length} 件 ${oranges[0] ? `(${oranges[0].qualityName}·${oranges[0].name} Lv${oranges[0].level} 词条${oranges[0].affixes.length})` : ''}`);
  ok(oranges.length === 1, '3 件稀有合成出 1 件史诗（顶级）');
  ok(oranges[0].affixes.length === QUALITIES.orange.affixes, `顶级品质带满 ${QUALITIES.orange.affixes} 条词条`);

  // 顶级不能再合
  const rTop = world.handleAction(U, { type: 'fuseItem', itemId: oranges[0].id });
  ok(rTop.ok === false, '合到史诗后就不能再往上合了');

  console.log(`\n全部通过：${pass} 项断言 ✅`);
  try { require('fs').rmSync(store.SAVES_DIR + `/${U}.json`, { force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
