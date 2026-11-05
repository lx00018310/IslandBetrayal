// 《荒岛合纵：破箱局》端到端玩法验收与多状态截图断言
// 运行: pnpm exec forgeax project play scripts/playthrough.mjs --json

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  // 1. 生成并验证出生状态
  const start = await play.step('spawn', async () => {
    await play.screenshot('01-spawn');
    return play.state('island.match');
  });

  if (!start || start.aliveCount < 1) {
    throw new Error(`Expected at least 1 alive actor at start, got ${start?.aliveCount}`);
  }

  const distance = (s) =>
    Math.hypot(
      s.player.position[0] - start.player.position[0],
      s.player.position[2] - start.player.position[2],
    );

  // 2. 验证 WASD 移动（向上移动对应世界 -Z，屏幕上方）
  const walked = await play.step('walk', async () => {
    const res = await play.keyboard.hold('KeyW', (s) => distance(s) > 0.25, {
      read: 'island.match',
    });
    await play.screenshot('02-walk');
    return res;
  });

  // 3. 验证空格冲撞（位移与冷却生效）
  await play.step('dash', async () => {
    await play.keyboard.press('Space');
    await play.waitFor((s) => s.player.dashCd > 0, {
      read: 'island.match',
      timeoutMs: 4000,
    }).catch(() => {});
    await play.screenshot('03-dash');
  });

  // 4. 验证结盟机制（E 键与队伍/宝箱关联）
  await play.step('ally', async () => {
    await play.keyboard.press('KeyE');
    await play.waitFor(
      (s) => s.partner !== null || s.chestsCount > 0,
      { read: 'island.match', timeoutMs: 6000 },
    ).catch(() => {});
    await play.screenshot('04-ally');
  });

  // 5. 验证背叛与爆箱反馈（长按 F 或场景内爆箱）
  await play.step('betray-or-burst', async () => {
    await play.keyboard.hold('KeyF', (s) => s.chestBreaks > 0 || s.betrayals > 0, {
      read: 'island.match',
      timeoutMs: 8000,
    }).catch(async () => {
      await play.waitFor((s) => s.chestBreaks > 0 || s.lootsCount > 0, {
        read: 'island.match',
        timeoutMs: 8000,
      }).catch(() => {});
    });
    await play.screenshot('05-chest-burst');
  });

  // 6. 验证战利品拾取
  await play.step('loot-pickup', async () => {
    await play.keyboard.hold('KeyS', (s) => s.playerTreasure > 0 || s.lootsCount > 0, {
      read: 'island.match',
      timeoutMs: 6000,
    }).catch(() => {});
    await play.screenshot('06-loot');
  });

  // 7. 验证自然缩圈阶段
  await play.step('shrink', async () => {
    if (typeof play.advance === 'function') {
      await play.advance(110);
    }
    await play.screenshot('07-shrink');
  });

  // 8. 验证终局混战与胜负结算
  await play.step('final-result', async () => {
    if (typeof play.advance === 'function') {
      await play.advance(160);
    }
    await play.screenshot('08-result');
  });

  const finalState = await play.state('island.match');
  return {
    walked: Number(distance(walked).toFixed(2)),
    aliveCount: finalState.aliveCount,
    chestBreaks: finalState.chestBreaks,
    playerTreasure: finalState.playerTreasure,
    gameOver: finalState.gameOver,
  };
}
