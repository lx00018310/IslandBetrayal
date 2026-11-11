import { expect, it } from 'vitest';
import art from '../art.pack.ts';
import {
  islandCameraBounds,
  sackTierFor,
  moodLevelFor,
  hopPose,
  debrisPoolSize,
} from '../presentation.ts';
import { createVoxelModel } from '../voxel-builder.ts';

it.each([[1280, 720], [1280, 600], [844, 390], [390, 844]])('视口 %sx%s 保持体素比例与最低横向视野', (width, height) => {
  const view = islandCameraBounds(width, height);
  expect((view.right - view.left) / (view.top - view.bottom)).toBeCloseTo(width / height);
  expect(view.right - view.left).toBeGreaterThanOrEqual(8);
});

it('赃物麻袋按个人财富分三档，且阈值互不重叠', () => {
  expect(sackTierFor(0)).toBe(0);
  expect(sackTierFor(3)).toBe(0);
  expect(sackTierFor(4)).toBe(1);
  expect(sackTierFor(11)).toBe(1);
  expect(sackTierFor(12)).toBe(2);
  expect(sackTierFor(999)).toBe(2);
});

it('双色温情绪等级只由真实背叛/终局状态推导，结算时回落晴天', () => {
  // 平静：无背叛、无终局
  expect(moodLevelFor({ playerDisbands: 0, finalPhase: false, gameOver: false })).toBe(0);
  // 玩家主动背叛过 → 暮色
  expect(moodLevelFor({ playerDisbands: 1, finalPhase: false, gameOver: false })).toBe(1);
  // 终局阶段 → 暮色
  expect(moodLevelFor({ playerDisbands: 0, finalPhase: true, gameOver: false })).toBe(1);
  // 已结算 → 回落晴天，避免残留暮色
  expect(moodLevelFor({ playerDisbands: 2, finalPhase: true, gameOver: true })).toBe(0);
});

it('Crossy Hop 姿态：起跳拉长、落地挤压、静止回归 1:1', () => {
  const rest = hopPose(0, false);
  expect(rest.scaleY).toBe(1);
  expect(rest.scaleXZ).toBe(1);
  expect(rest.height).toBe(0);

  // 腾空最高点：Y 拉长、XZ 收缩、离地
  const apex = hopPose(1, true);
  expect(apex.scaleY).toBeGreaterThan(1);
  expect(apex.scaleXZ).toBeLessThan(1);
  expect(apex.height).toBeGreaterThan(0);

  // 落地帧：Y 挤压、XZ 膨胀、贴地
  const land = hopPose(0, true);
  expect(land.scaleY).toBeLessThan(1);
  expect(land.scaleXZ).toBeGreaterThan(1);
  expect(land.height).toBeCloseTo(0, 6);

  // 任意相位都不允许出现 0 或负缩放
  for (let i = 0; i <= 20; i++) {
    const pose = hopPose(i / 20, true);
    expect(pose.scaleY).toBeGreaterThan(0.5);
    expect(pose.scaleXZ).toBeGreaterThan(0.5);
  }
});

it('体素碎块池是固定容量，且场景里预创建了同样数量的实体', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  const entities = assets['scene/island'].entities;
  const pool = debrisPoolSize();
  expect(pool).toBeGreaterThanOrEqual(64);
  for (let i = 0; i < pool; i++) {
    expect(entities[`debris-${i}`]).toBeDefined();
    expect(entities[`debris-${i}`].components.MeshRenderer.materials).toHaveLength(1);
  }
  // 池外不应存在多余实体
  expect(entities[`debris-${pool}`]).toBeUndefined();
});

it('全场景可见几何不含球 / 柱 / 环：辅助体同样是方块拼片', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  // 这些辅助网格过去是 torus / cylinder，现在必须是方块拼成的网格
  for (const key of ['mesh/foot-ring', 'mesh/blast-ring', 'mesh/boundary-ring', 'mesh/direction-arrow', 'mesh/shadow-quad', 'mesh/telegraph-fill', 'mesh/cover-ao']) {
    const mesh = assets[key];
    expect(mesh, key).toBeDefined();
    // 方块拼片的法线只允许落在 ±X / ±Y / ±Z 六个方向上
    const normals = mesh.attributes.normal as Float32Array;
    for (let i = 0; i < normals.length; i += 3) {
      const n = [normals[i]!, normals[i + 1]!, normals[i + 2]!];
      const axisAligned = n.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-5).length;
      expect(axisAligned, `${key} 出现非轴对齐法线 ${n.join(',')}`).toBe(1);
    }
  }
});

it('浪花方块环与棋盘地块都真实绑定在场景中', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  const entities = assets['scene/island'].entities;
  for (let i = 0; i < 24; i++) expect(entities[`foam-${i}`], `foam-${i}`).toBeDefined();
  // 棋盘格需要两种奇偶网格，且地块实体按 (gx+gy) 奇偶选择
  expect(assets['mesh/tile-0-0']).toBeDefined();
  expect(assets['mesh/tile-0-1']).toBeDefined();
  const tile = entities['tile-10-10'].components.MeshFilter.assetHandle as string;
  const tileOther = entities['tile-10-11'].components.MeshFilter.assetHandle as string;
  expect(tile).not.toBe(tileOther);
});

