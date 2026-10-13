'use strict';

/**
 * 全局数值与内容配置中心。
 * 调平衡只改这个文件，不要散落到各处。
 */

// 默认 8099：8080 常被开发机上的其它服务占用，可自行用 PORT 环境变量覆盖
const PORT = Number(process.env.PORT || 8099);

// ---------------------------------------------------------------- 角色基础属性
const PLAYER_BASE = {
  hp: 100, hpPerLevel: 20,
  mp: 30, mpPerLevel: 5,
  atk: 10, atkPerLevel: 3,
  def: 3, defPerLevel: 1,
  crit: 0.05,        // 暴击率，靠装备提升
  critDmg: 1.5,      // 暴击伤害倍率
  hit: 0.95,         // 命中
  dodge: 0.03,       // 闪避
  attackCooldown: 1000, // ms
  moveSpeed: 3.0,    // tile/秒
  radius: 0.3,       // 碰撞半径（tile 单位）
};

/**
 * 等级上限：设为无上限。
 * 无尽层数模式下如果仍然封顶 20 级，深层数会立刻变成"怪物越来越强、玩家原地踏步"的死局。
 * 经验曲线 expNext 不变，所以后面的等级会越来越慢，天然自带软性减速。
 */
const MAX_LEVEL = Infinity;

/** 升到下一级所需经验：expNext(level) = floor(50 * level^1.5) */
function expNext(level) {
  return Math.floor(50 * Math.pow(level, 1.5));
}

/** 按等级算出裸装基础属性（不含装备） */
function baseStatsByLevel(level) {
  const n = level - 1;
  return {
    maxHp: PLAYER_BASE.hp + n * PLAYER_BASE.hpPerLevel,
    maxMp: PLAYER_BASE.mp + n * PLAYER_BASE.mpPerLevel,
    atk: PLAYER_BASE.atk + n * PLAYER_BASE.atkPerLevel,
    def: PLAYER_BASE.def + n * PLAYER_BASE.defPerLevel,
    crit: PLAYER_BASE.crit,
    critDmg: PLAYER_BASE.critDmg,
    hit: PLAYER_BASE.hit,
    dodge: PLAYER_BASE.dodge,
  };
}

// ---------------------------------------------------------------- 药水
const POTIONS = {
  red: { name: '红药水', healHpPct: 0.40, healMpPct: 0, price: 30 },
  blue: { name: '蓝药水', healHpPct: 0, healMpPct: 0.40, price: 30 },
};
const POTION_COOLDOWN = 1500; // ms

// ---------------------------------------------------------------- 怪物模板
const MONSTERS = {
  // aggro = 主动追击半径（tile）。调小一点，避免被一群怪同时围殴。
  slime: { key: 'slime', name: '史莱姆', level: 1, hp: 22, atk: 4, def: 1, exp: 12, gold: [5, 10], aggro: 3.5, respawn: 4000 },
  wolf: { key: 'wolf', name: '森林狼', level: 3, hp: 70, atk: 11, def: 3, exp: 35, gold: [15, 30], aggro: 5, respawn: 5000 },
  boar: { key: 'boar', name: '白野猪', level: 4, hp: 115, atk: 16, def: 5, exp: 55, gold: [25, 50], aggro: 5, respawn: 6000 },
  skeleton: { key: 'skeleton', name: '骷髅兵', level: 6, hp: 160, atk: 22, def: 8, exp: 80, gold: [40, 80], aggro: 5, respawn: 7000 },
  orc: { key: 'orc', name: '半兽人', level: 8, hp: 300, atk: 34, def: 14, exp: 165, gold: [90, 160], aggro: 6, respawn: 9000 },
  boss: { key: 'boss', name: '洞穴魔王', level: 10, hp: 800, atk: 50, def: 20, exp: 500, gold: [200, 400], aggro: 7, respawn: 30000, isBoss: true },
};

