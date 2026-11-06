// 《荒岛分赃》统一数值系统（借鉴 PoE 计算分层）
// 纯函数模块，无外部依赖。
// 计算顺序（唯一权威）：
//   基础有效值 = (基础值 + 固定加减之和)
//              × (1 + 当局同类加减百分比之和)
//              × ∏(本局所有出场角色已生效的历史世界修正)
//              × ∏(独立状态倍率)
//   无限模式角色最终值 = 基础有效值 × (1 - 失利负担层数 / 100)
//   单局幸存者最终攻击伤害 = 上述伤害值 × (1.20 ** 本局已淘汰角色数)
//
// 重要：本版按 Plan 移除全部**人为成长上限**（HP/伤害/移速/攻速/暴击/范围）。
// 仅保留数学与物理合法性下界（HP 不为负、伤害最少 1、攻击周期必须为正），
// 不再以 clamp 伪装成长上限。

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

/** 单局死亡增伤：每淘汰 1 名参赛角色，幸存者伤害 ×1.20（本局独立乘区） */
export const DEATH_DAMAGE_FACTOR = 1.2;

/** 无限模式失利负担上限（用户明确指定，属于独立规则而非属性成长上限） */
export const MAX_LOSS_BURDEN = 20;

export interface GlobalRule {
  ownerId: number;
  stat: StatTarget;
  factor: StatFactor;
  chosenAtRound: number;
}

/** 宝物词条（首版每件宝物最多 1 条固定数值词条） */
export type RelicAffix = 'knifeArea' | 'arrowPierce' | 'bombRadius';

export interface CarryRelic {
  kind: 'knife' | 'arrow' | 'bomb';
  level: number; // 1..3
  affix?: RelicAffix;
}

export interface EndlessProfile {
  actorId: number;
  endlessRound: number;
  rules: GlobalRule[];
  carryRelic: CarryRelic | null;
  /** 失利负担层数 0..20，每层使该角色下一局全属性 -1% */
  lossBurden: number;
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
  /** 溢出暴击层数（>100% 暴击率时每满 100% 多一层） */
  critLayers: number;
}

// ---------------------------------------------------------------------------
// 合法性守卫（不是成长上限，只阻止 NaN / Infinity / 负值）
// ---------------------------------------------------------------------------

/** 把非有限数值回退到 fallback，避免 NaN/Infinity 进入战斗 */
export function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** 合法物理下界：移动/攻速必须为正（不是上限） */
export const MIN_LEGAL_RATE = 0.01;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// 聚合与有效乘数
// ---------------------------------------------------------------------------

/** 聚合所有活跃角色贡献的历史全场乘数（独立乘区累乘，顺序无关） */
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
    const cur = result[r.stat];
    const next = finiteOr(cur * r.factor, cur);
    result[r.stat] = next;
  }

  return result;
}

/**
 * 计算有效世界乘数。
 * 按 Plan：**不做人为上限**，仅把非有限值（NaN/Infinity）回退到 1，
 * 并保证乘数为正（负倍率由规则池本身排除，这里只做合法性兜底）。
 */
export function computeEffectiveMultipliers(raw: WorldMultipliers): EffectiveMultipliers {
  return {
    maxHp: Math.max(MIN_LEGAL_RATE, finiteOr(raw.maxHp, 1)),
    damage: Math.max(MIN_LEGAL_RATE, finiteOr(raw.damage, 1)),
    moveSpeed: Math.max(MIN_LEGAL_RATE, finiteOr(raw.moveSpeed, 1)),
    attackSpeed: Math.max(MIN_LEGAL_RATE, finiteOr(raw.attackSpeed, 1)),
    critChance: Math.max(0, finiteOr(raw.critChance, 1)),
  };
}

// ---------------------------------------------------------------------------
// 独立乘区
// ---------------------------------------------------------------------------

/** 无限模式个人失利负担乘区：1 - layers/100（layers 0..20 → ×1.00..×0.80） */
export function burdenFactor(layers: number): number {
  const l = clamp(Math.round(finiteOr(layers, 0)), 0, MAX_LOSS_BURDEN);
  return 1 - l / 100;
}

/** 单局死亡增伤乘区：1.20 ** 已淘汰角色数 */
export function survivalDamageMultiplier(eliminatedCount: number): number {
  const n = Math.max(0, Math.round(finiteOr(eliminatedCount, 0)));
  if (n === 0) return 1;
  return Math.pow(DEATH_DAMAGE_FACTOR, n);
}

