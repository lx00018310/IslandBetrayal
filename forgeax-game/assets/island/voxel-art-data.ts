// 《荒岛分赃》体素美术数据
// 只用原生几何与顶点色构建模型：Tibo 小狗、寄居宝箱蟹 Boss、青苔岩块掩体、
// 共享宝箱、掉落金砖、三武器、怪潮与阶梯地块。数据与装配分离，art.pack.ts 只负责场景。
//
// 坐标约定：
// - 每个部件都写在「角色/实体局部体素坐标」里（脚底 y = 0），枢轴也是同一坐标系中的绝对点。
// - 构建时顶点相对枢轴生成，因此把部件实体放在局部原点即可还原正确位置，旋转也绕真实关节。
// - 1 体素 = unit 个世界单位。

import type { AssetError, MeshAsset, Result } from '@forgeax/engine/types';
import { createVoxelModel } from './voxel-builder.ts';

// ---------------------------------------------------------------------------
// 共享色板（sRGB 十六进制；构建时转线性并叠加面亮度与折角 AO）
// ---------------------------------------------------------------------------

export const VOXEL_PALETTE = {
  // Tibo 萌系潮玩小柴犬：奶油白毛 + 柴犬赤金暖毛 + 亮黑萌眼 + 星星眼神光 + 软萌腮红 + 卷翘萌尾
  furCream: '#FBF5EB',
  furWarm: '#E39F58',
  furShade: '#CF8742',
  furWhite: '#FFFFFF',
  earOuter: '#CD7B32',
  earInner: '#F8A8A7',
  paw: '#FFF9F0',
  pawPad: '#F08B92',
  nose: '#221815',
  eye: '#1C1514',
  eyeSparkle: '#FFFFFF',
  blush: '#FFA49E',
  tongue: '#FF6F86',
  eyebrow: '#FFFDF7',
  tailTip: '#FFFFFF',
  sack: '#6E5233',
  sackRope: '#3F2E1C',
  collar: '#E74C3C',
  collarBell: '#FFD700',
  // 潮玩积木通用色
  gold: '#F0C24B',
  goldDark: '#B8892B',
  wood: '#8A6134',
  woodDark: '#5C3F21',
  iron: '#5B6470',
  // 寄居宝箱蟹
  crabShell: '#A8794A',
  crabShellDark: '#8A5F35',
  crabClaw: '#D8503C',
  crabClawLight: '#F2735B',
  crabEye: '#FF3A2E',
  // 青苔岩块
  moss: '#6E9B54',
  mossLight: '#8FB86A',
  rockWarm: '#7C7A72',
  rockCool: '#5C636B',
  rockDeep: '#4A5058',
  // 怪潮
  monsterBody: '#241C33',
  monsterBodyLight: '#3A2C4E',
  monsterHorn: '#141020',
  monsterGlow: '#FF5A1E',
  // 宝物与技能
  blade: '#DCE9F5',
  bladeEdge: '#FFFFFF',
  hilt: '#6C4A2A',
  arrowShaft: '#E8D08A',
  arrowHead: '#FFF6C2',
  fletch: '#FFFFFF',
  bombShell: '#232833',
  bombFuse: '#FF7A2E',
  laserCore: '#FFFFFF',
  laserGlow: '#38BDF8',
  laserPrism: '#818CF8',
  cycloneWind: '#6EE7B7',
  cycloneCore: '#A7F3D0',
  boomerangGold: '#FBBF24',
  boomerangEdge: '#FEF08A',
  hammerHead: '#475569',
  hammerShaft: '#78350F',
  hammerRune: '#F59E0B',
  smokePoison: '#A855F7',
  smokeMisty: '#C084FC',
  hpBg: '#0F172A',
  hpBorder: '#334155',
  hpGreen: '#22C55E',
  hpYellow: '#EAB308',
  hpRed: '#EF4444',
  // 战利品
  goldBar: '#FFD34D',
  goldBarLight: '#FFF3A8',
  goldBarDark: '#C79A1E',
  // 地形
  sand: '#D9C69C',
  sandDeep: '#C4B189',
  rockLayer: '#8C9199',
  rockLayerDeep: '#6B7076',
} as const;

