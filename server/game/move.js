'use strict';

/**
 * 移动求解：带"滑行"的碰撞处理。
 *
 * 玩家、怪物、宠物**共用这一份**——之前三处各写一套、规则还不一致，
 * 于是出现了"人滑得动、怪滑不动"这类怪现象。
 *
 * 设计要点（按顺序尝试，只要有一档能走就停）：
 *
 *   1) 直着走：完整位移，能走就走。
 *   2) 拆成单轴各试一次：斜着撞墙时，把被挡住的那个分量剥掉、保留还能走的分量，
 *      也就是"贴着墙滑"。★ 两个轴都要试（不是 else if），
 *      否则斜向撞墙会白白丢掉自由的那一半位移，手感发涩。
 *
 * 就这两档，不再加"偏转角度绕行"：
 * 实测偏 ±30°/±60° 在真实墙角处照样走不通（那两个方向物理上就是被挡的），
 * 而加大角度就等于"朝玩家没按的方向自动走"，那是坏手感。
 * 斜着过凸出的墙角本身没问题：圆心到墙角的对角线距离是 0.288×√2 ≈ 0.41，
 * 大于碰撞半径 0.3，所以能顺畅蹭过去，不会"勾住"墙角。
 *
 * 另外注意：地图最外圈是墙，但传送点是直接盖在边界格上的，
 * 所以"能不能站"一律交给 circleHitsWall 判断（它按 tile 判定，传送点不是墙）。
 * **绝对不要再加"把坐标夹进 [1, w-2]"之类的兜底**——
 * 那会把踩上传送点的角色推回边界墙格上，直接卡死（历史 bug）。
 */

const { circleHitsWall } = require('./map');

/**
 * 求"带滑行"的新位置。
 *
 * @param {object} map    地图实例（含 tiles）
 * @param {number} x,y    当前位置
 * @param {number} dx,dy  期望方向（不必归一化）
 * @param {number} dist   本步位移距离（tile）
 * @param {number} radius 碰撞半径
 * @returns {{x:number, y:number}|null} 新位置；null 表示完全走不动
 */
function resolveMove(map, x, y, dx, dy, dist, radius) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || dist <= 0) return null;
  const ux = dx / len;
  const uy = dy / len;

  // ---- 1) 直着走
  const fx = x + ux * dist;
  const fy = y + uy * dist;
  if (!circleHitsWall(map, fx, fy, radius)) return { x: fx, y: fy };

  // ---- 2) 单轴滑行：两个分量各自试，能保下来的都保下来
  const cx = ux * dist;
  const cy = uy * dist;
  let ax = x;
  let ay = y;
  let moved = false;
  if (cx !== 0 && !circleHitsWall(map, x + cx, y, radius)) { ax = x + cx; moved = true; }
  if (cy !== 0 && !circleHitsWall(map, ax, y + cy, radius)) { ay = y + cy; moved = true; }
  if (moved) return { x: ax, y: ay };

  // 直着推墙（含正对墙推）就该停住 —— 不额外找方向，
  // 否则玩家会觉得"我没按那个方向，人自己动了"。
  return null;
}

/**
 * 当前位置已经卡在障碍里（老存档的越界坐标、或历史 bug 推入墙格）时的自救：
 * 螺旋向外找一个能站的地方挪过去，避免"怎么走都走不动"的死局。
 *
 * @returns {boolean} 是否发生了挪动
 */
function rescueIfStuck(map, pos, radius) {
  if (!circleHitsWall(map, pos.x, pos.y, radius)) return false;
  for (let r = 0.5; r <= 6; r += 0.5) {
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const x = pos.x + Math.cos(a) * r;
      const y = pos.y + Math.sin(a) * r;
      if (!circleHitsWall(map, x, y, radius)) {
        pos.x = x;
        pos.y = y;
        return true;
      }
    }
  }
  return false;
}

module.exports = { resolveMove, rescueIfStuck };
