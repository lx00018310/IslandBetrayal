// 最终显示改动的针对性回归：正常输入、重载、四视口渲染与布局检查。
export default async function layoutPlaythrough(play) {
  for (const [width, height] of [[1280, 720], [1280, 600], [844, 390], [390, 844]]) {
    await play.page.setViewportSize({ width, height });
    await play.screenshot(`layout-${width}x${height}`);
  }
  await play.page.setViewportSize({ width: 1280, height: 720 });
  for (const name of ['move', 'reload-and-move']) {
    if (name === 'reload-and-move') await play.reload();
    await play.step(name, async () => {
      const before = await play.state('island.match');
      if (!before.player.alive) throw new Error('Player is not alive for input verification');
      const after = await play.keyboard.hold('KeyW', s => s.pendingUpgrade || s.gameOver || s.elapsed >= before.elapsed + 0.3,
        { read: 'island.match', timeoutMs: 4000 });
      if (Math.hypot(after.player.x - before.player.x, after.player.y - before.player.y) < 0.2) throw new Error('Movement failed');
      await play.screenshot(name);
    });
  }
  return { movementAndReload: true, viewports: 4 };
}
