// 《荒岛分赃》核心规则与模拟状态模块
// 纯 TypeScript 逻辑，无 DOM、Canvas 或外部运行时依赖。
// 规则：靠近选择 -> 双方同意组队 -> 连线与共享宝箱 -> 拉开距离断线 -> 中点爆箱 -> 争抢
// P0/P1 肉鸽割草拓展：怪潮波次、经验升级三选一、三类武器（飞刀/箭矢/炸弹）、Boss战、特殊事件、终局加时决胜

import {
  aggregateGlobalRules,
  addGrudgeScore,
  createEmptyGrudgeRecord,
  getGrudgeScore,
  type GlobalRule,
  type GrudgeRecord,
  calculateEffectiveAttackSpeed,
  calculateEffectiveCrit,
  calculateEffectiveDamage,
  calculateEffectiveMaxHp,
  calculateEffectiveMoveSpeed,
  computeEffectiveMultipliers,
  resolveHitDamage,
  survivalDamageMultiplier,
  type CarryRelic,
  type EffectiveMultipliers,
  type RelicAffix,
  type RelicKind,
  type WorldMultipliers,
} from './stats.ts';

export interface Vec2 {
  x: number;
  y: number;
}

export const GRID_SIZE = 33;
export const MATCH_SECONDS = 300;
export const OVERTIME_SECONDS = 60; // 300s ~ 360s 决胜加时

export const ALLY_INTERACT_DISTANCE = 2.4;
export const ALLY_INVITE_TTL = 5.0;
export const ALLY_IGNORE_SECONDS = 60.0;
export const TEAM_WARNING_DISTANCE = 4.0;
export const TEAM_BREAK_DISTANCE = 5.0;

// 两次悬赏 Boss（主对局时钟 120s / 240s）
export const RAID_TRIGGER_SECONDS = [120, 240] as const;
export const RAID_WARNING_SECONDS = 3.0;
export const RAID_MAX_SECONDS = 35.0;
export const RAID_RESULT_SECONDS = 2.5;
export const RAID_PARTICIPATION_XP = 4;
export const RAID_PARTICIPATION_TREASURE = 2;
export const RAID_FAIL_HP_LOSS = 0.15;

// 分段缩圈：主对局时钟每满 60s 半径 ×0.85；240s Boss 后再快速收至中心
export const SHRINK_THRESHOLD_SECONDS = [0, 60, 120, 180, 240, 260, 280, 300] as const;
export const SHRINK_RADIUS_MULT = [1, 0.85, 0.7225, 0.614125, 0.52200625, 0.44, 0.36, 0.3] as const;
export const SHRINK_TRANSITION_SECONDS = 5.0;

// 掩体遮挡减伤（炸弹/Boss 圈形攻击被岩石挡住时）
export const COVER_BLOCK_DAMAGE_SCALE = 0.3;

/** 终局前直接攻击角色伤害系数：0 表示终局前不直接扣角色 HP（主题是掠夺宝箱） */
export const PRE_FINAL_ACTOR_DAMAGE_SCALE = 0.2;

/** 攻击周期合法性下界（不是攻速上限：真实频率仍可无限增长，只是周期不能为 0） */
export const MIN_LEGAL_CYCLE = 1e-4;

/** 怪物仇恨半径（避免全岛 16~40 只怪同时围攻单一角色） */
export const MONSTER_AGGRO_RADIUS = 3.5;

/** 同一角色最多被几只怪贴身攻击（避免怪潮围殴瞬间秒杀） */
export const MAX_MONSTERS_PER_TARGET = 1;

/** 角色脱战生命回复（HP/秒），避免长期损耗后无法继续游戏 */
export const ACTOR_HP_REGEN_PER_SECOND = 5.0;

/** AI 低血撤退阈值（低于该比例时优先远离怪潮回血） */
export const AI_RETREAT_HP_RATIO = 0.5;

/** 玩家出生保护期（真实秒，含加载与开局无操作窗口） */
export const PLAYER_SPAWN_PROTECTION_SECONDS = 20.0;

export const PLAYER_COLORS = [
  '#e05a4f', '#3f8ee0', '#e8b53c', '#5fbf6a', '#a06bdd',
  '#ef7fb0', '#43c6c0', '#f08a3c', '#8fa84b', '#dcd0b4',
] as const;

export const PLAYER_NAMES = [
  '赤羽', '青岚', '金砂', '碧藤', '紫电', '绯樱', '苍潮', '橙焰', '苔原', '白垩',
] as const;

export type AiPersonality = 'honest' | 'greedy' | 'raider';
export type MonsterKind = 'chaser' | 'tank' | 'dasher' | 'boss';
export type WeaponKind = 'knife' | 'arrow' | 'laser' | 'cyclone' | 'boomerang' | 'hammer' | 'smoke' | 'bomb';
export type MatchEventKind = 'none' | 'treasure_rain' | 'monster_frenzy';

export interface TileState {
  readonly gx: number;
  readonly gy: number;
  readonly r: number;
  readonly isLand: boolean;
  readonly type: string;
  readonly height: number;
  readonly decor: string;
  readonly seed: number;
  gone: boolean;
  falling: number;
}

export interface ActorState {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly isPlayer: boolean;
  readonly ai: AiPersonality;
  readonly style: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  team: number;
  treasure: number;
  dashCd: number;
  attackCd: number;
  slow: number;
  aim: Vec2;
  think: number;
  kills: number;
  hitFlash: number;
  facing: number;
  rank: number | null;
  runningAwayFromPartner?: boolean;

  // 肉鸽经验与宝物技能等级
  level: number;
  xp: number;
  xpNext: number;
  weaponKnife: number; // 0..3 旋转飞刃
  weaponArrow: number; // 0..3 穿透箭矢
  relicLaser: number;  // 0..3 星芒激光 (8向散射高能光束)
  relicCyclone: number;// 0..3 风暴海螺 (向前螺旋扩散旋风)
  relicBoomerang: number; // 0..3 灵风骨刃 (往返贯穿回旋镖)
  relicHammer: number; // 0..3 巨灵战锤 (正面巨力砸击击退)
  relicSmoke: number;  // 0..3 遁影烟斗 (身后留存减速毒雾)
  weaponBomb: number;  // 0..3 范围炸弹 (保留兼容)
  statDamageBonus: number; // 百分比增益 e.g. 0.15
  statSpeedBonus: number;
  statAttackSpeedBonus: number;
  statAreaBonus: number;
  /** 个人状态乘区（不再应用失败惩罚） */
  personalMultiplier: number;
  /** 携带宝物词条（仅跨局继承的宝物拥有，首版最多 1 条） */
  relicAffix: RelicAffix | null;

  knifeAngle: number;
  arrowTimer: number;
  laserTimer: number;
  cycloneTimer: number;
  boomerangTimer: number;
  hammerTimer: number;
  smokeTimer: number;
  bombTimer: number;
}

export interface MonsterState {
  readonly id: number;
  kind: MonsterKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawn: number;
  wobble: number;
  hitFlash: number;
  speed: number;
  damage: number;
  attackCd: number;
}

export interface ChestState {
  readonly team: number;
  readonly a: number;
  readonly b: number;
  treasure: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  hitFlash: number;
}

export interface LootState {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  value: number;
  life: number;
  spin: number;
}

export interface ParticleState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface FloatTextState {
  id: number;
  text: string;
  x: number;
  y: number;
  life: number;
  maxLife: number;
  color: string;
}

export interface InviteState {
  id: number;
  fromId: number;
  toId: number;
  expiresAt: number;
}

export interface BreakEvent {
  seq: number;
  a: number;
  b: number;
  x: number;
  y: number;
  lootCount: number;
  reason: 'distance' | 'betrayal' | 'final' | 'fall';
}

export interface CandidateInfo {
  id: number;
  name: string;
  distance: number;
  canInvite: boolean;
  reason?: string;
}

export interface UpgradeOption {
  [key: string]: string;
  id: string;
  type: 'weapon' | 'stat';
  title: string;
  description: string;
  currentValue: string;
  nextValue: string;
}

export interface ArrowState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  pierceLeft: number;
  hitMonsterIds: number[];
  hitActorIds: number[];
}

export interface LaserState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  angle: number;
  length: number;
  life: number;
  maxLife: number;
}

export interface CycloneState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  life: number;
  damage: number;
  hitCooldowns: Map<string, number>;
}

export interface BoomerangState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  startX: number;
  startY: number;
  returnPhase: boolean;
  life: number;
  damage: number;
  hitActorIds: number[];
  hitMonsterIds: number[];
}

export interface HammerState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  facing: number;
  radius: number;
  life: number;
  maxLife: number;
  damage: number;
}

export interface SmokeState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
  damage: number;
  hitCooldowns: Map<string, number>;
}

export interface BombState {
  id: number;
  ownerId: number;
  x: number;
  y: number;
  timer: number;
  radius: number;
  damage: number;
  exploded: boolean;
  fxTimer: number;
}

export interface PlayerInputIntent {
  moveX: number;
  moveY: number;
  teamAction?: boolean;
  dash?: boolean;
  inviteTargetId?: number | null;
  acceptInviteId?: number | null;
  ignoreTargetId?: number | null;
  upgradeChoiceIndex?: number | null;
  speedToggle?: boolean;
  restart?: boolean;
}

export interface SimulationState {
  tiles: TileState[];
  actors: ActorState[];
  monsters: MonsterState[];
  chests: ChestState[];
  loots: LootState[];
  particles: ParticleState[];
  floats: FloatTextState[];
  invites: InviteState[];
  ignores: Map<string, number>;
  lastBreakEvent: BreakEvent | null;
  playerDisbands: number;
  nextBreakSeq: number;
  elapsed: number;
  speed: number;
  gameOver: boolean;
  winner: ActorState | null;
  betrayals: number;
  chestBreaks: number;
  playerTreasure: number;
  shrink: number;
  finalPhase: boolean;
  overtime: boolean;
  overtimeResolution: string | null;
  nextEntityId: number;

  // 统一数值与世界修正
  rules: ReturnType<typeof aggregateGlobalRules>;
  grudges: Map<number, GrudgeRecord>;
  grudgeConflicts: Map<number, Set<number>>;
  worldMultipliers: WorldMultipliers;
  effectiveMultipliers: EffectiveMultipliers;
  knifeHits: Map<string, number>;
  rng?: () => number;

  // 单局死亡增伤（每淘汰 1 名参赛角色，幸存者伤害 ×1.20）
  eliminatedCount: number;
  eliminatedActorIds: Set<number>;

  // 分段缩圈（分钟档位 + 过渡）
  shrinkStage: number;
  shrinkTransition: number;

  // 两次悬赏 Boss
  bossRound: 0 | 1 | 2;
  raidPhase: 'none' | 'warning' | 'fight' | 'result';
  raidElapsed: number;
  raidParticipants: number[];
  raidContributions: Map<number, number>;
  raidDamage: number;
  raidBossMaxHp: number;
  raidBossHp: number;
  raidBossX: number;
  raidBossY: number;
  raidTelegraphX: number;
  raidTelegraphY: number;
  raidTelegraphRadius: number;
  raidTelegraphTimer: number;
  raidAttackCd: number;
  raidBossDamage: number;
  raidFailed: boolean;
  raidPendingFinalPhase: boolean;

  // 敌人难度成长（无限模式按局数与战力缩放）
  enemyHpScale: number;
  enemyDamageScale: number;

  // 肉鸽扩展状态
  pendingUpgrade: boolean;
  upgradePaused: boolean;
  upgradeChoices: UpgradeOption[];
  /** 玩家待处理升级次数（连续升级排队，不覆盖未选卡片） */
  pendingUpgradeCount: number;
  arrows: ArrowState[];
  bombs: BombState[];
  lasers: LaserState[];
  cyclones: CycloneState[];
  boomerangs: BoomerangState[];
  hammers: HammerState[];
  smokes: SmokeState[];
  activeEvent: MatchEventKind;
  eventTimeLeft: number;
  eventTriggered: {
    treasure_rain: boolean;
    monster_frenzy: boolean;
  };
  bossSpawned: boolean;
  boss: MonsterState | null;
  maxMonsters: number;
}

