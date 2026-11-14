// 《荒岛分赃》统一数值系统（借鉴 PoE 计算分层）
// 纯函数模块，无外部依赖。
// 计算顺序（唯一权威）：
//   基础有效值 = (基础值 + 固定加减之和)
//              × (1 + 当局同类加减百分比之和)
//              × ∏(本局所有出场角色已生效的历史世界修正)
//              × ∏(独立状态倍率)
//   失败不再带入负担；最终属性在各自出口限幅。
//   单局幸存者最终攻击伤害 = 上述伤害值 × (1.20 ** 本局已淘汰角色数)
//
// 属性上限：HP 300、基础伤害 4 倍、移速 1.8 倍、攻速 2.5 倍、暴击 60%。

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

/** 旧 v1 档案兼容常量；不再参与玩法计算 */
export const MAX_LOSS_BURDEN = 20;

export interface LegacyStatRule {
  ownerId: number;
  stat: StatTarget;
  factor: StatFactor;
  chosenAtRound: number;
}

export interface LeverRule {
  ownerId: number;
  kind: GlobalRuleKind;
  chosenAtRound: number;
  revengeTargetId?: number;
}

// 旧属性规则仅用于读取已有 v1 存档；新投票只生成具名秘策。
export type GlobalRule = LegacyStatRule | LeverRule;
export const RULE_KINDS = Object.keys(RULE_KIND_NAMES) as GlobalRuleKind[];
export const RULE_DESCRIPTIONS: Record<GlobalRuleKind, string> = {
  tether_tight: '断线距离 -15%，共享箱收入 +25%',
  tether_long: '断线距离 +20%，结盟移速 +10%',
  bounty_greed: 'Boss / 敌箱伤害 +25%，散落范围 +30%',
  storm_rush: '每圈额外收紧 5%，移速 +12%',
  close_combat: '飞刀伤害与范围 +20%，箭矢射程 -15%',
  ranged_snipe: '箭矢 / 炸弹伤害 +20%，普攻 / 飞刀 -10%',
  blood_feud: '淘汰增伤底数变为 1.25',
};

/** 宝物词条（首版每件宝物最多 1 条固定数值词条） */
export type RelicKind = 'knife' | 'arrow' | 'laser' | 'cyclone' | 'boomerang' | 'hammer' | 'smoke' | 'heal' | 'bomb';
export type RelicAffix =
  | 'knifeArea'
  | 'arrowPierce'
  | 'laserWidth'
  | 'cycloneSize'
  | 'boomerangSpeed'
  | 'hammerStun'
  | 'smokeSlow'
  | 'healPower'
  | 'bombRadius';

export interface CarryRelic {
  kind: RelicKind;
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
  /** 旧 v1 档案兼容字段，新读写均为 0 */
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
    if (!('stat' in r)) continue;
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
    maxHp: clamp(finiteOr(raw.maxHp, 1), 0.3, 3),
    damage: clamp(finiteOr(raw.damage, 1), 0.2, 4),
    moveSpeed: clamp(finiteOr(raw.moveSpeed, 1), 0.6, 1.8),
    attackSpeed: clamp(finiteOr(raw.attackSpeed, 1), 0.4, 2.5),
    critChance: clamp(finiteOr(raw.critChance, 1), 0, 12),
  };
}

// ---------------------------------------------------------------------------
// 独立乘区
// ---------------------------------------------------------------------------

/** 旧负担兼容入口，始终返回 1 */
export function burdenFactor(layers: number): number {
  void layers; // v1 存档兼容；失败不再削弱下一局属性。
  return 1;
}

/** 单局死亡增伤乘区：1.20 ** 已淘汰角色数 */
export function survivalDamageMultiplier(eliminatedCount: number, base = DEATH_DAMAGE_FACTOR): number {
  const n = clamp(Math.round(finiteOr(eliminatedCount, 0)), 0, 9);
  if (n === 0) return 1;
  return Math.pow(clamp(base, 1.2, 1.25), n);
}

/** 多人同票按乘法叠加，最终在玩法杠杆处限幅，避免后期断线/缩圈退化。 */
export function aggregateGlobalRules(rules: readonly GlobalRule[]) {
  const count = (kind: GlobalRuleKind) => rules.filter(r => 'kind' in r && r.kind === kind).length;
  const tight = count('tether_tight'), long = count('tether_long');
  const bounty = count('bounty_greed'), storm = count('storm_rush');
  const close = count('close_combat'), ranged = count('ranged_snipe');
  return {
    tetherModifier: clamp(0.85 ** tight * 1.2 ** long, 0.6, 1.6),
    chestIncomeModifier: clamp(1.25 ** tight, 1, 3),
    teamSpeedModifier: clamp(1.1 ** long, 1, 1.3),
    shrinkModifier: clamp(0.95 ** storm, 0.8, 1),
    moveSpeedModifier: clamp(1.12 ** storm, 1, 1.4),
    bossDamageModifier: clamp(1.25 ** bounty, 1, 3),
    scatterModifier: clamp(1.3 ** bounty, 1, 2),
    knifeRangeModifier: clamp(1.2 ** close, 1, 1.8),
    arrowRangeModifier: clamp(0.85 ** close, 0.5, 1),
    weaponModifiers: {
      knife: clamp(1.2 ** close * 0.9 ** ranged, 0.5, 3),
      arrow: clamp(1.2 ** ranged, 1, 3),
      laser: clamp(1.2 ** ranged, 1, 3),
      cyclone: clamp(1.2 ** ranged, 1, 3),
      boomerang: clamp(1.2 ** ranged, 1, 3),
      hammer: clamp(1.2 ** close * 0.9 ** ranged, 0.5, 3),
      smoke: clamp(1.2 ** close, 0.5, 3),
      heal: 1.0,
      bomb: clamp(1.2 ** ranged, 1, 3),
      melee: clamp(0.9 ** ranged, 0.5, 1),
    },
    bloodFeudBase: count('blood_feud') > 0 ? 1.25 : 1.2,
  };
}

