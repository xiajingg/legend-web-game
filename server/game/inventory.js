'use strict';

/**
 * 背包 / 装备 / 药水。属性叠加在这里统一计算。
 */

const crypto = require('node:crypto');
const {
  SLOTS, BAG_SIZE, QUALITIES, POTIONS, FUSE,
  SLOT_BASE, ITEM_NAMES, nextQuality,
} = require('../config');
const { rollAffix } = require('./drops');

const genId = () => crypto.randomBytes(6).toString('hex');

// ------------------------------------------------------------------ 背包操作

/** 找一个空槽位，没有则返回 -1 */
function findEmptySlot(inv) {
  for (let i = 0; i < inv.length; i++) if (!inv[i]) return i;
  return -1;
}

/**
 * 往背包塞一个物品，支持药水堆叠。
 * @returns {number} 放入的槽位，-1 表示背包满
 */
function addItem(inv, item) {
  if (item.type === 'potion') {
    // 先找同类堆叠
    for (let i = 0; i < inv.length; i++) {
      const s = inv[i];
      if (s && s.type === 'potion' && s.kind === item.kind && s.count < 99) {
        s.count = Math.min(99, s.count + item.count);
        return i;
      }
    }
  }
  const slot = findEmptySlot(inv);
  if (slot < 0) return -1;
  inv[slot] = item;
  return slot;
}

function removeAt(inv, index) {
  const it = inv[index];
  inv[index] = null;
  return it;
}

function countPotions(ch) {
  return { red: ch.potions.red || 0, blue: ch.potions.blue || 0 };
}

// ------------------------------------------------------------------ 合成

/** 背包里与 item 同品质的装备数量（合成材料用） */
function countSameQuality(inv, item) {
  if (!item || item.type !== 'equipment') return 0;
  return inv.filter((it) => it && it.type === 'equipment' && it.quality === item.quality).length;
}

/** 按等级与品质重算一件装备的基础属性（合成后属性要跟着新等级/新品质走） */
function rollAttrs(slot, level, mult) {
  const b = SLOT_BASE[slot] || {};
  const attrs = {};
  if (b.atk !== undefined) attrs.atk = Math.round((b.atk + b.atkPerLevel * (level - 1)) * mult);
  if (b.def !== undefined) attrs.def = Math.round((b.def + b.defPerLevel * (level - 1)) * mult);
  if (b.hp !== undefined) attrs.maxHp = Math.round((b.hp + b.hpPerLevel * (level - 1)) * mult);
  if (b.dodge !== undefined) attrs.dodge = Math.round((b.dodge + b.dodgePerLevel * (level - 1)) * mult * 1000) / 1000;
  if (b.crit !== undefined) attrs.crit = Math.round((b.crit + b.critPerLevel * (level - 1)) * mult * 1000) / 1000;
  return attrs;
}

/** 把已有词条补齐到 targetCount 条（不覆盖已有词条，只补缺的；属性不重复） */
function topUpAffixes(existing, targetCount, level) {
  const out = (existing || []).slice();
  const used = new Set(out.map((a) => a.stat));
  let guard = 0;
  while (out.length < targetCount && guard++ < 40) {
    const a = rollAffix(level);
    if (used.has(a.stat)) continue;
    used.add(a.stat);
    out.push(a);
  }
  return out;
}

/**
 * 装备合成：FUSE.count 件**同品质**装备 → 1 件**高一阶品质**的装备。
 *
 * 产出规则：
 *   - 部位 / 名称：沿用参与装备里**等级最高**那件（保留装备的身份感，不是白给随机货）
 *   - 等级：参与者最高等级 + FUSE.levelBonus
 *   - 属性：按新等级 × 新品质系数重算
 *   - 词条：沿用参与者已有词条，并补齐到新品质应有的条数（不会把好词条洗掉）
 *
 * @returns {{ok:boolean, msg?:string, item?:object, consumed?:number, baseIdx?:number}}
 */
