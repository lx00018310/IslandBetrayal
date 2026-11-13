import {
  createInitialSimulation,
  stepSimulation,
  aliveActors,
} from '../assets/island/simulation.ts';

export function measureMatchPacing(maxSeconds = 90, dt = 0.1) {
  const sim = createInitialSimulation();
  let firstHitTime: number | null = null;
  let firstKillTime: number | null = null;
  let firstXpTime: number | null = null;
  let firstEncounterTime: number | null = null;
  let firstTeamTime: number | null = null;
  let firstBreakTime: number | null = null;
  let maxIdleGap = 0;
  let lastActionTime = 0;

  const player = sim.actors[0]!;
  let lastXp = player.xp;
  let lastBreaks = sim.chestBreaks;
  let lastMonstersKilled = 0;

  for (let t = 0; t <= maxSeconds; t += dt) {
    // 玩家模拟：靠近最近的怪物或未结盟角色
    const monsters = sim.monsters.filter((m) => m.alive);
    let moveX = 0;
    let moveY = 0;
    if (monsters.length > 0) {
      const nearest = monsters.reduce((best, cur) => {
        const dBest = Math.hypot(best.x - player.x, best.y - player.y);
        const dCur = Math.hypot(cur.x - player.x, cur.y - player.y);
        return dCur < dBest ? cur : best;
      });
      const dx = nearest.x - player.x;
      const dy = nearest.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.6) {
        moveX = dx / dist;
        moveY = dy / dist;
      }
    }

    stepSimulation(sim, dt, { moveX, moveY });

    // 1. 首次遭遇其他角色（距离 <= 3m）
    if (firstEncounterTime === null) {
      const other = aliveActors(sim).find((a) => a.id !== 0 && Math.hypot(a.x - player.x, a.y - player.y) <= 3.0);
      if (other) {
        firstEncounterTime = Number(t.toFixed(1));
        maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
        lastActionTime = t;
      }
    }

    // 2. 首次攻击命中（hitFlash > 0）
    if (firstHitTime === null) {
      const hitTarget = sim.monsters.find((m) => m.hitFlash > 0) ?? aliveActors(sim).find((a) => a.id !== 0 && a.hitFlash > 0);
      if (hitTarget) {
        firstHitTime = Number(t.toFixed(1));
        maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
        lastActionTime = t;
      }
    }

    // 3. 首次获得经验
    if (firstXpTime === null && player.xp > lastXp) {
      firstXpTime = Number(t.toFixed(1));
      maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
      lastActionTime = t;
    }
    lastXp = player.xp;

    // 4. 首次击杀怪物
    const currentDeadMonsters = sim.monsters.filter((m) => !m.alive).length;
    if (firstKillTime === null && currentDeadMonsters > lastMonstersKilled) {
      firstKillTime = Number(t.toFixed(1));
      maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
      lastActionTime = t;
    }

    // 5. 首次组队成立
    if (firstTeamTime === null && (player.team >= 0 || sim.actors.some((a) => a.team >= 0))) {
      firstTeamTime = Number(t.toFixed(1));
      maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
      lastActionTime = t;
    }

    // 6. 首次爆箱 / 背叛
    if (firstBreakTime === null && sim.chestBreaks > lastBreaks) {
      firstBreakTime = Number(t.toFixed(1));
      maxIdleGap = Math.max(maxIdleGap, t - lastActionTime);
      lastActionTime = t;
    }
    lastBreaks = sim.chestBreaks;
  }

  return {
    firstEncounterTime,
    firstHitTime,
    firstKillTime,
    firstXpTime,
    firstTeamTime,
    firstBreakTime,
    maxIdleGap: Number(maxIdleGap.toFixed(1)),
  };
}

if (process.argv[1] && process.argv[1].endsWith('pacing-probe.ts')) {
  console.log(JSON.stringify(measureMatchPacing(), null, 2));
}
