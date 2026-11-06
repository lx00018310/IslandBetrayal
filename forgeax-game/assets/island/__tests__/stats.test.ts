import { describe, expect, it } from 'vitest';
import {
  aggregateWorldMultipliers,
  applyRoundOutcome,
  burdenFactor,
  calculateEffectiveAttackSpeed,
  calculateEffectiveCrit,
  calculateEffectiveDamage,
  calculateEffectiveMaxHp,
  calculateEffectiveMoveSpeed,
  computeEffectiveMultipliers,
  createInitialEndlessProfile,
  MAX_LOSS_BURDEN,
  resolveHitDamage,
  survivalDamageMultiplier,
  type GlobalRule,
} from '../stats.ts';

describe('统一数值系统（PoE 分层计算，无成长上限）测试', () => {
  it('算例 1 (Plan 3.3): 基础100，固定加20，卡牌+15%，A选+20%，B选-10% -> 149', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
    ];
    const mults = aggregateWorldMultipliers(rules);
    expect(Number(mults.maxHp.toFixed(2))).toBe(1.08);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    expect(hp).toBe(149);
  });

  it('算例 2: 第3局同场，A再选+10% -> 164', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
      { ownerId: 0, stat: 'maxHp', factor: 1.1, chosenAtRound: 2 },
    ];
    const mults = aggregateWorldMultipliers(rules);
    expect(Number(mults.maxHp.toFixed(3))).toBe(1.188);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    expect(hp).toBe(164);
  });

  it('算例 3: B 缺席时，B 的 x0.90 规则不参与计算', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
      { ownerId: 0, stat: 'maxHp', factor: 1.1, chosenAtRound: 2 },
    ];
    const active = new Set([0]);
    const mults = aggregateWorldMultipliers(rules, active);
    expect(Number(mults.maxHp.toFixed(2))).toBe(1.32);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    expect(hp).toBe(182);
  });

  it('移除人为上限：MaxHP 不再夹到 300，长期累乘真实增长', () => {
    // 旧实现会 clamp 到 300；新实现必须真实增长
    expect(calculateEffectiveMaxHp(100, 0, 0, 10.0)).toBe(1000);
    expect(calculateEffectiveMaxHp(100, 0, 0, 100.0)).toBe(10000);
    // 合法下界：至少 1 HP
    expect(calculateEffectiveMaxHp(100, 0, 0, 0.001)).toBe(1);
  });

  it('移动速度：无上限，真实增长；减速状态独立施加', () => {
    expect(calculateEffectiveMoveSpeed(3.1, 0, 1.0, false)).toBeCloseTo(3.1);

    // 旧实现 clamp 到 5.58；新实现必须真实增长
    expect(calculateEffectiveMoveSpeed(3.1, 0, 5.0, false)).toBeCloseTo(15.5);
    expect(calculateEffectiveMoveSpeed(3.1, 0, 50.0, false)).toBeCloseTo(155);

    // 减速 ×0.55 在最终移速后施加
    expect(calculateEffectiveMoveSpeed(3.1, 0, 1.0, true)).toBeCloseTo(3.1 * 0.55);
    // 合法下界：必须为正（不能出现负移速/零移速）
    expect(calculateEffectiveMoveSpeed(3.1, 0, 0.0001, false)).toBeGreaterThan(0);
  });

  it('攻击频率：无上限，真实增长；周期始终为正', () => {
    expect(calculateEffectiveAttackSpeed(0, 1.0)).toBeCloseTo(1.0);
    // 旧实现 clamp 到 2.5
    expect(calculateEffectiveAttackSpeed(0.5, 2.0)).toBeCloseTo(3.0);
    expect(calculateEffectiveAttackSpeed(4, 10.0)).toBeCloseTo(50.0);
    // 合法下界（正频率）
    expect(calculateEffectiveAttackSpeed(-0.999, 0.0001)).toBeGreaterThan(0);
  });

  it('暴击率：无上限；>100% 分层结算（135% → 必中 1 层 + 35% 概率第 2 层）', () => {
    expect(calculateEffectiveCrit(1.2).critChance).toBeCloseTo(0.06);
    // 旧实现 clamp 到 60%
    expect(calculateEffectiveCrit(100.0).critChance).toBeCloseTo(5.0);

    // 135% 暴击率：guaranteed 1 层；余数 0.35
    const guaranteed = resolveHitDamage(20, 1.35, 1.5, () => 0.9);
    expect(guaranteed.critLayers).toBe(1);
    expect(guaranteed.isCrit).toBe(true);
    expect(guaranteed.damage).toBe(30);

    const double = resolveHitDamage(20, 1.35, 1.5, () => 0.1);
    expect(double.critLayers).toBe(2);
    expect(double.damage).toBe(45); // 20 * 1.5^2

    // 0 暴击率不暴击
    const none = resolveHitDamage(20, 0, 1.5, () => 0.0);
    expect(none.isCrit).toBe(false);
    expect(none.damage).toBe(20);
  });

  it('攻击伤害：无上限；最少 1 点', () => {
    expect(calculateEffectiveDamage(10, 0, 1.0)).toBe(10);
    // 旧实现 clamp 到 0.5 倍 → 5；新实现真实计算 10*0.2 = 2
    expect(calculateEffectiveDamage(10, 0, 0.2)).toBe(2);
    // 旧实现 clamp 到 4 倍 → 40；新实现真实计算 10*10 = 100
    expect(calculateEffectiveDamage(10, 0, 10.0)).toBe(100);
    // 合法下界
    expect(calculateEffectiveDamage(1, 0, 0.001)).toBe(1);
  });

  it('单局死亡增伤：1.2^n（1/2/3/5/9 人）', () => {
    expect(survivalDamageMultiplier(0)).toBe(1);
    expect(survivalDamageMultiplier(1)).toBeCloseTo(1.2, 6);
    expect(survivalDamageMultiplier(2)).toBeCloseTo(1.44, 6);
    expect(survivalDamageMultiplier(3)).toBeCloseTo(1.728, 6);
    expect(survivalDamageMultiplier(5)).toBeCloseTo(2.48832, 6);
    expect(survivalDamageMultiplier(9)).toBeCloseTo(5.15978, 4);
  });

  it('死亡增伤只乘一次：作为独立乘区进入伤害出口', () => {
    const base = calculateEffectiveDamage(10, 0, 1.0, 1.0, 1.0);
    const withDeath = calculateEffectiveDamage(10, 0, 1.0, 1.0, survivalDamageMultiplier(2));
    expect(base).toBe(10);
    expect(withDeath).toBe(14); // round(10 * 1.44)
  });

  it('个人失利乘区：0 层 ×1.00，1 层 ×0.99，20 层 ×0.80', () => {
    expect(burdenFactor(0)).toBeCloseTo(1.0);
    expect(burdenFactor(1)).toBeCloseTo(0.99);
    expect(burdenFactor(2)).toBeCloseTo(0.98);
    expect(burdenFactor(MAX_LOSS_BURDEN)).toBeCloseTo(0.8);
    // 越界被合法夹住（这是用户明确指定的 20 层上限，不是属性成长上限）
    expect(burdenFactor(999)).toBeCloseTo(0.8);
    expect(burdenFactor(-5)).toBeCloseTo(1.0);
  });

  it('失利负担与死亡增伤独立叠加（纯乘法顺序无关，取整只一次）', () => {
    const dmg = calculateEffectiveDamage(
      10,
      0.5,
      2.0,
      burdenFactor(2),
      survivalDamageMultiplier(3),
    );
    // 10 * 1.5 * 2.0 * 0.98 * 1.728 = 50.8032 → 51
    expect(dmg).toBe(51);
  });

  it('胜负负担结算：输 +1、赢 -1、0~20', () => {
    expect(applyRoundOutcome(0, false)).toBe(1);
    expect(applyRoundOutcome(1, false)).toBe(2);
    expect(applyRoundOutcome(2, true)).toBe(1);
    expect(applyRoundOutcome(0, true)).toBe(0);
    expect(applyRoundOutcome(MAX_LOSS_BURDEN, false)).toBe(MAX_LOSS_BURDEN);
  });

  it('非有限数值不会进入战斗（NaN/Infinity 防护）', () => {
    const mults = computeEffectiveMultipliers({
      maxHp: Number.NaN,
      damage: Number.POSITIVE_INFINITY,
      moveSpeed: Number.NEGATIVE_INFINITY,
      attackSpeed: Number.NaN,
      critChance: Number.NaN,
    });
    expect(Number.isFinite(mults.maxHp)).toBe(true);
    expect(Number.isFinite(mults.damage)).toBe(true);
    expect(Number.isFinite(mults.moveSpeed)).toBe(true);
    expect(Number.isFinite(mults.attackSpeed)).toBe(true);
    expect(Number.isFinite(mults.critChance)).toBe(true);

    expect(Number.isFinite(calculateEffectiveMaxHp(100, 0, 0, Number.NaN))).toBe(true);
    expect(Number.isFinite(calculateEffectiveDamage(10, 0, Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('第 1/3/10/30/100 局的累乘数值稳定（不溢出、不 NaN）', () => {
    for (const rounds of [1, 3, 10, 30, 100]) {
      const rules: GlobalRule[] = [];
      for (let i = 0; i < rounds; i++) {
        rules.push({ ownerId: i % 10, stat: 'damage', factor: 1.2, chosenAtRound: i + 1 });
      }
      const mults = aggregateWorldMultipliers(rules);
      expect(Number.isFinite(mults.damage)).toBe(true);
      const dmg = calculateEffectiveDamage(10, 0, mults.damage);
      expect(Number.isFinite(dmg)).toBe(true);
      expect(dmg).toBeGreaterThan(0);
    }
  });

  it('初始 Profile 含 lossBurden = 0', () => {
    const profile = createInitialEndlessProfile(3);
    expect(profile.actorId).toBe(3);
    expect(profile.lossBurden).toBe(0);
    expect(profile.rules).toHaveLength(0);
    expect(profile.carryRelic).toBeNull();
  });
});
