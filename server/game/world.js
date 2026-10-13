'use strict';

/**
 * 游戏世界：管理所有在线玩家的会话，跑 10Hz tick，服务端权威计算一切数值。
 */

const {
  MAPS, MAP_BY_ID, TICK_MS, PLAYER_BASE, POTIONS, POTION_COOLDOWN,
  PICKUP_RANGE, ATTACK_RANGE, MONSTERS, MAX_LEVEL, PETS, LAYER, FUSE,
  floorNo, FLOORS_PER_CYCLE, SKILLS, publicSkills,
} = require('../config');
const { buildMap, portalAt } = require('./map');
// 带滑行的移动求解：玩家 / 怪物 / 宠物共用同一套，避免三处规则不一致
const { resolveMove, rescueIfStuck } = require('./move');
const { clearPath } = require('./pathfind');
const { spawnMonstersForMap, updateMonster, toClient, dist } = require('./entities');
const { createPet, updatePet, toClient: petToClient, findSpawnSpot } = require('./pets');
const { computeDamage, gainExp, playerStats } = require('./combat');
const { rollDrops, dropRewardMult } = require('./drops');
const inventory = require('./inventory');
const sse = require('../sseHub');
const store = require('../store');

/** 预构建所有地图（tiles 是静态的） */
const MAPS_BUILT = Object.fromEntries(MAPS.map((def) => [def.id, buildMap(def)]));

/** @type {Map<string, Session>} */
const sessions = new Map();

let tickCount = 0;

// ------------------------------------------------------------------ 会话

class Session {
  constructor(username, save) {
    this.username = username;
    this.save = save;
    this.ch = save.character;
    // 无尽层数：存档里带着走，老存档没有这个字段时默认第 1 层
    this.ch.layer = Math.max(1, Math.floor(Number(this.ch.layer) || 1));
    this.ch.bossCleared = !!this.ch.bossCleared;
    this.map = MAPS_BUILT[this.ch.mapId] || MAPS_BUILT.village;
    this.monsters = spawnMonstersForMap(this.map, this.ch.layer);
    this.pets = [];               // 召唤出来的宠物（不持久化，重连/切图后需重新召唤）
    this.drops = [];
    this.moveDir = null;          // [dx, dy] 归一化向量，null = 停
    this.attackTargetId = null;
    this.nextAttackAt = 0;
    this.nextPotionAt = 0;
    this.nextSkillAt = 0;         // 技能冷却（所有技能共用一个，只有一个技能时够用）
    this.portalHintAt = 0;        // 传送点提示的节流时间戳
    this.refreshStats();
    // 地图每次启动都重新生成（障碍是随机的），存档里的坐标可能正好落在新墙里。
    // 这里主动挪一次，否则玩家登录后看起来"卡死"，要按一次方向键才会被救出来。
    rescueIfStuck(this.map, this.ch, PLAYER_BASE.radius);
    // 本次 tick 待下发的事件
    this.out = { combat: [], loot: [], messages: [] };
    this.leveledUp = false;
    this.dirtySave = false;
  }

  refreshStats() {
    const bonus = inventory.calcEquipmentBonus(this.ch.equipment);
    this.stats = playerStats(this.ch, bonus);
    // 卸装备后血量可能超上限，钳一下
    this.ch.hp = Math.min(this.ch.hp, this.stats.maxHp);
    this.ch.mp = Math.min(this.ch.mp, this.stats.maxMp);
  }

  monsterById(id) {
    return this.monsters.find((m) => m.id === id) || null;
  }
}

function getOrCreateSession(username, save) {
  let s = sessions.get(username);
  if (!s) {
    s = new Session(username, save);
    sessions.set(username, s);
  }
  s.disconnectedAt = 0; // 重新上线，取消离线计时
  // 每次（重）连接都重置操作意图：残留的 moveDir 会让角色在无人操作时继续跑
  s.moveDir = null;
  s.attackTargetId = null;
  return s;
}