export function hash(a: number, b: number, seed = 0): number {
  let h = (a * 374761393 + b * 668265263 + seed * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distPointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

export function landRadius(shrink: number): number {
  return 0.98 * (1 - shrink * 0.62);
}

/** 默认宝物词条：按宝物种类给出首版合法词条 */
export function defaultRelicAffix(kind: RelicKind): RelicAffix {
  if (kind === 'knife') return 'knifeArea';
  if (kind === 'arrow') return 'arrowPierce';
  if (kind === 'laser') return 'laserWidth';
  if (kind === 'cyclone') return 'cycloneSize';
  if (kind === 'boomerang') return 'boomerangSpeed';
  if (kind === 'hammer') return 'hammerStun';
  if (kind === 'smoke') return 'smokeSlow';
  return 'bombRadius';
}

/**
 * 当前分段缩圈档位（主对局时钟每满 60s 一档，240s Boss 后 260/280/300 快速收束）。
 * 只由主对局时钟（sim.elapsed）驱动；Boss 出现时主时钟仍正常推进。
 */
export function shrinkStageFor(elapsed: number): number {
  let stage = 0;
  for (let i = 0; i < SHRINK_THRESHOLD_SECONDS.length; i++) {
    if (elapsed >= SHRINK_THRESHOLD_SECONDS[i]!) stage = i;
  }
  return stage;
}

/** 档位对应的安全半径乘数 */
export function shrinkRadiusMultiplier(stage: number): number {
  const idx = clamp(stage, 0, SHRINK_RADIUS_MULT.length - 1);
  return SHRINK_RADIUS_MULT[idx]!;
}

/** 当前有效安全半径（以地图原始半径函数为基准 × 档位乘数，过渡期间平滑插值） */
export function currentSafeRadius(sim: SimulationState): number {
  const base = 0.98;
  const target = base * Math.max(0.28, shrinkRadiusMultiplier(sim.shrinkStage) * sim.rules.shrinkModifier ** sim.shrinkStage);
  const prevStage = Math.max(0, sim.shrinkStage - 1);
  const prev = base * Math.max(0.28, shrinkRadiusMultiplier(prevStage) * sim.rules.shrinkModifier ** prevStage);
  const t = clamp(sim.shrinkTransition / SHRINK_TRANSITION_SECONDS, 0, 1);
  return prev + (target - prev) * t;
}

// ---------------------------------------------------------------------------
// 中央掩体（2–3 处体素岩石）：同时阻挡移动与直线视线
// ---------------------------------------------------------------------------

export interface CoverBlock {
  readonly id: number;
  x: number;
  y: number;
  /** 半径（近似圆形碰撞/遮挡体积） */
  radius: number;
  /** 该掩体在多少档缩圈后消失（外侧掩体随收缩自然消失） */
  disappearsAtStage: number;
}

/** 中央固定掩体布局（2–3 处，均有可见绕行通道，不形成密封口袋） */
export const COVER_LAYOUT: readonly CoverBlock[] = [
  { id: 0, x: 13.5, y: 16, radius: 0.95, disappearsAtStage: 99 },
  { id: 1, x: 18.5, y: 16, radius: 0.95, disappearsAtStage: 99 },
  { id: 2, x: 18.2, y: 12.8, radius: 0.75, disappearsAtStage: 6 },
] as const;

/** 当前档位仍然存在的掩体 */
export function activeCovers(sim: SimulationState): CoverBlock[] {
  return COVER_LAYOUT.filter((c) => sim.shrinkStage < c.disappearsAtStage);
}

/** 点是否被任一掩体阻挡（用于移动碰撞与视线遮挡） */
export function isInsideCover(sim: SimulationState, x: number, y: number): boolean {
  for (const c of activeCovers(sim)) {
    if (Math.hypot(x - c.x, y - c.y) <= c.radius) return true;
  }
  return false;
}

/** 线段是否被掩体阻挡（视线遮挡：普通攻击/穿透箭不能穿岩） */
export function segmentBlockedByCover(
  sim: SimulationState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const covers = activeCovers(sim);
  if (covers.length === 0) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (const c of covers) {
    // 起点或终点在掩体内视为阻挡
    if (Math.hypot(x0 - c.x, y0 - c.y) <= c.radius) return true;
    if (Math.hypot(x1 - c.x, y1 - c.y) <= c.radius) return true;
    if (len2 <= 1e-9) continue;
    // 线段到圆心的最近点参数
    let t = ((c.x - x0) * dx + (c.y - y0) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    if (Math.hypot(px - c.x, py - c.y) <= c.radius) return true;
  }
  return false;
}

/** 沿 X/Y 分别尝试移动（简单滑墙），返回可行落点 */
export function slideMove(
  sim: SimulationState,
  fromX: number,
  fromY: number,
  deltaX: number,
  deltaY: number,
): { x: number; y: number } {
  let x = fromX;
  let y = fromY;
  if (!segmentBlockedByCover(sim, fromX, fromY, fromX + deltaX, fromY + deltaY)) {
    return { x: fromX + deltaX, y: fromY + deltaY };
  }
  if (!segmentBlockedByCover(sim, fromX, fromY, fromX + deltaX, fromY)) x = fromX + deltaX;
  if (!segmentBlockedByCover(sim, x, fromY, x, fromY + deltaY)) y = fromY + deltaY;
  return { x, y };
}

export function getPairKey(a: number, b: number): string {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return `${min}_${max}`;
}

export function isPairIgnored(sim: SimulationState, a: number, b: number): boolean {
  const key = getPairKey(a, b);
  const until = sim.ignores.get(key);
  return until !== undefined && sim.elapsed < until;
}

export function getIgnoreRemaining(sim: SimulationState, a: number, b: number): number {
  const key = getPairKey(a, b);
  const until = sim.ignores.get(key);
  if (until === undefined) return 0;
  return Math.max(0, until - sim.elapsed);
}

export function ignorePair(sim: SimulationState, a: number, b: number): boolean {
  if (a === b) return false;
  const fromActor = sim.actors[a];
  const toActor = sim.actors[b];
  if (!fromActor || !toActor || !fromActor.alive || !toActor.alive || sim.gameOver) return false;

  if (isPairIgnored(sim, a, b)) return false;

  const key = getPairKey(a, b);
  sim.ignores.set(key, sim.elapsed + ALLY_IGNORE_SECONDS);

  sim.invites = sim.invites.filter(
    (inv) =>
      !(
        (inv.fromId === a && inv.toId === b) ||
        (inv.fromId === b && inv.toId === a)
      ),
  );

  pulse(sim, `已忽略 ${toActor.name}，60秒内互不组队`, fromActor.x, fromActor.y, '#cfd8e0');
  return true;
}

export function createInitialSimulation(options?: {
  rules?: readonly GlobalRule[];
  grudges?: Map<number, GrudgeRecord>;
  worldMultipliers?: WorldMultipliers;
  carryRelics?: Map<number, CarryRelic>;
  /** 每个角色的个人状态乘区（无限模式 0..20 层） */
  personalMultipliers?: Map<number, number>;
  /** 敌人难度成长（无限模式按局数与战力缩放怪物/Boss） */
  enemyScale?: { hp: number; damage: number };
  rng?: () => number;
}): SimulationState {
  const center = (GRID_SIZE - 1) / 2;
  const tiles: TileState[] = [];

  const worldMultipliers: WorldMultipliers = options?.worldMultipliers ?? {
    maxHp: 1.0,
    damage: 1.0,
    moveSpeed: 1.0,
    attackSpeed: 1.0,
    critChance: 1.0,
  };
  const effectiveMultipliers = computeEffectiveMultipliers(worldMultipliers);
  const knifeHits = new Map<string, number>();
  const personalMultipliers = options?.personalMultipliers;
  const enemyHpScale = Math.max(0.2, options?.enemyScale?.hp ?? 1);
  const enemyDamageScale = Math.max(0.2, options?.enemyScale?.damage ?? 1);

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const dx = (gx - center) / (center * 1.06);
      const dy = (gy - center) / (center * 0.94);
      const radial = Math.sqrt(dx * dx + dy * dy);
      const wobble = (hash(gx, gy, 7) - 0.5) * 0.16;
      const r = radial + wobble;
      const isLand = r < 0.98;
      const n = hash(gx, gy, 19);
      let type = 'water';
      let height = 0;
      let decor = 'none';
      if (isLand) {
        if (r > 0.85) {
          type = 'sand';
          height = 0;
        } else if (n < 0.18) {
          type = 'stone';
          height = 0;
        } else if (n < 0.35) {
          type = 'moss';
          height = 0;
        } else {
          type = 'grass';
          height = 0;
        }
        if (height === 0 && n > 0.985 && r < 0.78) {
          decor = 'bush';
        }
      } else {
        type = r > 1.3 ? 'deep' : 'water';
      }
      tiles.push({
        gx,
        gy,
        r,
        isLand,
        type,
        height,
        decor,
        gone: false,
        falling: 0,
        seed: hash(gx, gy, 31),
      });
    }
  }

  const actors: ActorState[] = [];
  const personalities: AiPersonality[] = ['honest', 'greedy', 'raider'];
  for (let i = 0; i < 10; i++) {
    const a = 0.42 + (i / 10) * Math.PI * 2;
    const rad = 8.5 + (i % 3) * 1.8;
    const personalMultiplier = Math.max(0.01, personalMultipliers?.get(i) ?? 1);
    const actorMaxHp = calculateEffectiveMaxHp(
      100,
      0,
      0,
      effectiveMultipliers.maxHp,
      personalMultiplier,
    );
    actors.push({
      id: i,
      name: PLAYER_NAMES[i] ?? `角色${i}`,
      color: PLAYER_COLORS[i] ?? '#ffffff',
      isPlayer: i === 0,
      x: center + Math.cos(a) * rad,
      y: center + Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      hp: actorMaxHp,
      maxHp: actorMaxHp,
      alive: true,
      team: -1,
      treasure: 0,
      ai: personalities[i % 3] ?? 'honest',
      style: i % 4,
      dashCd: 0,
      attackCd: 0,
      slow: 0,
      aim: { x: center, y: center },
      think: hash(i, 3, 5) * 2,
      kills: 0,
      hitFlash: 0,
      facing: 0,
      rank: null,

      level: 1,
      xp: 0,
      xpNext: 5,
      weaponKnife: 0,
      weaponArrow: 0,
      relicLaser: 0,
      relicCyclone: 0,
      relicBoomerang: 0,
      relicHammer: 0,
      relicSmoke: 0,
      weaponBomb: 0,
      statDamageBonus: 0,
      statSpeedBonus: 0,
      statAttackSpeedBonus: 0,
      statAreaBonus: 0,
      personalMultiplier,
      relicAffix: null,
      knifeAngle: i * 0.6,
      arrowTimer: 0.5 + i * 0.2,
      laserTimer: 0.5 + i * 0.2,
      cycloneTimer: 0.8 + i * 0.2,
      boomerangTimer: 0.6 + i * 0.2,
      hammerTimer: 1.0 + i * 0.2,
      smokeTimer: 0.2,
      bombTimer: 1.0 + i * 0.3,
    });
  }

  // 若携带宝物跨局，继承该件宝物等级与词条（其他武器与财富全部清零）
  if (options?.carryRelics) {
    for (const actor of actors) {
      const relic = options.carryRelics.get(actor.id);
      if (relic) {
        const lvl = Math.min(3, Math.max(1, relic.level));
        if (relic.kind === 'knife') actor.weaponKnife = lvl;
        else if (relic.kind === 'arrow') actor.weaponArrow = lvl;
        else if (relic.kind === 'laser') actor.relicLaser = lvl;
        else if (relic.kind === 'cyclone') actor.relicCyclone = lvl;
        else if (relic.kind === 'boomerang') actor.relicBoomerang = lvl;
        else if (relic.kind === 'hammer') actor.relicHammer = lvl;
        else if (relic.kind === 'smoke') actor.relicSmoke = lvl;
        else if (relic.kind === 'bomb') actor.weaponBomb = lvl;
        actor.relicAffix = relic.affix ?? defaultRelicAffix(relic.kind);
      }
    }
  }

  // 初始生成 12 只基础怪物，随波次逐步扩容至 40 只
  const monsters: MonsterState[] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.3;
    const isInitial = i < 12;
    const kind: MonsterKind = i % 5 === 0 ? 'tank' : i % 3 === 0 ? 'dasher' : 'chaser';
    const baseHp = kind === 'tank' ? 8 : kind === 'dasher' ? 4 : 3;
    const speed = kind === 'tank' ? 1.35 : kind === 'dasher' ? 3.3 : 2.55;
    const hp = Math.max(1, Math.round(baseHp * enemyHpScale));
    const damage = Math.max(1, Math.round((kind === 'tank' ? 1.2 : 1) * enemyDamageScale));

    monsters.push({
      id: i,
      kind,
      x: center + Math.cos(a) * (7.5 + (i % 3) * 2.5),
      y: center + Math.sin(a) * (7.5 + (i % 3) * 2.5),
      hp,
      maxHp: hp,
      alive: isInitial,
      respawn: isInitial ? 0 : 4 + (i % 5) * 2,
      wobble: i,
      hitFlash: 0,
      speed,
      damage,
      attackCd: 0,
    });
  }

  return {
    tiles,
    actors,
    monsters,
    chests: [],
    loots: [],
    particles: [],
    floats: [],
    invites: [],
    ignores: new Map(),
    lastBreakEvent: null,
    playerDisbands: 0,
    nextBreakSeq: 1,
    elapsed: 0,
    speed: 1,
    gameOver: false,
    winner: null,
    betrayals: 0,
    chestBreaks: 0,
    playerTreasure: 0,
    shrink: 0,
    finalPhase: false,
    overtime: false,
    overtimeResolution: null,
    nextEntityId: 100,

    rules: aggregateGlobalRules(options?.rules ?? []),
    grudges: options?.grudges ?? new Map(),
    grudgeConflicts: new Map(),
    worldMultipliers,
    effectiveMultipliers,
    knifeHits,
    rng: options?.rng,

    eliminatedCount: 0,
    eliminatedActorIds: new Set<number>(),
    shrinkStage: 0,
    shrinkTransition: 0,

    bossRound: 0,
    raidPhase: 'none',
    raidElapsed: 0,
    raidParticipants: [],
    raidContributions: new Map<number, number>(),
    raidDamage: 0,
    raidBossMaxHp: 0,
    raidBossHp: 0,
    raidBossX: center,
    raidBossY: center,
    raidTelegraphX: center,
    raidTelegraphY: center,
    raidTelegraphRadius: 0,
    raidTelegraphTimer: 0,
    raidAttackCd: 0,
    raidBossDamage: 0,
    raidFailed: false,
    raidPendingFinalPhase: false,

    enemyHpScale,
    enemyDamageScale,

    pendingUpgrade: false,
    upgradePaused: false,
    upgradeChoices: [],
    pendingUpgradeCount: 0,
    arrows: [],
    bombs: [],
    lasers: [],
    cyclones: [],
    boomerangs: [],
    hammers: [],
    smokes: [],
    activeEvent: 'none',
    eventTimeLeft: 0,
    eventTriggered: {
      treasure_rain: false,
      monster_frenzy: false,
    },
    bossSpawned: false,
    boss: null,
    maxMonsters: 16,
  };
}

export function tileAt(sim: SimulationState, gx: number, gy: number): TileState | null {
  if (gx >= 0 && gy >= 0 && gx < GRID_SIZE && gy < GRID_SIZE) {
    return sim.tiles[gy * GRID_SIZE + gx] ?? null;
  }
  return null;
}

export function aliveActors(sim: SimulationState): ActorState[] {
  return sim.actors.filter((a) => a.alive);
}

export function partnerOf(sim: SimulationState, actor: ActorState): ActorState | null {
  return actor.team >= 0 ? sim.actors[actor.team] ?? null : null;
}

export function chestOf(sim: SimulationState, teamId: number): ChestState | null {
  return sim.chests.find((c) => (c.hp > 0 || c.treasure > 0) && (c.a === teamId || c.b === teamId)) ?? null;
}

export function pulse(sim: SimulationState, text: string, x: number, y: number, color = '#ffe27a'): void {
  sim.floats.push({
    id: sim.nextEntityId++,
    text,
    x,
    y,
    life: 1.1,
    maxLife: 1.1,
    color,
  });
}

export function burst(sim: SimulationState, x: number, y: number, color: string, count = 14): void {
  for (let i = 0; i < count; i++) {
    sim.particles.push({
      x,
      y,
      z: 0.5 + Math.random() * 0.6,
      vx: (Math.random() - 0.5) * 1.8,
      vy: (Math.random() - 0.5) * 1.8,
      vz: 1.5 + Math.random() * 3.0,
      life: 0.8 + Math.random() * 0.6,
      maxLife: 1.4,
      color,
      size: 3 + Math.floor(Math.random() * 4),
    });
  }
}

export function scatterLoot(sim: SimulationState, x: number, y: number, count: number): void {
  for (let i = 0; i < count; i++) {
    sim.loots.push({
      id: sim.nextEntityId++,
      x,
      y,
      z: 0.6 + Math.random() * 0.5,
      vx: (Math.random() - 0.5) * 2.4 * sim.rules.scatterModifier,
      vy: (Math.random() - 0.5) * 2.4 * sim.rules.scatterModifier,
      vz: 2.5 + Math.random() * 3.5,
      value: Math.min(1, count - i),
      life: 26,
      spin: Math.random() * 6,
    });
  }
  burst(sim, x, y, '#ffd257', Math.min(24, 6 + count * 2));
}