const P = VOXEL_PALETTE;

/** 按系数微调 sRGB 十六进制明度（仅用于地块棋盘格的微差，不改变色相）。 */
function shadeHex(hex: string, factor: number): string {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const num = parseInt(clean, 16);
  const channels = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * factor))),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 地块表层色（低对比、适度降饱和）：只用微弱色差区分地块，
 * 不让棋盘格抢占单位与弹药的注意力。索引与模拟层的 `band` 一致。
 */
export const GROUND_BAND_COLORS: readonly string[] = [
  '#4E7A48', // 0 内圈草地
  '#578450',
  '#5F8C56',
  '#6D955E',
  '#8E9A6A', // 草地 → 沙滩过渡
  '#CDBB8E', // 5 外圈沙滩
];

/**
 * 身份色（原 pixel-art-data.ts 的 L2 单位层色板，唯一被运行时使用的一组）。
 * 迁移到这里后，旧 2D 贴图生成器不再被任何代码引用。
 */
export const AI_IDENTITY_COLORS = {
  friendly: '#38BDF8',
  greedy: '#FACC15',
  raider: '#E879F9',
} as const;

export const TIBO_UNIT = 0.1;

// ---------------------------------------------------------------------------
// Tibo 萌柴犬（10 名参赛者共用骨骼结构，躯干由角色身份材质着色）
// 经典日系潮玩体态：大眼高光、软萌腮红、粉舌微笑吻部、卷翘面包尾、金铃铛项圈
// ---------------------------------------------------------------------------

/** 躯干（顶点色纯白交由身份材质着色，胸前配有饱满雪白围兜） */
export function tiboBody(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT });
  model.box([-3, 2, -2], [3, 7, 3], '#FFFFFF');
  // 胸前饱满立体围兜，凸显萌系头身分界
  model.box([-2, 3, 3], [2, 6, 4], P.furCream);
  return model.build();
}

/** 头部 + 萌系大眼带高光 + 软萌腮红 + 微笑吻部与粉舌；枢轴在脖颈 y = 7 */
export function tiboHead(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [0, 7, 0] });
  // 头部轮廓：下颌微收，两侧饱满
  model.box([-4, 7, -3], [4, 13, 4], P.furCream);
  model.box([-3, 6, -2], [3, 7, 3], P.furCream);
  // 顶部与后脑勺赤金暖毛
  model.box([-4, 12, -3], [4, 13, 4], P.furWarm);
  model.box([-4, 8, -3], [4, 12, -2], P.furWarm);
  // 柴犬招牌：额头一对浅白豆豆眉
  model.box([-3, 12, 3], [-1, 13, 4], P.eyebrow);
  model.box([1, 12, 3], [3, 13, 4], P.eyebrow);
  // 饱满立体口鼻吻部
  model.box([-2, 8, 4], [2, 10, 7], P.furWhite);
  model.box([-2, 7, 4], [2, 8, 6], P.furCream);
  // 乌黑湿润小鼻头
  model.box([-1, 9, 6], [1, 10, 7], P.nose);
  // 鼻下微露小粉舌（呆萌吐舌）
  model.box([-1, 8, 6], [1, 9, 7], P.tongue);
  // 灵动大双眼：乌黑眸底 + 白色星星眼神光（一秒变萌）
  model.box([-3, 10, 3], [-1, 12, 4], P.eye);
  model.box([-2, 11, 3], [-1, 12, 4], P.eyeSparkle);
  model.box([1, 10, 3], [3, 12, 4], P.eye);
  model.box([2, 11, 3], [3, 12, 4], P.eyeSparkle);
  // 两颊软萌粉红腮红
  model.box([-4, 9, 3], [-3, 10, 4], P.blush);
  model.box([3, 9, 3], [4, 10, 4], P.blush);
  return model.build();
}

