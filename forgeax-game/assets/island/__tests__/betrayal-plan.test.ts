import { describe, expect, it } from 'vitest';
import art from '../art.pack.ts';
import { parseEndlessSave, serializeEndlessSave } from '../endless-save.ts';
import {
  aggregateGlobalRules, chooseAiRule, createInitialEndlessProfile, createEmptyGrudgeRecord,
  RULE_KINDS, settleGrudges,
} from '../stats.ts';
import {
  activeCovers, awardTreasure, checkTeamDistances, chestOf, createInitialSimulation,
  damageActor, damageMonster, decideAI, destroyChest, formTeam, sendInvite,
  startBossRaid, stepBossRaid, stepSimulation, stepWeapons,
} from '../simulation.ts';

const rules = (...kinds: typeof RULE_KINDS[number][]) => kinds.map(kind => ({ ownerId: 0, chosenAtRound: 1, kind }));

describe('三大机制计划的运行链路', () => {
  it('七种具名秘策具有独立身份，旧属性倍率不会被误识别成秘策', () => {
    const legacy = aggregateGlobalRules([{ ownerId: 0, stat: 'moveSpeed', factor: 1.2, chosenAtRound: 1 }]);
    expect(legacy.tetherModifier).toBe(1);
    const all = aggregateGlobalRules(rules(...RULE_KINDS));
    expect(all.bloodFeudBase).toBe(1.25);
    expect(all.chestIncomeModifier).toBe(1.25);
    expect(all.bossDamageModifier).toBe(1.25);
    expect(all.weaponModifiers.bomb).toBe(1.2);
    expect(all.arrowRangeModifier).toBe(0.85);
  });

  it('短绳修改真实断线距离与箱收入，Space 主动背叛在几何中点爆箱并记仇', () => {
    const sim = createInitialSimulation({ rules: rules('tether_tight') });
    const a = sim.actors[0]!, b = sim.actors[1]!;
    Object.assign(a, { x: 10, y: 10 }); Object.assign(b, { x: 11, y: 10 });
    formTeam(sim, a, b);
    awardTreasure(sim, a, 4);
    expect(chestOf(sim, a.team)!.treasure).toBe(5);
    stepSimulation(sim, 0, { moveX: 0, moveY: 0, teamAction: true });
    expect(a.team).toBe(-1);
    expect(b.team).toBe(-1);
    expect(sim.lastBreakEvent).toMatchObject({ x: 10.5, y: 10, reason: 'betrayal', lootCount: 5 });
    expect(sim.grudges.get(1)!.grudgeScoreByActor[0]).toBe(50);
    Object.assign(b, { x: 11, y: 10 }); formTeam(sim, a, b);
    b.x = 14.3; checkTeamDistances(sim);
    expect(a.team).toBe(-1); // 4.3 > 5 × 0.85，而非写死 5m。
  });

  it('Boss 命中按实际伤害注资箱子，35 秒内仍运行 PvP、断线与主时钟', () => {
    const sim = createInitialSimulation({ rules: rules('bounty_greed'), rng: () => 0.99 });
    const a = sim.actors[0]!, b = sim.actors[1]!;
    Object.assign(a, { x: 11, y: 11 }); Object.assign(b, { x: 12, y: 11 });
    formTeam(sim, a, b);
    sim.elapsed = 120; startBossRaid(sim); stepBossRaid(sim, 3);
    damageMonster(sim, sim.boss!, 32, a);
    expect(sim.raidDamage).toBe(40);
    expect(chestOf(sim, a.team)!.treasure).toBe(2);
    b.x = 17; checkTeamDistances(sim);
    expect(a.team).toBe(-1);
    const t = sim.elapsed;
    stepSimulation(sim, 0.1, { moveX: 0, moveY: 0 });
    expect(sim.elapsed).toBeCloseTo(t + 0.1);
  });

  it('外部破箱只公开一半财富、归还另一半且不散队，分数财富也守恒', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[0]!, b = sim.actors[1]!;
    a.x = 10; a.y = 10; b.x = 11; b.y = 10; formTeam(sim, a, b);
    const chest = chestOf(sim, a.team)!;
    chest.treasure = 5;
    destroyChest(sim, chest, 10.5, 10, true);
    expect(a.team).toBe(b.id);
    expect(sim.loots.reduce((sum, loot) => sum + loot.value, 0)).toBe(2.5);
    expect(a.treasure + b.treasure).toBe(2.5);
  });

  it('击杀入口只记一次凶手，未冲突对象衰减，记仇与秘策保存后能恢复', () => {
    const sim = createInitialSimulation();
    damageActor(sim, sim.actors[1]!, 999, sim.actors[0]!);
    damageActor(sim, sim.actors[1]!, 999, sim.actors[0]!);
    const memory = sim.grudges.get(1)!;
    expect(memory.lastKilledById).toBe(0);
    expect(memory.grudgeScoreByActor[0]).toBe(30);
    memory.grudgeScoreByActor[2] = 60;
    settleGrudges(memory, sim.grudgeConflicts.get(1)!);
    expect(memory.grudgeScoreByActor).toEqual({ 0: 30, 2: 45 });
    const profiles = Array.from({ length: 10 }, (_, id) => createInitialEndlessProfile(id));
    profiles[1]!.grudge = memory; profiles[1]!.rules = rules('ranged_snipe');
    const saved = serializeEndlessSave({ roundIndex: 2, completedRounds: 1, challengeElapsed: 100,
      lastSettledRound: 1, profiles, phase: 'round-start' });
    const restored = parseEndlessSave(saved)!;
    expect(restored.profiles[1]!.grudge).toEqual(memory);
    expect(restored.profiles[1]!.rules).toEqual(rules('ranged_snipe'));
  });

  it('记仇投票锁定最高仇恨、读取实际携带宝物并只投一次概率', () => {
    const memory = createEmptyGrudgeRecord();
    memory.grudgeScoreByActor = { 0: 50, 2: 90 };
    const relics = new Map([[0, { kind: 'arrow' as const, level: 1 }], [2, { kind: 'knife' as const, level: 3 }]]);
    expect(chooseAiRule(1, 2, 'honest', memory, relics, 2, () => 0)).toMatchObject({ kind: 'ranged_snipe', revengeTargetId: 2 });
    expect(chooseAiRule(1, 2, 'honest', memory, relics, 2, () => 0.9)).not.toHaveProperty('revengeTargetId');
  });

  it('高仇恨老实人拒盟，贪财 AI 假结盟后在有财富时背叛', () => {
    for (const id of [3, 1]) {
      const sim = createInitialSimulation({ rng: () => 0 });
      const p = sim.actors[0]!, ai = sim.actors[id]!;
      p.x = 10; p.y = 10; ai.x = 11; ai.y = 10;
      sim.grudges.set(id, { ...createEmptyGrudgeRecord(), grudgeScoreByActor: { 0: 60 } });
      sendInvite(sim, 0, id); decideAI(sim, ai);
      if (id === 3) { expect(p.team).toBe(-1); expect(sendInvite(sim, id, 0)).toBe(false); expect(formTeam(sim, p, ai)).toBe(false); }
      else {
        expect(p.team).toBe(id);
        chestOf(sim, id)!.treasure = 4;
        decideAI(sim, ai);
        expect(p.team).toBe(-1);
      }
    }
  });

  it('携带飞刀增加实际刀数，近战秘策缩短真实箭矢寿命且增强飞刀范围', () => {
    const sim = createInitialSimulation({ rules: rules('close_combat'), carryRelics: new Map([[0, { kind: 'knife', level: 3 }]]) });
    const p = sim.actors[0]!;
    p.x = 10; p.y = 7; p.weaponArrow = 1; p.arrowTimer = 0;
    for (const a of sim.actors.slice(1)) { a.x = 15; a.y = 7; a.weaponKnife = 0; }
    sim.monsters.length = 0;
    stepWeapons(sim, 0.01);
    expect(sim.arrows[0]!.life).toBeCloseTo(1.4 * 0.85 - 0.01);
    expect(sim.rules.knifeRangeModifier).toBe(1.2);
    expect(p.relicAffix).toBe('knifeArea');
  });

  it('最后的安全区仍有两处固定掩体', () => {
    const sim = createInitialSimulation(); sim.shrinkStage = 7;
    expect(activeCovers(sim)).toHaveLength(2);
  });

  it('低血 AI 优先脱离近身威胁，不被追宝或已组队分支挡住', () => {
    const sim = createInitialSimulation();
    const a = sim.actors[3]!, ally = sim.actors[4]!;
    Object.assign(a, { x: 10, y: 7, hp: 20 });
    Object.assign(ally, { x: 11, y: 7 });
    formTeam(sim, a, ally);
    Object.assign(sim.monsters[0]!, { x: 10.5, y: 7, alive: true });
    sim.loots.push({ id: 999, x: 11, y: 7, z: 0, vx: 0, vy: 0, vz: 0, value: 1, life: 10, spin: 0 });
    decideAI(sim, a);
    expect(a.aim.x).toBeLessThan(a.x);
  });
});

