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
  acceptInvite,
  aliveActors,
  createInitialSimulation,
  dist,
  getIgnoreRemaining,
  getNearbyCandidate,
  ignorePair,
  isPairIgnored,
  landRadius,
  MATCH_SECONDS,
  partnerOf,
  type PlayerInputIntent,
  sendInvite,
  stepSimulation,
  TEAM_BREAK_DISTANCE,
  TEAM_WARNING_DISTANCE,
} from './simulation.ts';

export const ISLAND_CONTROL_CHANNEL = 'island/controls';

export interface IslandTouchMessage {
  channel: typeof ISLAND_CONTROL_CHANNEL;
  kind: 'move' | 'dash' | 'invite' | 'accept' | 'ignore' | 'speed' | 'restart' | 'reset';
  x?: number;
  y?: number;
  targetId?: number;
  inviteId?: number;
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

      // 前端控制输入意图
      let touchMoveX = 0;
      let touchMoveY = 0;
      let touchDash = false;
      let touchInviteTargetId: number | null = null;
      let touchAcceptInviteId: number | null = null;
      let touchIgnoreTargetId: number | null = null;
      let touchSpeedToggle = false;
      let touchRestart = false;

      // 监听来自前端 UI 的消息
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
            case 'invite':
              if (typeof data.targetId === 'number') touchInviteTargetId = data.targetId;
              break;
            case 'accept':
              if (typeof data.inviteId === 'number') touchAcceptInviteId = data.inviteId;
              break;
            case 'ignore':
              if (typeof data.targetId === 'number') touchIgnoreTargetId = data.targetId;
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
          const partnerDist = partner ? dist(p, partner) : null;
          const candidate = getNearbyCandidate(sim, p);
          const incoming = sim.invites.find((i) => i.toId === p.id && sim.elapsed <= i.expiresAt);
          const outgoing = sim.invites.find((i) => i.fromId === p.id && sim.elapsed <= i.expiresAt);

