// 三大机制与视觉回归：仅使用正常输入和只读状态，不写游戏状态、不吞错。
const read = play => play.state('island.match');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function upgrades(play) {
  for (let guard = 0; guard < 30; guard++) {
    const s = await read(play);
    if (!s.pendingUpgrade || s.gameOver) return;
    // 正常方向键选卡，优先解锁尚未拥有的武器。
    const index = s.upgradeChoices.findIndex(c => c.kind === 'weapon');
    for (let i = 0; i < (index < 0 ? 0 : index); i++) await play.keyboard.press('KeyD');
    await play.keyboard.press('Space');
  }
  throw new Error('Upgrade queue did not drain');
}

async function nudge(play, key) {
  await upgrades(play);
  const before = await read(play);
  if (!before.player.alive || before.gameOver) return before;
  return play.keyboard.hold(key, s => s.pendingUpgrade || s.gameOver || !s.player.alive || s.elapsed >= before.elapsed + 0.28,
    { read: 'island.match', timeoutMs: 4000 });
}

async function toward(play, x, y, stop = 1.5, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const s = await read(play);
    if (!s.player.alive || s.gameOver || Math.hypot(x - s.player.x, y - s.player.y) <= stop) return;
    const dx = x - s.player.x, dy = y - s.player.y;
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'KeyD' : 'KeyA') : (dy > 0 ? 'KeyS' : 'KeyW');
    const after = await nudge(play, key);
    if (Math.hypot(after.player.x - s.player.x, after.player.y - s.player.y) < 0.08) {
      // 正常绕行掩体：被挡住时沿垂直方向走一步，再重新评估。
      await nudge(play, key === 'KeyA' || key === 'KeyD' ? (dy > 0 ? 'KeyS' : 'KeyW') : (dx > 0 ? 'KeyD' : 'KeyA'));
    }
  }
}