/**
 * 玩家断开连接（关页面/断网/SSE 掉线）。
 * 必须清空"进行中的操作意图"——否则服务端的 tick 会继续按残留的
 * moveDir / attackTargetId 推进角色，表现为"人不在了角色还在跑"。
 * 这里只清操作状态、不立即销毁会话：EventSource 会自动重连，
 * 立即销毁会导致每次网络抖动都丢失未保存的进度。
 * 真正销毁交给 cleanupIdleSessions 在离线超时后处理。
 */
function handleDisconnect(username) {
  const s = sessions.get(username);
  if (!s) return;
  s.moveDir = null;
  s.attackTargetId = null;
  s.disconnectedAt = Date.now();
  s.dirtySave = true; // 下次存档周期落盘，避免丢进度
}

/** 离线超过这个时间的会话会被销毁，释放内存并停止为其跑 tick */
const SESSION_IDLE_MS = 5 * 60 * 1000;

async function cleanupIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [name, s] of sessions) {
    if (!s.disconnectedAt || s.disconnectedAt > cutoff) continue;
    try {
      await store.saveSave(name, s.save); // 销毁前先落盘
    } catch (e) {
      console.error(`[world] 离线会话存档失败 user=${name}:`, e);
    }
    sessions.delete(name);
  }
}

// ------------------------------------------------------------------ 玩家操作（只接收意图）

