import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  aliveActors,
  ALLY_IGNORE_SECONDS,
  ALLY_INTERACT_DISTANCE,
  applyUpgrade,
  calculateAttackDamage,
  checkTeamDistances,
  chestOf,
  createInitialSimulation,
  damageActor,
  destroyChest,
  disbandTeam,
  dist,
  doDash,
  formTeam,
  generateUpgradeChoices,
  getIgnoreRemaining,
  getNearbyCandidate,
  giveActorXp,
  GRID_SIZE,
  ignorePair,
  isPairIgnored,
  partnerOf,
  sendInvite,
  stepSimulation,
  stepWeapons,
  TEAM_BREAK_DISTANCE,
  TEAM_WARNING_DISTANCE,
} from '../simulation.ts';

describe('荒岛分赃核心规则、肉鸽升级与战斗系统测试', () => {
  // R01: 外部致命攻击破坏宝箱
  it('R01: external lethal attack bursts chest, scatters loot, and preserves team relationship', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0; // 隔离怪物掉落干扰，专测宝箱
    for (let i = 4; i < 10; i++) sim.actors[i]!.alive = false;

    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    const enemy = sim.actors[3]!;
    a.x = 10; a.y = 10;
    b.x = 11; b.y = 10;
    enemy.x = 11.5; enemy.y = 10;

    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.treasure = 5;
    chest.hp = 10;

    enemy.attackCd = 0;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });

    expect(chest.hp).toBe(0);
    expect(chest.treasure).toBe(0);
    expect(sim.chestBreaks).toBe(1);

    const pickedUp = a.treasure + b.treasure + enemy.treasure;
    const groundLoots = sim.loots.filter((l) => l.value > 0).length;
    expect(groundLoots + pickedUp).toBe(5);

    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);

    const secondBurst = destroyChest(sim, chest, chest.x, chest.y);
    expect(secondBurst).toBe(0);
  });

  // R02: 结局后冻结玩法
  it('R02: freezes gameplay and state completely after gameOver', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    for (let i = 2; i < 10; i++) {
      sim.actors[i]!.alive = false;
    }
    const a = sim.actors[1]!;
    damageActor(sim, a, 100, p);
    expect(sim.gameOver).toBe(true);
    expect(sim.winner?.id).toBe(p.id);
    expect(p.rank).toBe(1);

    const winnerX = p.x;
    const winnerY = p.y;
    const winnerHp = p.hp;

    stepSimulation(sim, 1.0, {
      moveX: 1,
      moveY: 1,
      dash: true,
      speedToggle: false,
      restart: false,
    });

    expect(p.x).toBe(winnerX);
    expect(p.y).toBe(winnerY);
    expect(p.hp).toBe(winnerHp);
    expect(sim.gameOver).toBe(true);
  });

  // R04: 忽略机制
  it('R04: does not extend ignore timer on repeat, and selects other valid candidates', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;

    p.x = 10; p.y = 10;
    a.x = 10.3; a.y = 10;
    b.x = 11.2; b.y = 10;

    sim.elapsed = 10.0;
    ignorePair(sim, p.id, a.id);
    const expireTime = 10.0 + ALLY_IGNORE_SECONDS;
    expect(sim.ignores.get(`${p.id}_${a.id}`)).toBe(expireTime);

    sim.elapsed = 25.0;
    ignorePair(sim, p.id, a.id);
    expect(sim.ignores.get(`${p.id}_${a.id}`)).toBe(expireTime);

    const cand = getNearbyCandidate(sim, p);
    expect(cand).not.toBeNull();
    expect(cand?.id).toBe(b.id);
    expect(cand?.canInvite).toBe(true);
  });

  // P0-B: 经验与升级三选一及全局暂停
  it('P0-B: levels up with XP, triggers pendingUpgrade and pauses simulation on player level-up', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    expect(p.level).toBe(1);
    expect(p.xp).toBe(0);
    expect(p.xpNext).toBe(5);

    // Give player 5 XP -> level up to 2
    giveActorXp(sim, p, 5);
    expect(p.level).toBe(2);
    expect(p.xp).toBe(0);
    expect(p.xpNext).toBe(7);
    expect(sim.pendingUpgrade).toBe(true);
    expect(sim.upgradePaused).toBe(true);
    expect(sim.upgradeChoices).toHaveLength(3);

    // During pause, time does not advance and actors do not move
    const oldElapsed = sim.elapsed;
    const oldX = p.x;
    stepSimulation(sim, 0.5, {
      moveX: 1,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.elapsed).toBe(oldElapsed);
    expect(p.x).toBe(oldX);

    // Player selects choice 0
    const chosen = sim.upgradeChoices[0]!;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      upgradeChoiceIndex: 0,
      speedToggle: false,
      restart: false,
    });
    expect(sim.pendingUpgrade).toBe(false);
    expect(sim.upgradePaused).toBe(false);

    // Simulation resumes
    stepSimulation(sim, 0.5, {
      moveX: 1,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.elapsed).toBeGreaterThan(oldElapsed);
  });

  // P0-C: 三类武器逻辑与伤害结算
  it('P0-C: triggers rotating knives, arrows, and bombs while respecting team immunity', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const ally = sim.actors[1]!;
    const enemy = sim.actors[2]!;

    p.x = 10; p.y = 10;
    ally.x = 11; ally.y = 10;
    enemy.x = 11.2; enemy.y = 10;
    formTeam(sim, p, ally);

    // Equip 2 knives, 1 arrow, 1 bomb on player
    p.weaponKnife = 2;
    p.weaponArrow = 1;
    p.weaponBomb = 1;
    p.arrowTimer = 0;
    p.bombTimer = 0;

    const initialAllyHp = ally.hp;
    const initialEnemyHp = enemy.hp;

    // Step weapons simulation
    stepWeapons(sim, 0.1);

    // Ally takes ZERO damage from player's weapons
    expect(ally.hp).toBe(initialAllyHp);

    // Arrow spawned and fired toward enemy
    expect(sim.arrows.length).toBeGreaterThanOrEqual(1);
    expect(sim.arrows[0]!.ownerId).toBe(p.id);

    // Bomb dropped
    expect(sim.bombs.length).toBeGreaterThanOrEqual(1);
    expect(sim.bombs[0]!.ownerId).toBe(p.id);
  });

  // P1-A: 180s Boss 战
  it('P1-A: spawns boss at 180s with high HP and drops 8 XP plus 8 treasures on kill', () => {
    const sim = createInitialSimulation();
    const center = (GRID_SIZE - 1) / 2;
    const p = sim.actors[0]!;
    p.x = center;
    p.y = center + 1; // 靠近中心以进入攻击距离
    sim.elapsed = 179.9;

    stepSimulation(sim, 0.2, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });

    expect(sim.bossSpawned).toBe(true);
    expect(sim.boss).not.toBeNull();
    expect(sim.boss?.kind).toBe('boss');

    sim.boss!.hp = 1;
    p.attackCd = 0;

    stepSimulation(sim, 0.8, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });

    // 击败 Boss 奖励结算
    expect(sim.boss?.alive).toBe(false);
    expect(sim.loots.length).toBeGreaterThanOrEqual(8);
  });

  // P1-C: 特殊事件
  it('P1-C: triggers treasure_rain at 90s and monster_frenzy at 220s', () => {
    const sim = createInitialSimulation();
    sim.elapsed = 89.9;

    stepSimulation(sim, 0.2, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.eventTriggered.treasure_rain).toBe(true);
    expect(sim.activeEvent).toBe('treasure_rain');
    expect(sim.loots.length).toBeGreaterThanOrEqual(8);

    // Advance to 220s
    sim.elapsed = 219.9;
    stepSimulation(sim, 0.2, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.eventTriggered.monster_frenzy).toBe(true);
    expect(sim.activeEvent).toBe('monster_frenzy');
  });

  // P1-D: 决胜加时与确定性平分判定
  it('P1-D: enters overtime after 300s and resolves winner deterministically by tiebreaker at 360s', () => {
    const sim = createInitialSimulation();
    const center = (GRID_SIZE - 1) / 2;
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    for (let i = 2; i < 10; i++) {
      sim.actors[i]!.alive = false;
    }
    // 置于中心安全陆地避免缩圈坠落
    p.x = center; p.y = center; p.hp = 80;
    a.x = center + 0.1; a.y = center; a.hp = 60;
    p.team = a.id; a.team = p.id;

    sim.elapsed = 300.1;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.overtime).toBe(true);
    expect(sim.finalPhase).toBe(true);

    // 推进至 360s 加时极限
    sim.elapsed = 360.1;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.gameOver).toBe(true);
    expect(sim.winner?.id).toBe(p.id); // 血量高者获胜
    expect(sim.overtimeResolution).toBe('points');
  });
});