export function destroyChest(sim: SimulationState, chest: ChestState, originX: number, originY: number, external = false): number {
  if (chest.hp <= 0 && chest.treasure <= 0) return 0;
  const total = chest.treasure;
  const count = external ? total / 2 : total;
  if (external) {
    // 外部破箱公开掉落一半，剩余财物平分归还双方，避免凭空复制或丢失。
    sim.actors[chest.a]!.treasure += (total - count) / 2;
    sim.actors[chest.b]!.treasure += (total - count) / 2;
  }
  chest.treasure = 0;
  chest.hp = 0;
  sim.chestBreaks++;
  if (count > 0) {
    scatterLoot(sim, originX, originY, count);
  }
  burst(sim, originX, originY, '#ffd257', 18);
  return count;
}

export function disbandTeam(sim: SimulationState, a: ActorState, reason: 'distance' | 'betrayal' | 'final' | 'fall'): void {
  const b = partnerOf(sim, a);
  if (!b) return;

  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const chest = chestOf(sim, a.team);

  let releasedCount = 0;
  if (chest && (chest.hp > 0 || chest.treasure > 0)) {
    releasedCount = destroyChest(sim, chest, cx, cy);
  }

  a.team = -1;
  b.team = -1;
  if (reason === 'distance' || reason === 'betrayal') {
    // 超距只归因于明确跑开的一方；普通双向分离不凭空记仇。
    const player = a.isPlayer ? a : b.isPlayer ? b : null;
    const other = player === a ? b : a;
    const separating = player && (player.vx * (player.x - other.x) + player.vy * (player.y - other.y)) > 0.1;
    const betrayer = reason === 'betrayal' ? a : a.runningAwayFromPartner ? a : b.runningAwayFromPartner ? b : separating ? player : null;
    if (betrayer) recordGrudge(sim, betrayer === a ? b.id : a.id, betrayer.id, 'betrayal');
    pulse(sim, '连线拉断，队伍解散！', cx, cy, '#ff6a5a');
    if (a.isPlayer || b.isPlayer) {
      sim.playerDisbands++;
      sim.betrayals = sim.playerDisbands;
      sim.lastBreakEvent = {
        seq: sim.nextBreakSeq++,
        a: a.id,
        b: b.id,
        x: cx,
        y: cy,
        lootCount: releasedCount,
        reason,
      };
    }
  } else if (reason === 'final') {
    pulse(sim, '最终混战 · 结盟解除', cx, cy, '#ff9a6a');
  }
  a.runningAwayFromPartner = false;
  b.runningAwayFromPartner = false;
}

function refusesAlliance(sim: SimulationState, a: ActorState, b: ActorState): boolean {
  return !a.isPlayer && a.ai === 'honest' && getGrudgeScore(sim.grudges.get(a.id) ?? createEmptyGrudgeRecord(), b.id) >= 50;
}

export function formTeam(sim: SimulationState, a: ActorState, b: ActorState): boolean {
  if (
    !a.alive ||
    !b.alive ||
    a.team >= 0 ||
    b.team >= 0 ||
    a.id === b.id ||
    sim.finalPhase ||
    sim.gameOver ||
    refusesAlliance(sim, a, b) || refusesAlliance(sim, b, a) ||
    isPairIgnored(sim, a.id, b.id) ||
    dist(a, b) > ALLY_INTERACT_DISTANCE
  ) {
    return false;
  }

  a.team = b.id;
  b.team = a.id;
  a.runningAwayFromPartner = false;
  b.runningAwayFromPartner = false;

  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  sim.chests.push({
    team: a.id,
    a: a.id,
    b: b.id,
    treasure: 0,
    hp: 60,
    maxHp: 60,
    x: cx,
    y: cy,
    hitFlash: 0,
  });

  sim.invites = sim.invites.filter((inv) => inv.fromId !== a.id && inv.toId !== a.id && inv.fromId !== b.id && inv.toId !== b.id);

  pulse(sim, '结盟成功！', cx, cy, '#8ef0a8');
  return true;
}

export function sendInvite(sim: SimulationState, fromId: number, toId: number): boolean {
  const from = sim.actors[fromId];
  const to = sim.actors[toId];
  if (!from || !to) return false;

  if (
    !from.alive ||
    !to.alive ||
    from.team >= 0 ||
    to.team >= 0 ||
    fromId === toId ||
    sim.finalPhase ||
    sim.gameOver ||
    refusesAlliance(sim, from, to) || refusesAlliance(sim, to, from) ||
    isPairIgnored(sim, fromId, toId) ||
    dist(from, to) > ALLY_INTERACT_DISTANCE
  ) {
    return false;
  }

  const reverse = sim.invites.find((inv) => inv.fromId === toId && inv.toId === fromId && sim.elapsed <= inv.expiresAt);
  if (reverse) {
    return formTeam(sim, from, to);
  }

  const fromBusy = sim.invites.some((inv) => (inv.fromId === fromId || inv.toId === fromId) && sim.elapsed <= inv.expiresAt);
  if (fromBusy) return false;

  const toBusy = sim.invites.some((inv) => (inv.fromId === toId || inv.toId === toId) && sim.elapsed <= inv.expiresAt);
  if (toBusy) return false;

  sim.invites.push({
    id: sim.nextEntityId++,
    fromId,
    toId,
    expiresAt: sim.elapsed + ALLY_INVITE_TTL,
  });

  pulse(sim, `已向 ${to.name} 发送组队邀请...`, from.x, from.y, '#ffe27a');
  return true;
}

export function acceptInvite(sim: SimulationState, inviteId: number, recipientId: number): boolean {
  const inv = sim.invites.find((i) => i.id === inviteId && i.toId === recipientId && sim.elapsed <= i.expiresAt);
  if (!inv) return false;

  const from = sim.actors[inv.fromId];
  const to = sim.actors[inv.toId];
  if (!from || !to) return false;

  return formTeam(sim, from, to);
}

export function getNearbyCandidate(sim: SimulationState, actor: ActorState): CandidateInfo | null {
  if (!actor.alive || actor.team >= 0 || sim.finalPhase || sim.gameOver) return null;

  let bestEligible: ActorState | null = null;
  let bestEligibleDist = ALLY_INTERACT_DISTANCE;
  let closestIgnored: ActorState | null = null;
  let closestIgnoredDist = ALLY_INTERACT_DISTANCE;

  for (const o of aliveActors(sim)) {
    if (o.id === actor.id || o.team >= 0) continue;
    const d = dist(actor, o);
    if (d > ALLY_INTERACT_DISTANCE) continue;

    const ignored = isPairIgnored(sim, actor.id, o.id);
    if (!ignored) {
      if (d < bestEligibleDist) {
        bestEligibleDist = d;
        bestEligible = o;
      }
    } else {
      if (d < closestIgnoredDist) {
        closestIgnoredDist = d;
        closestIgnored = o;
      }
    }
  }

  if (bestEligible) {
    return {
      id: bestEligible.id,
      name: bestEligible.name,
      distance: Number(bestEligibleDist.toFixed(2)),
      canInvite: true,
    };
  }

  if (closestIgnored) {
    return {
      id: closestIgnored.id,
      name: closestIgnored.name,
      distance: Number(closestIgnoredDist.toFixed(2)),
      canInvite: false,
      reason: '被忽略中',
    };
  }

  return null;
}

export function checkGameOver(sim: SimulationState): void {
  if (sim.gameOver) return;

  // 玩家死亡立即结束对局，不再观战 AI
  const player = sim.actors.find((a) => a.isPlayer);
  if (player && !player.alive) {
    sim.gameOver = true;
    sim.winner = null;
    return;
  }

  const alive = aliveActors(sim);
  if (alive.length <= 1) {
    sim.gameOver = true;
    sim.winner = alive[0] ?? null;
    if (sim.winner) {
      sim.winner.rank = 1;
    }
  }
}

export function eliminate(sim: SimulationState, a: ActorState, reason: string): void {
  if (!a.alive) return;
  a.alive = false;
  if (a.isPlayer) {
    sim.pendingUpgrade = false;
    sim.upgradePaused = false;
    sim.pendingUpgradeCount = 0;
    sim.upgradeChoices = [];
    sim.gameOver = true;
    sim.winner = null;
  }
  a.rank = aliveActors(sim).length + 1;

  if (a.team >= 0) {
    disbandTeam(sim, a, 'fall');
  }
  sim.invites = sim.invites.filter((inv) => inv.fromId !== a.id && inv.toId !== a.id);
  burst(sim, a.x, a.y, a.color, 18);

  // 单局死亡增伤：唯一入口去重，每个 actor.id 只计一次（怪物/Boss/宝箱死亡不计）
  if (!sim.eliminatedActorIds.has(a.id)) {
    sim.eliminatedActorIds.add(a.id);
    sim.eliminatedCount = sim.eliminatedActorIds.size;
    const mult = survivalDamageMultiplier(sim.eliminatedCount, sim.rules.bloodFeudBase);
    pulse(
      sim,
      `${a.name} 淘汰 · 幸存者伤害 ×${mult.toFixed(2)}`,
      a.x,
      a.y,
      '#ff9a8a',
    );
  } else {
    pulse(sim, `${a.name} 淘汰`, a.x, a.y, '#ff9a8a');
  }
  void reason;

  checkGameOver(sim);
}

/** 生成三选一升级候选项（全面接入宝物体系） */
export function generateUpgradeChoices(actor: ActorState): UpgradeOption[] {
  const pool: UpgradeOption[] = [];

  // 1. 核心宝物（未满 3 级）
  if (actor.weaponKnife < 3) {
    const nextLvl = actor.weaponKnife + 1;
    pool.push({
      id: 'weapon_knife',
      type: 'weapon',
      title: '宝物·旋转飞刃',
      description: `召唤 ${nextLvl} 把灵能飞刀在身周高速旋转切割触碰的一切敌人`,
      currentValue: actor.weaponKnife === 0 ? '未习得' : `LV.${actor.weaponKnife} (${actor.weaponKnife}把)`,
      nextValue: `LV.${nextLvl} (${nextLvl}把旋转飞刃)`,
    });
  }

  if (actor.weaponArrow < 3) {
    const nextLvl = actor.weaponArrow + 1;
    pool.push({
      id: 'weapon_arrow',
      type: 'weapon',
      title: '宝物·破晓神弩',
      description: `周期性向最近敌对目标射出高能穿透箭，穿透 ${nextLvl + 1} 个目标`,
      currentValue: actor.weaponArrow === 0 ? '未习得' : `LV.${actor.weaponArrow} (穿透${actor.weaponArrow + 1}人)`,
      nextValue: `LV.${nextLvl} (穿透${nextLvl + 1}人)`,
    });
  }

  if (actor.relicLaser < 3) {
    const nextLvl = actor.relicLaser + 1;
    pool.push({
      id: 'relic_laser',
      type: 'weapon',
      title: '宝物·星芒棱镜',
      description: `每隔数秒向八面八方散射瞬间贯穿的耀眼晶石激光束，扫除周围围攻`,
      currentValue: actor.relicLaser === 0 ? '未习得' : `LV.${actor.relicLaser} (8向激光)`,
      nextValue: `LV.${nextLvl} (${nextLvl >= 3 ? '12向高能激光' : '8向强化激光'})`,
    });
  }

  if (actor.relicCyclone < 3) {
    const nextLvl = actor.relicCyclone + 1;
    pool.push({
      id: 'relic_cyclone',
      type: 'weapon',
      title: '宝物·风暴海螺',
      description: `向前打出向前推进并螺旋向外扩散的暴风，持续牵引撕裂沿途目标`,
      currentValue: actor.relicCyclone === 0 ? '未习得' : `LV.${actor.relicCyclone} (半径${(1.5 + actor.relicCyclone * 0.4).toFixed(1)}m)`,
      nextValue: `LV.${nextLvl} (扩散半径${(1.5 + nextLvl * 0.4).toFixed(1)}m)`,
    });
  }

  if (actor.relicBoomerang < 3) {
    const nextLvl = actor.relicBoomerang + 1;
    pool.push({
      id: 'relic_boomerang',
      type: 'weapon',
      title: '宝物·灵风骨刃',
      description: `掷出高速飞行的黄金回旋镖，飞抵极限后折返归位，往返双程强力贯穿`,
      currentValue: actor.relicBoomerang === 0 ? '未习得' : `LV.${actor.relicBoomerang}`,
      nextValue: `LV.${nextLvl} (往返双段${nextLvl * 25}%增伤)`,
    });
  }

  if (actor.relicHammer < 3) {
    const nextLvl = actor.relicHammer + 1;
    pool.push({
      id: 'relic_hammer',
      type: 'weapon',
      title: '宝物·巨灵战锤',
      description: `朝正前方巨力重锤砸地，造成大范围扇形粉碎冲击并强烈击退近身威胁`,
      currentValue: actor.relicHammer === 0 ? '未习得' : `LV.${actor.relicHammer}`,
      nextValue: `LV.${nextLvl} (震波范围+${nextLvl * 20}%，击退强化)`,
    });
  }

  if (actor.relicSmoke < 3) {
    const nextLvl = actor.relicSmoke + 1;
    pool.push({
      id: 'relic_smoke',
      type: 'weapon',
      title: '宝物·遁影烟斗',
      description: `移动时在尾部喷射持续留存的毒云迷雾，踏入毒雾的敌人受到持续中毒并被大幅减速`,
      currentValue: actor.relicSmoke === 0 ? '未习得' : `LV.${actor.relicSmoke} (减速40%)`,
      nextValue: `LV.${nextLvl} (减速${35 + nextLvl * 5}%，留存+1s)`,
    });
  }

  // 2. 通用属性宝物选项（始终提供）
  pool.push({
    id: 'stat_damage',
    type: 'stat',
    title: '锋芒符石',
    description: '全部武器与攻击基础伤害提升 15%',
    currentValue: `+${Math.round(actor.statDamageBonus * 100)}%`,
    nextValue: `+${Math.round((actor.statDamageBonus + 0.15) * 100)}%`,
  });

  pool.push({
    id: 'stat_speed',
    type: 'stat',
    title: '疾风之靴',
    description: '角色移动速度提升 8%',
    currentValue: `+${Math.round(actor.statSpeedBonus * 100)}%`,
    nextValue: `+${Math.round((actor.statSpeedBonus + 0.08) * 100)}%`,
  });

  pool.push({
    id: 'stat_attack_speed',
    type: 'stat',
    title: '极速指环',
    description: '基础攻击与全宝物技能触发间隔缩短 10%',
    currentValue: `+${Math.round(actor.statAttackSpeedBonus * 100)}%`,
    nextValue: `+${Math.round((actor.statAttackSpeedBonus + 0.10) * 100)}%`,
  });

  pool.push({
    id: 'stat_area',
    type: 'stat',
    title: '威能法印',
    description: '技能打击范围、震波与扩散半径扩大 15%',
    currentValue: `+${Math.round(actor.statAreaBonus * 100)}%`,
    nextValue: `+${Math.round((actor.statAreaBonus + 0.15) * 100)}%`,
  });

  // 随机抽取 3 个不重复项
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}

