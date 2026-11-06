// 《荒岛分赃》呈现控制层
// 驱动原生正交相机、薄层地面崩塌与重置、3D 体素角色（含行走动画与受击红闪）、40 只怪潮、Boss 巨兽、三武器（飞刀/箭矢/炸弹）、道具遮挡、连线束（预警变红）与脚底阴影

import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { sceneEntity, Transform, worldResolveSceneEntity } from '@forgeax/engine/scene';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import type { SimulationState } from './simulation.ts';
import {
  activeCovers,
  GRID_SIZE,
  TEAM_WARNING_DISTANCE,
} from './simulation.ts';

const SCENE_KEY = 'scene/island' as const;

/** 大范围技能视觉裁剪上限（仅裁剪外观，真实命中范围不变；Plan B2） */
const VISUAL_MAX_BLAST_SCALE = 6.0;
const SPRITE_QUAT = [-0.4617486, 0, 0, 0.8870108] as const;
const SHADOW_QUAT = [-0.7071068, 0, 0, 0.7071068] as const;

export interface PresentationController {
  update(sim: SimulationState, dt: number): void;
  reset(sim: SimulationState): void;
  dispose(): void;
}

export function setupPresentation(
  world: World,
  sceneRoot: EntityHandle,
  initialSim: SimulationState,
): PresentationController {
  const resolve = (key: string): EntityHandle => {
    const res = worldResolveSceneEntity(world, sceneRoot, sceneEntity(SCENE_KEY, key));
    if (!res.ok) throw new Error(`Failed to resolve scene entity: ${key}`);
    return res.value;
  };

  const cameraEntity = resolve('camera');
  const center = (GRID_SIZE - 1) / 2;

  // 缓存 529 块地块实体与初始高度
  const tileEntities: Array<{ handle: EntityHandle; gx: number; gy: number; initialY: number }> = [];
  const propEntities: Map<string, { handle: EntityHandle; initialY: number }> = new Map();

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const h = resolve(`tile-${gx}-${gy}`);
      const t = initialSim.tiles[gy * GRID_SIZE + gx]!;
      const initY = t.isLand ? (t.height > 0 ? 0.05 : -0.11) : -999;
      tileEntities.push({ handle: h, gx, gy, initialY: initY });

      try {
        const prop = resolve(`prop-${gx}-${gy}`);
        const propH = t.decor === 'crystal' ? 0.62 : t.decor === 'bush' ? 0.35 : 0.30;
        propEntities.set(`${gx},${gy}`, { handle: prop, initialY: propH });
      } catch {
        // 无场景道具装饰
      }
    }
  }

  // 缓存 10 名体素角色
  const actorEntities: Array<{
    root: EntityHandle;
    body: EntityHandle;
    hit: EntityHandle;
    shadow: EntityHandle;
  }> = [];
  for (let i = 0; i < 10; i++) {
    actorEntities.push({
      root: resolve(`actor-${i}`),
      body: resolve(`actor-${i}-body`),
      hit: resolve(`actor-${i}-hit`),
      shadow: resolve(`actor-${i}-shadow`),
    });
  }

  // 缓存 40 只体素怪物实体
  const monsterEntities: Array<{ root: EntityHandle; shadow: EntityHandle }> = [];
  for (let i = 0; i < 40; i++) {
    monsterEntities.push({
      root: resolve(`monster-${i}`),
      shadow: resolve(`monster-${i}-shadow`),
    });
  }

  // 缓存 Boss 巨兽
  const bossEntity = {
    root: resolve('boss'),
    shadow: resolve('boss-shadow'),
  };

  // 缓存 5 个队伍共享宝箱
  const chestEntities: Array<{ root: EntityHandle; shadow: EntityHandle }> = [];
  for (let i = 0; i < 5; i++) {
    chestEntities.push({
      root: resolve(`chest-${i}`),
      shadow: resolve(`chest-${i}-shadow`),
    });
  }

  // 缓存 5 条队伍连线束（正常与预警红束）
  const teamBeamEntities: EntityHandle[] = [];
  const teamBeamWarnEntities: EntityHandle[] = [];
  for (let i = 0; i < 5; i++) {
    teamBeamEntities.push(resolve(`team-beam-${i}`));
    teamBeamWarnEntities.push(resolve(`team-beam-warn-${i}`));
  }

  // 缓存 30 把环绕飞刀（10 名角色 × 最多 3 把）
  const knifeEntities: EntityHandle[] = [];
  for (let i = 0; i < 30; i++) {
    knifeEntities.push(resolve(`player-knife-${i}`));
  }

  // 缓存 24 支穿透箭矢
  const arrowEntities: EntityHandle[] = [];
  for (let i = 0; i < 24; i++) {
    arrowEntities.push(resolve(`arrow-${i}`));
  }

  // 缓存 12 颗炸弹与冲击波
  const bombEntities: EntityHandle[] = [];
  const blastEntities: EntityHandle[] = [];
  for (let i = 0; i < 12; i++) {
    bombEntities.push(resolve(`bomb-${i}`));
    blastEntities.push(resolve(`blast-${i}`));
  }

  // 缓存 3 处中央岩石掩体与 Boss 圈形预警环
  const coverEntities: EntityHandle[] = [];
  for (let i = 0; i < 3; i++) {
    coverEntities.push(resolve(`cover-${i}`));
  }
  const raidTelegraphEntity = resolve('raid-telegraph');

  // 缓存 72 个掉落金宝物实体池
  const lootEntities: EntityHandle[] = [];
  for (let i = 0; i < 72; i++) {
    lootEntities.push(resolve(`loot-${i}`));
  }

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

  // 重置全部场景实体至初始形态
  const resetAll = (sim: SimulationState) => {
    for (const item of tileEntities) {
      world.set(item.handle, Transform, { pos: [item.gx, item.initialY, item.gy] }).unwrap();
      const prop = propEntities.get(`${item.gx},${item.gy}`);
      if (prop) {
        world.set(prop.handle, Transform, { pos: [item.gx, prop.initialY, item.gy] }).unwrap();
      }
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

    // 角色重位
    for (let i = 0; i < 10; i++) {
      const a = sim.actors[i]!;
      const e = actorEntities[i]!;
      world.set(e.root, Transform, { pos: [a.x, 0, a.y], scale: [1, 1, 1] }).unwrap();
      world.set(e.shadow, Transform, {
        pos: [a.x + 0.16, 0.005, a.y + 0.22],
        scale: [1, 1, 1],
        quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
      }).unwrap();
      world.set(e.hit, Transform, { pos: [0, -999, 0] }).unwrap();
    }

    // 怪物重置
    for (let i = 0; i < 40; i++) {
      const m = sim.monsters[i];
      const e = monsterEntities[i]!;
      if (m && m.alive) {
        world.set(e.root, Transform, { pos: [m.x, 0, m.y] }).unwrap();
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

    // Boss 隐藏
    world.set(bossEntity.root, Transform, { pos: [0, -999, 0] }).unwrap();
    world.set(bossEntity.shadow, Transform, { pos: [0, -999, 0] }).unwrap();

    // 隐藏宝箱、连线、武器、掉落
    for (const c of chestEntities) {
      world.set(c.root, Transform, { pos: [0, -999, 0] }).unwrap();
      world.set(c.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const b of teamBeamEntities) {
      world.set(b, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const bw of teamBeamWarnEntities) {
      world.set(bw, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const k of knifeEntities) {
      world.set(k, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const arr of arrowEntities) {
      world.set(arr, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const bm of bombEntities) {
      world.set(bm, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const bl of blastEntities) {
      world.set(bl, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    for (const l of lootEntities) {
      world.set(l, Transform, { pos: [0, -999, 0] }).unwrap();
    }
    world.set(raidTelegraphEntity, Transform, { pos: [0, -999, 0] }).unwrap();
    // 掩体位置按当前档位重建（reset 后档位为 0，全部存在）
    updateCovers(sim);
  };

  /** 掩体呈现：位置/大小与模拟层 activeCovers 完全一致 */
  const updateCovers = (sim: SimulationState) => {
    const covers = activeCovers(sim);
    for (let i = 0; i < 3; i++) {
      const handle = coverEntities[i]!;
      const c = covers[i];
      if (!c) {
        world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        continue;
      }
      const scale = c.radius / 0.4;
      world
        .set(handle, Transform, {
          pos: [c.x, 0.42, c.y],
          scale: [scale, scale * 1.35, scale],
        })
        .unwrap();
    }
  };

  let wasGameOver = false;

  return {
    reset(sim: SimulationState): void {
      resetAll(sim);
    },

    update(sim: SimulationState, dt: number): void {
      if (wasGameOver && !sim.gameOver) {
        resetAll(sim);
      }
      wasGameOver = sim.gameOver;

      const player = sim.actors[0]!;

      // 1. 正交相机平滑跟随主角
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

      // 2. 地块下沉崩塌呈现
      for (let i = 0; i < tileEntities.length; i++) {
        const item = tileEntities[i]!;
        const t = sim.tiles[i]!;
        const prop = propEntities.get(`${item.gx},${item.gy}`);

        if (t.gone) {
          world.set(item.handle, Transform, { pos: [item.gx, -999, item.gy] }).unwrap();
          if (prop) {
            world.set(prop.handle, Transform, { pos: [item.gx, -999, item.gy] }).unwrap();
          }
        } else if (t.falling > 0) {
          const dropY = -0.11 - t.falling * 2.8;
          world.set(item.handle, Transform, { pos: [item.gx, dropY, item.gy] }).unwrap();
          if (prop) {
            world.set(prop.handle, Transform, { pos: [item.gx, dropY + 0.5, item.gy] }).unwrap();
          }
        } else {
          world.set(item.handle, Transform, { pos: [item.gx, item.initialY, item.gy] }).unwrap();
          if (prop) {
            world.set(prop.handle, Transform, { pos: [item.gx, prop.initialY, item.gy] }).unwrap();
          }
        }
      }

      // 3. 10 名体素角色更新
      for (let i = 0; i < 10; i++) {
        const a = sim.actors[i]!;
        const e = actorEntities[i]!;

        if (!a.alive) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        const dirSign = a.vx < -0.05 ? -1 : 1;
        const isMoving = Math.hypot(a.vx, a.vy) > 0.05;
        const walkBob = isMoving ? Math.abs(Math.sin(sim.elapsed * 12.0 + a.id)) * 0.07 : 0;

        world
          .set(e.root, Transform, {
            pos: [a.x, walkBob, a.y],
            scale: [dirSign, 1, 1],
          })
          .unwrap();

        const hitY = a.hitFlash > 0 ? 0.52 : -999;
        world.set(e.hit, Transform, { pos: [0, hitY, 0] }).unwrap();

        world
          .set(e.shadow, Transform, {
            pos: [a.x + 0.16, 0.005, a.y + 0.22],
            scale: [1, 1, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      // 4. 40 只怪物池更新
      for (let i = 0; i < 40; i++) {
        const m = sim.monsters[i];
        const e = monsterEntities[i]!;

        if (!m || !m.alive || m.kind === 'boss') {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        const bob = Math.sin(sim.elapsed * 2.8 + m.wobble) * 0.05;
        const mScale = m.kind === 'tank' ? 1.25 : m.kind === 'dasher' ? 0.85 : 1.0;

        world
          .set(e.root, Transform, {
            pos: [m.x, bob, m.y],
            scale: [mScale, mScale, mScale],
          })
          .unwrap();

        world
          .set(e.shadow, Transform, {
            pos: [m.x + 0.14 * mScale, 0.005, m.y + 0.18 * mScale],
            scale: [0.95 * mScale, 0.95 * mScale, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      // 5. Boss 巨兽更新（仅团战阶段可见，旧 sim.boss 已废弃）
      if (sim.raidPhase === 'none') {
        world.set(bossEntity.root, Transform, { pos: [0, -999, 0] }).unwrap();
        world.set(bossEntity.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 5b. 中央掩体呈现（位置与模拟层完全一致）
      updateCovers(sim);

      // 5c. Boss 团战：巨兽与圈形预警呈现
      if (sim.raidPhase === 'fight' || sim.raidPhase === 'warning' || sim.raidPhase === 'result') {
        // Boss 体素主体 1.5×1.5×1.5 居中于自身原点：适度放大但不过度遮挡战场视野
        const bossBob = 0.85 + Math.sin(sim.elapsed * 2.4) * 0.08;
        const pulse = sim.raidPhase === 'fight' ? 0.95 : 0.85;
        world
          .set(bossEntity.root, Transform, {
            pos: [sim.raidBossX, bossBob, sim.raidBossY],
            scale: [pulse, pulse, pulse],
          })
          .unwrap();
        world
          .set(bossEntity.shadow, Transform, {
            pos: [sim.raidBossX + 0.14, 0.005, sim.raidBossY + 0.18],
            scale: [1.35, 1.35, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      if (sim.raidTelegraphTimer > 0) {
        const scale = Math.min(VISUAL_MAX_BLAST_SCALE, sim.raidTelegraphRadius / 1.2);
        world
          .set(raidTelegraphEntity, Transform, {
            pos: [sim.raidTelegraphX, 0.03, sim.raidTelegraphY],
            scale: [scale, scale, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      } else {
        world.set(raidTelegraphEntity, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 6. 队伍宝箱跟随与财富档位缩放
      const activeChests = sim.chests.filter((c) => c.hp > 0 || c.treasure > 0);
      for (let i = 0; i < 5; i++) {
        const e = chestEntities[i]!;
        const c = activeChests[i];

        if (!c || (c.hp <= 0 && c.treasure <= 0)) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        const size = 0.85 + Math.min(0.45, c.treasure * 0.04);
        world
          .set(e.root, Transform, {
            pos: [c.x, 0, c.y],
            scale: [size, size, size],
          })
          .unwrap();

        world
          .set(e.shadow, Transform, {
            pos: [c.x + 0.12, 0.005, c.y + 0.16],
            scale: [size * 1.1, size * 1.1, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      // 7. 队伍连线束呈现与超距预警变红
      const teamPairs: Array<{ a: typeof sim.actors[0]; b: typeof sim.actors[0]; dist: number }> = [];
      for (const a of sim.actors) {
        if (!a.alive || a.team < 0 || a.id > a.team) continue;
        const b = sim.actors[a.team];
        if (b && b.alive) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          teamPairs.push({ a, b, dist: d });
        }
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

        quat.fromLookAt(
          beamQ,
          [pair.a.x, 0.22, pair.a.y],
          [pair.b.x, 0.22, pair.b.y],
          [0, 1, 0],
        );

        const isWarning = pair.dist >= TEAM_WARNING_DISTANCE;
        const activeHandle = isWarning ? warnHandle : beamHandle;
        const inactiveHandle = isWarning ? beamHandle : warnHandle;

        world
          .set(activeHandle, Transform, {
            pos: [midX, 0.22, midZ],
            scale: [1, 1, length],
            quat: [beamQ[0] ?? 0, beamQ[1] ?? 0, beamQ[2] ?? 0, beamQ[3] ?? 1],
          })
          .unwrap();
        world.set(inactiveHandle, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 8. 环绕飞刀呈现（所有角色可见，R01）
      let knifeSlot = 0;
      for (let ai = 0; ai < 10; ai++) {
        const actor = sim.actors[ai]!;
        if (!actor.alive || actor.weaponKnife <= 0) continue;
        const count = actor.weaponKnife;
        const radius = 1.6 * (1 + actor.statAreaBonus) * (actor.relicAffix === 'knifeArea' ? 1.1 : 1);
        for (let k = 0; k < count && knifeSlot < knifeEntities.length; k++, knifeSlot++) {
          const handle = knifeEntities[knifeSlot]!;
          const ang = actor.knifeAngle + (k * Math.PI * 2) / count;
          const kx = actor.x + Math.cos(ang) * radius;
          const kz = actor.y + Math.sin(ang) * radius;
          quat.fromEuler(knifeQ, -Math.PI / 4, ang + Math.PI / 2, 0, 'YXZ');
          world
            .set(handle, Transform, {
              pos: [kx, 0.45, kz],
              scale: [1, 1, 1],
              quat: [knifeQ[0] ?? 0, knifeQ[1] ?? 0, knifeQ[2] ?? 0, knifeQ[3] ?? 1],
            })
            .unwrap();
        }
      }
      for (let k = knifeSlot; k < knifeEntities.length; k++) {
        world.set(knifeEntities[k]!, Transform, { pos: [0, -999, 0] }).unwrap();
      }

      // 9. 穿透箭矢呈现
      for (let i = 0; i < 24; i++) {
        const handle = arrowEntities[i]!;
        const arr = sim.arrows[i];
        if (arr && arr.life > 0) {
          const angle = Math.atan2(arr.vy, arr.vx);
          quat.fromEuler(arrowQ, 0, -angle + Math.PI / 2, 0, 'YXZ');
          world
            .set(handle, Transform, {
              pos: [arr.x, 0.45, arr.y],
              scale: [1, 1, 1],
              quat: [arrowQ[0] ?? 0, arrowQ[1] ?? 0, arrowQ[2] ?? 0, arrowQ[3] ?? 1],
            })
            .unwrap();
        } else {
          world.set(handle, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 10. 炸弹与冲击波呈现
      for (let i = 0; i < 12; i++) {
        const bombH = bombEntities[i]!;
        const blastH = blastEntities[i]!;
        const b = sim.bombs[i];

        if (b) {
          if (!b.exploded) {
            world.set(bombH, Transform, { pos: [b.x, 0.25, b.y], scale: [1, 1, 1] }).unwrap();
            world.set(blastH, Transform, { pos: [0, -999, 0] }).unwrap();
          } else {
            world.set(bombH, Transform, { pos: [0, -999, 0] }).unwrap();
            const rawScale = (b.radius / 1.2) * (1 + (0.5 - b.fxTimer) * 1.5);
            const scale = Math.min(VISUAL_MAX_BLAST_SCALE, rawScale);
            world
              .set(blastH, Transform, {
                pos: [b.x, 0.02, b.y],
                scale: [scale, scale, 1],
                quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
              })
              .unwrap();
          }
        } else {
          world.set(bombH, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(blastH, Transform, { pos: [0, -999, 0] }).unwrap();
        }
      }

      // 11. 自由拾取宝物实体池（支持大爆箱全量可见，按距离排序取前 72 个）
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
        quat.fromEuler(spinQ, angle * 0.5, angle, angle * 0.3, 'XYZ');

        world
          .set(handle, Transform, {
            pos: [l.x, l.z + 0.16, l.y],
            scale: [1, 1, 1],
            quat: [spinQ[0] ?? 0, spinQ[1] ?? 0, spinQ[2] ?? 0, spinQ[3] ?? 1],
          })
          .unwrap();
      }
    },

    dispose(): void {
      // 场景实体由 worldDespawnScene 统一析构
    },
  };
}
