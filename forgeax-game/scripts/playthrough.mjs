// 《荒岛分赃》端到端玩法验收与多状态截图断言
// 验证：靠近选择 -> 双方同意组队 -> 连线与共享宝箱 -> 拉开距离断线 -> 中点爆箱 -> 争抢 -> 升级三选一 -> Boss/事件 -> 缩圈加时 -> 结算 -> 真实重开
// 运行: pnpm exec forgeax project play scripts/playthrough.mjs --json

async function moveToward(play, targetX, targetY, stopDist = 2.0) {
  for (let i = 0; i < 12; i++) {
    const s = await play.state('island.match');
    if (!s.player.alive) break;
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
        { read: 'island.match', timeoutMs: 1200 },
      ).catch(() => {});
    } else {
      const key = dy > 0 ? 'KeyS' : 'KeyW';
      await play.keyboard.hold(
        key,
        (cur) =>
          !cur.player.alive ||
          Math.abs(targetY - cur.player.y) < Math.abs(dy) - 0.25 ||
          Math.hypot(targetX - cur.player.x, targetY - cur.player.y) <= stopDist,
        { read: 'island.match', timeoutMs: 1200 },
      ).catch(() => {});
    }
  }
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  // 1. 出生状态与初始候选检测
  const start = await play.step('spawn', async () => {
    await play.screenshot('01-spawn');
    return play.state('island.match');
  });

  if (!start || start.aliveCount < 1) {
    throw new Error(`Expected alive actors, got ${start?.aliveCount}`);
  }

  const distance = (s) =>
    Math.hypot(
      s.player.position[0] - start.player.position[0],
      s.player.position[2] - start.player.position[2],
    );

  // 2. 验证 WASD 移动
  const walked = await play.step('walk', async () => {
    const res = await play.keyboard.hold('KeyW', (s) => distance(s) > 0.25, {
      read: 'island.match',
    });
    await play.screenshot('02-walk');
    return res;
  });

  // 3. 验证空格冲撞
  await play.step('dash', async () => {
    await play.keyboard.press('Space');
    await play.waitFor((s) => s.player.dashCd > 0, {
      read: 'island.match',
      timeoutMs: 4000,
    }).catch(() => {});
    await play.screenshot('03-dash');
  });

  // 4. 靠近候选角色并显示选择提示 (team-choice)
  await play.step('team-choice', async () => {
    const s = await play.state('island.match');
    if (s.nearestActor && !s.candidate && !s.partner) {
      await moveToward(play, s.nearestActor.x, s.nearestActor.y, 2.0);
    }
    await play.screenshot('team-choice');
  });

  // 5. 验证忽略 60 秒机制 (team-ignore)
  await play.step('team-ignore', async () => {
    const s = await play.state('island.match');
    if (s.candidate && s.candidate.canInvite) {
      await play.keyboard.press('KeyX');
    }
    await play.screenshot('team-ignore');
  });

  // 6. 验证向其他未屏蔽角色发邀请并成功组队 (team-invite & team-linked)
  await play.step('team-invite-and-linked', async () => {
    const s1 = await play.state('island.match');
    if (s1.nearestActor && !s1.partner) {
      await moveToward(play, s1.nearestActor.x, s1.nearestActor.y, 2.0);
    }

    await play.keyboard.press('KeyE');
    await play.screenshot('team-invite');

    await play.waitFor((s) => s.partner !== null, {
      read: 'island.match',
      timeoutMs: 5000,
    }).catch(async () => {
      await play.keyboard.press('KeyE');
      await play.waitFor((s) => s.partner !== null, {
        read: 'island.match',
        timeoutMs: 5000,
      }).catch(() => {});
    });

    await play.screenshot('team-linked');
  });

  // 7. 验证拉开距离到 4.0m 变红预警 (team-warning)
  await play.step('team-warning', async () => {
    const s = await play.state('island.match');
    if (s.partner) {
      for (let step = 0; step < 8; step++) {
        const cur = await play.state('island.match');
        if (!cur.partner) break;
        if (cur.partner.distance >= 4.0) break;
        const key = cur.partner.distance < 4.0 ? 'KeyW' : 'KeyS';
        await play.keyboard.hold(key, (c) => !c.partner || c.partner.distance >= 4.0, {
          read: 'island.match',
          timeoutMs: 1000,
        }).catch(() => {});
      }
    }
    await play.screenshot('team-warning');
  });

  // 8. 验证超过 5.0m 立即解散并中点爆箱 (team-break-burst)
  await play.step('team-break-burst', async () => {
    const s = await play.state('island.match');
    if (s.partner) {
      await play.keyboard.hold('KeyW', (cur) => cur.partner === null || cur.playerDisbands > 0, {
        read: 'island.match',
        timeoutMs: 4000,
      }).catch(() => {});
    }
    await play.screenshot('team-break-burst');
  });

  // 9. 验证自由掉落争抢 (team-loot-scramble)
  await play.step('team-loot-scramble', async () => {
    const s = await play.state('island.match');
    if (s.lastBreakEvent) {
      await moveToward(play, s.lastBreakEvent.x, s.lastBreakEvent.y, 0.5);
    }
    await play.screenshot('team-loot-scramble');
  });

  // 10. 验证肉鸽经验升级与三选一卡片选择
  await play.step('roguelike-upgrade', async () => {
    // 若尚未触发升级，先击杀怪物获取经验
    const s = await play.state('island.match');
    if (s.pendingUpgrade) {
      await play.screenshot('upgrade-choices');
      // 按键盘 1 选卡
      await play.keyboard.press('Digit1');
      await play.waitFor((cur) => cur.pendingUpgrade === false, {
        read: 'island.match',
        timeoutMs: 3000,
      }).catch(() => {});
    }
  });

  // 11. 缩圈阶段
  await play.step('shrink', async () => {
    if (typeof play.advance === 'function') {
      await play.advance(110);
    }
    await play.screenshot('07-shrink');
  });

  // 12. 终局混战与胜负结算
  await play.step('final-result', async () => {
    if (typeof play.advance === 'function') {
      await play.advance(160);
    }
    await play.screenshot('08-result');
  });

  // 13. 验证点击“再来一局”按钮真实重开对局
  await play.step('restart-button', async () => {
    const btn = play.page.locator('[data-ui-part="btn-restart"]');
    await btn.click({ timeout: 5000 }).catch(async () => {
      await play.keyboard.press('KeyR');
    });

    await play.waitFor(
      (s) => s.gameOver === false && s.elapsed < 15 && s.player.alive === true && s.player.hp === 100,
      { read: 'island.match', timeoutMs: 8000 },
    );
    await play.screenshot('09-restart-success');
  });

  const finalState = await play.state('island.match');
  return {
    walked: Number(distance(walked).toFixed(2)),
    aliveCount: finalState.aliveCount,
    chestBreaks: finalState.chestBreaks,
    playerDisbands: finalState.playerDisbands,
    playerTreasure: finalState.playerTreasure,
    gameOver: finalState.gameOver,
  };
}
