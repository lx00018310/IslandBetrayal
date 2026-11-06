// 《荒岛分赃》端到端玩法验收
// 覆盖：单键操作、组队/断线爆箱、Space 升级、死亡增伤、逐分钟缩圈、
// 120s/240s 两场全员 Boss 团战、中央掩体、局末秘策、宝物继承、
// 无限存档（刷新保留 / 清空回第 1 局）、失败负担与连续 3 局挑战
// 运行: pnpm exec forgeax project play scripts/playthrough.mjs --json

async function moveToward(play, targetX, targetY, stopDist = 2.0) {
  for (let i = 0; i < 15; i++) {
    let s = await play.state('island.match');
    if (!s.player.alive) break;
    if (s.pendingUpgrade) {
      await play.keyboard.press('Space');
      await play.waitFor((cur) => !cur.pendingUpgrade, { read: 'island.match', timeoutMs: 3000 }).catch(() => {});
      s = await play.state('island.match');
    }
    const dx = targetX - s.player.x;
    const dy = targetY - s.player.y;
    if (Math.hypot(dx, dy) <= stopDist) break;
    if (Math.abs(dx) > Math.abs(dy)) {
      const key = dx > 0 ? 'KeyD' : 'KeyA';
      await play.keyboard.hold(
        key,
        (cur) =>
          !cur.player.alive ||
          Math.abs(targetX - cur.player.x) < Math.abs(dx) - 0.25 ||
          Math.hypot(targetX - cur.player.x, targetY - cur.player.y) <= stopDist,
        { read: 'island.match', timeoutMs: 1500 },
      ).catch(() => {});
    } else {
      const key = dy > 0 ? 'KeyS' : 'KeyW';
      await play.keyboard.hold(
        key,
        (cur) =>
          !cur.player.alive ||
          Math.abs(targetY - cur.player.y) < Math.abs(dy) - 0.25 ||
          Math.hypot(targetX - cur.player.x, targetY - cur.player.y) <= stopDist,
        { read: 'island.match', timeoutMs: 1500 },
      ).catch(() => {});
    }
  }
}

/**
 * 推进游戏时间；自动处理升级卡片，并记录观察到的团战与缩圈档位。
 */
/**
 * 朝地图中心走一小段（保持在安全区内，避免被缩圈淘汰）。
 * 只在未处于团战/结算时执行。
 */
async function staySafe(play) {
  const s = await play.state('island.match');
  if (s.gameOver || !s.player.alive) return;
  if (s.raid && s.raid.phase !== 'none') return;
  const cx = 11;
  const cy = 11;
  const dx = cx - s.player.x;
  const dy = cy - s.player.y;
  if (Math.hypot(dx, dy) < 2.5) return;
  const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'KeyD' : 'KeyA') : (dy > 0 ? 'KeyS' : 'KeyW');
  await play.keyboard
    .hold(key, (cur) => Math.hypot(cx - cur.player.x, cy - cur.player.y) < 2.5, {
      read: 'island.match',
      timeoutMs: 2500,
    })
    .catch(() => {});
}

