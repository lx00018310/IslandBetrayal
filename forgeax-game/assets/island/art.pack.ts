// 《荒岛分赃》受管艺术资产包
// 热带潮玩微缩体素：阶梯式海岛、Tibo 小狗、寄居宝箱蟹 Boss、青苔岩块掩体、
// 共享宝箱、三武器（飞刀/箭矢/炸弹）、怪潮、掉落金砖、光照与材质。
// 体素几何来自 voxel-art-data.ts（数据）+ voxel-builder.ts（隐藏面剔除与合并）。

import {
  createBoxGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createTorusGeometry,
} from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import {
  Camera,
  DirectionalLight,
  Materials,
  orthographic,
  Skylight,
} from '@forgeax/engine/render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine/render/authoring';
import { ChildOf } from '@forgeax/engine/scene';
import type { AssetError, AssetGuid, MeshAsset, Result, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok, srgbChannelToLinear } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { GRID_SIZE, hash } from './simulation.ts';
import {
  AI_IDENTITY_COLORS,
  arrowBlocks,
  bushProp,
  coverRock,
  crystalProp,
  foamCluster,
  GROUND_BAND_COLORS,
  groundTile,
  lootBar,
  mimicClaw,
  mimicEyes,
  mimicShell,
  monsterBody,
  monsterEyes,
  rimChunk,
  rockProp,
  softShadowPatch,
  squareFrame,
  teamChestBody,
  teamChestCrack,
  teamChestLid,
  teamChestLock,
  tiboBody,
  tiboCollar,
  tiboEar,
  tiboHead,
  tiboLegs,
  tiboSack,
  tiboTail,
  voxelTelegraphGrid,
  weaponArrow,
  weaponBomb,
  weaponKnife,
} from './voxel-art-data.ts';

function withMaterial(mesh: MeshAsset, material: AssetGuid, sourceKey: string): MeshAsset {
  return {
    ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey, defaultMaterial: material }],
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function linearColor(hex: string, alpha = 1): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [
    srgbChannelToLinear(r / 255),
    srgbChannelToLinear(g / 255),
    srgbChannelToLinear(b / 255),
    alpha,
  ];
}

/** 体素部件枢轴（世界单位），与 voxel-art-data.ts 中的体素枢轴一一对应。 */
const TIBO_PIVOT = {
  head: [0, 0.7, 0] as const,
  earLeft: [-0.4, 1.2, 0] as const,
  earRight: [0.4, 1.2, 0] as const,
  legs: [0, 0.3, 0] as const,
  tail: [0, 0.6, -0.2] as const,
  torsoTop: [0, 0.7, 0] as const,
};

const BOSS_PIVOT = {
  clawLeft: [-0.7, 0.6, 0.3] as const,
  clawRight: [0.7, 0.6, 0.3] as const,
};

