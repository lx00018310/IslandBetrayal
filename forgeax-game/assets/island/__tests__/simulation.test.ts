import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  aliveActors,
  ALLY_IGNORE_SECONDS,
  ALLY_INTERACT_DISTANCE,
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
  getIgnoreRemaining,
  getNearbyCandidate,
  ignorePair,
  isPairIgnored,
  partnerOf,
  sendInvite,
  stepSimulation,
  TEAM_BREAK_DISTANCE,
  TEAM_WARNING_DISTANCE,
} from '../simulation.ts';

describe('荒岛分赃核心规则与回归修复测试', () => {
  // R01: 外部致命攻击必须真正释放箱内财物
  it('R01: external lethal attack bursts chest, scatters loot, and preserves team relationship', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    const enemy = sim.actors[3]!;
    a.x = 10; a.y = 10;
    b.x = 11; b.y = 10;
    enemy.x = 11.5; enemy.y = 10; // In attack range

    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.treasure = 5;
    chest.hp = 12; // 12 HP left

    // Enemy triggers auto attack which hits chest with lethal damage (>= 12)
    enemy.attackCd = 0;
    sim.elapsed = 50; // In combat phase

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
    // Total treasure conservation: remaining ground loots + picked up by nearby actors
    const pickedUp = a.treasure + b.treasure + enemy.treasure;
    const groundLoots = sim.loots.filter((l) => l.value > 0).length;
    expect(groundLoots + pickedUp).toBe(5);

    // Teammates REMAIN TEAMMATES after external chest burst!
    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);

    // Calling destroyChest again does not duplicate loot
    const secondBurst = destroyChest(sim, chest, chest.x, chest.y);
    expect(secondBurst).toBe(0);
    expect(sim.loots.filter((l) => l.value > 0).length + pickedUp).toBe(5);
    expect(sim.chestBreaks).toBe(1);
  });

  // R02: 结局后冻结玩法，结算读取权威结果
  it('R02: freezes gameplay and state completely after gameOver', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    // Eliminate 8 AI
    for (let i = 2; i < 10; i++) {
      sim.actors[i]!.alive = false;
    }
    // Now p and a are alive
    const a = sim.actors[1]!;
    damageActor(sim, a, 100, p);
    expect(sim.gameOver).toBe(true);
    expect(sim.winner?.id).toBe(p.id);
    expect(p.rank).toBe(1);

    const winnerX = p.x;
    const winnerY = p.y;
    const winnerHp = p.hp;

    // Further inputs or steps after game over must not change player or winner
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
    expect(sim.winner?.alive).toBe(true);
    expect(sim.gameOver).toBe(true);
  });

  // R04: 重复忽略不延长屏蔽，忽略最近角色后不挡住旁边其他可选角色
  it('R04: does not extend ignore timer on repeat, and selects other valid candidates', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;

    p.x = 10; p.y = 10;
    a.x = 10.3; a.y = 10; // Distance 0.3
    b.x = 11.2; b.y = 10; // Distance 1.2

    // First ignore on a
    sim.elapsed = 10.0;
    ignorePair(sim, p.id, a.id);
    const expireTime = 10.0 + ALLY_IGNORE_SECONDS; // 70.0
    expect(sim.ignores.get(`${p.id}_${a.id}`)).toBe(expireTime);

    // Repeat ignore input at 25.0 must NOT extend
    sim.elapsed = 25.0;
    ignorePair(sim, p.id, a.id);
    expect(sim.ignores.get(`${p.id}_${a.id}`)).toBe(expireTime); // Still 70.0!

    // Candidate selection: a is ignored, so b MUST be chosen as candidate!
    const cand = getNearbyCandidate(sim, p);
    expect(cand).not.toBeNull();
    expect(cand?.id).toBe(b.id);
    expect(cand?.canInvite).toBe(true);
  });

  // R05: 普通合作 AI 不因远处宝物拉断线；移动后先断线还是先判坠落
  it('R05: teamed AI stays near partner instead of chasing distant loot, and falling priority is respected', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    a.x = 10; a.y = 10;
    b.x = 11; b.y = 10;
    formTeam(sim, a, b);

    // Distant loot 6 units away
    sim.loots.push({
      id: 888,
      x: 17,
      y: 10,
      z: 0.1,
      vx: 0,
      vy: 0,
      vz: 0,
      value: 1,
      life: 20,
      spin: 0,
    });

    // AI think tick
    a.think = 0;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });

    // Partner cooperative distance holds (does not bolt to x=17)
    expect(dist(a, b)).toBeLessThanOrEqual(TEAM_BREAK_DISTANCE);
    expect(a.team).toBe(b.id);

    // Falling priority: if b is pushed off island into void, b is eliminated as 'fall'
    b.x = 0; b.y = 0; // Off island void
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(b.alive).toBe(false);
    expect(a.team).toBe(-1);
    expect(sim.playerDisbands).toBe(0); // Not a distance disband!
  });

  // R08: 邀请冲突与单一邀请参与限制
  it('R08: enforces single invite rule and handles reverse direct agreement', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    const c = sim.actors[3]!;
    a.x = 10; a.y = 10;
    b.x = 11; b.y = 10;
    c.x = 10.5; c.y = 11;

    // a invites b
    expect(sendInvite(sim, a.id, b.id)).toBe(true);

    // a cannot invite c while active invite to b exists
    expect(sendInvite(sim, a.id, c.id)).toBe(false);

    // c cannot invite b while b has incoming invite
    expect(sendInvite(sim, c.id, b.id)).toBe(false);

    // b invites a -> mutual agreement -> form team atomically!
    expect(sendInvite(sim, b.id, a.id)).toBe(true);
    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);
    expect(sim.invites).toHaveLength(0);
  });

  // R09: 合作与个人财物的攻击收益
  it('R09: scales attack damage with personal treasure, alliance, and chest wealth', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;

    // Base damage
    expect(calculateAttackDamage(sim, p)).toBe(10);

    // Personal treasure bonus (+0.5 per treasure, max +10)
    p.treasure = 6;
    expect(calculateAttackDamage(sim, p)).toBe(13); // 10 + 3

    p.treasure = 30; // Capped at +10
    expect(calculateAttackDamage(sim, p)).toBe(20); // 10 + 10

    // Alliance bonus (+3)
    p.treasure = 0;
    p.x = 10; p.y = 10;
    a.x = 11; a.y = 10;
    formTeam(sim, p, a);
    expect(calculateAttackDamage(sim, p)).toBe(13); // 10 + 3

    // Shared chest wealth bonus (+0.5 per chest treasure, max +5)
    const chest = chestOf(sim, p.team)!;
    chest.treasure = 6;
    expect(calculateAttackDamage(sim, p)).toBe(16); // 10 + 3 + 3

    // When team breaks, bonuses vanish
    disbandTeam(sim, p, 'distance');
    expect(calculateAttackDamage(sim, p)).toBe(10);
  });

  it('preserves team at exact TEAM_BREAK_DISTANCE and breaks immediately when exceeded', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    p.x = 10.0;
    p.y = 10.0;
    a.x = 10.0;
    a.y = 11.0;
    formTeam(sim, p, a);
    const chest = chestOf(sim, p.team)!;
    chest.treasure = 6;

    // Pull to exactly 5.0 distance: team holds
    a.y = 10.0 + TEAM_BREAK_DISTANCE;
    checkTeamDistances(sim);
    expect(p.team).toBe(a.id);
    expect(a.team).toBe(p.id);
    expect(chest.hp).toBeGreaterThan(0);

    // Exceed distance strictly (> 5.0)
    a.y = 10.0 + TEAM_BREAK_DISTANCE + 0.1;
    checkTeamDistances(sim);
    expect(p.team).toBe(-1);
    expect(a.team).toBe(-1);
    expect(chest.hp).toBe(0);
    expect(chest.treasure).toBe(0);
    expect(sim.playerDisbands).toBe(1);
    expect(sim.chestBreaks).toBe(1);
    expect(sim.lastBreakEvent?.lootCount).toBe(6);
    expect(sim.loots).toHaveLength(6);
  });
});
