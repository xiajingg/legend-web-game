'use strict';

/**
 * 画布与世界渲染。
 * 关键：地面层预渲染到离屏 canvas（地图静态），每帧只 drawImage 一次；
 *      只有障碍块与实体参与深度排序，保证"前面的挡住后面的"且性能可控。
 */

import {
  TILE_W, TILE_H, BLOCK_H, VSCALE, worldToScreen, screenToWorld,
  diamondPath, drawBlock, drawShadow, shade, tri,
} from './iso.js';
import { Sprites, tintSprite } from './sprites.js';
import { state, animProgress } from '../game/state.js';

let canvas = null;
let ctx = null;
let viewW = 0, viewH = 0, dpr = 1;

/** 地面层离屏 canvas（含坐标原点偏移） */
let groundCanvas = null;
let groundOrigin = { x: 0, y: 0 };
let groundKey = '';

/** 障碍块列表（预计算，避免每帧扫全图） */
let blocks = [];

export function initCanvas(el) {
  canvas = el;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  return ctx;
}

export function resize() {
  if (!canvas) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  viewW = canvas.clientWidth;
  viewH = canvas.clientHeight;
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

export function getSize() { return { w: viewW, h: viewH }; }
export function getCtx() { return ctx; }

// ------------------------------------------------------------------ 地图预渲染

/** 地图切换时重建地面层与障碍块列表（配色由服务端下发，前端不硬编码） */
export function buildMapCache(map) {
  const key = map.mapId;
  if (groundKey === key && groundCanvas) return;
  groundKey = key;

  const { w, h, tiles } = map;
  const pad = 64;
  const cw = (w + h) * (TILE_W / 2) + pad * 2;
  const ch = (w + h) * (TILE_H / 2) + pad * 2;

  const off = document.createElement('canvas');
  off.width = Math.ceil(cw);
  off.height = Math.ceil(ch);
  const g = off.getContext('2d');
  g.imageSmoothingEnabled = false;

  // 原点偏移：让世界屏幕坐标 (-h*32, 0) 落在 canvas 的 (pad, pad)
  const originX = h * (TILE_W / 2) + pad;
  const originY = pad + TILE_H / 2;
  groundOrigin = { x: originX, y: originY };

  const def = map.def || {};
  const c1 = def.ground || '#3f6b3a';       // 地面主色
  const c2 = def.groundAlt || '#47773f';    // 地面交替色
  const wallTop = def.wallTop || shade(c1, 0.95);
  const wallLeft = shade(def.wallColor || c1, 0.62);
  const wallRight = shade(def.wallColor || c1, 0.8);

  blocks = [];

  // 先铺地面（含描边网格），再记下障碍块待运行时排序绘制
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const t = tiles[gy][gx];
      const { sx, sy } = worldToScreen(gx + 0.5, gy + 0.5);
      const px = sx + originX;
      const py = sy + originY;

      if (t === 1) {
        // 障碍：地面先画一块暗底，物件留到运行时画（才能和角色做遮挡排序）
        g.fillStyle = shade(c1, 0.55);
        diamondPath(g, px, py);
        g.fill();
        // 中间的障碍 → 树 / 破房子（预渲染好的几种图，按格子哈希取用，同一格永远同一种）；
        // 最外圈的边界墙 → 保持方块：一圈连成整体才像"地图到此为止"，散乱的树会漏出图外。
        const onBorder = gx === 0 || gy === 0 || gx === w - 1 || gy === h - 1;
        // 按权重取种类：树多、破屋少 —— 满地图都是房子会很吵，森林里偶尔有废墟才自然。
        // 权重顺序对应 Sprites.prop(i)：松树/阔叶/枯树/破屋/残墙，加起来必须等于 1。
        const PROP_WEIGHTS = [0.42, 0.2, 0.16, 0.12, 0.1];
        const roll = Math.abs((gx * 73856093) ^ (gy * 19349663)) % 1000 / 1000;
        let variant = -1;
        if (!onBorder) {
          let acc = 0;
          for (let i = 0; i < PROP_WEIGHTS.length; i++) {
            acc += PROP_WEIGHTS[i];
            if (roll < acc) { variant = i; break; }
          }
          if (variant < 0) variant = 0;
        }
        blocks.push({ gx, gy, depth: gx + gy, wallTop, wallLeft, wallRight, variant });
      } else if (t === 2) {
        // 传送点：发光菱形
        g.fillStyle = '#ffd24a';
        diamondPath(g, px, py);
        g.fill();
        g.strokeStyle = '#fff3b0';
        g.lineWidth = 2;
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.25)';
        diamondPath(g, px, py, TILE_W * 0.5, TILE_H * 0.5);
        g.fill();
      } else {
        // 低多边形地面：每格拆成两个三角面，明暗各差一点，再按坐标做确定性抖动。
        // 远看就是一块块切面拼起来的地面，而不是平涂棋盘格。
        // 抖动用 (gx,gy) 的哈希，同一格每次进图颜色都一样（不闪烁）。
        const hash = Math.abs((gx * 73856093) ^ (gy * 19349663)) % 1000 / 1000;
        const base = (gx + gy) % 2 === 0 ? c1 : c2;
        const j = (hash - 0.5) * 0.16;
        const top = [px, py - TILE_H / 2];
        const right = [px + TILE_W / 2, py];
        const bottom = [px, py + TILE_H / 2];
        const left = [px - TILE_W / 2, py];
        if ((gx + gy) % 2 === 0) {
          tri(g, top, right, bottom, shade(base, 1 + j));
          tri(g, top, bottom, left, shade(base, 1 + j + 0.07));
        } else {
          tri(g, top, right, bottom, shade(base, 1 + j + 0.07));
          tri(g, top, bottom, left, shade(base, 1 + j));
        }
      }
    }
  }

  groundCanvas = off;
}

