// 《荒岛分赃》原生游戏 Plugin 与生命周期管理
// 挂载原生场景、推进核心玩法模拟、更新呈现、注册只读投影
// 包含连续挑战会话（累计有效时长 >= 900s 与局数管理）

import { Time, Update } from '@forgeax/engine/ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { definePack } from '@forgeax/engine/pack/source';
import type { Plugin } from '@forgeax/engine/plugin';
import { worldDespawnScene } from '@forgeax/engine/scene';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS } from '../shared/asset-refs.ts';
import { setupPresentation } from './presentation.ts';
import {
  aggregateWorldMultipliers,
  createInitialEndlessProfile,
  STAT_FACTORS,
  STAT_NAMES,
  STAT_TARGETS,
  type CarryRelic,
  type EndlessProfile,
  type GlobalRule,
  type StatFactor,
  type StatTarget,
  type WorldMultipliers,
} from './stats.ts';
import {
  acceptInvite,
  aliveActors,
  chestOf,
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
  restartSimulation,
  sendInvite,
  stepSimulation,
  TEAM_BREAK_DISTANCE,
  TEAM_WARNING_DISTANCE,
} from './simulation.ts';

export const ISLAND_CONTROL_CHANNEL = 'island/controls';

export interface IslandTouchMessage {
  channel: typeof ISLAND_CONTROL_CHANNEL;
  kind:
    | 'move'
    | 'team'
    | 'dash'
    | 'invite'
    | 'accept'
    | 'ignore'
    | 'upgrade'
    | 'rule_select'
    | 'relic_select'
    | 'next_round'
    | 'mode_select'
    | 'speed'
    | 'restart'
    | 'reset';
  x?: number;
  y?: number;
  targetId?: number;
  inviteId?: number;
  choiceIndex?: number;
  stat?: StatTarget;
  factor?: StatFactor;
  relicKind?: 'knife' | 'arrow' | 'bomb' | null;
  relicLevel?: number;
  mode?: 'normal' | 'endless';
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

      // 无限模式角色 Profile 管理（各角色独立规则历史与携带宝物）
      const endlessProfiles = new Map<number, EndlessProfile>();
      for (let i = 0; i < 10; i++) {
        endlessProfiles.set(i, createInitialEndlessProfile(i));
      }

      let mode: 'normal' | 'endless' = 'endless';
      let matchIndex = 1;
      let completedRounds = 0;
      let sessionChallengeElapsed = 0;
      let roundFinishedLogged = false;
      let endlessPhase: 'playing' | 'round-result' | 'rule-pick' | 'relic-pick' = 'playing';

      let ruleAnnouncement: string | null = null;
      let ruleAnnouncementTimer = 0;

      let playerPendingRule: GlobalRule | null = null;
      let playerPendingRelic: CarryRelic | null = null;
      const aiPendingDecisions = new Map<number, { rule: GlobalRule; relic: CarryRelic | null }>();

      let upgradeHighlight = 0;
      let ruleStatIndex = 0;
      let ruleFactorIndex = 0;
      let relicHighlight = 0;

      const getPlayerOwnedRelics = (): CarryRelic[] => {
        const p = sim.actors[0];
        if (!p) return [];
        const list: CarryRelic[] = [];
        if (p.weaponKnife > 0) list.push({ kind: 'knife', level: p.weaponKnife });
        if (p.weaponArrow > 0) list.push({ kind: 'arrow', level: p.weaponArrow });
        if (p.weaponBomb > 0) list.push({ kind: 'bomb', level: p.weaponBomb });
        return list;
      };

