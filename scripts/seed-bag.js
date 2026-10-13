'use strict';

/**
 * 备货脚本：给测试账号塞几件指定的背包物品，用于验证「合成 / 装备对比」。
 *
 *   node scripts/seed-bag.js [用户名]      # 默认 selltest
 *
 * ★ 换一个新用户名很重要：服务端的会话在浏览器关闭后还会保留 5 分钟，
 *   期间再登录会复用内存里的旧会话，刚写进去的存档读不到。
 * 只动这个测试账号的存档，不碰其他玩家（尤其是 xiajing）。
 *
 * 备货思路：合成需要「3 件同品质」，所以每种品质都给够 3 件以上，
 * 可以直接在浏览器里连点验证 白→蓝→紫→橙 四档合成；
 * 另外身上穿一件紫武，用来验证背包装备与身上装备的对比提示。
 */

const fs = require('node:fs');
const path = require('node:path');

const USER = process.argv[2] || 'selltest';
const PASS = '123456';
const PORT = process.env.PORT || 8099;
const ROOT = path.join(__dirname, '..');
const SAVE_FILE = path.join(ROOT, 'data', 'saves', `${USER}.json`);

const START_GOLD = 500;

function equip(id, slot, name, quality, qualityName, color, level, attrs = {}, affixes = []) {
  return { id, type: 'equipment', slot, name, quality, qualityName, color, level, attrs, affixes };
}

// 3 白 + 3 蓝 + 3 紫 + 3 橙：每一档都够合一次
const SEED_ITEMS = [
  equip('w1', 'weapon', '木剑', 'white', '普通', '#d8d8d8', 1, { atk: 5 }),
  equip('w2', 'head', '皮帽', 'white', '普通', '#d8d8d8', 2, { def: 2 }),
  equip('w3', 'boots', '布靴', 'white', '普通', '#d8d8d8', 3, { dodge: 0.01 }),

  equip('b1', 'weapon', '铁剑', 'blue', '精良', '#4fa3ff', 4, { atk: 12 }, [
    { stat: 'crit', label: '暴击率', value: 0.02 },
  ]),
  equip('b2', 'armor', '皮甲', 'blue', '精良', '#4fa3ff', 5, { maxHp: 20, def: 5 }, [
    { stat: 'def', label: '防御', value: 3 },
  ]),
  equip('b3', 'accessory', '铜戒', 'blue', '精良', '#4fa3ff', 6, { maxHp: 15 }, [
    { stat: 'hit', label: '命中', value: 0.02 },
  ]),

  equip('p1', 'weapon', '精铁长剑', 'purple', '稀有', '#c061ff', 7, { atk: 22 }, [
    { stat: 'crit', label: '暴击率', value: 0.03 },
  ]),
  equip('p2', 'armor', '锁子甲', 'purple', '稀有', '#c061ff', 8, { maxHp: 40, def: 10 }, [
    { stat: 'def', label: '防御', value: 5 }, { stat: 'dodge', label: '闪避', value: 0.01 },
  ]),
  equip('p3', 'head', '铁盔', 'purple', '稀有', '#c061ff', 9, { def: 12, maxHp: 30 }, [
    { stat: 'maxHp', label: '生命', value: 20 },
  ]),

  equip('o1', 'weapon', '寒光剑', 'orange', '史诗', '#ffa03c', 10, { atk: 34 }, [
    { stat: 'crit', label: '暴击率', value: 0.04 },
  ]),
  equip('o2', 'armor', '龙鳞甲', 'orange', '史诗', '#ffa03c', 11, { maxHp: 70, def: 18 }, [
    { stat: 'def', label: '防御', value: 9 }, { stat: 'dodge', label: '闪避', value: 0.02 },
  ]),
  equip('o3', 'boots', '疾风靴', 'orange', '史诗', '#ffa03c', 12, { dodge: 0.03, maxHp: 25 }, [
    { stat: 'haste', label: '攻击间隔', value: 60 },
  ]),

  { id: 'pot_r', type: 'potion', kind: 'red', count: 7 },
];

async function ensureAccount() {
  const res = await fetch(`http://localhost:${PORT}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const data = await res.json();
  console.log(`注册 ${USER}: ${data.ok ? '成功' : '已存在/' + (data.msg || '')}`);
}

function seedSave() {
  let save;
  if (fs.existsSync(SAVE_FILE)) {
    save = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  } else {
    save = require('../server/store').newSave(USER);
    console.log(`存档不存在，已生成初始存档: ${SAVE_FILE}`);
  }
  save.character.gold = START_GOLD;
  save.character.inventory = new Array(24).fill(null);
  SEED_ITEMS.forEach((it, i) => { save.character.inventory[i] = it; });
  // 身上穿一件紫色武器：用来验证"背包装备 vs 身上已穿"的对比提示
  // （注意这件是单独造的、不在背包里，否则同一个 id 会同时出现在两处）
  save.character.equipment = {
    weapon: equip('eq_w', 'weapon', '青锋剑', 'purple', '稀有', '#c061ff', 6, { atk: 18 }, [
      { stat: 'crit', label: '暴击率', value: 0.02 },
    ]),
    head: null, armor: null, boots: null, accessory: null,
  };
  fs.writeFileSync(SAVE_FILE, JSON.stringify(save, null, 2), 'utf8');
  console.log(`已写入 ${SAVE_FILE}`);
  console.log(`  金币 ${START_GOLD}，背包前 ${SEED_ITEMS.length} 格已备货：白×3 蓝×3 紫×3 橙×3 + 红药水×7`);
  console.log('  每一档都有 3 件，可以连点验证 白→蓝→紫→橙');
}

(async () => {
  await ensureAccount();
  seedSave();
  console.log(`\n下一步：用浏览器登录 ${USER} / ${PASS}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