// ------------------------------------------------------------------ 摄像机

function cameraOffset() {
  const { sx, sy } = worldToScreen(state.rx, state.ry);
  return { ox: sx - viewW / 2, oy: sy - viewH / 2 };
}

/** 世界坐标 → 画布坐标 */
export function worldToCanvas(x, y, off) {
  const { sx, sy } = worldToScreen(x, y);
  return { x: sx - off.ox, y: sy - off.oy };
}

/** 画布坐标 → 世界坐标（鼠标点击用） */
export function canvasToWorld(cx, cy, off) {
  return screenToWorld(cx + off.ox, cy + off.oy);
}

export function currentOffset() { return cameraOffset(); }

// ------------------------------------------------------------------ 动作动画

/**
 * 出手动的"前冲"位移：朝目标方向冲出去再弹回（sin 曲线，起止都为 0）。
 * @param {object|null} atk 攻击动画进度
 * @param {number} strength 前冲距离（tile）
 */
function attackOffset(atk, bx, by, strength) {
  if (!atk || atk.kind !== 'attack') return { dx: 0, dy: 0 };
  const k = Math.sin(atk.p * Math.PI); // 0 → 1 → 0
  const vx = atk.tx - bx;
  const vy = atk.ty - by;
  const len = Math.hypot(vx, vy) || 1;
  return { dx: (vx / len) * strength * k, dy: (vy / len) * strength * k };
}

/** 玩家挥砍的剑光：一道朝目标方向的弧形，快速淡出 */
function drawSlash(ctx, px, py, anim) {
  // 只在挥砍中段显示，起手和收招不画
  if (anim.p < 0.18 || anim.p > 0.82) return;
  const t = (anim.p - 0.18) / 0.64; // 0 → 1

  // 世界方向 → 屏幕方向（等距投影）
  const vx = anim.tx - state.rx;
  const vy = anim.ty - state.ry;
  const sx = (vx - vy) * (TILE_W / 2);
  const sy = (vx + vy) * (TILE_H / 2);
  const angle = Math.atan2(sy, sx);
  const spread = 1.0 - t * 0.45; // 弧度逐渐收拢
  const radius = 39 + t * 15;

  ctx.save();
  ctx.translate(px, py - 33);
  ctx.rotate(angle);
  ctx.globalAlpha = (1 - t) * 0.9;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7 - t * 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, radius, -spread, spread);
  ctx.stroke();
  // 内层高光，让刀光更亮
  ctx.globalAlpha = (1 - t) * 0.55;
  ctx.strokeStyle = '#fff3b0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, radius - 6, -spread * 0.8, spread * 0.8);
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------ 主渲染