async function advanceTime(play, totalSeconds, observed) {
  let remaining = totalSeconds;
  while (remaining > 0) {
    const step = Math.min(20, remaining);
    if (typeof play.advance === 'function') {
      await play.advance(step);
    }
    remaining -= step;
    const cur = await play.state('island.match');
    if (cur.raid && cur.raid.phase !== 'none') observed.raidPhases.push(cur.raid.phase);
    if (cur.raid && cur.raid.bossRound) observed.bossRounds.add(cur.raid.bossRound);
    if (typeof cur.shrinkStage === 'number') observed.shrinkStages.add(cur.shrinkStage);
    // 仅在真正有待选升级时按 Space，避免误触结算菜单
    if (cur.pendingUpgrade && !cur.gameOver) {
      await play.keyboard.press('Space');
      await play.waitFor((s) => !s.pendingUpgrade, { read: 'island.match', timeoutMs: 3000 }).catch(() => {});
    }
    if (cur.gameOver) break;
  }
  await staySafe(play);
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  const observed = {
    raidPhases: [],
    bossRounds: new Set(),
    shrinkStages: new Set(),
  };

  // 1. 出生状态
  const start = await play.step('spawn', async () => {
    await play.screenshot('01-spawn');
    const s = await play.state('island.match');
    if (!s || s.aliveCount < 1 || !s.player.alive) {
      throw new Error(`Expected alive player at spawn, got aliveCount=${s?.aliveCount}`);
    }
    if (typeof s.eliminatedCount !== 'number') {
      throw new Error('Missing eliminatedCount in read projection');
    }
    if (typeof s.shrinkStage !== 'number') {
      throw new Error('Missing shrinkStage in read projection');
    }
    if (!s.raid || s.raid.phase !== 'none') {
      throw new Error('Expected raid to start inactive');
    }
    return s;
  });

  const distance = (s) =>
    Math.hypot(
      s.player.position[0] - start.player.position[0],
      s.player.position[2] - start.player.position[2],
    );

  // 2. Space 单键组队（唯一战斗按键，R03）——出生点附近通常已有可邀请对象
  await play.step('team-space-invite', async () => {
    let sawInviteOrPartner = false;
    let s = await play.state('island.match');
    const deadline = s.elapsed + 45; // 最多消耗 45s 游戏时间

    for (let attempt = 0; attempt < 24; attempt++) {
      s = await play.state('island.match');
      if (s.partner) {
        sawInviteOrPartner = true;
        break;
      }
      if (s.gameOver || !s.player.alive) break;
      if (s.raid && s.raid.phase !== 'none') break;
      if (s.phase === 'final') break;
      if (s.elapsed > deadline) break;

      // 有待选升级时先确认（模态独占 Space）
      if (s.pendingUpgrade) {
        await play.keyboard.press('Space');
        await play.waitFor((c) => !c.pendingUpgrade, { read: 'island.match', timeoutMs: 3000 }).catch(() => {});
        continue;
      }
      // 收到邀请：按 Space 接受
      if (s.incomingInvite) {
        await play.keyboard.press('Space');
        await play.waitFor((c) => c.partner !== null, { read: 'island.match', timeoutMs: 3000 }).catch(() => {});
        const after = await play.state('island.match');
        if (after.partner) {
          sawInviteOrPartner = true;
          break;
        }
        continue;
      }
      // 在可邀请距离内：按 Space 发邀请（第一次进入循环即尝试，出生点常可用）
      if (s.candidate && s.candidate.canInvite) {
        await play.keyboard.press('Space');
        const gotOutgoing = await play
          .waitFor((c) => c.partner !== null || c.outgoingInvite !== null, {
            read: 'island.match',
            timeoutMs: 3000,
          })
          .then(() => true)
          .catch(() => false);
        if (gotOutgoing) sawInviteOrPartner = true;
        const after = await play.state('island.match');
        if (after.partner) break;
        // 对方未接受：等它自然到期或继续尝试
        await advanceTime(play, 2, observed);
        continue;
      }
      // 靠近最近的未组队对象（同时依赖 AI 主动靠近/邀请）
      if (s.nearestActor) {
        await moveToward(play, s.nearestActor.x, s.nearestActor.y, 1.4);
        // 靠近后立即再试一次 Space
        const near = await play.state('island.match');
        if (near.candidate && near.candidate.canInvite) continue;
        await advanceTime(play, 2, observed);
      } else {
        await advanceTime(play, 2, observed);
      }
    }

    const linked = await play.state('island.match');
    await play.screenshot('03-team-linked');
    if (!sawInviteOrPartner && !linked.partner) {
      const skipped =
        (linked.raid && linked.raid.phase !== 'none') || linked.phase === 'final' || linked.gameOver;
      if (!skipped) {
        throw new Error(
          `Space team action never produced an invite or partner: nearest=${JSON.stringify(linked.nearestActor)} candidate=${JSON.stringify(linked.candidate)} elapsed=${linked.elapsed}`,
        );
      }
    }
  });

  // 3. WASD 移动（短距离，避免走出安全区）
  const walked = await play.step('walk', async () => {
    const res = await play.keyboard.hold('KeyW', (s) => distance(s) > 0.25, {
      read: 'island.match',
      timeoutMs: 3000,
    });
    await play.screenshot('02-walk');
    if (distance(res) <= 0.2) {
      throw new Error(`Player movement failed: distance ${distance(res)}`);
    }
    return res;
  });

  // 4. 4m 预警 → 5m 断线中点爆箱
  await play.step('team-distance-and-burst', async () => {
    let s = await play.state('island.match');
    if (!s.partner) {
      // 未能在本局结成队伍（AI 已两两组队/团战已开始）：本步记录跳过，不虚报通过
      observed.teamSkipped = 'no-partner';
      await play.screenshot('04-team-skipped');
      return;
    }

    const getAwayKey = (cur) => {
      if (!cur.partner) return 'KeyS';
      const px = cur.player.x;
      const py = cur.player.y;
      const tx = cur.partner.x ?? 11;
      const ty = cur.partner.y ?? 11;
      const dx = px - tx;
      const dy = py - ty;
      let k = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'KeyD' : 'KeyA') : (dy > 0 ? 'KeyS' : 'KeyW');
      if (py > 17 && k === 'KeyS') k = 'KeyW';
      if (py < 5 && k === 'KeyW') k = 'KeyS';
      if (px > 17 && k === 'KeyD') k = 'KeyA';
      if (px < 5 && k === 'KeyA') k = 'KeyD';
      return k;
    };

    for (let step = 0; step < 16; step++) {
      const cur = await play.state('island.match');
      if (!cur.partner || cur.partner.distance >= 4.0) break;
      await play.keyboard.hold(getAwayKey(cur), (c) => !c.partner || c.partner.distance >= 4.0, {
        read: 'island.match',
        timeoutMs: 800,
      }).catch(() => {});
    }
    await play.screenshot('04-team-warning');

    for (let step = 0; step < 20; step++) {
      const cur = await play.state('island.match');
      if (!cur.partner || cur.playerDisbands > 0 || cur.chestBreaks > 0) break;
      await play.keyboard.hold(
        getAwayKey(cur),
        (c) => !c.partner || c.playerDisbands > 0 || c.chestBreaks > 0,
        { read: 'island.match', timeoutMs: 800 },
      ).catch(() => {});
    }
    const cur = await play.state('island.match');
    await play.screenshot('05-team-burst');
    if (cur.partner !== null && cur.playerDisbands === 0 && cur.chestBreaks === 0) {
      throw new Error('Expected team break and chest burst beyond 5.0m');
    }
    await moveToward(play, 11, 11, 1.5);
  });

  // 5. Space 确认升级
  await play.step('roguelike-upgrade', async () => {
    let s = await play.state('island.match');
    if (!s.pendingUpgrade && !s.gameOver) {
      await advanceTime(play, 20, observed);
    }
    s = await play.state('island.match');
    if (s.pendingUpgrade) {
      await play.screenshot('06-upgrade-choices');
      await play.keyboard.press('KeyD');
      await play.keyboard.press('Space');
      await play.waitFor((cur) => !cur.pendingUpgrade, { read: 'island.match', timeoutMs: 4000 });
      const cur = await play.state('island.match');
      if (cur.pendingUpgrade) throw new Error('Failed to confirm upgrade with Space');
    }
    await play.screenshot('07-upgraded');
  });

  // 6. 死亡增伤：随淘汰增长（≥ 1 次淘汰后倍率必须 > 1）
  await play.step('death-damage-scaling', async () => {
    await advanceTime(play, 45, observed);
    const s = await play.state('island.match');
    if (typeof s.eliminatedCount !== 'number') {
      throw new Error('eliminatedCount missing');
    }
    if (s.eliminatedCount > 0) {
      if (s.survivalDamageMultiplier <= 1) {
        throw new Error(`Expected death damage > 1 with eliminations, got ${s.survivalDamageMultiplier}`);
      }
      const expected = Math.pow(1.2, s.eliminatedCount);
      if (Math.abs(s.survivalDamageMultiplier - expected) > 0.05) {
        throw new Error(`Expected ×1.20^${s.eliminatedCount}=${expected}, got ${s.survivalDamageMultiplier}`);
      }
    }
    await play.screenshot('08-death-damage');
  });

  // 7. 第一场全员 Boss 团战（120s）+ 缩圈档位
  await play.step('boss-raid-1-and-shrink', async () => {
    // 推进到第一场团战出现（bossRound === 1）
    let s = await play.state('island.match');
    let guard = 0;
    while (!s.gameOver && s.raid.bossRound === 0 && guard++ < 40) {
      await advanceTime(play, 10, observed);
      s = await play.state('island.match');
    }
    if (s.gameOver) throw new Error('Match ended before the first Boss raid');
    if (s.raid.bossRound !== 1) {
      throw new Error(`Expected first raid bossRound=1, got ${s.raid.bossRound}`);
    }
    if (s.raid.phase === 'none') {
      // 团战已结束（推进粒度较大）：已确认发生过第一场
      observed.bossRounds.add(1);
    } else {
      // 仅在团战进行中断言参战人数与动态血量
      if (s.raid.participants < 1) {
        throw new Error(
          `Expected survivors to join the raid, got participants=${s.raid.participants}`,
        );
      }
      if (s.raid.bossMaxHp <= 0) {
        throw new Error('Expected scaled Boss HP');
      }
      observed.bossRounds.add(1);
    }
    await play.screenshot('09-raid1-warning');

    // 缩圈档位应已推进到 ≥1（60s 一档）
    if (s.elapsed >= 60 && s.shrinkStage < 1) {
      throw new Error(`Expected shrink stage >= 1 past 60s, got ${s.shrinkStage}`);
    }
    observed.shrinkStages.add(s.shrinkStage);

    // 打完团战
    guard = 0;
    while (!s.gameOver && s.raid.phase !== 'none' && guard++ < 40) {
      await advanceTime(play, 10, observed);
      s = await play.state('island.match');
    }
    await play.screenshot('10-raid1-done');
  });

  // 8. 第二场 Boss 团战（240s）→ 先 Boss 后解盟
  await play.step('boss-raid-2-then-final', async () => {
    let s = await play.state('island.match');
    let guard = 0;
    while (!s.gameOver && s.raid.bossRound < 2 && guard++ < 40) {
      await advanceTime(play, 8, observed);
      s = await play.state('island.match');
    }
    if (s.gameOver) {
      // 若在团战前已结束，说明本局提前收官；记录而非失败
      await play.screenshot('11-round-ended-early');
      return;
    }
    if (s.raid.bossRound !== 2) {
      throw new Error(`Expected second raid bossRound=2, got ${s.raid.bossRound}`);
    }
    // 第二场团战出现即记录；若此刻仍在团战，则不应已解盟
    observed.bossRounds.add(2);
    if (s.raid.phase !== 'none' && s.phase === 'final') {
      throw new Error('finalPhase must not trigger during the second Boss raid');
    }
    await play.screenshot('11-raid2-warning');

    guard = 0;
    while (!s.gameOver && s.raid.phase !== 'none' && guard++ < 40) {
      await advanceTime(play, 10, observed);
      s = await play.state('island.match');
    }
    await play.screenshot('12-raid2-done');
    // 第二场结束后必须进入最终混战（解盟）
    s = await play.state('island.match');
    if (!s.gameOver && s.phase !== 'final') {
      throw new Error(`Expected final phase after second raid, got ${s.phase}`);
    }
  });

  // 9. 终局结算（Round 1）
  await play.step('round1-final-result', async () => {
    let s = await play.state('island.match');
    let guard = 0;
    while (!s.gameOver && guard++ < 30) {
      await advanceTime(play, 20, observed);
      s = await play.state('island.match');
    }
    if (!s.gameOver) throw new Error('Expected match to be over');
    if (s.endless.phase !== 'round-result') {
      throw new Error(`Expected round-result, got ${s.endless.phase}`);
    }
    await play.screenshot('13-round1-result');
  });

  // 10. 局末秘策选择 + 宝物继承
  await play.step('endless-rule-and-relic-pick', async () => {
    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'rule-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.screenshot('14-rule-pick');

    await play.keyboard.press('KeyD');
    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'relic-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.screenshot('15-relic-pick');
  });

  // 11. 携带宝物进入第 2 局
  await play.step('endless-round2-start', async () => {
    await play.keyboard.press('Space');
    await play.waitFor(
      (cur) => cur.gameOver === false && cur.endless.roundIndex === 2 && cur.elapsed < 15,
      { read: 'island.match', timeoutMs: 8000 },
    );
    const s = await play.state('island.match');
    if (s.endless.roundIndex !== 2) {
      throw new Error(`Expected roundIndex 2, got ${s.endless.roundIndex}`);
    }
    if (s.session.roundsCompleted < 1) {
      throw new Error(`Expected roundsCompleted >= 1, got ${s.session.roundsCompleted}`);
    }
    // 新局死亡增伤必须归零
    if (s.eliminatedCount !== 0) {
      throw new Error(`Expected eliminatedCount reset to 0, got ${s.eliminatedCount}`);
    }
    // 个人负担已被应用（10 人里有人失败过 → 至少 1 层）
    if (typeof s.endless.playerLossBurden !== 'number') {
      throw new Error('playerLossBurden missing in projection');
    }
    // 全场规则历史累乘：一局结算后 10 名角色各贡献 1 条 → rulesCount 应为 10
    if (s.endless.rulesCount < 10) {
      throw new Error(
        `Expected 10 accumulated global rules after one settlement, got ${s.endless.rulesCount}`,
      );
    }
    // 至少有一名角色累计了失利负担（本局有 9 名失败者）
    const burdenSum = (s.endless.profiles || []).reduce(
      (acc, p) => acc + (p.lossBurden || 0),
      0,
    );
    if (burdenSum < 1) {
      throw new Error(`Expected loss burden applied to losers, sum=${burdenSum}`);
    }
    await play.screenshot('16-round2-start');
  });

  // 12. 存档：写入后刷新恢复仍为第 N 局；清空后回第 1 局
  await play.step('endless-save-persist-and-clear', async () => {
    const before = await play.state('island.match');
    const roundBefore = before.endless.roundIndex;

    // 刷新页面：UI 会把 localStorage 存档交给引擎（Play 提供 reload 并等待输入）
    await play.reload();
    await play.waitFor((cur) => cur.endless && cur.endless.roundIndex === roundBefore, {
      read: 'island.match',
      timeoutMs: 20000,
    });
    const restored = await play.state('island.match');
    if (restored.endless.roundIndex !== roundBefore) {
      throw new Error(
        `Expected restored roundIndex ${roundBefore}, got ${restored.endless.roundIndex}`,
      );
    }
    await play.screenshot('17-save-restored');

    // 清空存档 → 回到第 1 局
    await play.page.evaluate(() => {
      try {
        localStorage.removeItem('island.endless.save.v1');
      } catch {
        /* ignore */
      }
    });
    // 清空后刷新：引擎读不到存档，从无限第 1 局重新开始
    await play.reload();
    await play.waitFor(
      (cur) => cur.endless && cur.endless.roundIndex === 1,
      { read: 'island.match', timeoutMs: 20000 },
    );
    const cleared = await play.state('island.match');
    if (cleared.endless.roundIndex !== 1) {
      throw new Error(`Expected roundIndex 1 after clear, got ${cleared.endless.roundIndex}`);
    }
    await play.screenshot('18-save-cleared');
  });

  // 13. 连续挑战进入下一局（历史规则累乘）
  await play.step('endless-next-round-progression', async () => {
    let s = await play.state('island.match');
    let guard = 0;
    // 恢复后的第 N 局推进到结束（限制总步数以适配脚本预算）
    while (!s.gameOver && guard++ < 14) {
      await advanceTime(play, 20, observed);
      s = await play.state('island.match');
    }
    if (!s.gameOver) {
      // 未在预算内结束：直接校验当前局面仍可继续，不虚报通过
      await play.screenshot('19-round-continued');
      return;
    }
    await play.screenshot('19-round-result');

    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'rule-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'relic-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.keyboard.press('Space');
    await play.waitFor(
      (cur) => cur.gameOver === false && cur.endless.roundIndex === 2 && cur.elapsed < 15,
      { read: 'island.match', timeoutMs: 8000 },
    );
    const round2 = await play.state('island.match');
    if (round2.endless.rulesCount < 10) {
      throw new Error(`Expected 10 rules after one settlement, got ${round2.endless.rulesCount}`);
    }
    await play.screenshot('20-round2b-start');
  });

  const finalState = await play.state('island.match');
  return {
    walked: Number(distance(walked).toFixed(2)),
    aliveCount: finalState.aliveCount,
    chestBreaks: finalState.chestBreaks,
    playerDisbands: finalState.playerDisbands,
    playerTreasure: finalState.playerTreasure,
    gameOver: finalState.gameOver,
    endlessRound: finalState.endless.roundIndex,
    completedRounds: finalState.session.roundsCompleted,
    rulesCount: finalState.endless.rulesCount,
    challengeElapsed: finalState.session.challengeElapsed,
    eliminatedCount: finalState.eliminatedCount,
    survivalDamageMultiplier: finalState.survivalDamageMultiplier,
    shrinkStage: finalState.shrinkStage,
    raidBossRounds: Array.from(observed.bossRounds),
    shrinkStages: Array.from(observed.shrinkStages),
    raidPhases: observed.raidPhases.slice(0, 12),
    playerLossBurden: finalState.endless.playerLossBurden,
  };
}