/** 灵动三角萌耳（side = -1 左 / +1 右）；外立暖赤金，内凹粉嫩耳窝 */
export function tiboEar(side: -1 | 1): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [side * 4, 12, 0] });
  const x0 = side < 0 ? -6 : 4;
  const x1 = side < 0 ? -4 : 6;
  // 耳背暖赤金
  model.box([x0, 8, -1], [x1, 12, 2], P.earOuter);
  // 内侧立体粉嫩耳窝
  model.box([x0, 9, 1], [x1, 11, 2], P.earInner);
  // 耳尖俏丽微白
  model.box([x0, 11, 0], [x1, 12, 1], P.furCream);
  return model.build();
}

/** 肉嘟嘟萌爪短腿；前足雪白白手套，爪底带粉嫩小肉垫 */
export function tiboLegs(front: boolean): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [0, 3, 0] });
  const z0 = front ? 1 : -2;
  const z1 = front ? 3 : 0;
  for (const [x0, x1] of [[-3, -1], [1, 3]] as const) {
    // 腿部暖毛
    model.box([x0, 1, z0], [x1, 3, z1], P.furCream);
    // 足底白手套
    model.box([x0, 0, z0], [x1, 1, z1], P.paw);
    // 爪底小粉肉垫（跑动跳跃时隐现）
    model.box([x0, 0, z0], [x1, 0, z1], P.pawPad);
  }
  return model.build();
}

/** 柴犬标志性卷翘面包尾（螺旋上卷 + 蓬松白尾尖） */
export function tiboTail(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [0, 6, -2] });
  // 尾根向上斜扬
  model.box([-1, 6, -3], [1, 8, -2], P.furWarm);
  // 尾中向前弯卷成面包圈弧度
  model.box([-1, 8, -3], [1, 10, -1], P.furWarm);
  // 卷翘末梢大白尾尖
  model.box([-1, 9, -2], [1, 11, 0], P.tailTip);
  return model.build();
}

/** 背上赃物麻袋（按个人财富分档缩放）；枢轴在躯干顶部 y = 7 */
export function tiboSack(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [0, 7, 0] });
  model.box([-2, 2, -4], [2, 5, -2], P.sack);
  model.box([-2, 5, -4], [2, 6, -3], P.sack);
  model.box([-2, 4, -4], [2, 5, -3], P.sackRope);
  return model.build();
}

/** 潮玩朱红项圈 + 正面立体悬垂小金铃铛 */
export function tiboCollar(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [0, 7, 0], ao: false });
  // 朱红项圈环
  model.box([-3, 6, -3], [3, 7, 3], P.collar);
  // 正面悬挂的金色小铜铃
  model.box([-1, 5, 3], [1, 7, 4], P.collarBell);
  return model.build();
}

// ---------------------------------------------------------------------------
// 寄居宝箱蟹 Boss（一种模型覆盖现有两次出场）
// 摄像机是 55° 俯视，因此可读细节必须落在顶面与侧面：拱形箱盖、金包角、
// 向两侧伸出的红色蟹钳与六条蟹腿。包围盒 24 × 16 × 14 体素（unit 0.1）
// ---------------------------------------------------------------------------

/** 木箱外壳 + 拱形箱盖 + 金包角 + 六条蟹腿；枢轴在脚底中心 */
export function mimicShell(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT });
  // 箱体（略收窄，留出钳与腿的空间）
  model.box([-6, 3, -5], [6, 10, 5], P.crabShell);
  // 木板分缝（顶面可见）
  for (const z of [-3, 0, 3]) model.box([-6, 3, z], [6, 4, z + 1], P.woodDark);
  model.box([-6, 5, -5], [6, 6, 5], P.crabShellDark);
  // 铁包角（左右两侧 + 底部）
  model.box([-6, 3, -5], [-5, 10, 5], P.iron);
  model.box([5, 3, -5], [6, 10, 5], P.iron);
  model.box([-6, 3, -5], [6, 4, 5], P.iron);
  // 拱形箱盖：顶面阶梯收窄，从上方读出弧形
  model.box([-6, 10, -5], [6, 12, 5], P.crabShell);
  model.box([-5, 12, -4], [5, 13, 4], P.crabShell);
  model.box([-3, 13, -2], [3, 14, 2], P.crabShellDark);
  // 金色包边：顶面两条横跨金带 + 中心锁扣
  model.box([-6, 12, -1], [6, 13, 1], P.gold);
  model.box([-1, 13, -4], [1, 15, 4], P.gold);
  model.box([-6, 11, -5], [6, 12, -4], P.goldDark);
  model.box([-6, 11, 4], [6, 12, 5], P.goldDark);
  // 六条蟹腿：左右各三条，向外伸出并落地
  for (const [z0, z1] of [[-5, -3], [-1, 1], [3, 5]] as const) {
    model.box([-9, 2, z0], [-6, 4, z1], P.crabShellDark);
    model.box([6, 2, z0], [9, 4, z1], P.crabShellDark);
    model.box([-10, 0, z0], [-8, 2, z1], P.iron);
    model.box([8, 0, z0], [10, 2, z1], P.iron);
  }
  return model.build();
}

