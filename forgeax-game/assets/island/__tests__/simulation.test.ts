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
  startBossRaid,
  stepBossRaid,
  finishBossRaid,
  endBossRaid,
  damageActor,
  damageMonster,
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
  getActorOwnedRelicKinds,
  DAMAGE_RELIC_KINDS,
  ENHANCE_RELIC_KINDS,
  grantRelicToActor,
  getActorAttackSpeedBonus,
} from '../simulation.ts';

describe('荒岛分赃核心规则、肉鸽升级与战斗系统测试', () => {
  it('怪物独立推进复活计时，较早到期的怪物不被数组前项阻塞', () => {
    const sim = createInitialSimulation();
    for (const a of sim.actors) a.attackCd = 999;
    for (const m of sim.monsters) { m.alive = false; m.respawn = 999; }
    sim.monsters[0]!.respawn = 1;
    sim.monsters[1]!.respawn = 0.1;
    stepSimulation(sim, 0.2, { moveX: 0, moveY: 0 });
    expect(sim.monsters[0]!.alive).toBe(false);
    expect(sim.monsters[0]!.respawn).toBeCloseTo(0.8);
    expect(sim.monsters[1]!.alive).toBe(true);
  });

  it('世界负倍率与当局卡牌叠加后真实相乘，仅应用伤害最小 1 点', () => {
    const sim = createInitialSimulation({ worldMultipliers: {
      maxHp: 1, damage: 0.2, moveSpeed: 1, attackSpeed: 1, critChance: 1,
    } });
    const p = sim.actors[0]!;
    p.statDamageBonus = 1;
    // 10 * (1+1) * 0.2 = 4（旧实现 clamp 到 0.5 倍得 5，现已移除人为上限）
    expect(calculateAttackDamage(sim, p)).toBe(4);
  });

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
    const groundLoots = sim.loots.reduce((sum, l) => sum + l.value, 0);
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

  // A: 120s / 240s 两次全员 Boss 团战（旧 180s 单次已移除）
  it('120s Boss 不传送角色、不暂停主时钟或缩圈，180s 不重复刷新', () => {
    const sim = createInitialSimulation();
    for (const a of sim.actors) { a.x = 11; a.y = 11; a.think = 999; a.attackCd = 999; }
    sim.monsters.length = 0;
    sim.elapsed = 119.9;
    stepSimulation(sim, 0.2, { moveX: 0, moveY: 0 });
    expect(sim.bossRound).toBe(1);
    expect(sim.raidPhase).toBe('warning');
    expect(sim.actors[0]!.x).toBe(11);
    const before = sim.elapsed;
    stepSimulation(sim, 0.2, { moveX: 0, moveY: 0 });
    expect(sim.elapsed).toBeCloseTo(before + 0.2);
    expect(sim.shrinkStage).toBe(2);
    finishBossRaid(sim, false);
    endBossRaid(sim);
    sim.elapsed = 180;
    stepSimulation(sim, 0.01, { moveX: 0, moveY: 0 });
    expect(sim.bossRound).toBe(1);
  });

  it('第二场 Boss 击破或 35 秒超时进入终局，保留结盟但组队减伤失效，且仍可组队', () => {
    for (const success of [true, false]) {
      const sim = createInitialSimulation();
      sim.bossRound = 1;
      sim.elapsed = 240;
      const a = sim.actors[0]!, b = sim.actors[1]!;
      a.x = 11; a.y = 11; b.x = 12; b.y = 11;
      expect(formTeam(sim, a, b)).toBe(true);
      startBossRaid(sim);
      expect(a.team).toBe(b.id);
      if (success) finishBossRaid(sim, true);
      else stepBossRaid(sim, 35);
      expect(sim.finalPhase).toBe(true);
      // 依最新设计：终局保留队伍关系，且组队减伤失效
      expect(a.team).toBe(b.id);
      expect(b.team).toBe(a.id);

      // 验证终局阶段组队减伤失效（普通阶段组队受伤害减免 20%，终局不再减免）
      const hpBefore = a.hp;
      damageActor(sim, a, 10, null);
      expect(a.hp).toBe(hpBefore - 10);
    }
  });

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
    // 置于中心安全陆地避免缩圈坠落；给足 HP 以在两次 Boss 团战中存活
    p.x = center; p.y = center; p.hp = 5000; p.maxHp = 5000;
    a.x = center + 0.1; a.y = center; a.hp = 3000; a.maxHp = 3000;
    p.team = a.id; a.team = p.id;

    // 先完成 120s / 240s 两场全员 Boss 团战（Plan A），再进入加时
    sim.elapsed = 119.9;
    stepSimulation(sim, 0.2, { moveX: 0, moveY: 0 });
    for (let i = 0; i < 400 && sim.raidPhase !== 'none'; i++) {
      stepSimulation(sim, 0.3, { moveX: 0, moveY: 0 });
    }
    sim.elapsed = 239.9;
    stepSimulation(sim, 0.2, { moveX: 0, moveY: 0 });
    for (let i = 0; i < 400 && sim.raidPhase !== 'none'; i++) {
      stepSimulation(sim, 0.3, { moveX: 0, moveY: 0 });
    }
    // 团战奖励 XP 会触发玩家升级暂停，先处理完卡片再推进时钟
    sim.pendingUpgrade = false;
    sim.upgradePaused = false;
    sim.pendingUpgradeCount = 0;
    sim.upgradeChoices = [];
    // 推进主时钟到 300s+ 进入加时
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

  // R01: 飞刀命中冷却机制（0.4s CD，高帧率不产生重复多次伤害）
  it('飞刀旋转与命中冷却受全场攻速影响，同时保留每目标冷却', () => {
    const sim = createInitialSimulation({ rng: () => 1, worldMultipliers: {
      maxHp: 1, damage: 1, moveSpeed: 1, attackSpeed: 2, critChance: 1,
    } });
    const p = sim.actors[0]!;
    p.weaponKnife = 1;
    p.x = 10; p.y = 10; p.knifeAngle = 0;
    sim.monsters = [sim.monsters[0]!];
    const target = sim.monsters[0]!;
    Object.assign(target, { x: 11.6, y: 10, hp: 1000, maxHp: 1000, alive: true });
    stepWeapons(sim, 0.01);
    expect(p.knifeAngle).toBeCloseTo(0.072);
    const firstHp = target.hp;
    sim.elapsed = 0.1;
    p.knifeAngle = 0;
    stepWeapons(sim, 0.01);
    expect(target.hp).toBe(firstHp);
    sim.elapsed = 0.21;
    p.knifeAngle = 0;
    stepWeapons(sim, 0.01);
    expect(target.hp).toBeLessThan(firstHp);
  });

  it('R01: knife hit cooldown prevents multi-hit on high FPS / multiple steps within cooldown', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0; // 清除普通怪
    const p = sim.actors[0]!;
    p.weaponKnife = 3;
    p.knifeAngle = 0;
    p.x = 10;
    p.y = 10;

    // 创建一只近身怪物
    const targetMonster = {
      id: 500,
      kind: 'tank' as const,
      x: 10 + 1.6, // 正好处于飞刀旋转半径
      y: 10,
      hp: 100,
      maxHp: 100,
      alive: true,
      respawn: 9999,
      wobble: 0,
      hitFlash: 0,
      speed: 0,
      damage: 0,
      attackCd: 99,
    };
    sim.monsters.push(targetMonster);

    // 第一帧命中
    stepWeapons(sim, 0.016);
    const hpAfterFirstHit = targetMonster.hp;
    expect(hpAfterFirstHit).toBeLessThan(100);

    // 接下来 10 帧 (0.16s 累计，仍在 0.4s 冷却期内)
    for (let f = 0; f < 10; f++) {
      sim.elapsed += 0.016;
      stepWeapons(sim, 0.016);
    }
    // HP 应当保持不变，没有被多刀或高帧率重复伤害
    expect(targetMonster.hp).toBe(hpAfterFirstHit);

    // 跨过 0.4s 冷却后，飞刀继续旋转碰触目标，再次触发伤害
    sim.elapsed += 0.45;
    for (let f = 0; f < 30; f++) {
      sim.elapsed += 0.04;
      stepWeapons(sim, 0.04);
      if (targetMonster.hp < hpAfterFirstHit) break;
    }
    expect(targetMonster.hp).toBeLessThan(hpAfterFirstHit);
  });

  // R02: 箭矢/炸弹/普攻/飞刀统一 resolveHostileHit，敌队宝箱先承伤，外部破箱不散队
  it('R02: hostile arrow, bomb, knife and attack hit team chest first, and breaking chest preserves team', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0;

    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    const enemy = sim.actors[3]!;
    a.x = 10; a.y = 10;
    b.x = 10.5; b.y = 10;
    enemy.x = 12; enemy.y = 10;

    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.hp = 50;
    chest.treasure = 10;

    const initialAHp = a.hp;

    // 1. 穿透箭射向 a，应该由宝箱吸收伤害
    sim.arrows.push({
      id: sim.nextEntityId++,
      ownerId: enemy.id,
      x: a.x,
      y: a.y,
      vx: 0,
      vy: 0,
      life: 1.0,
      pierceLeft: 1,
      hitMonsterIds: [],
      hitActorIds: [],
    });
    stepWeapons(sim, 0.016);

    // 角色 a 完好，宝箱掉血
    expect(a.hp).toBe(initialAHp);
    expect(chest.hp).toBeLessThan(50);

    // 2. 外部炸弹将宝箱彻底炸爆
    chest.hp = 1;
    sim.bombs.push({
      id: sim.nextEntityId++,
      ownerId: enemy.id,
      x: a.x,
      y: a.y,
      timer: 0.01,
      radius: 3.0,
      damage: 20,
      exploded: false,
      fxTimer: 0.5,
    });
    stepWeapons(sim, 0.02);

    expect(chest.hp).toBe(0);
    // 队伍关系仍然保留！
    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);
  });

  // R03: 单一 Space 键 / teamAction 组队交互逻辑
  it('R03: teamAction accepts incoming invite or sends invite to nearest candidate', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    p.x = 10; p.y = 10;
    a.x = 11; a.y = 10;

    // 靠近候选角色，按 Space / teamAction 发送邀请
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      teamAction: true,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    const outgoing = sim.invites.find((i) => i.fromId === p.id && i.toId === a.id);
    expect(outgoing).toBeDefined();

    // 对方接受组队
    acceptInvite(sim, outgoing!.id, a.id);
    expect(p.team).toBe(a.id);
    expect(a.team).toBe(p.id);
  });

  // R04 & M4: 跨局携带宝物（等级保留）与世界规则乘数
  it('R04 & M4: carryRelic retains level into next round while resetting other weapons, xp and treasure', () => {
    const carryRelics = new Map();
    carryRelics.set(0, { kind: 'knife', level: 3 });

    const worldMultipliers = {
      maxHp: 1.2,
      damage: 1.1,
      moveSpeed: 1.0,
      attackSpeed: 1.0,
      critChance: 1.0,
    };

    const nextSim = createInitialSimulation({
      carryRelics,
      worldMultipliers,
    });

    const p = nextSim.actors[0]!;
    // 携带宝物保留 3 级飞刀
    expect(p.weaponKnife).toBe(3);
    // 另外两件武器重置为 0
    expect(p.weaponArrow).toBe(0);
    expect(p.weaponBomb).toBe(0);
    // 财富与经验重置
    expect(p.treasure).toBe(0);
    expect(p.xp).toBe(0);
    expect(p.level).toBe(1);
    // 世界血量加成生效 100 * 1.2 = 120
    expect(p.maxHp).toBe(120);
    expect(p.hp).toBe(120);
  });

  it('普通模式新局开局随机获得一个宝物，无限模式开局获得除已有宝物之外的另一个宝物', () => {
    // 1. 普通模式新局：随机获得 1 个宝物，且必须是伤害类宝物
    const normalSim = createInitialSimulation({ grantRandomRelic: true });
    for (const actor of normalSim.actors) {
      const owned = getActorOwnedRelicKinds(actor);
      expect(owned).toHaveLength(1);
      expect(DAMAGE_RELIC_KINDS).toContain(owned[0]!);
      expect(ENHANCE_RELIC_KINDS).not.toContain(owned[0]!);
    }
    expect(normalSim.floats.some((f) => f.text.includes('开局获得：'))).toBe(true);

    // 2. 无限模式新局：继承已有宝物（例如 knife LV.2），额外获得除了 knife 之外的另一个伤害类宝物
    const carryRelics = new Map();
    carryRelics.set(0, { kind: 'knife', level: 2 });
    carryRelics.set(1, { kind: 'frost', level: 3 });

    const endlessSim = createInitialSimulation({
      grantRandomRelic: true,
      carryRelics,
    });

    const p0 = endlessSim.actors[0]!;
    expect(p0.weaponKnife).toBe(2);
    const p0Owned = getActorOwnedRelicKinds(p0);
    expect(p0Owned).toHaveLength(2);
    expect(p0Owned).toContain('knife');
    const extraKindP0 = p0Owned.find((k) => k !== 'knife');
    expect(extraKindP0).toBeDefined();
    expect(DAMAGE_RELIC_KINDS).toContain(extraKindP0!);
    expect(ENHANCE_RELIC_KINDS).not.toContain(extraKindP0!);

    const p1 = endlessSim.actors[1]!;
    expect(p1.relicFrost).toBe(3);
    const p1Owned = getActorOwnedRelicKinds(p1);
    expect(p1Owned).toHaveLength(2);
    expect(p1Owned).toContain('frost');
    const extraKindP1 = p1Owned.find((k) => k !== 'frost');
    expect(extraKindP1).toBeDefined();
    expect(DAMAGE_RELIC_KINDS).toContain(extraKindP1!);
    expect(ENHANCE_RELIC_KINDS).not.toContain(extraKindP1!);
  });

  it('开局随机宝物严格限定为伤害类宝物，且多次抽取无强化类宝物渗漏', () => {
    expect(DAMAGE_RELIC_KINDS).toHaveLength(15);
    expect(ENHANCE_RELIC_KINDS).toHaveLength(6);

    for (let round = 0; round < 30; round++) {
      const sim = createInitialSimulation({ grantRandomRelic: true });
      for (const actor of sim.actors) {
        const owned = getActorOwnedRelicKinds(actor);
        expect(owned).toHaveLength(1);
        const relicKind = owned[0]!;
        expect(DAMAGE_RELIC_KINDS.includes(relicKind as never)).toBe(true);
        expect(ENHANCE_RELIC_KINDS.includes(relicKind as never)).toBe(false);
      }
    }
  });

  it('新增强化类宝物（修罗战魂 might、盘古圣体 vitality、疾风灵羽 haste）数值成长生效', () => {
    const sim = createInitialSimulation();
    const actor = sim.actors[0]!;

    // 1. might: 修罗战魂增伤 (+25% / +50% / +80%，四舍五入为整数伤害)
    const baseDmg = calculateAttackDamage(sim, actor);
    grantRelicToActor(actor, 'might', 1);
    expect(actor.relicMight).toBe(1);
    const dmgLvl1 = calculateAttackDamage(sim, actor);
    expect(dmgLvl1).toBe(Math.round(baseDmg * 1.25));

    grantRelicToActor(actor, 'might', 2);
    expect(actor.relicMight).toBe(2);
    const dmgLvl2 = calculateAttackDamage(sim, actor);
    expect(dmgLvl2).toBe(Math.round(baseDmg * 1.5));

    grantRelicToActor(actor, 'might', 3);
    expect(actor.relicMight).toBe(3);
    const dmgLvl3 = calculateAttackDamage(sim, actor);
    expect(dmgLvl3).toBe(Math.round(baseDmg * 1.8));

    // 2. vitality: 盘古圣体 (+60 / +120 / +200 HP)
    const baseMaxHp = actor.maxHp;
    grantRelicToActor(actor, 'vitality', 1);
    expect(actor.relicVitality).toBe(1);
    expect(actor.maxHp).toBe(baseMaxHp + 60);
    expect(actor.hp).toBe(actor.maxHp);

    grantRelicToActor(actor, 'vitality', 2);
    expect(actor.relicVitality).toBe(2);
    expect(actor.maxHp).toBe(baseMaxHp + 120);

    grantRelicToActor(actor, 'vitality', 3);
    expect(actor.relicVitality).toBe(3);
    expect(actor.maxHp).toBe(baseMaxHp + 200);

    // 3. haste: 疾风灵羽 (攻速/出招冷却缩减 +20% / +40% / +60%)
    grantRelicToActor(actor, 'haste', 1);
    expect(actor.relicHaste).toBe(1);
    expect(getActorAttackSpeedBonus(actor)).toBeCloseTo(0.20);

    grantRelicToActor(actor, 'haste', 2);
    expect(actor.relicHaste).toBe(2);
    expect(getActorAttackSpeedBonus(actor)).toBeCloseTo(0.35);

    grantRelicToActor(actor, 'haste', 3);
    expect(actor.relicHaste).toBe(3);
    expect(getActorAttackSpeedBonus(actor)).toBeCloseTo(0.50);
  });

  it('宝物等级上限提升至 6 级，且数值阶梯正确生效', () => {
    const sim = createInitialSimulation();
    const actor = sim.actors[0]!;

    // 验证升级到 6 级
    for (let lvl = 1; lvl <= 6; lvl++) {
      grantRelicToActor(actor, 'might', lvl);
      expect(actor.relicMight).toBe(lvl);
    }
    // LV.6 修罗战魂增伤 +200%
    const baseDmg = 10;
    const dmgLvl6 = calculateAttackDamage(sim, actor);
    expect(dmgLvl6).toBe(baseDmg * 3);

    // 验证盘古圣体 LV.6 (+560 HP)
    const baseMaxHp = 100;
    grantRelicToActor(actor, 'vitality', 6);
    expect(actor.relicVitality).toBe(6);
    expect(actor.maxHp).toBe(baseMaxHp + 560);

    // 验证疾风灵羽 LV.6 (冷却缩减 80%)
    grantRelicToActor(actor, 'haste', 6);
    expect(actor.relicHaste).toBe(6);
    expect(getActorAttackSpeedBonus(actor)).toBeCloseTo(0.80);

    // 验证升级三选一逻辑与升级函数最高可升至 6 级
    actor.weaponKnife = 0;
    const knifeOpt = { id: 'weapon_knife' } as any;
    for (let i = 1; i <= 6; i++) {
      applyUpgrade(actor, knifeOpt);
      expect(actor.weaponKnife).toBe(i);
    }
    // 达到 6 级封顶后不再增加
    applyUpgrade(actor, knifeOpt);
    expect(actor.weaponKnife).toBe(6);

    // 三选一为随机抽样，先将其余宝物全部顶到满级，使 weapon_knife 成为唯一候选，
    // 避免随机洗牌漏抽导致断言偶发失败（产品逻辑：未满 6 级即会生成升级项）。
    Object.assign(actor, {
      weaponArrow: 6,
      relicLaser: 6,
      relicCyclone: 6,
      relicBoomerang: 6,
      relicHammer: 6,
      relicSmoke: 6,
      relicHeal: 6,
      relicThunder: 6,
      relicFrost: 6,
      relicShield: 6,
      relicBlackhole: 6,
      relicDrain: 6,
      relicSpikes: 6,
      relicChain: 6,
      relicOrb: 6,
      relicFireRing: 6,
      relicMirror: 6,
    });
    // might / vitality / haste 已在上方经 grantRelicToActor 升至 6 级
    actor.weaponKnife = 5;
    const choices = generateUpgradeChoices(actor);
    const knifeChoice = choices.find((c) => c.id === 'weapon_knife');
    expect(knifeChoice).toBeDefined();
    expect(knifeChoice!.nextValue).toContain('LV.6');
  });

  it('战斗中伤害打击与受击产生 damageHits 飘字事件', () => {
    const sim = createInitialSimulation();
    expect(sim.damageHits).toBeDefined();
    expect(Array.isArray(sim.damageHits)).toBe(true);

    const initialHitCount = sim.damageHits.length;
    // 对首个野怪造成伤害
    const monster = sim.monsters[0]!;
    const hitAmount = 35;
    damageMonster(sim, monster, hitAmount, null);

    expect(sim.damageHits.length).toBeGreaterThan(initialHitCount);
    const lastHit = sim.damageHits[sim.damageHits.length - 1]!;
    expect(lastHit.amount).toBe(hitAmount);
    expect(lastHit.targetType).toBe('monster');
    expect(lastHit.kind).toBe('damage');
    expect(lastHit.x).toBeCloseTo(monster.x);
    expect(lastHit.y).toBeCloseTo(monster.y);
  });
});
