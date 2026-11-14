import { describe, expect, it } from 'vitest';
import {
  activeCovers,
  resolveHostileHit,
  calculateAttackDamage,
  chestOf,
  createInitialSimulation,
  currentSafeRadius,
  damageActor,
  formTeam,
  generateUpgradeChoices,
  giveActorXp,
  isInsideCover,
  segmentBlockedByCover,
  shrinkRadiusMultiplier,
  shrinkStageFor,
  slideMove,
  stepSimulation,
  stepWeapons,
} from '../simulation.ts';
import { survivalDamageMultiplier } from '../stats.ts';

describe('两场 Boss / 死亡增伤 / 逐分钟缩圈与掩体 / 升级队列 / 目标排序', () => {
  // -------------------------------------------------------------------------
  // 2B: 单局死亡增伤 ×1.20^n
  // -------------------------------------------------------------------------
  it('2B: 每淘汰 1 名玩家/AI，幸存者伤害 ×1.20（累乘且每人只计一次）', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0;
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    expect(sim.eliminatedCount).toBe(0);
    expect(survivalDamageMultiplier(sim.eliminatedCount)).toBe(1);

    const dmg0 = calculateAttackDamage(sim, p);
    damageActor(sim, a, 999, null);
    expect(sim.eliminatedCount).toBe(1);
    expect(survivalDamageMultiplier(sim.eliminatedCount)).toBeCloseTo(1.2, 6);
    const dmg1 = calculateAttackDamage(sim, p);
    expect(dmg1).toBeGreaterThan(dmg0);

    damageActor(sim, b, 999, null);
    expect(sim.eliminatedCount).toBe(2);
    expect(survivalDamageMultiplier(sim.eliminatedCount)).toBeCloseTo(1.44, 6);

    // 重复淘汰同一角色不重复计数（eliminate 有 !alive 防线）
    damageActor(sim, b, 999, null);
    expect(sim.eliminatedCount).toBe(2);
  });

  it('2B: 怪物 / Boss 死亡不改变死亡增伤倍率', () => {
    const sim = createInitialSimulation();
    const before = sim.eliminatedCount;
    expect(sim.eliminatedActorIds.size).toBe(0);
    // 怪物池中的死亡与淘汰集合无关
    for (const m of sim.monsters) m.alive = false;
    expect(sim.eliminatedCount).toBe(before);
    expect(survivalDamageMultiplier(sim.eliminatedCount)).toBe(1);
  });

  it('2B: 新局归零（不写入永久 Profile）', () => {
    const sim = createInitialSimulation();
    damageActor(sim, sim.actors[1]!, 999, null);
    expect(sim.eliminatedCount).toBe(1);

    const next = createInitialSimulation();
    expect(next.eliminatedCount).toBe(0);
    expect(next.eliminatedActorIds.size).toBe(0);
    expect(survivalDamageMultiplier(next.eliminatedCount)).toBe(1);
  });

  it('2B: 延迟炸弹在命中瞬间读取最新死亡增伤（且只乘一次）', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0;
    const owner = sim.actors[1]!;
    const victim = sim.actors[2]!;
    owner.x = 10;
    owner.y = 10;
    victim.x = 11;
    victim.y = 10;
    // 选择终局完整伤害，隔离死亡增伤乘区的计算。
    sim.finalPhase = true;
    // 发射时基础伤害快照（不含死亡增伤）
    const base = Math.round(calculateAttackDamage(sim, owner, false) * 1.3);
    sim.bombs.push({
      id: sim.nextEntityId++,
      ownerId: owner.id,
      x: victim.x,
      y: victim.y,
      timer: 0.01,
      radius: 2.0,
      damage: base,
      exploded: false,
      fxTimer: 0.5,
    });
    // 爆炸前先淘汰两人，命中时应读取最新 ×1.44
    damageActor(sim, sim.actors[3]!, 999, null);
    damageActor(sim, sim.actors[4]!, 999, null);
    const hpBefore = victim.hp;
    stepWeapons(sim, 0.02);
    const dealt = hpBefore - victim.hp;
    expect(dealt).toBeGreaterThanOrEqual(Math.round(base * 1.44) - 1);
  });

  it('Boss 在场仍可伤害敌人、队友免伤且共享箱优先承伤', () => {
    const sim = createInitialSimulation({ rng: () => 0.99 });
    sim.elapsed = 130;
    sim.raidPhase = 'fight';
    const attacker = sim.actors[1]!, victim = sim.actors[2]!;
    const before = victim.hp;
    resolveHostileHit(sim, victim, 10, attacker);
    expect(victim.hp).toBe(before - 2);
    attacker.x = 10; attacker.y = 10; victim.x = 11; victim.y = 10;
    formTeam(sim, attacker, victim);
    resolveHostileHit(sim, victim, 10, attacker);
    expect(victim.hp).toBe(before - 2);
  });

  // -------------------------------------------------------------------------
  // 2C: 逐分钟缩圈
  // -------------------------------------------------------------------------
  it('2C: 每满 60s 半径 ×0.85，档位与半径表正确', () => {
    expect(shrinkStageFor(59)).toBe(0);
    expect(shrinkStageFor(60)).toBe(1);
    expect(shrinkStageFor(120)).toBe(2);
    expect(shrinkStageFor(180)).toBe(3);
    expect(shrinkStageFor(240)).toBe(4);
    expect(shrinkStageFor(260)).toBe(5);
    expect(shrinkStageFor(280)).toBe(6);
    expect(shrinkStageFor(300)).toBe(7);

    expect(shrinkRadiusMultiplier(0)).toBeCloseTo(1);
    expect(shrinkRadiusMultiplier(1)).toBeCloseTo(0.85);
    expect(shrinkRadiusMultiplier(2)).toBeCloseTo(0.7225);
    expect(shrinkRadiusMultiplier(3)).toBeCloseTo(0.614125);
    expect(shrinkRadiusMultiplier(4)).toBeCloseTo(0.52200625);
    expect(shrinkRadiusMultiplier(5)).toBeCloseTo(0.44);
    expect(shrinkRadiusMultiplier(6)).toBeCloseTo(0.36);
    expect(shrinkRadiusMultiplier(7)).toBeCloseTo(0.3);
  });

  it('2C: 安全半径跟随档位表，不会被旧 shrink 规则二次收缩', () => {
    const sim = createInitialSimulation();
    sim.shrinkStage = 0;
    sim.shrinkTransition = 5.0;
    expect(currentSafeRadius(sim)).toBeCloseTo(0.98);

    sim.shrinkStage = 2;
    sim.shrinkTransition = 5.0;
    expect(currentSafeRadius(sim)).toBeCloseTo(0.98 * 0.7225);
  });

  // -------------------------------------------------------------------------
  // 2C-2: 中央掩体
  // -------------------------------------------------------------------------
  it('2C-2: 掩体阻挡移动与直线视线，并可绕行', () => {
    const sim = createInitialSimulation();
    const covers = activeCovers(sim);
    expect(covers.length).toBeGreaterThanOrEqual(2);

    const c = covers[0]!;
    expect(isInsideCover(sim, c.x, c.y)).toBe(true);
    expect(isInsideCover(sim, c.x + c.radius + 0.5, c.y)).toBe(false);

    expect(segmentBlockedByCover(sim, c.x - 3, c.y, c.x + 3, c.y)).toBe(true);
    expect(segmentBlockedByCover(sim, c.x + 3, c.y + 3, c.x + 6, c.y + 3)).toBe(false);

    // 滑墙：正对掩体移动被挡住，落点仍合法
    const from = { x: c.x - c.radius - 0.6, y: c.y };
    const slid = slideMove(sim, from.x, from.y, 1.0, 0.4);
    expect(isInsideCover(sim, slid.x, slid.y)).toBe(false);
  });

  it('2C-2: 普攻不能隔岩命中（视线遮挡）', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0;
    const c = activeCovers(sim)[0]!;
    const p = sim.actors[0]!;
    const enemy = sim.actors[1]!;
    p.x = c.x - c.radius - 0.4;
    p.y = c.y;
    enemy.x = c.x + c.radius + 0.4;
    enemy.y = c.y;
    p.team = -1;
    enemy.team = -1;
    p.attackCd = 0;
    enemy.attackCd = 999;
    sim.elapsed = 100;
    const hpBefore = enemy.hp;
    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0 });
    expect(enemy.hp).toBe(hpBefore);
  });

  // -------------------------------------------------------------------------
  // E2: XP 升级队列
  // -------------------------------------------------------------------------
  it('E2: 同一帧连续升级排队展示，不覆盖未选卡片', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    giveActorXp(sim, p, 5 + 7);
    expect(p.level).toBeGreaterThanOrEqual(3);
    expect(sim.pendingUpgradeCount).toBeGreaterThanOrEqual(2);
    expect(sim.pendingUpgrade).toBe(true);

    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0, upgradeChoiceIndex: 0 });
    expect(sim.pendingUpgrade).toBe(true);
    expect(sim.upgradeChoices).toHaveLength(3);

    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0, upgradeChoiceIndex: 1 });
    expect(sim.pendingUpgrade).toBe(false);
    expect(sim.pendingUpgradeCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // R03: 目标价值排序
  // -------------------------------------------------------------------------
  it('R03: 敌队共享宝箱优先于更近的普通怪物', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    p.x = 10;
    p.y = 10;
    a.x = 10.8;
    a.y = 10;
    b.x = 10.8;
    b.y = 10.4;
    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.hp = 30;
    chest.treasure = 5;
    const m = sim.monsters[0]!;
    Object.assign(m, { x: 9.5, y: 10, hp: 999, maxHp: 999, alive: true });
    p.attackCd = 0;
    // 冻结其他角色攻击，隔离玩家目标选择
    for (let i = 1; i < 10; i++) sim.actors[i]!.attackCd = 999;
    p.attackCd = 0;
    sim.elapsed = 100;
    const chestBefore = chest.hp;
    const monsterBefore = m.hp;
    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0 });
    expect(chest.hp).toBeLessThan(chestBefore);
    expect(m.hp).toBe(monsterBefore);
  });

  // -------------------------------------------------------------------------
  // R04: 结算当帧冻结
  // -------------------------------------------------------------------------
  it('R04: 结局当帧冻结胜者 HP/名次/宝物', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    for (let i = 2; i < 10; i++) sim.actors[i]!.alive = false;
    damageActor(sim, sim.actors[1]!, 999, p);
    expect(sim.gameOver).toBe(true);
    const winnerHp = p.hp;
    const winnerRank = p.rank;
    const winnerTreasure = p.treasure;
    sim.elapsed = 360.1;
    stepSimulation(sim, 1.0, { moveX: 1, moveY: 1, teamAction: true });
    expect(p.hp).toBe(winnerHp);
    expect(p.rank).toBe(winnerRank);
    expect(p.treasure).toBe(winnerTreasure);
  });

  // -------------------------------------------------------------------------
  // 死亡立结机制测试
  // -------------------------------------------------------------------------
  it('玩家阵亡时立即结算结束游戏，不再等待其余存活 AI', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    expect(p.isPlayer).toBe(true);
    expect(sim.gameOver).toBe(false);

    // 此时全场 9 个 AI 均存活
    damageActor(sim, p, 9999, null);
    expect(p.alive).toBe(false);
    expect(sim.gameOver).toBe(true);
    expect(sim.winner).toBe(null);
  });

  // -------------------------------------------------------------------------
  // 创意宝物技能体系（激光、旋风、回旋镖、战锤、尾流毒雾）
  // -------------------------------------------------------------------------
  it('新创意宝物体系：激光、旋风、回旋镖、战锤、毒雾正确触发物理与战斗判定', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const idleInput = { moveX: 0, moveY: 0 };

    // 1. 装备星芒激光
    p.relicLaser = 1;
    p.laserTimer = 0;
    stepSimulation(sim, 0.1, idleInput);
    expect(sim.lasers.length).toBeGreaterThanOrEqual(8);

    // 2. 装备风暴海螺
    p.relicCyclone = 1;
    p.cycloneTimer = 0;
    stepSimulation(sim, 0.1, idleInput);
    expect(sim.cyclones.length).toBeGreaterThanOrEqual(1);

    // 3. 装备灵风骨刃
    p.relicBoomerang = 1;
    p.boomerangTimer = 0;
    stepSimulation(sim, 0.1, idleInput);
    expect(sim.boomerangs.length).toBeGreaterThanOrEqual(1);

    // 4. 装备巨灵战锤
    p.relicHammer = 1;
    p.hammerTimer = 0;
    stepSimulation(sim, 0.1, idleInput);
    expect(sim.hammers.length).toBeGreaterThanOrEqual(1);

    // 5. 装备遁影烟斗并移动
    p.relicSmoke = 1;
    p.smokeTimer = 0;
    p.vx = 2.0;
    p.vy = 0;
    stepSimulation(sim, 0.1, { moveX: 1, moveY: 0 });
    expect(sim.smokes.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 新机制：组队 20% 减伤 与 未受击缓慢回血及宝物强化
  // -------------------------------------------------------------------------
  it('组队机制：只要产生组队，受到的伤害减免 20%', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;

    // 未组队状态：承受 10 点伤害
    a.hp = 100;
    damageActor(sim, a, 10, null);
    expect(a.hp).toBe(90);

    // 组队状态：承受 10 点伤害，减免 20%（实受 8 点）
    a.x = 16; a.y = 16;
    b.x = 16.5; b.y = 16;
    formTeam(sim, a, b);
    expect(a.team >= 0).toBe(true);

    a.hp = 100;
    damageActor(sim, a, 10, null);
    expect(a.hp).toBe(92); // 100 - 8 = 92
  });

  it('回血机制：未受击时缓慢回血，宝物加速回血且高阶支持战时自愈', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const idleInput = { moveX: 0, moveY: 0 };

    p.hp = 50;
    p.lastHitTimer = 2.0; // 受击硬直中
    stepSimulation(sim, 1.0, idleInput);
    expect(p.hp).toBe(50); // 冷却中不回血
    expect(p.lastHitTimer).toBeCloseTo(1.0, 5);

    // 冷静期结束（步进 1.2s，其中 1.0s 冷却，0.2s 处于未受击回血阶段）
    stepSimulation(sim, 1.2, idleInput);
    expect(p.hp).toBeGreaterThan(50); // 开始缓慢自愈

    // 装备 LV.3 生命宝珠：即使受击（lastHitTimer = 3.0），也能战时恒定自愈
    p.hp = 50;
    p.relicHeal = 3;
    p.lastHitTimer = 3.0;
    stepSimulation(sim, 1.0, idleInput);
    expect(p.hp).toBeCloseTo(53.0, 1); // 战时自愈 3.0 HP/s
  });

  // -------------------------------------------------------------------------
  // 新机制：纯宝物升级体系 / 浅水区持续扣血 / 护盾格挡与吸血
  // -------------------------------------------------------------------------
  it('纯宝物升级：升级池 100% 全部为宝物选项，绝不产生额外属性卡', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    // 连续多次生成卡池验证
    for (let i = 0; i < 20; i++) {
      const choices = generateUpgradeChoices(p);
      expect(choices.length).toBeGreaterThanOrEqual(1);
      for (const choice of choices) {
        expect(choice.type).toBe('weapon');
        expect(choice.id.startsWith('stat_')).toBe(false);
      }
    }
  });

  it('浅水区机制：角色进入水域持续受侵蚀扣血与减速，生命耗尽时才淘汰', () => {
    const sim = createInitialSimulation();
    sim.elapsed = 30; // 跳过开局无敌保护期
    const p = sim.actors[0]!;
    // 将玩家放置在水域深水网格 (1, 1)，静止不移动
    p.x = 1.0; p.y = 1.0; p.hp = 100; p.alive = true;
    stepSimulation(sim, 1.0, { moveX: 0, moveY: 0 });
    // 未死，但受到持续扣血（每秒扣 10 点）与水流减速
    expect(p.alive).toBe(true);
    expect(p.hp).toBeLessThanOrEqual(90.1);
    expect(p.slow).toBeGreaterThan(0);

    // 将生命降至濒死，在浅水区持续受侵蚀致死淘汰
    p.hp = 4.0;
    p.x = 1.0; p.y = 1.0;
    stepSimulation(sim, 1.0, { moveX: 0, moveY: 0 });
    expect(p.alive).toBe(false);
    expect(p.hp).toBe(0);
  });

  it('金刚玄甲护盾：完全抵挡下一次攻击伤害并震退攻击者', () => {
    const sim = createInitialSimulation();
    const target = sim.actors[1]!;
    const attacker = sim.actors[2]!;
    target.x = 20; target.y = 20; target.hp = 100;
    attacker.x = 21; attacker.y = 20;

    target.relicShield = 1;
    target.shieldHp = 1;

    // 攻击者造成 30 点重创
    damageActor(sim, target, 30, attacker);
    // 护盾抵挡，无伤
    expect(target.hp).toBe(100);
    expect(target.shieldHp).toBe(0);
    // 攻击者被震退
    expect(attacker.x).toBeGreaterThan(21.0);
  });

  it('噬血魔翼：攻击敌人将伤害转化为自身生命值回复', () => {
    const sim = createInitialSimulation();
    const attacker = sim.actors[1]!;
    const target = sim.actors[2]!;
    attacker.hp = 50;
    attacker.relicDrain = 2; // 吸血 35%
    target.hp = 100;

    damageActor(sim, target, 40, attacker);
    expect(attacker.hp).toBeGreaterThan(50);
  });
});
