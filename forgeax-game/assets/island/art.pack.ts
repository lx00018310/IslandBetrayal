// 《荒岛分赃》受管艺术资产包
// 统一低对比自然平整草地、3D 体素角色、道具、光照与材质

import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  Skylight,
} from '@forgeax/engine/render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine/render/authoring';
import { ChildOf } from '@forgeax/engine/scene';
import type { AssetGuid, MeshAsset, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { GRID_SIZE, hash, PLAYER_COLORS } from './simulation.ts';

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

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.islandArt,
  name: 'Island Art',
  build: () => {
    // 1. 基础几何网格
    const tileBox = createBoxGeometry(1.0, 0.22, 1.0);
    if (!tileBox.ok) return tileBox;
    const oceanBox = createBoxGeometry(60, 0.5, 60);
    if (!oceanBox.ok) return oceanBox;
    const shadowQuad = createPlaneGeometry(1.25, 0.75);
    if (!shadowQuad.ok) return shadowQuad;

    // 体素角色部件
    const charHead = createBoxGeometry(0.48, 0.44, 0.44);
    if (!charHead.ok) return charHead;
    const charHair = createBoxGeometry(0.52, 0.22, 0.48);
    if (!charHair.ok) return charHair;
    const charEyes = createBoxGeometry(0.36, 0.12, 0.14);
    if (!charEyes.ok) return charEyes;
    const charBody = createBoxGeometry(0.54, 0.50, 0.38);
    if (!charBody.ok) return charBody;
    const charBelt = createBoxGeometry(0.56, 0.10, 0.40);
    if (!charBelt.ok) return charBelt;
    const charArms = createBoxGeometry(0.68, 0.36, 0.26);
    if (!charArms.ok) return charArms;
    const charLegs = createBoxGeometry(0.44, 0.36, 0.30);
    if (!charLegs.ok) return charLegs;
    const charShoes = createBoxGeometry(0.46, 0.10, 0.34);
    if (!charShoes.ok) return charShoes;
    const playerMarker = createBoxGeometry(0.24, 0.24, 0.24);
    if (!playerMarker.ok) return playerMarker;

    // 怪物部件
    const monsterBody = createBoxGeometry(0.72, 0.70, 0.72);
    if (!monsterBody.ok) return monsterBody;
    const monsterEyes = createBoxGeometry(0.52, 0.16, 0.18);
    if (!monsterEyes.ok) return monsterEyes;
    const monsterHorns = createBoxGeometry(0.58, 0.22, 0.28);
    if (!monsterHorns.ok) return monsterHorns;

    // 宝箱部件
    const chestBody = createBoxGeometry(0.82, 0.54, 0.58);
    if (!chestBody.ok) return chestBody;
    const chestLid = createBoxGeometry(0.86, 0.20, 0.62);
    if (!chestLid.ok) return chestLid;
    const chestLock = createBoxGeometry(0.18, 0.24, 0.16);
    if (!chestLock.ok) return chestLock;

    // 战利品与场景道具部件
    const cubeMesh = createBoxGeometry(0.32, 0.32, 0.32);
    if (!cubeMesh.ok) return cubeMesh;
    const teamBeamMesh = createBoxGeometry(0.12, 0.12, 1.0);
    if (!teamBeamMesh.ok) return teamBeamMesh;
    const bushMesh = createBoxGeometry(0.85, 0.70, 0.85);
    if (!bushMesh.ok) return bushMesh;
    const rockMesh = createBoxGeometry(0.92, 0.60, 0.80);
    if (!rockMesh.ok) return rockMesh;
    const crystalMesh = createBoxGeometry(0.38, 1.25, 0.38);
    if (!crystalMesh.ok) return crystalMesh;

    // 2. 角色服装材质
    const charMaterials: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      const colorHex = PLAYER_COLORS[i] ?? '#ffffff';
      const rgb = hexToRgb(colorHex);
      charMaterials[`material/char-${i}`] = Materials.standard({
        baseColor: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1],
        roughness: 0.55,
        metallic: 0.15,
      });
    }

    // 3. 构建场景
    const SPRITE_QUAT = [-0.4617486, 0, 0, 0.8870108] as const;
    const SHADOW_QUAT = [-0.7071068, 0, 0, 0.7071068] as const;
    const center = (GRID_SIZE - 1) / 2;
    const entities: Record<string, SceneEntity> = {};

    // 主相机（原生正交近景跟随，俯视 55 度）
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

    // 阳光与天光
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
        Skylight: {
          color: [0.45, 0.60, 0.75],
          intensity: 1.15,
        },
      },
    };

    // 岛下深色虚空水面
    entities['ocean'] = {
      components: {
        Name: { value: 'Ocean Floor' },
        Transform: { pos: [center, -0.65, center] },
        MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/ocean')) },
        MeshRenderer: { materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/ocean'))] },
      },
    };

    // 529 块平整自然草地（绝大多数为平坦草地，只有少量泥藓与外圈沙滩）
    for (let gy = 0; gy < GRID_SIZE; gy++) {
      for (let gx = 0; gx < GRID_SIZE; gx++) {
        const dx = (gx - center) / (center * 1.06);
        const dy = (gy - center) / (center * 0.94);
        const radial = Math.sqrt(dx * dx + dy * dy);
        const wobble = (hash(gx, gy, 7) - 0.5) * 0.16;
        const r = radial + wobble;
        const isLand = r < 0.98;
        const n = hash(gx, gy, 19);
        let matKey = 'material/ocean';
        let posY = -999;
        let decor = 'none';

        if (isLand) {
          posY = -0.11;
          if (r > 0.85) {
            matKey = 'material/ground-sand';
          } else if (n < 0.18) {
            matKey = 'material/ground-moss';
          } else if (n < 0.42) {
            matKey = 'material/ground-light-grass';
          } else {
            matKey = 'material/ground-grass';
          }
          if (n > 0.86 && r < 0.78) {
            decor = n > 0.96 ? 'crystal' : n > 0.91 ? 'bush' : 'rock';
          }
        }

        entities[`tile-${gx}-${gy}`] = {
          components: {
            Name: { value: `Tile ${gx},${gy}` },
            Transform: { pos: [gx, posY, gy] },
            MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/tile')) },
            MeshRenderer: { materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, matKey))] },
          },
        };

        if (decor !== 'none') {
          const propMesh =
            decor === 'bush'
              ? 'mesh/bush'
              : decor === 'rock'
                ? 'mesh/rock'
                : 'mesh/crystal';
          const propMat =
            decor === 'bush'
              ? 'material/bush'
              : decor === 'rock'
                ? 'material/rock'
                : 'material/crystal';
          const propH = decor === 'crystal' ? 0.62 : decor === 'bush' ? 0.35 : 0.30;

          entities[`prop-${gx}-${gy}`] = {
            components: {
              Name: { value: `Prop ${decor} ${gx},${gy}` },
              Transform: { pos: [gx, propH, gy] },
              MeshFilter: {
                assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, propMesh)),
              },
              MeshRenderer: { materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, propMat))] },
            },
          };
        }
      }
    }

    // 10 名体素角色（阴影 + 根节点 + 躯干 + 双臂 + 腰带 + 头部 + 头发 + 眼睛 + 腿部 + 鞋子）
    for (let i = 0; i < 10; i++) {
      const a = 0.42 + (i / 10) * Math.PI * 2;
      const rad = 6.0 + (i % 3) * 1.2;
      const initX = center + Math.cos(a) * rad;
      const initZ = center + Math.sin(a) * rad;

      // 贴地投影
      entities[`actor-${i}-shadow`] = {
        components: {
          Name: { value: `Actor ${i} Shadow` },
          Transform: {
            pos: [initX + 0.16, 0.005, initZ + 0.22],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/shadow-quad')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/shadow'))],
          },
        },
      };

      // 角色根节点
      entities[`actor-${i}`] = {
        components: {
          Name: { value: `Actor ${i}` },
          Transform: { pos: [initX, 0, initZ] },
        },
      };

      // 躯干战袍
      entities[`actor-${i}-body`] = {
        components: {
          Name: { value: `Actor ${i} Body` },
          Transform: { pos: [0, 0.52, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-body')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, `material/char-${i}`))],
          },
        },
      };

      // 受击红闪图层（初始隐藏，hitFlash > 0 时激活）
      entities[`actor-${i}-hit`] = {
        components: {
          Name: { value: `Actor ${i} Hit Overlay` },
          Transform: { pos: [0, -999, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-body')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-hit'))],
          },
        },
      };

      // 腰带
      entities[`actor-${i}-belt`] = {
        components: {
          Name: { value: `Actor ${i} Belt` },
          Transform: { pos: [0, 0.38, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-belt')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-dark'))],
          },
        },
      };

      // 双臂
      entities[`actor-${i}-arms`] = {
        components: {
          Name: { value: `Actor ${i} Arms` },
          Transform: { pos: [0, 0.54, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-arms')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, `material/char-${i}`))],
          },
        },
      };

      // 头部面部
      entities[`actor-${i}-head`] = {
        components: {
          Name: { value: `Actor ${i} Head` },
          Transform: { pos: [0, 0.92, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-head')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/skin'))],
          },
        },
      };

      // 头发
      entities[`actor-${i}-hair`] = {
        components: {
          Name: { value: `Actor ${i} Hair` },
          Transform: { pos: [0, 1.06, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-hair')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/hair'))],
          },
        },
      };

      // 眼睛
      entities[`actor-${i}-eyes`] = {
        components: {
          Name: { value: `Actor ${i} Eyes` },
          Transform: { pos: [0, 0.94, 0.23] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-eyes')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-dark'))],
          },
        },
      };

      // 裤子腿部
      entities[`actor-${i}-legs`] = {
        components: {
          Name: { value: `Actor ${i} Legs` },
          Transform: { pos: [0, 0.20, 0] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-legs')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-pants'))],
          },
        },
      };

      // 鞋子
      entities[`actor-${i}-shoes`] = {
        components: {
          Name: { value: `Actor ${i} Shoes` },
          Transform: { pos: [0, 0.05, 0.02] },
          ChildOf: { parent: `actor-${i}` },
          MeshFilter: { assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/char-shoes')) },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-shoes'))],
          },
        },
      };

      // 主角头顶醒目菱形标记 (仅 Actor 0 拥有)
      if (i === 0) {
        entities[`actor-0-marker`] = {
          components: {
            Name: { value: 'Player Marker' },
            Transform: {
              pos: [0, 1.48, 0],
              quat: [0.3826834, 0, 0, 0.9238795],
            },
            ChildOf: { parent: `actor-0` },
            MeshFilter: {
              assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/player-marker')),
            },
            MeshRenderer: {
              materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/loot'))],
            },
          },
        };
      }
    }

    // 6 只体素怪物（阴影 + 根节点 + 身体 + 尖角 + 发光红眼）
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const mx = center + Math.cos(a) * (5 + (i % 2));
      const mz = center + Math.sin(a) * (5 + (i % 2));

      entities[`monster-${i}-shadow`] = {
        components: {
          Name: { value: `Monster ${i} Shadow` },
          Transform: {
            pos: [mx + 0.14, 0.005, mz + 0.18],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/shadow-quad')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/shadow'))],
          },
        },
      };

      entities[`monster-${i}`] = {
        components: {
          Name: { value: `Monster ${i}` },
          Transform: { pos: [mx, 0, mz] },
        },
      };

      entities[`monster-${i}-body`] = {
        components: {
          Name: { value: `Monster ${i} Body` },
          Transform: { pos: [0, 0.38, 0] },
          ChildOf: { parent: `monster-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/monster-body')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/monster'))],
          },
        },
      };

      entities[`monster-${i}-horns`] = {
        components: {
          Name: { value: `Monster ${i} Horns` },
          Transform: { pos: [0, 0.74, 0] },
          ChildOf: { parent: `monster-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/monster-horns')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/char-dark'))],
          },
        },
      };

      entities[`monster-${i}-eyes`] = {
        components: {
          Name: { value: `Monster ${i} Eyes` },
          Transform: { pos: [0, 0.48, 0.37] },
          ChildOf: { parent: `monster-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/monster-eyes')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/monster-eyes'))],
          },
        },
      };
    }

    // 5 个队伍共享宝箱（阴影 + 根节点 + 箱身 + 盖子 + 金锁）
    for (let i = 0; i < 5; i++) {
      entities[`chest-${i}-shadow`] = {
        components: {
          Name: { value: `Chest ${i} Shadow` },
          Transform: {
            pos: [0, -999, 0],
            quat: [SHADOW_QUAT[0], SHADOW_QUAT[1], SHADOW_QUAT[2], SHADOW_QUAT[3]],
          },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/shadow-quad')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/shadow'))],
          },
        },
      };

      entities[`chest-${i}`] = {
        components: {
          Name: { value: `Chest ${i}` },
          Transform: { pos: [0, -999, 0] },
        },
      };

      entities[`chest-${i}-body`] = {
        components: {
          Name: { value: `Chest ${i} Body` },
          Transform: { pos: [0, 0.27, 0] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/chest-body')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/chest'))],
          },
        },
      };

      entities[`chest-${i}-lid`] = {
        components: {
          Name: { value: `Chest ${i} Lid` },
          Transform: { pos: [0, 0.60, 0] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/chest-lid')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/chest-gold'))],
          },
        },
      };

      entities[`chest-${i}-lock`] = {
        components: {
          Name: { value: `Chest ${i} Lock` },
          Transform: { pos: [0, 0.44, 0.30] },
          ChildOf: { parent: `chest-${i}` },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/chest-lock')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/chest-gold'))],
          },
        },
      };
    }

    // 5 条队伍连线束（正常绿束 + 预警红束，初始隐藏）
    for (let i = 0; i < 5; i++) {
      entities[`team-beam-${i}`] = {
        components: {
          Name: { value: `Team Beam ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/team-beam')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/team-beam'))],
          },
        },
      };

      entities[`team-beam-warn-${i}`] = {
        components: {
          Name: { value: `Team Beam Warning ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/team-beam')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/danger-border'))],
          },
        },
      };
    }

    // 72 个公共散落金宝物实体池（支持大爆箱全量可见，初始隐藏）
    for (let i = 0; i < 72; i++) {
      entities[`loot-${i}`] = {
        components: {
          Name: { value: `Loot ${i}` },
          Transform: { pos: [0, -999, 0] },
          MeshFilter: {
            assetHandle: guidText(assetGuid(PACKAGE_IDS.islandArt, 'mesh/cube')),
          },
          MeshRenderer: {
            materials: [guidText(assetGuid(PACKAGE_IDS.islandArt, 'material/loot'))],
          },
        },
      };
    }

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities,
    };

    return ok({
      // 网格
      'mesh/tile': withMaterial(
        tileBox.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/ground-grass'),
        'island:tile',
      ),
      'mesh/ocean': withMaterial(
        oceanBox.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/ocean'),
        'island:ocean',
      ),
      'mesh/shadow-quad': shadowQuad.value,
      'mesh/char-head': charHead.value,
      'mesh/char-hair': charHair.value,
      'mesh/char-eyes': charEyes.value,
      'mesh/char-body': charBody.value,
      'mesh/char-belt': charBelt.value,
      'mesh/char-arms': charArms.value,
      'mesh/char-legs': charLegs.value,
      'mesh/char-shoes': charShoes.value,
      'mesh/player-marker': playerMarker.value,
      'mesh/monster-body': monsterBody.value,
      'mesh/monster-eyes': monsterEyes.value,
      'mesh/monster-horns': monsterHorns.value,
      'mesh/chest-body': chestBody.value,
      'mesh/chest-lid': chestLid.value,
      'mesh/chest-lock': chestLock.value,
      'mesh/team-beam': withMaterial(
        teamBeamMesh.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/team-beam'),
        'island:team-beam',
      ),
      'mesh/cube': withMaterial(
        cubeMesh.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/loot'),
        'island:cube',
      ),
      'mesh/bush': withMaterial(
        bushMesh.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/bush'),
        'island:bush',
      ),
      'mesh/rock': withMaterial(
        rockMesh.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/rock'),
        'island:rock',
      ),
      'mesh/crystal': withMaterial(
        crystalMesh.value,
        assetGuid(PACKAGE_IDS.islandArt, 'material/crystal'),
        'island:crystal',
      ),

      // 地形材质 (主调为柔和绿地，点缀淡绿与沙滩)
      'material/ground-grass': Materials.standard({
        baseColor: [0.36, 0.46, 0.25, 1],
        roughness: 0.90,
        metallic: 0.03,
      }),
      'material/ground-light-grass': Materials.standard({
        baseColor: [0.42, 0.52, 0.30, 1],
        roughness: 0.90,
        metallic: 0.03,
      }),
      'material/ground-moss': Materials.standard({
        baseColor: [0.31, 0.40, 0.22, 1],
        roughness: 0.92,
        metallic: 0.02,
      }),
      'material/ground-sand': Materials.standard({
        baseColor: [0.75, 0.66, 0.44, 1],
        roughness: 0.85,
        metallic: 0.02,
      }),
      'material/ocean': Materials.standard({
        baseColor: [0.06, 0.11, 0.17, 1],
        roughness: 0.25,
        metallic: 0.4,
      }),

      // 实体材质
      'material/skin': Materials.standard({
        baseColor: [0.96, 0.82, 0.68, 1],
        roughness: 0.65,
      }),
      'material/hair': Materials.standard({
        baseColor: [0.18, 0.13, 0.10, 1],
        roughness: 0.8,
      }),
      'material/char-dark': Materials.standard({
        baseColor: [0.14, 0.16, 0.18, 1],
        roughness: 0.8,
      }),
      'material/char-pants': Materials.standard({
        baseColor: [0.22, 0.26, 0.32, 1],
        roughness: 0.75,
      }),
      'material/char-shoes': Materials.standard({
        baseColor: [0.88, 0.88, 0.88, 1],
        roughness: 0.5,
      }),
      'material/char-hit': Materials.standard({
        baseColor: [1.0, 0.3, 0.3, 1],
        emissive: [0.8, 0.1, 0.1],
        emissiveIntensity: 2.5,
      }),
      'material/monster': Materials.standard({
        baseColor: [0.46, 0.20, 0.62, 1],
        roughness: 0.5,
        metallic: 0.15,
      }),
      'material/monster-eyes': Materials.standard({
        baseColor: [1.0, 0.15, 0.15, 1],
        emissive: [1.0, 0.1, 0.1],
        emissiveIntensity: 3.0,
      }),
      'material/chest': Materials.standard({
        baseColor: [0.65, 0.40, 0.18, 1],
        roughness: 0.65,
        metallic: 0.2,
      }),
      'material/chest-gold': Materials.standard({
        baseColor: [0.96, 0.76, 0.22, 1],
        roughness: 0.3,
        metallic: 0.75,
      }),
      'material/loot': Materials.standard({
        baseColor: [1.0, 0.85, 0.25, 1],
        roughness: 0.2,
        metallic: 0.8,
        emissive: [0.45, 0.35, 0.1],
        emissiveIntensity: 1.5,
      }),
      'material/bush': Materials.standard({
        baseColor: [0.20, 0.42, 0.18, 1],
        roughness: 0.88,
        metallic: 0.02,
      }),
      'material/rock': Materials.standard({
        baseColor: [0.48, 0.52, 0.56, 1],
        roughness: 0.8,
        metallic: 0.1,
      }),
      'material/crystal': Materials.standard({
        baseColor: [0.35, 0.78, 0.85, 1],
        roughness: 0.25,
        metallic: 0.3,
        emissive: [0.2, 0.5, 0.6],
        emissiveIntensity: 2.0,
      }),
      'material/shadow': Materials.unlit([0.08, 0.14, 0.12, 0.52], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      }),
      'material/team-beam': Materials.unlit([0.42, 0.94, 0.65, 0.85], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      }),
      'material/danger-border': Materials.unlit([0.88, 0.28, 0.22, 0.75], {
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      }),
      'scene/island': sceneAsset,
      ...charMaterials,
    });
  },
});