/** 蟹钳（side = -1 左 / +1 右）：从箱体侧面向外伸出的两块钳形，枢轴在钳根 */
export function mimicClaw(side: -1 | 1): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, pivot: [side * 6, 7, 1] });
  const x0 = side < 0 ? -6 : 0;
  const x1 = side < 0 ? 0 : 6;
  // 钳臂：向外伸出 6 体素，顶面宽、底部收窄，从上方读出钳形
  model.box([x0, 4, -2], [x1, 8, 4], P.crabClaw);
  model.box([x0, 7, -2], [x1, 8, 4], P.crabClawLight);
  // 钳口：中间挖出缝隙，读成开合的钳
  model.box([x0, 5, 0], [x1, 7, 2], P.crabShellDark);
  // 钳尖上翘，形成外轮廓记忆点
  const tipX0 = side < 0 ? -8 : 4;
  const tipX1 = side < 0 ? -5 : 7;
  model.box([tipX0, 7, -1], [tipX1, 9, 3], P.crabClawLight);
  return model.build();
}

/** 蟹眼：位于箱盖前缘的红色眼柱，俯视下仍是高对比识别点 */
export function mimicEyes(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: TIBO_UNIT, ao: false });
  model.box([-4, 14, 2], [-2, 16, 4], P.crabEye);
  model.box([2, 14, 2], [4, 16, 4], P.crabEye);
  return model.build();
}

// ---------------------------------------------------------------------------
// 青苔岩块掩体：半径 1.0、高 1.4 世界单位的体素圆盘柱
// 呈现层按 activeCovers.radius 缩放 x/z，轮廓贴合近似圆形碰撞
// ---------------------------------------------------------------------------

export function coverRock(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.1 });
  model.disc(0, 0, 10, 0, 3, P.rockDeep);
  model.disc(0, 0, 9.6, 3, 7, P.rockCool);
  model.disc(0, 0, 8.6, 7, 11, P.rockWarm);
  model.disc(0, 0, 7.4, 11, 13, P.rockWarm);
  model.disc(0, 0, 6.6, 13, 14, P.moss);
  // 侧面青苔斑块
  model.box([-5, 8, 5], [-1, 11, 9], P.moss);
  model.box([3, 4, -9], [6, 7, -5], P.moss);
  return model.build();
}

// ---------------------------------------------------------------------------
// 共享宝箱（金铜箱体 + 木框 + 锁扣 + 真实 HP 裂纹）
// ---------------------------------------------------------------------------

export function teamChestBody(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.05 });
  model.box([-8, 0, -6], [8, 10, 6], P.gold);
  model.box([-8, 0, -6], [8, 2, 6], P.woodDark);
  model.box([-8, 0, -6], [-6, 10, 6], P.woodDark);
  model.box([6, 0, -6], [8, 10, 6], P.woodDark);
  model.box([-8, 5, -6], [8, 6, 6], P.wood);
  model.box([-8, 9, -6], [8, 10, 6], P.goldDark);
  return model.build();
}

