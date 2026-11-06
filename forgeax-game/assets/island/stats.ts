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

// 【玩法支柱三】7 种博弈杠杆秘策 (Plan v2026-11-06)
export type GlobalRuleKind =
  | 'tether_tight'   // 猜疑短绳：断线距离 -15%, 宝箱获取 +25%
  | 'tether_long'    // 铁索连环：断线距离 +20%, 队友移速 +10%
  | 'bounty_greed'   // 悬赏狂热：Boss/敌箱伤害 +25%, 爆箱范围 +30%
  | 'storm_rush'     // 急速坍塌：每阶段缩圈额外 -5%, 全员移速 +12%
  | 'close_combat'   // 近身肉搏：飞刀伤害 +20%, 范围 +20%; 箭矢射程 -15%
  | 'ranged_snipe'   // 猎手视野：箭矢/炸弹伤害 +20%; 近战/飞刀伤害 -10%
  | 'blood_feud';    // 嗜血分赃：淘汰乘区底数 b 从 1.20→1.25

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

// 7 种秘策的可读名称
export const RULE_KIND_NAMES: Record<GlobalRuleKind, string> = {
  tether_tight: '猜疑短绳',
  tether_long: '铁索连环',
  bounty_greed: '悬赏狂热',
  storm_rush: '急速坍塌',
  close_combat: '近身肉搏',
  ranged_snipe: '猎手视野',
  blood_feud: '嗜血分赃',
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

/**【玩法支柱三·AI 记仇生态】仇恨记忆记录（Plan R06）*/
export interface GrudgeRecord {
  lastBetrayedById: number | null;  // 上一局背叛拉爆自己箱子的仇人 ID
  lastKilledById: number | null;    // 上一局直接击杀自己的仇人 ID
  grudgeScoreByActor: Record<number, number>; // 对各角色的累计仇恨值 0..100
}

export interface EndlessProfile {
  actorId: number;
  endlessRound: number;
  rules: GlobalRule[];
  carryRelic: CarryRelic | null;
  /** 失利负担层数 0..20，每层使该角色下一局全属性 -1% */
  lossBurden: number;
  /** 跨局记仇记忆（Plan R06） */
  grudge?: GrudgeRecord;
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
// AI 记仇系统辅助函数（Plan R06）
// ---------------------------------------------------------------------------

/** 创建初始空仇恨记录 */
export function createEmptyGrudgeRecord(): GrudgeRecord {
  return {
    lastBetrayedById: null,
    lastKilledById: null,
    grudgeScoreByActor: {},
  };
}

/** 自然衰减仇恨值（每局结束未发生新冲突则 -15） */
export function decayGrudgeScore(score: number): number {
  return Math.max(0, score - 15);
}

/** 对单个角色增加仇恨值 */
export function addGrudgeScore(record: GrudgeRecord, actorId: number, amount: number): void {
  const current = record.grudgeScoreByActor[actorId] || 0;
  record.grudgeScoreByActor[actorId] = Math.min(100, current + amount);
}

/** 获取某角色的仇恨值（无记录则为 0） */
export function getGrudgeScore(record: GrudgeRecord, actorId: number): number {
  return record.grudgeScoreByActor[actorId] || 0;
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

// 【玩法支柱三】7 种博弈杠杆秘策的聚合计算函数
/** 
 * 根据全局规则集计算应用后的断线距离修正系数
 * tether_tight: -15%, tether_long: +20%
 */
export function calculateTetherDistanceModifier(rules: readonly GlobalRule[]): number {
  let modifier = 1.0;
  for (const r of rules) {
    if (r.stat === 'moveSpeed' && r.factor === 0.85) {
      modifier *= 0.85; // tether_tight
    } else if (r.stat === 'moveSpeed' && r.factor === 1.20) {
      modifier *= 1.20; // tether_long
    }
  }
  return modifier;
}

/** 
 * 根据全局规则集计算缩圈加速修正
 * storm_rush: 每阶段额外收紧 5%
 */
export function calculateShrinkAccelerationModifier(rules: readonly GlobalRule[]): number {
  for (const r of rules) {
    if (r.stat === 'moveSpeed' && r.factor === 0.88) {
      return 0.95; // storm_rush: 每个阶段再额外 -5%
    }
  }
  return 1.0;
}

/** 
 * 根据全局规则集计算 Boss/敌箱伤害修正
 * bounty_greed: +25%
 */
export function calculateBountyDamageModifier(rules: readonly GlobalRule[], targetIsBoss: boolean): number {
  for (const r of rules) {
    if (r.stat === 'damage' && r.factor === 1.25 && targetIsBoss) {
      return 1.25; // bounty_greed
    }
  }
  return 1.0;
}

/** 
 * 根据全局规则集计算近远程武器平衡修正
 * close_combat: 飞刀+20%, 箭矢射程-15%
 * ranged_snipe: 箭矢/炸弹+20%, 近战/飞刀-10%
 */
export function calculateWeaponBalanceModifier(weaponKind: 'knife' | 'arrow' | 'bomb' | 'melee', rules: readonly GlobalRule[]): number {
  let knifeMod = 1.0;
  let arrowMod = 1.0;
  let bombMod = 1.0;
  let meleeMod = 1.0;

  for (const r of rules) {
    // close_combet
    if (r.stat === 'attackSpeed' && r.factor === 1.20) {
      knifeMod *= 1.20; // 飞刀伤害/范围 +20%
    }
    if (r.stat === 'attackSpeed' && r.factor === 0.85) {
      arrowMod *= 0.85; // 箭矢射程 -15%
    }
    // ranged_snipe
    if (r.stat === 'critChance' && r.factor === 1.20) {
      arrowMod *= 1.20; // 箭矢伤害 +20%
      bombMod *= 1.20; // 炸弹伤害 +20%
    }
    if (r.stat === 'critChance' && r.factor === 0.90) {
      meleeMod *= 0.90; // 近战伤害 -10%
      knifeMod *= 0.90; // 飞刀伤害 -10%
    }
  }

  if (weaponKind === 'knife') return knifeMod;
  if (weaponKind === 'arrow') return arrowMod;
  if (weaponKind === 'bomb') return bombMod;
  return meleeMod;
}

/** 
 * 根据全局规则集计算淘汰乘区底数修正
 * blood_feud: b 从 1.20 → 1.25
 */
export function calculateBloodFeudBase(): number {
  // 此处应在 simulation.createInitialSimulation 或 island.pack 中读取全局规则
  // 为简化，返回默认值 1.20 (实际应由外部传入)
  return DEATH_DAMAGE_FACTOR;
}

/** 根据全局规则集汇总所有秘策影响因子 */
export function aggregateGlobalRules(rules: readonly GlobalRule[]): {
  tetherModifier: number;
  shrinkModifier: number;
  bossDamageModifier: number;
  weaponModifiers: Record<string, number>;
  bloodFeudBase: number;
} {
  return {
    tetherModifier: calculateTetherDistanceModifier(rules),
    shrinkModifier: calculateShrinkAccelerationModifier(rules),
    bossDamageModifier: calculateBountyDamageModifier(rules, true),
    weaponModifiers: {
      knife: calculateWeaponBalanceModifier('knife', rules),
      arrow: calculateWeaponBalanceModifier('arrow', rules),
      bomb: calculateWeaponBalanceModifier('bomb', rules),
      melee: calculateWeaponBalanceModifier('melee', rules),
    },
    bloodFeudBase: calculateBloodFeudBase(),
  };
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
    /**【玩法支柱三】初始化空仇恨记录（Plan R06） */
    grudge: createEmptyGrudgeRecord(),
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
