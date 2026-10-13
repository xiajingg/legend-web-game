'use strict';

/**
 * 召唤宠物：玩家召出的友方单位。
 *
 * 行为很简单，只有两条：
 *   1. 索敌半径内有怪 → 冲上去打（不在攻击距离内就先靠近）
 *   2. 没怪 → 回到主人身边飘着
 *
 * 宠物会被怪物攻击（怪物 AI 会选最近的敌人），所以能替主人挡刀。
 */

const { PETS } = require('../config');
const { circleHitsWall } = require('./map');
const { rescueIfStuck } = require('./move');
// A* 寻路：宠物追怪/跟人时同样要能绕开障碍
const { moveToward, clearPath } = require('./pathfind');
const { computeDamage } = require('./combat');

let seq = 1;
const nextId = () => `p${seq++}`;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 第 slot 号宠物的环绕方位角（黄金角铺开，任意数量都能均匀分布不打架） */
function slotAngle(slot) {
  return slot * 2.399963;
}

/**
 * 创建一只宠物。
 * 属性跟着主人的等级与攻击力走：主人越强，宠物越强。
 * @param {object} owner 主人会话（读 ch.level 与 stats）
 */
function createPet(owner, x, y, slot = 0) {
  const maxHp = PETS.hp + Math.max(0, owner.ch.level - 1) * PETS.hpPerLevel;
  return {
    id: nextId(),
    owner: owner.username,
    slot, // 站位槽（0~7）：决定它围绕目标/主人站的方位，避免所有宠物重叠
    x, y,
    hp: maxHp,
    maxHp,
    // 宠物攻击力 = 主人攻击力 × 系数，随主人成长
    atk: Math.max(1, Math.round(owner.stats.atk * PETS.atkRatio)),
    def: 0,
    crit: owner.stats.crit,
    critDmg: owner.stats.critDmg,
    hit: owner.stats.hit,
    dodge: 0.05,
    nextAttackAt: 0,
    targetId: null,
    dead: false,
    moving: false,
  };
}

function clampAxis(map, v, axis) {
  const max = (axis === 'x' ? map.w : map.h) - 2;
  return Math.max(1, Math.min(max, v));
}

/**
 * 给第 index 只宠物找个落脚点。
 * 用黄金角铺开，8 只宠物会自然均匀围成一圈，不会叠在一起。
 */
function findSpawnSpot(map, owner, index) {
  const base = (index * 2.399963) % (Math.PI * 2);
  for (let i = 0; i < 6; i++) {
    const a = base + i * (Math.PI / 3);
    const x = clampAxis(map, owner.x + Math.cos(a) * PETS.summonGap, 'x');
    const y = clampAxis(map, owner.y + Math.sin(a) * PETS.summonGap, 'y');
    if (!circleHitsWall(map, x, y, PETS.radius)) return { x, y };
  }
  return { x: owner.x, y: owner.y }; // 全被墙占住就落在主人脚下
}

/** 朝目标走一步：直线通就直走，不通就沿 A* 路径绕过去。返回是否真的动了 */
function stepToward(pet, tx, ty, map, dtSec, now) {
  const d = Math.hypot(tx - pet.x, ty - pet.y);
  if (d < 0.01) return false;
  return moveToward(pet, map, tx, ty, PETS.moveSpeed * dtSec, PETS.radius, now);
}

/**
 * 推进一只宠物一个 tick。
 * @returns {null | {type:'attack', targetId:string, dmg:number, crit:boolean, miss:boolean}}
 *          本 tick 若发动了攻击则返回伤害结果，交给上层记账
 */
function updatePet(pet, owner, monsters, map, now, dtSec) {
  if (pet.dead) return null;

  // 兜底自救：宠物因召唤/切图落在障碍里时先挪出来
  rescueIfStuck(map, pet, PETS.radius);

  // ---- 1) 索敌：攻击范围外 aggroRange 内最近的活怪 ----
  let target = null;
  let bestD = PETS.aggroRange;
  for (const m of monsters) {
    if (m.dead) continue;
    const d = dist(pet, m);
    if (d < bestD) { bestD = d; target = m; }
  }
  pet.targetId = target ? target.id : null;

  const a = slotAngle(pet.slot);
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  if (target) {
    if (bestD > PETS.attackRange) {
      // 还够不着：先直奔目标缩短距离
      stepToward(pet, target.x, target.y, map, dtSec, now);
      pet.moving = true;
    } else {
      // 已在攻击范围内：绕到自己对应的方位站好，8 只宠物自然围成一圈而不是叠成一坨
      let sx = target.x + cos * PETS.standGap;
      let sy = target.y + sin * PETS.standGap;
      if (circleHitsWall(map, sx, sy, PETS.radius)) { sx = target.x; sy = target.y; }
      if (Math.hypot(sx - pet.x, sy - pet.y) > 0.18) {
        stepToward(pet, sx, sy, map, dtSec, now);
        pet.moving = true;
      } else {
        pet.moving = false;
        if (now >= pet.nextAttackAt) {
          pet.nextAttackAt = now + PETS.attackCooldown;
          const res = computeDamage(pet, target);
          return { type: 'attack', targetId: target.id, ...res };
        }
      }
    }
    return null;
  }

  // ---- 2) 没怪就回主人身边，同样按槽位围成一圈 ----
  const fx = owner.x + cos * PETS.followGap;
  const fy = owner.y + sin * PETS.followGap;
  if (Math.hypot(fx - pet.x, fy - pet.y) > 0.15) {
    stepToward(pet, fx, fy, map, dtSec, now);
    pet.moving = true;
  } else {
    pet.moving = false;
  }
  return null;
}

/** 转成客户端需要的精简快照 */
function toClient(pet) {
  return {
    id: pet.id,
    x: Math.round(pet.x * 100) / 100,
    y: Math.round(pet.y * 100) / 100,
    hp: Math.max(0, Math.round(pet.hp)),
    maxHp: pet.maxHp,
    dead: pet.dead,
    moving: !!pet.moving,
  };
}

module.exports = { createPet, updatePet, toClient, findSpawnSpot, dist };