/** 应用升级项 */
export function applyUpgrade(actor: ActorState, upgrade: UpgradeOption): void {
  switch (upgrade.id) {
    case 'weapon_knife':
      actor.weaponKnife = Math.min(3, actor.weaponKnife + 1);
      break;
    case 'weapon_arrow':
      actor.weaponArrow = Math.min(3, actor.weaponArrow + 1);
      break;
    case 'relic_laser':
      actor.relicLaser = Math.min(3, actor.relicLaser + 1);
      break;
    case 'relic_cyclone':
      actor.relicCyclone = Math.min(3, actor.relicCyclone + 1);
      break;
    case 'relic_boomerang':
      actor.relicBoomerang = Math.min(3, actor.relicBoomerang + 1);
      break;
    case 'relic_hammer':
      actor.relicHammer = Math.min(3, actor.relicHammer + 1);
      break;
    case 'relic_smoke':
      actor.relicSmoke = Math.min(3, actor.relicSmoke + 1);
      break;
    case 'weapon_bomb':
      // 兼容旧存档，将 bomb 平滑转为激光宝物
      actor.relicLaser = Math.min(3, actor.relicLaser + 1);
      break;
    case 'stat_damage':
      actor.statDamageBonus += 0.15;
      break;
    case 'stat_speed':
      actor.statSpeedBonus += 0.08;
      break;
    case 'stat_attack_speed':
      actor.statAttackSpeedBonus += 0.10;
      break;
    case 'stat_area':
      actor.statAreaBonus += 0.15;
      break;
  }
}

/** 赋予角色经验并在满足时升级 */
export function giveActorXp(sim: SimulationState, actor: ActorState, amount: number): void {
  if (!actor.alive) return;
  actor.xp += amount;
  burst(sim, actor.x, actor.y, '#65d5b0', 4);


  processActorLevels(sim, actor);
}

/** 处理角色所有待结算升级；玩家选卡按队列展示 */
export function processActorLevels(sim: SimulationState, actor: ActorState): void {
  let guard = 0;
  while (actor.xp >= actor.xpNext && guard++ < 200) {
    actor.xp -= actor.xpNext;
    actor.level++;
    actor.xpNext = 3 + actor.level * 2;
    actor.hp = Math.min(actor.maxHp, actor.hp + 25);
    pulse(sim, `升级！LV.${actor.level}`, actor.x, actor.y, '#65d5b0');

    if (actor.isPlayer) {
      // 升级排队：不覆盖已有未选卡片，记录待选次数（Plan E2 / R02）
      sim.pendingUpgradeCount += 1;
      if (!sim.pendingUpgrade) {
        sim.pendingUpgrade = true;
        sim.upgradePaused = true; // 玩家升级：全局模拟暂停！
        sim.upgradeChoices = generateUpgradeChoices(actor);
      }
      continue;
    } else {
      // AI 升级：依权重自动选卡并应用（循环上限防卡死）
      const choices = generateUpgradeChoices(actor);
      const chosen = choices[Math.floor(Math.random() * choices.length)]!;
      applyUpgrade(actor, chosen);
    }
  }
}

/** 处理玩家升级卡片选择；若仍有排队升级，则继续展示下一张（不丢卡） */
export function selectPlayerUpgrade(sim: SimulationState, index: number): boolean {
  const choice = sim.upgradeChoices[index];
  if (!choice) return false;
  const player = sim.actors[0];
  if (!player) return false;
  applyUpgrade(player, choice);
  pulse(sim, `强化获得：${choice.title}`, player.x, player.y, '#65d5b0');
  sim.pendingUpgradeCount = Math.max(0, sim.pendingUpgradeCount - 1);
  if (sim.pendingUpgradeCount > 0) {
    sim.upgradeChoices = generateUpgradeChoices(player);
    sim.pendingUpgrade = true;
    sim.upgradePaused = true;
  } else {
    sim.pendingUpgrade = false;
    sim.upgradePaused = false;
    sim.upgradeChoices = [];
  }
  return true;
}

/** 计算攻击伤害：包含个人财物增益与结盟/宝箱财富加成，并通过 stats.ts 纯函数计算有效伤害（R07） */
export function calculateAttackDamage(
  sim: SimulationState,
  attacker: ActorState,
  includeDeathMultiplier = true,
): number {
  let baseDamage = 10;
  baseDamage += Math.min(10, attacker.treasure * 0.5);

  if (attacker.team >= 0) {
    baseDamage += 3;
    const chest = chestOf(sim, attacker.team);
    if (chest && (chest.hp > 0 || chest.treasure > 0)) {
      baseDamage += Math.min(5, chest.treasure * 0.5);
    }
  }

  // 唯一伤害出口：个人状态乘区 → 单局死亡增伤乘区（只乘一次）
  return calculateEffectiveDamage(
    baseDamage,
    attacker.statDamageBonus,
    sim.worldMultipliers.damage,
    attacker.personalMultiplier,
    includeDeathMultiplier ? survivalDamageMultiplier(sim.eliminatedCount, sim.rules.bloodFeudBase) : 1,
  );
}

/** 统一敌对命中入口（R02）：基础普攻/飞刀/箭矢/炸弹统一入口，队友免伤，敌队宝箱先承伤，外部破箱不散队 */
export function resolveHostileHit(
  sim: SimulationState,
  target: ActorState,
  baseDamage: number,
  attacker: ActorState | null,
): void {
  if (!target.alive) return;
  // 队友免伤（R02）
  if (attacker && attacker.team >= 0 && attacker.team === target.id) {
    return;
  }

  // 暴击判定（R07）：世界暴击 × 攻击者个人乘区（>100% 由 resolveHitDamage 分层）
  const crit = calculateEffectiveCrit(
    sim.effectiveMultipliers.critChance,
    attacker ? attacker.personalMultiplier : 1,
  );
  const hit = resolveHitDamage(
    baseDamage,
    attacker ? crit.critChance : 0,
    crit.critMultiplier,
    sim.rng ?? Math.random,
  );
  if (hit.isCrit) {
    pulse(sim, '⚡暴击!', target.x, target.y - 0.5, '#ff4757');
  }

  // 敌队宝箱先承伤（R02）
  if (target.team >= 0) {
    const c = chestOf(sim, target.team);
    if (c && (c.hp > 0 || c.treasure > 0)) {
      c.hp -= hit.damage * (attacker ? sim.rules.bossDamageModifier : 1);
      c.hitFlash = 0.2;
      burst(sim, c.x, c.y, '#ffb45c', 5);
      if (c.hp <= 0) {
        destroyChest(sim, c, c.x, c.y, true);
        pulse(sim, '宝箱被打爆！队伍关系仍保留', c.x, c.y, '#ff8a6a');
      }
      return;
    }
  }

  // 玩家出生保护期内免疫敌对角色/武器伤害
  if (target.isPlayer && sim.elapsed < PLAYER_SPAWN_PROTECTION_SECONDS) {
    return;
  }
  const scale = attacker && !sim.finalPhase ? PRE_FINAL_ACTOR_DAMAGE_SCALE : 1;
  damageActor(sim, target, Math.max(1, Math.round(hit.damage * scale)), attacker);
}

export function damageActor(sim: SimulationState, target: ActorState, amount: number, from: ActorState | null): void {
  if (sim.gameOver || !target.alive) return;
  target.hp -= amount;
  target.hitFlash = 0.2;
  burst(sim, target.x, target.y, '#ff8a8a', 4);
  if (target.hp <= 0) {
    if (from && from.id !== target.id) from.kills++;
    if (from && from.id !== target.id) recordGrudge(sim, target.id, from.id, 'kill');
    eliminate(sim, target, 'hp');
    if (from && !sim.gameOver) {
      giveActorXp(sim, from, 3);
    }
  }
}

export function damageMonster(sim: SimulationState, monster: MonsterState, amount: number, from: ActorState | null): void {
  if (sim.gameOver || !monster.alive || (monster.kind === 'boss' && sim.raidPhase !== 'fight')) return;
  if (monster.kind === 'boss' && from) {
    amount *= sim.rules.bossDamageModifier;
    const effective = Math.min(monster.hp, amount);
    const previous = sim.raidContributions.get(from.id) ?? 0;
    sim.raidContributions.set(from.id, previous + effective);
    sim.raidDamage += effective;
    const reward = Math.floor((previous + effective) / 20) - Math.floor(previous / 20);
    if (reward > 0) awardTreasure(sim, from, reward);
  }
  monster.hp -= amount;
  if (monster.kind === 'boss') sim.raidBossHp = Math.max(0, monster.hp);
  monster.hitFlash = 0.2;
  burst(sim, monster.x, monster.y, '#c8a2ff', 4);

  if (monster.hp <= 0) {
    monster.alive = false;
    monster.respawn = monster.kind === 'boss' ? 9999 : 8;

    if (from) {
      const isBoss = monster.kind === 'boss';
      if (isBoss) { finishBossRaid(sim, true); return; }
      giveActorXp(sim, from, isBoss ? 8 : 1);

      if (isBoss) {
        pulse(sim, '🏆 混沌巨兽被击败！大量宝物掉落！', monster.x, monster.y, '#ffd700');
        scatterLoot(sim, monster.x, monster.y, 8);
      } else {
        const c = from.team >= 0 ? chestOf(sim, from.team) : null;
        if (c && c.hp > 0) {
          c.treasure += 2 * sim.rules.chestIncomeModifier;
          pulse(sim, '+2 宝物', c.x, c.y, '#ffe27a');
        } else {
          from.treasure += 2;
          if (from.isPlayer) sim.playerTreasure += 2;
        }
        scatterLoot(sim, monster.x, monster.y, 1);
      }
    }
  }
}

export function doDash(sim: SimulationState, a: ActorState): void {
  if (!a.alive || a.dashCd > 0) return;
  a.dashCd = 3.2;
  const len = Math.hypot(a.vx, a.vy) || 1;
  const dx = a.vx / len;
  const dy = a.vy / len;
  a.x += dx * 1.1;
  a.y += dy * 1.1;
  for (const o of aliveActors(sim)) {
    if (o === a || o.team === a.id || a.team === o.id) continue;
    if (dist(a, o) < 1.25) {
      o.x += dx * 1.5;
      o.y += dy * 1.5;
      burst(sim, o.x, o.y, '#ffffff', 8);
    }
  }
  burst(sim, a.x, a.y, '#bfe9ff', 8);
}

export function checkTeamDistances(sim: SimulationState): void {
  for (const a of sim.actors) {
    if (!a.alive || a.team < 0 || a.id > a.team) continue;
    const b = sim.actors[a.team];
    if (!b || !b.alive) {
      disbandTeam(sim, a, 'fall');
      continue;
    }
    const d = dist(a, b);
    if (d > TEAM_BREAK_DISTANCE * sim.rules.tetherModifier) {
      disbandTeam(sim, a, 'distance');
    }
  }
}

export function recordGrudge(sim: SimulationState, victim: number, offender: number, kind: 'betrayal' | 'kill'): void {
  const memory = sim.grudges.get(victim) ?? createEmptyGrudgeRecord();
  sim.grudges.set(victim, memory);
  addGrudgeScore(memory, offender, kind === 'betrayal' ? 50 : 30);
  if (kind === 'betrayal') memory.lastBetrayedById = offender;
  else memory.lastKilledById = offender;
  const conflicts = sim.grudgeConflicts.get(victim) ?? new Set<number>();
  conflicts.add(offender);
  sim.grudgeConflicts.set(victim, conflicts);
}

export function awardTreasure(sim: SimulationState, actor: ActorState, amount: number): void {
  const chest = actor.team >= 0 ? chestOf(sim, actor.team) : null;
  if (chest && chest.hp > 0) chest.treasure += amount * sim.rules.chestIncomeModifier;
  else {
    actor.treasure += amount;
    if (actor.isPlayer) sim.playerTreasure += amount;
  }
}

function nearestSafeGround(sim: SimulationState, point: Vec2): Vec2 {
  const safe = sim.tiles.filter(t => t.isLand && !t.gone && t.r <= currentSafeRadius(sim) - 0.02 && !isInsideCover(sim, t.gx, t.gy))
    .sort((a, b) => Math.hypot(a.gx - point.x, a.gy - point.y) - Math.hypot(b.gx - point.x, b.gy - point.y))[0];
  return safe ? { x: safe.gx, y: safe.gy } : { x: 11, y: 11 };
}

export function steerAroundCover(sim: SimulationState, actor: Vec2 & { id: number }, target: Vec2): Vec2 {
  if (!segmentBlockedByCover(sim, actor.x, actor.y, target.x, target.y)) return target;
  for (const c of activeCovers(sim)) {
    const dx = actor.x - c.x, dy = actor.y - c.y;
    if (Math.hypot(dx, dy) > c.radius + 2.5) continue;
    const angle = Math.atan2(dy, dx);
    const candidates = [-1, 1].map(sign => ({
      x: c.x + Math.cos(angle + sign * 0.9) * (c.radius + 0.55),
      y: c.y + Math.sin(angle + sign * 0.9) * (c.radius + 0.55),
    })).filter(p => !segmentBlockedByCover(sim, actor.x, actor.y, p.x, p.y));
    candidates.sort((a, b) => dist(a, target) - dist(b, target));
    if (candidates[0]) return candidates[0];
  }
  return target;
}

