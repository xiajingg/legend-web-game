'use strict';

/**
 * 斜 45° 等距投影。全部坐标换算集中在这里，其它模块不自己算。
 *
 * 采用 2:1 dimetric：tile 宽 64、高 32。
 *   世界 +x 方向 → 屏幕右下
 *   世界 +y 方向 → 屏幕左下
 */

export const TILE_W = 96;
export const TILE_H = 48;
export const BLOCK_H = 26; // 障碍块的立体高度

/**
 * 实体（角色/怪物/特效/血条/阴影）的同步放大系数。
 * 必须和 tile 的放大比例一致，否则人会显得比格子大或小。
 * 精灵本体在 sprites.js 里用同一个系数放大（两边各写一份，改的时候要一起改）。
 */
export const VSCALE = 1.5;

/** 世界坐标（浮点 tile 单位）→ 屏幕像素（未减摄像机偏移） */
export function worldToScreen(x, y) {
  return {
    sx: (x - y) * (TILE_W / 2),
    sy: (x + y) * (TILE_H / 2),
  };
}

/** 屏幕像素 → 世界坐标（鼠标点击命中用） */
export function screenToWorld(sx, sy) {
  const a = sx / (TILE_W / 2); // = x - y
  const b = sy / (TILE_H / 2); // = x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/**
 * ★ 键盘方向 → 世界方向。
 * 屏幕方向 ≠ 世界方向，这是等距视角最容易搞反的地方，所以写死成常量表。
 * 推导：世界 +x → 屏幕右下(+32,+16)；世界 +y → 屏幕左下(-32,+16)。
 *   屏幕"上" = 世界 (-x,-y)：x-y 不变故 sx 不变，x+y 减小故 sy 减小 → 屏幕正上方
 *   屏幕"左" = 世界 (-x,+y)：x-y 减小故 sx 减小，x+y 不变故 sy 不变 → 屏幕正左方
 * 于是 WASD 正好对应屏幕上的上下左右，斜向按键自动叠加成右上/右下等，符合直觉。
 */
const R = Math.SQRT1_2; // 0.7071
export const DIRS = {
  up: [-R, -R],        // W / ↑ → 屏幕正上
  down: [R, R],        // S / ↓ → 屏幕正下
  left: [-R, R],       // A / ← → 屏幕正左
  right: [R, -R],      // D / → → 屏幕正右
};

/**
 * 把按键集合换算成世界空间的移动方向（已归一化）。
 * @param {Set<string>} keys 当前按下的方向键集合，元素为 up/down/left/right
 */
export function keysToDir(keys) {
  let dx = 0, dy = 0;
  if (keys.has('up')) { dx += DIRS.up[0]; dy += DIRS.up[1]; }
  if (keys.has('down')) { dx += DIRS.down[0]; dy += DIRS.down[1]; }
  if (keys.has('left')) { dx += DIRS.left[0]; dy += DIRS.left[1]; }
  if (keys.has('right')) { dx += DIRS.right[0]; dy += DIRS.right[1]; }
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return [dx / len, dy / len];
}

/** 深度值：越小越靠后（先画），越大越靠前（后画、盖住别人） */
export function depthOf(x, y) {
  return x + y;
}

// ------------------------------------------------------------------ 绘制图元

/** 画一个菱形（tile 顶面） */
export function diamondPath(ctx, sx, sy, w = TILE_W, h = TILE_H) {
  ctx.beginPath();
  ctx.moveTo(sx, sy - h / 2);          // 上
  ctx.lineTo(sx + w / 2, sy);          // 右
  ctx.lineTo(sx, sy + h / 2);          // 下
  ctx.lineTo(sx - w / 2, sy);          // 左
  ctx.closePath();
}

/** 画一块带厚度的立体方块（障碍/墙），锚点 (sx, sy) 为该格顶面中心 */
export function drawBlock(ctx, sx, sy, topColor, leftColor, rightColor, h = BLOCK_H) {
  const hw = TILE_W / 2, hh = TILE_H / 2;
  // 右侧面
  ctx.fillStyle = rightColor;
  ctx.beginPath();
  ctx.moveTo(sx, sy + hh);
  ctx.lineTo(sx + hw, sy);
  ctx.lineTo(sx + hw, sy - h);
  ctx.lineTo(sx, sy + hh - h);
  ctx.closePath();
  ctx.fill();
  // 左侧面
  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(sx, sy + hh);
  ctx.lineTo(sx - hw, sy);
  ctx.lineTo(sx - hw, sy - h);
  ctx.lineTo(sx, sy + hh - h);
  ctx.closePath();
  ctx.fill();
  // 顶面：拆成两个三角面，各带一点明暗差 → low poly 的"切面"感
  const ty = sy - h;
  const top = [sx, ty - hh];
  const right = [sx + hw, ty];
  const bottom = [sx, ty + hh];
  const left = [sx - hw, ty];
  tri(ctx, top, right, bottom, shade(topColor, 1.06));
  tri(ctx, top, bottom, left, shade(topColor, 0.92));
}

/** 脚底阴影（椭圆），让角色不"浮空" */
export function drawShadow(ctx, sx, sy, rx = 14, ry = 7) {
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 颜色明暗（factor<1 变暗、>1 提亮，用于生成切面色） */
export function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/** 画一个三角形（low poly 切面的基本单元） */
export function tri(ctx, p1, p2, p3, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.lineTo(p3[0], p3[1]);
  ctx.closePath();
  ctx.fill();
}