export function renderWorld(now) {
  if (!ctx) return null;
  const off = cameraOffset();

  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, viewW, viewH);

  if (!state.map) return off;

  // 1) 地面层：整张贴一次，性能关键
  if (groundCanvas) {
    ctx.drawImage(groundCanvas, -off.ox - groundOrigin.x, -off.oy - groundOrigin.y);
  }

  // 2) 收集需要按深度排序的东西：障碍块 + 掉落物 + 怪物 + 玩家
  const items = [];

  const margin = 180;
  for (const b of blocks) {
    const { sx, sy } = worldToScreen(b.gx + 0.5, b.gy + 0.5);
    const px = sx - off.ox;
    const py = sy - off.oy;
    // 视锥裁剪：画布外的不画
    if (px < -margin || px > viewW + margin || py < -margin || py > viewH + margin) continue;
    items.push({ depth: b.depth, kind: 'block', px, py, b });
  }

  for (const d of state.drops) {
    const { sx, sy } = worldToScreen(d.x, d.y);
    const px = sx - off.ox, py = sy - off.oy;
    if (px < -margin || px > viewW + margin || py < -margin || py > viewH + margin) continue;
    items.push({ depth: d.x + d.y, kind: 'drop', px, py, d });
  }

  for (const m of state.monsters) {
    if (m.dead) continue;
    const r = state.monsterRender.get(m.id) || { x: m.x, y: m.y };
    const atk = animProgress(m.id, 'attack', now);
    const hurt = animProgress(m.id, 'hurt', now);
    // 攻击时朝玩家前冲一点，做出"扑上去咬"的动感
    const o = attackOffset(atk, r.x, r.y, 0.24);
    const { sx, sy } = worldToScreen(r.x + o.dx, r.y + o.dy);
    const px = sx - off.ox, py = sy - off.oy;
    if (px < -margin || px > viewW + margin || py < -margin || py > viewH + margin) continue;
    items.push({ depth: r.x + r.y, kind: 'monster', px, py, m, atk, hurt });
  }

  for (const pet of state.pets) {
    if (pet.dead) continue;
    const r = state.petRender.get(pet.id) || { x: pet.x, y: pet.y };
    const atk = animProgress(pet.id, 'attack', now);
    const hurt = animProgress(pet.id, 'hurt', now);
    // 攻击时朝目标前冲一点，做出"扑上去"的动感
    const o = attackOffset(atk, r.x, r.y, 0.2);
    const { sx, sy } = worldToScreen(r.x + o.dx, r.y + o.dy);
    const px = sx - off.ox, py = sy - off.oy;
    if (px < -margin || px > viewW + margin || py < -margin || py > viewH + margin) continue;
    items.push({ depth: r.x + r.y, kind: 'pet', px, py, pet, atk, hurt });
  }

  if (state.player && state.player.hp > 0) {
    const atk = animProgress('player', 'attack', now);
    const cast = animProgress('player', 'cast', now);
    const hurt = animProgress('player', 'hurt', now);
    const o = attackOffset(atk, state.rx, state.ry, 0.18);
    const { sx, sy } = worldToScreen(state.rx + o.dx, state.ry + o.dy);
    const px = sx - off.ox, py = sy - off.oy;
    // +0.001 保证同格时玩家画在怪物之后（更显眼）
    items.push({ depth: state.rx + state.ry + 0.001, kind: 'player', px, py, atk, cast, hurt });
  }

  // 3) 深度排序：x+y 升序，天然实现前后遮挡
  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) {
    if (it.kind === 'block') drawBlockItem(it);
    else if (it.kind === 'drop') drawDropItem(it, now);
    else if (it.kind === 'monster') drawMonsterItem(it);
    else if (it.kind === 'pet') drawPetItem(it);
    else if (it.kind === 'player') drawPlayerItem(it);
  }

  // 4) 技能特效画在最上层：火球要能从所有实体上方飞过去
  drawFx(now, off);

  return off;
}

function drawBlockItem(it) {
  const { b } = it;
  if (b.variant >= 0) {
    // 树 / 破房子：预渲染图，底部对齐格心（和角色同一个锚点约定），自然参与深度排序
    const spr = Sprites.prop(b.variant);
    ctx.drawImage(spr, it.px - spr.width / 2, it.py - spr.height + 6);
    return;
  }
  drawBlock(ctx, it.px, it.py, b.wallTop, b.wallLeft, b.wallRight, BLOCK_H);
}

function drawDropItem(it, now) {
  const d = it.d;
  let spr;
  if (d.kind === 'gold') spr = Sprites.gold();
  else if (d.kind === 'red') spr = Sprites.potionRed();
  else if (d.kind === 'blue') spr = Sprites.potionBlue();
  else spr = Sprites.chest(d.color);

  // 上下浮动，提示可拾取
  const bob = Math.sin(now / 300 + d.x * 3) * 3;
  drawShadow(ctx, it.px, it.py, 12, 6);
  ctx.drawImage(spr, it.px - spr.width / 2, it.py - spr.height + bob);
}