      const aiDecideNextRound = (
        actorId: number,
        round: number,
      ): { rule: GlobalRule; relic: CarryRelic | null } => {
        const actor = sim.actors[actorId];
        const personality = actor?.ai ?? 'honest';

        let preferredStats: StatTarget[] = ['maxHp', 'moveSpeed'];
        let preferredFactors: StatFactor[] = [1.2, 1.1];
        if (personality === 'greedy') {
          preferredStats = ['damage', 'attackSpeed'];
          preferredFactors = [1.2, 1.1];
        } else if (personality === 'raider') {
          preferredStats = ['damage', 'critChance', 'maxHp'];
          preferredFactors = [1.2, 1.1, 0.9];
        }

        const stat = preferredStats[Math.floor(Math.random() * preferredStats.length)] ?? 'damage';
        const factor = preferredFactors[Math.floor(Math.random() * preferredFactors.length)] ?? 1.2;

        const rule: GlobalRule = {
          ownerId: actorId,
          stat,
          factor,
          chosenAtRound: round,
        };

        let relic: CarryRelic | null = null;
        if (actor) {
          const owned: CarryRelic[] = [];
          if (actor.weaponKnife > 0) owned.push({ kind: 'knife', level: actor.weaponKnife });
          if (actor.weaponArrow > 0) owned.push({ kind: 'arrow', level: actor.weaponArrow });
          if (actor.weaponBomb > 0) owned.push({ kind: 'bomb', level: actor.weaponBomb });
          if (owned.length > 0) {
            owned.sort((a, b) => b.level - a.level);
            relic = owned[0] ?? null;
          }
        }

        return { rule, relic };
      };

      const startNextEndlessRound = () => {
        if (playerPendingRule) {
          const p0 = endlessProfiles.get(0)!;
          p0.rules.push(playerPendingRule);
          p0.carryRelic = playerPendingRelic;
          p0.endlessRound++;
        }
        for (const [id, dec] of aiPendingDecisions) {
          const p = endlessProfiles.get(id);
          if (p) {
            p.rules.push(dec.rule);
            p.carryRelic = dec.relic;
            p.endlessRound++;
          }
        }

        playerPendingRule = null;
        playerPendingRelic = null;
        aiPendingDecisions.clear();

        const allRules: GlobalRule[] = [];
        for (const p of endlessProfiles.values()) {
          allRules.push(...p.rules);
        }
        const activeIds = new Set(sim.actors.map((a) => a.id));
        const worldMultipliers = aggregateWorldMultipliers(allRules, activeIds);

        const carryRelics = new Map<number, CarryRelic>();
        for (const [id, p] of endlessProfiles) {
          if (p.carryRelic) carryRelics.set(id, p.carryRelic);
        }

        restartSimulation(sim, { worldMultipliers, carryRelics });
        presentation.reset(sim);

        matchIndex++;
        roundFinishedLogged = false;
        endlessPhase = 'playing';

        const eff = sim.effectiveMultipliers;
        ruleAnnouncement = `第 ${matchIndex} 局开始！全场修正已生效: 血量×${eff.maxHp.toFixed(2)} 伤害×${eff.damage.toFixed(2)} 移速×${eff.moveSpeed.toFixed(2)} 攻速×${eff.attackSpeed.toFixed(2)} 暴击×${eff.critChance.toFixed(2)}`;
        ruleAnnouncementTimer = 5.0;
      };

      const resetAllEndless = () => {
        for (let i = 0; i < 10; i++) {
          endlessProfiles.set(i, createInitialEndlessProfile(i));
        }
        matchIndex = 1;
        completedRounds = 0;
        sessionChallengeElapsed = 0;
        roundFinishedLogged = false;
        endlessPhase = 'playing';
        playerPendingRule = null;
        playerPendingRelic = null;
        aiPendingDecisions.clear();
        ruleAnnouncement = null;
        ruleAnnouncementTimer = 0;
        restartSimulation(sim);
        presentation.reset(sim);
      };

      // 前端控制输入意图
      let matchReady = false;
      let touchMoveX = 0;
      let touchMoveY = 0;
      let touchTeamAction = false;
      let touchInviteTargetId: number | null = null;
      let touchAcceptInviteId: number | null = null;
      let touchIgnoreTargetId: number | null = null;
      let touchUpgradeChoiceIndex: number | null = null;
      let touchSpeedToggle = false;
      let touchRestart = false;

