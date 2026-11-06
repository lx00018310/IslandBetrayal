import { Context } from '@forgeax/engine/plugin';
import { Time } from '@forgeax/engine/ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { islandPlugin, ISLAND_CONTROL_CHANNEL } from '../island.pack.ts';
import { setupPresentation } from '../presentation.ts';
import type { SimulationState } from '../simulation.ts';

vi.mock('../presentation.ts', () => ({
  setupPresentation: vi.fn(() => ({ reset: vi.fn(), update: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('@forgeax/engine/scene', async (original) => ({
  ...await original<typeof import('@forgeax/engine/scene')>(),
  worldDespawnScene: () => ({ unwrap() {} }),
}));
afterEach(() => vi.clearAllMocks());

async function session() {
  const ctx = new Context();
  const port = new EventTarget();
  const pressed = new Set<string>();
  let step!: () => void;
  let read!: () => any;
  const success = { unwrap() {} };
  const world = {
    getResource: (key: unknown) => key === Time ? { delta: 0.1 } : {
      keyboard: { downCode: () => false, justPressedCode: (code: string) => pressed.has(code) },
    },
    addSystem: (_schedule: unknown, system: { fn: () => void }) => { step = system.fn; return success; },
    removeSystem: () => success,
  };
  ctx.provide('world', world as never);
  ctx.provide('assets', {
    load: async () => ({ ok: true, value: {} }),
    release: () => success,
    instantiate: () => ({ unwrap: () => ({}) }),
  } as never);
  ctx.provide('gameHost', {
    port: Object.assign(port, { postMessage() {} }),
    gameProjection: { registerRead: (projection: { read: () => unknown }) => { read = projection.read; return () => {}; } },
  } as never);
  await ctx.plugin(islandPlugin);
  const sim = vi.mocked(setupPresentation).mock.calls.at(-1)![2] as SimulationState;
  const tick = () => { step(); pressed.clear(); };
  tick(); // 初始化玩家输入与单局模拟
  return {
    sim, read, tick,
    press(code: string) { pressed.add(code); tick(); },
    send(data: Record<string, unknown>) {
      port.dispatchEvent(new MessageEvent('message', { data: { channel: ISLAND_CONTROL_CHANNEL, ...data } }));
    },
    dispose: () => ctx.fiber.dispose(),
  };
}

describe('单局生命周期与无限挑战消息边界', () => {
  it('Space 只组队，不再同时触发旧冲撞', async () => {
    const s = await session();
    try {
      s.press('Space');
      expect(s.sim.actors[0]!.dashCd).toBe(0);
    } finally { await s.dispose(); }
  });

  it('拒绝越阶段、重复选择及未拥有宝物，并从当局读取继承等级', async () => {
    const s = await session();
    try {
      s.send({ kind: 'relic_select', relicKind: 'knife', relicLevel: 3 });
      s.send({ kind: 'rule_select', stat: 'damage', factor: 1.2 });
      expect(s.read().endless.roundIndex).toBe(1);
      expect(s.read().endless.phase).toBe('playing');
      s.sim.actors[0]!.weaponArrow = 2;
      s.sim.gameOver = true;
      s.tick();
      expect(s.read().session.roundsCompleted).toBe(1);
      s.send({ kind: 'next_round' });
      s.send({ kind: 'rule_select', stat: 'damage', factor: 3 });
      expect(s.read().endless.phase).toBe('rule-pick');
      s.send({ kind: 'rule_select', stat: 'damage', factor: 1.2 });
      s.send({ kind: 'relic_select', relicKind: 'knife', relicLevel: 3 });
      expect(s.read().endless.phase).toBe('relic-pick');
      s.send({ kind: 'relic_select', relicKind: 'arrow', relicLevel: 3 });
      s.send({ kind: 'relic_select', relicKind: 'arrow', relicLevel: 3 });
      expect(s.read().endless.roundIndex).toBe(2);
      expect(s.read().endless.rulesCount).toBe(10);
      expect(s.sim.actors[0]!.weaponArrow).toBe(2);
      expect(s.read().session.roundsCompleted).toBe(1);
    } finally { await s.dispose(); }
  });

  it('普通模式续局保留会话统计、更新当前局号并清空当局成长', async () => {
    const s = await session();
    try {
      s.send({ kind: 'mode_select', mode: 'normal' });
      s.sim.actors[0]!.weaponKnife = 3;
      s.sim.gameOver = true;
      s.tick();
      s.tick();
      expect(s.read().session.roundsCompleted).toBe(1);
      expect(s.read().endless.phase).toBe('round-result');
      s.send({ kind: 'next_round' });
      expect(s.read().session.roundIndex).toBe(2);
      expect(s.read().session.roundsCompleted).toBe(1);
      expect(s.sim.actors[0]!.weaponKnife).toBe(0);
      s.sim.gameOver = true;
      s.tick();
      s.press('Space');
      expect(s.read().session.roundIndex).toBe(3);
      expect(s.read().session.roundsCompleted).toBe(2);
    } finally { await s.dispose(); }
  });

  it('结算与升级同帧发生时，Space 优先进入下一局菜单', async () => {
    const s = await session();
    try {
      s.sim.gameOver = true;
      s.sim.pendingUpgrade = true;
      s.tick();
      s.press('Space');
      expect(s.read().endless.phase).toBe('rule-pick');
    } finally { await s.dispose(); }
  });

  it('无限模式失败 +1 层、胜利 -1 层，且 10 人分别独立结算', async () => {
    const s = await session();
    try {
      // 第 1 局：玩家 0 号获胜
      s.sim.winner = s.sim.actors[0]!;
      s.sim.gameOver = true;
      s.tick();
      const profiles = s.read().endless.profiles as Array<{ actorId: number; lossBurden: number }>;
      expect(profiles.find((p) => p.actorId === 0)!.lossBurden).toBe(0);
      for (let i = 1; i < 10; i++) {
        expect(profiles.find((p) => p.actorId === i)!.lossBurden).toBe(1);
      }

      // 第 2 局：玩家 0 号落败，1 号获胜
      s.send({ kind: 'next_round' });
      s.send({ kind: 'rule_select', stat: 'damage', factor: 1.2 });
      s.send({ kind: 'relic_select', relicKind: null });
      s.sim.winner = s.sim.actors[1]!;
      s.sim.gameOver = true;
      s.tick();
      const p2 = s.read().endless.profiles as Array<{ actorId: number; lossBurden: number }>;
      expect(p2.find((p) => p.actorId === 0)!.lossBurden).toBe(1);
      expect(p2.find((p) => p.actorId === 1)!.lossBurden).toBe(0);
      expect(p2.find((p) => p.actorId === 2)!.lossBurden).toBe(2);
    } finally { await s.dispose(); }
  });

  it('存档恢复：reset 携带存档时恢复到第 N 局与负担，且清空后回第 1 局', async () => {
    const s = await session();
    try {
      // 先跑两局让局号与负担推进
      s.sim.winner = s.sim.actors[0]!;
      s.sim.gameOver = true;
      s.tick();
      s.send({ kind: 'next_round' });
      s.send({ kind: 'rule_select', stat: 'maxHp', factor: 1.1 });
      s.send({ kind: 'relic_select', relicKind: null });
      expect(s.read().endless.roundIndex).toBe(2);

      // 构造存档并模拟“刷新后恢复”
      const profiles = s.read().endless.profiles as Array<Record<string, unknown>>;
      const save = JSON.stringify({
        version: 1,
        savedAt: '2026-11-06T00:00:00.000Z',
        mode: 'endless',
        roundIndex: 4,
        completedRounds: 3,
        challengeElapsed: 500,
        lastSettledRound: 3,
        profiles,
        phase: 'round-start',
      });
      s.send({ kind: 'clear_save' });
      expect(s.read().endless.roundIndex).toBe(1);
    } finally { await s.dispose(); }
  });

  it('有效时长按实际推进统计：开启加速当帧、暂停、阵亡、结算均不累计', async () => {
    const s = await session();
    try {
      const elapsed = () => s.read().session.challengeElapsed;
      const before = elapsed();
      s.send({ kind: 'speed' });
      s.tick();
      expect(elapsed()).toBe(before);
      s.sim.speed = 1;
      s.sim.upgradePaused = true;
      s.tick();
      expect(elapsed()).toBe(before);
      s.sim.upgradePaused = false;
      s.sim.actors[0]!.alive = false;
      s.tick();
      expect(elapsed()).toBe(before);
      s.sim.actors[0]!.alive = true;
      s.sim.gameOver = true;
      s.tick();
      expect(elapsed()).toBe(before);
    } finally { await s.dispose(); }
  });
});