function fuseEquipment(ch, itemId) {
  const idx = ch.inventory.findIndex((it) => it && it.id === itemId);
  if (idx < 0) return { ok: false, msg: '背包中没有该物品' };
  const main = ch.inventory[idx];
  if (main.type !== 'equipment') return { ok: false, msg: '只有装备可以合成' };

  const nq = nextQuality(main.quality);
  if (!nq) return { ok: false, msg: '已是最高品质（史诗），无法继续合成' };

  // 找出同品质的其它装备（不含被点击的这件）
  const mates = [];
  for (let i = 0; i < ch.inventory.length; i++) {
    if (i === idx) continue;
    const it = ch.inventory[i];
    if (it && it.type === 'equipment' && it.quality === main.quality) mates.push(i);
  }
  if (mates.length + 1 < FUSE.count) {
    return { ok: false, msg: `需要 ${FUSE.count} 件同品质装备（当前 ${mates.length + 1} 件）` };
  }

  // 参与者：被点击的那件 + 前 (count-1) 件同品质
  const useIdx = [idx, ...mates.slice(0, FUSE.count - 1)];
  // 以等级最高那件为蓝本（并列时优先保留被点击的那件）
  let baseIdx = useIdx[0];
  for (const i of useIdx) {
    if ((ch.inventory[i].level || 1) > (ch.inventory[baseIdx].level || 1)) baseIdx = i;
  }
  const base = ch.inventory[baseIdx];

  const level = Math.max(1, (base.level || 1) + FUSE.levelBonus);
  const q = QUALITIES[nq];
  const parts = useIdx.map((i) => ch.inventory[i]);

  // 词条：先把参与者身上的词条都收拢过来（同属性只留第一条），再补齐
  const merged = [];
  const used = new Set();
  for (const p of parts) {
    for (const a of (p.affixes || [])) {
      if (used.has(a.stat)) continue;
      used.add(a.stat);
      merged.push(a);
    }
  }

  const namePool = ITEM_NAMES[base.slot] || [base.name];
  const tier = Math.min(namePool.length - 1, Math.floor((level - 1) / 3));

  const fused = {
    id: genId(),
    type: 'equipment',
    slot: base.slot,
    name: namePool[tier] || base.name,
    quality: q.key,
    qualityName: q.name,
    color: q.color,
    level,
    attrs: rollAttrs(base.slot, level, q.mult),
    affixes: topUpAffixes(merged, q.affixes, level),
  };

  // 清空参与者，产物落在蓝本那一格（视觉上就是"这几件合成了它"）
  for (const i of useIdx) ch.inventory[i] = null;
  ch.inventory[baseIdx] = fused;

  return { ok: true, item: fused, consumed: useIdx.length, baseIdx };
}

// ------------------------------------------------------------------ 装备属性

/**
 * 汇总所有已装备装备的属性加成。
 * @param {object} equipment { weapon: item|null, ... }
 */
function calcEquipmentBonus(equipment) {
  const bonus = { atk: 0, def: 0, maxHp: 0, maxMp: 0, crit: 0, hit: 0, dodge: 0, haste: 0 };
  for (const slot of SLOTS) {
    const item = equipment && equipment[slot];
    if (!item) continue;
    for (const [k, v] of Object.entries(item.attrs || {})) {
      bonus[k] = (bonus[k] || 0) + v;
    }
    for (const affix of item.affixes || []) {
      const key = affix.stat === 'haste' ? 'haste' : affix.stat;
      bonus[key] = (bonus[key] || 0) + affix.value;
    }
  }
  return bonus;
}

// ------------------------------------------------------------------ 穿脱装备

/**
 * 穿装备。会把原部位装备卸回背包。
 * @returns {{ok:boolean, msg?:string, equipment?:object, inventory?:Array}}
 */
function equip(ch, itemId) {
  const idx = ch.inventory.findIndex((it) => it && it.id === itemId);
  if (idx < 0) return { ok: false, msg: '背包中没有这件装备' };
  const item = ch.inventory[idx];
  if (item.type !== 'equipment') return { ok: false, msg: '这不是装备' };

  const slot = item.slot;
  if (!SLOTS.includes(slot)) return { ok: false, msg: '非法装备部位' };

  const old = ch.equipment[slot];
  ch.equipment[slot] = item;
  ch.inventory[idx] = old || null; // 原装备放回原位；没原装备就清空

  return { ok: true, equipment: ch.equipment, inventory: ch.inventory };
}

function unequip(ch, slot) {
  if (!SLOTS.includes(slot)) return { ok: false, msg: '非法装备部位' };
  const item = ch.equipment[slot];
  if (!item) return { ok: false, msg: '该部位没有装备' };
  const target = findEmptySlot(ch.inventory);
  if (target < 0) return { ok: false, msg: '背包已满，无法卸下' };
  ch.inventory[target] = item;
  ch.equipment[slot] = null;
  return { ok: true, equipment: ch.equipment, inventory: ch.inventory };
}

module.exports = {
  genId, addItem, removeAt, findEmptySlot, countPotions,
  calcEquipmentBonus, equip, unequip, BAG_SIZE,
  countSameQuality, fuseEquipment,
};
