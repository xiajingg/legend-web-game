'use strict';

/**
 * 备货脚本：造三个专用测试账号，用来在浏览器里验证「无尽层数（闯关）」。
 *
 *   node scripts/seed-layer.js
 *
 *   layergate / 123456  站在第 4 层（魔王洞穴）的闯关门上，魔王【未】打 → 应被挡住
 *   layerpass / 123456  站在第 4 层的闯关门上，魔王【已】打 → 应进入第 5 层（新手村）
 *   layerf2   / 123456  站在第 2 层（草原）→ 验证层号随地图递增的显示
 *
 * 只动这三个测试账号的存档，不碰其他玩家。
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('../server/store');
const { expNext, MAP_BY_ID } = require('../server/config');

const PORT = process.env.PORT || 8099;
const ROOT = path.join(__dirname, '..');

const LAYER2 = 40; // 等级给高一点，免得测试途中被洞穴里的骷髅/魔王打死

/** 造一份"停在指定地图某坐标"的存档 */
function makeSave(username, mapId, x, y, bossCleared) {
  const save = store.newSave(username);
  const spawn = MAP_BY_ID[mapId].spawn;
  save.character.mapId = mapId;
  save.character.x = x;
  save.character.y = y;
  save.character.level = LAYER2;
  save.character.expNext = expNext(LAYER2);
  save.character.layer = 1;
  save.character.bossCleared = bossCleared;
  // 属性补齐到该等级
  const { baseStatsByLevel } = require('../server/config');
  const base = baseStatsByLevel(LAYER2);
  save.character.hp = base.maxHp;
  save.character.mp = base.maxMp;
  console.log(`  ${username.padEnd(10)} ${MAP_BY_ID[mapId].name} (${x},${y})  `
    + `Lv${LAYER2}  魔王已打=${bossCleared ? '是' : '否'}  (出生点 ${spawn.x},${spawn.y})`);
  return save;
}

const CASES = [
  ['layergate', 'cave', 30, 12, false],
  ['layerpass', 'cave', 30, 12, true],
  ['layerf2', 'grassland', 2, 13, false],
];

(async () => {
  await store.loadAccounts();
  console.log('注册账号 + 写入存档：');
  for (const [user, mapId, x, y, bossCleared] of CASES) {
    const res = await fetch(`http://localhost:${PORT}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password: '123456' }),
    });
    const data = await res.json();
    if (!data.ok) console.log(`  （${user} 账号已存在，继续覆盖存档）`);
    const save = makeSave(user, mapId, x, y, bossCleared);
    fs.writeFileSync(path.join(ROOT, 'data', 'saves', `${user}.json`), JSON.stringify(save, null, 2), 'utf8');
  }
  console.log('\n三个账号密码都是 123456，可以开始浏览器验证了');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