export function teamChestLid(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.05 });
  model.box([-8, 0, -6], [8, 3, 6], P.gold);
  model.box([-8, 2, -6], [8, 3, 6], P.goldDark);
  model.box([-8, 0, -6], [-6, 3, 6], P.woodDark);
  model.box([6, 0, -6], [8, 3, 6], P.woodDark);
  return model.build();
}

export function teamChestLock(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.05, ao: false });
  model.box([-2, 0, 0], [2, 4, 1], P.goldDark);
  model.box([-1, 1, 1], [1, 3, 2], P.nose);
  return model.build();
}

/** 箱体裂纹（仅在真实 HP 低于一半时显示，不新增模拟层状态） */
export function teamChestCrack(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.05, ao: false });
  model.box([-1, 4, 6], [0, 7, 7], P.nose);
  model.box([0, 6, 6], [2, 7, 7], P.nose);
  model.box([-3, 2, 6], [-1, 5, 7], P.nose);
  return model.build();
}

// ---------------------------------------------------------------------------
// 掉落金砖 / 武器 / 怪潮 / 场景道具
// ---------------------------------------------------------------------------

/** 4 × 4 × 2 厚金砖；枢轴在中心，绕 Y 轴匀速旋转并上下浮动 */
export function lootBar(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.07, pivot: [0, 1, 0], ao: false });
  model.box([-2, 0, -2], [2, 2, 2], P.goldBar);
  model.box([-2, 1, -2], [2, 2, 2], P.goldBarLight);
  model.box([-2, 0, -2], [2, 1, -1], P.goldBarDark);
  model.box([1, 0, -2], [2, 2, 2], P.goldBarDark);
  return model.build();
}

/** 飞刀：薄刃 + 木柄，绕角色环绕 */
export function weaponKnife(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.05, ao: false });
  model.box([0, 0, 0], [8, 3, 1], P.blade);
  model.box([7, 0, 0], [9, 3, 1], P.bladeEdge);
  model.box([0, 2, 0], [8, 3, 1], P.bladeEdge);
  model.box([-3, 0, 0], [0, 3, 1], P.hilt);
  return model.build();
}

/** 箭矢：沿 +Y 指向飞行方向（呈现层把 +Y 旋转到速度方向） */
export function weaponArrow(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.06, ao: false });
  model.box([-1, 0, -1], [1, 14, 1], P.arrowShaft);
  model.box([-1, 14, -1], [1, 17, 1], P.arrowHead);
  model.box([-2, 17, -1], [2, 19, 1], P.arrowHead);
  model.box([-1, 17, -2], [1, 19, 2], P.arrowHead);
  model.box([-2, 0, -1], [2, 2, 1], P.fletch);
  model.box([-1, 0, -2], [1, 2, 2], P.fletch);
  return model.build();
}

/** 炸弹：方块化球体 + 亮橙引信（保留兼容） */
export function weaponBomb(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.09, pivot: [0, 4, 0] });
  model.disc(0, 0, 3.6, 1, 6, P.bombShell);
  model.box([-2, 0, -2], [2, 1, 2], P.bombShell);
  model.box([-2, 5, -2], [2, 6, 2], P.monsterHorn);
  model.box([-1, 6, -1], [1, 9, 1], P.bombFuse);
  return model.build();
}

/** 宝物·星芒激光：高能贯穿晶石光柱（沿 +Z 轴延伸 6m，unit 0.12） */
export function relicLaser(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.12, pivot: [0, 0, 0], ao: false });
  // 核心贯穿强光
  model.box([-1, -1, 0], [1, 1, 48], P.laserCore);
  // 外层电离护层
  model.box([-2, -2, 0], [2, 2, 48], P.laserGlow);
  // 聚能晶石棱镜发射基座
  model.box([-3, -3, -2], [3, 3, 4], P.laserPrism);
  return model.build();
}

