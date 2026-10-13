'use strict';

/**
 * 启动入口：登录 → 连 SSE → 装配渲染/输入/循环。
 */

import {
  state, applyInit, applySnapshot, addFloatText, addMessage, monsterById, triggerAnim,
  setMap, addFireballFx,
} from './game/state.js';
import * as net from './net.js';
import { initCanvas, buildMapCache, resize } from './render/canvas.js';
import { initInput, resync } from './input.js';
import { startLoop } from './game/loop.js';
import * as panels from './ui/panels.js';

const loginLayer = document.getElementById('loginLayer');
const loginForm = document.getElementById('loginForm');
const loginMsg = document.getElementById('loginMsg');
const tabLogin = document.getElementById('tabLogin');
const tabReg = document.getElementById('tabReg');
const submitBtn = document.getElementById('submitBtn');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const gameLayer = document.getElementById('gameLayer');
const logoutBtn = document.getElementById('logoutBtn');

let mode = 'login'; // login | register

// ------------------------------------------------------------------ 登录界面

tabLogin.addEventListener('click', () => setMode('login'));
tabReg.addEventListener('click', () => setMode('register'));

function setMode(m) {
  mode = m;
  tabLogin.classList.toggle('active', m === 'login');
  tabReg.classList.toggle('active', m === 'register');
  submitBtn.textContent = m === 'login' ? '登录' : '注册并开始游戏';
  loginMsg.textContent = '';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  loginMsg.textContent = '';
  submitBtn.disabled = true;
  try {
    const res = await net.api(mode === 'login' ? '/api/login' : '/api/register', { username, password });
    if (!res.ok) {
      loginMsg.textContent = res.msg || '操作失败';
      return;
    }
    enterGame(res.token, res.username);
  } catch (err) {
    loginMsg.textContent = '网络错误，请确认服务端已启动';
  } finally {
    submitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('game_token');
  localStorage.removeItem('game_user');
  net.close();
  loginLayer.classList.remove('hidden');
  gameLayer.classList.add('hidden');
  state.connected = false;
});

// ------------------------------------------------------------------ 进入游戏

async function enterGame(token, username) {
  localStorage.setItem('game_token', token);
  localStorage.setItem('game_user', username);
  net.setToken(token);
  state.token = token;
  state.username = username;

  loginLayer.classList.add('hidden');
  gameLayer.classList.remove('hidden');
  // ★ 画布在 gameLayer 隐藏时 clientWidth 为 0，显示后必须重新量一次尺寸
  resize();
  document.getElementById('whoText').textContent = username;

  bindNetEvents();
  net.connect(token);
}

// ------------------------------------------------------------------ SSE 事件处理

let eventsBound = false;

