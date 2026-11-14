// 《荒岛分赃》呈现控制层
// 驱动原生正交相机、阶梯地块下沉与重置、Tibo 小狗的蹦跳动作与受击红闪、
// 40 只怪潮、寄居宝箱蟹 Boss、三武器（飞刀/箭矢/炸弹）、真实事件反馈、连线束与脚底阴影。
//
// 约束：只读取 simulation.ts 的既有状态；不改变坐标、碰撞、移速、命中、奖励或存档规则。
// 可行走顶面恒为 y = 0，所有动作只修改视觉部件。

import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { Camera, DirectionalLight, Skylight } from '@forgeax/engine/render';
import { sceneEntity, Transform, worldResolveSceneEntity } from '@forgeax/engine/scene';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { getGrudgeScore } from './stats.ts';
import type { SimulationState } from './simulation.ts';
import {
  activeCovers,
  GRID_SIZE,
  TEAM_WARNING_DISTANCE,
  SHRINK_THRESHOLD_SECONDS,
  currentSafeRadius,
} from './simulation.ts';

const SCENE_KEY = 'scene/island' as const;

/** 大范围技能视觉裁剪上限（仅裁剪外观，真实命中范围不变） */
const VISUAL_MAX_BLAST_SCALE = 6.0;
const SPRITE_QUAT = [-0.4617486, 0, 0, 0.8870108] as const;
const SHADOW_QUAT = [-0.7071068, 0, 0, 0.7071068] as const;

/** 体素碎块装饰池容量（有界；容量不足只少粒子，不影响真实掉落与判定） */
const DEBRIS_POOL = 96;
const DEBRIS_LIFE = 0.9;
/** 碎块物理：重力与落地反弹系数（纯表现层，不参与任何玩法判定） */
const DEBRIS_GRAVITY = -18;
const DEBRIS_BOUNCE = 0.45;

/**
 * 双色温情绪光：只在真实背叛/终局状态之间插值，不新增玩法状态。
 * 冷色温 = 晴日波普；暖色温 = 背叛暮色（霓虹紫红主光 + 暗紫环境光）。
 */
const MOOD_CALM = {
  sunColor: [1.0, 0.97, 0.90] as const,
  sunIntensity: 2.6,
  skyColor: [0.45, 0.60, 0.75] as const,
  skyIntensity: 1.15,
};
// 背叛暮色：只做「色温偏移」而不是「整体染色」。
// 早期版本用 [1.0, 0.62, 0.72] + 2.35 强度，把海面染成大片粉色、压掉了预警与身份辨识，
// 按方案「若明暗变化遮蔽预警或混淆身份标识则删除该效果」的红线，改为克制版本：
// 保留接近白的主光，只让环境光偏紫，并在下面用 MOOD_MAX_BLEND 限制最大混合度。
const MOOD_BETRAYAL = {
  sunColor: [1.0, 0.86, 0.90] as const,
  sunIntensity: 2.45,
  skyColor: [0.40, 0.38, 0.62] as const,
  skyIntensity: 1.02,
};
/** 情绪光最大混合度：留一部分晴天色温，保证预警与身份标识始终清晰。 */
const MOOD_MAX_BLEND = 0.7;
/** 情绪过渡时长（秒）；暂停/结算/重开时按当前目标重新收敛。 */
const MOOD_BLEND_SECONDS = 0.8;

export interface PresentationController {
  update(sim: SimulationState, dt: number): void;
  reset(sim: SimulationState): void;
  dispose(): void;
}

/** 正交视野按真实宽高比匹配画布，竖屏保留至少 8m 横向可见范围。 */
export function islandCameraBounds(width: number, height: number) {
  const aspect = width / height;
  const halfWidth = Math.max(4, 4.5 * aspect);
  const halfHeight = halfWidth / aspect;
  return { left: -halfWidth, right: halfWidth, bottom: -halfHeight, top: halfHeight };
}

/** 个人财富 → 赃物麻袋外观档位（只读 actor.treasure，不与队伍宝箱财富混用）。 */
export function sackTierFor(treasure: number): 0 | 1 | 2 {
  if (treasure >= 12) return 2;
  if (treasure >= 4) return 1;
  return 0;
}

/**
 * 碎块材质 → 槽位余数索引。
 * 场景里 debris-0..95 的材质按 `i % 5` 固定绑定，因此只能在与材质匹配的
 * 槽位上激活碎块，否则会喷出错误颜色（例如跑步扬尘出现金块和红块）。
 * 顺序必须与 art.pack.ts 的 debrisMaterials 数组完全一致。
 */
const DEBRIS_MATERIAL_SLOT: Readonly<Record<string, number>> = Object.freeze({
  'debris-gold': 0,
  'debris-wood': 1,
  'debris-danger': 2,
  'debris-shell': 3,
  'debris-dust': 4,
});
const DEBRIS_MATERIAL_COUNT = 5;

/** 体素碎块池容量（供测试与场景装配共享同一数字）。 */
export function debrisPoolSize(): number {
  return DEBRIS_POOL;
}

/**
 * 双色温情绪等级：0 = 晴日，1 = 背叛暮色。
 * 只读取模拟层既有字段，不新增玩法状态；结算后回落晴天，避免残留暮色。
 */
export function moodLevelFor(state: {
  playerDisbands: number;
  finalPhase: boolean;
  gameOver: boolean;
}): 0 | 1 {
  if (state.gameOver) return 0;
  return state.playerDisbands > 0 || state.finalPhase ? 1 : 0;
}

export interface HopPose {
  /** Y 轴缩放（>1 拉长，<1 挤压） */
  scaleY: number;
  /** X/Z 轴缩放（与 Y 互补，保持体积感） */
  scaleXZ: number;
  /** 离地高度（世界单位） */
  height: number;
}

/**
 * Crossy Hop 姿态：`hop` 为 0..1 的腾空高度比，`moving` 为是否在移动。
 * 起跳拉长、落地挤压，静止时完全回归 1:1，避免残留形变。
 */
export function hopPose(hop: number, moving: boolean): HopPose {
  if (!moving) return { scaleY: 1, scaleXZ: 1, height: 0 };
  const clamped = Math.max(0, Math.min(1, hop));
  const stretch = 1 + clamped * 0.18;
  const squeeze = 1 - clamped * 0.12;
  // 触地瞬间（hop 接近 0）做一次挤压脉冲：Y 压扁、XZ 同时膨胀，
  // 保持体积感并读成"落地"，而不是整体缩小。
  const landAmount = clamped < 0.12 ? (0.12 - clamped) / 0.12 : 0;
  return {
    scaleY: stretch * (1 - landAmount * 0.2),
    scaleXZ: squeeze * (1 + landAmount * 0.16),
    height: clamped * 0.14,
  };
}

/**
 * 命中微弹性形变：在 hitFlash 持续期（通常 0.2s 内），
 * 瞬间给受击目标沿 Y 轴挤压、沿 XZ 轴横向膨胀，产生明确的敲击击中反馈；
 * 静止与未受击时严格回归 1:1，不影响任何物理碰撞与伤害判定。
 */
export function hitSquash(
  hitFlash: number,
  baseScale: number = 1.0,
): { scaleXZ: number; scaleY: number } {
  if (hitFlash <= 0) return { scaleXZ: baseScale, scaleY: baseScale };
  const hitImpact = Math.min(1, hitFlash / 0.2);
  return {
    scaleXZ: baseScale * (1 + hitImpact * 0.18),
    scaleY: baseScale * (1 - hitImpact * 0.20),
  };
}