      // 监听来自前端 UI 的控制消息
      const port = host?.port;
      if (port) {
        port.start?.();
        const onMessage = (event: MessageEvent) => {
          const data = event.data as IslandTouchMessage | undefined;
          if (!data || data.channel !== ISLAND_CONTROL_CHANNEL) return;
          switch (data.kind) {
            case 'move':
              touchMoveX = data.x ?? 0;
              touchMoveY = data.y ?? 0;
              break;
            case 'team':
              touchTeamAction = true;
              break;
            case 'dash':
              touchTeamAction = true;
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
            case 'upgrade':
              if (typeof data.choiceIndex === 'number') touchUpgradeChoiceIndex = data.choiceIndex;
              break;
            case 'rule_select':
              if (data.stat && typeof data.factor === 'number') {
                playerPendingRule = {
                  ownerId: 0,
                  stat: data.stat,
                  factor: data.factor,
                  chosenAtRound: matchIndex,
                };
                aiPendingDecisions.clear();
                for (let i = 1; i < 10; i++) {
                  aiPendingDecisions.set(i, aiDecideNextRound(i, matchIndex));
                }
                endlessPhase = 'relic-pick';
              }
              break;
            case 'relic_select':
              if (data.relicKind) {
                playerPendingRelic = {
                  kind: data.relicKind,
                  level: data.relicLevel ?? 1,
                };
              } else {
                playerPendingRelic = null;
              }
              startNextEndlessRound();
              break;
            case 'next_round':
              if (mode === 'normal') {
                restartSimulation(sim);
                presentation.reset(sim);
                endlessPhase = 'playing';
              } else {
                if (endlessPhase === 'round-result') {
                  endlessPhase = 'rule-pick';
                }
              }
              break;
            case 'mode_select':
              if (data.mode) {
                mode = data.mode;
              }
              break;
            case 'speed':
              touchSpeedToggle = true;
              break;
            case 'restart':
              resetAllEndless();
              break;
            case 'reset':
              touchMoveX = 0;
              touchMoveY = 0;
              if (!matchReady) {
                matchReady = true;
                restartSimulation(sim);
                presentation.reset(sim);
              }
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
        description: 'Read-only state for 《荒岛分赃》 gameplay assertions',
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
            const isEligible = o.team < 0 && !isPairIgnored(sim, p.id, o.id);
            const d = dist(p, o) + (isEligible ? 0 : 100);
            if (d < minActorDist) {
              minActorDist = d;
              nearestActor = {
                id: o.id,
                name: o.name,
                x: Number(o.x.toFixed(2)),
                y: Number(o.y.toFixed(2)),
                distance: Number(dist(p, o).toFixed(2)),
              };
            }
          }

          const ownChest = p.team >= 0 ? chestOf(sim, p.team) : null;

          return {
            elapsed: Number(sim.elapsed.toFixed(2)),
            progress: Number((sim.elapsed / MATCH_SECONDS).toFixed(3)),
            phase: sim.finalPhase ? 'final' : sim.shrink > 0 ? 'shrink' : 'normal',
            shrink: Number(sim.shrink.toFixed(3)),
            landRadius: Number(landRadius(sim.shrink).toFixed(3)),
            overtime: sim.overtime,
            overtimeResolution: sim.overtimeResolution,
            gameOver: sim.gameOver,
            winnerId: sim.winner ? sim.winner.id : -1,
            winnerName: sim.winner ? sim.winner.name : null,
            aliveCount: aliveActors(sim).length,
            player: {
              id: p.id,
              name: p.name,
              alive: p.alive,
              rank: p.rank,
              x: Number(p.x.toFixed(2)),
              y: Number(p.y.toFixed(2)),
              position: [Number(p.x.toFixed(2)), 0, Number(p.y.toFixed(2))],
              hp: Math.round(p.hp),
              team: p.team,
              treasure: p.treasure,
              kills: p.kills,
              dashCd: Number(p.dashCd.toFixed(2)),
              grounded: p.alive,
              level: p.level,
              xp: p.xp,
              xpNext: p.xpNext,
              weaponKnife: p.weaponKnife,
              weaponArrow: p.weaponArrow,
              weaponBomb: p.weaponBomb,
              relic: endlessProfiles.get(0)?.carryRelic
                ? {
                    kind: endlessProfiles.get(0)!.carryRelic!.kind,
                    level: endlessProfiles.get(0)!.carryRelic!.level,
                  }
                : null,
            },
            partner: partner
              ? {
                  id: partner.id,
                  name: partner.name,
                  x: Number(partner.x.toFixed(2)),
                  y: Number(partner.y.toFixed(2)),
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
            ownChest: ownChest
              ? {
                  treasure: ownChest.treasure,
                  hp: ownChest.hp,
                  maxHp: ownChest.maxHp,
                }
              : null,
            pendingUpgrade: sim.pendingUpgrade,
            upgradeChoices: sim.upgradeChoices,
            activeEvent: sim.activeEvent,
            eventTimeLeft: Number(Math.max(0, sim.eventTimeLeft).toFixed(1)),
            boss: sim.boss && sim.boss.alive
              ? {
                  id: sim.boss.id,
                  hp: sim.boss.hp,
                  maxHp: sim.boss.maxHp,
                  x: Number(sim.boss.x.toFixed(2)),
                  y: Number(sim.boss.y.toFixed(2)),
                }
              : null,
            chestsCount: sim.chests.filter((c) => c.hp > 0 || c.treasure > 0).length,
            monstersCount: sim.monsters.filter((m) => m.alive).length,
            lootsCount: sim.loots.filter((l) => l.value > 0).length,
            playerDisbands: sim.playerDisbands,
            betrayals: sim.playerDisbands,
            chestBreaks: sim.chestBreaks,
            playerTreasure: sim.playerTreasure,
            session: {
              challengeElapsed: Number(sessionChallengeElapsed.toFixed(1)),
              roundsCompleted: completedRounds,
              roundIndex: matchIndex,
              isChallengeTargetReached: sessionChallengeElapsed >= 900,
            },
            endless: {
              mode,
              roundIndex: matchIndex,
              completedRounds,
              phase: endlessPhase,
              worldMultipliers: {
                maxHp: Number(sim.worldMultipliers.maxHp.toFixed(3)),
                damage: Number(sim.worldMultipliers.damage.toFixed(3)),
                moveSpeed: Number(sim.worldMultipliers.moveSpeed.toFixed(3)),
                attackSpeed: Number(sim.worldMultipliers.attackSpeed.toFixed(3)),
                critChance: Number(sim.worldMultipliers.critChance.toFixed(3)),
              },
              effectiveMultipliers: {
                maxHp: Number(sim.effectiveMultipliers.maxHp.toFixed(3)),
                damage: Number(sim.effectiveMultipliers.damage.toFixed(3)),
                moveSpeed: Number(sim.effectiveMultipliers.moveSpeed.toFixed(3)),
                attackSpeed: Number(sim.effectiveMultipliers.attackSpeed.toFixed(3)),
                critChance: Number(sim.effectiveMultipliers.critChance.toFixed(3)),
              },
              playerRelic: endlessProfiles.get(0)?.carryRelic
                ? {
                    kind: endlessProfiles.get(0)!.carryRelic!.kind,
                    level: endlessProfiles.get(0)!.carryRelic!.level,
                  }
                : null,
              rulesCount: Array.from(endlessProfiles.values()).reduce((acc, p) => acc + p.rules.length, 0),
              ruleAnnouncement: ruleAnnouncement ?? null,
            },
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
            const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
            if (!matchReady && snap) {
              matchReady = true;
              restartSimulation(sim);
              presentation.reset(sim);
            }

            const dt = world.getResource(Time).delta;
            let moveX = touchMoveX;
            let moveY = touchMoveY;
            let teamAction = touchTeamAction;
            let inviteTargetId = touchInviteTargetId;
            let acceptInviteId = touchAcceptInviteId;
            let ignoreTargetId = touchIgnoreTargetId;
            let upgradeChoiceIndex = touchUpgradeChoiceIndex;
            let speedToggle = touchSpeedToggle;
            let restart = touchRestart;

            // 清除一次性触发参数
            touchTeamAction = false;
            touchInviteTargetId = null;
            touchAcceptInviteId = null;
            touchIgnoreTargetId = null;
            touchUpgradeChoiceIndex = null;
            touchSpeedToggle = false;
            touchRestart = false;

            // 键盘输入响应：统一为 WASD / 方向键移动，Space 为唯一战斗组队与模态确认按键（R03）
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

              // 模态上下文独占 Space 按键
              if (sim.pendingUpgrade) {
                if (kb.justPressedCode('KeyA') || kb.justPressedCode('ArrowLeft')) {
                  upgradeHighlight = (upgradeHighlight + 2) % 3;
                }
                if (kb.justPressedCode('KeyD') || kb.justPressedCode('ArrowRight')) {
                  upgradeHighlight = (upgradeHighlight + 1) % 3;
                }
                if (kb.justPressedCode('Space')) {
                  upgradeChoiceIndex = upgradeHighlight;
                }
              } else if (sim.gameOver) {
                if (mode === 'normal') {
                  if (kb.justPressedCode('Space')) {
                    restart = true;
                  }
                } else {
                  if (endlessPhase === 'round-result') {
                    if (kb.justPressedCode('Space')) {
                      endlessPhase = 'rule-pick';
                    }
                  } else if (endlessPhase === 'rule-pick') {
                    if (kb.justPressedCode('KeyA') || kb.justPressedCode('ArrowLeft')) {
                      ruleStatIndex = (ruleStatIndex + 4) % 5;
                    }
                    if (kb.justPressedCode('KeyD') || kb.justPressedCode('ArrowRight')) {
                      ruleStatIndex = (ruleStatIndex + 1) % 5;
                    }
                    if (kb.justPressedCode('KeyW') || kb.justPressedCode('ArrowUp')) {
                      ruleFactorIndex = (ruleFactorIndex + 3) % 4;
                    }
                    if (kb.justPressedCode('KeyS') || kb.justPressedCode('ArrowDown')) {
                      ruleFactorIndex = (ruleFactorIndex + 1) % 4;
                    }
                    if (kb.justPressedCode('Space')) {
                      playerPendingRule = {
                        ownerId: 0,
                        stat: STAT_TARGETS[ruleStatIndex] ?? 'damage',
                        factor: STAT_FACTORS[ruleFactorIndex] ?? 1.2,
                        chosenAtRound: matchIndex,
                      };
                      aiPendingDecisions.clear();
                      for (let i = 1; i < 10; i++) {
                        aiPendingDecisions.set(i, aiDecideNextRound(i, matchIndex));
                      }
                      endlessPhase = 'relic-pick';
                    }
                  } else if (endlessPhase === 'relic-pick') {
                    const owned = getPlayerOwnedRelics();
                    const totalOptions = owned.length + 1;
                    if (kb.justPressedCode('KeyA') || kb.justPressedCode('ArrowLeft')) {
                      relicHighlight = (relicHighlight + totalOptions - 1) % totalOptions;
                    }
                    if (kb.justPressedCode('KeyD') || kb.justPressedCode('ArrowRight')) {
                      relicHighlight = (relicHighlight + 1) % totalOptions;
                    }
                    if (kb.justPressedCode('Space')) {
                      playerPendingRelic = owned[relicHighlight] ?? null;
                      startNextEndlessRound();
                    }
                  }
                }
              } else {
                // 战斗状态：Space 触发队伍邀请或接受
                if (kb.justPressedCode('Space')) {
                  teamAction = true;
                }
              }
            }

            const inputIntent: PlayerInputIntent = {
              moveX,
              moveY,
              teamAction,
              dash: teamAction,
              inviteTargetId,
              acceptInviteId,
              ignoreTargetId,
              upgradeChoiceIndex,
              speedToggle,
              restart,
            };

            // 推进连续挑战累计有效时间（仅在玩家存活、活跃互动、未暂停、未加速且未结束时累计 R06）
            if (!sim.gameOver && !sim.upgradePaused && sim.speed === 1 && sim.actors[0]?.alive) {
              sessionChallengeElapsed += dt;
            }
            if (sim.gameOver && !roundFinishedLogged) {
              roundFinishedLogged = true;
              completedRounds++;
              if (mode === 'endless') {
                endlessPhase = 'round-result';
              }
            }
            if (!sim.gameOver && roundFinishedLogged) {
              roundFinishedLogged = false;
            }

            if (ruleAnnouncementTimer > 0) {
              ruleAnnouncementTimer -= dt;
              if (ruleAnnouncementTimer <= 0) {
                ruleAnnouncement = null;
              }
            }

            stepSimulation(sim, dt, inputIntent);

            if (inputIntent.restart) {
              resetAllEndless();
              touchMoveX = 0;
              touchMoveY = 0;
              touchTeamAction = false;
              touchInviteTargetId = null;
              touchAcceptInviteId = null;
              touchIgnoreTargetId = null;
              touchUpgradeChoiceIndex = null;
            } else {
              presentation.update(sim, dt);
            }

            // 每 4 帧向前端 UI 推送一次轻量 HUD 状态
            hudSyncCounter++;
            if (port && hudSyncCounter % 4 === 0) {
              const p = sim.actors[0]!;
              const partner = partnerOf(sim, p);
              const partnerDist = partner ? dist(p, partner) : null;
              const candidate = getNearbyCandidate(sim, p);
              const incoming = sim.invites.find((i) => i.toId === p.id && sim.elapsed <= i.expiresAt);
              const outgoing = sim.invites.find((i) => i.fromId === p.id && sim.elapsed <= i.expiresAt);
              const ownChest = p.team >= 0 ? chestOf(sim, p.team) : null;

              const activeTeams: Array<{ aName: string; bName: string; treasure: number }> = [];
              for (const a of sim.actors) {
                if (a.alive && a.team >= 0 && a.id < a.team) {
                  const b = sim.actors[a.team];
                  if (b && b.alive) {
                    const c = chestOf(sim, a.id);
                    activeTeams.push({
                      aName: a.name,
                      bName: b.name,
                      treasure: c ? c.treasure : 0,
                    });
                  }
                }
              }

              port.postMessage({
                channel: 'island/hud-state',
                elapsed: sim.elapsed,
                phase: sim.finalPhase ? 'final' : sim.shrink > 0 ? 'shrink' : 'normal',
                shrink: sim.shrink,
                gameOver: sim.gameOver,
                isWinner: sim.winner?.id === p.id,
                winnerName: sim.winner?.name ?? null,
                playerRank: p.rank,
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
                playerLevel: p.level,
                playerXp: p.xp,
                playerXpNext: p.xpNext,
                pendingUpgrade: sim.pendingUpgrade,
                upgradeChoices: sim.upgradeChoices,
                boss: sim.boss && sim.boss.alive
                  ? {
                      alive: true,
                      hp: sim.boss.hp,
                      maxHp: sim.boss.maxHp,
                    }
                  : null,
                challengeElapsed: Number(sessionChallengeElapsed.toFixed(1)),
                roundsCompleted: completedRounds,
                roundIndex: matchIndex,
                isChallengeTargetReached: sessionChallengeElapsed >= 900,
                endless: {
                  mode,
                  roundIndex: matchIndex,
                  completedRounds,
                  phase: endlessPhase,
                  worldMultipliers: { ...sim.worldMultipliers },
                  effectiveMultipliers: { ...sim.effectiveMultipliers },
                  ruleAnnouncement,
                  upgradeHighlight,
                  ruleStatIndex,
                  ruleFactorIndex,
                  relicHighlight,
                  ownedRelics: getPlayerOwnedRelics(),
                  playerRelic: endlessProfiles.get(0)?.carryRelic ?? null,
                },
                ownChest: ownChest
                  ? {
                      treasure: ownChest.treasure,
                      hp: Math.max(0, ownChest.hp),
                      maxHp: ownChest.maxHp,
                    }
                  : null,
                teams: activeTeams,
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
