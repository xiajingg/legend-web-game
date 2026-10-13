'use strict';

/**
 * 屏幕空间 HUD：伤害飘字、系统消息。
 * 血条/经验条/背包等面板由 ui/panels.js 用 DOM 实现。
 */

import { state, mapTitle } from '../game/state.js';
import { worldToCanvas } from './canvas.js';

const FLOAT_LIFE = 900;   // 飘字存活 ms
const MSG_LIFE = 4000;

/** 伤害飘字：从受伤者头顶向上飘并淡出 */
export function drawFloatTexts(ctx, off) {
  const now = performance.now();
  state.floatTexts = state.floatTexts.filter((f) => now - f.born < FLOAT_LIFE);

  ctx.textAlign = 'center';
  for (const f of state.floatTexts) {
    const age = (now - f.born) / FLOAT_LIFE;
    const { x, y } = worldToCanvas(f.x, f.y, off);
    const rise = age * 69;
    const alpha = 1 - Math.pow(age, 2);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = f.crit ? 'bold 33px "Courier New", monospace' : 'bold 24px "Courier New", monospace';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(f.text, x, y - 90 - rise);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, x, y - 90 - rise);
    if (f.crit) {
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('暴击!', x, y - 117 - rise);
    }
    ctx.globalAlpha = 1;
  }
}

/** 左下角滚动系统消息 */
export function drawMessages(ctx, viewW, viewH) {
  const now = performance.now();
  state.messages = state.messages.filter((m) => now - m.born < MSG_LIFE);

  ctx.textAlign = 'left';
  ctx.font = '19px "Courier New", monospace';
  let y = viewH - 165;
  // 从新到旧，新的在下
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    const age = (now - m.born) / MSG_LIFE;
    ctx.globalAlpha = Math.max(0, 1 - Math.pow(age, 3));
    ctx.fillStyle = m.kind === 'bad' ? '#ff6b6b' : m.kind === 'good' ? '#4cd964' : '#cfd4e0';
    ctx.fillText(m.text, 24, y);
    y -= 30;
    if (y < viewH / 2) break;
  }
  ctx.globalAlpha = 1;
}

/** 顶部中央的地图名（带层号，例如「第 5 层 · 新手村」） */
export function drawMapName(ctx, viewW) {
  const title = mapTitle();
  if (!title) return;
  ctx.textAlign = 'center';
  ctx.font = 'bold 21px "Courier New", monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(`【${title}】`, viewW / 2 + 2, 107);
  ctx.fillStyle = state.floor > 1 ? '#ff9f4a' : '#ffd24a';
  ctx.fillText(`【${title}】`, viewW / 2, 105);
}

/** 右下角：当前宠物数量 + 操作提示 */
export function drawPetStatus(ctx, viewW, viewH) {
  const pets = state.pets || [];
  const max = (state.player && state.player.petMax) || 8;

  const x = viewW - 16;
  // 画在右下角按钮（背包/角色/排行）的上方，避免被遮挡
  const y = viewH - 87;

  ctx.textAlign = 'right';

  // 操作提示（淡一些，不抢戏）
  ctx.font = '16px "Courier New", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.fillText('Q 召唤宠物   E 解散', x, y - 18);

  // 数量：有宠物时用宠物红色高亮（与场上宠物同色）
  ctx.font = 'bold 19px "Courier New", monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(`宠物 ${pets.length} / ${max}`, x + 1, y + 1);
  ctx.fillStyle = pets.length ? '#ff4d4d' : 'rgba(255,255,255,0.45)';
  ctx.fillText(`宠物 ${pets.length} / ${max}`, x, y);
}
