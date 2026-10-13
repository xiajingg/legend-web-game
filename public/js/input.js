'use strict';

/**
 * 输入：WASD/方向键移动、鼠标点怪攻击、数字键喝药、快捷键开关面板。
 * ★ 只在"方向改变"时向服务端发送一次，不是每帧发（避免请求洪水）。
 */

import { keysToDir } from './render/iso.js';
import { canvasToWorld, currentOffset, getSize } from './render/canvas.js';
import { state, addMessage } from './game/state.js';
import * as net from './net.js';

const keys = new Set();
let lastDir = null;
let panels = null; // 由 main.js 注入的面板控制器

const KEY_TO_DIR = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

export function initInput(canvas, panelController) {
  panels = panelController;

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    // 切走窗口时松开所有键，防止角色一直走
    keys.clear();
    sendMoveIfChanged();
  });

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function onKeyDown(e) {
  // 输入框里打字时不响应游戏快捷键
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;

  const dir = KEY_TO_DIR[e.code];
  if (dir) {
    e.preventDefault();
    keys.add(dir);
    sendMoveIfChanged();
    return;
  }

  switch (e.code) {
    case 'Digit1':
      net.send({ type: 'useItem', kind: 'red' });
      break;
    case 'Digit2':
      net.send({ type: 'useItem', kind: 'blue' });
      break;
    case 'KeyB':
      if (panels) panels.toggle('bag');
      break;
    case 'KeyC':
      if (panels) panels.toggle('char');
      break;
    case 'KeyL':
      if (panels) panels.toggle('rank');
      break;
    case 'KeyQ':
      // 召唤一只宠物（每只消耗 1 点魔法）
      net.send({ type: 'summonPet' });
      break;
    case 'KeyE':
      // 解散全部宠物
      net.send({ type: 'dismissPets' });
      break;
    case 'KeyF':
      // 主动技能：小火球。和点击技能槽走同一个入口，避免两处行为不一致。
      if (panels && panels.castSkill) panels.castSkill('fireball');
      else net.send({ type: 'castSkill', skill: 'fireball' });
      break;
    case 'Escape':
      if (panels && panels.anyOpen()) panels.closeAll();
      else { state.selectedId = null; net.send({ type: 'stopAttack' }); }
      break;
    case 'Space':
      e.preventDefault();
      attackNearest();
      break;
    default:
      break;
  }
}

function onKeyUp(e) {
  const dir = KEY_TO_DIR[e.code];
  if (dir) {
    keys.delete(dir);
    sendMoveIfChanged();
  }
}

/**
 * 重新同步输入状态。
 * 断线重连后服务端已把移动意图清空，但客户端 lastDir 还是旧值，
 * 会导致"键还按着但角色不动"（因为方向没变化就不重复发）。
 * 这里强制清掉缓存，让下一次判定必定重发当前按键状态。
 */
export function resync() {
  lastDir = undefined;
  sendMoveIfChanged();
}

/** 方向变了才发请求 */
function sendMoveIfChanged() {
  if (!state.connected) return;
  const dir = keysToDir(keys);
  const same = (!dir && !lastDir)
    || (dir && lastDir && Math.abs(dir[0] - lastDir[0]) < 1e-6 && Math.abs(dir[1] - lastDir[1]) < 1e-6);
  if (same) return;
  lastDir = dir;
  net.send({ type: 'move', dir });
}

// ------------------------------------------------------------------ 鼠标

function pickMonster(cx, cy) {
  const off = currentOffset();
  const w = canvasToWorld(cx, cy, off);
  let best = null, bestD = 1.3; // 命中半径（tile）
  for (const m of state.monsters) {
    if (m.dead) continue;
    const d = Math.hypot(m.x - w.x, m.y - w.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

function onMouseDown(e) {
  if (!state.connected || !state.player || state.player.hp <= 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  const m = pickMonster(cx, cy);
  if (m) {
    state.selectedId = m.id;
    net.send({ type: 'attack', targetId: m.id });
  } else {
    state.selectedId = null;
    net.send({ type: 'stopAttack' });
  }
}

function onMouseMove(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const m = pickMonster(e.clientX - rect.left, e.clientY - rect.top);
  state.hoverId = m ? m.id : null;
  if (e.currentTarget.style) e.currentTarget.style.cursor = m ? 'crosshair' : 'default';
}

/** 空格键：自动锁定最近的怪 */
function attackNearest() {
  if (!state.player) return;
  let best = null, bestD = 6;
  for (const m of state.monsters) {
    if (m.dead) continue;
    const d = Math.hypot(m.x - state.rx, m.y - state.ry);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (best) {
    state.selectedId = best.id;
    net.send({ type: 'attack', targetId: best.id });
  } else {
    addMessage('附近没有可攻击的怪物', 'info');
  }
}
