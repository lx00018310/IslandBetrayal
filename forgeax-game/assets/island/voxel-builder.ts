// 《荒岛分赃》体素网格构建器
// 只做样件真实需要的事：体素占用网格 → 隐藏面剔除 → 同色同 AO 的贪心合并 → 单个 MeshAsset。
// 不做通用 CSG、不做指令 DSL、不做多格式导入；顶点色承载体素颜色、面亮度与折角 AO。

import { createMeshBuilder } from '@forgeax/engine/geometry';
import { AssetError } from '@forgeax/engine/types';
import type { MeshAsset, Result } from '@forgeax/engine/types';
import { err, srgbChannelToLinear } from '@forgeax/engine/types';

type Axis = 0 | 1 | 2;

interface FaceDir {
  /** 面所在轴向 */
  readonly axis: Axis;
  readonly sign: 1 | -1;
  /** 面内第一轴（u × v = normal，保证外法线绕序） */
  readonly u: Axis;
  /** 面内第二轴 */
  readonly v: Axis;
  readonly normal: readonly [number, number, number];
  /**
   * 面亮度系数（烘焙进顶点色，不依赖引擎漫反射）：
   * 顶面提亮、左前主面居中、右后背光面压暗并偏冷。
   */
  readonly shade: number;
  /** 背光面的冷色偏移量（加到蓝通道，sRGB 0..1） */
  readonly coolShift: number;
}

/**
 * 六面方向光阶：模拟固定「左上偏前」的主光。
 * 顶面 1.06 / 前 0.84 / 右 0.64（+冷偏移）/ 底 0.45，形成《天天过马路》的刀切切面感。
 */
const FACE_DIRS: readonly FaceDir[] = [
  { axis: 1, sign: 1, u: 2, v: 0, normal: [0, 1, 0], shade: 1.06, coolShift: 0 },
  { axis: 1, sign: -1, u: 0, v: 2, normal: [0, -1, 0], shade: 0.45, coolShift: 0 },
  { axis: 2, sign: 1, u: 0, v: 1, normal: [0, 0, 1], shade: 0.84, coolShift: 0 },
  { axis: 2, sign: -1, u: 1, v: 0, normal: [0, 0, -1], shade: 0.64, coolShift: 0.05 },
  { axis: 0, sign: -1, u: 2, v: 1, normal: [-1, 0, 0], shade: 0.84, coolShift: 0 },
  { axis: 0, sign: 1, u: 1, v: 2, normal: [1, 0, 0], shade: 0.64, coolShift: 0.05 },
];

/** 折角 AO 四档亮度：0 最暗（两侧都被挡），3 最亮。每级约 -12%。 */
const DEFAULT_AO_SHADE = [0.66, 0.78, 0.89, 1.0] as const;

const GRID_MIN = -64;
const GRID_SPAN = 128;
const KEY_OFFSET = 64;

export interface VoxelModelOptions {
  /** 单个体素边长（世界单位），默认 0.1 */
  readonly unit?: number;
  /** 模型枢轴（体素坐标），顶点相对枢轴生成，默认 [0,0,0]（脚底中心） */
  readonly pivot?: readonly [number, number, number];
  /** 关闭折角 AO（纯色部件可关） */
  readonly ao?: boolean;
  /** 折角 AO 亮度覆盖，长度 4 */
  readonly aoShade?: readonly number[];
}

export interface VoxelModel {
  /** 单个体素，坐标取体素格左下前角 */
  voxel(x: number, y: number, z: number, color: string): VoxelModel;
  /** 闭开区间长方体 [min, max)，颜色统一 */
  box(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    color: string,
  ): VoxelModel;
  /** XZ 圆盘柱体（半径按体素中心判定），用于岩块 / 宝珠等圆润轮廓 */
  disc(cx: number, cz: number, radius: number, y0: number, y1: number, color: string): VoxelModel;
  /** 当前已写入的体素数量（调试与测试用） */
  readonly size: number;
  build(): Result<MeshAsset, AssetError>;
}

function packKey(x: number, y: number, z: number): number {
  return (x - GRID_MIN) + (y - GRID_MIN) * GRID_SPAN + (z - GRID_MIN) * GRID_SPAN * GRID_SPAN;
}

function unpackKey(key: number, out: [number, number, number]): void {
  const x = key % GRID_SPAN;
  const y = Math.floor(key / GRID_SPAN) % GRID_SPAN;
  const z = Math.floor(key / (GRID_SPAN * GRID_SPAN));
  out[0] = x + GRID_MIN;
  out[1] = y + GRID_MIN;
  out[2] = z + GRID_MIN;
}