/** 宝物·风暴海螺：螺旋扩散旋风体（由低到高逐级扩散的体素风团） */
export function relicCyclone(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.08, pivot: [0, 0, 0], ao: false });
  // 底层窄风眼
  model.box([-2, 0, -2], [2, 3, 2], P.cycloneCore);
  model.box([-4, 1, -1], [4, 2, 1], P.cycloneWind);
  // 中层扩散风刃
  model.box([-5, 3, -5], [5, 7, 5], P.cycloneWind);
  model.box([-2, 3, -2], [2, 7, 2], P.cycloneCore);
  // 顶层外旋巨刃
  model.box([-8, 7, -3], [8, 10, 3], P.cycloneWind);
  model.box([-3, 7, -8], [3, 10, 8], P.cycloneWind);
  model.box([-3, 8, -3], [3, 11, 3], P.cycloneCore);
  return model.build();
}

/** 宝物·灵风骨刃：V 字飞翼黄金回旋镖（枢轴在重心） */
export function relicBoomerang(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.06, pivot: [0, 0, 0], ao: false });
  // 中心金色握柄
  model.box([-2, 0, -2], [2, 1, 2], P.boomerangGold);
  // 左侧前掠锋刃
  model.box([-7, 0, 0], [-2, 1, 3], P.boomerangGold);
  model.box([-8, 0, 2], [-4, 1, 4], P.boomerangEdge);
  // 右侧前掠锋刃
  model.box([2, 0, 0], [7, 1, 3], P.boomerangGold);
  model.box([4, 0, 2], [8, 1, 4], P.boomerangEdge);
  return model.build();
}

/** 宝物·巨灵战锤：长柄玄铁重锤（朝向正前方，用于猛烈砸地） */
export function relicHammer(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.08, pivot: [0, 0, -12], ao: false });
  // 长柄
  model.box([-1, 0, -12], [1, 2, 8], P.hammerShaft);
  // 握把包金
  model.box([-2, -1, -13], [2, 3, -10], P.hammerRune);
  // 硕大锤头
  model.box([-6, -2, 8], [6, 6, 18], P.hammerHead);
  // 锤面符文加固带
  model.box([-7, -1, 10], [7, 5, 16], P.hammerRune);
  return model.build();
}

/** 宝物·遁影毒雾：蓬松毒云颗粒（多重半透明感体素烟团） */
export function relicSmoke(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.09, pivot: [0, 0, 0], ao: false });
  // 中心毒核
  model.box([-3, 1, -3], [3, 6, 3], P.smokePoison);
  // 错落外散迷雾团
  model.box([-5, 2, -2], [5, 5, 2], P.smokeMisty);
  model.box([-2, 2, -5], [2, 5, 5], P.smokeMisty);
  model.box([-4, 3, -4], [4, 7, 4], P.smokeMisty);
  return model.build();
}

/** 3D 实体头顶血条底框：深暗色槽框（长 1.0m，高 0.12m） */
export function hpBarBg(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.04, pivot: [0, 0, 0], ao: false });
  // 外边框
  model.box([-13, -2, -1], [13, 2, 1], P.hpBorder);
  // 内凹底槽
  model.box([-12, -1, 0], [12, 1, 2], P.hpBg);
  return model.build();
}

/** 3D 实体头顶血条填充条（pivot 在最左侧 0，长度 24格，scale.x 直接映射 0..1 百分比） */
export function hpBarFill(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.04, pivot: [0, 0, 0], ao: false });
  model.box([0, -1, 1], [24, 1, 2], P.hpRed);
  return model.build();
}

/** 怪潮：矮扁暗体 + 双角；眼睛与背脊亮核落在顶面，俯视下仍是高对比识别点 */
export function monsterBody(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.1 });
  model.box([-4, 0, -4], [4, 2, 4], P.monsterBody);
  model.box([-4, 2, -3], [4, 3, 3], P.monsterBody);
  // 顶面背脊：比体色亮一档，避免俯视下成为纯黑块
  model.box([-3, 3, -2], [3, 4, 2], P.monsterBodyLight);
  model.box([-2, 4, -1], [2, 5, 1], P.monsterBodyLight);
  // 双角向外上方伸出
  model.box([-3, 3, -1], [-1, 6, 1], P.monsterHorn);
  model.box([1, 3, -1], [3, 6, 1], P.monsterHorn);
  return model.build();
}