/** 模拟附加武器：飞刀、穿透箭、范围炸弹 */
export function stepWeapons(sim: SimulationState, dt: number): void {
  const center = (GRID_SIZE - 1) / 2;

  // 1. 环绕飞刀
  for (const a of aliveActors(sim)) {
    if (sim.gameOver) return;
    const attackSpeed = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
    if (a.weaponKnife > 0) {
      a.knifeAngle += dt * 3.6 * attackSpeed;
      const count = a.weaponKnife + (a.relicAffix === 'knifeArea' ? 1 : 0);
      const radius =
        1.6 * (1 + a.statAreaBonus) * sim.rules.knifeRangeModifier;
      const knifeDmg = Math.round(calculateAttackDamage(sim, a) * 0.65 * sim.rules.weaponModifiers.knife);

      for (let k = 0; k < count; k++) {
        const ang = a.knifeAngle + (k * Math.PI * 2) / count;
        const kx = a.x + Math.cos(ang) * radius;
        const ky = a.y + Math.sin(ang) * radius;
        const knifePos = { x: kx, y: ky };

        // 碰触怪物（带 0.4s 命中冷却 R01）
        for (const m of sim.monsters) {
          if (m.alive && dist(knifePos, m) < 0.9 && !segmentBlockedByCover(sim, a.x, a.y, m.x, m.y)) {
            const mKey = `${a.id}:m:${m.id}`;
            const nextHit = sim.knifeHits.get(mKey) ?? 0;
            if (sim.elapsed >= nextHit) {
              sim.knifeHits.set(mKey, sim.elapsed + 0.4 / attackSpeed);
              const crit = calculateEffectiveCrit(sim.effectiveMultipliers.critChance, a.personalMultiplier);
              const hit = resolveHitDamage(
                knifeDmg,
                crit.critChance,
                crit.critMultiplier,
                sim.rng ?? Math.random,
              );
              damageMonster(sim, m, hit.damage, a);
            }
          }
        }

        // 碰触敌方角色与宝箱（遵守队友免伤与敌队宝箱先承伤统一入口 R01 & R02）
        for (const o of aliveActors(sim)) {
          if (o === a || (a.team >= 0 && a.team === o.id)) continue;
          if (dist(knifePos, o) < 0.9 && !segmentBlockedByCover(sim, a.x, a.y, o.x, o.y)) {
            const aKey = `${a.id}:a:${o.id}`;
            const nextHit = sim.knifeHits.get(aKey) ?? 0;
            if (sim.elapsed >= nextHit) {
              sim.knifeHits.set(aKey, sim.elapsed + 0.4 / attackSpeed);
              resolveHostileHit(sim, o, knifeDmg, a);
              if (sim.gameOver) return;
            }
          }
        }
      }
    }

    // 2. 穿透箭矢发射计时
    if (a.weaponArrow > 0) {
      a.arrowTimer -= dt;
      if (a.arrowTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(
          a.statAttackSpeedBonus,
          sim.worldMultipliers.attackSpeed,
        );
        // 攻速在属性出口限幅，攻击周期必须为正
        a.arrowTimer = Math.max(MIN_LEGAL_CYCLE, (1.6 - a.weaponArrow * 0.25) / effAtkSpd);

        // 寻找最近敌对目标
        let targetPos: Vec2 | null = null;
        let minD = 8.5 * sim.rules.arrowRangeModifier;
        for (const m of sim.monsters) {
          if (m.alive && dist(a, m) < minD) {
            minD = dist(a, m);
            targetPos = m;
          }
        }
        for (const o of aliveActors(sim)) {
          if (o !== a && a.team !== o.id && dist(a, o) < minD) {
            minD = dist(a, o);
            targetPos = o;
          }
        }

        if (targetPos) {
          const dx = targetPos.x - a.x;
          const dy = targetPos.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          sim.arrows.push({
            id: sim.nextEntityId++,
            ownerId: a.id,
            x: a.x,
            y: a.y,
            vx: (dx / len) * 7.5,
            vy: (dy / len) * 7.5,
            life: 1.4 * sim.rules.arrowRangeModifier,
            pierceLeft: a.weaponArrow + 1 + (a.relicAffix === 'arrowPierce' ? 1 : 0),
            hitMonsterIds: [],
            hitActorIds: [],
          });
        }
      }
    }

    // 3. 宝物·星芒激光（8向/12向散射瞬发贯穿光束）
    if (a.relicLaser > 0) {
      a.laserTimer -= dt;
      if (a.laserTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
        a.laserTimer = Math.max(MIN_LEGAL_CYCLE, (3.2 - a.relicLaser * 0.4) / effAtkSpd);
        const rayCount = a.relicLaser >= 3 ? 12 : 8;
        const length = (6.0 + a.relicLaser * 0.8) * (1 + a.statAreaBonus) * (a.relicAffix === 'laserWidth' ? 1.25 : 1);
        const laserDmg = Math.round(calculateAttackDamage(sim, a, false) * (0.8 + a.relicLaser * 0.25) * sim.rules.weaponModifiers.laser);
        const deathMult = survivalDamageMultiplier(sim.eliminatedCount, sim.rules.bloodFeudBase);
        const effLaserDmg = Math.max(1, Math.round(laserDmg * deathMult));
        const laserCrit = calculateEffectiveCrit(sim.effectiveMultipliers.critChance, a.personalMultiplier);

        for (let r = 0; r < rayCount; r++) {
          const ang = (r * Math.PI * 2) / rayCount + (a.relicLaser >= 3 ? a.knifeAngle * 0.2 : 0);
          const endX = a.x + Math.cos(ang) * length;
          const endY = a.y + Math.sin(ang) * length;

          // 记录激光束实体用于 3D 渲染
          sim.lasers.push({
            id: sim.nextEntityId++,
            ownerId: a.id,
            x: a.x,
            y: a.y,
            angle: ang,
            length,
            life: 0.22,
            maxLife: 0.22,
          });

          // 对沿途怪物判定射线碰撞（点到线段距离 < 0.65）
          for (const m of sim.monsters) {
            if (!m.alive) continue;
            const distToSeg = distPointToSegment(m.x, m.y, a.x, a.y, endX, endY);
            if (distToSeg < 0.75 && !segmentBlockedByCover(sim, a.x, a.y, m.x, m.y)) {
              const hit = resolveHitDamage(effLaserDmg, laserCrit.critChance, laserCrit.critMultiplier, sim.rng ?? Math.random);
              damageMonster(sim, m, hit.damage, a);
            }
          }

          // 对沿途敌对角色与宝箱判定
          for (const o of aliveActors(sim)) {
            if (o.id === a.id || (a.team >= 0 && a.team === o.id)) continue;
            const distToSeg = distPointToSegment(o.x, o.y, a.x, a.y, endX, endY);
            if (distToSeg < 0.75 && !segmentBlockedByCover(sim, a.x, a.y, o.x, o.y)) {
              resolveHostileHit(sim, o, effLaserDmg, a);
              if (sim.gameOver) return;
            }
          }
        }
      }
    }

    // 4. 宝物·风暴海螺（螺旋扩散旋风）
    if (a.relicCyclone > 0) {
      a.cycloneTimer -= dt;
      if (a.cycloneTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
        a.cycloneTimer = Math.max(MIN_LEGAL_CYCLE, (2.6 - a.relicCyclone * 0.3) / effAtkSpd);
        const speed = 4.2;
        const dirX = Math.cos(a.facing) || 1;
        const dirY = Math.sin(a.facing) || 0;
        const cycloneDmg = Math.round(calculateAttackDamage(sim, a, false) * (0.6 + a.relicCyclone * 0.2) * sim.rules.weaponModifiers.cyclone);

        sim.cyclones.push({
          id: sim.nextEntityId++,
          ownerId: a.id,
          x: a.x + dirX * 0.8,
          y: a.y + dirY * 0.8,
          vx: dirX * speed,
          vy: dirY * speed,
          radius: (1.2 + a.relicCyclone * 0.3) * (1 + a.statAreaBonus) * (a.relicAffix === 'cycloneSize' ? 1.3 : 1),
          life: 2.2,
          damage: cycloneDmg,
          hitCooldowns: new Map(),
        });
      }
    }

    // 5. 宝物·灵风骨刃（黄金回旋镖：去程+折返双段）
    if (a.relicBoomerang > 0) {
      a.boomerangTimer -= dt;
      if (a.boomerangTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
        a.boomerangTimer = Math.max(MIN_LEGAL_CYCLE, (2.2 - a.relicBoomerang * 0.25) / effAtkSpd);
        const flySpeed = 8.0 * (a.relicAffix === 'boomerangSpeed' ? 1.35 : 1);
        const dirX = Math.cos(a.facing) || 1;
        const dirY = Math.sin(a.facing) || 0;
        const boomDmg = Math.round(calculateAttackDamage(sim, a, false) * (0.9 + a.relicBoomerang * 0.25) * sim.rules.weaponModifiers.boomerang);

        sim.boomerangs.push({
          id: sim.nextEntityId++,
          ownerId: a.id,
          x: a.x + dirX * 0.6,
          y: a.y + dirY * 0.6,
          vx: dirX * flySpeed,
          vy: dirY * flySpeed,
          startX: a.x,
          startY: a.y,
          returnPhase: false,
          life: 2.4,
          damage: boomDmg,
          hitActorIds: [],
          hitMonsterIds: [],
        });
      }
    }

    // 6. 宝物·巨灵战锤（正面巨力砸地与震波击退）
    if (a.relicHammer > 0) {
      a.hammerTimer -= dt;
      if (a.hammerTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
        a.hammerTimer = Math.max(MIN_LEGAL_CYCLE, (2.4 - a.relicHammer * 0.3) / effAtkSpd);
        const reach = (2.2 + a.relicHammer * 0.3) * (1 + a.statAreaBonus);
        const hammerDmg = Math.round(calculateAttackDamage(sim, a, false) * (1.5 + a.relicHammer * 0.4) * sim.rules.weaponModifiers.hammer);
        const deathMult = survivalDamageMultiplier(sim.eliminatedCount, sim.rules.bloodFeudBase);
        const effHammerDmg = Math.max(1, Math.round(hammerDmg * deathMult));

        sim.hammers.push({
          id: sim.nextEntityId++,
          ownerId: a.id,
          x: a.x,
          y: a.y,
          facing: a.facing,
          radius: reach,
          life: 0.32,
          maxLife: 0.32,
          damage: effHammerDmg,
        });

        // 正面 120 度扇形判定
        for (const m of sim.monsters) {
          if (!m.alive) continue;
          const d = dist(a, m);
          if (d <= reach) {
            const angToM = Math.atan2(m.y - a.y, m.x - a.x);
            let diff = Math.abs(angToM - a.facing);
            while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
            if (diff <= (Math.PI / 3) && !segmentBlockedByCover(sim, a.x, a.y, m.x, m.y)) {
              damageMonster(sim, m, effHammerDmg, a);
              // 击退怪物
              const pushX = Math.cos(angToM) * 1.8;
              const pushY = Math.sin(angToM) * 1.8;
              m.x += pushX;
              m.y += pushY;
            }
          }
        }

        for (const o of aliveActors(sim)) {
          if (o.id === a.id || (a.team >= 0 && a.team === o.id)) continue;
          const d = dist(a, o);
          if (d <= reach) {
            const angToO = Math.atan2(o.y - a.y, o.x - a.x);
            let diff = Math.abs(angToO - a.facing);
            while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
            if (diff <= (Math.PI / 3) && !segmentBlockedByCover(sim, a.x, a.y, o.x, o.y)) {
              resolveHostileHit(sim, o, effHammerDmg, a);
              o.x += Math.cos(angToO) * 1.6;
              o.y += Math.sin(angToO) * 1.6;
              if (sim.gameOver) return;
            }
          }
        }
      }
    }

    // 7. 宝物·遁影烟斗（移动时身后留下减速毒雾）
    if (a.relicSmoke > 0) {
      a.smokeTimer -= dt;
      const speedSq = a.vx * a.vx + a.vy * a.vy;
      if (a.smokeTimer <= 0 && speedSq > 0.16) {
        a.smokeTimer = 0.35;
        const norm = Math.hypot(a.vx, a.vy) || 1;
        const smokeDmg = Math.round(calculateAttackDamage(sim, a, false) * (0.35 + a.relicSmoke * 0.15) * sim.rules.weaponModifiers.smoke);
        sim.smokes.push({
          id: sim.nextEntityId++,
          ownerId: a.id,
          x: a.x - (a.vx / norm) * 0.6,
          y: a.y - (a.vy / norm) * 0.6,
          radius: 1.3 * (1 + a.statAreaBonus),
          life: 2.6,
          maxLife: 2.6,
          damage: smokeDmg,
          hitCooldowns: new Map(),
        });
      }
    }

    // 兼容历史测试：若手动赋予了 weaponBomb，支持旧炸弹投掷
    if (a.weaponBomb > 0) {
      a.bombTimer -= dt;
      if (a.bombTimer <= 0) {
        const effAtkSpd = calculateEffectiveAttackSpeed(a.statAttackSpeedBonus, sim.worldMultipliers.attackSpeed);
        a.bombTimer = Math.max(MIN_LEGAL_CYCLE, (2.8 - a.weaponBomb * 0.35) / effAtkSpd);
        const radius = (1.8 + a.weaponBomb * 0.45) * (1 + a.statAreaBonus) * (a.relicAffix === 'bombRadius' ? 1.15 : 1);
        const bombDmg = Math.round(calculateAttackDamage(sim, a, false) * 1.3 * sim.rules.weaponModifiers.bomb);
        sim.bombs.push({
          id: sim.nextEntityId++,
          ownerId: a.id,
          x: a.x + a.vx * 1.5,
          y: a.y + a.vy * 1.5,
          timer: 0.9,
          radius,
          damage: bombDmg,
          exploded: false,
          fxTimer: 0.5,
        });
      }
    }
  }

  // 更新箭矢飞行与穿透命中
  for (let i = sim.arrows.length - 1; i >= 0; i--) {
    const arr = sim.arrows[i]!;
    arr.life -= dt;
    const nextX = arr.x + arr.vx * dt, nextY = arr.y + arr.vy * dt;
    if (segmentBlockedByCover(sim, arr.x, arr.y, nextX, nextY)) {
      sim.arrows.splice(i, 1); continue;
    }
    arr.x = nextX; arr.y = nextY;
    const owner = sim.actors[arr.ownerId];

    if (owner && arr.pierceLeft > 0) {
      const arrDmg = Math.round(calculateAttackDamage(sim, owner) * 0.85 * sim.rules.weaponModifiers.arrow);
      // 命中怪物（掩体阻挡视线：不能隔岩命中）
      for (const m of sim.monsters) {
        if (
          m.alive &&
          !arr.hitMonsterIds.includes(m.id) &&
          dist(arr, m) < 0.75 &&
          !segmentBlockedByCover(sim, owner.x, owner.y, m.x, m.y)
        ) {
          arr.hitMonsterIds.push(m.id);
          arr.pierceLeft--;
          const crit = calculateEffectiveCrit(sim.effectiveMultipliers.critChance, owner.personalMultiplier);
          const hit = resolveHitDamage(
            arrDmg,
            crit.critChance,
            crit.critMultiplier,
            sim.rng ?? Math.random,
          );
          damageMonster(sim, m, hit.damage, owner);
          if (arr.pierceLeft <= 0) break;
        }
      }
      // 命中敌方角色（统一入口 R02）
      if (arr.pierceLeft > 0) {
        for (const o of aliveActors(sim)) {
          if (
            o.id !== arr.ownerId &&
            !(owner.team >= 0 && owner.team === o.id) &&
            !arr.hitActorIds.includes(o.id) &&
            dist(arr, o) < 0.75 &&
            !segmentBlockedByCover(sim, owner.x, owner.y, o.x, o.y)
          ) {
            arr.hitActorIds.push(o.id);
            arr.pierceLeft--;
            resolveHostileHit(sim, o, arrDmg, owner);
            if (sim.gameOver) return;
            if (arr.pierceLeft <= 0) break;
          }
        }
      }
    }

    if (arr.life <= 0 || arr.pierceLeft <= 0) {
      sim.arrows.splice(i, 1);
    }
  }

  // 更新激光束寿命
  for (let i = sim.lasers.length - 1; i >= 0; i--) {
    const l = sim.lasers[i]!;
    l.life -= dt;
    if (l.life <= 0) sim.lasers.splice(i, 1);
  }

  // 更新风暴旋风位移与持续吸扯撕裂
  for (let i = sim.cyclones.length - 1; i >= 0; i--) {
    const c = sim.cyclones[i]!;
    c.life -= dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    const owner = sim.actors[c.ownerId];
    if (owner) {
      for (const m of sim.monsters) {
        if (!m.alive || dist(c, m) > c.radius) continue;
        const key = `m:${m.id}`;
        const cd = c.hitCooldowns.get(key) ?? 0;
        if (sim.elapsed >= cd) {
          c.hitCooldowns.set(key, sim.elapsed + 0.3);
          damageMonster(sim, m, c.damage, owner);
          const dx = c.x - m.x;
          const dy = c.y - m.y;
          const d = Math.hypot(dx, dy) || 1;
          m.x += (dx / d) * 0.4;
          m.y += (dy / d) * 0.4;
        }
      }
      for (const o of aliveActors(sim)) {
        if (o.id === c.ownerId || (owner.team >= 0 && owner.team === o.id) || dist(c, o) > c.radius) continue;
        const key = `a:${o.id}`;
        const cd = c.hitCooldowns.get(key) ?? 0;
        if (sim.elapsed >= cd) {
          c.hitCooldowns.set(key, sim.elapsed + 0.3);
          resolveHostileHit(sim, o, c.damage, owner);
          if (sim.gameOver) return;
        }
      }
    }
    if (c.life <= 0) sim.cyclones.splice(i, 1);
  }

  // 更新灵风骨刃回旋镖往返轨迹与贯穿命中
  for (let i = sim.boomerangs.length - 1; i >= 0; i--) {
    const b = sim.boomerangs[i]!;
    b.life -= dt;
    const owner = sim.actors[b.ownerId];
    if (!owner) {
      sim.boomerangs.splice(i, 1);
      continue;
    }

    if (!b.returnPhase) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const flyDist = Math.hypot(b.x - b.startX, b.y - b.startY);
      if (flyDist >= 5.2 || b.life <= 1.2) {
        b.returnPhase = true;
      }
    } else {
      const toOwnerX = owner.x - b.x;
      const toOwnerY = owner.y - b.y;
      const d = Math.hypot(toOwnerX, toOwnerY);
      if (d < 0.6) {
        sim.boomerangs.splice(i, 1);
        continue;
      }
      const speed = 9.0;
      b.x += (toOwnerX / d) * speed * dt;
      b.y += (toOwnerY / d) * speed * dt;
    }

    for (const m of sim.monsters) {
      if (!m.alive || dist(b, m) > 0.85 || b.hitMonsterIds.includes(m.id)) continue;
      b.hitMonsterIds.push(m.id);
      damageMonster(sim, m, b.damage, owner);
    }
    for (const o of aliveActors(sim)) {
      if (o.id === b.ownerId || (owner.team >= 0 && owner.team === o.id) || dist(b, o) > 0.85 || b.hitActorIds.includes(o.id)) continue;
      b.hitActorIds.push(o.id);
      resolveHostileHit(sim, o, b.damage, owner);
      if (sim.gameOver) return;
    }

    if (b.life <= 0) sim.boomerangs.splice(i, 1);
  }

  // 更新战锤砸地寿命
  for (let i = sim.hammers.length - 1; i >= 0; i--) {
    const h = sim.hammers[i]!;
    h.life -= dt;
    if (h.life <= 0) sim.hammers.splice(i, 1);
  }

  // 更新遁影毒雾留存与踏入减速中毒
  for (let i = sim.smokes.length - 1; i >= 0; i--) {
    const s = sim.smokes[i]!;
    s.life -= dt;
    const owner = sim.actors[s.ownerId];
    if (owner) {
      for (const m of sim.monsters) {
        if (!m.alive || dist(s, m) > s.radius) continue;
        const key = `m:${m.id}`;
        const cd = s.hitCooldowns.get(key) ?? 0;
        if (sim.elapsed >= cd) {
          s.hitCooldowns.set(key, sim.elapsed + 0.5);
          damageMonster(sim, m, s.damage, owner);
        }
      }
      for (const o of aliveActors(sim)) {
        if (o.id === s.ownerId || (owner.team >= 0 && owner.team === o.id) || dist(s, o) > s.radius) continue;
        o.slow = Math.max(o.slow, 1.2);
        const key = `a:${o.id}`;
        const cd = s.hitCooldowns.get(key) ?? 0;
        if (sim.elapsed >= cd) {
          s.hitCooldowns.set(key, sim.elapsed + 0.5);
          resolveHostileHit(sim, o, s.damage, owner);
          if (sim.gameOver) return;
        }
      }
    }
    if (s.life <= 0) sim.smokes.splice(i, 1);
  }

  // 更新炸弹倒计时与爆炸波及
  for (let i = sim.bombs.length - 1; i >= 0; i--) {
    const b = sim.bombs[i]!;
    if (!b.exploded) {
      b.timer -= dt;
      if (b.timer <= 0) {
        b.exploded = true;
        const owner = sim.actors[b.ownerId];
        burst(sim, b.x, b.y, '#f59e0b', 20);
        pulse(sim, '💥 轰！', b.x, b.y, '#f59e0b');

        if (owner) {
          // 死亡增伤在爆炸命中瞬间读取最新倍率（只乘一次）
          const deathMult = survivalDamageMultiplier(sim.eliminatedCount, sim.rules.bloodFeudBase);
          const effBombDmg = Math.max(1, Math.round(b.damage * deathMult));
          const bombCrit = calculateEffectiveCrit(
            sim.effectiveMultipliers.critChance,
            owner.personalMultiplier,
          );
          // 对半径内怪物造成 AOE 伤害
          for (const m of sim.monsters) {
            if (m.alive && dist(b, m) <= b.radius) {
              const covered = segmentBlockedByCover(sim, b.x, b.y, m.x, m.y);
              const scaled = covered
                ? Math.max(1, Math.round(effBombDmg * COVER_BLOCK_DAMAGE_SCALE))
                : effBombDmg;
              const hit = resolveHitDamage(
                scaled,
                bombCrit.critChance,
                bombCrit.critMultiplier,
                sim.rng ?? Math.random,
              );
              damageMonster(sim, m, hit.damage, owner);
            }
          }
          // 对半径内敌方角色与宝箱造成伤害（统一入口 R02）
          for (const o of aliveActors(sim)) {
            if (o.id !== b.ownerId && !(owner.team >= 0 && owner.team === o.id) && dist(b, o) <= b.radius) {
              const covered = segmentBlockedByCover(sim, b.x, b.y, o.x, o.y);
              const scaled = covered
                ? Math.max(1, Math.round(effBombDmg * COVER_BLOCK_DAMAGE_SCALE))
                : effBombDmg;
              resolveHostileHit(sim, o, scaled, owner);
              if (sim.gameOver) return;
            }
          }
        }
      }
    } else {
      b.fxTimer -= dt;
      if (b.fxTimer <= 0) {
        sim.bombs.splice(i, 1);
      }
    }
  }
}