function bindNetEvents() {
  if (eventsBound) return;
  eventsBound = true;

  net.on('init', (data) => {
    applyInit(data);
    buildMapCache(data.map);
    panels.renderBag();
    panels.renderChar();
    // 服务端在建立连接时会清空移动意图，客户端也要同步重置，否则按住的键会失效
    resync();
    addMessage(`欢迎来到【${data.map.name}】`, 'good');
  });

  net.on('state', (data) => {
    applySnapshot(data);
    // 选中目标死了就取消选中
    if (state.selectedId) {
      const m = monsterById(state.selectedId);
      if (!m || m.dead) state.selectedId = null;
    }
  });

  net.on('combat', (data) => {
    // 宠物 id 形如 p1 / p12；'player' 与 'm1' 都不匹配这个规则
    const isPet = (id) => /^p\d+$/.test(String(id));
    const petById = (id) => state.pets.find((p) => p.id === id);

    for (const ev of data.events) {
      // ---- 0) 技能（小火球）：伤害服务端已经结算完了，这里只排"表现" ----
      if (ev.skill === 'fireball') {
        const m = monsterById(ev.targetId);
        // 怪物可能已经被打死了，位置就以服务端发来的为准，取不到就退回落点
        const tx = m ? m.x : (ev.ax ?? state.rx);
        const ty = m ? m.y : (ev.ay ?? state.ry);
        const flight = ev.flightMs || 260;

        if (!ev.splash) {
          // 主目标：玩家起手 + 火球从玩家飞向目标
          triggerAnim('player', 'cast', tx, ty);
          addFireballFx(state.rx, state.ry, tx, ty, flight);
        }
        // 命中表现延后到火球飞到的那一刻 —— 否则伤害数字比火球先到，很出戏
        // 溅射和主目标是同一发火球炸出来的，所以延后时间一样
        const delay = flight;
        const text = ev.miss ? 'MISS' : `${ev.dmg}`;
        const color = ev.miss ? '#cfd4e0' : (ev.splash ? '#ffb86b' : (ev.crit ? '#ffd24a' : '#ffffff'));
        setTimeout(() => {
          if (!ev.miss) triggerAnim(ev.targetId, 'hurt', 0, 0);
          addFloatText(tx, ty, text, color, ev.crit);
        }, delay);
        continue;
      }

      // ---- 1) 出手动：谁打谁，就让它朝对方做一个动作
      if (ev.attackerId === 'player') {
        const m = monsterById(ev.targetId);
        const tx = m ? m.x : state.rx;
        const ty = m ? m.y : state.ry - 1;
        triggerAnim('player', 'attack', tx, ty);   // 玩家挥砍
      } else if (isPet(ev.attackerId)) {
        // 宠物出手：朝它锁定的怪扑过去
        const m = monsterById(ev.targetId);
        triggerAnim(ev.attackerId, 'attack', m ? m.x : state.rx, m ? m.y : state.ry);
      } else if (ev.attackerId) {
        // 怪物出手：朝它打的目标（可能是玩家，也可能是宠物）
        let tx = state.rx, ty = state.ry;
        if (ev.targetType === 'pet') {
          const pet = petById(ev.targetId);
          if (pet) { tx = pet.x; ty = pet.y; }
        }
        triggerAnim(ev.attackerId, 'attack', tx, ty); // 怪物扑咬/挥爪
      }

      // ---- 2) 受击反馈：闪白 + 轻微后仰（用 hurt 动作表现）
      if (ev.targetType === 'player') {
        triggerAnim('player', 'hurt', 0, 0);
      } else if (!ev.miss) {
        triggerAnim(ev.targetId, 'hurt', 0, 0);
      }

      // ---- 3) 伤害飘字
      if (ev.targetType === 'player') {
        if (ev.miss) addFloatText(state.rx, state.ry, '闪避', '#9fd0ff');
        else addFloatText(state.rx, state.ry, `-${ev.dmg}`, ev.crit ? '#ff4a4a' : '#ff8c8c', ev.crit);
      } else if (ev.targetType === 'pet') {
        // 宠物挨打：在它自己头上飘字
        const pet = petById(ev.targetId);
        const x = pet ? pet.x : state.rx;
        const y = pet ? pet.y : state.ry;
        if (ev.miss) addFloatText(x, y, '闪避', '#9fd0ff');
        else addFloatText(x, y, `-${ev.dmg}`, '#ffb3b3');
      } else {
        const m = monsterById(ev.targetId);
        const x = m ? m.x : state.rx;
        const y = m ? m.y : state.ry;
        if (ev.miss) addFloatText(x, y, 'MISS', '#cfd4e0');
        else addFloatText(x, y, `${ev.dmg}`, ev.crit ? '#ffd24a' : '#ffffff', ev.crit);
      }
    }
  });

  net.on('loot', (data) => {
    if (data.items && data.items.length) addMessage(`获得 ${data.items.join('、')}`, 'good');
  });

  net.on('levelup', (data) => {
    addMessage(`★ 升级！当前 Lv${data.level}`, 'good');
    const p = state.player;
    if (p) addFloatText(state.rx, state.ry, 'LEVEL UP!', '#ffd24a', true);
  });

  net.on('inventory', (data) => {
    state.inventory = data.inventory;
    state.equipment = data.equipment;
    state.gold = data.gold;
    state.potions = data.potions;
    if (state.player) state.player.stats = data.stats;
    panels.renderBag();
    panels.renderChar();
  });

  net.on('message', (data) => {
    for (const m of data.items) addMessage(m.text, m.kind);
  });

  net.on('map', (data) => {
    // 切图：重建地图缓存
    if (state.map) {
      state.map.mapId = data.mapId;
      state.map.name = data.name;
      state.map.w = data.w;
      state.map.h = data.h;
      state.map.tiles = data.tiles;
      state.map.def = data.def;
      setMap(data.name, data.floor, data.layer);
      buildMapCache(state.map);
    }
  });

  net.on('revive', (data) => {
    addMessage('你已在村庄复活', 'info');
  });

  net.on('open', () => { state.connected = true; });
  net.on('error', (data) => {
    if (data && data.msg) addMessage(data.msg, 'bad');
    else state.connected = false;
  });
}

// ------------------------------------------------------------------ 启动

function boot() {
  // 暴露到 window，方便在控制台调试与查状态
  window.__game = { state, net, panels };

  const canvas = document.getElementById('gameCanvas');
  initCanvas(canvas);
  panels.initPanels();
  initInput(canvas, panels.Panels);
  startLoop(panels.Panels);

  // 恢复登录态
  const token = localStorage.getItem('game_token');
  const user = localStorage.getItem('game_user');
  if (token && user) {
    net.setToken(token);
    net.api(`/api/profile?token=${encodeURIComponent(token)}`).then((res) => {
      if (res.ok) enterGame(token, user);
      else { localStorage.clear(); loginLayer.classList.remove('hidden'); }
    }).catch(() => { loginLayer.classList.remove('hidden'); });
  } else {
    loginLayer.classList.remove('hidden');
  }
}

boot();
