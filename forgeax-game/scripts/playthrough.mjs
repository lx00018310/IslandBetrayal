// 《荒岛分赃》端到端玩法验收与极简操作/无限模式连续挑战断言
// 验证：
// 1. PC: 唯一战斗操作为 WASD 移动 + Space 组队/确认；手机：摇杆 +【组队】
// 2. 靠近候选角色 -> 按 Space 发起邀请/接受 -> 连线 -> 拉开距离 -> 4m 预警 -> 5m 断线爆箱
// 3. 升级三选一 -> Space 确认卡片升级
// 4. 终局胜负结算 (Round 1 结束)
// 5. 无限模式局末全场秘策选择 (5 属性 x 4 倍率) -> Space 确认
// 6. 跨局携带宝物选择 (保留武器等级) -> Space 确认进入 Round 2
// 7. 进入 Round 2 并验证多角色独立规则累乘与携带宝物生效
// 8. 连续挑战推进至 Round 3，验证历史累乘 (如 1.20 x 0.90 = 1.08) 与真实有效体验时间统计
// 运行: pnpm exec forgeax project play scripts/playthrough.mjs --json

let verifiedUpgrades = 0;

async function moveFor(play, key, seconds = 0.25) {
  const before = await play.state('island.match');
  return await play.keyboard.hold(key, (cur) =>
    cur.elapsed >= before.elapsed + seconds || cur.pendingUpgrade || !cur.player.alive || cur.gameOver,
    { read: 'island.match', timeoutMs: 3000 });
}

async function confirmUpgrade(play) {
  const before = await play.state('island.match');
  if (!before.pendingUpgrade || before.gameOver) return;
  await play.screenshot(`upgrade-${verifiedUpgrades + 1}-choices`);
  await play.advance(2);
  const paused = await play.state('island.match');
  if (paused.elapsed !== before.elapsed || paused.session.challengeElapsed !== before.session.challengeElapsed) {
    throw new Error('Upgrade pause advanced simulation or challenge time');
  }
  const weaponIndex = before.upgradeChoices.findIndex((c) => c.type === 'weapon');
  const targetIndex = weaponIndex >= 0 ? weaponIndex : 0;
  const presses = (targetIndex - before.endless.upgradeHighlight + 3) % 3;
  for (let i = 0; i < presses; i++) await play.keyboard.press('KeyD');
  await play.keyboard.press('Space');
  await play.waitFor((cur) => !cur.pendingUpgrade, { read: 'island.match', timeoutMs: 3000 });
  verifiedUpgrades++;
  await play.screenshot(`upgrade-${verifiedUpgrades}-confirmed`);
}

async function moveToward(play, targetX, targetY, stopDist = 2.0) {
  for (let i = 0; i < 15; i++) {
    let s = await play.state('island.match');
    if (!s.player.alive) break;
    if (s.pendingUpgrade) {
      await confirmUpgrade(play);
      s = await play.state('island.match');
    }
    const dx = targetX - s.player.x;
    const dy = targetY - s.player.y;
    if (Math.hypot(dx, dy) <= stopDist) break;
    if (Math.abs(dx) > Math.abs(dy)) {
      const key = dx > 0 ? 'KeyD' : 'KeyA';
      await moveFor(play, key);
    } else {
      const key = dy > 0 ? 'KeyS' : 'KeyW';
      await moveFor(play, key);
    }
  }
}

