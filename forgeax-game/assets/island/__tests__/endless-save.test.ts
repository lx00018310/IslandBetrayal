import { describe, expect, it } from 'vitest';
import {
  ENDLESS_SAVE_KEY,
  parseEndlessSave,
  serializeEndlessSave,
} from '../endless-save.ts';
import { createInitialEndlessProfile, type EndlessProfile } from '../stats.ts';

function profiles(): EndlessProfile[] {
  const list: EndlessProfile[] = [];
  for (let i = 0; i < 10; i++) list.push(createInitialEndlessProfile(i));
  return list;
}

describe('无限模式持久存档（序列化 / 校验 / 损坏处理）', () => {
  it('往返序列化保留局数、规则、宝物词条与失利负担', () => {
    const p = profiles();
    p[0]!.endlessRound = 5;
    p[0]!.lossBurden = 3;
    p[0]!.rules.push({ ownerId: 0, stat: 'damage', factor: 1.2, chosenAtRound: 2 });
    p[0]!.rules.push({ ownerId: 0, stat: 'maxHp', factor: 0.9, chosenAtRound: 4 });
    p[0]!.carryRelic = { kind: 'knife', level: 3, affix: 'knifeArea' };
    p[1]!.lossBurden = 20;

    const raw = serializeEndlessSave({
      roundIndex: 5,
      completedRounds: 4,
      challengeElapsed: 1234.5,
      lastSettledRound: 4,
      profiles: p,
      phase: 'round-start',
    });
    const parsed = parseEndlessSave(raw)!;
    expect(parsed).not.toBeNull();
    expect(parsed.roundIndex).toBe(5);
    expect(parsed.completedRounds).toBe(4);
    expect(parsed.challengeElapsed).toBeCloseTo(1234.5);
    expect(parsed.lastSettledRound).toBe(4);
    expect(parsed.profiles).toHaveLength(10);

    const p0 = parsed.profiles.find((x) => x.actorId === 0)!;
    expect(p0.endlessRound).toBe(5);
    expect(p0.lossBurden).toBe(0);
    expect(p0.rules).toHaveLength(2);
    expect(p0.carryRelic).toEqual({ kind: 'knife', level: 3, affix: 'knifeArea' });
    expect(parsed.profiles.find((x) => x.actorId === 1)!.lossBurden).toBe(0);
  });

  it('拒绝损坏 / 缺角色 / 版本错误的存档（不偷偷覆盖）', () => {
    expect(parseEndlessSave(null)).toBeNull();
    expect(parseEndlessSave('')).toBeNull();
    expect(parseEndlessSave('not-json')).toBeNull();
    expect(parseEndlessSave('{}')).toBeNull();
    expect(parseEndlessSave(JSON.stringify({ version: 2, mode: 'endless' }))).toBeNull();

    // 只有 9 份 profile → 视为损坏
    const raw = serializeEndlessSave({
      roundIndex: 2,
      completedRounds: 1,
      challengeElapsed: 100,
      lastSettledRound: 1,
      profiles: profiles().slice(0, 9),
      phase: 'round-start',
    });
    expect(parseEndlessSave(raw)).toBeNull();
  });

  it('过滤非法规则与非法宝物（倍率白名单 / 等级范围）', () => {
    const p = profiles();
    p[0]!.rules.push({ ownerId: 0, stat: 'damage', factor: 1.2, chosenAtRound: 1 });
    const raw = serializeEndlessSave({
      roundIndex: 1,
      completedRounds: 0,
      challengeElapsed: 0,
      lastSettledRound: 0,
      profiles: p,
      phase: 'round-start',
    });
    // 注入非法规则与非法宝物
    const tampered = JSON.parse(raw);
    tampered.profiles[0].rules.push({ ownerId: 0, stat: 'hack', factor: 99, chosenAtRound: 1 });
    tampered.profiles[0].carryRelic = { kind: 'sword', level: 9 };
    const parsed = parseEndlessSave(JSON.stringify(tampered))!;
    expect(parsed.profiles[0]!.rules).toHaveLength(1);
    expect(parsed.profiles[0]!.carryRelic).toBeNull();
  });

  it('旧存档的失利负担读入后归零', () => {
    const p = profiles();
    const raw = serializeEndlessSave({
      roundIndex: 1,
      completedRounds: 0,
      challengeElapsed: 0,
      lastSettledRound: 0,
      profiles: p,
      phase: 'round-start',
    });
    const tampered = JSON.parse(raw);
    tampered.profiles[0].lossBurden = 999;
    tampered.profiles[1].lossBurden = -5;
    const parsed = parseEndlessSave(JSON.stringify(tampered))!;
    expect(parsed.profiles[0]!.lossBurden).toBe(0);
    expect(parsed.profiles[1]!.lossBurden).toBe(0);
  });

  it('存档键名固定且为 v1', () => {
    expect(ENDLESS_SAVE_KEY).toBe('island.endless.save.v1');
  });
});
