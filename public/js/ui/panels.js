'use strict';

/**
 * DOM 覆盖层 UI：顶部状态条、底部快捷栏、背包 / 角色 / 排行榜面板。
 * 用 DOM 而非 Canvas，交互更稳、文字更清晰，同样零素材。
 */

import { state, addMessage, mapTitle } from '../game/state.js';
import * as net from '../net.js';

const SLOT_LABELS = { weapon: '武器', head: '头盔', armor: '衣服', boots: '鞋子', accessory: '饰品' };
const SLOT_ORDER = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const PCT_STATS = { crit: 1, hit: 1, dodge: 1 };

let els = {};
const open = { bag: false, char: false, rank: false };

export function initPanels() {
  els = {
    hpFill: document.getElementById('hpFill'),
    hpText: document.getElementById('hpText'),
    mpFill: document.getElementById('mpFill'),
    mpText: document.getElementById('mpText'),
    expFill: document.getElementById('expFill'),
    expText: document.getElementById('expText'),
    lvText: document.getElementById('lvText'),
    goldText: document.getElementById('goldText'),
    mapText: document.getElementById('mapText'),
    redCount: document.getElementById('redCount'),
    blueCount: document.getElementById('blueCount'),
    bagPanel: document.getElementById('bagPanel'),
    bagGrid: document.getElementById('bagGrid'),
    charPanel: document.getElementById('charPanel'),
    equipGrid: document.getElementById('equipGrid'),
    statList: document.getElementById('statList'),
    rankPanel: document.getElementById('rankPanel'),
    rankList: document.getElementById('rankList'),
    tooltip: document.getElementById('tooltip'),
    connDot: document.getElementById('connDot'),
    slotFireball: document.getElementById('slotFireball'),
    fireballCd: document.getElementById('fireballCd'),
    fireballCost: document.getElementById('fireballCost'),
    petCount: document.getElementById('petCount'),
  };

  // 面板关闭按钮
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => toggle(btn.dataset.close));
  });
  // 底部快捷栏的面板开关按钮
  document.querySelectorAll('[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => toggle(btn.dataset.panel));
  });
  // 底部快捷栏
  document.getElementById('slotRed').addEventListener('click', () => net.send({ type: 'useItem', kind: 'red' }));
  document.getElementById('slotBlue').addEventListener('click', () => net.send({ type: 'useItem', kind: 'blue' }));
  // 技能槽：点一下也能放（键盘 F 是同一个意图）
  const fireball = document.getElementById('slotFireball');
  if (fireball) fireball.addEventListener('click', () => castSkill('fireball'));
  // 召唤 / 解散宝宝：和键盘 Q / E 走同一条路径
  const summon = document.getElementById('slotSummon');
  if (summon) summon.addEventListener('click', () => net.send({ type: 'summonPet' }));
  const dismiss = document.getElementById('slotDismiss');
  if (dismiss) dismiss.addEventListener('click', () => net.send({ type: 'dismissPets' }));
}

/** 释放技能：和键盘 F 走同一条路径，避免两个入口行为不一致 */
export function castSkill(key) {
  net.send({ type: 'castSkill', skill: key });
  state.skillCastAt = performance.now(); // 本地立即进冷却，避免连按刷屏报错
}

// ------------------------------------------------------------------ 顶部 HUD