/** 需要构建的体素网格（源键 → 构建函数），任一失败即整体失败。 */
type MeshFactory = () => Result<MeshAsset, AssetError>;

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.islandArt,
  name: 'Island Art',
  build: () => {
    // 1. 辅助几何：全部为方块或方块拼片（方案要求全场景可见几何 100% 由立方体构成）。
    //    阴影用薄方块、脚底标识用方形框条、预警用方环，不使用球/柱/环。
    // 接地阴影：两层扁平方块（外淡内深），顶点色做中心深/边缘浅的过渡，
    // 避免单层 alpha 方板在水平视角下变成硬边深色方框。
    const shadowQuad = softShadowPatch(1.25, 0.75);
    if (!shadowQuad.ok) return shadowQuad;
    const monsterShadow = softShadowPatch(1.04, 1.04);
    if (!monsterShadow.ok) return monsterShadow;
    const bossShadow = softShadowPatch(2.8, 2.2);
    if (!bossShadow.ok) return bossShadow;
    /** 方形脚底框：4 根细方条拼成回字形，替代旧圆环。 */
    const footRing = squareFrame(0.58, 0.07, 0.02);
    if (!footRing.ok) return footRing;
    /** 方向指示：3 层递缩小方块构成的三角箭头。 */
    const directionArrow = arrowBlocks();
    if (!directionArrow.ok) return directionArrow;
    const coverAo = createBoxGeometry(2, 0.025, 2);
    if (!coverAo.ok) return coverAo;
    /** 技能/炸弹预警方环（单位半径 1，按半径缩放）。 */
    const blastRing = squareFrame(1, 0.06, 0.02);
    if (!blastRing.ok) return blastRing;
    // 缩圈边界半径可达 ~10 世界单位，若用同粗细的框会被同步放大成一条粗带；
    // 单独用极细方条，保证放大后仍是细线。
    const boundaryRing = squareFrame(1, 0.006, 0.02);
    if (!boundaryRing.ok) return boundaryRing;
    /** 预警填充：贴合圆形边界的体素方格阵列（单位半径 1）。 */
    const telegraphFill = voxelTelegraphGrid();
    if (!telegraphFill.ok) return telegraphFill;
    const playerMarker = createBoxGeometry(0.24, 0.24, 0.24);
    if (!playerMarker.ok) return playerMarker;
    const teamBeamMesh = createBoxGeometry(0.12, 0.12, 1.0);
    if (!teamBeamMesh.ok) return teamBeamMesh;
    const oceanBox = createBoxGeometry(60, 0.5, 60);
    if (!oceanBox.ok) return oceanBox;
    const debrisCube = createBoxGeometry(0.18, 0.18, 0.18);
    if (!debrisCube.ok) return debrisCube;
    const xpCrystalMesh = createBoxGeometry(0.24, 0.32, 0.24);
    if (!xpCrystalMesh.ok) return xpCrystalMesh;

    // 2. 体素网格（每个部件保持独立，动画绕真实关节枢轴）
    const factories: Record<string, MeshFactory> = {
      'mesh/char-body': tiboBody,
      'mesh/char-head': tiboHead,
      'mesh/char-ear-left': () => tiboEar(-1),
      'mesh/char-ear-right': () => tiboEar(1),
      'mesh/char-legs-front': () => tiboLegs(true),
      'mesh/char-legs-back': () => tiboLegs(false),
      'mesh/char-tail': tiboTail,
      'mesh/char-sack': tiboSack,
      'mesh/char-collar': tiboCollar,
      'mesh/boss-shell': mimicShell,
      'mesh/boss-claw': () => mimicClaw(-1),
      'mesh/boss-claw-right': () => mimicClaw(1),
      'mesh/boss-eyes': mimicEyes,
      'mesh/cover-rock': coverRock,
      'mesh/chest-body': teamChestBody,
      'mesh/chest-lid': teamChestLid,
      'mesh/chest-lock': teamChestLock,
      'mesh/chest-crack': teamChestCrack,
      'mesh/loot-bar': lootBar,
      'mesh/weapon-knife': weaponKnife,
      'mesh/weapon-arrow': weaponArrow,
      'mesh/weapon-bomb': weaponBomb,
      'mesh/monster-body': monsterBody,
      'mesh/monster-eyes': monsterEyes,
      'mesh/bush': bushProp,
      'mesh/rock': rockProp,
      'mesh/crystal': crystalProp,
    };
    // 阶梯地块按档位烘焙表层色差（6 档 × 棋盘格 2 奇偶 = 12 个网格），
    // 同一网格被同奇偶地块共享，Draw Call 不随 529 块线性增长。
    for (let band = 0; band < GROUND_BAND_COLORS.length; band++) {
      for (let parity = 0; parity < 2; parity++) {
        factories[`mesh/tile-${band}-${parity}`] = () => groundTile(band, parity);
      }
    }
    // 浪花方块簇与可独立下坠的边缘方块
    factories['mesh/foam'] = foamCluster;
    factories['mesh/rim-chunk'] = rimChunk;

    const meshes: Record<string, MeshAsset> = {};
    for (const [key, factory] of Object.entries(factories)) {
      const built = factory();
      if (!built.ok) return built;
      meshes[key] = built.value;
    }

    // 3. 角色服装材质（躯干身份色；体素顶点色只提供明暗层次）
    const charMaterials: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      const colorHex = i === 0 ? '#10B981' : [AI_IDENTITY_COLORS.friendly, AI_IDENTITY_COLORS.greedy, AI_IDENTITY_COLORS.raider][i % 3]!;
      const rgb = hexToRgb(colorHex);
      charMaterials[`material/char-${i}`] = Materials.standard({
        baseColor: [srgbChannelToLinear(rgb[0] / 255), srgbChannelToLinear(rgb[1] / 255), srgbChannelToLinear(rgb[2] / 255), 1],
        roughness: 0.55,
        metallic: 0.15,
      });
    }

    // 4. 场景装配
    const SPRITE_QUAT = [-0.4617486, 0, 0, 0.8870108] as const;
    const SHADOW_QUAT = [-0.7071068, 0, 0, 0.7071068] as const;
    const center = (GRID_SIZE - 1) / 2;
    const entities: Record<string, SceneEntity> = {};
    const meshRef = (key: string) => guidText(assetGuid(PACKAGE_IDS.islandArt, key));
    const matRef = (key: string) => guidText(assetGuid(PACKAGE_IDS.islandArt, key));

    // 主相机（保持原生正交投影与当前朝向）
    entities['camera'] = {
      components: {
        Name: { value: 'Main Camera' },
        Transform: {
          pos: [center, 14, center + 9.8],
          quat: [SPRITE_QUAT[0], SPRITE_QUAT[1], SPRITE_QUAT[2], SPRITE_QUAT[3]],
        },
        Camera: {
          ...orthographic({ left: -8, right: 8, bottom: -4.5, top: 4.5, near: 0.1, far: 60 }),
          clearColor: [0.06, 0.10, 0.16, 1],
        },
      },
    };

    // 阳光与天光：顶面亮、侧面有区分
    entities['sun'] = {
      components: {
        Name: { value: 'Directional Sunlight' },
        Transform: { pos: [center, 22, center + 16] },
        DirectionalLight: {
          color: [1.0, 0.97, 0.90],
          intensity: 2.6,
          direction: [-0.35, -0.82, -0.45],
        },
      },
    };
    entities['skylight'] = {
      components: {
        Name: { value: 'Skylight' },
        Skylight: { color: [0.45, 0.60, 0.75], intensity: 1.15 },
      },
    };

    // 岛下水面（顶面 -0.2，正好接住阶梯地块的岩层底面）
    entities['ocean'] = {
      components: {
        Name: { value: 'Ocean' },
        Transform: { pos: [center, -0.45, center] },
        MeshFilter: { assetHandle: meshRef('mesh/ocean') },
        MeshRenderer: { materials: [matRef('material/ocean')] },
      },
    };

    // 外圈浪花方块环：24 簇纯白体素，由呈现层做离散上下浮动与缩放。
    // 只落在水面（陆地外侧），不占用任何可行走格，也不参与碰撞。
    const foamRadius = center * 1.09;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const fx = center + Math.cos(a) * foamRadius;
      const fz = center + Math.sin(a) * foamRadius * 0.94;
      entities[`foam-${i}`] = {
        components: {
          Name: { value: `Foam ${i}` },
          Transform: { pos: [fx, -0.16, fz], scale: [1, 1, 1] },
          MeshFilter: { assetHandle: meshRef('mesh/foam') },
          MeshRenderer: { materials: [matRef('material/foam')] },
        },
      };
    }

    // 529 块阶梯地块：顶面严格 y = 0，随模拟层 falling / gone 一起下沉与隐藏
    for (let gy = 0; gy < GRID_SIZE; gy++) {
      for (let gx = 0; gx < GRID_SIZE; gx++) {
        const dx = (gx - center) / (center * 1.06);
        const dy = (gy - center) / (center * 0.94);
        const radial = Math.sqrt(dx * dx + dy * dy);
        const wobble = (hash(gx, gy, 7) - 0.5) * 0.16;
        const r = radial + wobble;
        const isLand = r < 0.98;
        const n = hash(gx, gy, 19);
        let band = 0;
        let posY = -999;
        let decor = 'none';

        if (isLand) {
          posY = 0;
          band = r < 0.7 ? 0 : Math.min(5, 1 + Math.floor((r - 0.7) / 0.05));
          if (n > 0.985 && r < 0.78) decor = 'bush';
        }

        entities[`tile-${gx}-${gy}`] = {
          components: {
            Name: { value: `Tile ${gx},${gy}` },
            Transform: { pos: [gx, posY, gy] },
            MeshFilter: { assetHandle: meshRef(`mesh/tile-${band}-${(gx + gy) % 2}`) },
            MeshRenderer: { materials: [matRef('material/ground-voxel')] },
          },
        };

        if (decor !== 'none') {
          const propKey = decor === 'bush' ? 'mesh/bush' : decor === 'rock' ? 'mesh/rock' : 'mesh/crystal';
          entities[`prop-${gx}-${gy}`] = {
            components: {
              Name: { value: `Prop ${decor} ${gx},${gy}` },
              Transform: { pos: [gx, 0, gy] },
              MeshFilter: { assetHandle: meshRef(propKey) },
              MeshRenderer: { materials: [matRef(`material/${decor}`)] },
            },
          };
        }
      }
    }

    // 10 名体素角色（Tibo 结构，躯干使用身份材质）
    for (let i = 0; i < 10; i++) {
      const a = 0.42 + (i / 10) * Math.PI * 2;
      const rad = 6.0 + (i % 3) * 1.2;
      const initX = center + Math.cos(a) * rad;
      const initZ = center + Math.sin(a) * rad;

      entities[`actor-${i}-shadow`] = {
        components: {
          Name: { value: `Actor ${i} Shadow` },
          Transform: {
            pos: [initX + 0.16, 0.005, initZ + 0.22],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          },
          MeshFilter: { assetHandle: meshRef('mesh/shadow-quad') },
          MeshRenderer: { materials: [matRef('material/shadow')] },
        },
      };

      for (const state of ['player', 'ally', 'rival', 'grudge']) {
        entities[`actor-${i}-ring-${state}`] = {
          components: {
            Name: { value: `Actor ${i} Ring ${state}` },
            Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
            MeshFilter: { assetHandle: meshRef('mesh/foot-ring') },
            MeshRenderer: { materials: [matRef(`material/ring-${state}`)] },
          },
        };
      }
      if (i === 0) {
        entities['player-direction'] = {
          components: {
            Name: { value: 'Player Direction' },
            Transform: { pos: [0, -999, 0] },
            MeshFilter: { assetHandle: meshRef('mesh/direction-arrow') },
            MeshRenderer: { materials: [matRef('material/ring-white')] },
          },
        };
        entities['player-inner-ring'] = {
          components: {
            Name: { value: 'Player Inner Ring' },
            Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
            MeshFilter: { assetHandle: meshRef('mesh/foot-ring') },
            MeshRenderer: { materials: [matRef('material/ring-white')] },
          },
        };
      }

      entities[`actor-${i}`] = {
        components: {
          Name: { value: `Actor ${i}` },
          Transform: { pos: [initX, 0, initZ] },
        },
      };

      const part = (
        key: string,
        mesh: string,
        material: string,
        pos: readonly [number, number, number] = [0, 0, 0],
      ) => {
        entities[`actor-${i}-${key}`] = {
          components: {
            Name: { value: `Actor ${i} ${key}` },
            Transform: { pos: [pos[0], pos[1], pos[2]] },
            ChildOf: { parent: `actor-${i}` },
            MeshFilter: { assetHandle: meshRef(mesh) },
            MeshRenderer: { materials: [matRef(material)] },
          },
        };
      };

      part('body', 'mesh/char-body', `material/char-${i}`);
      // 受击红闪覆盖层：与躯干同形，平时隐藏
      entities[`actor-${i}-hit`] = {
        components: {
          Name: { value: `Actor ${i} Hit Overlay` },
          Transform: { pos: [0, -999, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/char-body') },
          MeshRenderer: { materials: [matRef('material/char-hit')] },
        },
      };
      part('head', 'mesh/char-head', 'material/char-fur', TIBO_PIVOT.head);
      part('ear-left', 'mesh/char-ear-left', 'material/char-fur', TIBO_PIVOT.earLeft);
      part('ear-right', 'mesh/char-ear-right', 'material/char-fur', TIBO_PIVOT.earRight);
      part('legs-front', 'mesh/char-legs-front', 'material/char-fur', TIBO_PIVOT.legs);
      part('legs-back', 'mesh/char-legs-back', 'material/char-fur', TIBO_PIVOT.legs);
      part('tail', 'mesh/char-tail', 'material/char-fur', TIBO_PIVOT.tail);
      part('sack', 'mesh/char-sack', 'material/char-sack', TIBO_PIVOT.torsoTop);
      part('collar', 'mesh/char-collar', 'material/chest-gold', TIBO_PIVOT.torsoTop);

      if (i === 0) {
        entities['actor-0-marker'] = {
          components: {
            Name: { value: 'Player Marker' },
            Transform: { pos: [0, 1.55, 0], quat: [0.3826834, 0, 0, 0.9238795] },
            ChildOf: { parent: 'actor-0' },
            MeshFilter: { assetHandle: meshRef('mesh/player-marker') },
            MeshRenderer: { materials: [matRef('material/loot')] },
          },
        };
      }
    }

    // 40 只体素怪潮实体池（支持怪潮扩容）
    for (let i = 0; i < 40; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3;
      const mx = center + Math.cos(a) * (5 + (i % 3) * 1.5);
      const mz = center + Math.sin(a) * (5 + (i % 3) * 1.5);
      const isInitial = i < 12;

      entities[`monster-${i}-shadow`] = {
        components: {
          Name: { value: `Monster ${i} Shadow` },
          Transform: { pos: isInitial ? [mx + 0.14, 0.005, mz + 0.18] : [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/monster-shadow') },
          MeshRenderer: { materials: [matRef('material/shadow')] },
        },
      };
      entities[`monster-${i}`] = {
        components: {
          Name: { value: `Monster ${i}` },
          Transform: { pos: isInitial ? [mx, 0, mz] : [0, -999, 0] },
        },
      };
      entities[`monster-${i}-body`] = {
        components: {
          Name: { value: `Monster ${i} Body` },
          Transform: { pos: [0, 0, 0] },
          ChildOf: { parent: `monster-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/monster-body') },
          MeshRenderer: { materials: [matRef('material/monster')] },
        },
      };
      entities[`monster-${i}-eyes`] = {
        components: {
          Name: { value: `Monster ${i} Eyes` },
          Transform: { pos: [0, 0, 0] },
          ChildOf: { parent: `monster-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/monster-eyes') },
          MeshRenderer: { materials: [matRef('material/monster-eyes')] },
        },
      };
    }

    // 寄居宝箱蟹 Boss（两次出场复用同一模型）
    entities['boss-shadow'] = {
      components: {
        Name: { value: 'Boss Shadow' },
        Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
        MeshFilter: { assetHandle: meshRef('mesh/boss-shadow') },
        MeshRenderer: { materials: [matRef('material/shadow')] },
      },
    };
    entities['boss'] = {
      components: { Name: { value: 'Mimic Crab Boss' }, Transform: { pos: [0, -999, 0] } },
    };
    entities['boss-body'] = {
      components: {
        Name: { value: 'Boss Shell' },
        Transform: { pos: [0, 0, 0] },
        ChildOf: { parent: 'boss' },
        MeshFilter: { assetHandle: meshRef('mesh/boss-shell') },
        MeshRenderer: { materials: [matRef('material/boss-shell')] },
      },
    };
    entities['boss-eyes'] = {
      components: {
        Name: { value: 'Boss Eyes' },
        Transform: { pos: [0, 0, 0] },
        ChildOf: { parent: 'boss' },
        MeshFilter: { assetHandle: meshRef('mesh/boss-eyes') },
        MeshRenderer: { materials: [matRef('material/boss-eyes')] },
      },
    };
    entities['boss-claw-left'] = {
      components: {
        Name: { value: 'Boss Left Claw' },
        Transform: { pos: [BOSS_PIVOT.clawLeft[0], BOSS_PIVOT.clawLeft[1], BOSS_PIVOT.clawLeft[2]] },
        ChildOf: { parent: 'boss' },
        MeshFilter: { assetHandle: meshRef('mesh/boss-claw') },
        MeshRenderer: { materials: [matRef('material/boss-claw')] },
      },
    };
    entities['boss-claw-right'] = {
      components: {
        Name: { value: 'Boss Right Claw' },
        Transform: { pos: [BOSS_PIVOT.clawRight[0], BOSS_PIVOT.clawRight[1], BOSS_PIVOT.clawRight[2]] },
        ChildOf: { parent: 'boss' },
        MeshFilter: { assetHandle: meshRef('mesh/boss-claw-right') },
        MeshRenderer: { materials: [matRef('material/boss-claw')] },
      },
    };

    // 5 个队伍共享宝箱
    for (let i = 0; i < 5; i++) {
      entities[`chest-${i}-shadow`] = {
        components: {
          Name: { value: `Chest ${i} Shadow` },
          Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
          MeshFilter: { assetHandle: meshRef('mesh/shadow-quad') },
          MeshRenderer: { materials: [matRef('material/shadow')] },
        },
      };
      entities[`chest-${i}`] = {
        components: { Name: { value: `Chest ${i}` }, Transform: { pos: [0, -999, 0] } },
      };
      entities[`chest-${i}-body`] = {
        components: {
          Name: { value: `Chest ${i} Body` },
          Transform: { pos: [0, 0, 0] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/chest-body') },
          MeshRenderer: { materials: [matRef('material/chest-gold')] },
        },
      };
      entities[`chest-${i}-lid`] = {
        components: {
          Name: { value: `Chest ${i} Lid` },
          Transform: { pos: [0, 0.5, 0] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/chest-lid') },
          MeshRenderer: { materials: [matRef('material/chest-gold')] },
        },
      };
      entities[`chest-${i}-lock`] = {
        components: {
          Name: { value: `Chest ${i} Lock` },
          Transform: { pos: [0, 0.3, 0.3] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/chest-lock') },
          MeshRenderer: { materials: [matRef('material/chest-gold')] },
        },
      };
      entities[`chest-${i}-crack`] = {
        components: {
          Name: { value: `Chest ${i} Crack` },
          Transform: { pos: [0, 0, 0] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: { assetHandle: meshRef('mesh/chest-crack') },
          MeshRenderer: { materials: [matRef('material/char-dark')] },
        },
      };
    }

    // 5 条队伍连线束（正常与超距预警）
    for (let i = 0; i < 5; i++) {
      for (const [key, material] of [['team-beam', 'material/team-beam'], ['team-beam-warn', 'material/danger-border']] as const) {
        entities[`${key}-${i}`] = {
          components: {
            Name: { value: `${key} ${i}` },
            Transform: { pos: [0, -999, 0] },
            MeshFilter: { assetHandle: meshRef('mesh/team-beam') },
            MeshRenderer: { materials: [matRef(material)] },
          },
        };
      }
    }

    // 40 把环绕飞刀
    for (let i = 0; i < 40; i++) {
      entities[`player-knife-${i}`] = {
        components: {
          Name: { value: `Knife ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/weapon-knife') },
          MeshRenderer: { materials: [matRef('material/weapon-knife')] },
        },
      };
    }

    // 64 支穿透箭矢与拖尾
    for (let i = 0; i < 64; i++) {
      entities[`arrow-${i}`] = {
        components: {
          Name: { value: `Arrow ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/weapon-arrow') },
          MeshRenderer: { materials: [matRef('material/weapon-arrow')] },
        },
      };
      for (let tail = 0; tail < 2; tail++) {
        entities[`arrow-${i}-tail-${tail}`] = {
          components: {
            Name: { value: `Arrow ${i} Tail ${tail}` },
            Transform: { pos: [0, -999, 0] },
            MeshFilter: { assetHandle: meshRef('mesh/weapon-arrow') },
            MeshRenderer: { materials: [matRef('material/ammo-trail')] },
          },
        };
      }
    }

    // 32 颗炸弹与冲击波
    for (let i = 0; i < 32; i++) {
      entities[`bomb-${i}`] = {
        components: {
          Name: { value: `Bomb ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/weapon-bomb') },
          MeshRenderer: { materials: [matRef('material/weapon-bomb')] },
        },
      };
      entities[`blast-${i}`] = {
        components: {
          Name: { value: `Blast Wave ${i}` },
          Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
          MeshFilter: { assetHandle: meshRef('mesh/blast-ring') },
          MeshRenderer: { materials: [matRef('material/danger-border')] },
        },
      };
    }

    // 3 处青苔岩块掩体（位置与半径严格读 activeCovers）
    for (let i = 0; i < 3; i++) {
      entities[`cover-${i}`] = {
        components: {
          Name: { value: `Cover Rock ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/cover-rock') },
          MeshRenderer: { materials: [matRef('material/rock')] },
        },
      };
      entities[`cover-${i}-ao`] = {
        components: {
          Name: { value: `Cover ${i} AO` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/cover-ao') },
          MeshRenderer: { materials: [matRef('material/ao')] },
        },
      };
      entities[`cover-${i}-top`] = {
        components: {
          Name: { value: `Cover ${i} Top` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/cover-ao') },
          MeshRenderer: { materials: [matRef('material/rock-top')] },
        },
      };
    }

    // 缩圈边界与 Boss 圆形预警（准确圆边 + 辅助填充，不改命中形状）
    entities['shrink-boundary'] = {
      components: {
        Name: { value: 'Shrink Warning Boundary' },
        Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
        MeshFilter: { assetHandle: meshRef('mesh/boundary-ring') },
        MeshRenderer: { materials: [matRef('material/danger-border')] },
      },
    };
    entities['raid-telegraph'] = {
      components: {
        Name: { value: 'Raid Telegraph Ring' },
        Transform: { pos: [0, -999, 0], quat: [...SHADOW_QUAT] },
        MeshFilter: { assetHandle: meshRef('mesh/blast-ring') },
        MeshRenderer: { materials: [matRef('material/danger-border')] },
      },
    };
    entities['raid-telegraph-fill'] = {
      components: {
        Name: { value: 'Raid Telegraph Fill' },
        Transform: { pos: [0, -999, 0] },
        MeshFilter: { assetHandle: meshRef('mesh/telegraph-fill') },
        MeshRenderer: { materials: [matRef('material/danger-fill')] },
      },
    };

    // 72 个掉落金砖实体池
    for (let i = 0; i < 72; i++) {
      entities[`loot-${i}`] = {
        components: {
          Name: { value: `Loot ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/loot-bar') },
          MeshRenderer: { materials: [matRef('material/loot')] },
        },
      };
    }

    // 96 块体素碎块（表现层有界装饰池，不进入模拟层）。
    // 材质按槽位轮转分配到 5 种碎块色，避免逐帧换材质。
    const debrisMaterials = [
      'material/debris-gold',
      'material/debris-wood',
      'material/debris-danger',
      'material/debris-shell',
      'material/debris-dust',
    ] as const;
    for (let i = 0; i < 96; i++) {
      entities[`debris-${i}`] = {
        components: {
          Name: { value: `Debris ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: { assetHandle: meshRef('mesh/debris') },
          MeshRenderer: { materials: [matRef(debrisMaterials[i % debrisMaterials.length]!)] },
        },
      };
    }

    const sceneAsset: SceneAsset = { kind: 'scene', entities };

    // 5. 输出网格与材质
    const meshOutput: Record<string, MeshAsset> = {
      'mesh/ocean': withMaterial(oceanBox.value, assetGuid(PACKAGE_IDS.islandArt, 'material/ocean'), 'island:ocean'),
      'mesh/shadow-quad': shadowQuad.value,
      'mesh/monster-shadow': monsterShadow.value,
      'mesh/boss-shadow': bossShadow.value,
      'mesh/foot-ring': footRing.value,
      'mesh/direction-arrow': directionArrow.value,
      'mesh/cover-ao': coverAo.value,
      'mesh/blast-ring': blastRing.value,
      'mesh/boundary-ring': boundaryRing.value,
      'mesh/telegraph-fill': telegraphFill.value,
      'mesh/player-marker': playerMarker.value,
      'mesh/team-beam': withMaterial(teamBeamMesh.value, assetGuid(PACKAGE_IDS.islandArt, 'material/team-beam'), 'island:team-beam'),
      'mesh/debris': debrisCube.value,
      'mesh/xp-crystal': withMaterial(xpCrystalMesh.value, assetGuid(PACKAGE_IDS.islandArt, 'material/xp-crystal'), 'island:xp-crystal'),
    };
    for (const [key, mesh] of Object.entries(meshes)) {
      meshOutput[key] = withMaterial(mesh, assetGuid(PACKAGE_IDS.islandArt, 'material/ground-voxel'), `island:${key}`);
    }

    return ok({
      ...meshOutput,

      // 地形与通用体素材质（顶点色承载体素颜色，这里保持中性白）
      'material/ground-voxel': Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 0.92,
        metallic: 0.02,
      }),
      'material/ground-grass': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.92, metallic: 0.02 }),
      // 海面是一个 60×60 的大平面，永远正对主光。若用受光材质，
      // 双色温暮色会把整片背景染成粉色墙，压掉预警与身份辨识。
      // 因此海面用 unlit 固定深海军蓝：既保持原始暗背景，也完全不受情绪光影响。
      'material/ocean': Materials.unlit(linearColor('#16374A')),

      // 角色材质
      'material/char-fur': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.72, metallic: 0.02 }),
      'material/char-sack': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.9, metallic: 0.02 }),
      'material/char-dark': Materials.standard({ baseColor: linearColor('#2A2320'), roughness: 0.8 }),
      'material/char-hit': Materials.standard({
        baseColor: linearColor('#FF6A5A'),
        emissive: [0.8, 0.1, 0.1],
        emissiveIntensity: 2.2,
      }),

      // 怪物与 Boss
      'material/monster': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.5, metallic: 0.12 }),
      'material/monster-eyes': Materials.standard({
        baseColor: linearColor('#FF5A1E'),
        emissive: [1.0, 0.18, 0.02],
        emissiveIntensity: 1.6,
      }),
      'material/boss-shell': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.6, metallic: 0.12 }),
      'material/boss-claw': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.42, metallic: 0.2 }),
      'material/boss-eyes': Materials.standard({
        baseColor: linearColor('#FF3A2E'),
        emissive: [1.0, 0.06, 0.04],
        emissiveIntensity: 2.2,
      }),

      // 宝箱
      'material/chest-gold': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.34, metallic: 0.6 }),

      // 体素碎块（顶点色承载体素色，材质保持中性并做差异化粗糙度/自发光）
      'material/debris-gold': Materials.standard({
        baseColor: linearColor('#FFD34D'),
        roughness: 0.28,
        metallic: 0.7,
        emissive: [0.30, 0.22, 0.04],
        emissiveIntensity: 1.1,
      }),
      'material/debris-wood': Materials.standard({ baseColor: linearColor('#8A6134'), roughness: 0.85, metallic: 0.05 }),
      'material/debris-danger': Materials.standard({
        baseColor: linearColor('#FF3B5C'),
        roughness: 0.5,
        metallic: 0.1,
        emissive: [0.55, 0.05, 0.10],
        emissiveIntensity: 1.3,
      }),
      'material/debris-shell': Materials.standard({ baseColor: linearColor('#A8794A'), roughness: 0.7, metallic: 0.1 }),
      'material/debris-dust': Materials.standard({ baseColor: linearColor('#F2F6FA'), roughness: 0.95, metallic: 0.0 }),
      'material/foam': Materials.standard({ baseColor: linearColor('#FFFFFF'), roughness: 0.6, metallic: 0.0 }),
      'material/chest': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.5, metallic: 0.35 }),

      // 武器
      'material/weapon-knife': Materials.standard({
        baseColor: linearColor('#EAF4FF'),
        roughness: 0.16,
        metallic: 0.85,
        emissive: [0.22, 0.55, 0.75],
        emissiveIntensity: 1.1,
      }),
      'material/weapon-arrow': Materials.standard({
        baseColor: linearColor('#FFF0A8'),
        roughness: 0.32,
        metallic: 0.6,
        emissive: [0.55, 0.4, 0.06],
        emissiveIntensity: 1.2,
      }),
      'material/weapon-bomb': Materials.standard({
        baseColor: linearColor('#2A3038'),
        roughness: 0.68,
        metallic: 0.25,
        emissive: [0.7, 0.16, 0.05],
        emissiveIntensity: 0.9,
      }),

      // 道具
      'material/loot': Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 0.24,
        metallic: 0.7,
        emissive: [0.32, 0.24, 0.05],
        emissiveIntensity: 1.2,
      }),
      'material/xp-crystal': Materials.standard({
        baseColor: linearColor('#61D9AE'),
        roughness: 0.25,
        metallic: 0.6,
        emissive: [0.2, 0.6, 0.45],
        emissiveIntensity: 1.6,
      }),
      'material/bush': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.88, metallic: 0.02 }),
      'material/rock': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.85, metallic: 0.06 }),
      'material/crystal': Materials.standard({
        baseColor: [1, 1, 1, 1],
        roughness: 0.24,
        metallic: 0.3,
        emissive: [0.1, 0.28, 0.34],
        emissiveIntensity: 1.4,
      }),

      // 无光照辅助层
      'material/ammo-trail': Materials.unlit([0.35, 0.3, 0.08, 0.35], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, depthWriteEnabled: false },
      }),
      'material/ao': Materials.unlit([0.071, 0.086, 0.102, 1]),
      'material/rock-top': Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.9 }),
      'material/ring-player': Materials.unlit([0.063, 0.725, 0.506, 1]),
      'material/ring-ally': Materials.unlit([0.055, 0.647, 0.914, 1]),
      'material/ring-rival': Materials.unlit([0.984, 0.4, 0.18, 1]),
      'material/ring-grudge': Materials.unlit([0.85, 0.275, 0.937, 1]),
      'material/ring-white': Materials.unlit([1, 1, 1, 1]),
      // 接地阴影：顶点色提供灰度层次，材质只给统一低透明度
      'material/shadow': Materials.unlit([0.16, 0.20, 0.17, 0.42], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, depthWriteEnabled: false },
      }),
      'material/team-beam': Materials.unlit([0.055, 0.647, 0.914, 0.75], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      }),
      'material/danger-border': Materials.unlit([0.88, 0.28, 0.22, 0.75], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      }),
      'material/danger-fill': Materials.unlit([0.88, 0.24, 0.18, 0.22], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, depthWriteEnabled: false },
      }),
      'scene/island': sceneAsset,
      ...charMaterials,
    });
  },
});