// ---------------------------------------------------------------- 召唤宠物
/**
 * 召唤宠物：玩家用「召唤」技能召出的友方单位。
 * 会自动跟随主人、攻击附近怪物，也会被怪物攻击（能替主人挡刀）。
 * 调宠物强度只改这里。
 */
const PETS = {
  max: 8,               // 同时存在上限
  mpCost: 1,            // 每召唤一只消耗的魔法值
  hp: 40,               // 基础生命
  hpPerLevel: 12,       // 主人每提升 1 级，宠物额外获得的生命
  atkRatio: 0.6,        // 攻击力 = 主人攻击力 × 该系数
  attackCooldown: 900,  // 攻击间隔 ms
  attackRange: 1.0,     // 攻击距离 tile
  aggroRange: 6,        // 索敌半径 tile；范围内没怪就回来跟随主人
  moveSpeed: 3.4,       // 移动速度 tile/秒（略快于玩家，便于跟上）
  followGap: 1.2,       // 跟随时与主人保持的间距，避免全叠在主人身上
  standGap: 0.6,        // 攻击时围绕目标站开的半径，避免 8 只宠物挤成一坨
  summonGap: 1.0,       // 召唤时在主人周围散开的半径
  radius: 0.25,
};

// ---------------------------------------------------------------- 装备
const SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const SLOT_NAMES = { weapon: '武器', head: '头盔', armor: '衣服', boots: '鞋子', accessory: '饰品' };

const QUALITIES = {
  white: { key: 'white', name: '普通', color: '#d8d8d8', weight: 70, affixes: 0, mult: 1.0 },
  blue: { key: 'blue', name: '精良', color: '#4fa3ff', weight: 22, affixes: 1, mult: 1.2 },
  purple: { key: 'purple', name: '稀有', color: '#c061ff', weight: 7, affixes: 2, mult: 1.5 },
  orange: { key: 'orange', name: '史诗', color: '#ffa03c', weight: 1, affixes: 3, mult: 2.0 },
};

/** 品质由低到高的顺序。合成时按这张表往上升一阶（最后一级不能再升） */
const QUALITY_ORDER = ['white', 'blue', 'purple', 'orange'];

/** 取 key 的下一阶品质；已是最高（或非法）则返回 null */
function nextQuality(key) {
  const i = QUALITY_ORDER.indexOf(key);
  if (i < 0 || i >= QUALITY_ORDER.length - 1) return null;
  return QUALITY_ORDER[i + 1];
}

/** 各部位的基础属性（乘以品质系数，再按装备等级缩放） */
const SLOT_BASE = {
  weapon: { atk: 5, atkPerLevel: 1.0 },
  head: { def: 2, defPerLevel: 0.4, hp: 8, hpPerLevel: 1.5 },
  armor: { def: 3, defPerLevel: 0.6, hp: 10, hpPerLevel: 2.0 },
  boots: { def: 1, defPerLevel: 0.3, dodge: 0.01, dodgePerLevel: 0.002 },
  accessory: { atk: 2, atkPerLevel: 0.5, crit: 0.01, critPerLevel: 0.002 },
};

const ITEM_NAMES = {
  weapon: ['木剑', '铁剑', '钢刀', '精铁长剑', '寒光剑'],
  head: ['皮帽', '铁盔', '精钢盔', '龙鳞盔', '战神盔'],
  armor: ['布衣', '皮甲', '锁子甲', '精铁铠', '龙鳞铠'],
  boots: ['草鞋', '皮靴', '铁靴', '疾风靴', '踏云靴'],
  accessory: ['铜戒', '银戒', '玉佩', '力量指环', '战神勋章'],
};

