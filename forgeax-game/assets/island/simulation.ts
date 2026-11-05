// 《荒岛合纵：破箱局》核心规则与模拟状态模块
// 纯 TypeScript 逻辑，无 DOM、Canvas 或外部运行时依赖。

export interface Vec2 {
  x: number;
  y: number;
}

export const GRID_SIZE = 23;
export const MATCH_SECONDS = 300;

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
  kickCharge: number;
  dashCd: number;
  attackCd: number;
  slow: number;
  aim: Vec2;
  think: number;
  kills: number;
  hitFlash: number;
  facing: number; // 朝向角度（弧度），用于朝向呈现
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

export interface PlayerInputIntent {
  moveX: number;
  moveY: number;
  dash: boolean;
  interact: boolean;
  kickHeld: boolean;
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
        if (r > 0.84) {
          type = 'sand';
          height = 0;
        } else if (n < 0.12) {
          type = 'stone';
          height = 1;
        } else if (n < 0.20) {
          type = 'crystal';
          height = 1;
        } else if (n < 0.52) {
          type = 'moss';
          height = 0;
        } else {
          type = 'grass';
          height = 0;
        }
        if (height === 0 && n > 0.86 && r < 0.78) {
          decor = n > 0.955 ? 'crystal' : n > 0.925 ? 'tree' : 'rock';
        }
        if (r > 0.9 && n > 0.8) {
          type = 'cliff';
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
      kickCharge: 0,
      dashCd: 0,
      attackCd: 0,
      slow: 0,
      aim: { x: center, y: center },
      think: hash(i, 3, 5) * 2,
      kills: 0,
      hitFlash: 0,
      facing: 0,
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
  return sim.chests.find((c) => c.hp > 0 && (c.a === teamId || c.b === teamId)) ?? null;
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
  burst(sim, x, y, '#ffd257', Math.min(18, 6 + count * 2));
}

export function formTeam(sim: SimulationState, a: ActorState, b: ActorState): void {
  if (!a.alive || !b.alive || a.team >= 0 || b.team >= 0 || a === b) return;
  a.team = b.id;
  b.team = a.id;
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
  pulse(sim, '结盟！', cx, cy, '#8ef0a8');
}

export function breakTeam(sim: SimulationState, a: ActorState, byPlayer: boolean): void {
  const b = partnerOf(sim, a);
  const c = chestOf(sim, a.team);
  if (!b) return;
  if (c) {
    burst(sim, c.x, c.y, '#ffd257', 22);
    scatterLoot(sim, c.x, c.y, c.treasure);
    c.hp = 0;
  }
  sim.chestBreaks++;
  if (byPlayer) sim.betrayals++;
  pulse(sim, byPlayer ? '背叛！' : '宝箱被击爆！', a.x, a.y, '#ff8a6a');
  a.team = -1;
  b.team = -1;
  a.kickCharge = 0;
  b.kickCharge = 0;
}

export function eliminate(sim: SimulationState, a: ActorState, reason: string): void {
  if (!a.alive) return;
  a.alive = false;
  if (a.team >= 0) {
    const b = partnerOf(sim, a);
    if (b) {
      b.team = -1;
      const c = chestOf(sim, a.team);
      if (c) c.hp = 0;
    }
    a.team = -1;
  }
  burst(sim, a.x, a.y, a.color, 18);
  pulse(sim, `${a.name} 淘汰`, a.x, a.y, '#ff9a8a');
  void reason;
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

export function tryInteract(sim: SimulationState, player: ActorState): void {
  if (sim.gameOver || !player.alive) return;
  if (player.team >= 0) return;
  let best: ActorState | null = null;
  let bd = 2.4;
  for (const a of aliveActors(sim)) {
    if (a === player || a.team >= 0) continue;
    const d = dist(player, a);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  if (best) {
    formTeam(sim, player, best);
  } else {
    pulse(sim, '附近没有可结盟的人', player.x, player.y, '#cfd8e0');
  }
}

export function decideAI(sim: SimulationState, a: ActorState): void {
  const center = (GRID_SIZE - 1) / 2;
  const free = aliveActors(sim).filter((o) => o !== a && o.team < 0);

  // 抢宝物优先
  let bestLoot: LootState | null = null;
  let bl = 7;
  for (const l of sim.loots) {
    if (!l.value || l.z > 2) continue;
    const d = dist(a, l);
    if (d < bl) {
      bl = d;
      bestLoot = l;
    }
  }
  if (bestLoot) {
    a.aim = { x: bestLoot.x, y: bestLoot.y };
    return;
  }

  if (sim.finalPhase) {
    const others = aliveActors(sim).filter((o) => o !== a);
    const t = others.sort((p, q) => dist(a, p) - dist(a, q))[0];
    a.aim = t ? { x: t.x, y: t.y } : { x: center, y: center };
    return;
  }

  if (a.team >= 0) {
    const b = partnerOf(sim, a);
    const c = chestOf(sim, a.team);
    if (a.ai === 'greedy' && c && c.treasure >= 7 && Math.random() < 0.22) {
      breakTeam(sim, a, false);
      return;
    }
    if (a.ai === 'raider') {
      const enemyChest = sim.chests
        .filter((x) => x.hp > 0 && x.team !== a.team && x.treasure >= 3)
        .sort((p, q) => dist(a, p) - dist(a, q))[0];
      if (enemyChest) {
        a.aim = { x: enemyChest.x, y: enemyChest.y };
        return;
      }
    }
    if (b) {
      a.aim = {
        x: (a.x + b.x) / 2 + (Math.random() - 0.5) * 3,
        y: (a.y + b.y) / 2 + (Math.random() - 0.5) * 3,
      };
      return;
    }
  } else if (free.length && a.ai !== 'raider') {
    const near = free.sort((p, q) => dist(a, p) - dist(a, q))[0];
    if (near && dist(a, near) < 2.3) {
      formTeam(sim, a, near);
      return;
    }
    if (near && dist(a, near) < 7) {
      a.aim = { x: near.x, y: near.y };
      return;
    }
  }

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

  const dt = dtRaw * sim.speed;
  const center = (GRID_SIZE - 1) / 2;
  const player = sim.actors[0]!;

  if (!sim.gameOver) {
    sim.elapsed += dt;
    const progress = sim.elapsed / MATCH_SECONDS;
    sim.shrink = clamp((progress - 0.38) / 0.5, 0, 1);

    if (progress >= 0.8 && !sim.finalPhase) {
      sim.finalPhase = true;
      for (const a of aliveActors(sim)) {
        if (a.team >= 0) {
          const b = partnerOf(sim, a);
          if (b) {
            const c = chestOf(sim, a.team);
            if (c) {
              scatterLoot(sim, c.x, c.y, c.treasure);
              c.hp = 0;
            }
            a.team = -1;
            b.team = -1;
          }
        }
      }
      pulse(sim, '最终混战 · 结盟解除', center, center, '#ff9a6a');
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

    // 掉出荒岛或缩圈淘汰
    for (const a of aliveActors(sim)) {
      const t = tileAt(sim, Math.round(a.x), Math.round(a.y));
      if (!t || !t.isLand || t.gone || t.r > currentRadius) {
        eliminate(sim, a, 'fall');
      }
    }
  }

  // 玩家输入处理
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

  if (input.interact) {
    tryInteract(sim, player);
  }
  if (input.dash) {
    doDash(sim, player);
  }

  // 踢箱蓄力
  if (player.team >= 0 && input.kickHeld) {
    player.kickCharge += dt;
    if (player.kickCharge >= 1) {
      breakTeam(sim, player, true);
    }
  } else {
    player.kickCharge = 0;
  }

  // AI 决策推进
  for (const a of sim.actors) {
    if (!a.alive || a.isPlayer) continue;
    a.think -= dt;
    if (a.think <= 0) {
      a.think = 0.5 + hash(a.id, Math.floor(sim.elapsed), 11) * 0.7;
      decideAI(sim, a);
    }
  }

  // 移动更新与阻尼
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

    const t = tileAt(sim, Math.round(a.x), Math.round(a.y));
    if (t && t.gone) {
      a.x = center + (a.x - center) * 0.97;
      a.y = center + (a.y - center) * 0.97;
    }
  }

  // 宝箱跟随与生命刷新
  for (const c of sim.chests) {
    if (c.hp <= 0) continue;
    const a = sim.actors[c.a]!;
    const b = sim.actors[c.b]!;
    if (!a.alive || !b.alive || a.team < 0) {
      if (c.treasure > 0) {
        scatterLoot(sim, c.x, c.y, c.treasure);
      }
      c.hp = 0;
      continue;
    }
    c.x = (a.x + b.x) / 2;
    c.y = (a.y + b.y) / 2;
    c.maxHp = 60 + c.treasure * 6;
    c.hp = Math.min(c.hp, c.maxHp);
    c.hitFlash = Math.max(0, c.hitFlash - dt);
  }

  // 自动攻击判断
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

    if (!sim.finalPhase) {
      for (const o of aliveActors(sim)) {
        if (o === a || a.team === o.id) continue;
        const d = dist(a, o);
        if (d < td) {
          td = d;
          targetActor = o;
          targetMonster = null;
        }
      }
    } else {
      for (const o of aliveActors(sim)) {
        if (o === a) continue;
        const d = dist(a, o);
        if (d < td) {
          td = d;
          targetActor = o;
          targetMonster = null;
        }
      }
    }

    if (targetMonster) {
      a.attackCd = 0.7;
      targetMonster.hp -= 1;
      targetMonster.hitFlash = 0.2;
      burst(sim, targetMonster.x, targetMonster.y, '#c8a2ff', 5);
      if (targetMonster.hp <= 0) {
        targetMonster.alive = false;
        targetMonster.respawn = 9;
        const c = a.team >= 0 ? chestOf(sim, a.team) : null;
        if (c) {
          c.treasure += 2;
          pulse(sim, '+2 宝物', c.x, c.y, '#ffe27a');
        } else {
          a.treasure += 2;
          if (a.isPlayer) sim.playerTreasure += 2;
        }
        scatterLoot(sim, targetMonster.x, targetMonster.y, 1);
      }
    } else if (targetActor) {
      a.attackCd = 0.7;
      if (targetActor.team >= 0) {
        const c = chestOf(sim, targetActor.team);
        if (c && c.hp > 0) {
          c.hp -= 12;
          c.hitFlash = 0.2;
          burst(sim, c.x, c.y, '#ffb45c', 5);
          if (c.hp <= 0) {
            scatterLoot(sim, c.x, c.y, c.treasure);
            c.treasure = 0;
            sim.chestBreaks++;
            pulse(sim, '宝箱被打爆！', c.x, c.y, '#ff8a6a');
          }
        } else {
          damageActor(sim, targetActor, 10, a);
        }
      } else {
        damageActor(sim, targetActor, 10, a);
      }
    }
  }

  // 怪物重生
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

  // 自由宝物物理模拟与拾取
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

  // 粒子与飘字生命周期
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

  // 胜负与结局判定
  if (!sim.gameOver) {
    const alive = aliveActors(sim);
    if (alive.length <= 1 || sim.elapsed >= MATCH_SECONDS) {
      sim.gameOver = true;
      sim.winner = alive[0] ?? null;
    }
  }
}
