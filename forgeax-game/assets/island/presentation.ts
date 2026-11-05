// 《荒岛合纵：破箱局》呈现控制层
// 驱动原生正交相机、薄层地面崩塌、3D 体素角色、道具遮挡与脚底阴影

import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { sceneEntity, Transform, worldResolveSceneEntity } from '@forgeax/engine/scene';
import type { SimulationState } from './simulation.ts';
import { GRID_SIZE } from './simulation.ts';

const SCENE_KEY = 'scene/island' as const;
const SPRITE_QUAT = [-0.4617486, 0, 0, 0.8870108] as const;
const SHADOW_QUAT = [-0.7071068, 0, 0, 0.7071068] as const;

export interface PresentationController {
  update(sim: SimulationState, dt: number): void;
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

  // 缓存 529 块地块实体与场景道具
  const tileEntities: Array<{ handle: EntityHandle; gx: number; gy: number }> = [];
  const propEntities: Map<string, EntityHandle> = new Map();

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const h = resolve(`tile-${gx}-${gy}`);
      tileEntities.push({ handle: h, gx, gy });
      try {
        const prop = resolve(`prop-${gx}-${gy}`);
        propEntities.set(`${gx},${gy}`, prop);
      } catch {
        // 无场景道具装饰
      }
    }
  }

  // 缓存 10 名体素角色
  const actorEntities: Array<{ shadow: EntityHandle; root: EntityHandle }> = [];
  for (let i = 0; i < 10; i++) {
    actorEntities.push({
      shadow: resolve(`actor-${i}-shadow`),
      root: resolve(`actor-${i}`),
    });
  }

  // 缓存 6 只体素怪物
  const monsterEntities: Array<{ shadow: EntityHandle; root: EntityHandle }> = [];
  for (let i = 0; i < 6; i++) {
    monsterEntities.push({
      shadow: resolve(`monster-${i}-shadow`),
      root: resolve(`monster-${i}`),
    });
  }

  // 缓存 5 个队伍共享宝箱
  const chestEntities: Array<{ shadow: EntityHandle; root: EntityHandle }> = [];
  for (let i = 0; i < 5; i++) {
    chestEntities.push({
      shadow: resolve(`chest-${i}-shadow`),
      root: resolve(`chest-${i}`),
    });
  }

  // 缓存 24 个掉落金宝物实体池
  const lootEntities: EntityHandle[] = [];
  for (let i = 0; i < 24; i++) {
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

  return {
    update(sim: SimulationState, dt: number): void {
      const player = sim.actors[0]!;

      // 1. 正交相机平滑跟随主角（主角存活跟随，死亡后视野锁定）
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
            world.set(prop, Transform, { pos: [item.gx, -999, item.gy] }).unwrap();
          }
        } else if (t.falling > 0) {
          const dropY = -0.11 - t.falling * 2.8;
          world.set(item.handle, Transform, { pos: [item.gx, dropY, item.gy] }).unwrap();
          if (prop) {
            world.set(prop, Transform, { pos: [item.gx, dropY + 0.5, item.gy] }).unwrap();
          }
        }
      }

      // 3. 体素角色位置、朝向与阴影更新
      for (let i = 0; i < 10; i++) {
        const a = sim.actors[i]!;
        const e = actorEntities[i]!;

        if (!a.alive) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        // 面向角度翻转或旋转
        const dirSign = a.vx < -0.05 ? -1 : 1;
        world
          .set(e.root, Transform, {
            pos: [a.x, 0, a.y],
            scale: [dirSign, 1, 1],
          })
          .unwrap();

        // 统一固定方向脚底阴影（右下偏置贴地）
        world
          .set(e.shadow, Transform, {
            pos: [a.x + 0.12, 0.005, a.y + 0.16],
            scale: [1, 1, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      // 4. 体素怪物浮动与阴影
      for (let i = 0; i < 6; i++) {
        const m = sim.monsters[i]!;
        const e = monsterEntities[i]!;

        if (!m.alive) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        const bob = Math.sin(sim.elapsed * 2.5 + m.wobble) * 0.05;
        world
          .set(e.root, Transform, {
            pos: [m.x, bob, m.y],
          })
          .unwrap();

        world
          .set(e.shadow, Transform, {
            pos: [m.x + 0.1, 0.005, m.y + 0.14],
            scale: [0.95, 0.95, 1],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          })
          .unwrap();
      }

      // 5. 队伍宝箱跟随与财富档位缩放
      const activeChests = sim.chests.filter((c) => c.hp > 0);
      for (let i = 0; i < 5; i++) {
        const e = chestEntities[i]!;
        const c = activeChests[i];

        if (!c) {
          world.set(e.root, Transform, { pos: [0, -999, 0] }).unwrap();
          world.set(e.shadow, Transform, { pos: [0, -999, 0] }).unwrap();
          continue;
        }

        // 宝箱尺寸随财富适度增加 (0.85 ~ 1.25)
        const size = 0.85 + Math.min(0.4, c.treasure * 0.035);
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

      // 6. 自由拾取宝物实体池（散落、弹跳与多轴自转）
      for (let i = 0; i < 24; i++) {
        const handle = lootEntities[i]!;
        const l = sim.loots[i];

        if (!l || l.value <= 0) {
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
