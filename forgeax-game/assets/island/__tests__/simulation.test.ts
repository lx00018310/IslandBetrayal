import { describe, expect, it } from 'vitest';
import {
  aliveActors,
  breakTeam,
  chestOf,
  createInitialSimulation,
  damageActor,
  dist,
  doDash,
  formTeam,
  partnerOf,
  stepSimulation,
  tryInteract,
} from '../simulation.ts';

describe('island simulation rules', () => {
  it('creates 10 actors and 6 monsters on an active island', () => {
    const sim = createInitialSimulation();
    expect(sim.actors).toHaveLength(10);
    expect(sim.monsters).toHaveLength(6);
    expect(sim.playerTreasure).toBe(0);
    expect(sim.gameOver).toBe(false);
    expect(aliveActors(sim)).toHaveLength(10);
    expect(sim.actors[0]!.isPlayer).toBe(true);
  });

  it('forms a team and creates a shared chest', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    a.x = p.x + 1;
    a.y = p.y;
    tryInteract(sim, p);
    expect(p.team).toBe(a.id);
    expect(a.team).toBe(p.id);
    const chest = chestOf(sim, p.team);
    expect(chest).not.toBeNull();
    expect(chest?.hp).toBe(60);
    expect(chest?.treasure).toBe(0);
  });

  it('handles intentional betrayal by kicking the chest', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    formTeam(sim, p, a);
    const chest = chestOf(sim, p.team)!;
    chest.treasure = 5;

    // Hold kick for 1.0 second
    stepSimulation(sim, 0.5, {
      moveX: 0,
      moveY: 0,
      dash: false,
      interact: false,
      kickHeld: true,
      speedToggle: false,
      restart: false,
    });
    expect(p.team).toBe(a.id); // Not broken yet
    expect(p.kickCharge).toBeCloseTo(0.5);

    stepSimulation(sim, 0.6, {
      moveX: 0,
      moveY: 0,
      dash: false,
      interact: false,
      kickHeld: true,
      speedToggle: false,
      restart: false,
    });
    expect(p.team).toBe(-1);
    expect(a.team).toBe(-1);
    expect(sim.betrayals).toBe(1);
    expect(sim.chestBreaks).toBe(1);
    expect(sim.loots.length).toBeGreaterThanOrEqual(5);
  });

  it('handles external raid destroying another team chest', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.treasure = 4;

    breakTeam(sim, a, false);
    expect(sim.chestBreaks).toBe(1);
    expect(sim.betrayals).toBe(0); // External break is not a betrayal
    expect(sim.loots.length).toBeGreaterThanOrEqual(4);
  });

  it('allows picking up free loots with slow penalty', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    sim.loots.push({
      id: 999,
      x: p.x + 0.1,
      y: p.y + 0.1,
      z: 0.2,
      vx: 0,
      vy: 0,
      vz: 0,
      value: 1,
      life: 10,
      spin: 0,
    });

    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      interact: false,
      kickHeld: false,
      speedToggle: false,
      restart: false,
    });
    expect(p.treasure).toBe(1);
    expect(sim.playerTreasure).toBe(1);
    expect(p.slow).toBeGreaterThan(0);
  });

  it('applies dash displacement and pushes nearby opponents', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const enemy = sim.actors[1]!;
    p.vx = 1;
    p.vy = 0;
    enemy.x = p.x + 0.5;
    enemy.y = p.y;
    const initialEnemyX = enemy.x;

    doDash(sim, p);
    expect(p.dashCd).toBeGreaterThan(3.0);
    expect(enemy.x).toBeGreaterThan(initialEnemyX);
  });

  it('eliminates actor on falling off edge or hp zero', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[1]!;
    damageActor(sim, p, 100, sim.actors[0]!);
    expect(p.alive).toBe(false);
    expect(p.hp).toBeLessThanOrEqual(0);
    expect(sim.actors[0]!.kills).toBe(1);
  });
});
