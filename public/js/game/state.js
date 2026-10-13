'use strict';

/**
 * 客户端游戏状态。值全部来自服务端（服务端权威），这里只做缓存与插值。
 */

export const state = {
  // 登录
  token: null,
  username: null,
  connected: false,

  // 地图（静态，切换地图时整体替换）
  map: null,          // { mapId, name, w, h, tiles, def, portals }
  mapDef: null,

  // 玩家（服务端快照）
  player: null,       // { x, y, hp, mp, level, exp, expNext, gold, potions, stats, dead, moving, dir }
  // 渲染用插值坐标（避免 10Hz 的卡顿感）
  rx: 0, ry: 0,
  facing: 1,          // 1 = 朝右，-1 = 朝左

  monsters: [],       // 服务端快照数组
  monsterRender: new Map(), // id -> { x, y } 插值坐标

  pets: [],           // 自己召唤的宠物（服务端快照）
  petRender: new Map(), // id -> { x, y } 插值坐标

  drops: [],

  inventory: [],
  equipment: {},
  gold: 0,
  potions: { red: 0, blue: 0 },

  selectedId: null,   // 当前选中的怪物
  hoverId: null,

  floatTexts: [],     // 伤害飘字 { x, y, text, color, born, crit }
  messages: [],       // 系统滚动消息 { text, kind, born }
  fx: [],             // 技能特效（目前只有小火球飞行弹道）{ kind, x0,y0,x1,y1, born, flight }
  skillCastAt: 0,     // 本地记录上次施法时间，用来画冷却读条（服务端才是权威）

  // 动作动画：key = 'player' 或怪物 id → { kind, start, tx, ty }
  // kind: 'attack' 出手 | 'hurt' 受击；tx/ty 是动作朝向的目标点（世界坐标）
  anims: new Map(),

  lastTick: 0,
  mapName: '',
  layer: 1,           // 第几轮循环（怪物强度档位）
  floor: 1,           // 第几层（显示用，随地图连续递增）
  fuseCount: 3,       // 合成需要几件同品质装备（服务端下发）
};

/** 地图标题：带层号，例如「第 5 层 · 新手村」 */
export function mapTitle() {
  if (!state.mapName) return '';
  return `第 ${state.floor || 1} 层 · ${state.mapName}`;
}

/** 同步地图信息（init 与切图事件共用一处，避免两边写法不一致） */
export function setMap(name, floor, layer) {
  state.mapName = name || '';
  if (floor) state.floor = floor;
  if (layer) state.layer = layer;
}

export const ANIM = {
  ATTACK_MS: 300,   // 出手动时长
  HURT_MS: 180,     // 受击闪白时长
  CAST_MS: 420,     // 施法姿态时长（比挥砍略长，抬手蓄力更有"放技能"的感觉）
};

/** 各类动作的总时长 */
function animTotal(kind) {
  if (kind === 'attack') return ANIM.ATTACK_MS;
  if (kind === 'cast') return ANIM.CAST_MS;
  return ANIM.HURT_MS;
}

/**
 * 触发一个动作动画。同 key 重复触发会覆盖（连续攻击时重新计时）。
 * 内部按 "实体:动作类型" 存，所以同一实体可以同时处于"出手"和"受击"两个动作中。
 */
export function triggerAnim(key, kind, tx, ty) {
  state.anims.set(`${key}:${kind}`, { kind, start: performance.now(), tx, ty });
}

/**
 * 取某个实体的某个动作进度。
 * @returns {null | { kind, p, tx, ty }} p 为 0~1 的进度，过期自动清理
 */
export function animProgress(key, kind, now) {
  const a = state.anims.get(`${key}:${kind}`);
  if (!a) return null;
  const total = animTotal(a.kind);
  const t = now - a.start;
  if (t >= total) {
    state.anims.delete(key);
    return null;
  }
  return { kind: a.kind, p: t / total, tx: a.tx, ty: a.ty };
}

/**
 * 清理已过期的动画项。
 * animProgress 只在实体被渲染时才会顺手删除，若实体离开视口或中途消失，
 * 它残留的动画项就没人清理了 —— 这里做兜底，防止 Map 缓慢膨胀。
 */
export function cleanupAnims(now) {
  for (const [k, a] of state.anims) {
    if (now - a.start >= animTotal(a.kind)) state.anims.delete(k);
  }
}

/** 收到 init 时整体重建 */
export function applyInit(data) {
  state.map = data.map;
  state.mapDef = data.map.def;
  setMap(data.map.name, data.map.floor, data.map.layer);
  state.player = data.player;
  state.rx = data.player.x;
  state.ry = data.player.y;
  state.monsters = data.monsters;
  state.monsterRender.clear();
  for (const m of data.monsters) state.monsterRender.set(m.id, { x: m.x, y: m.y });
  state.pets = data.pets || [];
  state.petRender.clear();
  for (const p of state.pets) state.petRender.set(p.id, { x: p.x, y: p.y });
  state.drops = data.drops || [];
  state.inventory = data.inventory || [];
  state.equipment = data.equipment || {};
  state.gold = data.player.gold;
  state.potions = data.player.potions;
  state.connected = true;
  if (data.player.fuseCount) state.fuseCount = data.player.fuseCount;
}

/** 收到每 tick 的 state 快照 */
export function applySnapshot(data) {
  state.lastTick = data.tick;
  if (state.player) {
    state.player = { ...state.player, ...data.player };
  } else {
    state.player = data.player;
    state.rx = data.player.x;
    state.ry = data.player.y;
  }
  state.monsters = data.monsters;
  state.pets = data.pets || [];
  state.drops = data.drops;
  state.gold = data.player.gold;
  state.potions = data.player.potions;
}

export function addFloatText(x, y, text, color, crit = false) {
  state.floatTexts.push({ x, y, text, color, crit, born: performance.now() });
  // 限制数量，防止刷屏拖慢渲染
  if (state.floatTexts.length > 40) state.floatTexts.splice(0, state.floatTexts.length - 40);
}

export function addMessage(text, kind = 'info') {
  state.messages.push({ text, kind, born: performance.now() });
  if (state.messages.length > 6) state.messages.shift();
}

/**
 * 小火球的飞行弹道特效。
 * 纯表现：伤害在服务端已经结算完了，这里只负责"看起来像火球飞过去"。
 * @param {number} flight 飞行时长 ms（由服务端下发，和命中表现的延后时间对齐）
 */
export function addFireballFx(x0, y0, x1, y1, flight = 260) {
  state.fx.push({ kind: 'fireball', x0, y0, x1, y1, flight, born: performance.now() });
  if (state.fx.length > 30) state.fx.splice(0, state.fx.length - 30);
}

export function monsterById(id) {
  return state.monsters.find((m) => m.id === id) || null;
}