export function decideAI(sim: SimulationState, a: ActorState): void {
  const center = (GRID_SIZE - 1) / 2;

  // 1. 处理发给自己的待处理组队邀请
  const pendingToMe = sim.invites.find((inv) => inv.toId === a.id && sim.elapsed <= inv.expiresAt);
  if (pendingToMe && a.team < 0 && !sim.finalPhase) {
    const fromActor = sim.actors[pendingToMe.fromId];
    if (fromActor && fromActor.alive && dist(a, fromActor) <= ALLY_INTERACT_DISTANCE && !isPairIgnored(sim, a.id, fromActor.id)) {
      const grudge = getGrudgeScore(sim.grudges.get(a.id) ?? createEmptyGrudgeRecord(), fromActor.id);
      if (grudge >= 50 && a.ai === 'honest') { ignorePair(sim, a.id, fromActor.id); return; }
      let acceptProb = grudge >= 50 ? 1 : 0.8;
      if (grudge < 50 && a.ai === 'greedy') acceptProb = 0.65;
      else if (grudge < 50 && a.ai === 'raider') acceptProb = 0.35;

      if ((sim.rng ?? Math.random)() < acceptProb) {
        acceptInvite(sim, pendingToMe.id, a.id);
        return;
      } else {
        ignorePair(sim, a.id, fromActor.id);
        return;
      }
    }
  }

  const ally = partnerOf(sim, a);
  const grudge = ally ? getGrudgeScore(sim.grudges.get(a.id) ?? createEmptyGrudgeRecord(), ally.id) : 0;
  const chest = ally ? chestOf(sim, a.team) : null;
  const rich = (chest?.treasure ?? 0) >= 4;
  const nearTelegraph = ally && sim.raidTelegraphTimer > 0 && Math.hypot(ally.x - sim.raidTelegraphX, ally.y - sim.raidTelegraphY) <= sim.raidTelegraphRadius + 1;
  const bossWeak = sim.raidPhase === 'fight' && sim.raidBossHp <= sim.raidBossMaxHp * 0.2;
  if (ally && a.ai !== 'honest' && ((grudge >= 50 && (rich || nearTelegraph)) || (bossWeak && (rich || aliveActors(sim).some(o => o !== a && o.id !== a.team && o.hp / o.maxHp < 0.4 && dist(a, o) < 3))))) {
    disbandTeam(sim, a, 'betrayal');
    a.aim = { x: ally.x, y: ally.y };
    return;
  }
  if (ally && a.runningAwayFromPartner) {
    const dx = a.x - ally.x || 1, dy = a.y - ally.y;
    const len = Math.hypot(dx, dy);
    a.aim = { x: a.x + dx / len * 5, y: a.y + dy / len * 5 };
    return;
  }

  // 先躲 Boss 红圈、先脱离威胁，再考虑追宝与常规合作移动。
  if (sim.raidTelegraphTimer > 0 && Math.hypot(a.x - sim.raidTelegraphX, a.y - sim.raidTelegraphY) <= sim.raidTelegraphRadius + 0.4) {
    const dx = a.x - sim.raidTelegraphX || (a.id % 2 ? 1 : -1), dy = a.y - sim.raidTelegraphY;
    const len = Math.hypot(dx, dy);
    a.aim = { x: a.x + dx / len * 3, y: a.y + dy / len * 3 };
    return;
  }
  if (a.hp / a.maxHp < AI_RETREAT_HP_RATIO) {
    const threats: Vec2[] = [
      ...sim.monsters.filter(m => m.alive),
      ...aliveActors(sim).filter(o => o.id !== a.id && o.id !== a.team),
    ];
    const threat = threats.filter(o => dist(a, o) < MONSTER_AGGRO_RADIUS * 1.4).sort((p, q) => dist(a, p) - dist(a, q))[0];
    if (threat) {
      const dx = a.x - threat.x || 1, dy = a.y - threat.y;
      const len = Math.hypot(dx, dy);
      a.aim = { x: a.x + dx / len * 3, y: a.y + dy / len * 3 };
      return;
    }
  }

  // 2. 抢自由宝物（合作状态受距离约束，且不追逐落入水域边缘的宝物）
  let bestLoot: LootState | null = null;
  let bl = 7;
  const partner = partnerOf(sim, a);
  const currentRadius = currentSafeRadius(sim);

  for (const l of sim.loots) {
    if (!l.value || l.z > 2) continue;
    const lt = tileAt(sim, Math.round(l.x), Math.round(l.y));
    if (!lt || !lt.isLand || lt.gone || lt.r > currentRadius - 0.05) continue;

    const d = dist(a, l);
    if (d < bl) {
      if (partner && !a.runningAwayFromPartner && dist(partner, l) > 3.6) {
        continue;
      }
      bl = d;
      bestLoot = l;
    }
  }
  if (bestLoot) {
    a.aim = { x: bestLoot.x, y: bestLoot.y };
    return;
  }

  // 3. 终局混战阶段
  if (sim.finalPhase) {
    const others = aliveActors(sim).filter((o) => o !== a);
    const t = others.sort((p, q) => dist(a, p) - dist(a, q))[0];
    a.aim = t ? { x: t.x, y: t.y } : { x: center, y: center };
    return;
  }

  // 4. 已有队伍状态
  if (a.team >= 0 && partner) {
    const c = chestOf(sim, a.team);

    if (a.ai === 'greedy' && c && c.treasure >= 6 && Math.random() < 0.25) {
      a.runningAwayFromPartner = true;
    }

    if (a.runningAwayFromPartner) {
      const dx = a.x - partner.x || 1;
      const dy = a.y - partner.y || 1;
      const dlen = Math.hypot(dx, dy);
      a.aim = {
        x: clamp(a.x + (dx / dlen) * 4.0, 1.5, GRID_SIZE - 2.5),
        y: clamp(a.y + (dy / dlen) * 4.0, 1.5, GRID_SIZE - 2.5),
      };
      return;
    }

    if (a.ai === 'raider') {
      const enemyChest = sim.chests
        .filter((x) => (x.hp > 0 || x.treasure > 0) && x.a !== a.id && x.b !== a.id && x.treasure >= 3)
        .sort((p, q) => dist(a, p) - dist(a, q))[0];
      if (enemyChest) {
        a.aim = { x: enemyChest.x, y: enemyChest.y };
        return;
      }
    }

    a.aim = {
      x: (a.x + partner.x) / 2 + (Math.random() - 0.5) * 2.0,
      y: (a.y + partner.y) / 2 + (Math.random() - 0.5) * 2.0,
    };
    return;
  } else if (!sim.finalPhase && a.ai !== 'raider') {
    // 5. 单人未组队：寻找附近未组队未屏蔽角色
    const candidate = getNearbyCandidate(sim, a);
    if (candidate && candidate.canInvite) {
      sendInvite(sim, a.id, candidate.id);
      return;
    }
  }

  // 6. 优先攻击附近怪物（绕开掩体，不卡死在岩石前）
  const monster = sim.monsters
    .filter((m) => m.alive)
    .sort((p, q) => dist(a, p) - dist(a, q))[0];
  if (monster) {
    let tx = monster.x + (Math.random() - 0.5) * 2;
    let ty = monster.y + (Math.random() - 0.5) * 2;
    if (isInsideCover(sim, tx, ty)) {
      // 目标落点在掩体内：向侧边预定义绕行点偏移
      tx = monster.x + (a.x > monster.x ? 1.6 : -1.6);
      ty = monster.y + (a.y > monster.y ? 1.6 : -1.6);
    }
    a.aim = { x: tx, y: ty };
    return;
  }

  a.aim = {
    x: center + (Math.random() - 0.5) * 7,
    y: center + (Math.random() - 0.5) * 7,
  };
}

