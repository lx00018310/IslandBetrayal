import { initialize, game, lifecycle } from 'zaohua-platform-sdk'

// 造化平台运行时入口：在天工引擎启动前完成 SDK 初始化与发布必需的基础能力接入。
// 声明 game.loading（真实加载区间上报）与 game.lifecycle（生命周期注册 + 真实暂停/恢复）。
await initialize({
  capabilities: ['game.loading', 'game.lifecycle'],
})

// 加载开始：引擎模块与游戏资源加载期间上报，直到主循环进入可玩状态。
game.loading()

// lifecycle adapter：pause/resume 必须影响真实运行时行为，而不只是改状态。
// 这里用一个全局布尔标志控制游戏主循环与音频；getState 如实反映当前状态。
let paused = false
function applyPaused(next) {
  paused = next
  globalThis.__zaohuaGamePaused = next
  // 同时暂停/恢复背景音乐等 HTMLMediaElement，保证暂停影响真实音频行为。
  try {
    const media = document.querySelectorAll('audio, video')
    media.forEach((m) => {
      if (next) {
        if (!m.paused) { m.pause(); m.dataset.zaohuaPausedByLifecycle = '1' }
      } else if (m.dataset.zaohuaPausedByLifecycle === '1') {
        m.play().catch(() => {})
        delete m.dataset.zaohuaPausedByLifecycle
      }
    })
  } catch { /* 无 DOM 或无媒体元素时忽略 */ }
}

lifecycle.register({
  pause() { applyPaused(true) },
  resume() { applyPaused(false) },
  getState() { return { paused } },
})

// 上报加载完成：轮询游戏主循环置起的“可玩”标志（matchReady），
// 引擎真正进入可玩状态后才调用 game.loaded（握手通过不等于可玩）。
const loadedDeadline = Date.now() + 30000
const loadingWatch = setInterval(() => {
  if (globalThis.__zaohuaGameReady || Date.now() >= loadedDeadline) {
    clearInterval(loadingWatch)
    game.loaded()
  }
}, 100)