function handleAction(username, action) {
  const s = sessions.get(username);
  if (!s) return { ok: false, msg: '会话不存在' };
  const now = Date.now();

  switch (action.type) {
    case 'move': {
      // 只在方向改变时发送，这里直接存住方向，tick 里持续推进
      const d = action.dir;
      if (!d) { s.moveDir = null; return { ok: true }; }
      const len = Math.hypot(d[0], d[1]);
      if (len === 0) { s.moveDir = null; return { ok: true }; }
      s.moveDir = [d[0] / len, d[1] / len];
      return { ok: true };
    }

    case 'attack': {
      const m = s.monsterById(action.targetId);
      if (!m || m.dead) return { ok: false, msg: '目标不存在' };
      s.attackTargetId = m.id;
      return { ok: true };
    }

    case 'stopAttack':
      s.attackTargetId = null;
      return { ok: true };

    // ---- 召唤宠物：每只消耗 PETS.mpCost 点魔法，最多同时 PETS.max 只 ----
    case 'summonPet': {
      if (s.pets.length >= PETS.max) {
        return { ok: false, msg: `最多同时召唤 ${PETS.max} 只宠物` };
      }
      if (s.ch.mp < PETS.mpCost) {
        return { ok: false, msg: '魔法值不足，无法召唤' };
      }
      s.ch.mp -= PETS.mpCost;
      // 用黄金角在主人周围铺开，避免 8 只宠物叠在同一个点上
      const spot = findSpawnSpot(s.map, s.ch, s.pets.length);
      s.pets.push(createPet(s, spot.x, spot.y, s.pets.length));
      s.out.messages.push({
        text: `召唤宠物 (${s.pets.length}/${PETS.max})，消耗 ${PETS.mpCost} 魔法`,
        kind: 'info',
      });
      return { ok: true };
    }

    case 'dismissPets': {
      if (!s.pets.length) return { ok: false, msg: '当前没有宠物' };
      const n = s.pets.length;
      s.pets.length = 0;
      s.out.messages.push({ text: `解散了 ${n} 只宠物`, kind: 'info' });
      return { ok: true };
    }

    // ---- 主动技能（小火球）：远程 + 落点溅射，代价是耗蓝与冷却 ----
    case 'castSkill': {
      const sk = SKILLS[action.skill];
      if (!sk) return { ok: false, msg: '没有这个技能' };
      if (s.ch.hp <= 0) return { ok: false, msg: '已阵亡，无法施法' };
      if (now < s.nextSkillAt) {
        const left = Math.ceil((s.nextSkillAt - now) / 100) / 10;
        return { ok: false, msg: `${sk.name}冷却中（${left}s）` };
      }
      if (s.ch.mp < sk.mpCost) return { ok: false, msg: `魔法值不足（需要 ${sk.mpCost}）` };

      // 选目标：优先当前锁定的怪（且在射程内），否则自动取射程内最近的一只。
      // 注意这里**不设置** attackTargetId —— 否则 tick 里的"自动靠近目标"会让玩家
      // 一边放火球一边走上去贴脸，远程技能就白做了。
      const ch0 = s.ch;
      let target = s.attackTargetId ? s.monsterById(s.attackTargetId) : null;
      if (target && (target.dead || dist(ch0, target) > sk.range)) target = null;
      if (!target) {
        let bestD = sk.range;
        for (const m of s.monsters) {
          if (m.dead) continue;
          const d = dist(ch0, m);
          if (d < bestD) { bestD = d; target = m; }
        }
      }
      if (!target) return { ok: false, msg: `射程内没有怪物（${sk.range} 格）` };

      s.ch.mp -= sk.mpCost;
      s.nextSkillAt = now + sk.cooldown;

      // 主目标：正常倍率
      const hit = computeDamage({ ...s.stats, atk: s.stats.atk * sk.damageMult }, target);
      target.hp -= hit.dmg;
      s.out.combat.push({
        attackerId: 'player', targetId: target.id, targetType: 'monster',
        dmg: hit.dmg, crit: hit.crit, miss: hit.miss,
        skill: sk.key, flightMs: sk.flightMs,   // 客户端据 skill 播火球、据 flightMs 延后命中表现
        ax: ch0.x, ay: ch0.y,
      });
      if (target.hp <= 0) onMonsterDead(s, target, now);

      // 溅射：落点附近的其它怪吃一部分伤害（火球"炸开"的感觉）
      if (sk.splashRadius > 0) {
        const splash = [];
        for (const m of s.monsters) {
          if (m.dead || m === target) continue;
          if (dist(m, target) > sk.splashRadius) continue;
          splash.push({ m, res: computeDamage({ ...s.stats, atk: s.stats.atk * sk.damageMult * sk.splashRatio }, m) });
        }
        for (const { m, res } of splash) {
          m.hp -= res.dmg;
          s.out.combat.push({
            // 溅射从落点炸开（ax/ay 用主目标位置），客户端不再单独播飞行弹道
            attackerId: 'player', targetId: m.id, targetType: 'monster',
            dmg: res.dmg, crit: res.crit, miss: res.miss,
            skill: sk.key, splash: true, flightMs: 0,
            ax: target.x, ay: target.y,
          });
          if (m.hp <= 0) onMonsterDead(s, m, now);
        }
      }

      s.dirtySave = true; // 魔法值变了，要落盘
      return { ok: true };
    }

    case 'useItem': {
      const kind = action.kind === 'blue' ? 'blue' : 'red';
      if (now < s.nextPotionAt) return { ok: false, msg: '药水冷却中' };
      if ((s.ch.potions[kind] || 0) <= 0) return { ok: false, msg: `没有${POTIONS[kind].name}了` };
      const p = POTIONS[kind];
      if (s.ch.hp >= s.stats.maxHp && kind === 'red') return { ok: false, msg: '生命已满' };
      if (s.ch.mp >= s.stats.maxMp && kind === 'blue') return { ok: false, msg: '魔法已满' };
      s.ch.potions[kind] -= 1;
      if (p.healHpPct) s.ch.hp = Math.min(s.stats.maxHp, s.ch.hp + s.stats.maxHp * p.healHpPct);
      if (p.healMpPct) s.ch.mp = Math.min(s.stats.maxMp, s.ch.mp + s.stats.maxMp * p.healMpPct);
      s.nextPotionAt = now + POTION_COOLDOWN;
      s.out.messages.push({ text: `使用${p.name}`, kind: 'info' });
      pushInventory(s);
      s.dirtySave = true; // 药水数量变了，必须落盘，否则异常重启会"回血"
      return { ok: true };
    }

    case 'equip': {
      const r = inventory.equip(s.ch, action.itemId);
      if (!r.ok) return r;
      s.refreshStats();
      pushInventory(s);
      s.dirtySave = true; // 穿装备也要落盘，否则重启后装备会退回背包
      return { ok: true };
    }

    case 'unequip': {
      const r = inventory.unequip(s.ch, action.slot);
      if (!r.ok) return r;
      s.refreshStats();
      pushInventory(s);
      s.dirtySave = true;
      return { ok: true };
    }

    case 'dropItem': {
      const idx = s.ch.inventory.findIndex((it) => it && it.id === action.itemId);
      if (idx < 0) return { ok: false, msg: '背包中没有该物品' };
      inventory.removeAt(s.ch.inventory, idx);
      pushInventory(s);
      s.dirtySave = true;
      return { ok: true };
    }

    // ---- 合成：几件同品质装备 → 一件高一阶品质的 ----
    case 'fuseItem': {
      if (s.ch.hp <= 0) return { ok: false, msg: '已阵亡，无法操作' };
      const r = inventory.fuseEquipment(s.ch, action.itemId);
      if (!r.ok) return r;
      s.out.messages.push({
        text: `合成成功：${r.item.qualityName}·${r.item.name} Lv${r.item.level}（消耗 ${r.consumed} 件）`,
        kind: 'good',
      });
      pushInventory(s);
      s.dirtySave = true;
      return { ok: true, item: r.item };
    }

    case 'enterMap': {
      const target = MAP_BY_ID[action.mapId];
      if (!target) return { ok: false, msg: '地图不存在' };
      // 校验：目标地图必须与当前地图有传送点相连，防作弊
      const portal = s.map.def.portals.find((p) => p.to === action.mapId);
      if (!portal) return { ok: false, msg: '此处无法传送到该地图' };
      // 闯关门同样要过"打穿本层魔王"的校验，否则可以直接构造请求绕过限制
      if (portal.nextLayer) {
        if (!s.ch.bossCleared) return { ok: false, msg: '先击败本层魔王' };
        advanceLayer(s);
        return { ok: true };
      }
      switchMap(s, action.mapId);
      return { ok: true };
    }

    default:
      return { ok: false, msg: `未知操作: ${action.type}` };
  }
}