describe('视觉资产闭包', () => {
  it('脚底环、AO、预警、40 把飞刀都真实绑定在场景中，体素部件带面亮度与折角 AO', async () => {
    const built = await art.build(undefined as never);
    if (!built.ok) throw built.error;
    const assets = built.value as Record<string, any>;
    const scene = assets['scene/island'];
    const entities = scene.entities;
    for (let id = 0; id < 10; id++) for (const state of ['player', 'ally', 'rival', 'grudge']) {
      expect(entities[`actor-${id}-ring-${state}`].components.MeshRenderer.materials).toHaveLength(1);
    }
    expect(entities['player-knife-39']).toBeDefined();
    expect(entities['cover-0-ao']).toBeDefined();
    expect(entities['shrink-boundary']).toBeDefined();
    expect(entities['raid-telegraph-fill']).toBeDefined();
    expect(entities['debris-23']).toBeDefined();

    // Tibo 的动画部件各自独立，枢轴实体存在且由角色根节点挂载
    for (const part of ['head', 'ear-left', 'ear-right', 'legs-front', 'legs-back', 'tail', 'sack']) {
      expect(entities[`actor-0-${part}`].components.ChildOf.parent).toBe('actor-0');
    }
    expect(entities['boss-claw-left'].components.ChildOf.parent).toBe('boss');
    expect(entities['chest-0-crack'].components.ChildOf.parent).toBe('chest-0');

    // 顶点色承载体素颜色：躯干纯白部件既有顶面亮值也有侧面/AO 暗值，且没有死黑
    const colors = assets['mesh/char-body'].attributes.color as Float32Array;
    const rgb = Array.from(colors).filter((_, index) => index % 4 !== 3);
    const min = Math.min(...rgb);
    const max = Math.max(...rgb);
    expect(max).toBeGreaterThan(0.5);
    expect(min).toBeLessThan(max * 0.75);
    expect(min).toBeGreaterThan(0.2);
    // 头部含亮黑鼻头与眼睛，但不允许出现纯 0 的死黑块
    const headColors = assets['mesh/char-head'].attributes.color as Float32Array;
    expect(Math.min(...Array.from(headColors))).toBeGreaterThan(0);
  });

  it('体素网格剔除内部隐藏面并输出有效三角形', async () => {
    const built = await art.build(undefined as never);
    if (!built.ok) throw built.error;
    const assets = built.value as Record<string, any>;
    for (const key of ['mesh/char-head', 'mesh/boss-shell', 'mesh/cover-rock', 'mesh/tile-0']) {
      const mesh = assets[key];
      expect(mesh.kind).toBe('mesh');
      expect(mesh.indices.length).toBeGreaterThan(0);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.aabb).toBeDefined();
      // 隐藏面剔除：三角形数远小于「每体素 12 个三角形」的上界
      expect(mesh.indices.length / 3).toBeLessThan(mesh.attributes.position.length / 3);
    }
  });
});
