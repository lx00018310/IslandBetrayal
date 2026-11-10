// 《荒岛分赃》呈现控制层
// 驱动原生正交相机、阶梯地块下沉与重置、Tibo 小狗的蹦跳动作与受击红闪、
// 40 只怪潮、寄居宝箱蟹 Boss、三武器（飞刀/箭矢/炸弹）、真实事件反馈、连线束与脚底阴影。
//
// 约束：只读取 simulation.ts 的既有状态；不改变坐标、碰撞、移速、命中、奖励或存档规则。
// 可行走顶面恒为 y = 0，所有动作只修改视觉部件。

import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { Camera } from '@forgeax/engine/render';
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

/** 破箱碎屑装饰池容量（有界；容量不足只少粒子，不影响真实掉落与判定） */
const DEBRIS_POOL = 24;
const DEBRIS_LIFE = 0.55;

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

interface DebrisPiece {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  spin: number;
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
  let initialized = false;
  /** 固定槽位碎屑池：null 表示该槽位空闲。 */
  const debris: Array<DebrisPiece | null> = new Array(DEBRIS_SLOTS).fill(null);

  /** 一次性局部反馈：真实破箱 / 背叛事件才产生碎屑（容量不足只少粒子）。 */
  const spawnDebris = (x: number, y: number, count: number): void => {
    let spawned = 0;
    for (let slot = 0; slot < DEBRIS_SLOTS && spawned < count; slot++) {
      if (debris[slot]) continue;
      debris[slot] = {
        x,
        y,
        z: 0.24 + Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 2.4,
        vy: (Math.random() - 0.5) * 2.4,
        vz: 1.2 + Math.random() * 1.8,
        life: DEBRIS_LIFE,
        spin: Math.random() * Math.PI * 2,
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

    lastArrowCount = 0;
    lastBombCount = 0;
    coverStage = -1;
    debris.fill(null);
    // 一次性事件基线重置到当前 sim，重开与刷新不重播旧事件
    lastBreakSeq = sim.lastBreakEvent?.seq ?? 0;
    lastChestBreaks = sim.chestBreaks;
    lastBossRound = sim.bossRound;
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

      // 1. 正交相机平滑跟随主角（保持当前朝向，不引入偏航）
      if (player.alive) {
        const follow = 1 - Math.exp(-8.0 * dt);
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
        } else if (t.falling > 0) {
          const dropY = -t.falling * 2.8;
          world.set(item.handle, Transform, { pos: [item.gx, dropY, item.gy] }).unwrap();
          if (prop) world.set(prop.handle, Transform, { pos: [item.gx, dropY + 0.04, item.gy] }).unwrap();
        } else if (item.hidden) {
          item.hidden = false;
          world.set(item.handle, Transform, { pos: [item.gx, 0, item.gy] }).unwrap();
          if (prop) world.set(prop.handle, Transform, { pos: [item.gx, 0, item.gy] }).unwrap();
        }
      }

      const nextShrink = SHRINK_THRESHOLD_SECONDS[sim.shrinkStage + 1];
      const warning = nextShrink !== undefined && nextShrink - sim.elapsed <= 5;
      const boundaryRadius = currentSafeRadius(sim) * 11;
      world.set(shrinkBoundary, Transform, {
        pos: warning || (sim.shrinkStage > 0 && sim.shrinkTransition < 5) ? [11, 0.03, 11] : [0, -999, 0],
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

        if (!a.alive) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        const dirSign = a.vx < -0.05 ? -1 : 1;
        const speed = Math.hypot(a.vx, a.vy);
        const isMoving = speed > 0.05;
        // 时间相位（不用帧数），每个角色相位固定偏移
        const phase = sim.elapsed * 11.0 + a.id * 1.7;
        const hop = isMoving ? Math.abs(Math.sin(phase)) : 0;
        const airborne = isMoving ? Math.sin(phase) : 0;

        // 起跳拉长 / 落地挤压（只影响视觉，不改模拟坐标与碰撞）
        const stretchY = isMoving ? 1 + hop * 0.18 : 1;
        const squeezeXZ = isMoving ? 1 - hop * 0.12 : 1;
        const landSquash = isMoving && hop < 0.12 ? 1 - (0.12 - hop) * 1.2 : 1;

        world.set(e.root, Transform, {
          pos: [a.x, isMoving ? hop * 0.14 : 0, a.y],
          scale: [dirSign, 1, 1],
        }).unwrap();
        world.set(e.body, Transform, {
          scale: [squeezeXZ * landSquash, stretchY * landSquash, squeezeXZ * landSquash],
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
        if (!m || !m.alive || m.kind === 'boss') {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }
        const bob = Math.abs(Math.sin(sim.elapsed * 2.8 + m.wobble)) * 0.08;
        const mScale = m.kind === 'tank' ? 1.25 : m.kind === 'dasher' ? 0.85 : 1.0;
        world.set(e.root, Transform, { pos: [m.x, bob, m.y], scale: [mScale, mScale, mScale] }).unwrap();
        world.set(e.shadow, Transform, {
          pos: [m.x, 0.008, m.y],
          scale: [mScale, 1, mScale],
          quat: [0, 0, 0, 1],
        }).unwrap();
      }

      // 5. Boss：仅团战阶段可见，两次出场复用同一模型
      if (sim.raidPhase === 'none' || sim.raidPhase === 'result') {
        world.set(bossEntity.root, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(bossEntity.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
      } else {
        const bob = Math.abs(Math.sin(sim.elapsed * 2.2)) * 0.1;
        // 体素外壳本身已 2.2 × 1.3 世界单位，1.15 倍即占屏接近原 Boss
        const scale = 1.15 + Math.sin(sim.elapsed * 2.2) * 0.02;
        world.set(bossEntity.root, Transform, {
          pos: [sim.raidBossX, bob, sim.raidBossY],
          scale: [scale, scale, scale],
        }).unwrap();
        world.set(bossEntity.shadow, Transform, {
          pos: [sim.raidBossX + 0.14, 0.006, sim.raidBossY + 0.18],
          scale: [2.6, 1, 2.2],
          quat: [0, 0, 0, 1],
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
        const pulseAlpha = 0.85 + Math.sin(sim.elapsed * 18) * 0.15;
        world.set(raidTelegraphFillEntity, Transform, {
          pos: [sim.raidTelegraphX, 0.024, sim.raidTelegraphY],
          scale: [scale * pulseAlpha, 1, scale * pulseAlpha],
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
        world.set(handle, Transform, {
          pos: [l.x, float, l.y],
          scale: [1, 1, 1],
          quat: [spinQ[0] ?? 0, spinQ[1] ?? 0, spinQ[2] ?? 0, spinQ[3] ?? 1],
        }).unwrap();
      }

      // 12. 一次性真实事件反馈：破箱碎屑与背叛标记
      if (!initialized) {
        lastBreakSeq = sim.lastBreakEvent?.seq ?? 0;
        lastChestBreaks = sim.chestBreaks;
        lastBossRound = sim.bossRound;
        initialized = true;
      }
      if (sim.chestBreaks > lastChestBreaks) {
        const grown = Math.min(6, sim.chestBreaks - lastChestBreaks);
        const event = sim.lastBreakEvent;
        if (event) spawnDebris(event.x, event.y, 4 + grown * 2);
        lastChestBreaks = sim.chestBreaks;
      }
      const breakSeq = sim.lastBreakEvent?.seq ?? 0;
      if (breakSeq > lastBreakSeq) {
        const event = sim.lastBreakEvent!;
        lastBreakSeq = breakSeq;
        // 背叛 / 断线标记：真实事件几何中点的方块标记，而非全场暮色
        spawnDebris(event.x, event.y, 5);
      }
      if (sim.bossRound > lastBossRound) {
        lastBossRound = sim.bossRound;
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
        piece.vz -= 9.5 * dt;
        if (piece.z < 0.02) {
          piece.z = 0.02;
          piece.vz = 0;
        }
        const shrink = Math.max(0.05, piece.life / DEBRIS_LIFE);
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