export function monsterEyes(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.1, ao: false });
  // 眼睛同时贴在前缘与顶面，保证俯视/侧视都能看到亮核
  model.box([-2, 2, 4], [0, 4, 5], P.monsterGlow);
  model.box([1, 2, 4], [3, 4, 5], P.monsterGlow);
  model.box([-2, 3, 2], [0, 4, 4], P.monsterGlow);
  model.box([1, 3, 2], [3, 4, 4], P.monsterGlow);
  return model.build();
}

/** 灌木丛：三团青苔方块 */
export function bushProp(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.08 });
  model.disc(0, 0, 4.4, 0, 3, P.moss);
  model.disc(0.6, -0.6, 3.4, 3, 5, P.mossLight);
  model.box([-2, 5, -2], [2, 6, 2], P.mossLight);
  return model.build();
}

/** 小岩石道具 */
export function rockProp(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.08 });
  model.disc(0, 0, 3.6, 0, 2, P.rockDeep);
  model.disc(0, 0, 2.6, 2, 3, P.rockCool);
  model.box([-1, 3, -1], [2, 4, 1], P.rockWarm);
  return model.build();
}

/** 水晶尖塔 */
export function crystalProp(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.08 });
  model.box([-2, 0, -2], [2, 6, 2], '#5FD7F0');
  model.box([-1, 6, -1], [1, 9, 1], '#9BEAFF');
  model.box([0, 9, 0], [1, 10, 1], '#FFFFFF');
  return model.build();
}

// ---------------------------------------------------------------------------
// 阶梯地块：1.0 × 0.2 × 1.0 世界单位，顶面正好在局部 y = 0
// 表层草地（按档位烘焙色差）→ 暖沙层 → 内收岩层，随地块一起下沉/隐藏
// ---------------------------------------------------------------------------

export function groundTile(band: number, parity = 0): Result<MeshAsset, AssetError> {
  const base = GROUND_BAND_COLORS[Math.max(0, Math.min(GROUND_BAND_COLORS.length - 1, band))]!;
  // 棋盘格：按 (x + z) 奇偶做微差明度（±3%），形成《天天过马路》的跳格视觉引导，
  // 但不抢战斗信息——草地档位本身的色差仍然主导。
  const color = parity === 0 ? base : shadeHex(base, 1.055);
  const model = createVoxelModel({ unit: 0.05, pivot: [10, 4, 10], ao: false });
  // 表层草地：顶面 y = 0
  model.box([0, 3, 0], [20, 4, 20], color);
  // 中层暖沙
  model.box([0, 2, 0], [20, 3, 20], P.sand);
  model.box([0, 1, 0], [20, 2, 20], P.sandDeep);
  // 底层岩层内收一格，形成阶梯切面
  model.box([1, 0, 1], [19, 1, 19], P.rockLayer);
  return model.build();
}

// ---------------------------------------------------------------------------
// 方块拼片辅助体：替代旧圆环 / 圆锥，保证全场景可见几何都是立方体
// ---------------------------------------------------------------------------

/**
 * 用整数格建出回字形方框（替代旧 torus 圆环）。
 *
 * 构建器只接受整数体素坐标，早期版本传小数导致坐标被逐位取整、
 * 整体放大上百倍并退化成实心方板。这里改为固定整数网格：
 * 外圈 [-N..N] × [-N..N]，挖空内部 [-N+W..N-W]，得到四条空心窄边。
 *
 * @param halfSize 外半边长（世界单位）
 * @param thickness 边框厚度（世界单位）
 * @param height 高度（世界单位）
 */