async function advanceTime(play, totalSeconds, stopForUpgrade = false) {
  let cur = await play.state('island.match');
  const targetElapsed = cur.elapsed + totalSeconds;
  while (cur.elapsed < targetElapsed && !cur.gameOver) {
    await play.advance(Math.min(25, targetElapsed - cur.elapsed));
    cur = await play.state('island.match');
    if (cur.gameOver) break;
    if (cur.pendingUpgrade) {
      if (stopForUpgrade) return;
      await confirmUpgrade(play);
    }
    cur = await play.state('island.match');
  }
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  verifiedUpgrades = 0;
  await play.page.waitForSelector('html[data-forgeax-input="open"]');
  // 1. 出生状态与初始候选检测
  const start = await play.step('spawn', async () => {
    await play.screenshot('01-spawn');
    const s = await play.state('island.match');
    if (!s || s.aliveCount < 1 || !s.player.alive) {
      throw new Error(`Expected alive player and actors at spawn, got aliveCount=${s?.aliveCount}`);
    }
    return s;
  });

  const distance = (s) =>
    Math.hypot(
      s.player.position[0] - start.player.position[0],
      s.player.position[2] - start.player.position[2],
    );

  // 2. 验证 WASD 移动
  const walked = await play.step('walk', async () => {
    const res = await play.keyboard.hold('KeyW', (s) => distance(s) > 0.25, {
      read: 'island.match',
      timeoutMs: 3000,
    });
    await play.screenshot('02-walk');
    if (distance(res) <= 0.2) {
      throw new Error(`Player movement failed: distance traveled ${distance(res)}`);
    }
    return res;
  });

  // 3. 验证唯一按键 Space 触发组队邀请/接受 (R03)
  await play.step('team-space-invite', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      let s = await play.state('island.match');
      if (s.partner) break;

      if (s.pendingUpgrade) {
        await confirmUpgrade(play);
        continue;
      }

      if (s.incomingInvite) {
        await play.keyboard.press('Space');
        await play.advance(0.3);
        s = await play.state('island.match');
        if (s.partner) break;
      }

      if (!s.candidate && s.nearestActor) {
        await moveToward(play, s.nearestActor.x, s.nearestActor.y, 1.8);
        s = await play.state('island.match');
      }

      if (s.candidate && s.candidate.canInvite) {
        await play.keyboard.press('Space');
        await play.advance(0.3);
        s = await play.state('island.match');
        if (s.partner) break;
      }
    }

    const linkedState = await play.state('island.match');
    await play.screenshot('03-team-linked');
    if (!linkedState.partner) {
      throw new Error('Failed to form a team using Space key');
    }
  });

  // 4. 验证拉开距离到 4.0m 变红预警与 >5.0m 断线中点爆箱
  await play.step('team-distance-and-burst', async () => {
    let s = await play.state('island.match');
    if (!s.partner) {
      throw new Error('Expected partner before testing distance warning and burst');
    }
    const disbandsBefore = s.playerDisbands;

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

    let warningState = null;
    for (let step = 0; step < 80; step++) {
      const cur = await play.state('island.match');
      if (cur.pendingUpgrade) { await confirmUpgrade(play); continue; }
      if (!cur.partner) break;
      if (cur.partner.isWarning) { warningState = cur; break; }
      const key = getAwayKey(cur);
      const moved = await moveFor(play, key, 0.1);
      if (moved.partner?.isWarning) { warningState = moved; break; }
    }
    if (!warningState) throw new Error('Expected visible 4m team warning before burst');
    await play.screenshot('04-team-warning');

    for (let step = 0; step < 80; step++) {
      const cur = await play.state('island.match');
      if (cur.pendingUpgrade) { await confirmUpgrade(play); continue; }
      if (!cur.partner || cur.playerDisbands > disbandsBefore) break;
      const key = getAwayKey(cur);
      await moveFor(play, key);
    }

    const cur = await play.state('island.match');
    await play.screenshot('05-team-burst');
    if (cur.partner !== null || cur.playerDisbands <= disbandsBefore || cur.lastBreakEvent?.reason !== 'distance') {
      throw new Error('Expected team to break and burst chest when distance exceeds 5.0m');
    }

    await moveToward(play, 11, 11, 1.5);
  });

  // 5. 验证肉鸽升级三选一与 Space 确认
  await play.step('roguelike-upgrade', async () => {
    let s = await play.state('island.match');
    if (verifiedUpgrades === 0 && !s.pendingUpgrade && !s.gameOver) {
      await advanceTime(play, 90, true);
    }
    s = await play.state('island.match');
    if (s.pendingUpgrade) await confirmUpgrade(play);
    if (verifiedUpgrades === 0) throw new Error('Upgrade did not occur; upgrade confirmation is unverified');
    await play.screenshot('07-upgraded');
  });

  // 6. 终局加时决胜与 Round 1 结算 (M0/R02)
  await play.step('round1-final-result', async () => {
    let s = await play.state('island.match');
    if (!s.gameOver) {
      await advanceTime(play, 340);
    }
    await play.waitFor((cur) => cur.gameOver === true, {
      read: 'island.match',
      timeoutMs: 15000,
    });
    s = await play.state('island.match');
    if (!s.gameOver) {
      throw new Error('Expected match to be over after combat resolution');
    }
    if (s.endless.phase !== 'round-result') {
      throw new Error(`Expected endless phase round-result, got ${s.endless.phase}`);
    }
    await play.screenshot('08-round1-result');
    const challengeTime = s.session.challengeElapsed;
    await play.advance(2);
    if ((await play.state('island.match')).session.challengeElapsed !== challengeTime) {
      throw new Error('Result screen counted challenge time');
    }
  });

  // 7. 无限模式局末全场秘策选择 (M3)
  await play.step('endless-secret-rule-choice', async () => {
    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'rule-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.screenshot('09-rule-pick');

    await play.keyboard.press('KeyD');
    await play.keyboard.press('Space');

    await play.waitFor((cur) => cur.endless.phase === 'relic-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });
    await play.screenshot('10-relic-pick');
  });

  // 8. 携带一件宝物进入 Round 2 (M4)
  await play.step('endless-relic-choice-and-round2', async () => {
    const result = await play.state('island.match');
    const expectedRelic = result.endless.ownedRelics[0] ?? null;
    await play.keyboard.press('Space');
    await play.waitFor(
      (cur) => cur.gameOver === false && cur.endless.roundIndex === 2 && cur.elapsed < 15,
      { read: 'island.match', timeoutMs: 8000 },
    );

    const round2State = await play.state('island.match');
    if (round2State.endless.roundIndex !== 2) {
      throw new Error(`Expected roundIndex 2, got ${round2State.endless.roundIndex}`);
    }
    if (round2State.session.roundsCompleted < 1) {
      throw new Error(`Expected roundsCompleted >= 1, got ${round2State.session.roundsCompleted}`);
    }
    if (JSON.stringify(round2State.endless.playerRelic) !== JSON.stringify(expectedRelic)) {
      throw new Error('Relic kind or level was not retained into round 2');
    }
    await play.screenshot('11-round2-start');
  });

  // 9. 连续挑战推进至第 3 局，验证历史累乘生效与持续可玩 (M3/M5)
  await play.step('endless-round3-progression', async () => {
    let s = await play.state('island.match');
    if (!s.gameOver) {
      await advanceTime(play, 360);
    }
    await play.waitFor((cur) => cur.gameOver === true, {
      read: 'island.match',
      timeoutMs: 15000,
    });
    await play.screenshot('12-round2-result');

    await play.keyboard.press('Space');
    await play.waitFor((cur) => cur.endless.phase === 'rule-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });

    await play.page.locator('[data-ui-part="rule-card-0"]').click();
    await play.page.locator('[data-ui-part="factor-pill-3"]').click();
    await play.advance(0.25);
    if (!(await play.page.locator('[data-ui-part="factor-pill-3"]').getAttribute('class')).includes('selected')) {
      throw new Error('Pointer rule choice was overwritten by the next HUD update');
    }
    await play.screenshot('12b-pointer-rule-choice');
    await play.page.locator('[data-ui-part="btn-confirm-rule"]').click();
    await play.waitFor((cur) => cur.endless.phase === 'relic-pick', {
      read: 'island.match',
      timeoutMs: 5000,
    });

    await play.page.locator('[data-relic-idx="0"]').click();
    await play.advance(0.25);
    if ((await play.state('island.match')).endless.roundIndex !== 2) throw new Error('Relic highlight started a round before confirmation');
    await play.page.locator('[data-ui-part="btn-confirm-relic"]').click();
    await play.waitFor(
      (cur) => cur.gameOver === false && cur.endless.roundIndex === 3 && cur.elapsed < 15,
      { read: 'island.match', timeoutMs: 8000 },
    );

    const round3State = await play.state('island.match');
    if (round3State.endless.roundIndex !== 3) {
      throw new Error(`Expected roundIndex 3, got ${round3State.endless.roundIndex}`);
    }
    if (round3State.session.roundsCompleted < 2) {
      throw new Error(`Expected roundsCompleted >= 2, got ${round3State.session.roundsCompleted}`);
    }
    if (round3State.endless.rulesCount !== 20) {
      throw new Error(`Expected rule accumulation across rounds, rulesCount=${round3State.endless.rulesCount}`);
    }
    const pointerRule = round3State.endless.rules.find((r) => r.ownerId === 0 && r.chosenAtRound === 2);
    if (pointerRule?.stat !== 'maxHp' || pointerRule?.factor !== 0.8) throw new Error('Pointer rule selection applied the wrong stat or factor');
    for (const stat of ['maxHp', 'damage', 'moveSpeed', 'attackSpeed', 'critChance']) {
      const expected = round3State.endless.rules.filter((r) => r.stat === stat).reduce((v, r) => v * r.factor, 1);
      if (Math.abs(round3State.endless.worldMultipliers[stat] - expected) > 0.001) {
        throw new Error(`Historical world multiplier mismatch: ${stat}`);
      }
    }
    await play.screenshot('13-round3-start');
  });

  const finalState = await play.state('island.match');
  await play.reload();
  await play.page.waitForSelector('html[data-forgeax-input="open"]');
  const reloaded = await play.state('island.match');
  if (reloaded.endless.roundIndex !== 1 || reloaded.endless.rulesCount !== 0) throw new Error('Reload did not start a fresh challenge');
  const beforeReloadWalk = reloaded.player.y;
  const afterReloadWalk = await play.keyboard.hold('KeyS', (s) => s.player.y > beforeReloadWalk + 0.25, { read: 'island.match', timeoutMs: 3000 });
  if (afterReloadWalk.player.y <= beforeReloadWalk + 0.25) throw new Error('Movement failed after reload');
  await play.screenshot('14-reload-playable');
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
  };
}