interface DebrisPiece {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  spin: number;
  /** 已经反弹过的次数：最多弹 1 次，之后贴地缩小消失 */
  bounces: number;
  /** 碎块材质键（金 / 木 / 铁 / 白尘 / 猩红），池内复用，不逐帧分配 */
  material: string;
}

/** 破箱 / 背叛碎屑池：固定槽位，不依赖数组 splice，容量与实体一一对应。 */
const DEBRIS_SLOTS = DEBRIS_POOL;

export function setupPresentation(
  world: World,
  sceneRoot: EntityHandle,
  initialSim: SimulationState,
  drawingBufferSize?: () => { width: number; height: number },
): PresentationController {
  const resolve = (key: string): EntityHandle => {
    const res = worldResolveSceneEntity(world, sceneRoot, sceneEntity(SCENE_KEY, key));
    if (!res.ok) throw new Error(`Failed to resolve scene entity: ${key}`);
    return res.value;
  };
  const tryResolve = (key: string): EntityHandle | null => {
    const res = worldResolveSceneEntity(world, sceneRoot, sceneEntity(SCENE_KEY, key));
    return res.ok ? res.value : null;
  };

  const rings = Array.from({ length: 10 }, (_, id) =>
    Object.fromEntries(['player', 'ally', 'rival', 'grudge'].map(state => [state, resolve(`actor-${id}-ring-${state}`)])));
  const playerDirection = resolve('player-direction');
  const playerInnerRing = resolve('player-inner-ring');
  const coverAoEntities = [0, 1, 2].map(i => resolve(`cover-${i}-ao`));
  const coverTopEntities = [0, 1, 2].map(i => resolve(`cover-${i}-top`));
  const shrinkBoundary = resolve('shrink-boundary');
  const cameraEntity = resolve('camera');
  const sunEntity = resolve('sun');
  const skylightEntity = resolve('skylight');
  const center = (GRID_SIZE - 1) / 2;

  // 缓存 529 块地块实体（顶面 y = 0，随 falling / gone 下沉与隐藏）
  const tileEntities: Array<{ handle: EntityHandle; gx: number; gy: number; hidden: boolean }> = [];
  const propEntities: Map<string, { handle: EntityHandle }> = new Map();

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const t = initialSim.tiles[gy * GRID_SIZE + gx]!;
      if (!t.isLand) continue;
      tileEntities.push({ handle: resolve(`tile-${gx}-${gy}`), gx, gy, hidden: false });
      const prop = tryResolve(`prop-${gx}-${gy}`);
      if (prop) propEntities.set(`${gx},${gy}`, { handle: prop });
    }
  }

  // 缓存 10 名体素角色的全部部件
  interface ActorParts {
    root: EntityHandle;
    body: EntityHandle;
    head: EntityHandle;
    earLeft: EntityHandle;
    earRight: EntityHandle;
    legsFront: EntityHandle;
    legsBack: EntityHandle;
    tail: EntityHandle;
    sack: EntityHandle;
    hit: EntityHandle;
    shadow: EntityHandle;
    ringState: string | null;
  }
  const actorEntities: ActorParts[] = [];
  for (let i = 0; i < 10; i++) {
    actorEntities.push({
      root: resolve(`actor-${i}`),
      body: resolve(`actor-${i}-body`),
      head: resolve(`actor-${i}-head`),
      earLeft: resolve(`actor-${i}-ear-left`),
      earRight: resolve(`actor-${i}-ear-right`),
      legsFront: resolve(`actor-${i}-legs-front`),
      legsBack: resolve(`actor-${i}-legs-back`),
      tail: resolve(`actor-${i}-tail`),
      sack: resolve(`actor-${i}-sack`),
      hit: resolve(`actor-${i}-hit`),
      shadow: resolve(`actor-${i}-shadow`),
      ringState: null,
    });
  }

  // 缓存 40 只体素怪潮
  const monsterEntities: Array<{ root: EntityHandle; shadow: EntityHandle }> = [];
  for (let i = 0; i < 40; i++) {
    monsterEntities.push({ root: resolve(`monster-${i}`), shadow: resolve(`monster-${i}-shadow`) });
  }

  // 缓存 Boss 部件
  const bossEntity = {
    root: resolve('boss'),
    shadow: resolve('boss-shadow'),
    clawLeft: resolve('boss-claw-left'),
    clawRight: resolve('boss-claw-right'),
  };

  // 缓存 5 个共享宝箱（含真实 HP 裂纹）
  const chestEntities: Array<{ root: EntityHandle; shadow: EntityHandle; crack: EntityHandle }> = [];
  for (let i = 0; i < 5; i++) {
    chestEntities.push({
      root: resolve(`chest-${i}`),
      shadow: resolve(`chest-${i}-shadow`),
      crack: resolve(`chest-${i}-crack`),
    });
  }

  // 队伍连线束
  const teamBeamEntities: EntityHandle[] = [];
  const teamBeamWarnEntities: EntityHandle[] = [];
  for (let i = 0; i < 5; i++) {
    teamBeamEntities.push(resolve(`team-beam-${i}`));
    teamBeamWarnEntities.push(resolve(`team-beam-warn-${i}`));
  }

  const knifeEntities: EntityHandle[] = [];
  for (let i = 0; i < 40; i++) knifeEntities.push(resolve(`player-knife-${i}`));

  const arrowEntities: EntityHandle[] = [];
  for (let i = 0; i < 64; i++) arrowEntities.push(resolve(`arrow-${i}`));
  const arrowTails = Array.from({ length: 64 }, (_, i) => [0, 1].map(tail => resolve(`arrow-${i}-tail-${tail}`)));

  const bombEntities: EntityHandle[] = [];
  const blastEntities: EntityHandle[] = [];
  for (let i = 0; i < 32; i++) {
    bombEntities.push(resolve(`bomb-${i}`));
    blastEntities.push(resolve(`blast-${i}`));
  }

  const coverEntities: EntityHandle[] = [];
  for (let i = 0; i < 3; i++) coverEntities.push(resolve(`cover-${i}`));
  const raidTelegraphEntity = resolve('raid-telegraph');
  const raidTelegraphFillEntity = resolve('raid-telegraph-fill');

  const lootEntities: EntityHandle[] = [];
  for (let i = 0; i < 72; i++) lootEntities.push(resolve(`loot-${i}`));

  const debrisEntities: EntityHandle[] = [];
  for (let i = 0; i < DEBRIS_POOL; i++) debrisEntities.push(resolve(`debris-${i}`));

  // 外圈浪花方块环（纯装饰，不参与碰撞与判定）
  const foamEntities: EntityHandle[] = [];
  for (let i = 0; i < 24; i++) foamEntities.push(resolve(`foam-${i}`));

  // 宝物视觉实体池
  const laserEntities: EntityHandle[] = [];
  for (let i = 0; i < 24; i++) laserEntities.push(resolve(`laser-${i}`));

  const cycloneEntities: EntityHandle[] = [];
  for (let i = 0; i < 16; i++) cycloneEntities.push(resolve(`cyclone-${i}`));

  const boomerangEntities: EntityHandle[] = [];
  for (let i = 0; i < 16; i++) boomerangEntities.push(resolve(`boomerang-${i}`));

  const hammerEntities: EntityHandle[] = [];
  for (let i = 0; i < 10; i++) hammerEntities.push(resolve(`hammer-${i}`));

  const smokeEntities: EntityHandle[] = [];
  for (let i = 0; i < 32; i++) smokeEntities.push(resolve(`smoke-${i}`));

  // 3D 实体头顶血条系统
  const actorHpBgs: EntityHandle[] = [];
  const actorHpFills: EntityHandle[] = [];
  for (let i = 0; i < 10; i++) {
    actorHpBgs.push(resolve(`actor-${i}-hp-bg`));
    actorHpFills.push(resolve(`actor-${i}-hp-fill`));
  }

  const monsterHpBgs: EntityHandle[] = [];
  const monsterHpFills: EntityHandle[] = [];
  for (let i = 0; i < 4; i++) {
    monsterHpBgs.push(resolve(`monster-${i}-hp-bg`));
    monsterHpFills.push(resolve(`monster-${i}-hp-fill`));
  }

  const bossHpBg = resolve('boss-hp-bg');
  const bossHpFill = resolve('boss-hp-fill');

  let camX = center;
  let camZ = center + 9.8;
  const initialPlayer = initialSim.actors[0];
  if (initialPlayer) {
    camX = initialPlayer.x;
    camZ = initialPlayer.y + 9.8;
    world
      .set(cameraEntity, Transform, {
        pos: [camX, 14, camZ],
        quat: [SPRITE_QUAT[0], SPRITE_QUAT[1], SPRITE_QUAT[2], SPRITE_QUAT[3]],
      })
      .unwrap();
  }

  const spinQ = quat.create();
  const beamQ = quat.create();
  const knifeQ = quat.create();
  const arrowQ = quat.create();
  const partQ = quat.create();

  let coverStage = -1;
  let lastArrowCount = 0;
  let lastBombCount = 0;

  // 一次性事件追踪：首次加载即同步基线，不重播历史事件
  let lastBreakSeq = initialSim.lastBreakEvent?.seq ?? 0;
  let lastChestBreaks = initialSim.chestBreaks;
  let lastBossRound = initialSim.bossRound;
  let lastBossHp = initialSim.raidBossHp;
  const lastHitFlash: number[] = new Array(10).fill(0);
  /** 上一帧的跳跃相位（用于检测落地帧，避免每帧重复生成尘土）。 */
  const lastHopPhase: number[] = new Array(10).fill(0);
  let initialized = false;
  /** 固定槽位碎屑池：null 表示该槽位空闲。 */
  const debris: Array<DebrisPiece | null> = new Array(DEBRIS_SLOTS).fill(null);

  /**
   * 体素碎块迸裂：从固定槽位池取空闲槽，赋初速与重力后交给每帧积分。
   * 只做表现，容量不足时少粒子，绝不影响真实掉落、判定或模拟结果。
   */
  const spawnDebris = (
    x: number,
    y: number,
    count: number,
    material: string,
    speed = 2.4,
    upward = 1.8,
  ): void => {
    const matIdx = DEBRIS_MATERIAL_SLOT[material] ?? 0;
    let spawned = 0;
    for (let slot = 0; slot < DEBRIS_SLOTS && spawned < count; slot++) {
      // 槽位材质是按 i % 5 预绑定的，只能占用同余数槽位。
      if (slot % DEBRIS_MATERIAL_COUNT !== matIdx) continue;
      if (debris[slot]) continue;
      debris[slot] = {
        x,
        y,
        z: 0.22 + Math.random() * 0.18,
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        vz: upward * (0.6 + Math.random() * 0.8),
        life: DEBRIS_LIFE,
        maxLife: DEBRIS_LIFE,
        spin: Math.random() * Math.PI * 2,
        bounces: 0,
        material,
      };
      spawned++;
    }
  };

  const resetAll = (sim: SimulationState) => {
    for (const item of tileEntities) {
      item.hidden = false;
      world.set(item.handle, Transform, { pos: [item.gx, 0, item.gy], scale: [1, 1, 1] }).unwrap();
      const prop = propEntities.get(`${item.gx},${item.gy}`);
      if (prop) world.set(prop.handle, Transform, { pos: [item.gx, 0, item.gy], scale: [1, 1, 1] }).unwrap();
    }

    const p = sim.actors[0]!;
    camX = p.x;
    camZ = p.y + 9.8;
    world
      .set(cameraEntity, Transform, {
        pos: [camX, 14, camZ],
        quat: [SPRITE_QUAT[0], SPRITE_QUAT[1], SPRITE_QUAT[2], SPRITE_QUAT[3]],
      })
      .unwrap();

    for (let i = 0; i < 10; i++) {
      const a = sim.actors[i]!;
      const e = actorEntities[i]!;
      e.ringState = null;
      for (const ring of Object.values(rings[i]!)) world.set(ring, Transform, { pos: [0, -999, 0] }).unwrap();
      world.set(e.root, Transform, { pos: [a.x, 0, a.y], scale: [1, 1, 1], quat: [0, 0, 0, 1] }).unwrap();
      world.set(e.shadow, Transform, {
        pos: [a.x + 0.16, 0.005, a.y + 0.22],
        scale: [1, 1, 1],
        quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
      }).unwrap();
      world.set(e.hit, Transform, { pos: [0, -999, 0] }).unwrap();
      // 部件恢复默认姿态，避免重开后残留缩放或旋转
      for (const part of [e.body, e.head, e.earLeft, e.earRight, e.legsFront, e.legsBack, e.tail, e.sack]) {
        world.set(part, Transform, { scale: [1, 1, 1], quat: [0, 0, 0, 1] }).unwrap();
      }
      world.set(e.sack, Transform, { pos: [0, 0.7, 0], scale: [0.001, 0.001, 0.001] }).unwrap();
    }

    for (let i = 0; i < 40; i++) {
      const m = sim.monsters[i];
      const e = monsterEntities[i]!;
      if (m && m.alive && m.kind !== 'boss') {
        world.set(e.root, Transform, { pos: [m.x, 0, m.y], scale: [1, 1, 1] }).unwrap();
        world.set(e.shadow, Transform, {
          pos: [m.x + 0.14, 0.005, m.y + 0.18],
          scale: [0.95, 0.95, 1],
          quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
        }).unwrap();
      } else {
        world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
      }
    }

    world.set(bossEntity.root, Transform, { pos: [0, -999, 0], scale: [1, 1, 1] }).unwrap();
    world.set(bossEntity.shadow, Transform, { pos: [0, -999, 0] }).unwrap();

    for (const c of chestEntities) {
      world.set(c.root, Transform, { pos: [0, -999, 0], scale: [1, 1, 1] }).unwrap();
      world.set(c.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
      world.set(c.crack, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const b of teamBeamEntities) world.set(b, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const bw of teamBeamWarnEntities) world.set(bw, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const k of knifeEntities) world.set(k, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const arr of arrowEntities) world.set(arr, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const bm of bombEntities) world.set(bm, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const bl of blastEntities) world.set(bl, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const l of lootEntities) world.set(l, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const d of debrisEntities) world.set(d, Transform, { pos: [0, -999, 0] }).unwrap();
    world.set(raidTelegraphEntity, Transform, { pos: [0, -999, 0] }).unwrap();
    world.set(raidTelegraphFillEntity, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const tails of arrowTails) for (const tail of tails) world.set(tail, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const l of laserEntities) world.set(l, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const c of cycloneEntities) world.set(c, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const b of boomerangEntities) world.set(b, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const h of hammerEntities) world.set(h, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const s of smokeEntities) world.set(s, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const bg of actorHpBgs) world.set(bg, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const f of actorHpFills) world.set(f, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const bg of monsterHpBgs) world.set(bg, Transform, { pos: [0, -999, 0] }).unwrap();
    for (const f of monsterHpFills) world.set(f, Transform, { pos: [0, -999, 0] }).unwrap();
    world.set(bossHpBg, Transform, { pos: [0, -999, 0] }).unwrap();
    world.set(bossHpFill, Transform, { pos: [0, -999, 0] }).unwrap();

    lastArrowCount = 0;
    lastBombCount = 0;
    coverStage = -1;
    debris.fill(null);
    // 一次性事件基线重置到当前 sim，重开与刷新不重播旧事件
    lastBreakSeq = sim.lastBreakEvent?.seq ?? 0;
    lastChestBreaks = sim.chestBreaks;
    lastBossRound = sim.bossRound;
    lastBossHp = sim.raidBossHp;
    lastHitFlash.fill(0);
    lastHopPhase.fill(0);
    lastMoodBetraySeq = sim.lastBreakEvent?.seq ?? 0;
    moodActive = false;
    moodTarget = 0;
    moodBlend = 0;
    applyMood(0);
    initialized = true;
    updateCovers(sim);
  };

  /** 掩体呈现：位置、半径与消失档位完全来自 activeCovers */
  const updateCovers = (sim: SimulationState) => {
    if (coverStage === sim.shrinkStage) return;
    coverStage = sim.shrinkStage;
    const covers = activeCovers(sim);
    for (let i = 0; i < 3; i++) {
      const handle = coverEntities[i]!;
      const c = covers.find(c => c.id === i);
      if (!c) {
        world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(coverAoEntities[i]!, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(coverTopEntities[i]!, Transform, { pos: [0, -999, 0] }).unwrap();
        continue;
      }
      world.set(coverAoEntities[i]!, Transform, {
        pos: [c.x, 0.012, c.y],
        scale: [c.radius + 0.22, 1, c.radius + 0.22],
      }).unwrap();
      world.set(coverTopEntities[i]!, Transform, {
        pos: [c.x, 0.02, c.y],
        scale: [c.radius * 0.62, 1, c.radius * 0.62],
      }).unwrap();
      // 体素岩柱高 1.4；半径严格等于碰撞半径，轮廓贴合圆形判定
      world.set(handle, Transform, {
        pos: [c.x, 0, c.y],
        scale: [c.radius, 1, c.radius],
      }).unwrap();
    }
  };

  let wasGameOver = false;
  let viewportWidth = 0;
  let viewportHeight = 0;

  /**
   * 双色温情绪光（0 = 晴日，1 = 背叛暮色）。
   * 触发源全部来自模拟层既有字段：玩家主动背叛次数、断线事件、终局阶段。
   * 只影响光照颜色/强度，不改变任何玩法判定。
   */
  let moodTarget = 0;
  let moodBlend = 0;
  let lastMoodBetraySeq = initialSim.lastBreakEvent?.seq ?? 0;
  let moodActive = false;

  const applyMood = (value: number) => {
    const lerp = (a: number, b: number) => a + (b - a) * value;
    world.set(sunEntity, DirectionalLight, {
      color: [
        lerp(MOOD_CALM.sunColor[0], MOOD_BETRAYAL.sunColor[0]),
        lerp(MOOD_CALM.sunColor[1], MOOD_BETRAYAL.sunColor[1]),
        lerp(MOOD_CALM.sunColor[2], MOOD_BETRAYAL.sunColor[2]),
      ],
      intensity: lerp(MOOD_CALM.sunIntensity, MOOD_BETRAYAL.sunIntensity),
      direction: [-0.35, -0.82, -0.45],
    }).unwrap();
    world.set(skylightEntity, Skylight, {
      color: [
        lerp(MOOD_CALM.skyColor[0], MOOD_BETRAYAL.skyColor[0]),
        lerp(MOOD_CALM.skyColor[1], MOOD_BETRAYAL.skyColor[1]),
        lerp(MOOD_CALM.skyColor[2], MOOD_BETRAYAL.skyColor[2]),
      ],
      intensity: lerp(MOOD_CALM.skyIntensity, MOOD_BETRAYAL.skyIntensity),
    }).unwrap();
  };
  applyMood(0);

  return {
    reset(sim: SimulationState): void {
      resetAll(sim);
    },

    update(sim: SimulationState, dt: number): void {
      const size = drawingBufferSize?.();
      if (size && size.width > 0 && size.height > 0 && (size.width !== viewportWidth || size.height !== viewportHeight)) {
        viewportWidth = size.width;
        viewportHeight = size.height;
        world.set(cameraEntity, Camera, islandCameraBounds(size.width, size.height)).unwrap();
      }
      if (!initialized) resetAll(sim);
      if (wasGameOver && !sim.gameOver) resetAll(sim);
      wasGameOver = sim.gameOver;

      const player = sim.actors[0]!;

      // 1. 正交相机平滑跟随主角（保持当前朝向，不引入偏航；带 dt 边界防抖）
      if (player.alive) {
        const clampedDt = Math.min(dt, 0.1);
        const follow = 1 - Math.exp(-9.0 * clampedDt);
        camX += (player.x - camX) * follow;
        camZ += (player.y + 9.8 - camZ) * follow;
        world
          .set(cameraEntity, Transform, {
            pos: [camX, 14, camZ],
            quat: [SPRITE_QUAT[0], SPRITE_QUAT[1], SPRITE_QUAT[2], SPRITE_QUAT[3]],
          })
          .unwrap();
      }

      // 2. 地块下沉崩塌：只跟随模拟层 falling / gone，不改失效时刻
      for (const item of tileEntities) {
        const t = sim.tiles[item.gy * GRID_SIZE + item.gx]!;
        const prop = propEntities.get(`${item.gx},${item.gy}`);
        if (t.gone) {
          if (item.hidden) continue;
          item.hidden = true;
          world.set(item.handle, Transform, { pos: [item.gx, -999, item.gy] }).unwrap();
          if (prop) world.set(prop.handle, Transform, { pos: [item.gx, -999, item.gy] }).unwrap();
          // 地块首次消失时在海面激起一小簇白色方块水花（纯表现，不改失效时刻）。
          spawnDebris(item.gx, item.gy, 3, 'debris-dust', 1.6, 2.0);
        } else if (t.falling > 0) {
          const dropY = -t.falling * 2.8;
          // 下沉期间叠加高频微幅抖动，读成"方块在被海水拽下去"而不是平滑位移。
          // 抖动只是视觉偏移（±0.04m），不改模拟坐标与失效时刻。
          const jitterX = Math.sin(sim.elapsed * 47 + item.gx * 3.1) * 0.04;
          const jitterZ = Math.cos(sim.elapsed * 43 + item.gy * 2.7) * 0.04;
          world.set(item.handle, Transform, { pos: [item.gx + jitterX, dropY, item.gy + jitterZ] }).unwrap();
          if (prop) {
            world.set(prop.handle, Transform, {
              pos: [item.gx + jitterX, dropY + 0.04, item.gy + jitterZ],
            }).unwrap();
          }
        } else if (item.hidden) {
          item.hidden = false;
          world.set(item.handle, Transform, { pos: [item.gx, 0, item.gy] }).unwrap();
          if (prop) world.set(prop.handle, Transform, { pos: [item.gx, 0, item.gy] }).unwrap();
        }
      }

      const nextShrink = SHRINK_THRESHOLD_SECONDS[sim.shrinkStage + 1];
      const warning = nextShrink !== undefined && nextShrink - sim.elapsed <= 5;
      const boundaryRadius = currentSafeRadius(sim) * center;
      world.set(shrinkBoundary, Transform, {
        pos: warning || (sim.shrinkStage > 0 && sim.shrinkTransition < 5) ? [center, 0.03, center] : [0, -999, 0],
        scale: [boundaryRadius * 1.06, boundaryRadius * 0.94, 1],
        quat: [...SHADOW_QUAT],
      }).unwrap();

      // 3. 10 名体素角色：身份环、Crossy Hop 蹦跳、受击红闪、赃物麻袋分档
      for (let i = 0; i < 10; i++) {
        const a = sim.actors[i]!;
        const e = actorEntities[i]!;

        const grudge = sim.grudges.get(a.id);
        const state = !a.alive ? null
          : a.id === 0 ? 'player'
            : a.id === player.team ? 'ally'
              : grudge && getGrudgeScore(grudge, 0) >= 50 ? 'grudge' : 'rival';
        if (e.ringState !== state && e.ringState) world.set(rings[i]![e.ringState]!, Transform, { pos: [0, -999, 0] }).unwrap();
        e.ringState = state;
        if (state) {
          const pulse = state === 'grudge' ? 1 + Math.sin(sim.elapsed * 7) * 0.08 : 1;
          world.set(rings[i]![state]!, Transform, {
            pos: [a.x, 0.018, a.y],
            scale: [pulse, pulse, 0.35],
            quat: [...SHADOW_QUAT],
          }).unwrap();
        }
        if (i === 0) {
          world.set(playerInnerRing, Transform, {
            pos: a.alive ? [a.x, 0.022, a.y] : [0, -999, 0],
            scale: [0.85, 0.85, 0.3],
            quat: [...SHADOW_QUAT],
          }).unwrap();
          quat.fromEuler(partQ, Math.PI / 2, 0, a.facing - Math.PI / 2, 'YXZ');
          world.set(playerDirection, Transform, {
            pos: a.alive ? [a.x + Math.cos(a.facing) * 0.78, 0.04, a.y + Math.sin(a.facing) * 0.78] : [0, -999, 0],
            quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          }).unwrap();
        }

        const hpBg = actorHpBgs[i]!;
        const hpFill = actorHpFills[i]!;

        if (!a.alive) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(hpBg, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(hpFill, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        // 3D 实体头顶血条：跟随角色头顶，面向摄像机，动态比例
        const hpPct = Math.max(0.001, Math.min(1.0, a.hp / a.maxHp));
        world.set(hpBg, Transform, {
          pos: [a.x, 2.05, a.y],
          scale: [0.95, 0.95, 1],
          quat: [...SPRITE_QUAT],
        }).unwrap();
        world.set(hpFill, Transform, {
          pos: [a.x - 0.46 * (1 - hpPct), 2.05, a.y + 0.01],
          scale: [hpPct * 0.95, 0.95, 1],
          quat: [...SPRITE_QUAT],
        }).unwrap();

        const dirSign = a.vx < -0.05 ? -1 : 1;
        const speed = Math.hypot(a.vx, a.vy);
        const isMoving = speed > 0.05;
        // 时间相位（不用帧数），每个角色相位固定偏移
        const phase = sim.elapsed * 11.0 + a.id * 1.7;
        const hop = isMoving ? Math.abs(Math.sin(phase)) : 0;
        const airborne = isMoving ? Math.sin(phase) : 0;

        // 落地帧：相位从「腾空」跨到「触地」时，脚底扬起 3 颗白色方块尘土。
        // 用相位跨越判定而非每帧判定，避免落地瞬间重复生成粒子。
        const prevSin = Math.sin(lastHopPhase[i]!);
        lastHopPhase[i] = phase;
        if (isMoving && airborne <= 0 && prevSin > 0.25) {
          spawnDebris(a.x, a.y, 3, 'debris-dust', 1.1, 0.9);
        }

        // 起跳拉长 / 落地挤压（只影响视觉，不改模拟坐标与碰撞）
        const pose = hopPose(hop, isMoving);

        world.set(e.root, Transform, {
          pos: [a.x, pose.height, a.y],
          scale: [dirSign, 1, 1],
        }).unwrap();
        world.set(e.body, Transform, {
          scale: [pose.scaleXZ, pose.scaleY, pose.scaleXZ],
        }).unwrap();
        // 头部：滞空时轻微前倾
        quat.fromEuler(partQ, airborne * 0.21, 0, 0, 'XYZ');
        world.set(e.head, Transform, {
          pos: [0, 0.7, 0],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
        // 双耳：滞后半个相位（垂耳摆动）
        const earLag = Math.sin(phase - 0.9) * (isMoving ? 0.3 : 0.06);
        quat.fromEuler(partQ, 0, 0, earLag, 'XYZ');
        const earQuat = [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1] as [number, number, number, number];
        world.set(e.earLeft, Transform, { pos: [-0.4, 1.2, 0], quat: earQuat, scale: [1, 1, 1] }).unwrap();
        quat.fromEuler(partQ, 0, 0, -earLag, 'XYZ');
        world.set(e.earRight, Transform, {
          pos: [0.4, 1.2, 0],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
        // 四腿前后交替
        const swing = isMoving ? Math.sin(phase) * 0.55 : 0;
        quat.fromEuler(partQ, swing, 0, 0, 'XYZ');
        world.set(e.legsFront, Transform, {
          pos: [0, 0.3, 0],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
        quat.fromEuler(partQ, -swing, 0, 0, 'XYZ');
        world.set(e.legsBack, Transform, {
          pos: [0, 0.3, 0],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
        // 尾巴摇动
        quat.fromEuler(partQ, 0, Math.sin(phase * 1.6) * 0.35, 0, 'XYZ');
        world.set(e.tail, Transform, {
          pos: [0, 0.6, -0.2],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
        // 赃物麻袋：只读个人财富分三档（0 / 0.7 / 1.0），0 档隐藏
        const tier = sackTierFor(a.treasure);
        const sackScale = tier === 0 ? 0.001 : tier === 1 ? 0.7 : 1.0;
        world.set(e.sack, Transform, { pos: [0, 0.7, 0], scale: [sackScale, sackScale, sackScale] }).unwrap();

        world.set(e.hit, Transform, { pos: [0, a.hitFlash > 0 ? 0 : -999, 0] }).unwrap();

        world.set(e.shadow, Transform, {
          pos: [a.x + 0.08, 0.006, a.y + 0.1],
          scale: [1, 1, 1],
          quat: [0, 0, 0, 1],
        }).unwrap();
      }

      // 4. 40 只怪潮池
      for (let i = 0; i < 40; i++) {
        const m = sim.monsters[i];
        const e = monsterEntities[i]!;
        const mHpBg = i < 4 ? monsterHpBgs[i] : null;
        const mHpFill = i < 4 ? monsterHpFills[i] : null;
        if (!m || !m.alive || m.kind === 'boss') {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          if (mHpBg) world.set(mHpBg, Transform, { pos: [0, -999, 0] }).unwrap();
          if (mHpFill) world.set(mHpFill, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        const bob = Math.abs(Math.sin(sim.elapsed * 2.8 + m.wobble)) * 0.08;
        const mBaseScale = m.kind === 'tank' ? 1.25 : m.kind === 'dasher' ? 0.85 : 1.0;
        const squashed = hitSquash(m.hitFlash, mBaseScale);
        world.set(e.root, Transform, { pos: [m.x, bob, m.y], scale: [squashed.scaleXZ, squashed.scaleY, squashed.scaleXZ] }).unwrap();
        world.set(e.shadow, Transform, {
          pos: [m.x, 0.008, m.y],
          scale: [squashed.scaleXZ, 1, squashed.scaleXZ],
          quat: [0, 0, 0, 1],
        }).unwrap();

        // 基础怪物 3D 头顶血条（为前 4 只主要怪物渲染清晰血条）
        if (mHpBg && mHpFill) {
          const mPct = Math.max(0.001, Math.min(1.0, m.hp / m.maxHp));
          world.set(mHpBg, Transform, {
            pos: [m.x, 1.45, m.y],
            scale: [0.75, 0.75, 1],
            quat: [...SPRITE_QUAT],
          }).unwrap();
          world.set(mHpFill, Transform, {
            pos: [m.x - 0.36 * (1 - mPct), 1.45, m.y + 0.01],
            scale: [mPct * 0.75, 0.75, 1],
            quat: [...SPRITE_QUAT],
          }).unwrap();
        }
      }

      // 5. Boss：仅团战阶段可见，两次出场复用同一模型
      if (sim.raidPhase === 'none' || sim.raidPhase === 'result' || sim.raidBossHp <= 0) {
        world.set(bossEntity.root, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(bossEntity.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(bossHpBg, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(bossHpFill, Transform, { pos: [0, -999, 0] }).unwrap();
      } else {
        const bob = Math.abs(Math.sin(sim.elapsed * 2.2)) * 0.1;
        // 体素外壳本身已 2.2 × 1.3 世界单位，1.15 倍即占屏接近原 Boss
        const baseScale = 1.15 + Math.sin(sim.elapsed * 2.2) * 0.02;
        const bossSquashed = hitSquash(sim.boss?.hitFlash ?? 0, baseScale);
        world.set(bossEntity.root, Transform, {
          pos: [sim.raidBossX, bob, sim.raidBossY],
          scale: [bossSquashed.scaleXZ, bossSquashed.scaleY, bossSquashed.scaleXZ],
        }).unwrap();
        world.set(bossEntity.shadow, Transform, {
          pos: [sim.raidBossX + 0.14, 0.006, sim.raidBossY + 0.18],
          scale: [2.6, 1, 2.2],
          quat: [0, 0, 0, 1],
        }).unwrap();

        // Boss 3D 巨型头顶血条
        const bPct = Math.max(0.001, Math.min(1.0, sim.raidBossHp / Math.max(1, sim.raidBossMaxHp)));
        world.set(bossHpBg, Transform, {
          pos: [sim.raidBossX, 2.7, sim.raidBossY],
          scale: [2.2, 1.4, 1],
          quat: [...SPRITE_QUAT],
        }).unwrap();
        world.set(bossHpFill, Transform, {
          pos: [sim.raidBossX - 1.05 * (1 - bPct), 2.7, sim.raidBossY + 0.01],
          scale: [bPct * 2.2, 1.4, 1],
          quat: [...SPRITE_QUAT],
        }).unwrap();
        // 蟹钳开合：预警期间张到最大，与真实圆形成一致
        const open = sim.raidTelegraphTimer > 0 ? 1 : 0.35;
        quat.fromEuler(partQ, 0, open * 0.5, 0, 'XYZ');
        const clawQuat = [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1] as [number, number, number, number];
        world.set(bossEntity.clawLeft, Transform, { pos: [-0.7, 0.6, 0.3], quat: clawQuat, scale: [1, 1, 1] }).unwrap();
        quat.fromEuler(partQ, 0, -open * 0.5, 0, 'XYZ');
        world.set(bossEntity.clawRight, Transform, {
          pos: [0.7, 0.6, 0.3],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          scale: [1, 1, 1],
        }).unwrap();
      }

      // 5b. 中央掩体（位置与半径严格等于 activeCovers）
      updateCovers(sim);

      // 5c. 圆形预警：保留准确圆边（命中判定仍是圆），填充只作辅助
      if (sim.raidTelegraphTimer > 0) {
        const scale = Math.min(VISUAL_MAX_BLAST_SCALE, sim.raidTelegraphRadius);
        world.set(raidTelegraphEntity, Transform, {
          pos: [sim.raidTelegraphX, 0.026, sim.raidTelegraphY],
          scale: [scale, scale, 1],
          quat: [...SHADOW_QUAT],
        }).unwrap();
        // 体素方格填充严格与圆环同半径（格子已按圆裁剪），只做轻微脉冲，
        // 绝不放大到圆外，避免把真实危险范围画大。
        const pulseScale = scale * (1 + Math.sin(sim.elapsed * 18) * 0.015);
        world.set(raidTelegraphFillEntity, Transform, {
          pos: [sim.raidTelegraphX, 0.024, sim.raidTelegraphY],
          scale: [pulseScale, 1, pulseScale],
        }).unwrap();
      } else {
        world.set(raidTelegraphEntity, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(raidTelegraphFillEntity, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 6. 共享宝箱：跟随、财富档位缩放、真实 HP 裂纹
      const activeChests = sim.chests.filter((c) => c.hp > 0 || c.treasure > 0);
      for (let i = 0; i < 5; i++) {
        const e = chestEntities[i]!;
        const c = activeChests[i];
        if (!c) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        const size = 0.85 + Math.min(0.45, c.treasure * 0.04);
        world.set(e.root, Transform, { pos: [c.x, 0, c.y], scale: [size, size, size] }).unwrap();
        world.set(e.shadow, Transform, {
          pos: [c.x + 0.12, 0.006, c.y + 0.16],
          scale: [size * 1.1, 1, size * 0.8],
          quat: [0, 0, 0, 1],
        }).unwrap();
        // 裂纹只读真实 HP（低于一半时显示）
        const cracked = c.hp > 0 && c.maxHp > 0 && c.hp < c.maxHp * 0.5;
        world.set(e.crack, Transform, { pos: [0, cracked ? 0 : -999, 0], scale: [1, 1, 1] }).unwrap();
      }

      // 7. 队伍连线束与超距预警
      const teamPairs: Array<{ a: typeof sim.actors[0]; b: typeof sim.actors[0]; dist: number }> = [];
      for (const a of sim.actors) {
        if (!a.alive || a.team < 0 || a.id > a.team) continue;
        const b = sim.actors[a.team];
        if (b && b.alive) teamPairs.push({ a, b, dist: Math.hypot(a.x - b.x, a.y - b.y) });
      }
      for (let i = 0; i < 5; i++) {
        const beamHandle = teamBeamEntities[i]!;
        const warnHandle = teamBeamWarnEntities[i]!;
        const pair = teamPairs[i];
        if (!pair) {
          world.set(beamHandle, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(warnHandle, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        const midX = (pair.a.x + pair.b.x) / 2;
        const midZ = (pair.a.y + pair.b.y) / 2;
        const length = Math.max(0.2, pair.dist);
        quat.fromLookAt(beamQ, [pair.a.x, 0.2, pair.a.y], [pair.b.x, 0.2, pair.b.y], [0, 1, 0]);
        const isWarning = pair.dist >= TEAM_WARNING_DISTANCE * sim.rules.tetherModifier;
        const activeHandle = isWarning ? warnHandle : beamHandle;
        const inactiveHandle = isWarning ? beamHandle : warnHandle;
        world.set(activeHandle, Transform, {
          pos: [midX, 0.2, midZ],
          scale: [1, 1, length],
          quat: [beamQ[0] ?? 0, beamQ[1] ?? 0, beamQ[2] ?? 0, beamQ[3] ?? 1],
        }).unwrap();
        world.set(inactiveHandle, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 8. 环绕飞刀
      let knifeSlot = 0;
      for (let ai = 0; ai < 10; ai++) {
        const actor = sim.actors[ai]!;
        if (!actor.alive || actor.weaponKnife <= 0) continue;
        const count = actor.weaponKnife + (actor.relicAffix === 'knifeArea' ? 1 : 0);
        const radius = 1.6 * (1 + actor.statAreaBonus) * sim.rules.knifeRangeModifier;
        for (let k = 0; k < count && knifeSlot < knifeEntities.length; k++, knifeSlot++) {
          const handle = knifeEntities[knifeSlot]!;
          const ang = actor.knifeAngle + (k * Math.PI * 2) / count;
          const kx = actor.x + Math.cos(ang) * radius;
          const kz = actor.y + Math.sin(ang) * radius;
          quat.fromEuler(knifeQ, 0, ang + Math.PI / 2, 0, 'YXZ');
          world.set(handle, Transform, {
            pos: [kx, 0.42, kz],
            scale: [1, 1, 1],
            quat: [knifeQ[0] ?? 0, knifeQ[1] ?? 0, knifeQ[2] ?? 0, knifeQ[3] ?? 1],
          }).unwrap();
        }
      }
      for (let k = knifeSlot; k < knifeEntities.length; k++) {
        world.set(knifeEntities[k]!, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 9. 穿透箭矢（+Y 指向飞行方向）
      const arrowCount = Math.min(64, sim.arrows.length);
      const arrowSlots = Math.max(lastArrowCount, arrowCount);
      lastArrowCount = arrowCount;
      for (let i = 0; i < arrowSlots; i++) {
        const handle = arrowEntities[i]!;
        const arr = sim.arrows[i];
        for (const [tail, tailHandle] of arrowTails[i]!.entries()) {
          const speed = arr ? Math.hypot(arr.vx, arr.vy) : 1;
          quat.fromEuler(arrowQ, Math.PI / 2, 0, arr ? Math.atan2(arr.vy, arr.vx) - Math.PI / 2 : 0, 'YXZ');
          world.set(tailHandle, Transform, {
            pos: arr ? [arr.x - arr.vx / speed * (tail + 1) * 0.4, 0.44, arr.y - arr.vy / speed * (tail + 1) * 0.4] : [0, -999, 0],
            scale: [0.7, 0.5, 0.7],
            quat: [arrowQ[0] ?? 0, arrowQ[1] ?? 0, arrowQ[2] ?? 0, arrowQ[3] ?? 1],
          }).unwrap();
        }
        if (arr && arr.life > 0) {
          quat.fromEuler(arrowQ, Math.PI / 2, 0, Math.atan2(arr.vy, arr.vx) - Math.PI / 2, 'YXZ');
          world.set(handle, Transform, {
            pos: [arr.x, 0.45, arr.y],
            scale: [1, 1, 1],
            quat: [arrowQ[0] ?? 0, arrowQ[1] ?? 0, arrowQ[2] ?? 0, arrowQ[3] ?? 1],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10. 炸弹与冲击波
      const bombCount = Math.min(32, sim.bombs.length);
      const bombSlots = Math.max(lastBombCount, bombCount);
      lastBombCount = bombCount;
      for (let i = 0; i < bombSlots; i++) {
        const bombH = bombEntities[i]!;
        const blastH = blastEntities[i]!;
        const b = sim.bombs[i];
        if (b) {
          if (!b.exploded) {
            world.set(bombH, Transform, { pos: [b.x, 0.24, b.y], scale: [1, 1, 1] }).unwrap();
            world.set(blastH, Transform, {
              pos: [b.x, 0.02, b.y],
              scale: [b.radius, b.radius, 0.5],
              quat: [...SHADOW_QUAT],
            }).unwrap();
          } else {
            world.set(bombH, Transform, { pos: [0, -999, 0] }).unwrap();
            const rawScale = b.radius * (1 + (0.5 - b.fxTimer) * 1.5);
            const scale = Math.min(VISUAL_MAX_BLAST_SCALE, rawScale);
            world.set(blastH, Transform, {
              pos: [b.x, 0.02, b.y],
              scale: [scale, scale, 1],
              quat: [...SHADOW_QUAT],
            }).unwrap();
          }
        } else {
          world.set(bombH, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(blastH, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10b. 宝物·星芒激光（贯穿晶石光柱）
      for (let i = 0; i < 24; i++) {
        const handle = laserEntities[i]!;
        const l = sim.lasers[i];
        if (l && l.life > 0) {
          quat.fromEuler(partQ, 0, -l.angle, 0, 'XYZ');
          const alpha = l.life / l.maxLife;
          world.set(handle, Transform, {
            pos: [l.x, 0.45, l.y],
            scale: [alpha, alpha, l.length / 6.0],
            quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10c. 宝物·风暴海螺（螺旋向外扩散的暴风）
      for (let i = 0; i < 16; i++) {
        const handle = cycloneEntities[i]!;
        const c = sim.cyclones[i];
        if (c && c.life > 0) {
          const spin = (sim.elapsed * 12.0 + c.id * 1.5) % (Math.PI * 2);
          quat.fromEuler(partQ, 0, spin, 0, 'XYZ');
          const sc = Math.max(0.4, c.radius / 1.5);
          world.set(handle, Transform, {
            pos: [c.x, 0.35, c.y],
            scale: [sc, sc, sc],
            quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10d. 宝物·灵风骨刃（高速自转黄金回旋镖）
      for (let i = 0; i < 16; i++) {
        const handle = boomerangEntities[i]!;
        const b = sim.boomerangs[i];
        if (b && b.life > 0) {
          const spin = (sim.elapsed * 20.0 + b.id * 2.0) % (Math.PI * 2);
          quat.fromEuler(partQ, 0, spin, 0, 'XYZ');
          world.set(handle, Transform, {
            pos: [b.x, 0.65, b.y],
            scale: [1, 1, 1],
            quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10e. 宝物·巨灵战锤（正面高空下砸与震波）
      for (let i = 0; i < 10; i++) {
        const handle = hammerEntities[i]!;
        const h = sim.hammers[i];
        if (h && h.life > 0) {
          const progress = 1 - (h.life / h.maxLife);
          const pitch = (1 - progress) * 1.1;
          quat.fromEuler(partQ, pitch, -h.facing, 0, 'YXZ');
          world.set(handle, Transform, {
            pos: [h.x, 0.3 + (1 - progress) * 0.7, h.y],
            scale: [1.2, 1.2, 1.2],
            quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10f. 宝物·遁影烟斗（尾随留存减速毒雾）
      for (let i = 0; i < 32; i++) {
        const handle = smokeEntities[i]!;
        const s = sim.smokes[i];
        if (s && s.life > 0) {
          const pulse = 1.0 + Math.sin(sim.elapsed * 4.0 + s.id) * 0.12;
          world.set(handle, Transform, {
            pos: [s.x, 0.22, s.y],
            scale: [s.radius * pulse, 0.8, s.radius * pulse],
            quat: [...SHADOW_QUAT],
          }).unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 11. 掉落金砖：绕 Y 轴匀速旋转 + 上下浮动
      const validLoots = sim.loots.filter((l) => l.value > 0);
      if (validLoots.length > 72) {
        validLoots.sort((p, q) => {
          const dp = Math.hypot(p.x - player.x, p.y - player.y);
          const dq = Math.hypot(q.x - player.x, q.y - player.y);
          return dp - dq;
        });
      }
      for (let i = 0; i < 72; i++) {
        const handle = lootEntities[i]!;
        const l = validLoots[i];
        if (!l) {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        const angle = (l.spin + sim.elapsed * 4.0) % (Math.PI * 2);
        quat.fromEuler(spinQ, 0, angle, 0, 'XYZ');
        const float = 0.1 + Math.sin(sim.elapsed * 3.4 + l.spin) * 0.03;
        const lootPulse = 1.0 + Math.sin(sim.elapsed * 5.0 + l.spin) * 0.08;
        world.set(handle, Transform, {
          pos: [l.x, float, l.y],
          scale: [lootPulse, lootPulse, lootPulse],
          quat: [spinQ[0] ?? 0, spinQ[1] ?? 0, spinQ[2] ?? 0, spinQ[3] ?? 1],
        }).unwrap();
      }

      // 11b. 双色温情绪光：只在真实背叛/终局状态间平滑过渡
      // 触发源（全部来自模拟层既有字段）：
      //   - 玩家主动背叛次数增加（sim.playerDisbands）
      //   - 新的断线事件（sim.lastBreakEvent.seq 增长）
      //   - 终局阶段（sim.finalPhase）
      // 只改光照颜色与强度；暂停、结算、重开都会按目标重新收敛，不留残留。
      const betraySeq = sim.lastBreakEvent?.seq ?? 0;
      const betrayalJustHappened = betraySeq > lastMoodBetraySeq;
      if (betrayalJustHappened) lastMoodBetraySeq = betraySeq;
      if (betrayalJustHappened || sim.playerDisbands > 0 || sim.finalPhase) moodActive = true;
      moodTarget = moodActive && !sim.gameOver ? 1 : 0;
      const blendStep = dt / MOOD_BLEND_SECONDS;
      const target = moodTarget * MOOD_MAX_BLEND;
      if (Math.abs(moodBlend - target) > 1e-4) {
        moodBlend = target > moodBlend
          ? Math.min(target, moodBlend + blendStep)
          : Math.max(target, moodBlend - blendStep);
        applyMood(moodBlend);
      }

      // 11c. 外圈浪花方块环：离散上下浮动 + 轻微缩放，纯装饰。
      for (let i = 0; i < foamEntities.length; i++) {
        const wave = Math.sin(sim.elapsed * 1.7 + i * 0.62);
        const bob = wave > 0.2 ? 0.06 : wave < -0.4 ? -0.04 : 0;
        const scale = 0.85 + (wave + 1) * 0.11;
        const a = (i / foamEntities.length) * Math.PI * 2;
        const foamRadius = ((GRID_SIZE - 1) / 2) * 1.09;
        world.set(foamEntities[i]!, Transform, {
          pos: [
            center + Math.cos(a) * foamRadius,
            -0.16 + bob,
            center + Math.sin(a) * foamRadius * 0.94,
          ],
          scale: [scale, scale, scale],
        }).unwrap();
      }

      // 12. 一次性真实事件反馈：破箱碎屑与背叛标记
      if (!initialized) {
        lastBreakSeq = sim.lastBreakEvent?.seq ?? 0;
        lastChestBreaks = sim.chestBreaks;
        lastBossRound = sim.bossRound;
        lastBossHp = sim.raidBossHp;
        lastHitFlash.fill(0);
        initialized = true;
      }
      if (sim.chestBreaks > lastChestBreaks) {
        // 真实破箱：木框 + 铁铆钉 + 金币三色碎块，抛物线迸裂。
        const grown = Math.min(6, sim.chestBreaks - lastChestBreaks);
        const event = sim.lastBreakEvent;
        if (event) {
          spawnDebris(event.x, event.y, 8 + grown * 2, 'debris-wood', 3.2, 3.0);
          spawnDebris(event.x, event.y, 4, 'debris-gold', 2.6, 2.4);
        }
        lastChestBreaks = sim.chestBreaks;
      }
      const breakSeq = sim.lastBreakEvent?.seq ?? 0;
      if (breakSeq > lastBreakSeq) {
        const event = sim.lastBreakEvent!;
        lastBreakSeq = breakSeq;
        // 背叛 / 断线：真实事件几何中点的猩红碎块标记，而非全场暮色。
        spawnDebris(event.x, event.y, 8, 'debris-danger', 2.8, 2.6);
      }
      if (sim.bossRound > lastBossRound) {
        lastBossRound = sim.bossRound;
      }

      // 真实受击反馈：Boss / 角色 hitFlash 上升沿各迸一次碎块（不新增玩法事件）。
      if (sim.raidBossHp < lastBossHp) {
        spawnDebris(sim.raidBossX, sim.raidBossY, 3, 'debris-shell', 2.2, 2.0);
      }
      lastBossHp = sim.raidBossHp;
      for (let i = 0; i < 10; i++) {
        const a = sim.actors[i]!;
        const wasHit = lastHitFlash[i] ?? 0;
        lastHitFlash[i] = a.hitFlash;
        if (a.alive && a.hitFlash > wasHit + 0.05) {
          spawnDebris(a.x, a.y, 3, 'debris-danger', 1.8, 1.6);
        }
      }

      // 碎屑装饰池推进（固定槽位，有界；与模拟层粒子互不影响）
      for (let i = 0; i < DEBRIS_SLOTS; i++) {
        const piece = debris[i];
        const handle = debrisEntities[i]!;
        if (!piece) {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        piece.life -= dt;
        if (piece.life <= 0) {
          debris[i] = null;
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        piece.x += piece.vx * dt;
        piece.y += piece.vy * dt;
        piece.z += piece.vz * dt;
        piece.vz += DEBRIS_GRAVITY * dt;
        if (piece.z <= 0.06) {
          piece.z = 0.06;
          if (piece.bounces < 1) {
            // 落地反弹一次（能量衰减），之后贴地滑行到消失
            piece.vz = Math.abs(piece.vz) * DEBRIS_BOUNCE;
            piece.bounces += 1;
            piece.vx *= 0.6;
            piece.vy *= 0.6;
          } else {
            piece.vz = 0;
            piece.vx *= 0.82;
            piece.vy *= 0.82;
          }
        }
        const shrink = Math.max(0.05, piece.life / piece.maxLife);
        quat.fromEuler(partQ, piece.spin, piece.spin * 1.7, 0, 'XYZ');
        world.set(handle, Transform, {
          pos: [piece.x, piece.z, piece.y],
          scale: [shrink, shrink, shrink],
          quat: [partQ[0] ?? 0, partQ[1] ?? 0, partQ[2] ?? 0, partQ[3] ?? 1],
        }).unwrap();
      }
    },

    dispose(): void {
      // 场景实体由 worldDespawnScene 统一析构
    },
  };
}