// ---------------------------------------------------------------------------
// 各属性有效值（无成长上限）
// ---------------------------------------------------------------------------

/** 1. 最大生命值：无上限；仅保证 >= 1（数学合法） */
export function calculateEffectiveMaxHp(
  baseHp = 100,
  flatAdd = 0,
  increasedPct = 0,
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
): number {
  const raw =
    (baseHp + flatAdd) *
    (1 + finiteOr(increasedPct, 0)) *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  return Math.max(1, Math.round(finiteOr(raw, 1)));
}

/** 2. 移动速度：基准 3.1，无上限；减速状态 ×0.55 在最终速度后独立施加 */
export function calculateEffectiveMoveSpeed(
  baseSpeed = 3.1,
  speedBonus = 0,
  worldMultiplier = 1.0,
  isSlowed = false,
  personalMultiplier = 1.0,
): number {
  const unclamped =
    baseSpeed *
    (1 + finiteOr(speedBonus, 0)) *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  const safe = Math.max(MIN_LEGAL_RATE, finiteOr(unclamped, baseSpeed));
  const statusMultiplier = isSlowed ? 0.55 : 1.0;
  return safe * statusMultiplier;
}

/** 3. 攻击频率倍率：无上限；仅保证为正（攻击周期必须 > 0） */
export function calculateEffectiveAttackSpeed(
  attackSpeedBonus = 0,
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
): number {
  const raw =
    (1 + finiteOr(attackSpeedBonus, 0)) *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  return Math.max(MIN_LEGAL_RATE, finiteOr(raw, 1));
}

/** 4. 暴击率：基准 5%，相对倍率；**无上限**，>100% 由 resolveHitDamage 分层结算 */
export function calculateEffectiveCrit(
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
): { critChance: number; critMultiplier: number } {
  const chance =
    0.05 *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  return {
    critChance: Math.max(0, finiteOr(chance, 0)),
    critMultiplier: 1.5,
  };
}

/** 5. 攻击基础伤害：无上限；最少 1 点（数学合法） */
export function calculateEffectiveDamage(
  baseWithFlat: number,
  damageBonus = 0,
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
  deathMultiplier = 1.0,
): number {
  const raw =
    baseWithFlat *
    (1 + finiteOr(damageBonus, 0)) *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1)) *
    Math.max(0, finiteOr(deathMultiplier, 1));
  return Math.max(1, Math.round(finiteOr(raw, 1)));
}

/**
 * 6. 单次命中伤害与暴击判定。
 * 暴击率 > 100% 的约定：每满 100% 必定多一层暴击，余数概率再触发一层。
 * 例：135% → 必定 1 层，35% 概率第 2 层。每层 ×critMultiplier。
 */
export function resolveHitDamage(
  damage: number,
  critChance: number,
  critMultiplier = 1.5,
  rng: () => number = Math.random,
): HitResult {
  const chance = Math.max(0, finiteOr(critChance, 0));
  const guaranteedLayers = Math.floor(chance);
  const remainder = chance - guaranteedLayers;
  const extraLayer = remainder > 0 && rng() < remainder ? 1 : 0;
  const critLayers = guaranteedLayers + extraLayer;
  const isCrit = critLayers > 0;
  const mult = Math.pow(critMultiplier, Math.max(0, critLayers));
  const finalDamage = Math.max(1, Math.round(finiteOr(damage * mult, damage)));
  return { damage: finalDamage, isCrit, critLayers };
}

/** 创建初始无限模式角色 Profile */
export function createInitialEndlessProfile(actorId: number): EndlessProfile {
  return {
    actorId,
    endlessRound: 1,
    rules: [],
    carryRelic: null,
    lossBurden: 0,
  };
}

/** 胜利减一层、失败加一层（0..20） */
export function applyRoundOutcome(layers: number, won: boolean): number {
  const cur = clamp(Math.round(finiteOr(layers, 0)), 0, MAX_LOSS_BURDEN);
  return won ? Math.max(0, cur - 1) : Math.min(MAX_LOSS_BURDEN, cur + 1);
}

/** 宝物词条的可读说明（首版每件最多 1 条） */
export const RELIC_AFFIX_TEXT: Record<RelicAffix, string> = {
  knifeArea: '飞刀范围 +10%',
  arrowPierce: '箭矢穿透 +1',
  bombRadius: '炸弹半径 +10%',
};
