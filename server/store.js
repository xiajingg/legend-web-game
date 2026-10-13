'use strict';

/**
 * 持久化层：账号表 + 每个玩家一份存档。
 * 用 JSON 文件 + 临时文件 rename 原子写，避免"写一半崩溃导致存档损坏"。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { MAP_BY_ID, MAX_LEVEL, expNext, baseStatsByLevel, SLOTS } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

let accounts = {}; // username -> { salt, pwHash, createdAt }

// ------------------------------------------------------------------ 底层工具

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SAVES_DIR, { recursive: true });
}

/** 原子写：先写 .tmp 再 rename，同文件系统上 rename 是原子操作 */
async function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 读取 JSON，损坏则回退 .bak，都没有就返回 null */
async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    try {
      const bak = JSON.parse(await fs.readFile(file + '.bak', 'utf8'));
      console.warn(`[store] ${path.basename(file)} 损坏，已从 .bak 恢复`);
      return bak;
    } catch (_) {
      return null;
    }
  }
}

function saveFile(username) {
  // 用户名已做 [a-zA-Z0-9_] 校验，可安全用于文件名
  return path.join(SAVES_DIR, `${username}.json`);
}

// ------------------------------------------------------------------ 账号

async function loadAccounts() {
  await ensureDirs();
  accounts = (await readJsonSafe(ACCOUNTS_FILE)) || {};
}

async function saveAccounts() {
  await atomicWrite(ACCOUNTS_FILE, accounts);
}

function getAccount(username) {
  return accounts[username] || null;
}

async function putAccount(username, saltHex, pwHashHex) {
  accounts[username] = { salt: saltHex, pwHash: pwHashHex, createdAt: Date.now() };
  await saveAccounts();
}

// ------------------------------------------------------------------ 存档

/** 创建一个新角色的存档 */
function newSave(username) {
  const base = baseStatsByLevel(1);
  const startMap = MAP_BY_ID.village;
  return {
    username,
    version: 1,
    updatedAt: Date.now(),
    character: {
      level: 1,
      exp: 0,
      expNext: expNext(1),
      hp: base.maxHp,
      mp: base.maxMp,
      mapId: startMap.id,
      x: startMap.spawn.x,
      y: startMap.spawn.y,
      gold: 100,
      potions: { red: 5, blue: 3 },
      equipment: Object.fromEntries(SLOTS.map((s) => [s, null])),
      inventory: new Array(24).fill(null),
      dir: [0, 1], // 朝向（世界空间向量）
      layer: 1,          // 无尽闯关：第几轮循环（1 = 原始数值）
      bossCleared: false, // 本轮循环的魔王是否已被打穿（决定闯关传送门是否放行）
    },
    stats: { kills: 0, deaths: 0, bossKills: 0 },
  };
}

async function loadSave(username) {
  await ensureDirs();
  const save = await readJsonSafe(saveFile(username));
  if (!save) {
    const fresh = newSave(username);
    await saveSave(username, fresh);
    return fresh;
  }
  // 兼容旧档 / 结构补全，避免缺字段导致崩溃
  const fresh = newSave(username);
  const merged = {
    ...fresh,
    ...save,
    character: { ...fresh.character, ...(save.character || {}) },
    stats: { ...fresh.stats, ...(save.stats || {}) },
  };
  // 数据迁移：无尽闯关上线前没有"层"的概念，老存档里 bossCleared 是缺失的。
  // 如果这个玩家历史上已经打穿过魔王，就认为当前循环的魔王已清 ——
  // 否则会被要求把同一个魔王再刷一遍（事实上他已经打穿过了）。
  if (!save.character || save.character.bossCleared === undefined) {
    merged.character.bossCleared = ((save.stats && save.stats.bossKills) || 0) > 0;
  }
  return merged;
}

async function saveSave(username, save) {
  await ensureDirs();
  save.updatedAt = Date.now();
  const file = saveFile(username);
  // 写之前把现存的好存档留一份 .bak
  try {
    const cur = await fs.readFile(file, 'utf8');
    await fs.writeFile(file + '.bak', cur, 'utf8');
  } catch (_) { /* 首次存档没有旧文件，忽略 */ }
  await atomicWrite(file, save);
}

/** 排行榜：扫全部存档文件，按等级降序、经验降序 */
async function leaderboard(top = 20) {
  await ensureDirs();
  const list = [];
  let names = [];
  try {
    names = (await fs.readdir(SAVES_DIR)).filter((f) => f.endsWith('.json'));
  } catch (_) { /* 目录不存在时返回空榜 */ }

  for (const f of names) {
    const save = await readJsonSafe(path.join(SAVES_DIR, f));
    if (!save || !save.character) continue;
    list.push({
      username: save.username,
      level: save.character.level || 1,
      exp: save.character.exp || 0,
      kills: (save.stats && save.stats.kills) || 0,
    });
  }
  list.sort((a, b) => b.level - a.level || b.exp - a.exp);
  return list.slice(0, top);
}

module.exports = {
  loadAccounts, saveAccounts, getAccount, putAccount,
  loadSave, saveSave, newSave, leaderboard,
  DATA_DIR, SAVES_DIR,
};
