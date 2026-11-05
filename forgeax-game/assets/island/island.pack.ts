// 《荒岛合纵：破箱局》原生游戏 Plugin 与生命周期管理
// 挂载原生场景、推进核心玩法模拟、更新呈现、注册只读投影

import { Time, Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { definePack } from '@forgeax/engine/pack/source';
import type { Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { setupPresentation } from './presentation.ts';
import {
  aliveActors,
  createInitialSimulation,
  landRadius,
  MATCH_SECONDS,
  partnerOf,
  type PlayerInputIntent,
  stepSimulation,
} from './simulation.ts';

export const ISLAND_CONTROL_CHANNEL = 'island/controls';

export interface IslandTouchMessage {
  channel: typeof ISLAND_CONTROL_CHANNEL;
  kind: 'move' | 'dash' | 'ally' | 'kick' | 'speed' | 'restart' | 'reset';
  x?: number;
  y?: number;
  held?: boolean;
}

export const islandPlugin: Plugin = {
  name: 'island-game',
  inject: ['world', 'assets', 'gameHost'],
  async apply(ctx) {
    const world = ctx.world;
    const assets = ctx.assets;
    const host = ctx.gameHost;
    if (!assets) throw new Error('island-game requires assets service');

    const sceneGuid = assetGuid(PACKAGE_IDS.islandArt, 'scene/island');
    const loaded = await assets.load(sceneGuid, 'scene');
    if (!loaded.ok) throw loaded.error;

    await ctx.effect(async function* () {
      const sceneHandle = loaded.value;
      yield () => {
        assets.release(sceneHandle).unwrap();
      };

      const root = assets.instantiate(sceneHandle, world).unwrap();
      yield () => worldDespawnScene(world, root).unwrap();
      yield ctx.provide('gameScene', { root });

      // 初始化荒岛模拟与视觉呈现
      const sim = createInitialSimulation();
      const presentation = setupPresentation(world, root, sim);
      yield () => presentation.dispose();

      // 触控输入状态缓存
      let touchMoveX = 0;
      let touchMoveY = 0;
      let touchDash = false;
      let touchInteract = false;
      let touchKickHeld = false;
      let touchSpeedToggle = false;
      let touchRestart = false;

      // 监听来自前端 UI 的触控和按钮消息
      const port = host?.presentationPort ?? host?.port;
      if (port) {
        const onMessage = (event: MessageEvent) => {
          const data = event.data as IslandTouchMessage | undefined;
          if (!data || data.channel !== ISLAND_CONTROL_CHANNEL) return;
          switch (data.kind) {
            case 'move':
              touchMoveX = data.x ?? 0;
              touchMoveY = data.y ?? 0;
              break;
            case 'dash':
              touchDash = true;
              break;
            case 'ally':
              touchInteract = true;
              break;
            case 'kick':
              touchKickHeld = data.held ?? false;
              break;
            case 'speed':
              touchSpeedToggle = true;
              break;
            case 'restart':
              touchRestart = true;
              break;
            case 'reset':
              touchMoveX = 0;
              touchMoveY = 0;
              touchKickHeld = false;
              break;
          }
        };
        port.addEventListener('message', onMessage);
        yield () => port.removeEventListener('message', onMessage);
      }

      // 注册验收只读投影：island.match
      const unregisterIslandMatch = host?.gameProjection?.registerRead({
        id: 'island.match',
        title: 'Island Match State',
        description: 'Read-only state for 《荒岛合纵：破箱局》 gameplay assertions',
        read: () => {
          const p = sim.actors[0]!;
          const partner = partnerOf(sim, p);
          return {
            elapsed: Number(sim.elapsed.toFixed(2)),
            progress: Number((sim.elapsed / MATCH_SECONDS).toFixed(3)),
            phase: sim.finalPhase ? 'final' : sim.shrink > 0 ? 'shrink' : 'normal',
            shrink: Number(sim.shrink.toFixed(3)),
            landRadius: Number(landRadius(sim.shrink).toFixed(3)),
            gameOver: sim.gameOver,
            winnerId: sim.winner ? sim.winner.id : -1,
            winnerName: sim.winner ? sim.winner.name : null,
            aliveCount: aliveActors(sim).length,
            player: {
              id: p.id,
              name: p.name,
              alive: p.alive,
              x: Number(p.x.toFixed(2)),
              y: Number(p.y.toFixed(2)),
              position: [Number(p.x.toFixed(2)), 0, Number(p.y.toFixed(2))],
              hp: Math.round(p.hp),
              team: p.team,
              treasure: p.treasure,
              kills: p.kills,
              kickCharge: Number(p.kickCharge.toFixed(2)),
              dashCd: Number(p.dashCd.toFixed(2)),
              grounded: true,
            },
            partner: partner ? { id: partner.id, name: partner.name } : null,
            chestsCount: sim.chests.filter((c) => c.hp > 0).length,
            monstersCount: sim.monsters.filter((m) => m.alive).length,
            lootsCount: sim.loots.filter((l) => l.value > 0).length,
            betrayals: sim.betrayals,
            chestBreaks: sim.chestBreaks,
            playerTreasure: sim.playerTreasure,
          };
        },
      });
      if (unregisterIslandMatch) yield unregisterIslandMatch;

      // 主循环系统：采样键盘与触控输入，单向推进模拟，同步呈现，向 UI 推送 HUD 状态
      let hudSyncCounter = 0;
      world
        .addSystem(Update, {
          name: 'island-simulation-step',
          queries: [],
          fn: () => {
            const dt = world.getResource(Time).delta;
            let moveX = touchMoveX;
            let moveY = touchMoveY;
            let dash = touchDash;
            let interact = touchInteract;
            let kickHeld = touchKickHeld;
            let speedToggle = touchSpeedToggle;
            let restart = touchRestart;

            // 清零一次性触控标志
            touchDash = false;
            touchInteract = false;
            touchSpeedToggle = false;
            touchRestart = false;

            // 读取键盘 InputSnapshot
            const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
            if (snap) {
              const kb = snap.keyboard;
              let kx = 0;
              let ky = 0;
              if (kb.downCode('KeyW') || kb.downCode('ArrowUp')) ky -= 1;
              if (kb.downCode('KeyS') || kb.downCode('ArrowDown')) ky += 1;
              if (kb.downCode('KeyA') || kb.downCode('ArrowLeft')) kx -= 1;
              if (kb.downCode('KeyD') || kb.downCode('ArrowRight')) kx += 1;

              if (kx !== 0 || ky !== 0) {
                const len = Math.hypot(kx, ky);
                moveX = kx / len;
                moveY = ky / len;
              }

              if (kb.justPressedCode('Space')) dash = true;
              if (kb.justPressedCode('KeyE')) interact = true;
              if (kb.downCode('KeyF')) kickHeld = true;
              if (kb.justPressedCode('KeyQ')) speedToggle = true;
              if (kb.justPressedCode('KeyR')) restart = true;
            }

            const inputIntent: PlayerInputIntent = {
              moveX,
              moveY,
              dash,
              interact,
              kickHeld,
              speedToggle,
              restart,
            };

            stepSimulation(sim, dt, inputIntent);
            presentation.update(sim, dt);

            // 每 4 帧向前端 UI 推送一次轻量 HUD 状态
            hudSyncCounter++;
            if (port && hudSyncCounter % 4 === 0) {
              const p = sim.actors[0]!;
              const partner = partnerOf(sim, p);
              port.postMessage({
                channel: 'island/hud-state',
                elapsed: sim.elapsed,
                phase: sim.finalPhase ? 'final' : sim.shrink > 0 ? 'shrink' : 'normal',
                shrink: sim.shrink,
                gameOver: sim.gameOver,
                winnerName: sim.winner?.name ?? null,
                aliveCount: aliveActors(sim).length,
                hp: Math.round(p.hp),
                isAlive: p.alive,
                treasure: p.treasure,
                playerTreasure: sim.playerTreasure,
                chestBreaks: sim.chestBreaks,
                betrayals: sim.betrayals,
                kills: p.kills,
                partnerName: partner?.name ?? null,
                kickCharge: p.kickCharge,
              });
            }
          },
        })
        .unwrap();

      yield () => world.removeSystem(Update, 'island-simulation-step').unwrap();
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId: PACKAGE_IDS.islandGame,
  build: () =>
    ok({
      'plugin/island': {
        kind: 'plugin',
        module: { specifier: './island.pack.ts', export: 'islandPlugin' },
      },
    }),
});