export function updateHud() {
  const p = state.player;
  if (!p || !els.hpFill) return;
  const st = p.stats || {};

  const hpPct = Math.max(0, Math.min(1, p.hp / (st.maxHp || 1)));
  els.hpFill.style.width = `${hpPct * 100}%`;
  els.hpText.textContent = `${Math.max(0, Math.round(p.hp))} / ${st.maxHp || 0}`;

  const mpPct = Math.max(0, Math.min(1, p.mp / (st.maxMp || 1)));
  els.mpFill.style.width = `${mpPct * 100}%`;
  els.mpText.textContent = `${Math.max(0, Math.round(p.mp))} / ${st.maxMp || 0}`;

  const expPct = p.expNext > 0 ? Math.max(0, Math.min(1, p.exp / p.expNext)) : 1;
  els.expFill.style.width = `${expPct * 100}%`;
  els.expText.textContent = p.expNext > 0 ? `${p.exp} / ${p.expNext}` : '已满级';

  els.lvText.textContent = `Lv ${p.level}`;
  els.goldText.textContent = p.gold;
  els.mapText.textContent = mapTitle();
  els.redCount.textContent = (p.potions && p.potions.red) || 0;
  els.blueCount.textContent = (p.potions && p.potions.blue) || 0;
  if (els.connDot) els.connDot.className = state.connected ? 'dot ok' : 'dot bad';

  // 技能槽：冷却读条（自下而上退去）+ 蓝不够时压暗
  const sk = (p.skills || []).find((k) => k.key === 'fireball');
  if (els.fireballCd && sk) {
    const left = Math.max(0, 1 - (performance.now() - (state.skillCastAt || 0)) / sk.cooldown);
    els.fireballCd.style.height = `${(left * 100).toFixed(1)}%`;
    const poor = (p.mp || 0) < sk.mpCost;
    els.slotFireball.classList.toggle('no-mp', poor);
    if (els.fireballCost) {
      els.fireballCost.textContent = sk.mpCost;
      els.fireballCost.style.color = poor ? '#e04a4a' : '#6fb6ff';
    }
  }

  // 召唤槽上的宠物数量：有宝宝时金色高亮
  if (els.petCount) {
    const pets = (state.pets || []).length;
    const max = p.petMax || 8;
    els.petCount.textContent = `${pets}/${max}`;
    els.petCount.classList.toggle('has-pets', pets > 0);
  }
}

// ------------------------------------------------------------------ 面板开关

export function toggle(name) {
  open[name] = !open[name];
  syncPanels();
}

export function closeAll() {
  Object.keys(open).forEach((k) => { open[k] = false; });
  syncPanels();
}

export function anyOpen() {
  return Object.values(open).some(Boolean);
}

function syncPanels() {
  els.bagPanel.classList.toggle('hidden', !open.bag);
  els.charPanel.classList.toggle('hidden', !open.char);
  els.rankPanel.classList.toggle('hidden', !open.rank);
  if (open.bag) renderBag();
  if (open.char) renderChar();
  if (open.rank) loadRank();
}

// ------------------------------------------------------------------ 背包

export function renderBag() {
  if (!els.bagGrid) return;
  const inv = state.inventory || [];
  els.bagGrid.innerHTML = '';

  for (let i = 0; i < 24; i++) {
    const item = inv[i];
    const cell = document.createElement('div');
    cell.className = 'bag-cell';
    if (item) {
      cell.classList.add('has-item');
      if (item.type === 'equipment') {
        cell.style.borderColor = item.color;
        cell.innerHTML = `<span class="item-name" style="color:${item.color}">${escapeHtml(item.name)}</span>`
          + `<span class="item-sub">Lv${item.level}</span>`;
        cell.title = '';
        cell.addEventListener('click', () => net.send({ type: 'equip', itemId: item.id }));
        cell.addEventListener('mouseenter', (e) => showTooltip(e, item));
        cell.addEventListener('mouseleave', hideTooltip);
      } else if (item.type === 'potion') {
        const color = item.kind === 'red' ? '#ff6b6b' : '#4a8cff';
        const label = item.kind === 'red' ? '红药水' : '蓝药水';
        cell.style.borderColor = color;
        cell.innerHTML = `<span class="item-name" style="color:${color}">${label}</span>`
          + `<span class="item-sub">x${item.count}</span>`;
      }
      // 合成：点格子是"穿戴"，点底部角标才是"合成"，避免误操作
      if (item.type === 'equipment') cell.appendChild(makeFuseButton(item, inv));
    }
    els.bagGrid.appendChild(cell);
  }
}

/** 背包里与 item 同品质的装备数量（合成材料够不够，前端先算一遍用于置灰） */
function countSameQuality(inv, item) {
  if (!item || item.type !== 'equipment') return 0;
  return inv.filter((it) => it && it.type === 'equipment' && it.quality === item.quality).length;
}

const QUALITY_TOP = 'orange'; // 最高品质，不能再往上合

/**
 * 背包格底部的"合成"角标。
 * 规则由服务端决定（FUSE.count 件同品质 → 高一阶品质），
 * 前端只负责：算还差几件、凑不齐时置灰、以及发指令。
 */