/** 先锁定最高仇恨目标，再做一次 70% 判定；投票不影响自身宝物继承。 */
export function chooseAiRule(
  actorId: number, round: number, personality: 'honest' | 'greedy' | 'raider',
  grudge: GrudgeRecord | undefined, relics: ReadonlyMap<number, CarryRelic | null>,
  winnerId: number | null, rng: () => number = Math.random,
): LeverRule {
  const target = Object.entries(grudge?.grudgeScoreByActor ?? {})
    .map(([id, score]) => ({ id: Number(id), score }))
    .filter(t => t.score >= 40 && (t.id === 0 || t.id === winnerId) && relics.get(t.id))
    .sort((a, b) => b.score - a.score || a.id - b.id)[0];
  if (target && rng() < 0.7) {
    return { ownerId: actorId, chosenAtRound: round, revengeTargetId: target.id,
      kind: relics.get(target.id)!.kind === 'knife' ? 'ranged_snipe' : 'close_combat' };
  }
  const pool: GlobalRuleKind[] = personality === 'honest'
    ? ['tether_long', 'tether_long', 'close_combat', 'storm_rush']
    : personality === 'greedy'
      ? ['tether_tight', 'bounty_greed', 'ranged_snipe', 'blood_feud']
      : ['bounty_greed', 'blood_feud', 'storm_rush', 'close_combat', 'ranged_snipe'];
  return { ownerId: actorId, chosenAtRound: round, kind: pool[Math.floor(rng() * pool.length)]! };
}

export function settleGrudges(record: GrudgeRecord, conflicts: ReadonlySet<number>): void {
  for (const id of Object.keys(record.grudgeScoreByActor).map(Number)) {
    if (!conflicts.has(id)) record.grudgeScoreByActor[id] = decayGrudgeScore(record.grudgeScoreByActor[id]!);
  }
}

// ---------------------------------------------------------------------------
// 各属性最终出口（先计算完整乘区，再应用安全边界）
// ---------------------------------------------------------------------------

/** 1. 最大生命值：在最终出口限幅；仅保证 >= 1（数学合法） */
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
  return clamp(Math.round(finiteOr(raw, 1)), 1, 300);
}

/** 2. 移动速度：基准 3.1，在最终出口限幅；减速状态 ×0.55 在最终速度后独立施加 */
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
  const safe = clamp(finiteOr(unclamped, baseSpeed), baseSpeed * 0.6, baseSpeed * 1.8);
  const statusMultiplier = isSlowed ? 0.55 : 1.0;
  return safe * statusMultiplier;
}

/** 3. 攻击频率倍率：在最终出口限幅；仅保证为正（攻击周期必须 > 0） */
export function calculateEffectiveAttackSpeed(
  attackSpeedBonus = 0,
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
): number {
  const raw =
    (1 + finiteOr(attackSpeedBonus, 0)) *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  return clamp(finiteOr(raw, 1), 0.4, 2.5);
}

/** 4. 暴击率：基准 5%，最终限制在 0..60%，一次命中最多一层。 */
export function calculateEffectiveCrit(
  worldMultiplier = 1.0,
  personalMultiplier = 1.0,
): { critChance: number; critMultiplier: number } {
  const chance =
    0.05 *
    Math.max(0, finiteOr(worldMultiplier, 1)) *
    Math.max(0, finiteOr(personalMultiplier, 1));
  return {
    critChance: clamp(finiteOr(chance, 0), 0, 0.6),
    critMultiplier: 1.5,
  };
}

/** 5. 攻击基础伤害：在最终出口限幅；最少 1 点（数学合法） */
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
  return Math.max(1, Math.round(Math.min(finiteOr(raw, 1), baseWithFlat * 4 * deathMultiplier)));
}

/**
 * 6. 单次命中伤害与暴击判定。
 * 暴击率限制在 0..60%，一次命中最多触发一层。
 */
export function resolveHitDamage(
  damage: number,
  critChance: number,
  critMultiplier = 1.5,
  rng: () => number = Math.random,
): HitResult {
  const chance = clamp(finiteOr(critChance, 0), 0, 0.6);
  const isCrit = chance > 0 && rng() < chance;
  const critLayers = isCrit ? 1 : 0;
  const mult = isCrit ? critMultiplier : 1;
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

/** 旧失利负担兼容入口：胜负都不再影响下一局属性 */
export function applyRoundOutcome(layers: number, won: boolean): number {
  void layers;
  void won;
  return 0;
}

/** 宝物词条的可读说明（首版每件最多 1 条） */
export const RELIC_AFFIX_TEXT: Record<RelicAffix, string> = {
  knifeArea: '飞刀数量 +1',
  arrowPierce: '箭矢穿透 +1',
  laserWidth: '激光射程 +25%',
  cycloneSize: '旋风范围 +30%',
  boomerangSpeed: '回旋镖往返 +35%',
  hammerStun: '战锤重击 +40%',
  smokeSlow: '毒雾减速 +15%',
  healPower: '回血效能 +35%',
  bombRadius: '爆炸范围 +15%',
};
