// 《荒岛分赃》核心规则与模拟状态模块
// 纯 TypeScript 逻辑，无 DOM、Canvas 或外部运行时依赖。
// 规则：靠近选择 -> 双方同意组队 -> 连线与共享宝箱 -> 拉开距离断线 -> 中点爆箱 -> 争抢

export interface Vec2 {
  x: number;
  y: number;
}

export const GRID_SIZE = 23;
export const MATCH_SECONDS = 300;

export const ALLY_INTERACT_DISTANCE = 2.4;
export const ALLY_INVITE_TTL = 5.0;
export const ALLY_IGNORE_SECONDS = 60.0;
export const TEAM_WARNING_DISTANCE = 4.0;
export const TEAM_BREAK_DISTANCE = 5.0;

export const PLAYER_COLORS = [
  '#e05a4f', '#3f8ee0', '#e8b53c', '#5fbf6a', '#a06bdd',
  '#ef7fb0', '#43c6c0', '#f08a3c', '#8fa84b', '#dcd0b4',
] as const;

export const PLAYER_NAMES = [
  '赤羽', '青岚', '金砂', '碧藤', '紫电', '绯樱', '苍潮', '橙焰', '苔原', '白垩',
] as const;

export type AiPersonality = 'honest' | 'greedy' | 'raider';

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
}

export interface MonsterState {
  readonly id: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  respawn: number;
  wobble: number;
  hitFlash: number;
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
  reason: 'distance' | 'final' | 'fall';
}

export interface CandidateInfo {
  id: number;
  name: string;
  distance: number;
  canInvite: boolean;
  reason?: string;
}