function pushInventory(s) {
  sse.send(s.username, 'inventory', {
    inventory: s.ch.inventory,
    equipment: s.ch.equipment,
    gold: s.ch.gold,
    potions: s.ch.potions,
    stats: s.stats,
  });
}

function switchMap(s, mapId) {
  const def = MAP_BY_ID[mapId];
  s.ch.mapId = mapId;
  s.map = MAPS_BUILT[mapId];
  s.ch.x = def.spawn.x;
  s.ch.y = def.spawn.y;
  // 怪物按当前层数生成：同一张图在更深的层数里就是"加强版"
  s.monsters = spawnMonstersForMap(s.map, s.ch.layer);
  s.drops = [];
  s.moveDir = null;
  s.attackTargetId = null;
  // 宠物跟着主人一起传送：重新找落脚点，避免落在新地图的墙里
  s.pets.forEach((pet, i) => {
    const spot = findSpawnSpot(s.map, s.ch, i);
    pet.x = spot.x;
    pet.y = spot.y;
    pet.targetId = null;
    pet.nextAttackAt = 0;
    clearPath(pet); // 跨图后旧路径全是别张图的坐标，必须清掉
  });
  s.dirtySave = true;
  sse.send(s.username, 'map', {
    mapId, name: def.name,
    layer: s.ch.layer,                       // 第几轮循环（决定怪物强度）
    floor: floorNo(s.ch.layer, mapId),       // 第几层（显示用，随地图连续递增）
    bossCleared: s.ch.bossCleared,
    w: s.map.w, h: s.map.h, tiles: s.map.tiles, def: publicMapDef(def),
  });
  pushInventory(s);
}

/**
 * 进入下一层：层数 +1，回到第一张图（新手村）重跑一遍。
 * 每层的怪物都是"上一层的加强版"，且必须重新打完本层魔王才能再往下走，
 * 所以这里要把 bossCleared 清掉，否则新一层可以直接穿过去。
 */