/** 词条池：stat=属性名, min/max=数值区间 */
const AFFIX_POOL = [
  { stat: 'atk', label: '攻击', min: 1, max: 4, pct: false },
  { stat: 'def', label: '防御', min: 1, max: 3, pct: false },
  { stat: 'maxHp', label: '生命', min: 8, max: 25, pct: false },
  { stat: 'maxMp', label: '魔法', min: 4, max: 12, pct: false },
  { stat: 'crit', label: '暴击率', min: 0.01, max: 0.03, pct: true },
  { stat: 'hit', label: '命中', min: 0.01, max: 0.03, pct: true },
  { stat: 'dodge', label: '闪避', min: 0.01, max: 0.02, pct: true },
  { stat: 'haste', label: '攻速', min: 40, max: 90, pct: false }, // 减少冷却 ms
];

const DROP_RATES = {
  equipment: 0.35,  // 掉落装备的概率
  potion: 0.30,     // 掉落药水的概率（金币必然掉）
  potionAmount: [1, 2],
};

// ---------------------------------------------------------------- 合成
/**
 * 装备合成：几件**同品质**装备合成一件**高一阶品质**的。
 *
 * 这是背包里垃圾装备的消耗口（早先版本是"卖出换金币"，后来改成了合成）。
 * 产出沿用"参与装备里等级最高那件"的部位与名称，等级再 +levelBonus，
 * 词条沿用并补齐到新品质应有的条数 —— 也就是说越合越强，且不会把原有词条洗掉。
 *
 * 想改手感就动这两个数：count 越大越难凑、levelBonus 越大升级越快。
 */
const FUSE = {
  count: 3,        // 需要几件同品质装备（含被点击的那件）
  levelBonus: 1,   // 产出等级 = 参与装备中的最高等级 + levelBonus
};

// ---------------------------------------------------------------- 主动技能
/**
 * 技能全部由服务端结算，客户端只负责按键与表现。
 * 调平衡改这里，别散落到各处。
 *
 * 小火球的定位：**远程**（射程远大于普通攻击的 1.4 格）+ 落点小范围溅射，
 * 代价是耗蓝和冷却。伤害用的是和普通攻击同一套公式，只是攻击力乘了个倍率，
 * 所以装备越好、技能收益越高（和普通攻击同步成长，不会后期变成摆设）。
 */
const SKILLS = {
  fireball: {
    key: 'fireball',
    name: '小火球',
    hotkey: 'F',
    mpCost: 4,          // 耗蓝
    cooldown: 2500,     // 冷却（ms）
    range: 6.0,         // 施法距离（tile）
    damageMult: 2.0,    // 伤害 = 攻击 × 倍率 - 目标防御 / 2
    splashRadius: 1.3,  // 落点溅射半径（tile）；设为 0 就是纯单体技能
    splashRatio: 0.5,   // 溅射伤害占主目标的比例
    flightMs: 260,      // 表现用：火球飞行时长，客户端据此延后命中特效与飘字
  },
};

/** 下发给客户端的技能面板数据（只给表现需要的字段，不含伤害公式） */
function publicSkills() {
  return Object.values(SKILLS).map((k) => ({
    key: k.key,
    name: k.name,
    hotkey: k.hotkey,
    mpCost: k.mpCost,
    cooldown: k.cooldown,
    flightMs: k.flightMs,
  }));
}

// ---------------------------------------------------------------- 地图
const TILE = { EMPTY: 0, WALL: 1, PORTAL: 2 };

/**
 * 地图定义。tiles 用程序化生成（见 map.js），这里只声明尺寸与内容参数。
 * difficulty 影响掉落品质权重：越高越容易出紫橙。
 *
 * ★ 传送点**不要放在最外圈的边界格上**（x=0 / y=0 / x=w-1 / y=h-1）。
 *   边界格本身是墙，传送点会把它覆盖掉，但传送点上下（或左右）的邻居仍是墙：
 *   碰撞圆半径 0.3，想站进这一列，圆心必须落在 0.4 宽的窗口里 ——
 *   玩家只要没正好对齐那一行/列，就永远走不进去，表现为"走到边缘被卡住"。
 *   往里挪一格（x=1 / y=1 之类）就完全没这个问题，走到底自然踩上。
 */
