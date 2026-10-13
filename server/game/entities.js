'use strict';

/**
 * 怪物实体与 AI。
 */

const { MONSTERS, MONSTER_ATTACK_RANGE, layerMonsterLevel } = require('../config');
const { circleHitsWall } = require('./map');
const { rescueIfStuck } = require('./move');
// A* 寻路：遇到需要绕开的障碍时不再只会贴着墙滑
const { moveToward, clearPath } = require('./pathfind');
const { monsterStats, computeDamage } = require('./combat');

const MONSTER_RADIUS = 0.3;

let seq = 1;
const nextId = () => `m${seq++}`;

/**
 * 朝 (tx,ty) 走一步。
 * 直线通就直接走；直线不通就走 A* 算出来的路绕过去（见 pathfind.js）。
 * 返回是否真的移动了。
 */
function stepToward(m, tx, ty, speed, map, now) {
  const d = Math.hypot(tx - m.x, ty - m.y);
  if (d < 1e-4) return false;
  return moveToward(m, map, tx, ty, speed, MONSTER_RADIUS, now);
}

/** 在出生点附近挑一个"能站"的游走点；挑不到返回 null（本 tick 就不动） */
function pickWanderTarget(m, map) {
  for (let i = 0; i < 8; i++) {
    const x = m.homeX + (Math.random() - 0.5) * 4;
    const y = m.homeY + (Math.random() - 0.5) * 4;
    if (!circleHitsWall(map, x, y, MONSTER_RADIUS)) return { x, y };
  }
  return null;
}

function createMonster(type, x, y, homeX, homeY, layer = 1) {
  const tpl = MONSTERS[type];
  if (!tpl) throw new Error(`未知怪物类型: ${type}`);
  const st = monsterStats(tpl, layer);
  return {
    id: nextId(),
    type,
    name: tpl.name,
    // 显示等级随层数上浮（第 1 层就是模板等级），掉落装备等级也用它
    level: layerMonsterLevel(tpl.level, layer),
    layer,
    isBoss: !!tpl.isBoss,
    x, y,
    homeX, homeY,
    hp: st.maxHp,
    maxHp: st.maxHp,
    atk: st.atk,
    def: st.def,
    crit: st.crit,
    critDmg: st.critDmg,
    hit: st.hit,
    dodge: st.dodge,
    aggro: tpl.aggro,
    nextAttackAt: 0,
    dead: false,
    respawnAt: 0,
    state: 'idle',
    wanderTarget: null,
  };
}

/** 按地图定义批量生成怪物（layer 决定强度，Boss 也一样随层数变强） */
function spawnMonstersForMap(map, layer = 1) {
  const list = [];
  for (const ms of map.def.monsterSpawns) {
    for (let i = 0; i < ms.count; i++) {
      // 在刷怪点周围散开。范围要够大，否则一堆怪叠在一起会瞬间围殴玩家。
      const ox = (Math.random() - 0.5) * 7;
      const oy = (Math.random() - 0.5) * 7;
      const x = Math.max(1, Math.min(map.w - 2, ms.x + ox));
      const y = Math.max(1, Math.min(map.h - 2, ms.y + oy));
      if (circleHitsWall(map, x, y, 0.3)) continue; // 卡墙里就不刷
      list.push(createMonster(ms.type, x, y, ms.x, ms.y, layer));
    }
  }
  return list;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 推进一只怪物一个 tick。
 * 目标不再固定是玩家，而是"最近的敌人"——玩家或任意一只宠物，
 * 所以宠物能吸引仇恨、替主人挡刀。
 * @param {object} player { x, y, dead, stats }
 * @param {Array} pets 主人召唤出的宠物列表
 * @returns {null | {type:'attack', targetType:'player'|'pet', targetId:string, dmg:number, crit:boolean, miss:boolean}}
 */
function updateMonster(m, map, player, pets, now, dtSec) {
  if (m.dead) {
    if (now >= m.respawnAt) {
      m.dead = false;
      m.hp = m.maxHp;
      m.x = m.homeX;
      m.y = m.homeY;
      m.state = 'idle';
      clearPath(m); // 复活是瞬移，残留路径会把旧路点带过来
    }
    return null;
  }

  // ---- 选最近的敌人 ----
  let target = null;
  let targetType = null;
  let bestD = Infinity;

  if (player && !player.dead && player.stats) {
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d < bestD) { bestD = d; target = player; targetType = 'player'; }
  }
  for (const p of pets || []) {
    if (p.dead) continue;
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bestD) { bestD = d; target = p; targetType = 'pet'; }
  }
  if (!target) return null;

  const speed = 2.2 * dtSec; // 怪物移动速度 tile/秒，略慢于玩家

  // 兜底自救：万一生成点/坐标卡在障碍里，先挪出来，否则它会永远杵着不动
  rescueIfStuck(map, m, MONSTER_RADIUS);

  if (bestD <= m.aggro) {
    m.state = 'chase';
    if (bestD > MONSTER_ATTACK_RANGE) {
      // 朝目标走一步——带滑行，贴着墙也能继续追，不会顶在墙上不动
      // 带寻路：能直走就直走，绕不过去时走 A* 算出来的路
      stepToward(m, target.x, target.y, speed, map, now);
    } else if (now >= m.nextAttackAt) {
      m.nextAttackAt = now + 1500; // 怪物攻击间隔（调慢一点，给玩家反应时间）
      // 玩家传 stats（{atk,hit,...}），宠物本身就是战斗属性对象
      const defender = targetType === 'player' ? target.stats : target;
      return {
        type: 'attack',
        targetType,
        targetId: targetType === 'player' ? 'player' : target.id,
        ...computeDamage(m, defender),
      };
    }
  } else if (m.state === 'chase' && bestD > m.aggro * 1.6) {
    m.state = 'return';
  }

  if (m.state === 'return') {
    const hd = Math.hypot(m.homeX - m.x, m.homeY - m.y);
    if (hd < 0.3) {
      m.state = 'idle';
      m.wanderTarget = null;
    } else if (!stepToward(m, m.homeX, m.homeY, speed, map, now)) {
      // 完全走不动（真被夹住了）：就地重新安家。
      // ★ 以前这里是 m.x = m.homeX 直接瞬移归位 —— 一旦 home 不合法，
      //   怪会被塞进墙里，然后永远动不了。改成"就地安家"就不会产生非法坐标。
      m.homeX = m.x;
      m.homeY = m.y;
      m.state = 'idle';
    }
  } else if (m.state === 'idle') {
    // 在出生点附近随机游走
    if (!m.wanderTarget || Math.hypot(m.wanderTarget.x - m.x, m.wanderTarget.y - m.y) < 0.3) {
      m.wanderTarget = pickWanderTarget(m, map);
    }
    if (m.wanderTarget) stepToward(m, m.wanderTarget.x, m.wanderTarget.y, speed * 0.5, map, now);
  }

  return null;
}

/** 转成客户端需要的精简快照 */
function toClient(m) {
  return {
    id: m.id, type: m.type, name: m.name, level: m.level, isBoss: m.isBoss,
    x: Math.round(m.x * 100) / 100,
    y: Math.round(m.y * 100) / 100,
    hp: Math.max(0, Math.round(m.hp)),
    maxHp: m.maxHp,
    dead: m.dead,
  };
}

module.exports = { createMonster, spawnMonstersForMap, updateMonster, toClient, dist };
