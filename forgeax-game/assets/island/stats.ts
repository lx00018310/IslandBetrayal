// 《荒岛分赃》统一数值系统（借鉴 PoE 计算分层）
// 纯函数模块，无外部依赖
// 计算顺序：最终属性 = 限幅并按属性取整(
//   (基础值 + 固定加减值之和)
//   × (1 + 本局同类百分比加减值之和)
//   × ∏(所有当前参赛者历史全场乘数)
//   × ∏(该属性明确允许的独立状态乘数)
// )

export type StatTarget = 'maxHp' | 'damage' | 'moveSpeed' | 'attackSpeed' | 'critChance';
export type StatFactor = 0.8 | 0.9 | 1.1 | 1.2;

export const STAT_TARGETS: readonly StatTarget[] = [
  'maxHp',
  'damage',
  'moveSpeed',
  'attackSpeed',
  'critChance',
] as const;

export const STAT_FACTORS: readonly StatFactor[] = [1.2, 1.1, 0.9, 0.8] as const;

export const STAT_NAMES: Record<StatTarget, string> = {
  maxHp: '最大血量',
  damage: '攻击伤害',
  moveSpeed: '移动速度',
  attackSpeed: '攻击频率',
  critChance: '暴击概率',
};

export interface GlobalRule {
  ownerId: number;
  stat: StatTarget;
  factor: StatFactor;
  chosenAtRound: number;
}

export interface CarryRelic {
  kind: 'knife' | 'arrow' | 'bomb';
  level: number; // 1..3
}

export interface EndlessProfile {
  actorId: number;
  endlessRound: number;
  rules: GlobalRule[];
  carryRelic: CarryRelic | null;
}

export interface WorldMultipliers {
  maxHp: number;
  damage: number;
  moveSpeed: number;
  attackSpeed: number;
  critChance: number;
}

export interface EffectiveMultipliers {
  maxHp: number;
  damage: number;
  moveSpeed: number;
  attackSpeed: number;
  critChance: number;
}

export interface HitResult {
  damage: number;
  isCrit: boolean;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 聚合所有活跃角色贡献的历史全场乘数（独立乘区累乘） */
export function aggregateWorldMultipliers(
  rules: readonly GlobalRule[],
  activeActorIds?: ReadonlySet<number>,
): WorldMultipliers {
  const result: WorldMultipliers = {
    maxHp: 1.0,
    damage: 1.0,
    moveSpeed: 1.0,
    attackSpeed: 1.0,
    critChance: 1.0,
  };

  for (const r of rules) {
    if (activeActorIds && !activeActorIds.has(r.ownerId)) {
      continue;
    }
    result[r.stat] *= r.factor;
  }

  return result;
}

/** 计算有效世界乘数（带安全上下限） */
export function computeEffectiveMultipliers(raw: WorldMultipliers): EffectiveMultipliers {
  return {
    maxHp: clamp(raw.maxHp, 0.5, 3.0),
    damage: clamp(raw.damage, 0.5, 4.0),
    moveSpeed: clamp(raw.moveSpeed, 0.6, 1.8),
    attackSpeed: clamp(raw.attackSpeed, 0.5, 2.5),
    critChance: clamp(raw.critChance, 0.0, 12.0), // 0.05 * 12 = 0.60
  };
}

/** 1. 最大生命值计算：50 ~ 300 HP */
export function calculateEffectiveMaxHp(
  baseHp = 100,
  flatAdd = 0,
  increasedPct = 0,
  worldMultiplier = 1.0,
): number {
  const raw = (baseHp + flatAdd) * (1 + increasedPct) * worldMultiplier;
  return clamp(Math.round(raw), 50, 300);
}

/** 2. 移动速度计算：基准 3.1，范围 [3.1 * 0.6, 3.1 * 1.8] = [1.86, 5.58]，拾取/负重减速 ×0.55 在主移速后独立应用 */
export function calculateEffectiveMoveSpeed(
  baseSpeed = 3.1,
  speedBonus = 0,
  worldMultiplier = 1.0,
  isSlowed = false,
): number {
  const unclamped = baseSpeed * (1 + speedBonus) * worldMultiplier;
  const clamped = clamp(unclamped, baseSpeed * 0.6, baseSpeed * 1.8);
  const statusMultiplier = isSlowed ? 0.55 : 1.0;
  return Number((clamped * statusMultiplier).toFixed(3));
}

/** 3. 攻击频率计算：基准 1.0，有效范围 0.5 ~ 2.5 倍频率 */
export function calculateEffectiveAttackSpeed(
  attackSpeedBonus = 0,
  worldMultiplier = 1.0,
): number {
  const raw = (1 + attackSpeedBonus) * worldMultiplier;
  return clamp(Number(raw.toFixed(3)), 0.5, 2.5);
}

/** 4. 暴击率与暴击倍率：基准 5% (0.05)，相对变化，上限 60%，默认暴伤 ×1.5 */
export function calculateEffectiveCrit(worldMultiplier = 1.0): {
  critChance: number;
  critMultiplier: number;
} {
  const chance = clamp(0.05 * worldMultiplier, 0.0, 0.6);
  return {
    critChance: Number(chance.toFixed(4)),
    critMultiplier: 1.5,
  };
}

/** 5. 攻击基础伤害计算：0.5 ~ 4 倍基础伤害，最少 1 */
export function calculateEffectiveDamage(
  baseWithFlat: number,
  damageBonus = 0,
  worldMultiplier = 1.0,
): number {
  const multiplier = clamp((1 + damageBonus) * worldMultiplier, 0.5, 4.0);
  const raw = baseWithFlat * multiplier;
  return Math.max(1, Math.round(raw));
}

/** 6. 单次命中伤害与暴击判定 */
export function resolveHitDamage(
  damage: number,
  critChance: number,
  critMultiplier = 1.5,
  rng: () => number = Math.random,
): HitResult {
  const isCrit = critChance > 0 && rng() < critChance;
  const finalDamage = isCrit
    ? Math.max(1, Math.round(damage * critMultiplier))
    : Math.max(1, Math.round(damage));
  return { damage: finalDamage, isCrit };
}

/** 创建初始无限模式角色 Profile */
export function createInitialEndlessProfile(actorId: number): EndlessProfile {
  return {
    actorId,
    endlessRound: 1,
    rules: [],
    carryRelic: null,
  };
}
