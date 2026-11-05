// @ts-nocheck
// 《荒岛合纵：破箱局》阶段一可玩原型
// 等距（2.5D）体素渲染 + 核心玩法循环。渲染层挂在 frontend root，
// 保持天工引擎工程骨架与造化插件构建/预览流程不变。

type Vec = { x: number; y: number };

const W = 960;
const H = 540;
const GRID = 23;
const HALF_W = 17;
const HALF_H = 9;
const BLOCK = 14;
const ORIGIN_X = W / 2;
const ORIGIN_Y = 118;
const MATCH_SECONDS = 300;

const PLAYER_COLORS = [
  '#e05a4f', '#3f8ee0', '#e8b53c', '#5fbf6a', '#a06bdd',
  '#ef7fb0', '#43c6c0', '#f08a3c', '#8fa84b', '#dcd0b4',
];

const TERRAIN: Record<string, { top: string; left: string; right: string }> = {
  grass:   { top: '#7cc25a', left: '#4f8a3c', right: '#3c6c30' },
  moss:    { top: '#5fa856', left: '#3f7c42', right: '#2f6136' },
  sand:    { top: '#e2c885', left: '#b99c5b', right: '#927a43' },
  stone:   { top: '#a6adb5', left: '#737d88', right: '#58636d' },
  cliff:   { top: '#8b8f86', left: '#5f655d', right: '#474c46' },
  crystal: { top: '#8fd8e8', left: '#4f9fb8', right: '#3b7893' },
  water:   { top: '#3e82b8', left: '#2a5f8f', right: '#1f4870' },
  deep:    { top: '#244b74', left: '#183754', right: '#122940' },
};