export default async function playthrough(play) {
  const covered = { team: false, betrayal: false, upgrade: false, bosses: [], telegraph: false, shrink: [], endings: [] };
  const bossSeen = new Set(), shrinkSeen = new Set();
  await play.step('spawn-and-move', async () => {
    const s = await read(play);
    assert(s.player.alive && s.aliveCount >= 2, 'Expected a living player and multiple contestants after input opens');
    await play.screenshot('01-visual-layers');
    const moved = await nudge(play, 'KeyW');
    assert(Math.hypot(moved.player.x - s.player.x, moved.player.y - s.player.y) > 0.2, 'W movement had no visible effect');
    assert(moved.player.dashCd === 0, 'Movement unexpectedly triggered dash');
    await play.screenshot('02-movement');
  });

  async function teamAndBetray() {
    for (let attempt = 0; attempt < 12; attempt++) {
      await upgrades(play);
      const s = await read(play);
      if (!s.player.alive || s.gameOver) return false;
      if (s.partner) break;
      if (s.incomingInvite || (s.candidate?.canInvite && !s.outgoingInvite)) await play.keyboard.press('Space');
      else if (s.nearestActor) await toward(play, s.nearestActor.x, s.nearestActor.y, 1.4, 3);
      await play.advance(0.5);
    }
    const teamed = await read(play);
    if (!teamed.partner || !teamed.ownChest) return false;
    covered.team = true;
    await play.screenshot('03-ally-blue-ring');
    const partnerId = teamed.partner.id;
    await upgrades(play);
    const before = await read(play);
    if (before.partner?.id !== partnerId) return false;
    const midpoint = [(before.player.x + before.partner.x) / 2, (before.player.y + before.partner.y) / 2];
    await play.keyboard.press('Space');
    await play.waitFor(s => s.lastBreakEvent?.reason === 'betrayal', { read: 'island.match', timeoutMs: 4000 });
    const after = await read(play);
    assert(after.partner === null, 'Space failed to disband the alliance');
    assert(Math.hypot(after.lastBreakEvent.x - midpoint[0], after.lastBreakEvent.y - midpoint[1]) < 0.6, 'Betrayal burst is away from the midpoint');
    covered.betrayal = true;
    await play.screenshot('04-midpoint-betrayal');
    return true;
  }

  async function teamUp() {
    for (let attempt = 0; attempt < 12; attempt++) {
      await upgrades(play);
      const s = await read(play);
      if (!s.player.alive || s.gameOver || s.partner) break;
      if (s.incomingInvite || (s.candidate?.canInvite && !s.outgoingInvite)) {
        await play.keyboard.press('Space');
        await play.advance(0.3);
      } else if (s.nearestActor) {
        await toward(play, s.nearestActor.x, s.nearestActor.y, 1.4, 3);
      }
      await play.advance(0.5);
    }
  }
  await play.step('team-attempt-round-1', () => teamAndBetray());

  async function observe() {
    let s = await read(play);
    if (s.pendingUpgrade && !s.gameOver) {
      if (!covered.upgrade) await play.screenshot('05-upgrade-queue');
      covered.upgrade = true;
      await upgrades(play);
    }
    if (s.raid.bossRound && s.raid.phase !== 'none' && s.raid.phase !== 'result' && !bossSeen.has(s.raid.bossRound)) {
      bossSeen.add(s.raid.bossRound);
      await play.screenshot(`boss-${s.raid.bossRound}-silhouette`);
      const before = await read(play);
      await play.advance(1);
      const after = await read(play);
      assert(after.gameOver || after.pendingUpgrade || after.elapsed > before.elapsed, 'Boss froze the main clock');
      s = after;
    }
    if (!covered.telegraph && (s.raid.phase === 'fight' || s.raid.phase === 'warning')) {
      // 圆形预警只持续 1.5s、每 4.5s 触发一次：在团战窗口内小步推进轮询真实状态，
      // 出现即截图（只读 + advance，不写模拟层）。
      // 只在团战阶段轮询，否则会把脚本预算耗在非团战帧上、导致后续局次跑不完。
      for (let guard = 0; guard < 28; guard++) {
        const t = await read(play);
        if (t.gameOver || t.raid.phase === 'none' || t.raid.phase === 'result') break;
        if (t.raid.telegraph) {
          covered.telegraph = true;
          await play.screenshot('boss-red-telegraph');
          break;
        }
        await play.advance(0.2);
      }
      // 轮询会推进时间，重新读一次，避免后续截图与断言用过期的 s
      s = await read(play);
    }
    if (!shrinkSeen.has(s.shrinkStage)) {
      shrinkSeen.add(s.shrinkStage);
      await play.screenshot(`shrink-${s.shrinkStage}`);
    }
    if (s.raid.bossRound === 2 && s.elapsed >= 275 && !s.gameOver) assert(s.phase === 'final' && !s.partner, 'Final disband is late');
    const expected = (s.ruleEffects?.bloodFeudBase ?? 1.2) ** s.eliminatedCount;
    assert(Math.abs(s.survivalDamageMultiplier - expected) < 0.01, 'Survival damage multiplier diverged');
    return read(play);
  }

  async function finishRound() {
    for (let guard = 0; guard < 420; guard++) {
      const s = await observe();
      if (s.gameOver) {
        covered.endings.push(s.winnerId === 0 ? 'victory' : 'defeat');
        await play.screenshot(`round-${s.endless.roundIndex}-result`);
        return s;
      }
      if (s.player.alive) {
        // 组队是真实的减伤机制：队内受击先由共享宝箱承伤（60 + 财富×6 HP），
        // 因此存活期用真实 Space 结盟，才能活到 120s / 240s 的两次 Boss 出场。
        // 背叛覆盖已在 round-1 专项步骤中完成，这里不再主动拆队。
        if (!s.partner) {
          if (s.incomingInvite || (s.candidate?.canInvite && !s.outgoingInvite)) {
            await play.keyboard.press('Space');
            await play.advance(0.2);
          } else if (s.nearestActor && s.nearestActor.distance > 1.2) {
            // 没有可结盟对象时，先真实靠近最近的参赛者再按 Space 尝试结盟。
            const ndx = s.nearestActor.x - s.player.x;
            const ndy = s.nearestActor.y - s.player.y;
            const nkeys = [];
            if (Math.abs(ndx) > 0.5) nkeys.push(ndx > 0 ? 'KeyD' : 'KeyA');
            if (Math.abs(ndy) > 0.5) nkeys.push(ndy > 0 ? 'KeyS' : 'KeyW');
            for (const key of nkeys) await play.page.keyboard.down(key);
            try { await play.advance(0.4); }
            finally { for (const key of nkeys) await play.page.keyboard.up(key); }
          }
        }
        // 持续使用真实 WASD 绕安全区走位；advance 只推进时间，不写模拟状态。
        const radius = s.safeRadius * 11 * 0.72;
        const angle = 0.42 + s.elapsed * 0.35;
        // 走位（真实 WASD，只读状态，不改任何玩法数值）：
        // 后期死亡增伤会放大 AI 环绕飞刀的伤害，因此常态要主动远离最近参赛者：
        // 在当前安全圆上取「离所有参赛者最远」的角度，而不是被动等它贴近。
        let targetX = 11 + Math.cos(angle) * radius;
        let targetY = 11 + Math.sin(angle) * radius * 0.94;
        const raidLive = s.raid.phase === 'warning' || s.raid.phase === 'fight';
        if (raidLive) {
          // 团战时靠近战场中心（Boss 固定 11,11），让 Boss 轮廓与圆形预警真实入镜。
          targetX = 11;
          targetY = 14.2;
        } else if ((s.nearestRivals ?? []).length > 0) {
          let bestAngle = angle;
          let bestScore = -Infinity;
          for (let step = 0; step < 16; step++) {
            const a2 = (step / 16) * Math.PI * 2;
            const px = 11 + Math.cos(a2) * radius;
            const py = 11 + Math.sin(a2) * radius * 0.94;
            let nearest = Infinity;
            for (const o of s.nearestRivals) nearest = Math.min(nearest, Math.hypot(o.x - px, o.y - py));
            // 同时略微偏好继续沿原方向移动，避免原地来回抖动
            const score = Math.min(nearest, 6) + 0.9 * Math.cos(a2 - angle);
            if (score > bestScore) { bestScore = score; bestAngle = a2; }
          }
          targetX = 11 + Math.cos(bestAngle) * radius;
          targetY = 11 + Math.sin(bestAngle) * radius * 0.94;
        }
        const dx = targetX - s.player.x;
        const dy = targetY - s.player.y;
        const keys = [];
        if (Math.abs(dx) > 0.4) keys.push(dx > 0 ? 'KeyD' : 'KeyA');
        if (Math.abs(dy) > 0.4) keys.push(dy > 0 ? 'KeyS' : 'KeyW');
        for (const key of keys) await play.page.keyboard.down(key);
        try { await play.advance(1); }
        finally { for (const key of keys) await play.page.keyboard.up(key); }
      } else {
        const raidActive = s.raid.phase === 'warning' || s.raid.phase === 'fight';
        await play.advance(raidActive ? 0.5 : 3);
      }
    }
    throw new Error('Round did not reach a genuine ending');
  }

  async function nextRound(index) {
    await play.keyboard.press('Space');
    await play.waitFor(s => s.endless.phase === 'rule-pick', { read: 'island.match', timeoutMs: 5000 });
    if (index === 1) await play.screenshot(`round-${index}-seven-rules`);
    if (index === 1) {
      for (const [width, height] of [[1280, 600], [844, 390], [390, 844]]) {
        await play.page.setViewportSize({ width, height });
        await play.screenshot(`rules-layout-${width}x${height}`);
      }
      await play.page.setViewportSize({ width: 1280, height: 720 });
    }
    assert(await play.page.locator('[data-ui-part^="rule-card-"]').count() === 7, 'Expected seven named strategy cards');
    await play.page.locator(`[data-ui-part="rule-card-${index % 7}"]`).click();
    await play.page.locator('[data-ui-part="btn-confirm-rule"]').click();
    await play.waitFor(s => s.endless.phase === 'relic-pick', { read: 'island.match', timeoutMs: 5000 });
    const before = await read(play);
    const relic = before.endless.ownedRelics[0] ?? null;
    if (index === 1) await play.screenshot(`round-${index}-relic`);
    await play.keyboard.press('Space');
    await play.waitFor(s => !s.gameOver && s.endless.roundIndex === index + 1, { read: 'island.match', timeoutMs: 7000 });
    const after = await read(play);
    assert(after.endless.rulesCount === index * 10, 'Each round must add exactly ten votes');
    assert(after.endless.profiles.every(p => p.lossBurden === 0), 'Failure burden returned');
    if (relic) assert(after.player[`weapon${relic.kind[0].toUpperCase() + relic.kind.slice(1)}`] === relic.level, 'Relic level was not inherited');
    // 新局输入已就绪，先正常靠近最近角色，避免截图等待期间 AI 已彼此成队。
    if (!covered.betrayal) await nudge(play, 'KeyW');
    if (index <= 2) await play.screenshot(`round-${index + 1}-announcement`);
    if (!covered.betrayal) await play.step(`team-attempt-round-${index + 1}`, () => teamAndBetray());
    else await play.step(`team-attempt-round-${index + 1}`, () => teamUp());
  }

  for (let index = 1; index <= 9; index++) {
    await play.step(`round-${index}-combat-and-result`, () => finishRound());
    await play.step(`round-${index}-secret-votes-and-inheritance`, () => nextRound(index));
    if (index >= 2 && bossSeen.has(1) && bossSeen.has(2) && covered.upgrade && covered.betrayal && covered.telegraph) break;
  }

  await play.step('actual-upgrade-coverage', async () => {
    for (let guard = 0; guard < 25 && !covered.upgrade; guard++) {
      const s = await observe();
      assert(!s.gameOver && s.player.alive, 'No actual upgrade was exercised before the player died');
      await toward(play, 11, 11, 1.3, 3);
      await play.advance(3);
    }
  });

  await play.step('save-reload-and-input', async () => {
    const before = await read(play);
    const persisted = await play.page.evaluate(() => JSON.parse(localStorage.getItem('island.endless.save.v1')));
    await play.reload();
    await play.waitFor(s => s.endless.roundIndex === before.endless.roundIndex, { read: 'island.match', timeoutMs: 20000 });
    const restored = await read(play);
    assert(restored.endless.rulesCount === before.endless.rulesCount, 'Reload discarded named strategy history');
    for (const profile of persisted.profiles) for (const [id, score] of Object.entries(profile.grudge.grudgeScoreByActor)) assert((restored.endless.profiles.find(p => p.actorId === profile.actorId).grudge.grudgeScoreByActor[id] ?? 0) >= score, 'Reload discarded persisted grudge memory');
    const moved = await nudge(play, 'KeyW');
    assert(Math.hypot(moved.player.x - restored.player.x, moved.player.y - restored.player.y) > 0.2, 'Input failed after reload');
    await play.screenshot('save-restored-and-moved');
  });

  // 覆盖缺口必须失败，不能以“提前结束/没遇见”冒充通过。
  covered.bosses = [...bossSeen]; covered.shrink = [...shrinkSeen];
  assert(covered.team && covered.betrayal, 'No actual mutual alliance and active betrayal were exercised across three rounds');
  assert(covered.upgrade, 'No actual upgrade was exercised');
  assert(bossSeen.has(1) && bossSeen.has(2), `Missing real Boss coverage: ${JSON.stringify(covered)}`);
  assert(covered.telegraph, 'No Boss AOE telegraph was observed');
  return { ...covered, simulatedTimeOnly: true, real15MinuteHumanPlay: 'unverified' };
}