function advanceLayer(s) {
  s.ch.layer += 1;
  s.ch.bossCleared = false;
  switchMap(s, MAPS[0].id);
  s.out.messages.push({
    text: `突破第 ${FLOORS_PER_CYCLE} 层魔王！进入第 ${floorNo(s.ch.layer, MAPS[0].id)} 层 —— `
      + `怪物强度与收益整体提升（血量 +${Math.round(LAYER.hp * (s.ch.layer - 1) * 100)}%）`,
    kind: 'good',
  });
  s.dirtySave = true;
}

/** 只把客户端需要的地图定义字段发出去（含配色，前端不必硬编码） */
function publicMapDef(def) {
  return {
    id: def.id, name: def.name, w: def.w, h: def.h, difficulty: def.difficulty,
    ground: def.ground,
    groundAlt: def.groundAlt,
    wallTop: def.wallTop,
    wallColor: def.wallColor,
  };
}

// ------------------------------------------------------------------ 快照

function buildInit(s) {
  return {
    player: {
      username: s.username,
      level: s.ch.level,
      exp: s.ch.exp,
      expNext: s.ch.expNext,
      hp: Math.round(s.ch.hp),
      mp: Math.round(s.ch.mp),
      x: s.ch.x,
      y: s.ch.y,
      gold: s.ch.gold,
      potions: s.ch.potions,
      stats: s.stats,
      kills: s.save.stats.kills,
      petMax: PETS.max, // 宠物上限，前端 HUD 显示用
      skills: publicSkills(), // 技能面板数据（名称/快捷键/耗蓝/冷却）
      fuseCount: FUSE.count,  // 合成需要几件同品质装备（前端据此显示还差几件）
    },
    map: {
      mapId: s.map.id,
      name: s.map.name,
      layer: s.ch.layer,                            // 第几轮循环
      floor: floorNo(s.ch.layer, s.map.id),         // 第几层（显示用）
      bossCleared: s.ch.bossCleared,
      w: s.map.w,
      h: s.map.h,
      tiles: s.map.tiles,
      def: publicMapDef(s.map.def),
      portals: s.map.def.portals,
    },
    monsters: s.monsters.map(toClient),
    pets: s.pets.map(petToClient),
    drops: s.drops.map(toClientDrop),
    inventory: s.ch.inventory,
    equipment: s.ch.equipment,
  };
}

function toClientDrop(d) {
  return {
    id: d.id, x: d.x, y: d.y,
    kind: d.item.type === 'gold' ? 'gold' : (d.item.kind || d.item.type),
    name: d.item.type === 'gold' ? `${d.item.amount} 金币`
      : d.item.type === 'potion' ? `${POTIONS[d.item.kind].name} x${d.item.count}` : d.item.name,
    color: d.item.type === 'equipment' ? d.item.color : (d.item.type === 'gold' ? '#ffd24a' : '#ff6b6b'),
    amount: d.item.amount || 0,
  };
}

// ------------------------------------------------------------------ tick

function tick() {
  tickCount++;
  const now = Date.now();
  const dt = TICK_MS / 1000;

  for (const s of sessions.values()) {
    try {
      stepSession(s, now, dt);
    } catch (err) {
      console.error(`[world] tick 异常 user=${s.username}:`, err);
    }
  }
}

