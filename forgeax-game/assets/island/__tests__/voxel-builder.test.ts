import { describe, expect, it } from 'vitest';
import { createVoxelModel } from '../voxel-builder.ts';

function mesh(model: ReturnType<typeof createVoxelModel>) {
  const built = model.build();
  if (!built.ok) throw built.error;
  return built.value;
}

/** 每个三角形的几何法线（右手绕序，指向面外侧）。 */
function triangleNormals(meshAsset: ReturnType<typeof mesh>): Array<[number, number, number]> {
  const p = meshAsset.attributes.position as Float32Array;
  const indices = meshAsset.indices as Uint16Array | Uint32Array;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n: [number, number, number] = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const len = Math.hypot(...n);
    out.push([n[0] / len, n[1] / len, n[2] / len]);
  }
  return out;
}

describe('体素构建器', () => {
  it('单个体素只产生 6 个可见面，且三角形绕序朝外', () => {
    const asset = mesh(createVoxelModel({ unit: 1 }).voxel(0, 0, 0, '#808080'));
    expect((asset.indices as Uint16Array).length / 3).toBe(12);
    expect((asset.attributes.position as Float32Array).length / 3).toBe(24);

    const normals = triangleNormals(asset);
    const p = asset.attributes.position as Float32Array;
    const indices = asset.indices as Uint16Array | Uint32Array;
    for (let t = 0; t < normals.length; t++) {
      const center = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]! * 3;
        center[0] += p[v]! / 3;
        center[1] += p[v + 1]! / 3;
        center[2] += p[v + 2]! / 3;
      }
      // 体素中心在 (0.5, 0.5, 0.5)：面中心相对中心的方向必须与几何法线同向
      const outward = [center[0]! - 0.5, center[1]! - 0.5, center[2]! - 0.5];
      expect(outward[0]! * normals[t]![0]! + outward[1]! * normals[t]![1]! + outward[2]! * normals[t]![2]!).toBeGreaterThan(0);
    }
  });

  it('相邻体素之间的内部面被剔除，且共面同色格子可合并', () => {
    const model = createVoxelModel({ unit: 1, ao: false });
    model.box([0, 0, 0], [2, 2, 2], '#808080');
    const asset = mesh(model);
    // 8 个体素 × 6 面 − 内部 12 对面 × 2 = 24 个可见面，
    // 每侧 4 个同色共面格子再贪心合并为 1 个矩形 → 6 个矩形 = 12 个三角形
    expect((asset.indices as Uint16Array).length / 3).toBe(12);
    const aabb = Array.from(asset.aabb!);
    expect(aabb).toEqual([0, 0, 0, 2, 2, 2]);
  });

  it('颜色不同的相邻面不会被错误合并（保留 24 个可见面）', () => {
    const model = createVoxelModel({ unit: 1, ao: false });
    // 棋盘着色：每个体素颜色都不同，禁止贪心合并
    const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF', '#808080'];
    let i = 0;
    for (let x = 0; x < 2; x++)
      for (let y = 0; y < 2; y++)
        for (let z = 0; z < 2; z++) model.voxel(x, y, z, colors[i++]!);
    const asset = mesh(model);
    // 内部面仍然剔除，但每侧 4 个格子颜色不同，必须保留为 4 个独立四边形
    expect((asset.indices as Uint16Array).length / 3).toBe(48);
  });

  it('同色同 AO 的共面格子贪心合并为更少的四边形', () => {
    const model = createVoxelModel({ unit: 1, ao: false });
    model.box([0, 0, 0], [4, 1, 1], '#808080');
    const asset = mesh(model);
    // 4×1×1 条带：顶/底/前/后各 1 个合并矩形，左右各 1 个 → 6 个面 → 12 个三角形
    expect((asset.indices as Uint16Array).length / 3).toBe(12);
  });

  it('枢轴只平移顶点，不改变包围盒尺寸', () => {
    const model = createVoxelModel({ unit: 0.5, pivot: [2, 4, 0], ao: false });
    model.box([0, 0, 0], [4, 4, 4], '#808080');
    const aabb = Array.from(mesh(model).aabb!);
    expect(aabb[0]).toBeCloseTo(-1);
    expect(aabb[1]).toBeCloseTo(-2);
    expect(aabb[3]).toBeCloseTo(1);
    expect(aabb[4]).toBeCloseTo(0);
  });

  it('折角 AO 在凹角压暗、凸角保持最亮，且不产生纯黑', () => {
    const model = createVoxelModel({ unit: 1 });
    // L 形体素：在 (1,0,1) 的顶面形成内凹角
    model.voxel(0, 0, 0, '#FFFFFF');
    model.voxel(1, 0, 0, '#FFFFFF');
    model.voxel(0, 0, 1, '#FFFFFF');
    const asset = mesh(model);
    const colors = asset.attributes.color as Float32Array;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < colors.length; i += 4) {
      min = Math.min(min, colors[i]!);
      max = Math.max(max, colors[i]!);
    }
    // 顶面最亮档与凹角最暗档必须同时存在，且暗档不是死黑
    expect(max).toBeCloseTo(1.06, 5);
    expect(min).toBeLessThan(max * 0.7);
    expect(min).toBeGreaterThan(0.4);
  });

  it('体素颜色按 sRGB 解码为线性值，面亮度给出三面明暗', () => {
    const asset = mesh(createVoxelModel({ unit: 1, ao: false }).voxel(0, 0, 0, '#FFFFFF'));
    const colors = asset.attributes.color as Float32Array;
    const normals = asset.attributes.normal as Float32Array;
    const byAxis = new Map<string, number>();
    const byAxisBlue = new Map<string, number>();
    for (let v = 0; v < normals.length / 3; v++) {
      const key = `${normals[v * 3]!},${normals[v * 3 + 1]!},${normals[v * 3 + 2]!}`;
      byAxis.set(key, colors[v * 4]!);
      byAxisBlue.set(key, colors[v * 4 + 2]!);
    }
    // 方向光阶：顶面 > 左前主面 > 右后背光面 > 底面
    const top = byAxis.get('0,1,0')!;
    const front = byAxis.get('0,0,1')!;
    const left = byAxis.get('-1,0,0')!;
    const right = byAxis.get('1,0,0')!;
    const back = byAxis.get('0,0,-1')!;
    const bottom = byAxis.get('0,-1,0')!;
    expect(top).toBeGreaterThan(front);
    expect(front).toBeGreaterThan(right);
    expect(left).toBeGreaterThan(right);
    expect(right).toBeGreaterThan(bottom);
    // 背光面叠加冷色偏移（蓝通道相对红通道更高）
    expect(byAxisBlue.get('1,0,0')!).toBeGreaterThan(right);
    expect(byAxisBlue.get('0,0,-1')!).toBeGreaterThan(back);
    // 顶面仍是最亮、底面最暗的固定关系
    expect(top).toBeCloseTo(1.06, 5);
    expect(bottom).toBeCloseTo(0.45, 5);
  });

  it('空模型返回结构化错误而不是静默输出空网格', () => {
    const built = createVoxelModel().build();
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('asset-invalid-value');
  });
});