export interface PlayerInputIntent {
  moveX: number;
  moveY: number;
  dash: boolean;
  inviteTargetId?: number | null;
  acceptInviteId?: number | null;
  ignoreTargetId?: number | null;
  speedToggle: boolean;
  restart: boolean;
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
  nextEntityId: number;
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

export function landRadius(shrink: number): number {
  return 0.98 * (1 - shrink * 0.62);
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

/** 建立双方 60 秒双向屏蔽，已有活跃屏蔽不重复延长 */
export function ignorePair(sim: SimulationState, a: number, b: number): boolean {
  if (a === b) return false;
  const fromActor = sim.actors[a];
  const toActor = sim.actors[b];
  if (!fromActor || !toActor || !fromActor.alive || !toActor.alive || sim.gameOver) return false;

  // 已有活跃屏蔽不重复刷新时长（R04）
  if (isPairIgnored(sim, a, b)) return false;

  const key = getPairKey(a, b);
  sim.ignores.set(key, sim.elapsed + ALLY_IGNORE_SECONDS);

  // 清除涉及该对的待处理邀请
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

export function createInitialSimulation(): SimulationState {
  const center = (GRID_SIZE - 1) / 2;
  const tiles: TileState[] = [];

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
          height = 1;
        } else if (n < 0.35) {
          type = 'moss';
          height = 0;
        } else {
          type = 'grass';
          height = 0;
        }
        if (height === 0 && n > 0.88 && r < 0.78) {
          decor = n > 0.96 ? 'crystal' : n > 0.92 ? 'bush' : 'rock';
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
    const rad = 3.2 + (i % 3) * 1.4;
    actors.push({
      id: i,
      name: PLAYER_NAMES[i] ?? `角色${i}`,
      color: PLAYER_COLORS[i] ?? '#ffffff',
      isPlayer: i === 0,
      x: center + Math.cos(a) * rad,
      y: center + Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      hp: 100,
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
    });
  }

  const monsters: MonsterState[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    monsters.push({
      id: i,
      x: center + Math.cos(a) * (5 + (i % 2)),
      y: center + Math.sin(a) * (5 + (i % 2)),
      hp: 3,
      alive: true,
      respawn: 0,
      wobble: i,
      hitFlash: 0,
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
    nextEntityId: 100,
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
      vx: (Math.random() - 0.5) * 2.4,
      vy: (Math.random() - 0.5) * 2.4,
      vz: 2.5 + Math.random() * 3.5,
      value: 1,
      life: 26,
      spin: Math.random() * 6,
    });
  }
  burst(sim, x, y, '#ffd257', Math.min(24, 6 + count * 2));
}

/** 破坏有效宝箱（R01 修复）：释放全部所含财物并置为无效，单次生效，不解除队伍关系 */
export function destroyChest(sim: SimulationState, chest: ChestState, originX: number, originY: number): number {
  if (chest.hp <= 0 && chest.treasure <= 0) return 0;
  const count = chest.treasure;
  chest.treasure = 0;
  chest.hp = 0;
  sim.chestBreaks++;
  if (count > 0) {
    scatterLoot(sim, originX, originY, count);
  }
  burst(sim, originX, originY, '#ffd257', 18);
  return count;
}

/** 原子解除两人队伍关系。若是超距触发，在两当时位置中点引爆共享宝箱（如有） */
export function disbandTeam(sim: SimulationState, a: ActorState, reason: 'distance' | 'final' | 'fall'): void {
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
  a.runningAwayFromPartner = false;
  b.runningAwayFromPartner = false;

  if (reason === 'distance') {
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
}

/** 双方同意成队：建立互指关系与初始共享宝箱 */
export function formTeam(sim: SimulationState, a: ActorState, b: ActorState): boolean {
  if (
    !a.alive ||
    !b.alive ||
    a.team >= 0 ||
    b.team >= 0 ||
    a.id === b.id ||
    sim.finalPhase ||
    sim.gameOver ||
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

  // 成队后清除两人相关的待处理邀请
  sim.invites = sim.invites.filter((inv) => inv.fromId !== a.id && inv.toId !== a.id && inv.fromId !== b.id && inv.toId !== b.id);

  pulse(sim, '结盟成功！', cx, cy, '#8ef0a8');
  return true;
}

/** 发送组队邀请（R08 校验单一邀请限制与反向直接同意） */
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
    isPairIgnored(sim, fromId, toId) ||
    dist(from, to) > ALLY_INTERACT_DISTANCE
  ) {
    return false;
  }

  // 若对方此前已经向我发送过有效邀请：双向同时同意，直接原子成队
  const reverse = sim.invites.find((inv) => inv.fromId === toId && inv.toId === fromId && sim.elapsed <= inv.expiresAt);
  if (reverse) {
    return formTeam(sim, from, to);
  }

  // 严格单一邀请参与约束：发起方或接收方正在处理其他有效邀请时，不覆盖并返回 busy
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

/** 接受组队邀请 */
export function acceptInvite(sim: SimulationState, inviteId: number, recipientId: number): boolean {
  const inv = sim.invites.find((i) => i.id === inviteId && i.toId === recipientId && sim.elapsed <= i.expiresAt);
  if (!inv) return false;

  const from = sim.actors[inv.fromId];
  const to = sim.actors[inv.toId];
  if (!from || !to) return false;

  return formTeam(sim, from, to);
}

/** 查询离某角色最近的候选可交互角色（R04 过滤屏蔽对象，被忽略的不阻碍选择其他合资格者） */
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
  const alive = aliveActors(sim);
  if (alive.length <= 1 || sim.elapsed >= MATCH_SECONDS) {
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
  // 记录真实淘汰名次（R02）
  a.rank = aliveActors(sim).length + 1;

  if (a.team >= 0) {
    disbandTeam(sim, a, 'fall');
  }
  // 清理涉及淘汰角色的邀请
  sim.invites = sim.invites.filter((inv) => inv.fromId !== a.id && inv.toId !== a.id);
  burst(sim, a.x, a.y, a.color, 18);
  pulse(sim, `${a.name} 淘汰`, a.x, a.y, '#ff9a8a');
  void reason;

  checkGameOver(sim);
}

/** 计算攻击伤害：包含个人财物增益与结盟/宝箱财富加成（R09） */
export function calculateAttackDamage(sim: SimulationState, attacker: ActorState): number {
  let damage = 10; // 基础伤害
  // 个人宝物增益：每个宝物 +0.5 伤害，上限 +10
  damage += Math.min(10, attacker.treasure * 0.5);

  // 结盟合作增益：有队友时 +3 伤害
  if (attacker.team >= 0) {
    damage += 3;
    // 共享宝箱财富加成：宝箱内每宝物 +0.5 伤害，上限 +5
    const chest = chestOf(sim, attacker.team);
    if (chest && (chest.hp > 0 || chest.treasure > 0)) {
      damage += Math.min(5, chest.treasure * 0.5);
    }
  }
  return Math.round(damage);
}

export function damageActor(sim: SimulationState, target: ActorState, amount: number, from: ActorState | null): void {
  target.hp -= amount;
  target.hitFlash = 0.2;
  burst(sim, target.x, target.y, '#ff8a8a', 4);
  if (target.hp <= 0) {
    eliminate(sim, target, 'hp');
    if (from) from.kills++;
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

/** 统一队伍距离与断线检测：在所有移动与击退位移结算后统一判定 */
export function checkTeamDistances(sim: SimulationState): void {
  for (const a of sim.actors) {
    if (!a.alive || a.team < 0 || a.id > a.team) continue;
    const b = sim.actors[a.team];
    if (!b || !b.alive) {
      disbandTeam(sim, a, 'fall');
      continue;
    }
    const d = dist(a, b);
    if (d > TEAM_BREAK_DISTANCE) {
      disbandTeam(sim, a, 'distance');
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
      let acceptProb = 0.8;
      if (a.ai === 'greedy') acceptProb = 0.65;
      else if (a.ai === 'raider') acceptProb = 0.35;

      if (Math.random() < acceptProb) {
        acceptInvite(sim, pendingToMe.id, a.id);
        return;
      } else {
        ignorePair(sim, a.id, fromActor.id);
        return;
      }
    }
  }

  // 2. 抢自由宝物优先（合作状态下受队友距离约束，R05）
  let bestLoot: LootState | null = null;
  let bl = 7;
  const partner = partnerOf(sim, a);

  for (const l of sim.loots) {
    if (!l.value || l.z > 2) continue;
    const d = dist(a, l);
    if (d < bl) {
      // 若处于正常合作中且未背叛：宝物不能远离队友，否则放弃避免意外拉断
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

    // 贪财 AI 在宝箱足够大时产生背叛意图：真实远离队友以触发距离断线
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

    // 正常合作：跟随在队友附近（保持 1.5~2.8 距离以内，避免拉断线）
    a.aim = {
      x: (a.x + partner.x) / 2 + (Math.random() - 0.5) * 2.0,
      y: (a.y + partner.y) / 2 + (Math.random() - 0.5) * 2.0,
    };
    return;
  } else if (!sim.finalPhase && a.ai !== 'raider') {
    // 5. 单人未组队：寻找附近未组队未屏蔽角色并发送组队邀请
    const candidate = getNearbyCandidate(sim, a);
    if (candidate && candidate.canInvite) {
      sendInvite(sim, a.id, candidate.id);
      return;
    }
  }

  // 6. 攻击附近怪物
  const monster = sim.monsters
    .filter((m) => m.alive)
    .sort((p, q) => dist(a, p) - dist(a, q))[0];
  if (monster) {
    a.aim = {
      x: monster.x + (Math.random() - 0.5) * 2,
      y: monster.y + (Math.random() - 0.5) * 2,
    };
    return;
  }

  a.aim = {
    x: center + (Math.random() - 0.5) * 7,
    y: center + (Math.random() - 0.5) * 7,
  };
}

export function restartSimulation(sim: SimulationState): void {
  const initial = createInitialSimulation();
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
  if (sim.gameOver && input.restart) {
    restartSimulation(sim);
    return;
  }

  // 结局后冻结全部游戏规则（R02）
  if (sim.gameOver) {
    return;
  }

  const dt = dtRaw * sim.speed;
  const center = (GRID_SIZE - 1) / 2;
  const player = sim.actors[0]!;

  sim.elapsed += dt;
  const progress = sim.elapsed / MATCH_SECONDS;
  sim.shrink = clamp((progress - 0.38) / 0.5, 0, 1);

  if (progress >= 0.8 && !sim.finalPhase) {
    sim.finalPhase = true;
    for (const a of aliveActors(sim)) {
      if (a.team >= 0) {
        disbandTeam(sim, a, 'final');
      }
    }
    sim.invites.length = 0;
  }

  // 地块崩塌判定
  const currentRadius = landRadius(sim.shrink);
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

  // 1. 处理玩家目标邀请与忽略输入
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

  // 3. 玩家位移输入
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

  // 5. 移动物理位移与阻尼
  for (const a of aliveActors(sim)) {
    if (!a.isPlayer) {
      const dl = Math.hypot(a.aim.x - a.x, a.aim.y - a.y);
      a.vx = dl > 0.25 ? ((a.aim.x - a.x) / dl) * 0.82 : 0;
      a.vy = dl > 0.25 ? ((a.aim.y - a.y) / dl) * 0.82 : 0;
      if (Math.hypot(a.vx, a.vy) > 0.05) {
        a.facing = Math.atan2(a.vy, a.vx);
      }
    }
    const slow = a.slow > 0 ? 0.55 : 1;
    const sp = 3.1 * slow * dt;
    a.x = clamp(a.x + a.vx * sp, 0.5, GRID_SIZE - 1.5);
    a.y = clamp(a.y + a.vy * sp, 0.5, GRID_SIZE - 1.5);
    a.slow = Math.max(0, a.slow - dt);
    a.dashCd = Math.max(0, a.dashCd - dt);
    a.attackCd = Math.max(0, a.attackCd - dt);
    a.hitFlash = Math.max(0, a.hitFlash - dt);
  }

  // 6. 移动后优先执行本步边缘坠落与淘汰判定（R05：坠落优先于超距断线）
  for (const a of aliveActors(sim)) {
    const t = tileAt(sim, Math.round(a.x), Math.round(a.y));
    if (!t || !t.isLand || t.gone || t.r > currentRadius) {
      eliminate(sim, a, 'fall');
    }
  }

  // 7. 统一队伍距离与断线检测（仅对仍存活的队伍对检测）
  checkTeamDistances(sim);

  // 8. 宝箱实时中点跟随与属性刷新
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

  // 9. 自动攻击判断（遵循最近有效敌对目标，包含财物与结盟攻击收益计算，R09）
  for (const a of aliveActors(sim)) {
    if (a.attackCd > 0) continue;
    let targetMonster: MonsterState | null = null;
    let targetActor: ActorState | null = null;
    let td = 2.7;

    for (const m of sim.monsters) {
      if (!m.alive) continue;
      const d = dist(a, m);
      if (d < td) {
        td = d;
        targetMonster = m;
        targetActor = null;
      }
    }

    for (const o of aliveActors(sim)) {
      if (o === a || a.team === o.id) continue;
      const d = dist(a, o);
      if (d < td) {
        td = d;
        targetActor = o;
        targetMonster = null;
      }
    }

    if (targetMonster) {
      a.attackCd = Math.max(0.55, 0.7 - a.treasure * 0.008);
      const dmg = Math.round(1 + a.treasure * 0.1);
      targetMonster.hp -= dmg;
      targetMonster.hitFlash = 0.2;
      burst(sim, targetMonster.x, targetMonster.y, '#c8a2ff', 5);
      if (targetMonster.hp <= 0) {
        targetMonster.alive = false;
        targetMonster.respawn = 9;
        const c = a.team >= 0 ? chestOf(sim, a.team) : null;
        if (c && c.hp > 0) {
          c.treasure += 2;
          pulse(sim, '+2 宝物', c.x, c.y, '#ffe27a');
        } else {
          a.treasure += 2;
          if (a.isPlayer) sim.playerTreasure += 2;
        }
        scatterLoot(sim, targetMonster.x, targetMonster.y, 1);
      }
    } else if (targetActor) {
      a.attackCd = Math.max(0.55, 0.7 - a.treasure * 0.008);
      const dmg = calculateAttackDamage(sim, a);

      if (targetActor.team >= 0) {
        const c = chestOf(sim, targetActor.team);
        if (c && (c.hp > 0 || c.treasure > 0)) {
          c.hp -= dmg;
          c.hitFlash = 0.2;
          burst(sim, c.x, c.y, '#ffb45c', 5);
          if (c.hp <= 0) {
            // 外部打爆宝箱：释放全部战利品，但原队伍双方保持结盟关系！（R01 修复）
            destroyChest(sim, c, c.x, c.y);
            pulse(sim, '宝箱被打爆！队伍关系仍保留', c.x, c.y, '#ff8a6a');
          }
        } else {
          damageActor(sim, targetActor, dmg, a);
        }
      } else {
        damageActor(sim, targetActor, dmg, a);
      }
    }
  }

  // 10. 怪物重生
  for (const m of sim.monsters) {
    m.hitFlash = Math.max(0, m.hitFlash - dt);
    if (m.alive) continue;
    m.respawn -= dt;
    if (m.respawn <= 0) {
      const a = Math.random() * Math.PI * 2;
      m.x = center + Math.cos(a) * (3 + Math.random() * 4);
      m.y = center + Math.sin(a) * (3 + Math.random() * 4);
      m.hp = 3;
      m.alive = true;
    }
  }

  // 11. 自由宝物物理模拟与拾取
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
          a.treasure = Math.min(30, a.treasure + 1);
          if (a.isPlayer) sim.playerTreasure += 1;
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

  // 12. 粒子与飘字生命周期
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

  // 13. 胜负与结局判定
  if (!sim.gameOver) {
    const alive = aliveActors(sim);
    if (alive.length <= 1 || sim.elapsed >= MATCH_SECONDS) {
      sim.gameOver = true;
      sim.winner = alive[0] ?? null;
      if (sim.winner) {
        sim.winner.rank = 1;
      }
    }
  }
}