function stepSession(s, now, dt) {
  const ch = s.ch;
  if (ch.hp <= 0) return; // 死亡处理在伤害里已做

  // ---- 1) 移动（玩家输入优先；没有输入但有攻击目标则自动靠近）
  let moving = false;
  if (s.moveDir) {
    moving = tryMove(s, s.moveDir[0], s.moveDir[1], dt);
    } else if (s.attackTargetId) {
    const m = s.monsterById(s.attackTargetId);
    if (m && !m.dead) {
      const d = dist(ch, m);
      if (d > ATTACK_RANGE * 0.9) {
        // 自动靠近目标时也要算作"在移动"，否则跑步动画不播，看着像平移
        moving = tryMove(s, (m.x - ch.x) / d, (m.y - ch.y) / d, dt);
      }
    }
  }
  ch.moving = moving;

  // ---- 2) 玩家攻击
  if (s.attackTargetId && now >= s.nextAttackAt) {
    const m = s.monsterById(s.attackTargetId);
    if (!m || m.dead) {
      s.attackTargetId = null;
    } else if (dist(ch, m) <= ATTACK_RANGE) {
      s.nextAttackAt = now + s.stats.attackCooldown;
      const res = computeDamage(s.stats, m);
      m.hp -= res.dmg;
      // attackerId 让客户端知道"谁出的手"，才能播放对应的砍杀/攻击动作
      s.out.combat.push({
        attackerId: 'player', targetId: m.id, targetType: 'monster',
        dmg: res.dmg, crit: res.crit, miss: res.miss,
        ax: ch.x, ay: ch.y, // 攻击者位置，客户端据此算动作朝向
      });

      if (m.hp <= 0) onMonsterDead(s, m, now);
    }
  }

  // ---- 3) 怪物 AI：攻击"最近的敌人"（玩家或宠物）——宠物能替主人挡刀
  for (const m of s.monsters) {
    const atk = updateMonster(
      m, s.map, { x: ch.x, y: ch.y, dead: ch.hp <= 0, stats: s.stats }, s.pets, now, dt,
    );
    if (!atk || atk.type !== 'attack') continue;

    s.out.combat.push({
      attackerId: m.id, targetId: atk.targetId, targetType: atk.targetType,
      dmg: atk.dmg, crit: atk.crit, miss: atk.miss, ax: m.x, ay: m.y,
    });
    if (atk.miss) continue;

    if (atk.targetType === 'player') {
      ch.hp -= atk.dmg;
      if (ch.hp <= 0) onPlayerDead(s, now);
    } else {
      // 打到的是宠物
      const pet = s.pets.find((p) => p.id === atk.targetId);
      if (pet && !pet.dead) {
        pet.hp -= atk.dmg;
        if (pet.hp <= 0) {
          pet.dead = true;
          s.out.messages.push({ text: '一只宠物被击倒了', kind: 'bad' });
        }
      }
    }
  }

  // ---- 4) 宠物 AI：自动索敌攻击；没怪就回到主人身边
  for (const pet of s.pets) {
    const res = updatePet(pet, ch, s.monsters, s.map, now, dt);
    if (!res || res.type !== 'attack') continue;
    const m = s.monsterById(res.targetId);
    if (!m || m.dead) continue;
    s.out.combat.push({
      attackerId: pet.id, targetId: m.id, targetType: 'monster',
      dmg: res.dmg, crit: res.crit, miss: res.miss, ax: pet.x, ay: pet.y,
    });
    if (!res.miss && res.dmg > 0) {
      m.hp -= res.dmg;
      if (m.hp <= 0) onMonsterDead(s, m, now);
    }
  }
  // 移除阵亡宠物
  if (s.pets.some((p) => p.dead)) s.pets = s.pets.filter((p) => !p.dead);

  // ---- 5) 自动拾取
  for (let i = s.drops.length - 1; i >= 0; i--) {
    const d = s.drops[i];
    if (Math.hypot(d.x - ch.x, d.y - ch.y) <= PICKUP_RANGE) {
      pickupDrop(s, d);
      s.drops.splice(i, 1);
    }
  }

  // ---- 6) 传送点
  if (s.map.id === ch.mapId) {
    const p = portalAt(s.map, ch.x, ch.y);
    if (p && !s.portalCooldown) {
      if (p.nextLayer) {
        // 闯关入口：必须先打穿本层魔王，否则只提示、不传送
        if (!s.ch.bossCleared) {
          if (now >= s.portalHintAt) {
            s.portalHintAt = now + 3000; // 节流，免得站在门口刷屏
            s.out.messages.push({
              text: `此门通往第 ${floorNo(s.ch.layer + 1, MAPS[0].id)} 层 —— 先击败本层魔王`,
              kind: 'bad',
            });
          }
          return;
        }
        advanceLayer(s);
        s.portalCooldown = true;
        setTimeout(() => { s.portalCooldown = false; }, 1500);
        return;
      }
      // 普通传送点：站上去即传送，并给一段冷却防止来回弹
      switchMap(s, p.to);
      s.portalCooldown = true;
      setTimeout(() => { s.portalCooldown = false; }, 1500);
      s.out.messages.push({ text: `传送到 ${MAP_BY_ID[p.to].name}`, kind: 'info' });
    }
  }
}

