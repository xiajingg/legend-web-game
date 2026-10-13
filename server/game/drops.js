'use strict';

/**
 * 掉落：品质权重（白蓝紫橙）+ 词条生成。
 * 地图难度越高，高品质权重越大。
 */

const crypto = require('node:crypto');
const {
  QUALITIES, SLOT_BASE, ITEM_NAMES, AFFIX_POOL, DROP_RATES, LAYER, layerScale, layerMonsterLevel,
} = require('../config');

const genId = () => crypto.randomBytes(6).toString('hex');
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 按地图难度加权抽取品质。
 * difficulty 每 +1，紫/橙权重各 ×1.6，白权重相应降低。
 */
function rollQuality(difficulty = 0) {
  const entries = Object.values(QUALITIES).map((q) => {
    let w = q.weight;
    if (q.key === 'purple' || q.key === 'orange') w *= Math.pow(1.6, difficulty);
    return [q, w];
  });
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [q, w] of entries) {
    r -= w;
    if (r <= 0) return q;
  }
  return QUALITIES.white;
}

/** 生成一条词条 */
function rollAffix(level) {
  const tpl = pick(AFFIX_POOL);
  // 词条数值随装备等级略增
  const scale = 1 + Math.max(0, level - 1) * 0.15;
  const raw = (tpl.min + Math.random() * (tpl.max - tpl.min)) * scale;
  const value = tpl.pct ? Math.round(raw * 1000) / 1000 : Math.round(raw);
  return { stat: tpl.stat, label: tpl.label, value };
}

/**
 * 生成一件装备。
 * @param {number} level 装备等级（≈ 怪物等级 ±1）
 * @param {number} difficulty 地图难度
 */
function rollEquipment(level, difficulty = 0) {
  const slot = pick(Object.keys(SLOT_BASE));
  const quality = rollQuality(difficulty);
  const base = SLOT_BASE[slot];
  const lv = Math.max(1, level);
  const mult = quality.mult;

  const attrs = {};
  if (base.atk !== undefined) attrs.atk = Math.round((base.atk + base.atkPerLevel * (lv - 1)) * mult);
  if (base.def !== undefined) attrs.def = Math.round((base.def + base.defPerLevel * (lv - 1)) * mult);
  if (base.hp !== undefined) attrs.maxHp = Math.round((base.hp + base.hpPerLevel * (lv - 1)) * mult);
  if (base.dodge !== undefined) attrs.dodge = Math.round((base.dodge + base.dodgePerLevel * (lv - 1)) * mult * 1000) / 1000;
  if (base.crit !== undefined) attrs.crit = Math.round((base.crit + base.critPerLevel * (lv - 1)) * mult * 1000) / 1000;

  // 词条：不重复属性
  const affixes = [];
  const used = new Set();
  for (let i = 0; i < quality.affixes; i++) {
    let a = rollAffix(lv);
    let guard = 0;
    while (used.has(a.stat) && guard++ < 10) a = rollAffix(lv);
    used.add(a.stat);
    affixes.push(a);
  }

  const namePool = ITEM_NAMES[slot];
  const tier = Math.min(namePool.length - 1, Math.floor((lv - 1) / 3));

  return {
    id: genId(),
    type: 'equipment',
    slot,
    name: namePool[tier],
    quality: quality.key,
    qualityName: quality.name,
    color: quality.color,
    level: lv,
    attrs,
    affixes,
  };
}

/**
 * 怪物死亡时生成掉落物列表。
 * @param {object} monsterTpl 怪物模板
 * @param {number} difficulty 地图基础难度（影响品质权重）
 * @param {number} layer 当前层数：金币按层数放大、装备等级随层数上浮、品质权重也随层数提升
 * @returns {Array} [{ type:'gold', amount } | { type:'potion', kind, count } | equipment]
 */
function rollDrops(monsterTpl, difficulty = 0, layer = 1) {
  const drops = [];
  const rewardMult = layerScale(layer, LAYER.reward);

  // 金币必掉（数量随层数放大）
  const [gMin, gMax] = monsterTpl.gold;
  drops.push({ type: 'gold', amount: Math.max(1, Math.round(randInt(gMin, gMax) * rewardMult)) });

  // 装备：等级随层数上浮，品质难度也随层数提升（但有上限，避免深层数永远只掉橙装）
  if (Math.random() < DROP_RATES.equipment) {
    const effLevel = layerMonsterLevel(monsterTpl.level, layer) + randInt(-1, 1);
    const lv = Math.max(1, effLevel);
    const effDifficulty = difficulty + Math.min(Math.max(0, layer - 1), LAYER.dropCap);
    drops.push(rollEquipment(lv, effDifficulty));
  }

  // 药水
  if (Math.random() < DROP_RATES.potion) {
    drops.push({
      id: genId(),
      type: 'potion',
      kind: Math.random() < 0.6 ? 'red' : 'blue',
      count: randInt(DROP_RATES.potionAmount[0], DROP_RATES.potionAmount[1]),
    });
  }

  return drops;
}

// rollAffix 也导出：合成时要给升阶后的装备补齐词条
module.exports = { rollDrops, rollEquipment, rollQuality, rollAffix, dropRewardMult };

/** 第 layer 层的经验 / 金币倍率（world 算经验时也要用） */
function dropRewardMult(layer) {
  return layerScale(layer, LAYER.reward);
}