const MAPS = [
  {
    id: 'village', name: '新手村', w: 40, h: 30, difficulty: 0,
    ground: '#3f6b3a', groundAlt: '#47773f', wallColor: '#6b5334', wallTop: '#8a6b45',
    spawn: { x: 20, y: 15 },
    obstacleDensity: 0.05,
    clusterDensity: 0.007,
    monsterSpawns: [
      { type: 'slime', x: 10, y: 8, count: 5 },
      { type: 'slime', x: 30, y: 20, count: 5 },
      { type: 'slime', x: 20, y: 24, count: 4 },
    ],
    portals: [{ x: 38, y: 15, to: 'grassland' }],
  },
  {
    id: 'grassland', name: '草原', w: 48, h: 36, difficulty: 1,
    ground: '#4a7a3c', groundAlt: '#538544', wallColor: '#5d4a2e', wallTop: '#7a6240',
    spawn: { x: 2, y: 18 },
    obstacleDensity: 0.07,
    clusterDensity: 0.009,
    monsterSpawns: [
      { type: 'slime', x: 16, y: 10, count: 5 },
      { type: 'wolf', x: 30, y: 14, count: 5 },
      { type: 'boar', x: 34, y: 26, count: 4 },
      { type: 'boar', x: 12, y: 28, count: 4 },
      { type: 'wolf', x: 40, y: 8, count: 4 },
    ],
    portals: [{ x: 1, y: 18, to: 'village' }, { x: 46, y: 18, to: 'forest' }],
  },
  {
    id: 'forest', name: '幽暗森林', w: 52, h: 38, difficulty: 2,
    ground: '#2f5233', groundAlt: '#365c3a', wallColor: '#3d3226', wallTop: '#54462f',
    spawn: { x: 2, y: 19 },
    obstacleDensity: 0.11,
    clusterDensity: 0.011,
    monsterSpawns: [
      { type: 'wolf', x: 16, y: 12, count: 5 },
      { type: 'boar', x: 28, y: 8, count: 4 },
      { type: 'skeleton', x: 30, y: 16, count: 5 },
      { type: 'orc', x: 42, y: 10, count: 4 },
      { type: 'orc', x: 24, y: 30, count: 4 },
      { type: 'skeleton', x: 40, y: 28, count: 5 },
    ],
    portals: [{ x: 1, y: 19, to: 'grassland' }, { x: 50, y: 19, to: 'cave' }],
  },
  {
    id: 'cave', name: '魔王洞穴', w: 44, h: 32, difficulty: 3,
    ground: '#3a3540', groundAlt: '#423d4a', wallColor: '#2a2730', wallTop: '#3b3745',
    spawn: { x: 2, y: 16 },
    obstacleDensity: 0.10,
    clusterDensity: 0.010,
    monsterSpawns: [
      { type: 'skeleton', x: 16, y: 10, count: 5 },
      { type: 'orc', x: 18, y: 22, count: 5 },
      { type: 'orc', x: 28, y: 10, count: 4 },
      { type: 'skeleton', x: 30, y: 24, count: 5 },
      { type: 'boss', x: 36, y: 16, count: 1 },
    ],
    portals: [
      { x: 1, y: 16, to: 'forest' },
      // 闯关入口：打完本层魔王后走到最右侧即可进入下一层（回到新手村重跑一遍）
      { x: 42, y: 16, to: 'village', nextLayer: true },
    ],
  },
];

const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));