function tryMove(s, dx, dy, dt) {
  const ch = s.ch;
  const dist = PLAYER_BASE.moveSpeed * dt;
  const r = PLAYER_BASE.radius;

  // 兜底自救：万一存档里的坐标卡在障碍里，先挪出来，否则怎么走都走不动
  rescueIfStuck(s.map, ch, r);

  // 带滑行的移动：直着走 → 单轴滑 → 斜向撞墙角时偏一点绕过去
  const next = resolveMove(s.map, ch.x, ch.y, dx, dy, dist, r);
  if (!next) return false;

  ch.x = next.x;
  ch.y = next.y;
  ch.dir = [dx, dy];
  s.dirtySave = true; // 标记待存：saveDirty 每 10s 落盘一次，天然节流
  return true;
}

function onMonsterDead(s, m, now) {
  const tpl = MONSTERS[m.type];
  m.dead = true;
  m.hp = 0;
  m.respawnAt = now + tpl.respawn;
  s.save.stats.kills += 1;
  if (m.isBoss) {
    s.save.stats.bossKills += 1;
    // 本层魔王已击破 → 最右侧的闯关传送点放行。
    // 注意 Boss 30 秒后会复活，所以判据是"打通过一次"而不是"现在是否活着"，
    // 否则玩家只有 30 秒窗口能进下一层，太苛刻。
    s.ch.bossCleared = true;
  }

  // 经验与升级（经验随层数放大，保证深层数的成长能跟上怪物强度）
  const expGain = Math.round(tpl.exp * dropRewardMult(s.ch.layer));
  const leveled = gainExp(s.ch, expGain);
  if (leveled) {
    s.refreshStats();
    sse.send(s.username, 'levelup', {
      level: s.ch.level,
      stats: s.stats,
      hp: Math.round(s.ch.hp),
      mp: Math.round(s.ch.mp),
    });
    s.out.messages.push({ text: `升级！当前等级 ${s.ch.level}`, kind: 'good' });
    s.dirtySave = true;
  }

  // 掉落（金币与装备等级随层数放大，品质权重也随层数提升）
  const drops = rollDrops(tpl, s.map.def.difficulty, s.ch.layer);
  const got = [];
  for (const item of drops) {
    if (item.type === 'gold') {
      s.ch.gold += item.amount;
      got.push(`金币 x${item.amount}`);
      continue;
    }
    if (item.type === 'potion') {
      s.ch.potions[item.kind] = (s.ch.potions[item.kind] || 0) + item.count;
      got.push(`${POTIONS[item.kind].name} x${item.count}`);
      continue;
    }
    // 装备：优先进背包，满了就掉地上
    const slot = inventory.addItem(s.ch.inventory, item);
    if (slot >= 0) got.push(`${item.qualityName}·${item.name}`);
    else s.drops.push({ id: `d${now}_${Math.random().toString(36).slice(2, 7)}`, x: m.x, y: m.y, item });
  }

  if (got.length) {
    sse.send(s.username, 'loot', { items: got, gold: s.ch.gold });
  }
  pushInventory(s);
  s.dirtySave = true;
}