function drawMonsterItem(it) {
  const m = it.m;
  // 攻击时切成攻击姿态帧（张嘴/挥爪/前扑）
  let spr = it.atk ? Sprites.monsterAttack(m.type) : Sprites.monster(m.type);
  // 受击瞬间叠一层白色，闪一下
  if (it.hurt) spr = tintSprite(spr, `m_${m.type}`, '#ffffff', 4 * (1 - it.hurt.p) * 0.9);

  drawShadow(ctx, it.px, it.py, m.isBoss ? 33 : 20, m.isBoss ? 15 : 9);

  // 死亡时半透明（服务端复活前）
  ctx.save();
  if (m.hp <= 0) ctx.globalAlpha = 0.25;
  // 攻击瞬间略微放大，强化"扑击"力度
  if (it.atk) {
    const s = 1 + Math.sin(it.atk.p * Math.PI) * 0.08;
    const w = spr.width * s, h = spr.height * s;
    ctx.drawImage(spr, it.px - w / 2, it.py - h + 6, w, h);
  } else {
    ctx.drawImage(spr, it.px - spr.width / 2, it.py - spr.height + 6);
  }
  ctx.restore();

  // 选中框
  if (state.selectedId === m.id) {
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 2;
    diamondPath(ctx, it.px, it.py, TILE_W * 0.9, TILE_H * 0.9);
    ctx.stroke();
  }
  if (state.hoverId === m.id) {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    diamondPath(ctx, it.px, it.py, TILE_W * 0.9, TILE_H * 0.9);
    ctx.stroke();
  }

  // 头顶血条 + 名字 + 等级
  const barW = m.isBoss ? 90 : 57;
  const barH = 7;
  const topY = it.py - spr.height - 2;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(it.px - barW / 2 - 1, topY - 1, barW + 2, barH + 2);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(it.px - barW / 2, topY, barW, barH);
  const pct = Math.max(0, m.hp / m.maxHp);
  ctx.fillStyle = m.isBoss ? '#ff4a4a' : '#4cd964';
  ctx.fillRect(it.px - barW / 2, topY, barW * pct, barH);

  ctx.font = '15px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = m.isBoss ? '#ff8c3c' : '#e8e8f0';
  ctx.fillText(`${m.name} Lv${m.level}`, it.px, topY - 3);
}

function drawPetItem(it) {
  const pet = it.pet;
  // 攻击时切成攻击帧
  const isAtk = !!it.atk;
  let spr = isAtk ? Sprites.petAttack() : Sprites.pet();
  // 受击瞬间叠白闪一下。
  // key 必须带上帧名：平时帧和攻击帧尺寸不同，共用同一个 key 会从缓存里
  // 取到另一种形状的染色图，表现为"受击时宠物突然变形"。
  if (it.hurt) spr = tintSprite(spr, isAtk ? 'petA' : 'pet', '#ffffff', 4 * (1 - it.hurt.p) * 0.9);

  // 影子随体型放大（宠物是 2 倍体型，影子也按 2 倍给）
  drawShadow(ctx, it.px, it.py, 27, 12);

  // 上下漂浮，做出"小精灵悬浮"的感觉
  const bob = Math.sin(performance.now() / 260 + it.px * 0.05) * 2;
  if (it.atk) {
    // 攻击瞬间略微放大，强化力度
    const s = 1 + Math.sin(it.atk.p * Math.PI) * 0.1;
    const w = spr.width * s, h = spr.height * s;
    ctx.drawImage(spr, it.px - w / 2, it.py - h + 6 - bob, w, h);
  } else {
    ctx.drawImage(spr, it.px - spr.width / 2, it.py - spr.height + 6 - bob);
  }

  // 血条：只在掉血时显示，避免 8 只宠物头顶挂满血条太吵
  if (pet.hp < pet.maxHp) {
    const barW = 54, barH = 6;
    const topY = it.py - spr.height - 2 - bob;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(it.px - barW / 2 - 1, topY - 1, barW + 2, barH + 2);
    ctx.fillStyle = '#3fae6e';
    ctx.fillRect(it.px - barW / 2, topY, barW * Math.max(0, pet.hp / pet.maxHp), barH);
  }
}