function hash(a: number, b: number, seed = 0): number {
  let h = (a * 374761393 + b * 668265263 + seed * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function dist(a: Vec, b: Vec) { return Math.hypot(a.x - b.x, a.y - b.y); }
function iso(x: number, y: number, z = 0): Vec {
  return { x: ORIGIN_X + (x - y) * HALF_W, y: ORIGIN_Y + (x + y) * HALF_H - z * BLOCK };
}

export function mountIslandGame(): { dispose(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = 'position:fixed;z-index:99999;image-rendering:pixelated;background:#0b1622;touch-action:none;outline:none;';
  canvas.tabIndex = 0;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let scale = 1;
  const resize = () => {
    scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    canvas.style.left = `${(window.innerWidth - W * scale) / 2}px`;
    canvas.style.top = `${(window.innerHeight - H * scale) / 2}px`;
  };
  resize();
  window.addEventListener('resize', resize);

  // ---------- 地图 ----------
  const tiles: any[] = [];
  const center = (GRID - 1) / 2;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
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
        if (r > 0.84) { type = 'sand'; height = 0; }
        else if (n < 0.12) { type = 'stone'; height = 1; }
        else if (n < 0.20) { type = 'crystal'; height = 1; }
        else if (n < 0.52) { type = 'moss'; height = 0; }
        else { type = 'grass'; height = 0; }
        if (height === 0 && n > 0.86 && r < 0.78) decor = n > 0.955 ? 'crystal' : n > 0.925 ? 'tree' : 'rock';
        if (r > 0.9 && n > 0.8) type = 'cliff';
      } else {
        type = r > 1.3 ? 'deep' : 'water';
      }
      tiles.push({ gx, gy, r, isLand, type, height, decor, gone: false, falling: 0, seed: hash(gx, gy, 31) });
    }
  }
  const tileAt = (gx: number, gy: number) =>
    gx >= 0 && gy >= 0 && gx < GRID && gy < GRID ? tiles[gy * GRID + gx] : null;

  // ---------- 实体 ----------
  const names = ['赤羽', '青岚', '金砂', '碧藤', '紫电', '绯樱', '苍潮', '橙焰', '苔原', '白垩'];
  const personalities = ['honest', 'greedy', 'raider'];
  const actors: any[] = [];
  for (let i = 0; i < 10; i++) {
    const a = 0.42 + (i / 10) * Math.PI * 2;
    const rad = 3.2 + (i % 3) * 1.4;
    actors.push({
      id: i, name: names[i], color: PLAYER_COLORS[i], isPlayer: i === 0,
      x: center + Math.cos(a) * rad, y: center + Math.sin(a) * rad,
      vx: 0, vy: 0, hp: 100, alive: true, team: -1, treasure: 0,
      ai: personalities[i % 3], style: i % 4,
      kickCharge: 0, dashCd: 0, attackCd: 0, slow: 0, aim: { x: 0, y: 0 },
      think: hash(i, 3, 5) * 2, kills: 0,
    });
  }
  const monsters: any[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    monsters.push({ x: center + Math.cos(a) * (5 + (i % 2)), y: center + Math.sin(a) * (5 + (i % 2)), hp: 3, alive: true, respawn: 0, wobble: i });
  }
  const chests: any[] = []; // { team, a, b, treasure, hp, x, y }
  const loots: any[] = [];  // 自由拾取的宝物
  const particles: any[] = [];
  const floats: any[] = [];

  let elapsed = 0;
  let speed = 1;
  let gameOver = false;
  let winner: any = null;
  let betrayals = 0;
  let chestBreaks = 0;
  let playerTreasure = 0;
  let shrink = 0;
  let finalPhase = false;
  const keys: Record<string, boolean> = {};
  let joystick = { active: false, id: -1, x: 0, y: 0, dx: 0, dy: 0 };
  let kickHeld = false;
  let lastFrame = performance.now();
  let raf = 0;

  const player = actors[0];

  function pulse(text: string, x: number, y: number, color = '#ffe27a') {
    floats.push({ text, x, y, life: 1.1, color });
  }
  function burst(x: number, y: number, color: string, count = 14) {
    for (let i = 0; i < count; i++) {
      particles.push({ x, y, z: 6 + Math.random() * 8, vx: (Math.random() - 0.5) * 1.7, vy: (Math.random() - 0.5) * 1.7, vz: 2 + Math.random() * 4, life: 0.8 + Math.random() * 0.6, color, size: 3 + Math.floor(Math.random() * 4) });
    }
  }
  function chestOf(id: number) { return chests.find((c) => c.hp > 0 && (c.a === id || c.b === id)); }
  function partner(a: any) { return a.team >= 0 ? actors[a.team] : null; }
  function aliveActors() { return actors.filter((a) => a.alive); }
  function landRadius() { return 0.98 * (1 - shrink * 0.62); }

  function formTeam(a: any, b: any) {
    if (!a.alive || !b.alive || a.team >= 0 || b.team >= 0 || a === b) return;
    a.team = b.id; b.team = a.id;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    chests.push({ team: a.id, a: a.id, b: b.id, treasure: 0, hp: 60, x: cx, y: cy });
    pulse('结盟！', cx, cy, '#8ef0a8');
  }
  function breakTeam(a: any, byPlayer: boolean) {
    const b = partner(a);
    const c = chestOf(a.team);
    if (!b) return;
    if (c) {
      burst(c.x, c.y, '#ffd257', 22);
      for (let i = 0; i < c.treasure; i++) {
        loots.push({ x: c.x, y: c.y, z: 10 + Math.random() * 6, vx: (Math.random() - 0.5) * 2.4, vy: (Math.random() - 0.5) * 2.4, vz: 3 + Math.random() * 4, value: 1, life: 26, spin: Math.random() * 6 });
      }
      c.hp = 0;
    }
    chestBreaks++;
    if (byPlayer) betrayals++;
    pulse(byPlayer ? '背叛！' : '宝箱被击爆！', a.x, a.y, '#ff8a6a');
    a.team = -1; b.team = -1;
    a.kickCharge = 0; b.kickCharge = 0;
  }
  function eliminate(a: any, reason: string) {
    if (!a.alive) return;
    a.alive = false;
    if (a.team >= 0) { const b = partner(a); if (b) { b.team = -1; const c = chestOf(a.team); if (c) c.hp = 0; } a.team = -1; }
    burst(a.x, a.y, a.color, 18);
    pulse(`${a.name} 淘汰`, a.x, a.y, '#ff9a8a');
    void reason;
  }
  function scatterLoot(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      loots.push({ x, y, z: 8 + Math.random() * 8, vx: (Math.random() - 0.5) * 2.2, vy: (Math.random() - 0.5) * 2.2, vz: 3 + Math.random() * 4, value: 1, life: 30, spin: Math.random() * 6 });
    }
    burst(x, y, '#ffd257', 12);
  }

  // ---------- 输入 ----------
  const onKeyDown = (e: KeyboardEvent) => {
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE') tryInteract();
    if (e.code === 'Space') doDash(player);
    if (e.code === 'KeyQ') speed = speed === 1 ? 4 : 1;
  };
  const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function canvasPos(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }
  const onPointerDown = (e: PointerEvent) => {
    canvas.focus();
    const p = canvasPos(e);
    if (Math.hypot(p.x - 112, p.y - 448) < 74) {
      joystick.active = true; joystick.id = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      moveStick(p);
      return;
    }
    if (Math.hypot(p.x - 838, p.y - 452) < 38) { tryInteract(); return; }
    if (Math.hypot(p.x - 758, p.y - 470) < 38) { kickHeld = true; return; }
    if (Math.hypot(p.x - 878, p.y - 388) < 38) { doDash(player); return; }
    if (p.x > 380 && p.x < 580 && p.y > 246 && p.y < 278 && gameOver) restart();
    if (p.x > 800 && p.x < 940 && p.y > 12 && p.y < 44) speed = speed === 1 ? 4 : 1;
  };
  function moveStick(p: Vec) {
    let dx = (p.x - 112) / 58, dy = (p.y - 448) / 58;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    joystick.dx = dx; joystick.dy = dy; joystick.x = p.x; joystick.y = p.y;
  }
  const onPointerMove = (e: PointerEvent) => {
    if (joystick.active && e.pointerId === joystick.id) moveStick(canvasPos(e));
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === joystick.id) { joystick.active = false; joystick.id = -1; joystick.dx = 0; joystick.dy = 0; }
    kickHeld = false;
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  function tryInteract() {
    if (gameOver || !player.alive) return;
    if (player.team >= 0) return;
    let best: any = null, bd = 2.4;
    for (const a of aliveActors()) {
      if (a === player || a.team >= 0) continue;
      const d = dist(player, a);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) formTeam(player, best);
    else pulse('附近没有可结盟的人', player.x, player.y, '#cfd8e0');
  }
  function doDash(a: any) {
    if (!a.alive || a.dashCd > 0) return;
    a.dashCd = 3.2;
    const len = Math.hypot(a.vx, a.vy) || 1;
    const dx = a.vx / len, dy = a.vy / len;
    a.x += dx * 1.1; a.y += dy * 1.1;
    for (const o of aliveActors()) {
      if (o === a || o.team === a.id || a.team === o.id) continue;
      if (dist(a, o) < 1.25) {
        o.x += dx * 1.5; o.y += dy * 1.5;
        burst(o.x, o.y, '#ffffff', 8);
      }
    }
    burst(a.x, a.y, '#bfe9ff', 8);
  }

  // ---------- 更新 ----------
  function update(dt: number) {
    if (!gameOver) {
      elapsed += dt;
      const progress = elapsed / MATCH_SECONDS;
      shrink = clamp((progress - 0.38) / 0.5, 0, 1);
      if (progress >= 0.8 && !finalPhase) {
        finalPhase = true;
        for (const a of aliveActors()) if (a.team >= 0) { const b = partner(a); if (b) { const c = chestOf(a.team); if (c) { scatterLoot(c.x, c.y, c.treasure); c.hp = 0; } a.team = -1; b.team = -1; } }
        pulse('最终混战 · 结盟解除', center, center, '#ff9a6a');
      }
      // 地块崩塌
      for (const t of tiles) {
        if (!t.isLand || t.gone) continue;
        if (t.r > landRadius()) {
          t.falling += dt;
          if (t.falling > 0.55) { t.gone = true; if (Math.random() < 0.5) burst(t.gx, t.gy, '#8b8f86', 4); }
        }
      }
      // 掉出岛 / 缩圈淘汰
      for (const a of aliveActors()) {
        const t = tileAt(Math.round(a.x), Math.round(a.y));
        if (!t || !t.isLand || t.gone || t.r > landRadius()) eliminate(a, 'fall');
      }
    }

    // 玩家输入
    let mx = 0, my = 0;
    if (keys['KeyW'] || keys['ArrowUp']) { my -= 1; mx -= 1; }
    if (keys['KeyS'] || keys['ArrowDown']) { my += 1; mx += 1; }
    if (keys['KeyA'] || keys['ArrowLeft']) { mx -= 1; my += 1; }
    if (keys['KeyD'] || keys['ArrowRight']) { mx += 1; my -= 1; }
    if (joystick.active) { mx += joystick.dx - joystick.dy; my += joystick.dx + joystick.dy; }
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    player.vx = mx; player.vy = my;

    // 踢箱蓄力
    if (player.team >= 0 && (keys['KeyF'] || kickHeld)) {
      player.kickCharge += dt;
      if (player.kickCharge >= 1) { breakTeam(player, true); }
    } else player.kickCharge = 0;

    // AI 决策
    for (const a of actors) {
      if (!a.alive || a.isPlayer) continue;
      a.think -= dt;
      if (a.think <= 0) { a.think = 0.5 + hash(a.id, Math.floor(elapsed), 11) * 0.7; decideAI(a); }
    }

    // 移动
    for (const a of aliveActors()) {
      if (!a.isPlayer) {
        const dl = Math.hypot(a.aim.x - a.x, a.aim.y - a.y);
        a.vx = dl > 0.25 ? ((a.aim.x - a.x) / dl) * 0.82 : 0;
        a.vy = dl > 0.25 ? ((a.aim.y - a.y) / dl) * 0.82 : 0;
      }
      const slow = a.slow > 0 ? 0.55 : 1;
      const sp = 3.1 * slow * dt;
      a.x = clamp(a.x + a.vx * sp, 0.5, GRID - 1.5);
      a.y = clamp(a.y + a.vy * sp, 0.5, GRID - 1.5);
      a.slow = Math.max(0, a.slow - dt);
      a.dashCd = Math.max(0, a.dashCd - dt);
      a.attackCd = Math.max(0, a.attackCd - dt);
      const t = tileAt(Math.round(a.x), Math.round(a.y));
      if (t && t.gone) a.x = center + (a.x - center) * 0.97, a.y = center + (a.y - center) * 0.97;
    }

    // 宝箱跟随 + 自动攻击
    for (const c of chests) {
      if (c.hp <= 0) continue;
      const a = actors[c.a], b = actors[c.b];
      if (!a.alive || !b.alive || a.team < 0) { if (c.treasure > 0) scatterLoot(c.x, c.y, c.treasure); c.hp = 0; continue; }
      c.x = (a.x + b.x) / 2; c.y = (a.y + b.y) / 2;
      c.hp = 60 + c.treasure * 6;
    }
    for (const a of aliveActors()) {
      if (a.attackCd > 0) continue;
      let target: any = null, td = 2.7, isMonster = false;
      for (const m of monsters) {
        if (!m.alive) continue;
        const d = dist(a, m);
        if (d < td) { td = d; target = m; isMonster = true; }
      }
      if (!finalPhase) {
        for (const o of aliveActors()) {
          if (o === a || a.team === o.id) continue;
          const d = dist(a, o);
          if (d < td) { td = d; target = o; isMonster = false; }
        }
      } else {
        for (const o of aliveActors()) {
          if (o === a) continue;
          const d = dist(a, o);
          if (d < td) { td = d; target = o; isMonster = false; }
        }
      }
      if (!target) continue;
      a.attackCd = 0.7;
      if (isMonster) {
        target.hp -= 1;
        burst(target.x, target.y, '#c8a2ff', 5);
        if (target.hp <= 0) {
          target.alive = false; target.respawn = 9;
          const c = a.team >= 0 ? chestOf(a.team) : null;
          if (c) { c.treasure += 2; pulse('+2 宝物', c.x, c.y, '#ffe27a'); }
          else { a.treasure += 2; if (a.isPlayer) playerTreasure += 2; }
          scatterLoot(target.x, target.y, 1);
        }
      } else if (target.team >= 0) {
        const c = chestOf(target.team);
        if (c && c.hp > 0) {
          c.hp -= 12;
          burst(c.x, c.y, '#ffb45c', 5);
          if (c.hp <= 0) { scatterLoot(c.x, c.y, c.treasure); c.treasure = 0; chestBreaks++; pulse('宝箱被打爆！', c.x, c.y, '#ff8a6a'); }
        } else { damage(target, 10, a); }
      } else damage(target, 10, a);
    }

    // 怪物重生
    for (const m of monsters) {
      if (m.alive) continue;
      m.respawn -= dt;
      if (m.respawn <= 0) {
        const a = Math.random() * Math.PI * 2;
        m.x = center + Math.cos(a) * (3 + Math.random() * 4);
        m.y = center + Math.sin(a) * (3 + Math.random() * 4);
        m.hp = 3; m.alive = true;
      }
    }

    // 宝物物理与拾取
    for (const l of loots) {
      l.life -= dt;
      l.x += l.vx * dt * 2.2; l.y += l.vy * dt * 2.2;
      l.z += l.vz * dt * 3; l.vz -= 14 * dt;
      if (l.z < 0) { l.z = 0; l.vz = Math.abs(l.vz) > 1.2 ? -l.vz * 0.42 : 0; l.vx *= 0.7; l.vy *= 0.7; }
      if (l.value && l.z < 1.5) {
        for (const a of aliveActors()) {
          if (dist(a, l) < 0.8) {
            a.treasure = Math.min(30, a.treasure + 1);
            if (a.isPlayer) playerTreasure += 1;
            a.slow = 0.45;
            pulse('+1', a.x, a.y, '#ffe27a');
            l.value = 0; l.life = 0;
            break;
          }
        }
      }
    }
    for (let i = loots.length - 1; i >= 0; i--) if (loots[i].life <= 0) loots.splice(i, 1);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt * 3; p.y += p.vy * dt * 3;
      p.z += p.vz * dt * 4; p.vz -= 12 * dt;
      if (p.z < 0) { p.z = 0; p.vz = 0; }
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = floats.length - 1; i >= 0; i--) {
      floats[i].life -= dt;
      if (floats[i].life <= 0) floats.splice(i, 1);
    }

    if (!gameOver) {
      const alive = aliveActors();
      if (alive.length <= 1 || elapsed >= MATCH_SECONDS) {
        gameOver = true;
        winner = alive[0] ?? null;
      }
    }
  }

  function damage(target: any, amount: number, from: any) {
    target.hp -= amount;
    burst(target.x, target.y, '#ff8a8a', 4);
    if (target.hp <= 0) { eliminate(target, 'hp'); if (from) from.kills++; }
  }

  function decideAI(a: any) {
    const free = aliveActors().filter((o) => o !== a && o.team < 0);
    // 抢宝物优先
    let bestLoot: any = null, bl = 7;
    for (const l of loots) { if (!l.value || l.z > 2) continue; const d = dist(a, l); if (d < bl) { bl = d; bestLoot = l; } }
    if (bestLoot) { a.aim = { x: bestLoot.x, y: bestLoot.y }; return; }
    if (finalPhase) {
      const others = aliveActors().filter((o) => o !== a);
      const t = others.sort((p, q) => dist(a, p) - dist(a, q))[0];
      a.aim = t ? { x: t.x, y: t.y } : { x: center, y: center };
      return;
    }
    if (a.team >= 0) {
      const b = partner(a);
      const c = chestOf(a.team);
      if (a.ai === 'greedy' && c && c.treasure >= 7 && Math.random() < 0.22) { breakTeam(a, false); return; }
      if (a.ai === 'raider') {
        const enemyChest = chests.filter((x) => x.hp > 0 && x.team !== a.team && x.treasure >= 3).sort((p, q) => dist(a, p) - dist(a, q))[0];
        if (enemyChest) { a.aim = { x: enemyChest.x, y: enemyChest.y }; return; }
      }
      if (b) { a.aim = { x: (a.x + b.x) / 2 + (Math.random() - 0.5) * 3, y: (a.y + b.y) / 2 + (Math.random() - 0.5) * 3 }; return; }
    } else if (free.length && a.ai !== 'raider') {
      const near = free.sort((p, q) => dist(a, p) - dist(a, q))[0];
      if (near && dist(a, near) < 2.3) { formTeam(a, near); return; }
      if (near && dist(a, near) < 7) { a.aim = { x: near.x, y: near.y }; return; }
    }
    const monster = monsters.filter((m) => m.alive).sort((p, q) => dist(a, p) - dist(a, q))[0];
    if (monster) { a.aim = { x: monster.x + (Math.random() - 0.5) * 2, y: monster.y + (Math.random() - 0.5) * 2 }; return; }
    a.aim = { x: center + (Math.random() - 0.5) * 7, y: center + (Math.random() - 0.5) * 7 };
  }

  // ---------- 绘制 ----------
  function diamond(cx: number, cy: number, hw: number, hh: number, color: string) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
    ctx.closePath(); ctx.fill();
  }
  function cube(cx: number, cy: number, hw: number, hh: number, depth: number, colors: { top: string; left: string; right: string }) {
    ctx.fillStyle = colors.left;
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx, cy + hh + depth); ctx.lineTo(cx - hw, cy + depth);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = colors.right;
    ctx.beginPath();
    ctx.moveTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx, cy + hh + depth); ctx.lineTo(cx + hw, cy + depth);
    ctx.closePath(); ctx.fill();
    diamond(cx, cy, hw, hh, colors.top);
  }
  function shadow(x: number, y: number, size: number) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(x, y + 3, size, size * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#14263c'); g.addColorStop(0.55, '#1d3b57'); g.addColorStop(1, '#0d1c2c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 26; i++) {
      const x = (hash(i, 1, 2) * W + elapsed * (2 + hash(i, 3, 4) * 4)) % W;
      ctx.fillRect(Math.floor(x), 30 + hash(i, 5, 6) * 120, 22, 5);
    }
  }

  function drawTile(t: any) {
    if (!t.isLand && t.type === 'deep') return;
    const wob = t.type === 'water' ? Math.sin(elapsed * 2 + t.seed * 8) * 1.4 : 0;
    const p = iso(t.gx, t.gy, t.height * 0.7 + wob / BLOCK);
    const drop = t.falling > 0 ? t.falling * 90 : 0;
    const cx = p.x, cy = p.y + drop;
    if (t.gone) return;
    const c = TERRAIN[t.type];
    if (!t.isLand) {
      diamond(cx, cy, HALF_W, HALF_H, c.top);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(cx - 8 + Math.sin(elapsed + t.seed * 9) * 3, cy, 8, 2);
      return;
    }
    // 漂浮岛基底：向下逐层收缩变暗，形成明显的悬崖与倒锥基座
    const depth = t.height * BLOCK + 10;
    const layers = Math.max(2, Math.round(6 - t.r * 3.2));
    for (let l = layers; l >= 1; l--) {
      const shrinkBy = l * 2.1;
      const col = l > 3 ? '#2f2a22' : l > 2 ? '#40382c' : l > 1 ? '#514634' : '#63553e';
      cube(cx, cy + l * 11, HALF_W - shrinkBy, HALF_H - shrinkBy * 0.5, 12,
        { top: col, left: '#2b261f', right: '#1e1a16' });
    }
    cube(cx, cy, HALF_W, HALF_H, depth, c);
    if (t.type === 'crystal') {
      ctx.fillStyle = 'rgba(150,235,255,0.55)';
      ctx.fillRect(cx - 3, cy - 12, 6, 9);
    }
    if (t.decor === 'tree') {
      cube(cx, cy - 20, 5, 3, 17, { top: '#7a5a35', left: '#5c4227', right: '#432f1c' });
      cube(cx, cy - 34, 11, 6, 12, { top: '#4f9b4a', left: '#34703a', right: '#25572d' });
      cube(cx, cy - 44, 7, 4, 8, { top: '#63b356', left: '#3f8343', right: '#2e6634' });
    } else if (t.decor === 'rock') {
      cube(cx, cy - 8, 8, 4, 8, { top: '#9aa3ac', left: '#6d7883', right: '#525c66' });
    } else if (t.decor === 'crystal') {
      cube(cx, cy - 10, 6, 3, 16, { top: '#9ce9ff', left: '#4fa9c6', right: '#347e9d' });
    }
    if (t.falling > 0) {
      ctx.fillStyle = `rgba(255,120,80,${0.25 + t.falling * 0.5})`;
      diamond(cx, cy, HALF_W, HALF_H, ctx.fillStyle as string);
    }
  }

  function drawVoxelCharacter(a: any) {
    const p = iso(a.x, a.y, 0.6);
    const cx = p.x, cy = p.y;
    shadow(cx, cy + 6, 11);
    const top = a.color;
    const dark = shade(a.color, -0.35);
    const side = shade(a.color, -0.18);
    // 腿
    cube(cx - 4, cy - 8, 3, 2, 8, { top: dark, left: dark, right: dark });
    cube(cx + 4, cy - 8, 3, 2, 8, { top: dark, left: dark, right: dark });
    // 身体
    cube(cx, cy - 20, 8, 4, 13, { top, left: dark, right: side });
    // 头
    cube(cx, cy - 33, 6, 3, 10, { top: '#f2d2a9', left: '#c9a577', right: '#e0bb8d' });
    // 造型差异：帽子 / 头盔 / 天线 / 披风
    if (a.style === 0) cube(cx, cy - 39, 8, 4, 4, { top: shade(a.color, 0.2), left: dark, right: side });
    else if (a.style === 1) { ctx.fillStyle = '#ffe27a'; ctx.fillRect(cx - 2, cy - 45, 4, 6); ctx.fillRect(cx - 5, cy - 43, 10, 2); }
    else if (a.style === 2) cube(cx, cy - 39, 7, 3, 5, { top: '#d8dee6', left: '#8d97a3', right: '#aab4bf' });
    else { cube(cx - 9, cy - 22, 4, 2, 12, { top: shade(a.color, 0.15), left: dark, right: side }); }
    // 血条
    if (a.hp < 100 || a.isPlayer) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(cx - 12, cy - 50, 24, 4);
      ctx.fillStyle = a.isPlayer ? '#7ee08a' : '#e86a5a'; ctx.fillRect(cx - 12, cy - 50, 24 * clamp(a.hp / 100, 0, 1), 4);
    }
    // 玩家标记
    if (a.isPlayer) {
      ctx.fillStyle = '#ffe27a';
      ctx.beginPath(); ctx.moveTo(cx, cy - 58); ctx.lineTo(cx - 5, cy - 66); ctx.lineTo(cx + 5, cy - 66); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = a.isPlayer ? '#ffffff' : 'rgba(255,255,255,0.75)';
    ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText(a.name, cx, cy - 69);
    if (a.treasure > 0) { ctx.fillStyle = '#ffe27a'; ctx.fillText(`◆${a.treasure}`, cx, cy + 16); }
  }

  function shade(hex: string, amount: number) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(Math.round(((n >> 16) & 255) * (1 + amount)), 0, 255);
    const g = clamp(Math.round(((n >> 8) & 255) * (1 + amount)), 0, 255);
    const b = clamp(Math.round((n & 255) * (1 + amount)), 0, 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  function drawMonster(m: any) {
    if (!m.alive) return;
    const p = iso(m.x + Math.sin(elapsed * 2 + m.wobble) * 0.06, m.y, 0.4);
    const cx = p.x, cy = p.y;
    shadow(cx, cy + 5, 9);
    cube(cx, cy - 15, 7, 4, 14, { top: '#7a5aa8', left: '#4f3674', right: '#63418f' });
    cube(cx, cy - 24, 6, 3, 7, { top: '#9b73c9', left: '#60448a', right: '#7755a8' });
    ctx.fillStyle = '#ff6a6a'; ctx.fillRect(cx - 4, cy - 22, 2, 2); ctx.fillRect(cx + 2, cy - 22, 2, 2);
  }

  function drawChest(c: any) {
    if (c.hp <= 0) return;
    const p = iso(c.x, c.y, 0.5);
    const cx = p.x, cy = p.y;
    const size = 7 + Math.min(12, c.treasure * 0.8);
    shadow(cx, cy + 6, size + 3);
    ctx.fillStyle = 'rgba(255,215,90,0.16)';
    ctx.beginPath(); ctx.arc(cx, cy - 12, size + 10, 0, Math.PI * 2); ctx.fill();
    cube(cx, cy - size, size, size * 0.5, size + 4, { top: '#e8b64a', left: '#9b6b22', right: '#c38c2e' });
    ctx.fillStyle = '#ffe89a';
    ctx.fillRect(cx - 2, cy - size - size * 0.5 - 2, 4, size + 8);
    ctx.fillStyle = '#5d3d14';
    ctx.fillRect(cx - size + 2, cy - size + 2, size * 2 - 4, 3);
    ctx.fillStyle = '#fff3c4'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`◆${c.treasure}`, cx, cy + 14);
    if (c.hp < 60 + c.treasure * 6) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx - 16, cy + 18, 32, 4);
      ctx.fillStyle = '#ff8a5a'; ctx.fillRect(cx - 16, cy + 18, 32 * clamp(c.hp / (60 + c.treasure * 6), 0, 1), 4);
    }
  }

  function drawLoot(l: any) {
    if (!l.value) return;
    const p = iso(l.x, l.y, l.z / BLOCK);
    ctx.fillStyle = 'rgba(255,220,110,0.28)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    cube(p.x, p.y, 4, 2, 6, { top: '#ffe27a', left: '#c99721', right: '#e8b43c' });
  }

  function drawTeamLinks() {
    for (const a of aliveActors()) {
      const b = partner(a);
      if (!b || a.id > b.id) continue;
      const p1 = iso(a.x, a.y, 1.1), p2 = iso(b.x, b.y, 1.1);
      const steps = Math.max(2, Math.floor(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 10));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = p1.x + (p2.x - p1.x) * t, y = p1.y + (p2.y - p1.y) * t - Math.sin(t * Math.PI) * 12;
        ctx.fillStyle = i % 2 ? 'rgba(140,240,180,0.85)' : 'rgba(210,255,225,0.95)';
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const s = iso(p.x, p.y, p.z / BLOCK);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillRect(s.x - p.size / 2, s.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const f of floats) {
      const s = iso(f.x, f.y, 2.4);
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.fillStyle = f.color; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
      ctx.fillText(f.text, s.x, s.y - (1.1 - f.life) * 22);
    }
    ctx.globalAlpha = 1;
  }

  function panel(x: number, y: number, w: number, h: number, alpha = 0.72) {
    ctx.fillStyle = `rgba(12,24,38,${alpha})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(150,200,225,0.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function drawHud() {
    panel(12, 10, 330, 46);
    ctx.fillStyle = '#ffe6a8'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'left';
    ctx.fillText('荒岛合纵 · 破箱局', 24, 30);
    ctx.fillStyle = '#9fc4d8'; ctx.font = '10px monospace';
    ctx.fillText('体素荒岛 / 合作 · 背叛 · 掠夺 · 哄抢', 24, 46);

    const left = Math.max(0, MATCH_SECONDS - elapsed);
    const mm = Math.floor(left / 60), ss = Math.floor(left % 60);
    panel(368, 10, 224, 46);
    ctx.fillStyle = '#e8f2f8'; ctx.font = 'bold 17px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, 480, 32);
    ctx.fillStyle = shrink > 0 ? '#ff9a6a' : '#8fb6c9'; ctx.font = '10px monospace';
    const phase = finalPhase ? '最终混战 · 结盟解除' : shrink > 0 ? '荒岛缩圈中' : elapsed < 60 ? '寻找队友 · 合作打怪' : elapsed < 120 ? '宝箱成长 · 背叛频发' : '外部掠夺 · 争夺宝物';
    ctx.fillText(phase, 480, 47);
    panel(604, 10, 156, 46);
    ctx.fillStyle = '#e8f2f8'; ctx.font = 'bold 15px monospace';
    ctx.fillText(`存活 ${aliveActors().length}/10`, 682, 32);
    ctx.fillStyle = '#8fb6c9'; ctx.font = '10px monospace';
    ctx.fillText(`宝物 ${playerTreasure} · 爆箱 ${chestBreaks}`, 682, 47);
    panel(772, 10, 176, 46);
    ctx.fillStyle = speed > 1 ? '#ffe27a' : '#9fc4d8'; ctx.font = '11px monospace';
    ctx.fillText(speed > 1 ? '⏩ 演示加速 ×4（点击切回）' : '点击加速 ×4 / Q 键', 860, 30);
    ctx.fillStyle = '#6d8fa3'; ctx.font = '8px monospace';
    ctx.fillText('WASD移动 E结盟 F踢箱 空格冲撞', 860, 46);

    // 队伍列表
    panel(12, 66, 186, 20 + Math.min(6, chests.filter((c) => c.hp > 0).length) * 15, 0.62);
    ctx.fillStyle = '#cfe3ef'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
    ctx.fillText('场上队伍 / 宝箱', 22, 82);
    let row = 0;
    for (const c of chests) {
      if (c.hp <= 0 || row >= 6) continue;
      const a = actors[c.a], b = actors[c.b];
      ctx.fillStyle = a.color; ctx.fillRect(22, 90 + row * 15, 7, 7);
      ctx.fillStyle = b.color; ctx.fillRect(31, 90 + row * 15, 7, 7);
      ctx.fillStyle = '#dbe9f2'; ctx.font = '10px monospace';
      ctx.fillText(`${a.name}+${b.name}  ◆${c.treasure}`, 44, 97 + row * 15);
      row++;
    }
    if (row === 0) { ctx.fillStyle = '#7f9cae'; ctx.font = '10px monospace'; ctx.fillText('暂无结盟', 22, 100); }

    // 玩家状态
    panel(772, 66, 176, 74, 0.62);
    ctx.fillStyle = player.color; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
    ctx.fillText(`● ${player.name}（你）`, 782, 84);
    ctx.fillStyle = '#cfe3ef'; ctx.font = '10px monospace';
    ctx.fillText(`生命 ${Math.max(0, Math.round(player.hp))}`, 782, 102);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(782, 106, 156, 5);
    ctx.fillStyle = '#7ee08a'; ctx.fillRect(782, 106, 156 * clamp(player.hp / 100, 0, 1), 5);
    ctx.fillStyle = '#cfe3ef';
    ctx.fillText(player.team >= 0 ? `队友 ${partner(player)?.name ?? ''} · 长按 F 踢箱` : '单人 · 靠近他人按 E 结盟', 782, 126);
    if (player.team >= 0 && player.kickCharge > 0) {
      ctx.fillStyle = '#ff8a6a'; ctx.font = 'bold 10px monospace';
      ctx.fillText(`踢箱蓄力 ${Math.min(100, Math.round(player.kickCharge * 100))}%`, 782, 138);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(782, 140, 156, 4);
      ctx.fillStyle = '#ff6a4a'; ctx.fillRect(782, 140, 156 * clamp(player.kickCharge, 0, 1), 4);
    }

    // 虚拟摇杆 + 按钮
    ctx.strokeStyle = 'rgba(180,220,240,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(112, 448, 58, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(180,220,240,0.10)'; ctx.fill();
    const kx = 112 + joystick.dx * 40, ky = 448 + joystick.dy * 40;
    ctx.fillStyle = 'rgba(220,240,250,0.65)';
    ctx.beginPath(); ctx.arc(kx, ky, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8fb6c9'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('移动', 112, 518);

    drawButton(838, 452, 38, '#5fbf8a', '结盟', 'E');
    drawButton(758, 470, 38, player.team >= 0 ? '#d8794f' : '#5a6b78', '踢箱', 'F');
    drawButton(878, 388, 38, '#4f9ad0', '冲撞', '␣');

    // 底部说明
    ctx.fillStyle = 'rgba(10,22,34,0.7)'; ctx.fillRect(220, 512, 520, 22);
    ctx.fillStyle = '#9fc4d8'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('合作创造财富 · 背叛重新分配财富 · 掠夺打破利益格局', 480, 527);
  }

  function drawButton(x: number, y: number, r: number, color: string, label: string, key: string) {
    ctx.fillStyle = color; ctx.globalAlpha = 0.75;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = '9px monospace';
    ctx.fillText(key, x, y + 15);
  }

  function drawResult() {
    if (!gameOver) return;
    panel(300, 150, 360, 190, 0.92);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe6a8'; ctx.font = 'bold 22px monospace';
    ctx.fillText(winner ? `${winner.name} 获胜！` : '本局结束', 480, 192);
    ctx.fillStyle = winner ? winner.color : '#ffffff'; ctx.font = '12px monospace';
    ctx.fillText(winner ? (winner.isPlayer ? '你是最后幸存者' : '再试一次，换个策略') : '', 480, 214);
    ctx.fillStyle = '#cfe3ef'; ctx.font = '12px monospace'; ctx.textAlign = 'left';
    const rows = [
      ['本局获得宝物', `${playerTreasure}`],
      ['打爆宝箱次数', `${chestBreaks}`],
      ['主动背叛次数', `${betrayals}`],
      ['淘汰人数', `${player.kills}`],
      ['最终名次', `${winner?.isPlayer ? '1' : Math.max(2, 11 - aliveActors().length)} / 10`],
    ];
    rows.forEach((r, i) => {
      ctx.fillStyle = '#8fb6c9'; ctx.fillText(r[0], 336, 244 + i * 18);
      ctx.fillStyle = '#ffe6a8'; ctx.fillText(r[1], 590, 244 + i * 18);
    });
    ctx.fillStyle = '#7ee08a'; ctx.fillRect(380, 246, 200, 32);
    ctx.fillStyle = '#0b1c14'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    ctx.fillText('再来一局', 480, 267);
  }

  function restart() {
    elapsed = 0; gameOver = false; winner = null; betrayals = 0; chestBreaks = 0;
    playerTreasure = 0; shrink = 0; finalPhase = false; speed = 1;
    for (const t of tiles) { t.gone = false; t.falling = 0; }
    chests.length = 0; loots.length = 0; particles.length = 0; floats.length = 0;
    actors.forEach((a, i) => {
      const ang = 0.42 + (i / 10) * Math.PI * 2, rad = 3.2 + (i % 3) * 1.4;
      Object.assign(a, { x: center + Math.cos(ang) * rad, y: center + Math.sin(ang) * rad, hp: 100, alive: true, team: -1, treasure: 0, kickCharge: 0, dashCd: 0, attackCd: 0, slow: 0, kills: 0, aim: { x: a.x, y: a.y } });
    });
    monsters.forEach((m, i) => { const a = (i / 6) * Math.PI * 2 + 0.3; Object.assign(m, { x: center + Math.cos(a) * (5 + (i % 2)), y: center + Math.sin(a) * (5 + (i % 2)), hp: 3, alive: true, respawn: 0 }); });
  }

  function render() {
    drawBackground();
    // 地块按等距深度排序
    for (let s = 0; s <= (GRID - 1) * 2; s++) {
      for (let gx = 0; gx < GRID; gx++) {
        const gy = s - gx;
        if (gy < 0 || gy >= GRID) continue;
        const t = tileAt(gx, gy);
        if (t && !t.gone) drawTile(t);
      }
    }
    drawTeamLinks();
    const drawables: any[] = [];
    for (const m of monsters) if (m.alive) drawables.push({ d: m.x + m.y, fn: () => drawMonster(m) });
    for (const c of chests) if (c.hp > 0) drawables.push({ d: c.x + c.y + 0.1, fn: () => drawChest(c) });
    for (const a of aliveActors()) drawables.push({ d: a.x + a.y + 0.2, fn: () => drawVoxelCharacter(a) });
    drawables.sort((p, q) => p.d - q.d).forEach((o) => o.fn());
    for (const l of loots) drawLoot(l);
    drawParticles();
    drawHud();
    drawResult();
  }

  function frame(now: number) {
    const raw = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const dt = raw * speed;
    update(dt);
    render();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.remove();
    },
  };
}