function onPlayerDead(s, now) {
  const ch = s.ch;
  ch.hp = 0;
  s.save.stats.deaths += 1;
  s.attackTargetId = null;
  s.moveDir = null;
  // 主人阵亡，召唤物一并消散（复活后需要重新召唤）
  const petCount = s.pets.length;
  s.pets.length = 0;
  if (petCount) {
    s.out.messages.push({ text: `主人阵亡，${petCount} 只宠物随之消散`, kind: 'bad' });
  }
  // 死亡惩罚：损失当前等级升级所需经验的 10%（不会掉级）
  const penalty = Math.floor(ch.exp * 0.1);
  ch.exp = Math.max(0, ch.exp - penalty);
  s.out.messages.push({ text: `你被击败了！损失 ${penalty} 经验`, kind: 'bad' });

  // 3 秒后在出生点满血复活
  setTimeout(() => {
    if (!sessions.has(s.username)) return;
    ch.x = s.map.def.spawn.x;
    ch.y = s.map.def.spawn.y;
    ch.hp = s.stats.maxHp;
    ch.mp = s.stats.maxMp;
    sse.send(s.username, 'revive', { hp: ch.hp, mp: ch.mp, x: ch.x, y: ch.y });
    pushInventory(s);
  }, 3000);

  s.dirtySave = true;
}

function pickupDrop(s, d) {
  const item = d.item;
  if (item.type === 'gold') {
    s.ch.gold += item.amount;
    s.out.messages.push({ text: `拾取金币 x${item.amount}`, kind: 'good' });
  } else if (item.type === 'potion') {
    s.ch.potions[item.kind] = (s.ch.potions[item.kind] || 0) + item.count;
    s.out.messages.push({ text: `拾取 ${POTIONS[item.kind].name} x${item.count}`, kind: 'good' });
  } else {
    const slot = inventory.addItem(s.ch.inventory, item);
    if (slot >= 0) s.out.messages.push({ text: `拾取 ${item.qualityName}·${item.name}`, kind: 'good' });
    else s.out.messages.push({ text: '背包已满', kind: 'bad' });
  }
  pushInventory(s);
  s.dirtySave = true;
}

// ------------------------------------------------------------------ 广播

function broadcastStates() {
  for (const s of sessions.values()) {
    const ch = s.ch;
    const snapshot = {
      tick: tickCount,
      player: {
        x: Math.round(ch.x * 100) / 100,
        y: Math.round(ch.y * 100) / 100,
        hp: Math.round(ch.hp),
        mp: Math.round(ch.mp),
        level: ch.level,
        exp: ch.exp,
        expNext: ch.expNext,
        gold: ch.gold,
        potions: ch.potions,
        dir: ch.dir || [0, 1],
        moving: !!ch.moving,
        dead: ch.hp <= 0,
        stats: s.stats,
      },
      monsters: s.monsters.map(toClient),
      pets: s.pets.map(petToClient),
      drops: s.drops.map(toClientDrop),
    };
    sse.send(s.username, 'state', snapshot);

    if (s.out.combat.length) {
      sse.send(s.username, 'combat', { events: s.out.combat });
      s.out.combat = [];
    }
    if (s.out.messages.length) {
      sse.send(s.username, 'message', { items: s.out.messages });
      s.out.messages = [];
    }
    if (s.out.loot.length) s.out.loot = [];
  }
}

// ------------------------------------------------------------------ 存档

async function saveDirty() {
  for (const s of sessions.values()) {
    if (!s.dirtySave) continue;
    s.dirtySave = false;
    try {
      await store.saveSave(s.username, s.save);
    } catch (e) {
      console.error(`[world] 存档失败 user=${s.username}:`, e);
    }
  }
}

async function saveAll() {
  for (const s of sessions.values()) {
    await store.saveSave(s.username, s.save);
    s.dirtySave = false;
  }
}

// ------------------------------------------------------------------ 启动

function startLoops() {
  setInterval(tick, TICK_MS);
  setInterval(broadcastStates, TICK_MS);
  setInterval(saveDirty, 10000);
  setInterval(cleanupIdleSessions, 60000); // 每分钟回收离线会话
}

module.exports = {
  sessions, getOrCreateSession, handleDisconnect, handleAction, buildInit,
  startLoops, saveAll, saveDirty, cleanupIdleSessions, MAPS_BUILT,
};