function drawPlayerItem(it) {
  const p = state.player;
  // 攻击/施法时都朝向目标（而不是移动方向）
  const aim = it.atk || it.cast;
  if (aim) {
    const dx = aim.tx - state.rx;
    if (Math.abs(dx) > 0.15) state.facing = dx > 0 ? 1 : -1;
  }
  let spr = state.facing < 0 ? Sprites.heroFlipped() : Sprites.hero();
  if (aim) spr = state.facing < 0 ? Sprites.heroAttackFlipped() : Sprites.heroAttack();
  if (it.hurt) spr = tintSprite(spr, 'player', '#ff6b6b', 4 * (1 - it.hurt.p) * 0.8);

  drawShadow(ctx, it.px, it.py, 20, 9);

  // 移动时轻微上下起伏，增加生动感
  const bob = p.moving ? Math.abs(Math.sin(performance.now() / 90)) * 2 : 0;
  ctx.drawImage(spr, it.px - spr.width / 2, it.py - spr.height + 6 - bob);

  // 挥砍剑光：只有近战普通攻击才画
  if (it.atk) drawSlash(ctx, it.px, it.py - bob, it.atk);
  // 施法：手心聚起火团（抬手蓄力 → 掷出），不画剑光
  if (it.cast) drawCastCharge(ctx, it.px, it.py - bob, it.cast);

  // 自己的名字
  ctx.font = 'bold 16px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd24a';
  ctx.fillText(state.username || '', it.px, it.py - spr.height - 4 - bob);
}

/** 施法时手心聚起的火团：蓄力变大变亮，火球掷出后迅速熄灭 */
function drawCastCharge(ctx, px, py, anim) {
  const t = anim.p;
  const grow = Math.min(1, t / 0.5);
  const alpha = t < 0.6 ? 0.5 + grow * 0.5 : Math.max(0, 1 - (t - 0.6) / 0.4);
  if (alpha <= 0) return;
  const r = 6 + grow * 12;
  const hy = py - 36; // 大致在胸口/手的位置

  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(px, hy, 0, px, hy, r);
  g.addColorStop(0, '#fffbe0');
  g.addColorStop(0.45, '#ffc23c');
  g.addColorStop(1, 'rgba(206,58,12,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(px, hy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 技能特效层：小火球的飞行弹道 + 命中炸开。
 * 全是纯表现（伤害早已在服务端结算），所以没有任何游戏逻辑依赖这里。
 */
function drawFx(now, off) {
  const LINGER = 220; // 命中后爆炸的残留时长（ms）
  state.fx = state.fx.filter((f) => now - f.born < f.flight + LINGER);

  for (const f of state.fx) {
    const raw = (now - f.born) / f.flight;
    const t = Math.max(0, Math.min(1, raw));

    // 世界坐标 → 屏幕坐标；抬到"身体中段"，看起来像从手里飞出去
    const A = worldToScreen(f.x0, f.y0);
    const B = worldToScreen(f.x1, f.y1);
    const ax = A.sx - off.ox, ay = A.sy - off.oy - 30;
    const bx = B.sx - off.ox, by = B.sy - off.oy - 24;
    const arcAt = (k) => Math.sin(Math.PI * k) * 24; // 抛物线弧度

    if (raw < 1) {
      // ---- 飞行中
      ctx.save();
      // 拖尾：越靠后越淡越小
      for (let i = 1; i <= 4; i++) {
        const k = Math.max(0, t - i * 0.07);
        ctx.globalAlpha = 0.3 * (1 - i / 5);
        ctx.fillStyle = '#ff8c2a';
        ctx.beginPath();
        ctx.arc(ax + (bx - ax) * k, ay + (by - ay) * k - arcAt(k), 9 - i * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // 火球本体
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t - arcAt(t);
      const R = 27;
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, '#fffbe0');
      g.addColorStop(0.3, '#ffd24a');
      g.addColorStop(0.6, '#ff7a1a');
      g.addColorStop(1, 'rgba(190,40,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fill();
      // 外圈跳动的火舌
      ctx.globalAlpha = 0.45 + Math.sin(now / 45) * 0.2;
      ctx.strokeStyle = '#ffb03c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 12 + Math.sin(now / 40) * 2.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      // ---- 命中炸开
      const p = Math.min(1, (raw - 1) / (LINGER / f.flight));
      const rr = 18 + p * 45;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p);
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, rr);
      g.addColorStop(0, '#fffbe0');
      g.addColorStop(0.45, 'rgba(255,150,40,0.85)');
      g.addColorStop(1, 'rgba(190,40,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, rr, 0, Math.PI * 2);
      ctx.fill();
      // 冲击环
      ctx.globalAlpha = Math.max(0, 1 - p) * 0.7;
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = Math.max(1, 3 - p * 2);
      ctx.beginPath();
      ctx.arc(bx, by, rr * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** 在玩家脚下画一个高亮圈，方便在地图上定位自己 */
export function drawPlayerMarker(off) {
  if (!state.player) return;
  const { x, y } = worldToCanvas(state.rx, state.ry, off);
  ctx.strokeStyle = 'rgba(255,210,74,0.35)';
  ctx.lineWidth = 2;
  diamondPath(ctx, x, y, TILE_W, TILE_H);
  ctx.stroke();
}