/**
 * 层号（显示用）：把「循环次数 + 当前地图」折算成一个连续递增的层号。
 *
 *   第 1 层 = 新手村   第 2 层 = 草原   第 3 层 = 幽暗森林   第 4 层 = 魔王洞穴(BOSS)
 *   第 5 层 = 新手村   第 6 层 = 草原   ... 第 8 层 = 魔王洞穴(BOSS) → 如此循环
 *
 * 所以「第 N 层」和「第 N + 地图数 层」是同一张地图，但数值按循环次数更强。
 * 层号是算出来的、不单独存，避免存档里的层号和实际所在地图对不上。
 *
 * @param {number} layer    第几轮循环（从 1 开始，1 = 原始数值）
 * @param {string} mapId    当前地图 id
 */
function floorNo(layer, mapId) {
  const idx = MAPS.findIndex((m) => m.id === mapId);
  return (Math.max(1, Math.floor(Number(layer) || 1)) - 1) * MAPS.length + (idx < 0 ? 1 : idx + 1);
}

/** 一个循环有多少层（= 地图数量），BOSS 出现在每个循环的最后一层 */
const FLOORS_PER_CYCLE = MAPS.length;

// ---------------------------------------------------------------- 无尽层数（闯关）
/**
 * 每往下一层，怪物强度与奖励的成长率。
 *
 * 用「加法」而不是「复利」：第 layer 层的系数 = 1 + rate × (layer - 1)。
 * 原因：玩家属性随等级是线性成长（每级 +20 血 / +3 攻），复利会指数级甩开玩家，
 * 十来层就直接变成死局；加法下玩家靠升级 + 刷装备能一直跟上。
 *
 * 以标准档为例：第 5 层怪是 2.6 倍血 / 2.2 倍攻，第 10 层是 4.6 倍血 / 3.7 倍攻。
 */
const LAYER = {
  hp: 0.40,       // 每层血量 +40%
  atk: 0.30,      // 每层攻击 +30%
  def: 0.25,      // 每层防御 +25%（防御在伤害公式里只按一半抵扣，所以可以给得比攻击高）
  reward: 0.60,   // 每层经验 / 金币 +60%
  levelPer: 2,    // 每层怪物等级 +2（决定显示等级与掉落装备等级）
  dropCap: 6,     // 掉落品质难度的层数加成上限，避免深层数永远只掉橙装、毫无惊喜
};

/** 第 layer 层的成长系数：layer=1 时恒为 1（即原始数值） */
function layerScale(layer, rate) {
  return 1 + Math.max(0, (Number(layer) || 1) - 1) * rate;
}

/** 第 layer 层怪物的等效等级（用于显示与掉落） */
function layerMonsterLevel(baseLevel, layer) {
  return baseLevel + Math.max(0, (Number(layer) || 1) - 1) * LAYER.levelPer;
}

// ---------------------------------------------------------------- 世界
const TICK_MS = 100;          // 服务端模拟步长（10Hz）
const AUTOSAVE_MS = 30000;    // 自动存档间隔
const BAG_SIZE = 24;          // 背包格数
// ★ 拾取半径必须 > 攻击距离，否则打死怪后掉落物落在怪脚下，玩家站着捡不到
const PICKUP_RANGE = 1.8;     // 自动拾取半径（tile）
const ATTACK_RANGE = 1.4;     // 玩家攻击距离（tile）
const MONSTER_ATTACK_RANGE = 1.2;

module.exports = {
  PORT, PLAYER_BASE, MAX_LEVEL, expNext, baseStatsByLevel,
  POTIONS, POTION_COOLDOWN,
  MONSTERS, PETS, SLOTS, SLOT_NAMES, QUALITIES, QUALITY_ORDER, nextQuality,
  SLOT_BASE, ITEM_NAMES, AFFIX_POOL, DROP_RATES, FUSE,
  SKILLS, publicSkills,
  TILE, MAPS, MAP_BY_ID,
  LAYER, layerScale, layerMonsterLevel,
  floorNo, FLOORS_PER_CYCLE,
  TICK_MS, AUTOSAVE_MS, BAG_SIZE, PICKUP_RANGE, ATTACK_RANGE, MONSTER_ATTACK_RANGE,
};