it('体素预警填充不越出真实圆形伤害边界', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  const mesh = assets['mesh/telegraph-fill'];
  const pos = mesh.attributes.position as Float32Array;
  // 单位半径 1 的网格：所有顶点的 XZ 半径都必须 <= 1（含方块自身半宽）
  let maxRadius = 0;
  for (let i = 0; i < pos.length; i += 3) {
    maxRadius = Math.max(maxRadius, Math.hypot(pos[i]!, pos[i + 2]!));
  }
  expect(maxRadius).toBeLessThanOrEqual(1.0001);
  // 且必须是方块格阵列（顶点数远多于单个方盒 24 个顶点），不是整块方板
  expect(pos.length / 3).toBeGreaterThan(24 * 3);
  // 必须以圆心为中心（包围盒在 XZ 上对称），不允许整体偏移
  const aabb = Array.from(mesh.aabb as Float32Array);
  expect(aabb[0]! + aabb[3]!).toBeCloseTo(0, 3);
  expect(aabb[2]! + aabb[5]!).toBeCloseTo(0, 3);
  // 圆心必须有覆盖：贪心合并会把中心格子并进一个跨中心的大四边形，
  // 因此不能用「顶点靠近圆心」判断，而要看是否存在包围圆心的三角形。
  const idx = mesh.indices as Uint16Array;
  let coversCenter = false;
  for (let t = 0; t < idx.length && !coversCenter; t += 3) {
    const tri: Array<[number, number]> = [0, 1, 2].map((k) => {
      const v = idx[t + k]! * 3;
      return [pos[v]!, pos[v + 2]!] as [number, number];
    });
    // 逆时针同向法：圆心是否在三角形内（含边界）
    const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
      (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
    const d1 = sign(0, 0, tri[0]![0], tri[0]![1], tri[1]![0], tri[1]![1]);
    const d2 = sign(0, 0, tri[1]![0], tri[1]![1], tri[2]![0], tri[2]![1]);
    const d3 = sign(0, 0, tri[2]![0], tri[2]![1], tri[0]![0], tri[0]![1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(hasNeg && hasPos)) coversCenter = true;
  }
  expect(coversCenter).toBe(true);
});

it('体素构建器输出的三面明度严格递减（顶 > 前 > 右）', () => {
  const built = createVoxelModel({ unit: 1, ao: false }).voxel(0, 0, 0, '#FFFFFF').build();
  if (!built.ok) throw built.error;
  const colors = built.value.attributes.color as Float32Array;
  const normals = built.value.attributes.normal as Float32Array;
  const byNormal = new Map<string, number>();
  for (let v = 0; v < normals.length / 3; v++) {
    byNormal.set(`${normals[v * 3]},${normals[v * 3 + 1]},${normals[v * 3 + 2]}`, colors[v * 4]!);
  }
  const top = byNormal.get('0,1,0')!;
  const front = byNormal.get('0,0,1')!;
  const right = byNormal.get('1,0,0')!;
  expect(top).toBeGreaterThan(front);
  expect(front).toBeGreaterThan(right);
});

it('脚底环是空心方框：原点不被任何三角形覆盖，且几何对称', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  const mesh = assets['mesh/foot-ring'];
  const pos = mesh.attributes.position as Float32Array;
  const idx = mesh.indices as Uint16Array;

  const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  let coversOrigin = false;
  for (let t = 0; t < idx.length && !coversOrigin; t += 3) {
    const tri: Array<[number, number]> = [0, 1, 2].map((k) => {
      const v = idx[t + k]! * 3;
      return [pos[v]!, pos[v + 2]!] as [number, number];
    });
    const d1 = sign(0, 0, tri[0]![0], tri[0]![1], tri[1]![0], tri[1]![1]);
    const d2 = sign(0, 0, tri[1]![0], tri[1]![1], tri[2]![0], tri[2]![1]);
    const d3 = sign(0, 0, tri[2]![0], tri[2]![1], tri[0]![0], tri[0]![1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(hasNeg && hasPos)) coversOrigin = true;
  }
  // 空心方框：中心必须是空的（早期 bug 让这里退化成了实心方板）
  expect(coversOrigin).toBe(false);

  // 几何必须以原点为中心、且尺寸在合理范围（早期 bug 让 AABB 放大到 ±60）
  const aabb = Array.from(mesh.aabb as Float32Array);
  expect(aabb[0]! + aabb[3]!).toBeCloseTo(0, 3);
  expect(aabb[2]! + aabb[5]!).toBeCloseTo(0, 3);
  expect(aabb[3]!).toBeLessThan(1);
  expect(aabb[3]!).toBeGreaterThan(0.2);
});

it('碎块槽位材质与激活材质一致（避免扬尘喷出金块）', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  const entities = assets['scene/island'].entities;
  // 场景里每个槽位的材质必须是固定的 5 种之一，且按 i % 5 轮转
  const seen = new Set<string>();
  for (let i = 0; i < 96; i++) {
    const handle = entities[`debris-${i}`].components.MeshRenderer.materials[0] as string;
    seen.add(handle);
  }
  expect(seen.size).toBe(5);
  // 同一余数的槽位必须共用同一材质（presentation 的槽位选择依赖这一事实）
  const byRemainder = new Map<number, string>();
  for (let i = 0; i < 96; i++) {
    const handle = entities[`debris-${i}`].components.MeshRenderer.materials[0] as string;
    const rem = i % 5;
    if (byRemainder.has(rem)) expect(handle).toBe(byRemainder.get(rem));
    else byRemainder.set(rem, handle);
  }
});

it('缩圈边缘不再残留未使用的 rimChunk 网格', async () => {
  const built = await art.build(undefined as never);
  if (!built.ok) throw built.error;
  const assets = built.value as Record<string, any>;
  expect(assets['mesh/rim-chunk']).toBeUndefined();
  const entities = assets['scene/island'].entities;
  expect(Object.keys(entities).some((k) => k.includes('rim-chunk'))).toBe(false);
});