function makeFuseButton(item, inv) {
  const need = state.fuseCount || 3;
  const have = countSameQuality(inv, item);
  const isTop = item.quality === QUALITY_TOP;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fuse-btn';
  // 材料够了就只显示"合成"，不够才显示还差几件（"4/3"这种看着像分数，容易误读）
  btn.textContent = isTop ? '满级' : (have >= need ? '合成' : `合成 ${have}/${need}`);
  btn.classList.toggle('no-mat', !isTop && have < need);
  btn.classList.toggle('ready', !isTop && have >= need);
  btn.title = isTop
    ? '已是最高品质（史诗），无法继续合成'
    : (have >= need
      ? `消耗 ${need} 件${item.qualityName}装备，合成一件更高品质`
      : `需要 ${need} 件同品质装备（当前 ${have} 件）`);
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); // 关键：别冒泡给格子，否则会顺带把装备穿上
    net.send({ type: 'fuseItem', itemId: item.id });
  });
  return btn;
}

// ------------------------------------------------------------------ 角色面板

export function renderChar() {
  if (!els.equipGrid) return;

  // 装备栏
  els.equipGrid.innerHTML = '';
  for (const slot of SLOT_ORDER) {
    const item = state.equipment && state.equipment[slot];
    const cell = document.createElement('div');
    cell.className = 'equip-cell';
    if (item) {
      cell.style.borderColor = item.color;
      cell.innerHTML = `<div class="equip-slot-label">${SLOT_LABELS[slot]}</div>`
        + `<div class="equip-name" style="color:${item.color}">${escapeHtml(item.name)}</div>`
        + `<div class="equip-sub">Lv${item.level}</div>`;
      cell.addEventListener('click', () => net.send({ type: 'unequip', slot }));
      cell.addEventListener('mouseenter', (e) => showTooltip(e, item));
      cell.addEventListener('mouseleave', hideTooltip);
    } else {
      cell.innerHTML = `<div class="equip-slot-label">${SLOT_LABELS[slot]}</div>`
        + '<div class="equip-empty">空</div>';
    }
    els.equipGrid.appendChild(cell);
  }

  // 属性
  const st = (state.player && state.player.stats) || {};
  const rows = [
    ['生命上限', st.maxHp],
    ['魔法上限', st.maxMp],
    ['攻击', st.atk],
    ['防御', st.def],
    ['暴击率', `${((st.crit || 0) * 100).toFixed(1)}%`],
    ['暴击伤害', `${((st.critDmg || 1.5) * 100).toFixed(0)}%`],
    ['命中', `${((st.hit || 0) * 100).toFixed(0)}%`],
    ['闪避', `${((st.dodge || 0) * 100).toFixed(1)}%`],
    ['攻击间隔', `${((st.attackCooldown || 1000) / 1000).toFixed(2)}s`],
  ];
  els.statList.innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ------------------------------------------------------------------ 排行榜

async function loadRank() {
  if (!els.rankList) return;
  els.rankList.innerHTML = '<div class="loading">加载中...</div>';
  try {
    const data = await net.api('/api/leaderboard?top=20');
    const list = data.list || [];
    els.rankList.innerHTML = `
      <div class="rank-row head"><span>#</span><span>玩家</span><span>等级</span><span>击杀</span></div>
      ${list.map((u, i) => `<div class="rank-row${u.username === state.username ? ' me' : ''}">
        <span>${i + 1}</span><span>${escapeHtml(u.username)}</span><span>Lv${u.level}</span><span>${u.kills}</span>
      </div>`).join('')}
    `;
  } catch (_) {
    els.rankList.innerHTML = '<div class="loading">加载失败</div>';
  }
}

// ------------------------------------------------------------------ 物品悬浮说明

function showTooltip(e, item) {
  if (!els.tooltip) return;
  const lines = [];
  lines.push(`<div class="tt-title" style="color:${item.color}">${escapeHtml(item.name)}</div>`);
  lines.push(`<div class="tt-sub">${item.qualityName || ''} · ${SLOT_LABELS[item.slot] || ''} · Lv${item.level}</div>`);
  for (const [k, v] of Object.entries(item.attrs || {})) {
    lines.push(`<div class="tt-line">${formatStat(k, v)}</div>`);
  }
  for (const a of item.affixes || []) {
    lines.push(`<div class="tt-line affix">${formatStat(a.stat, a.value)}</div>`);
  }
  if (item.type === 'equipment') {
    // 与身上正在穿的同部位装备做对比（换装的净收益 = 新 − 旧）
    lines.push(...compareLines(item));
    const need = state.fuseCount || 3;
    if (item.quality === QUALITY_TOP) {
      lines.push('<div class="tt-line fuse">已是最高品质，无法继续合成</div>');
    } else {
      lines.push(`<div class="tt-line fuse">可合成：${need} 件${item.qualityName} → 更高一阶品质</div>`);
    }
  }
  els.tooltip.innerHTML = lines.join('');
  els.tooltip.classList.remove('hidden');
  const rect = e.currentTarget.getBoundingClientRect();
  els.tooltip.style.left = `${Math.min(window.innerWidth - 220, rect.right + 8)}px`;
  els.tooltip.style.top = `${rect.top}px`;
}

function hideTooltip() {
  if (els.tooltip) els.tooltip.classList.add('hidden');
}

const STAT_NAMES = {
  atk: '攻击', def: '防御', maxHp: '生命', maxMp: '魔法',
  crit: '暴击率', hit: '命中', dodge: '闪避', haste: '攻击间隔',
};

/** 对比时属性的显示顺序（固定顺序才不会每次打开都跳） */
const CMP_ORDER = ['atk', 'def', 'maxHp', 'maxMp', 'crit', 'hit', 'dodge', 'haste'];

/**
 * 一件装备的"属性合计"：基础属性 + 词条。
 * 对比时必须两者合在一起算 —— 词条加的是和基础属性同一套 key
 * （比如基础 +22 攻击、词条再 +5 攻击，实际就是 +27），分开比会算错。
 */
function itemTotalStats(item) {
  const total = {};
  if (!item) return total;
  for (const [k, v] of Object.entries(item.attrs || {})) total[k] = (total[k] || 0) + v;
  for (const a of item.affixes || []) total[a.stat] = (total[a.stat] || 0) + a.value;
  return total;
}

/** 属性值的显示格式（不带符号，对比表格里用） */
function fmtValue(key, v) {
  if (key === 'haste') return `${Math.round(v)}ms`;
  if (PCT_STATS[key]) return `${(v * 100).toFixed(1)}%`;
  return `${Math.round(v)}`;
}

/**
 * 生成"与身上正在穿的对比"那一段。
 * 穿上新装备 = 卸掉旧的、穿上新的，所以净收益就是 (新 - 旧)，同部位一对一比即可。
 */
function compareLines(item) {
  const cur = state.equipment && state.equipment[item.slot];
  const out = [];
  if (!cur) {
    out.push(`<div class="tt-cmp-head">${SLOT_LABELS[item.slot] || '该部位'}：身上暂时没穿</div>`);
    return out;
  }
  out.push(`<div class="tt-cmp-head">对比身上：`
    + `<span style="color:${cur.color}">${escapeHtml(cur.name)}</span> Lv${cur.level}</div>`);

  const a = itemTotalStats(cur);
  const b = itemTotalStats(item);
  let any = false;
  for (const key of CMP_ORDER) {
    const av = a[key] || 0;
    const bv = b[key] || 0;
    if (!av && !bv) continue;
    any = true;
    const d = bv - av;
    const cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'same');
    const sign = d > 0 ? '+' : '';
    out.push(`<div class="tt-cmp-row">`
      + `<span class="k">${STAT_NAMES[key] || key}</span>`
      + `<span class="v">${fmtValue(key, av)} <i>→</i> ${fmtValue(key, bv)}</span>`
      + `<span class="d ${cls}">${d === 0 ? '±0' : sign + fmtValue(key, d)}</span>`
      + `</div>`);
  }
  if (!any) out.push('<div class="tt-cmp-row"><span class="v">两件都没有属性差异</span></div>');
  return out;
}

export function formatStat(key, value) {
  const label = STAT_NAMES[key] || key;
  if (key === 'haste') return `${label} -${value}ms`;
  if (PCT_STATS[key]) return `${label} +${(value * 100).toFixed(1)}%`;
  return `${label} +${Math.round(value)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const Panels = { toggle, closeAll, anyOpen, updateHud, renderBag, renderChar, castSkill };
