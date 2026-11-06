import { describe, expect, it } from 'vitest';
import {
  aggregateWorldMultipliers,
  calculateEffectiveAttackSpeed,
  calculateEffectiveCrit,
  calculateEffectiveDamage,
  calculateEffectiveMaxHp,
  calculateEffectiveMoveSpeed,
  computeEffectiveMultipliers,
  resolveHitDamage,
  type GlobalRule,
} from '../stats.ts';

describe('统一数值系统（PoE 分层计算与安全边界）测试', () => {
  it('算例 1 (Section 3.3): 基础100，固定加20，卡牌+15%，A选+20%，B选-10% -> 149', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
    ];
    const mults = aggregateWorldMultipliers(rules);
    expect(Number(mults.maxHp.toFixed(2))).toBe(1.08);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    // (100 + 20) * (1 + 0.15) * 1.20 * 0.90 = 120 * 1.15 * 1.08 = 149.04 -> 149
    expect(hp).toBe(149);
  });

  it('算例 2 (Section 3.3): 第3局同场，A再选+10% -> 164', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
      { ownerId: 0, stat: 'maxHp', factor: 1.1, chosenAtRound: 2 },
    ];
    const mults = aggregateWorldMultipliers(rules);
    // 1.2 * 0.9 * 1.1 = 1.188
    expect(Number(mults.maxHp.toFixed(3))).toBe(1.188);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    // 120 * 1.15 * 1.188 = 163.944 -> 164
    expect(hp).toBe(164);
  });

  it('算例 3 (Section 3.3): B 缺席时，B 的 x0.90 规则不参与计算', () => {
    const rules: GlobalRule[] = [
      { ownerId: 0, stat: 'maxHp', factor: 1.2, chosenAtRound: 1 },
      { ownerId: 1, stat: 'maxHp', factor: 0.9, chosenAtRound: 1 },
      { ownerId: 0, stat: 'maxHp', factor: 1.1, chosenAtRound: 2 },
    ];
    // 仅主角 (0) 参赛，B (1) 缺席
    const active = new Set([0]);
    const mults = aggregateWorldMultipliers(rules, active);
    // 1.2 * 1.1 = 1.32
    expect(Number(mults.maxHp.toFixed(2))).toBe(1.32);

    const hp = calculateEffectiveMaxHp(100, 20, 0.15, mults.maxHp);
    // 120 * 1.15 * 1.32 = 182.16 -> 182
    expect(hp).toBe(182);
  });

  it('数值安全边界：MaxHP 限幅在 50 ~ 300 之间', () => {
    expect(calculateEffectiveMaxHp(100, 0, 0, 0.1)).toBe(50);
    expect(calculateEffectiveMaxHp(100, 0, 0, 10.0)).toBe(300);
  });

  it('移动速度：安全上下限与独立减速状态叠加', () => {
    const normal = calculateEffectiveMoveSpeed(3.1, 0, 1.0, false);
    expect(normal).toBe(3.1);

    // 极端高倍率限幅在 3.1 * 1.8 = 5.58
    const maxSpeed = calculateEffectiveMoveSpeed(3.1, 0, 5.0, false);
    expect(maxSpeed).toBe(5.58);

    // 极端低倍率限幅在 3.1 * 0.6 = 1.86
    const minSpeed = calculateEffectiveMoveSpeed(3.1, 0, 0.1, false);
    expect(minSpeed).toBe(1.86);

    // 独立减速 x0.55 在主移速计算后施加
    const slowed = calculateEffectiveMoveSpeed(3.1, 0, 1.0, true);
    expect(slowed).toBe(Number((3.1 * 0.55).toFixed(3)));
  });

  it('攻击速度：倍率作用于频率，有效范围 0.5 ~ 2.5', () => {
    expect(calculateEffectiveAttackSpeed(0, 1.0)).toBe(1.0);
    expect(calculateEffectiveAttackSpeed(0.5, 2.0)).toBe(2.5); // 1.5 * 2 = 3.0 -> clamp 2.5
    expect(calculateEffectiveAttackSpeed(-0.5, 0.5)).toBe(0.5); // 0.5 * 0.5 = 0.25 -> clamp 0.5
  });

  it('暴击率：相对变化，基准 5%，上限 60%，暴击造成 1.5 倍伤害', () => {
    // 相对 +20% -> 5% * 1.2 = 6% (0.06)
    const critA = calculateEffectiveCrit(1.2);
    expect(critA.critChance).toBe(0.06);

    // 上限 60%
    const critMax = calculateEffectiveCrit(100.0);
    expect(critMax.critChance).toBe(0.6);

    // 确定性暴击掷骰
    const hitNonCrit = resolveHitDamage(20, 0.5, 1.5, () => 0.8);
    expect(hitNonCrit.isCrit).toBe(false);
    expect(hitNonCrit.damage).toBe(20);

    const hitCrit = resolveHitDamage(20, 0.5, 1.5, () => 0.2);
    expect(hitCrit.isCrit).toBe(true);
    expect(hitCrit.damage).toBe(30); // 20 * 1.5 = 30
  });

  it('攻击伤害：0.5 ~ 4 倍基础伤害，最少 1', () => {
    expect(calculateEffectiveDamage(10, 0, 1.0)).toBe(10);
    expect(calculateEffectiveDamage(10, 0, 0.2)).toBe(5); // min clamp 0.5 -> 5
    expect(calculateEffectiveDamage(10, 0, 10.0)).toBe(40); // max clamp 4.0 -> 40
  });
});