          let nearestActor: { id: number; name: string; x: number; y: number; distance: number } | null = null;
          let minActorDist = 999;
          for (const o of aliveActors(sim)) {
            if (o.id === p.id) continue;
            const d = dist(p, o);
            if (d < minActorDist) {
              minActorDist = d;
              nearestActor = {
                id: o.id,
                name: o.name,
                x: Number(o.x.toFixed(2)),
                y: Number(o.y.toFixed(2)),
                distance: Number(d.toFixed(2)),
              };
            }
          }

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
              dashCd: Number(p.dashCd.toFixed(2)),
              grounded: true,
            },
            partner: partner
              ? {
                  id: partner.id,
                  name: partner.name,
                  distance: Number(partnerDist?.toFixed(2) ?? 0),
                  isWarning: (partnerDist ?? 0) >= TEAM_WARNING_DISTANCE,
                }
              : null,
            candidate: candidate
              ? {
                  id: candidate.id,
                  name: candidate.name,
                  distance: candidate.distance,
                  canInvite: candidate.canInvite,
                  reason: candidate.reason ?? null,
                }
              : null,
            nearestActor: nearestActor
              ? {
                  id: nearestActor.id,
                  name: nearestActor.name,
                  x: nearestActor.x,
                  y: nearestActor.y,
                  distance: nearestActor.distance,
                }
              : null,
            incomingInvite: incoming
              ? {
                  id: incoming.id,
                  fromId: incoming.fromId,
                  fromName: sim.actors[incoming.fromId]?.name ?? '',
                  timeLeft: Number(Math.max(0, incoming.expiresAt - sim.elapsed).toFixed(1)),
                }
              : null,
            outgoingInvite: outgoing
              ? {
                  id: outgoing.id,
                  toId: outgoing.toId,
                  toName: sim.actors[outgoing.toId]?.name ?? '',
                  timeLeft: Number(Math.max(0, outgoing.expiresAt - sim.elapsed).toFixed(1)),
                }
              : null,
            chestsCount: sim.chests.filter((c) => c.hp > 0).length,
            monstersCount: sim.monsters.filter((m) => m.alive).length,
            lootsCount: sim.loots.filter((l) => l.value > 0).length,
            playerDisbands: sim.playerDisbands,
            betrayals: sim.playerDisbands,
            chestBreaks: sim.chestBreaks,
            playerTreasure: sim.playerTreasure,
            lastBreakEvent: sim.lastBreakEvent
              ? {
                  seq: sim.lastBreakEvent.seq,
                  a: sim.lastBreakEvent.a,
                  b: sim.lastBreakEvent.b,
                  x: Number(sim.lastBreakEvent.x.toFixed(2)),
                  y: Number(sim.lastBreakEvent.y.toFixed(2)),
                  lootCount: sim.lastBreakEvent.lootCount,
                  reason: sim.lastBreakEvent.reason,
                }
              : null,
          };
        },
      });
      if (unregisterIslandMatch) yield unregisterIslandMatch;

      // 主循环系统
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
            let inviteTargetId = touchInviteTargetId;
            let acceptInviteId = touchAcceptInviteId;
            let ignoreTargetId = touchIgnoreTargetId;
            let speedToggle = touchSpeedToggle;
            let restart = touchRestart;

            // 清除一次性触发参数
            touchDash = false;
            touchInviteTargetId = null;
            touchAcceptInviteId = null;
            touchIgnoreTargetId = null;
            touchSpeedToggle = false;
            touchRestart = false;

            // 键盘快捷键响应
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

              // E 键：有收到的邀请则接受；否则若有附近候选角色则发送邀请
              if (kb.justPressedCode('KeyE')) {
                const incoming = sim.invites.find(
                  (i) => i.toId === sim.actors[0]!.id && sim.elapsed <= i.expiresAt,
                );
                if (incoming) {
                  acceptInviteId = incoming.id;
                } else {
                  const candidate = getNearbyCandidate(sim, sim.actors[0]!);
                  if (candidate && candidate.canInvite) {
                    inviteTargetId = candidate.id;
                  }
                }
              }

              // X 键：忽略附近候选角色或发邀请者 60 秒
              if (kb.justPressedCode('KeyX')) {
                const incoming = sim.invites.find(
                  (i) => i.toId === sim.actors[0]!.id && sim.elapsed <= i.expiresAt,
                );
                if (incoming) {
                  ignoreTargetId = incoming.fromId;
                } else {
                  const candidate = getNearbyCandidate(sim, sim.actors[0]!);
                  if (candidate) {
                    ignoreTargetId = candidate.id;
                  }
                }
              }

              if (kb.justPressedCode('KeyQ')) speedToggle = true;
              if (kb.justPressedCode('KeyR')) restart = true;
            }

            const inputIntent: PlayerInputIntent = {
              moveX,
              moveY,
              dash,
              inviteTargetId,
              acceptInviteId,
              ignoreTargetId,
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
              const partnerDist = partner ? dist(p, partner) : null;
              const candidate = getNearbyCandidate(sim, p);
              const incoming = sim.invites.find((i) => i.toId === p.id && sim.elapsed <= i.expiresAt);
              const outgoing = sim.invites.find((i) => i.fromId === p.id && sim.elapsed <= i.expiresAt);

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
                playerDisbands: sim.playerDisbands,
                betrayals: sim.playerDisbands,
                kills: p.kills,
                partnerName: partner?.name ?? null,
                partnerDistance: partnerDist !== null ? Number(partnerDist.toFixed(1)) : null,
                isWarning: (partnerDist ?? 0) >= TEAM_WARNING_DISTANCE,
                candidate: candidate
                  ? {
                      id: candidate.id,
                      name: candidate.name,
                      distance: candidate.distance,
                      canInvite: candidate.canInvite,
                      reason: candidate.reason,
                    }
                  : null,
                incomingInvite: incoming
                  ? {
                      id: incoming.id,
                      fromId: incoming.fromId,
                      fromName: sim.actors[incoming.fromId]?.name ?? '',
                      timeLeft: Math.max(0, Math.ceil(incoming.expiresAt - sim.elapsed)),
                    }
                  : null,
                outgoingInvite: outgoing
                  ? {
                      id: outgoing.id,
                      toId: outgoing.toId,
                      toName: sim.actors[outgoing.toId]?.name ?? '',
                      timeLeft: Math.max(0, Math.ceil(outgoing.expiresAt - sim.elapsed)),
                    }
                  : null,
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