// ---------------------------------------------------------------------------
// 悬赏 Boss（120s / 240s，保持自由 PvPvE）
// ---------------------------------------------------------------------------

/** 悬赏 Boss 留在原战场；不传送、不改阵营、不停表。 */
export function startBossRaid(sim: SimulationState): void {
  if (sim.raidPhase !== 'none' || sim.gameOver || sim.bossRound >= 2) return;
  sim.bossRound = (sim.bossRound + 1) as 1 | 2;
  sim.raidPhase = 'warning'; sim.raidElapsed = 0;
  sim.raidParticipants = aliveActors(sim).map(a => a.id);
  const center = (GRID_SIZE - 1) / 2;
  sim.raidContributions.clear(); sim.raidDamage = 0; sim.raidFailed = false;
  sim.raidBossX = center; sim.raidBossY = center;
  sim.raidBossMaxHp = Math.round((160 + 32 * sim.raidParticipants.length) * sim.enemyHpScale);
  sim.raidBossHp = sim.raidBossMaxHp;
  sim.raidBossDamage = 18 * sim.enemyDamageScale;
  sim.raidTelegraphTimer = 0; sim.raidTelegraphRadius = 0; sim.raidAttackCd = 0;
  sim.boss = { id: sim.nextEntityId++, kind: 'boss', x: center, y: center,
    hp: sim.raidBossHp, maxHp: sim.raidBossMaxHp, alive: true, respawn: 9999,
    wobble: 0, hitFlash: 0, speed: 0, damage: sim.raidBossDamage, attackCd: 0 };
  sim.monsters.push(sim.boss);
  pulse(sim, `第 ${sim.bossRound} 场悬赏 Boss · 小心背刺`, center, center, '#ff1e42');
}

export function enterFinalPhase(sim: SimulationState): void {
  if (sim.finalPhase || sim.gameOver) return;
  sim.finalPhase = true;
  for (const a of aliveActors(sim)) if (a.team >= 0) disbandTeam(sim, a, 'final');
  sim.invites.length = 0;
}

export function stepBossRaid(sim: SimulationState, dt: number): void {
  if (sim.raidPhase === 'none' || sim.gameOver) return;
  sim.raidElapsed += dt;
  if (sim.raidPhase === 'result') {
    if (sim.raidElapsed >= RAID_RESULT_SECONDS) endBossRaid(sim);
    return;
  }
  if (sim.raidElapsed >= RAID_MAX_SECONDS) { finishBossRaid(sim, false); return; }
  if (sim.raidPhase === 'warning') {
    if (sim.raidElapsed >= RAID_WARNING_SECONDS) sim.raidPhase = 'fight';
    return;
  }
  sim.raidAttackCd -= dt;
  if (sim.raidTelegraphTimer > 0) {
    sim.raidTelegraphTimer -= dt;
    if (sim.raidTelegraphTimer <= 0) {
      for (const a of aliveActors(sim)) {
        if (Math.hypot(a.x - sim.raidTelegraphX, a.y - sim.raidTelegraphY) > sim.raidTelegraphRadius) continue;
        const covered = segmentBlockedByCover(sim, sim.raidTelegraphX, sim.raidTelegraphY, a.x, a.y);
        resolveHostileHit(sim, a, sim.raidBossDamage * (covered ? 0.3 : 1), null);
        if (sim.gameOver) return;
      }
      burst(sim, sim.raidTelegraphX, sim.raidTelegraphY, '#ff1e42', 24);
    }
  } else if (sim.raidAttackCd <= 0) {
    const value = (a: ActorState) => a.treasure + (chestOf(sim, a.team)?.treasure ?? 0) + (sim.raidContributions.get(a.id) ?? 0) / 10;
    const target = aliveActors(sim).sort((a, b) => value(b) - value(a) || a.id - b.id)[0];
    if (target) {
      sim.raidTelegraphX = target.x; sim.raidTelegraphY = target.y;
      sim.raidTelegraphRadius = 2.2; sim.raidTelegraphTimer = 1.5; sim.raidAttackCd = 4.5;
    }
  }
}

export function finishBossRaid(sim: SimulationState, success: boolean): void {
  if (sim.raidPhase === 'result' || sim.raidPhase === 'none') return;
  sim.raidFailed = !success; sim.raidPhase = 'result'; sim.raidElapsed = 0;
  sim.raidTelegraphTimer = 0;
  if (sim.boss) sim.boss.alive = false;
  if (success) {
    sim.raidBossHp = 0;
    scatterLoot(sim, 11, 11, 12);
    // 所有实际输出者获得经验与至少一件可升级武器；无需直接写测试状态。
    for (const a of aliveActors(sim)) {
      if ((sim.raidContributions.get(a.id) ?? 0) <= 0) continue;
      if (a.weaponKnife === 0 && a.weaponArrow === 0 && a.weaponBomb === 0) a.weaponKnife = 1;
      giveActorXp(sim, a, 8);
    }
  }
  if (sim.bossRound === 2) enterFinalPhase(sim);
  pulse(sim, success ? '悬赏已破 · 战利品公开争抢' : '悬赏 Boss 离场', 11, 11, '#ffd166');
}

export function endBossRaid(sim: SimulationState): void {
  sim.raidPhase = 'none'; sim.raidElapsed = 0; sim.raidTelegraphTimer = 0;
  if (sim.boss) sim.boss.alive = false;
}

export function restartSimulation(
  sim: SimulationState,
  options?: {
    rules?: readonly GlobalRule[];
  grudges?: Map<number, GrudgeRecord>;
  worldMultipliers?: WorldMultipliers;
    carryRelics?: Map<number, CarryRelic>;
    personalMultipliers?: Map<number, number>;
    enemyScale?: { hp: number; damage: number };
    rng?: () => number;
  },
): void {
  const initial = createInitialSimulation(options);
  Object.assign(sim, initial);
}