export function squareFrame(
  halfSize: number,
  thickness: number,
  height: number,
): Result<MeshAsset, AssetError> {
  const N = 8; // 外半边长占 8 格
  const W = Math.max(1, Math.round((Math.max(0.001, thickness) / Math.max(0.001, halfSize)) * N));
  const unit = Math.max(0.0001, halfSize) / N;
  const rows = Math.max(1, Math.round(height / unit));
  const model = createVoxelModel({ unit, pivot: [0, 0, 0], ao: false });
  // 逐格判断，判定统一用「格中心」以保持几何对称：
  // 格 [ix, ix+1) 的中心是 ix + 0.5，因此 ix 从 -N 到 N-1 恰好覆盖 -N..N。
  for (let ix = -N; ix < N; ix++) {
    for (let iz = -N; iz < N; iz++) {
      const cx = ix + 0.5;
      const cz = iz + 0.5;
      // 内孔：中心落在 (±(N-W)) 之内则跳过，得到四条空心窄边。
      if (Math.abs(cx) < N - W && Math.abs(cz) < N - W) continue;
      for (let iy = 0; iy < rows; iy++) {
        model.voxel(ix, iy, iz, '#FFFFFF');
      }
    }
  }
  return model.build();
}

/** 用递缩方块堆出朝 +Z 的三角箭头（替代旧圆锥体）。 */
export function arrowBlocks(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.06, ao: false });
  model.box([-3, 0, -3], [3, 1, -1], '#FFFFFF');
  model.box([-2, 0, -1], [2, 1, 1], '#FFFFFF');
  model.box([-1, 0, 1], [1, 1, 2], '#FFFFFF');
  return model.build();
}

/** 纯白浪花方块簇（外圈海面上下浮动用），单簇 3 格阶梯方块。 */
export function foamCluster(): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 0.16, ao: false });
  model.box([-2, 0, -2], [2, 1, 2], '#FFFFFF');
  model.box([-1, 1, -1], [1, 2, 1], '#FFFFFF');
  model.box([0, 2, 0], [1, 3, 1], '#EAF7FF');
  return model.build();
}


/**
 * 方块化接地阴影：由「外圈淡 + 内圈稍深」两层扁平方块叠成，
 * 用顶点色做中心深、边缘浅的柔和过渡，避免硬边深色方板抢画面。
 * 尺寸按世界单位直接给出（unit = 1），由调用方缩放。
 */
export function softShadowPatch(width: number, depth: number): Result<MeshAsset, AssetError> {
  const model = createVoxelModel({ unit: 1, ao: false, pivot: [0, 0, 0] });
  // 外圈：浅一档（顶点色为灰白，实际透明度由材质 alpha 决定）
  model.box([-width / 2, 0, -depth / 2], [width / 2, 1, depth / 2], '#8C8C8C');
  // 内圈：更深，形成中心聚集的视觉重量
  model.box([-width / 4, 0, -depth / 4], [width / 4, 1, depth / 4], '#4A4A4A');
  return model.build();
}

/**
 * 体素方格预警方块阵列：用 1×1×0.25 的方块格铺满半径 1 的圆。
 * 只保留「格中心落在圆内」的格子，因此外轮廓仍贴合真实圆形伤害边界，
 * 不会像整块方形贴片那样把危险范围画大。调用方按真实半径缩放即可。
 */
export function voxelTelegraphGrid(): Result<MeshAsset, AssetError> {
  // 体素坐标必须是整数（构建器按整数格建键），因此用 unit 缩放而不是小数坐标。
  // 网格以原点为中心：ix 从 -N/2 到 N/2-1，裁剪判定统一在世界单位下做。
  const cell = 0.125;
  const cells = Math.round(2 / cell); // 覆盖 -1..1 的格数
  const lo = -cells / 2;
  const model = createVoxelModel({ unit: cell, pivot: [0, 0, 0], ao: false });
  const halfDiag = (cell * Math.SQRT2) / 2;
  for (let ix = 0; ix < cells; ix++) {
    for (let iz = 0; iz < cells; iz++) {
      // 格中心的世界坐标
      const cx = (lo + ix + 0.5) * cell;
      const cz = (lo + iz + 0.5) * cell;
      // 用「格最远角点到圆心」的距离裁剪：保证格子实体绝不越出圆形伤害边界。
      if (Math.hypot(cx, cz) + halfDiag > 1) continue;
      model.box([lo + ix, 0, lo + iz], [lo + ix + 1, 1, lo + iz + 1], '#FFFFFF');
    }
  }
  return model.build();
}
