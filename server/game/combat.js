'use strict';

/**
 * 数值公式。全部在这里，客户端不参与任何数值计算（服务端权威）。
 */

const { MAX_LEVEL, expNext, baseStatsByLevel, PLAYER_BASE, LAYER, layerScale } = require('../config');

const rand = (min, max) => min + Math.random() * (max - min);

/**
 * 计算一次攻击的结果。
 * @param {object} atk 攻击方 { atk, crit, critDmg, hit }
 * @param {object} def 防守方 { def, dodge }
 */
function computeDamage(atk, def) {
  const hitChance = Math.max(0.5, Math.min(1, (atk.hit ?? 0.95) - (def.dodge ?? 0)));
  if (Math.random() * 100 >= hitChance * 100) {
    return { dmg: 0, crit: false, miss: true };
  }
  const base = Math.max(1, atk.atk - (def.def || 0) / 2);
  const varied = base * rand(0.9, 1.1);
  const crit = Math.random() < (atk.crit || 0);
  const final = crit ? varied * (atk.critDmg || 1.5) : varied;
  return { dmg: Math.max(1, Math.round(final)), crit, miss: false };
}

/** 把经验加到角色上，返回升级结果（可能连升多级） */
function gainExp(ch, amount) {
  ch.exp += amount;
  let leveled = false;
  while (ch.level < MAX_LEVEL && ch.exp >= ch.expNext) {
    ch.exp -= ch.expNext;
    ch.level += 1;
    leveled = true;
    // 升级后上限提高，并把新增的上限补满血量（爽感）
    const before = baseStatsByLevel(ch.level - 1);
    const after = baseStatsByLevel(ch.level);
    ch.hp += after.maxHp - before.maxHp;
    ch.mp += after.maxMp - before.maxMp;
    // ★ 必须在循环内更新阈值，否则连升时会一直用旧（低）阈值，导致一次喂经验直接满级
    ch.expNext = expNext(ch.level);
  }
  if (ch.level >= MAX_LEVEL) {
    ch.expNext = 0;
    ch.exp = Math.min(ch.exp, 0);
  } else {
    ch.expNext = expNext(ch.level);
  }
  return leveled;
}

/**
 * 玩家最终属性 = 等级基础属性 + 已装备装备属性 + 词条。
 * 装备数据来自 inventory.calcEquipmentBonus，这里只做合并与封顶。
 */
function playerStats(ch, equipBonus) {
  const base = baseStatsByLevel(ch.level);
  const b = equipBonus || {};
  return {
    maxHp: base.maxHp + (b.maxHp || 0),
    maxMp: base.maxMp + (b.maxMp || 0),
    atk: base.atk + (b.atk || 0),
    def: base.def + (b.def || 0),
    crit: Math.min(0.75, base.crit + (b.crit || 0)),
    critDmg: base.critDmg,
    hit: Math.min(1, base.hit + (b.hit || 0)),
    dodge: Math.min(0.5, base.dodge + (b.dodge || 0)),
    // 攻速：每件装备的 haste 减少冷却，最低 250ms
    attackCooldown: Math.max(250, PLAYER_BASE.attackCooldown - (b.haste || 0)),
  };
}

/**
 * 怪物属性。
 * @param {object} tpl 怪物模板
 * @param {number} layer 当前层数（第 1 层 = 原始数值，每层按 LAYER 的成长率叠加）
 */
function monsterStats(tpl, layer = 1) {
  return {
    maxHp: Math.round(tpl.hp * layerScale(layer, LAYER.hp)),
    atk: Math.round(tpl.atk * layerScale(layer, LAYER.atk)),
    def: Math.round(tpl.def * layerScale(layer, LAYER.def)),
    crit: 0.05,
    critDmg: 1.5,
    hit: 0.9,
    dodge: 0.02,
  };
}

module.exports = { computeDamage, gainExp, playerStats, monsterStats, rand };
