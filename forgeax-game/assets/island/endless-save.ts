// 《荒岛分赃》无限模式持久存档（浏览器本地存储，最小实现）
// 纯函数：序列化 / 反序列化 / 合法性校验。Storage 访问由 UI realm 负责，
// 引擎域通过消息通道交接，不在纯模拟层直接调用 DOM/Storage API。

import {
  MAX_LOSS_BURDEN,
  STAT_FACTORS,
  STAT_TARGETS,
  type CarryRelic,
  type EndlessProfile,
  type GlobalRule,
  type RelicAffix,
  type StatFactor,
  type StatTarget,
} from './stats.ts';

export const ENDLESS_SAVE_KEY = 'island.endless.save.v1';
export const ENDLESS_SAVE_VERSION = 1;

export type EndlessPhase = 'round-start' | 'round-result' | 'rule-pick' | 'relic-pick';

export interface EndlessSaveV1 {
  version: 1;
  savedAt: string;
  mode: 'endless';
  roundIndex: number;
  completedRounds: number;
  challengeElapsed: number;
  lastSettledRound: number;
  profiles: EndlessProfile[];
  phase: EndlessPhase;
  pendingRule?: GlobalRule | null;
  pendingRelic?: CarryRelic | null;
}

export interface EndlessSaveInput {
  roundIndex: number;
  completedRounds: number;
  challengeElapsed: number;
  lastSettledRound: number;
  profiles: Iterable<EndlessProfile>;
  phase: EndlessPhase;
  pendingRule?: GlobalRule | null;
  pendingRelic?: CarryRelic | null;
  now?: Date;
}

const RELIC_KINDS: ReadonlyArray<CarryRelic['kind']> = ['knife', 'arrow', 'bomb'];
const RELIC_AFFIXES: ReadonlyArray<RelicAffix> = ['knifeArea', 'arrowPierce', 'bombRadius'];
const PHASES: ReadonlyArray<EndlessPhase> = ['round-start', 'round-result', 'rule-pick', 'relic-pick'];

function isStatTarget(v: unknown): v is StatTarget {
  return typeof v === 'string' && (STAT_TARGETS as readonly string[]).includes(v);
}

function isStatFactor(v: unknown): v is StatFactor {
  return typeof v === 'number' && (STAT_FACTORS as readonly number[]).includes(v);
}

function sanitizeRule(raw: unknown): GlobalRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.ownerId) || (r.ownerId as number) < 0 || (r.ownerId as number) > 9) return null;
  if (!isStatTarget(r.stat)) return null;
  if (!isStatFactor(r.factor)) return null;
  if (!Number.isInteger(r.chosenAtRound) || (r.chosenAtRound as number) < 1) return null;
  return {
    ownerId: r.ownerId as number,
    stat: r.stat,
    factor: r.factor,
    chosenAtRound: r.chosenAtRound as number,
  };
}

function sanitizeRelic(raw: unknown): CarryRelic | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !RELIC_KINDS.includes(r.kind as CarryRelic['kind'])) return null;
  const level = Number(r.level);
  if (!Number.isInteger(level) || level < 1 || level > 3) return null;
  const affix =
    typeof r.affix === 'string' && RELIC_AFFIXES.includes(r.affix as RelicAffix)
      ? (r.affix as RelicAffix)
      : undefined;
  return { kind: r.kind as CarryRelic['kind'], level, ...(affix ? { affix } : {}) };
}

function sanitizeProfile(raw: unknown): EndlessProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const actorId = Number(r.actorId);
  if (!Number.isInteger(actorId) || actorId < 0 || actorId > 9) return null;
  const endlessRound = Number(r.endlessRound);
  if (!Number.isInteger(endlessRound) || endlessRound < 1) return null;
  const lossBurdenRaw = Number(r.lossBurden ?? 0);
  const lossBurden = Number.isFinite(lossBurdenRaw)
    ? Math.max(0, Math.min(MAX_LOSS_BURDEN, Math.round(lossBurdenRaw)))
    : 0;
  const rules = Array.isArray(r.rules)
    ? r.rules.map(sanitizeRule).filter((x): x is GlobalRule => x !== null)
    : [];
  const carryRelic = sanitizeRelic(r.carryRelic);
  return { actorId, endlessRound, rules, carryRelic, lossBurden };
}

/** 序列化为可写入 localStorage 的 JSON 字符串 */
export function serializeEndlessSave(input: EndlessSaveInput): string {
  const profiles: EndlessProfile[] = [];
  for (const p of input.profiles) {
    const sanitized = sanitizeProfile(p);
    if (sanitized) profiles.push(sanitized);
  }
  const save: EndlessSaveV1 = {
    version: ENDLESS_SAVE_VERSION,
    savedAt: (input.now ?? new Date()).toISOString(),
    mode: 'endless',
    roundIndex: Math.max(1, Math.round(input.roundIndex)),
    completedRounds: Math.max(0, Math.round(input.completedRounds)),
    challengeElapsed: Math.max(0, Number(input.challengeElapsed) || 0),
    lastSettledRound: Math.max(0, Math.round(input.lastSettledRound)),
    profiles,
    phase: PHASES.includes(input.phase) ? input.phase : 'round-start',
    pendingRule: sanitizeRule(input.pendingRule),
    pendingRelic: sanitizeRelic(input.pendingRelic),
  };
  return JSON.stringify(save);
}

/** 解析并校验存档；损坏返回 null（不偷偷覆盖） */
export function parseEndlessSave(raw: string | null | undefined): EndlessSaveV1 | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.version !== ENDLESS_SAVE_VERSION) return null;
  if (d.mode !== 'endless') return null;

  const roundIndex = Number(d.roundIndex);
  if (!Number.isInteger(roundIndex) || roundIndex < 1) return null;

  const profilesRaw = Array.isArray(d.profiles) ? d.profiles : [];
  const profiles = profilesRaw.map(sanitizeProfile).filter((p): p is EndlessProfile => p !== null);
  // 必须覆盖全部 10 名固定参赛者，否则视为损坏（避免缺档静默续用）
  if (profiles.length !== 10) return null;
  const ids = new Set(profiles.map((p) => p.actorId));
  for (let i = 0; i < 10; i++) if (!ids.has(i)) return null;

  const phase = PHASES.includes(d.phase as EndlessPhase)
    ? (d.phase as EndlessPhase)
    : 'round-start';

  return {
    version: ENDLESS_SAVE_VERSION,
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : '',
    mode: 'endless',
    roundIndex,
    completedRounds: Math.max(0, Math.round(Number(d.completedRounds) || 0)),
    challengeElapsed: Math.max(0, Number(d.challengeElapsed) || 0),
    lastSettledRound: Math.max(0, Math.round(Number(d.lastSettledRound) || 0)),
    profiles,
    phase,
    pendingRule: sanitizeRule(d.pendingRule),
    pendingRelic: sanitizeRelic(d.pendingRelic),
  };
}