export function stepSimulation(
  sim: SimulationState,
  dtRaw: number,
  input: PlayerInputIntent,
): void {
  if (input.speedToggle) {
    sim.speed = sim.speed === 1 ? 4 : 1;
  }
  if (input.restart) {
    restartSimulation(sim);
    return;
  }

  // 结局后冻结全部游戏规则（R02）
  if (sim.gameOver) {
    return;
  }

  // 升级三选一选择输入处理（选卡后恢复模拟暂停）
  const player = sim.actors[0]!;
  if (sim.pendingUpgrade && input.upgradeChoiceIndex !== undefined && input.upgradeChoiceIndex !== null) {
    selectPlayerUpgrade(sim, input.upgradeChoiceIndex);
  }

  // 全局升级暂停：暂停时所有战斗、移动与倒计时静止
  if (sim.upgradePaused) {
    return;
  }

  const dt = dtRaw * sim.speed;
  const center = (GRID_SIZE - 1) / 2;

  sim.elapsed += dt;
  if (sim.raidPhase === 'none' && sim.bossRound < 2 && sim.elapsed >= RAID_TRIGGER_SECONDS[sim.bossRound as 0 | 1]!) startBossRaid(sim);
  stepBossRaid(sim, dt);
  if (sim.gameOver) return;

  // 分段缩圈：主对局时钟每满 60s 一档 ×0.85；240s 后 260/280/300 快速收束
  const newStage = shrinkStageFor(sim.elapsed);
  if (newStage !== sim.shrinkStage) {
    sim.shrinkStage = newStage;
    sim.shrinkTransition = 0;
    pulse(
      sim,
      `安全区收缩 · 第 ${newStage} 档（半径 ${(shrinkRadiusMultiplier(newStage) * 100).toFixed(0)}%）`,
      center,
      center,
      '#ffb45c',
    );
  }
  if (sim.shrinkTransition < SHRINK_TRANSITION_SECONDS) {
    sim.shrinkTransition = Math.min(
      SHRINK_TRANSITION_SECONDS,
      sim.shrinkTransition + dt,
    );
  }
  sim.shrink = 1 - currentSafeRadius(sim) / 0.98;

  if (sim.elapsed >= 275) enterFinalPhase(sim);

  // P1-D: 决胜加时与判定修复（300s 仍有多人存活进入 overtime 加速决胜）
  if (sim.elapsed >= MATCH_SECONDS && !sim.gameOver) {
    sim.overtime = true;

    // 达到 360s 加时极限仍有多人存活：按明确平分规则决胜（HP > Kills > Treasure > ID）
    if (sim.elapsed >= MATCH_SECONDS + OVERTIME_SECONDS) {
      const alive = aliveActors(sim);
      if (alive.length > 0) {
        const winner = alive.sort((p, q) => {
          if (q.hp !== p.hp) return q.hp - p.hp;
          if (q.kills !== p.kills) return q.kills - p.kills;
          if (q.treasure !== p.treasure) return q.treasure - p.treasure;
          return p.id - q.id;
        })[0]!;
        sim.gameOver = true;
        sim.winner = winner;
        sim.overtimeResolution = 'points';
        winner.rank = 1;
        pulse(sim, `加时积分决胜：${winner.name} 获胜！`, center, center, '#ffe27a');
        // 结局成立：立即冻结本次模拟更新（Plan R04 / E4）
        return;
      }
    }
  }

  // P1-C: 特殊事件触发
  // 1. 宝物雨（90s 触发）
  if (sim.elapsed >= 90 && !sim.eventTriggered.treasure_rain) {
    sim.eventTriggered.treasure_rain = true;
    sim.activeEvent = 'treasure_rain';
    sim.eventTimeLeft = 14;
    pulse(sim, '🌟 宝物雨降临！荒岛空投大量战利品！', center, center, '#ffd700');
    // 在安全陆地生成 8 个金色宝物
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rx = center + Math.cos(a) * (2.5 + (i % 2) * 1.5);
      const ry = center + Math.sin(a) * (2.5 + (i % 2) * 1.5);
      sim.loots.push({
        id: sim.nextEntityId++,
        x: rx,
        y: ry,
        z: 3.5,
        vx: (Math.random() - 0.5) * 1.2,
        vy: (Math.random() - 0.5) * 1.2,
        vz: 3.0,
        value: 1,
        life: 25,
        spin: Math.random() * 6,
      });
    }
  }

  // 2. 怪物暴走（220s 触发）
  if (sim.elapsed >= 220 && !sim.eventTriggered.monster_frenzy) {
    sim.eventTriggered.monster_frenzy = true;
    sim.activeEvent = 'monster_frenzy';
    sim.eventTimeLeft = 18;
    pulse(sim, '⚡ 怪物狂暴！全岛怪潮暴走！', center, center, '#ef4444');
  }

  if (sim.eventTimeLeft > 0) {
    sim.eventTimeLeft -= dt;
    if (sim.eventTimeLeft <= 0) {
      if (sim.activeEvent === 'monster_frenzy') {
        pulse(sim, '狂暴消退，怪潮恢复平静', center, center, '#65d5b0');
      }
      sim.activeEvent = 'none';
    }
  }

  // 怪潮容量随时间扩展 (16 -> 24 -> 34 -> 40)
  sim.maxMonsters = sim.elapsed < 60 ? 5 : sim.elapsed < 140 ? 10 : sim.elapsed < 230 ? 16 : 22;

  // 地块崩塌判定（与 Boss 并行）
  const currentRadius = currentSafeRadius(sim);
  for (const t of sim.tiles) {
    if (!t.isLand || t.gone) continue;
    if (t.r > currentRadius) {
      t.falling += dt;
      if (t.falling > 0.55) {
        t.gone = true;
        if (Math.random() < 0.5) {
          burst(sim, t.gx, t.gy, '#8b8f86', 4);
        }
      }
    }
  }

  // 1. 处理玩家队伍交互（唯一战斗按键 Space / 组队按钮触发 teamAction，R03）
  if (input.teamAction) {
    const incoming = sim.invites.find(
      (i) => i.toId === player.id && sim.elapsed <= i.expiresAt,
    );
    if (player.team >= 0) {
      disbandTeam(sim, player, 'betrayal');
    } else if (incoming) {
      acceptInvite(sim, incoming.id, player.id);
    } else if (player.team < 0) {
      const candidate = getNearbyCandidate(sim, player);
      if (candidate && candidate.canInvite) {
        sendInvite(sim, player.id, candidate.id);
      }
    }
  }

  // 处理玩家目标邀请与忽略输入（保留兼容代码）
  if (input.ignoreTargetId !== undefined && input.ignoreTargetId !== null) {
    ignorePair(sim, player.id, input.ignoreTargetId);
  }
  if (input.acceptInviteId !== undefined && input.acceptInviteId !== null) {
    acceptInvite(sim, input.acceptInviteId, player.id);
  }
  if (input.inviteTargetId !== undefined && input.inviteTargetId !== null) {
    sendInvite(sim, player.id, input.inviteTargetId);
  }

  // 2. 清理超时失效或离开距离的邀请
  for (let i = sim.invites.length - 1; i >= 0; i--) {
    const inv = sim.invites[i]!;
    const from = sim.actors[inv.fromId];
    const to = sim.actors[inv.toId];
    if (
      sim.elapsed > inv.expiresAt ||
      !from ||
      !to ||
      !from.alive ||
      !to.alive ||
      from.team >= 0 ||
      to.team >= 0 ||
      dist(from, to) > ALLY_INTERACT_DISTANCE ||
      isPairIgnored(sim, from.id, to.id)
    ) {
      sim.invites.splice(i, 1);
    }
  }

  // 3. 玩家位移输入（包含敏捷增益）
  let mx = input.moveX;
  let my = input.moveY;
  const ml = Math.hypot(mx, my);
  if (ml > 1) {
    mx /= ml;
    my /= ml;
  }
  player.vx = mx;
  player.vy = my;
  if (ml > 0.05) {
    player.facing = Math.atan2(my, mx);
  }

  if (input.dash) {
    doDash(sim, player);
  }

  // 4. AI 决策推进
  for (const a of sim.actors) {
    if (!a.alive || a.isPlayer) continue;
    a.think -= dt;
    if (a.think <= 0) {
      a.think = 0.5 + hash(a.id, Math.floor(sim.elapsed), 11) * 0.7;
      decideAI(sim, a);
    }
  }

  // 5. 角色移动物理位移与阻尼
  for (const a of aliveActors(sim)) {
    if (!a.isPlayer) {
      a.aim = steerAroundCover(sim, a, a.aim);
      const dl = Math.hypot(a.aim.x - a.x, a.aim.y - a.y);
      a.vx = dl > 0.25 ? ((a.aim.x - a.x) / dl) * 0.82 : 0;
      a.vy = dl > 0.25 ? ((a.aim.y - a.y) / dl) * 0.82 : 0;
      if (Math.hypot(a.vx, a.vy) > 0.05) {
        a.facing = Math.atan2(a.vy, a.vx);
      }
    }
    const isSlowed = a.slow > 0;
    const sp =
      calculateEffectiveMoveSpeed(
        4.65,
        a.statSpeedBonus,
        sim.worldMultipliers.moveSpeed,
        isSlowed,
        a.personalMultiplier * sim.rules.moveSpeedModifier * (a.team >= 0 ? sim.rules.teamSpeedModifier : 1),
      ) * dt;
    const nx = a.x + a.vx * sp;
    const ny = a.y + a.vy * sp;
    if (!a.isPlayer) {
      const nt = tileAt(sim, Math.round(nx), Math.round(ny));
      if (!nt || !nt.isLand || nt.gone || nt.r > currentRadius - 0.04) {
        a.aim = { x: center, y: center };
        a.vx = ((center - a.x) / (Math.hypot(center - a.x, center - a.y) || 1)) * 0.5;
        a.vy = ((center - a.y) / (Math.hypot(center - a.x, center - a.y) || 1)) * 0.5;
      }
    }
    // 掩体碰撞：沿 X/Y 分别尝试移动形成简单滑墙（不引入寻路框架）
    const slid = slideMove(sim, a.x, a.y, a.vx * sp, a.vy * sp);
    a.x = clamp(slid.x, 0.5, GRID_SIZE - 1.5);
    a.y = clamp(slid.y, 0.5, GRID_SIZE - 1.5);
    a.slow = Math.max(0, a.slow - dt);
    a.dashCd = Math.max(0, a.dashCd - dt);
    a.attackCd = Math.max(0, a.attackCd - dt);
    a.hitFlash = Math.max(0, a.hitFlash - dt);
    // 脱战生命回复（受击后短暂停止），保证长期对局可持续
    if (a.hitFlash <= 0 && a.hp < a.maxHp) {
      a.hp = Math.min(a.maxHp, a.hp + ACTOR_HP_REGEN_PER_SECOND * dt);
    }
  }

  // 6. 移动后优先执行本步边缘坠落与淘汰判定（R05）
  for (const a of aliveActors(sim)) {
    const t = tileAt(sim, Math.round(a.x), Math.round(a.y));
    if (!t || !t.isLand || t.gone || t.r > currentRadius) {
      if (sim.shrinkTransition < SHRINK_TRANSITION_SECONDS) {
        const safe = nearestSafeGround(sim, a); a.x = safe.x; a.y = safe.y;
      } else {
        eliminate(sim, a, 'fall');
        if (sim.gameOver) return;
      }
    }
  }

  // 7. 统一队伍距离与断线检测（Boss 在场也不豁免）
  checkTeamDistances(sim);

  // 8. 怪物追踪移动与攻击
  const frenzyMultiplier = sim.activeEvent === 'monster_frenzy' ? 1.35 : 1.0;
  for (const m of sim.monsters) {
    if (!m.alive || m.kind === 'boss') continue;
    const floor = tileAt(sim, Math.round(m.x), Math.round(m.y));
    if (!floor || floor.gone || !floor.isLand || floor.r > currentRadius) {
      const safe = nearestSafeGround(sim, m); m.x = safe.x; m.y = safe.y;
    }
    m.hitFlash = Math.max(0, m.hitFlash - dt);
    m.attackCd = Math.max(0, m.attackCd - dt);

    // 寻找最近的存活角色追逐（限制仇恨半径；同一角色最多被 2 只怪贴身，避免围殴秒杀）
    let closestActor: ActorState | null = null;
    let minD = MONSTER_AGGRO_RADIUS;
    for (const a of aliveActors(sim)) {
      const d = dist(m, a);
      if (d < minD) {
        minD = d;
        closestActor = a;
      }
    }
    if (closestActor) {
      // 按距离统计真正贴身的怪（attackCd 多数为 0，不能作为交战判据）
      const engaged = sim.monsters.filter(
        (o) => o.alive && o.id !== m.id && dist(o, closestActor!) < 1.1,
      ).length;
      if (engaged >= MAX_MONSTERS_PER_TARGET) {
        closestActor = null;
      }
    }

    if (closestActor) {
      const dx = closestActor.x - m.x;
      const dy = closestActor.y - m.y;
      const dlen = Math.hypot(dx, dy) || 1;
      const msp = m.speed * frenzyMultiplier * dt;
      // 怪物统一遵守安全地面：目标落点不安全则取消本次位移（不悬空漫游）
      const nextMx = m.x + (dx / dlen) * msp;
      const nextMy = m.y + (dy / dlen) * msp;
      const mt = tileAt(sim, Math.round(nextMx), Math.round(nextMy));
      if (mt && mt.isLand && !mt.gone && mt.r <= currentRadius - 0.04) {
        const slid = slideMove(sim, m.x, m.y, nextMx - m.x, nextMy - m.y);
        m.x = slid.x; m.y = slid.y;
      }

      // 触碰攻击角色（带 0.2s 受击硬直无敌防瞬间多怪秒杀）
      const playerProtected =
        closestActor.isPlayer && sim.elapsed < PLAYER_SPAWN_PROTECTION_SECONDS;
      if (!segmentBlockedByCover(sim, m.x, m.y, closestActor.x, closestActor.y) && minD < 0.85 && m.attackCd <= 0 && closestActor.hitFlash <= 0 && !playerProtected) {
        m.attackCd = 2.0;
        resolveHostileHit(sim, closestActor, m.damage, null);
        if (sim.gameOver) return;
      }
      // 保护期内怪物也不主动贴近玩家（避免视觉上围殴但打不动）
      if (closestActor.isPlayer && sim.elapsed < PLAYER_SPAWN_PROTECTION_SECONDS) {
        m.x -= (dx / dlen) * msp;
        m.y -= (dy / dlen) * msp;
      }
    }
  }

  // 9. 怪物波次动态刷新（仅在当前安全陆地生成）
  for (const m of sim.monsters) {
    if (!m.alive && m.kind !== 'boss') {
      m.respawn -= dt * (sim.activeEvent === 'monster_frenzy' ? 2.2 : 1.0);
    }
  }
  const activeMonsters = sim.monsters.filter((m) => m.alive && m.kind !== 'boss');
  if (activeMonsters.length < sim.maxMonsters) {
    const deadMonster = sim.monsters.find((m) => !m.alive && m.kind !== 'boss' && m.respawn <= 0);
    if (deadMonster) {
      // 寻找一个安全未崩塌陆地网格
      for (let tries = 0; tries < 15; tries++) {
        const gx = Math.floor(center + (Math.random() - 0.5) * 24);
        const gy = Math.floor(center + (Math.random() - 0.5) * 24);
        const t = tileAt(sim, gx, gy);
        if (t && t.isLand && !t.gone && t.r <= currentRadius - 0.1) {
          const x = gx + (Math.random() - 0.5) * 0.8, y = gy + (Math.random() - 0.5) * 0.8;
          const actualTile = tileAt(sim, Math.round(x), Math.round(y));
          if (isInsideCover(sim, x, y) || !actualTile?.isLand || actualTile.gone || actualTile.r > currentRadius - 0.04) continue;
          deadMonster.x = x;
          deadMonster.y = y;
          deadMonster.hp = deadMonster.maxHp;
          deadMonster.alive = true;
          deadMonster.respawn = 0;
          break;
        }
      }
    }
  }

  // 10. 宝箱实时中点跟随与属性刷新
  for (const c of sim.chests) {
    if (c.hp <= 0 && c.treasure <= 0) continue;
    const a = sim.actors[c.a]!;
    const b = sim.actors[c.b]!;
    if (!a.alive || !b.alive || a.team < 0) {
      destroyChest(sim, c, c.x, c.y);
      continue;
    }
    c.x = (a.x + b.x) / 2;
    c.y = (a.y + b.y) / 2;
    c.maxHp = 60 + c.treasure * 6;
    c.hp = Math.min(c.hp, c.maxHp);
    c.hitFlash = Math.max(0, c.hitFlash - dt);
  }

  // 11. 基础自动攻击：残血抢宝者 > 高价值敌箱 > Boss / 精英 > 普通怪
  for (const a of aliveActors(sim)) {
    if (sim.gameOver) return;
    if (a.attackCd > 0) continue;
    let targetMonster: MonsterState | null = null;
    let targetActor: ActorState | null = null;
    let targetChest: ChestState | null = null;
    const reach = 2.7 * (1 + a.statAreaBonus);
    const targets: Array<{ score: number; distance: number; monster?: MonsterState; actor?: ActorState; chest?: ChestState }> = [];
    for (const m of sim.monsters) {
      if (!m.alive || (m.kind === 'boss' && sim.raidPhase !== 'fight')) continue;
      const d = dist(a, m);
      if (d <= reach && !segmentBlockedByCover(sim, a.x, a.y, m.x, m.y)) targets.push({ score: m.kind === 'boss' ? 250 : m.kind === 'tank' ? 220 : 100, distance: d, monster: m });
    }
    for (const c of sim.chests) {
      const d = dist(a, c);
      if (c.hp > 0 && c.a !== a.id && c.b !== a.id && d <= reach && !segmentBlockedByCover(sim, a.x, a.y, c.x, c.y)) targets.push({ score: 400 + c.treasure, distance: d, chest: c });
    }
    for (const o of aliveActors(sim)) {
      if (o === a || o.id === a.team) continue;
      const d = dist(a, o);
      const looting = o.hp / o.maxHp < 0.4 && sim.loots.some(l => l.value > 0 && dist(l, o) < 1.5);
      if (d <= reach && !segmentBlockedByCover(sim, a.x, a.y, o.x, o.y)) targets.push({ score: looting ? 600 : d <= 1.2 ? 200 : 50, distance: d, actor: o });
    }
    const chosen = targets.sort((p, q) => q.score - p.score || p.distance - q.distance)[0];
    if (chosen) { targetMonster = chosen.monster ?? null; targetActor = chosen.actor ?? null; targetChest = chosen.chest ?? null; }

    if (targetChest) {
      const effAtkSpd = calculateEffectiveAttackSpeed(
        a.statAttackSpeedBonus,
        sim.worldMultipliers.attackSpeed,
        a.personalMultiplier,
      );
      a.attackCd = Math.max(MIN_LEGAL_CYCLE, (0.7 - a.treasure * 0.008) / effAtkSpd);
      const dmg = calculateAttackDamage(sim, a) * sim.rules.weaponModifiers.melee;
      if (segmentBlockedByCover(sim, a.x, a.y, targetChest.x, targetChest.y)) continue;
      targetChest.hp -= dmg * sim.rules.bossDamageModifier;
      targetChest.hitFlash = 0.2;
      burst(sim, targetChest.x, targetChest.y, '#ffb45c', 5);
      if (targetChest.hp <= 0) {
        destroyChest(sim, targetChest, targetChest.x, targetChest.y, true);
        pulse(sim, '宝箱被打爆！队伍关系仍保留', targetChest.x, targetChest.y, '#ff8a6a');
      }
      continue;
    }

    if (targetMonster && segmentBlockedByCover(sim, a.x, a.y, targetMonster.x, targetMonster.y)) {
      // 掩体挡住视线：本次不攻击（保留走位绕柱博弈）
      continue;
    }

    if (targetMonster) {
      const effAtkSpd = calculateEffectiveAttackSpeed(
        a.statAttackSpeedBonus,
        sim.worldMultipliers.attackSpeed,
        a.personalMultiplier,
      );
      a.attackCd = Math.max(MIN_LEGAL_CYCLE, (0.7 - a.treasure * 0.008) / effAtkSpd);
      const dmg = calculateAttackDamage(sim, a) * sim.rules.weaponModifiers.melee;
      const crit = calculateEffectiveCrit(sim.effectiveMultipliers.critChance, a.personalMultiplier);
      const hit = resolveHitDamage(
        dmg,
        crit.critChance,
        crit.critMultiplier,
        sim.rng ?? Math.random,
      );
      damageMonster(sim, targetMonster, hit.damage, a);
    } else if (targetActor) {
      if (segmentBlockedByCover(sim, a.x, a.y, targetActor.x, targetActor.y)) {
        continue;
      }
      const effAtkSpd = calculateEffectiveAttackSpeed(
        a.statAttackSpeedBonus,
        sim.worldMultipliers.attackSpeed,
        a.personalMultiplier,
      );
      a.attackCd = Math.max(MIN_LEGAL_CYCLE, (0.7 - a.treasure * 0.008) / effAtkSpd);
      const dmg = calculateAttackDamage(sim, a) * sim.rules.weaponModifiers.melee;
      resolveHostileHit(sim, targetActor, dmg, a);
      if (sim.gameOver) return;
    }
  }

  // 12. 附加武器步进（飞刀/穿透箭/范围爆轰）
  stepWeapons(sim, dt);
  if (sim.gameOver) return;

  // 13. 自由宝物物理模拟与拾取
  for (const l of sim.loots) {
    l.life -= dt;
    l.x += l.vx * dt * 2.2;
    l.y += l.vy * dt * 2.2;
    l.z += l.vz * dt * 3.0;
    l.vz -= 14 * dt;
    if (l.z < 0) {
      l.z = 0;
      l.vz = Math.abs(l.vz) > 1.2 ? -l.vz * 0.42 : 0;
      l.vx *= 0.7;
      l.vy *= 0.7;
    }
    if (l.value && l.z < 1.5) {
      for (const a of aliveActors(sim)) {
        if (dist(a, l) < 0.8) {
          a.treasure += l.value;
          if (a.isPlayer) sim.playerTreasure += l.value;
          a.slow = 0.45;
          pulse(sim, '+1', a.x, a.y, '#ffe27a');
          l.value = 0;
          l.life = 0;
          break;
        }
      }
    }
  }
  for (let i = sim.loots.length - 1; i >= 0; i--) {
    if (sim.loots[i]!.life <= 0) sim.loots.splice(i, 1);
  }

  // 14. 粒子与飘字生命周期
  for (let i = sim.particles.length - 1; i >= 0; i--) {
    const p = sim.particles[i]!;
    p.x += p.vx * dt * 3.0;
    p.y += p.vy * dt * 3.0;
    p.z += p.vz * dt * 4.0;
    p.vz -= 12 * dt;
    if (p.z < 0) {
      p.z = 0;
      p.vz = 0;
    }
    p.life -= dt;
    if (p.life <= 0) sim.particles.splice(i, 1);
  }

  for (let i = sim.floats.length - 1; i >= 0; i--) {
    const f = sim.floats[i]!;
    f.life -= dt;
    if (f.life <= 0) sim.floats.splice(i, 1);
  }

  // 15. 胜负结局检查
  checkGameOver(sim);
}
