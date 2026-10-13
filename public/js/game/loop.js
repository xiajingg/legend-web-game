'use strict';

/**
 * 主循环：60fps 渲染，对服务端 10Hz 的坐标做插值，避免抖动。
 */

import { state, cleanupAnims } from './state.js';
import { renderWorld, getCtx, getSize } from '../render/canvas.js';
import { drawFloatTexts, drawMessages, drawMapName, drawPetStatus } from '../render/hud.js';

const LERP = 0.2;        // 插值系数
const SNAP_THRESHOLD = 3; // 超过这个距离直接瞬移（防切图/复活时的橡皮筋）

let panels = null;
let running = false;
let frameCount = 0;

export function startLoop(panelController) {
  panels = panelController;
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

function frame(now) {
  const ctx = getCtx();
  if (!ctx) { requestAnimationFrame(frame); return; }

  // 每半秒兜底清理一次过期动画（约 30 帧）
  if (++frameCount % 30 === 0) cleanupAnims(now);

  // ---- 1) 坐标插值
  if (state.player) {
    let dx = state.player.x - state.rx;
    let dy = state.player.y - state.ry;
    if (Math.hypot(dx, dy) > SNAP_THRESHOLD) {
      state.rx = state.player.x;
      state.ry = state.player.y;
    } else {
      state.rx += dx * LERP;
      state.ry += dy * LERP;
    }
    // 朝向：世界 +x 为屏幕右下 → 面朝右
    const d = state.player.dir;
    if (d && Math.abs(d[0]) > 0.2) state.facing = d[0] > 0 ? 1 : -1;
  }

  for (const m of state.monsters) {
    let r = state.monsterRender.get(m.id);
    if (!r) { r = { x: m.x, y: m.y }; state.monsterRender.set(m.id, r); }
    const dist = Math.hypot(m.x - r.x, m.y - r.y);
    if (dist > SNAP_THRESHOLD) { r.x = m.x; r.y = m.y; }
    else { r.x += (m.x - r.x) * LERP; r.y += (m.y - r.y) * LERP; }
  }

  for (const pet of state.pets) {
    let r = state.petRender.get(pet.id);
    if (!r) { r = { x: pet.x, y: pet.y }; state.petRender.set(pet.id, r); }
    const dist = Math.hypot(pet.x - r.x, pet.y - r.y);
    if (dist > SNAP_THRESHOLD) { r.x = pet.x; r.y = pet.y; }
    else { r.x += (pet.x - r.x) * LERP; r.y += (pet.y - r.y) * LERP; }
  }
  // 宠物消失后清掉它的插值缓存，避免 Map 无限增长
  if (state.petRender.size > state.pets.length) {
    const alive = new Set(state.pets.map((p) => p.id));
    for (const id of state.petRender.keys()) if (!alive.has(id)) state.petRender.delete(id);
  }

  // ---- 2) 渲染
  const off = renderWorld(now);
  if (off) {
    drawFloatTexts(ctx, off);
    const { w, h } = getSize();
    drawMapName(ctx, w);
    drawMessages(ctx, w, h);
    drawPetStatus(ctx, w, h);
  }

  // ---- 3) DOM HUD
  if (panels) panels.updateHud();

  requestAnimationFrame(frame);
}
