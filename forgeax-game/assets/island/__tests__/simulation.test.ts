import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  aliveActors,
  ALLY_IGNORE_SECONDS,
  ALLY_INTERACT_DISTANCE,
  checkTeamDistances,
  chestOf,
  createInitialSimulation,
  damageActor,
  destroyChest,
  disbandTeam,
  dist,
  doDash,
  formTeam,
  getIgnoreRemaining,
  getNearbyCandidate,
  ignorePair,
  isPairIgnored,
  partnerOf,
  sendInvite,
  stepSimulation,
  TEAM_BREAK_DISTANCE,
  TEAM_WARNING_DISTANCE,
} from '../simulation.ts';

describe('cooperation and distance betrayal mechanics', () => {
  it('does not form team on single unilateral invite', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    a.x = p.x + 1.0;
    a.y = p.y;

    const ok = sendInvite(sim, p.id, a.id);
    expect(ok).toBe(true);
    expect(sim.invites).toHaveLength(1);
    expect(p.team).toBe(-1);
    expect(a.team).toBe(-1);
    expect(chestOf(sim, p.id)).toBeNull();
  });

  it('forms team atomically upon invite acceptance and clears pending invites', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    a.x = p.x + 1.0;
    a.y = p.y;

    sendInvite(sim, p.id, a.id);
    const invite = sim.invites[0]!;

    const accepted = acceptInvite(sim, invite.id, a.id);
    expect(accepted).toBe(true);
    expect(p.team).toBe(a.id);
    expect(a.team).toBe(p.id);
    expect(sim.invites).toHaveLength(0);

    const chest = chestOf(sim, p.team);
    expect(chest).not.toBeNull();
    expect(chest?.hp).toBe(60);
    expect(chest?.treasure).toBe(0);
  });

  it('handles simultaneous mutual invites atomically without double-team or double-chests', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    b.x = a.x + 1.0;
    b.y = a.y;

    sendInvite(sim, a.id, b.id);
    expect(sim.invites).toHaveLength(1);

    // b simultaneously sends invite to a
    sendInvite(sim, b.id, a.id);
    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);
    expect(sim.chests.filter((c) => c.hp > 0)).toHaveLength(1);
    expect(sim.invites).toHaveLength(0);
  });

  it('enforces 60-second ignore blocking symmetrically while other pairs stay available', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    a.x = p.x + 1.0;
    a.y = p.y;
    b.x = p.x + 1.2;
    b.y = p.y;

    ignorePair(sim, p.id, a.id);
    expect(isPairIgnored(sim, p.id, a.id)).toBe(true);
    expect(isPairIgnored(sim, a.id, p.id)).toBe(true);
    expect(isPairIgnored(sim, p.id, b.id)).toBe(false);

    // Cannot invite ignored pair
    expect(sendInvite(sim, p.id, a.id)).toBe(false);
    expect(sendInvite(sim, a.id, p.id)).toBe(false);
    // Can invite third party
    expect(sendInvite(sim, p.id, b.id)).toBe(true);

    // 59.9 seconds later: still ignored
    sim.elapsed = 59.9;
    expect(isPairIgnored(sim, p.id, a.id)).toBe(true);

    // 60.1 seconds later: ignore expires
    sim.elapsed = 60.1;
    expect(isPairIgnored(sim, p.id, a.id)).toBe(false);
    expect(sendInvite(sim, p.id, a.id)).toBe(true);
  });

  it('cancels pending invite when actors walk outside interact distance', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    a.x = p.x + 1.0;
    a.y = p.y;

    sendInvite(sim, p.id, a.id);
    expect(sim.invites).toHaveLength(1);

    // Walk away past 2.4 distance
    a.x = p.x + 3.0;
    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });
    expect(sim.invites).toHaveLength(0);
  });

  it('maintains team at TEAM_BREAK_DISTANCE and breaks immediately when exceeded', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    const a = sim.actors[1]!;
    p.x = 10.0;
    p.y = 10.0;
    a.x = 10.0;
    a.y = 11.0; // Close to form team
    formTeam(sim, p, a);
    const chest = chestOf(sim, p.team)!;
    chest.treasure = 6;

    // Pull to exactly 5.0 distance: team holds
    a.y = 10.0 + TEAM_BREAK_DISTANCE;
    checkTeamDistances(sim);
    expect(p.team).toBe(a.id);
    expect(a.team).toBe(p.id);
    expect(chest.hp).toBeGreaterThan(0);

    // Exceed distance strictly (> 5.0)
    a.y = 10.0 + TEAM_BREAK_DISTANCE + 0.1;
    checkTeamDistances(sim);
    expect(p.team).toBe(-1);
    expect(a.team).toBe(-1);
    expect(chest.hp).toBe(0);
    expect(chest.treasure).toBe(0);
    expect(sim.playerDisbands).toBe(1);
    expect(sim.chestBreaks).toBe(1);
    expect(sim.lastBreakEvent).not.toBeNull();
    expect(sim.lastBreakEvent?.lootCount).toBe(6);
    expect(sim.lastBreakEvent?.y).toBeCloseTo((p.y + a.y) / 2);
    expect(sim.loots).toHaveLength(6);
  });

  it('keeps team alive when chest is destroyed by external raid, and does not double-spawn loot on later disband', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    a.x = 10;
    a.y = 10;
    b.x = 11;
    b.y = 10;
    formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.treasure = 4;

    // External enemy destroys chest
    const count = destroyChest(sim, chest, chest.x, chest.y);
    expect(count).toBe(4);
    expect(sim.chestBreaks).toBe(1);
    expect(sim.loots).toHaveLength(4);

    // Crucial rule: teammates REMAIN TEAMMATES!
    expect(a.team).toBe(b.id);
    expect(b.team).toBe(a.id);

    // Later they pull apart > 5.0
    b.x = 18;
    checkTeamDistances(sim);
    expect(a.team).toBe(-1);
    expect(b.team).toBe(-1);

    // Loot count stays 4 (no double release)
    expect(sim.loots).toHaveLength(4);
    expect(sim.chestBreaks).toBe(1);
  });

  it('handles empty chest distance break without generating phantom treasure', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[1]!;
    const b = sim.actors[2]!;
    a.x = 10;
    a.y = 10;
    b.x = 11;
    b.y = 10;
    formTeam(sim, a, b);

    // Pull apart
    b.x = 20;
    checkTeamDistances(sim);
    expect(a.team).toBe(-1);
    expect(b.team).toBe(-1);
    expect(sim.loots).toHaveLength(0);
  });

  it('conserves loot value on public pickup', () => {
    const sim = createInitialSimulation();
    const p = sim.actors[0]!;
    p.treasure = 0;
    sim.loots.push({
      id: 501,
      x: p.x + 0.1,
      y: p.y + 0.1,
      z: 0.1,
      vx: 0,
      vy: 0,
      vz: 0,
      value: 1,
      life: 20,
      spin: 0,
    });

    stepSimulation(sim, 0.1, {
      moveX: 0,
      moveY: 0,
      dash: false,
      speedToggle: false,
      restart: false,
    });

    expect(p.treasure).toBe(1);
    expect(sim.loots).toHaveLength(0);
  });
});
