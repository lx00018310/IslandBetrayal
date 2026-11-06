import { describe, expect, it } from 'vitest';
import {
  activeCovers,
  calculateAttackDamage,
  chestOf,
  createInitialSimulation,
  currentSafeRadius,
  damageActor,
  formTeam,
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
    // 角色直接伤害只在最终混战生效（终局前为掠夺宝箱主题）
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

  it('2B: 终局前不直接扣角色 HP（主题为掠夺宝箱，保证能撑到两场团战）', () => {
    const sim = createInitialSimulation();
    sim.monsters.length = 0;
    const attacker = sim.actors[1]!;
    const victim = sim.actors[2]!;
    attacker.x = 10;
    attacker.y = 10;
    victim.x = 10.8;
    victim.y = 10;
    attacker.team = -1;
    victim.team = -1;
    attacker.attackCd = 0;
    victim.attackCd = 999;
    sim.elapsed = 100;
    const hpBefore = victim.hp;
    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0 });
    expect(victim.hp).toBe(hpBefore);

    // 终局混战恢复完整角色伤害
    sim.finalPhase = true;
    attacker.attackCd = 0;
    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0 });
    expect(victim.hp).toBeLessThan(hpBefore);
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
});