function hexToLinear(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const num = parseInt(clean, 16);
  return [
    srgbChannelToLinear(((num >> 16) & 255) / 255),
    srgbChannelToLinear(((num >> 8) & 255) / 255),
    srgbChannelToLinear((num & 255) / 255),
  ];
}

/**
 * 创建体素模型构建器。颜色按 sRGB 十六进制书写，构建时转线性并乘以面亮度与折角 AO。
 * 相同颜色且相同 AO 图案的相邻同向面才会合并，避免合并后 AO 插值失真。
 */
export function createVoxelModel(options: VoxelModelOptions = {}): VoxelModel {
  const unit = options.unit ?? 0.1;
  const pivot = options.pivot ?? [0, 0, 0];
  const useAo = options.ao ?? true;
  const aoShade = options.aoShade ?? DEFAULT_AO_SHADE;
  const grid = new Map<number, number>();
  const palette: Array<[number, number, number]> = [];
  const paletteIndex = new Map<string, number>();

  const colorIndex = (hex: string): number => {
    const existing = paletteIndex.get(hex);
    if (existing !== undefined) return existing;
    const index = palette.length;
    palette.push(hexToLinear(hex));
    paletteIndex.set(hex, index);
    return index;
  };

  const solid = (x: number, y: number, z: number): boolean =>
    grid.has(packKey(x, y, z));

  const voxel = (x: number, y: number, z: number, color: string): VoxelModel => {
    if (
      x < GRID_MIN || x >= GRID_MIN + GRID_SPAN ||
      y < GRID_MIN || y >= GRID_MIN + GRID_SPAN ||
      z < GRID_MIN || z >= GRID_MIN + GRID_SPAN
    ) {
      throw new Error(`voxel 坐标越界: ${x},${y},${z}`);
    }
    grid.set(packKey(x, y, z), colorIndex(color));
    return model;
  };

  const box = (
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    color: string,
  ): VoxelModel => {
    for (let x = min[0]; x < max[0]; x++)
      for (let y = min[1]; y < max[1]; y++)
        for (let z = min[2]; z < max[2]; z++) voxel(x, y, z, color);
    return model;
  };

  const disc = (
    cx: number,
    cz: number,
    radius: number,
    y0: number,
    y1: number,
    color: string,
  ): VoxelModel => {
    const r2 = radius * radius;
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      for (let z = Math.floor(cz - radius); z <= Math.ceil(cz + radius); z++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        if (dx * dx + dz * dz > r2) continue;
        for (let y = y0; y < y1; y++) voxel(x, y, z, color);
      }
    }
    return model;
  };

  const build = (): Result<MeshAsset, AssetError> => {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const cell: [number, number, number] = [0, 0, 0];
    const neighbor: [number, number, number] = [0, 0, 0];

    const scaled = (v: number, axis: Axis): number => (v - pivot[axis]) * unit;

    const pushVertex = (
      p: readonly [number, number, number],
      n: readonly [number, number, number],
      uv: readonly [number, number],
      rgb: readonly [number, number, number],
    ): void => {
      positions.push(scaled(p[0], 0), scaled(p[1], 1), scaled(p[2], 2));
      normals.push(n[0], n[1], n[2]);
      uvs.push(uv[0], uv[1]);
      colors.push(rgb[0], rgb[1], rgb[2], 1);
    };

    for (const dir of FACE_DIRS) {
      // 1. 收集该方向可见面，按切片分组；mask 键 = (u+64)*128 + (v+64)
      const slices = new Map<number, Map<number, number>>();
      for (const [key, color] of grid) {
        unpackKey(key, cell);
        neighbor[0] = cell[0];
        neighbor[1] = cell[1];
        neighbor[2] = cell[2];
        neighbor[dir.axis] += dir.sign;
        if (solid(neighbor[0], neighbor[1], neighbor[2])) continue;

        let aoBits = 0;
        if (useAo) {
          for (let corner = 0; corner < 4; corner++) {
            const du = (corner === 1 || corner === 2) ? 1 : -1;
            const dv = (corner === 2 || corner === 3) ? 1 : -1;
            const su = neighbor[0] + (dir.u === 0 ? du : 0);
            const sv = neighbor[1] + (dir.u === 1 ? du : 0);
            const sw = neighbor[2] + (dir.u === 2 ? du : 0);
            const s1 = solid(su, sv, sw);
            const tu = neighbor[0] + (dir.v === 0 ? dv : 0);
            const tv = neighbor[1] + (dir.v === 1 ? dv : 0);
            const tw = neighbor[2] + (dir.v === 2 ? dv : 0);
            const s2 = solid(tu, tv, tw);
            const s3 = solid(
              su + (dir.v === 0 ? dv : 0),
              sv + (dir.v === 1 ? dv : 0),
              sw + (dir.v === 2 ? dv : 0),
            );
            const occlusion = s1 && s2 ? 0 : 3 - (Number(s1) + Number(s2) + Number(s3));
            aoBits |= occlusion << (corner * 2);
          }
        }

        const entry = color | (aoBits << 12);
        const slice = cell[dir.axis];
        let mask = slices.get(slice);
        if (!mask) {
          mask = new Map<number, number>();
          slices.set(slice, mask);
        }
        mask.set((cell[dir.u] + KEY_OFFSET) * GRID_SPAN + (cell[dir.v] + KEY_OFFSET), entry);
      }

      // 2. 每个切片做贪心矩形合并（颜色与 AO 图案必须完全一致）
      for (const [slice, mask] of slices) {
        const used = new Set<number>();
        const keys = [...mask.keys()].sort((a, b) => a - b);
        for (const key of keys) {
          if (used.has(key)) continue;
          const entry = mask.get(key)!;
          const u0 = Math.floor(key / GRID_SPAN) - KEY_OFFSET;
          const v0 = (key % GRID_SPAN) - KEY_OFFSET;
          const keyOf = (u: number, v: number) => (u + KEY_OFFSET) * GRID_SPAN + (v + KEY_OFFSET);

          let width = 1;
          for (;;) {
            const candidate = keyOf(u0 + width, v0);
            if (mask.get(candidate) !== entry || used.has(candidate)) break;
            width++;
          }
          let height = 1;
          expand: for (;;) {
            for (let du = 0; du < width; du++) {
              const candidate = keyOf(u0 + du, v0 + height);
              if (mask.get(candidate) !== entry || used.has(candidate)) break expand;
            }
            height++;
          }
          for (let du = 0; du < width; du++)
            for (let dv = 0; dv < height; dv++) used.add(keyOf(u0 + du, v0 + dv));

          // 3. 生成四边形（u × v = normal，逆时针朝外）
          const base: [number, number, number] = [0, 0, 0];
          base[dir.axis] = slice + (dir.sign > 0 ? 1 : 0);
          base[dir.u] = u0;
          base[dir.v] = v0;
          const eu: [number, number, number] = [0, 0, 0];
          eu[dir.u] = width;
          const ev: [number, number, number] = [0, 0, 0];
          ev[dir.v] = height;
          const corners: Array<[number, number, number]> = [
            [base[0], base[1], base[2]],
            [base[0] + eu[0], base[1] + eu[1], base[2] + eu[2]],
            [base[0] + eu[0] + ev[0], base[1] + eu[1] + ev[1], base[2] + eu[2] + ev[2]],
            [base[0] + ev[0], base[1] + ev[1], base[2] + ev[2]],
          ];

          const rgb = palette[entry & 0xfff]!;
          const first = positions.length / 3;
          const cornerUv: Array<[number, number]> = [[0, 0], [width, 0], [width, height], [0, height]];
          for (let corner = 0; corner < 4; corner++) {
            const occlusion = (entry >> 12 >> (corner * 2)) & 3;
            const brightness = dir.shade * (useAo ? (aoShade[occlusion] ?? 1) : 1);
            pushVertex(
              corners[corner]!,
              dir.normal,
              cornerUv[corner]!,
              [
                rgb[0] * brightness,
                rgb[1] * brightness,
                Math.min(1, rgb[2] * brightness + dir.coolShift * brightness),
              ],
            );
          }
          indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        }
      }
    }

    if (indices.length === 0) {
      // 空模型是构建期的程序错误，明确失败而不是输出无法渲染的空网格
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'at least one voxel before build()',
          hint: 'call voxel()/box()/disc() at least once; an empty voxel model has no surface',
          detail: { field: 'grid', value: 0, reason: 'empty-model' },
        }),
      );
    }

    const builder = createMeshBuilder();
    const appended = builder.appendVertices({
      position: new Float32Array(positions),
      normal: new Float32Array(normals),
      uv: new Float32Array(uvs),
      color: new Float32Array(colors),
    });
    if (!appended.ok) return appended;
    const indexed = builder.appendIndices(indices);
    if (!indexed.ok) return indexed;
    return builder.build();
  };

  const model: VoxelModel = {
    voxel,
    box,
    disc,
    get size() {
      return grid.size;
    },
    build,
  };
  return model;
}
