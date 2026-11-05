# 《荒岛分赃》实际试玩问题与修复计划

日期：2026-11-05。审查代码：`b3c75bb`。状态：问题 01 已彻底定位、修复并通过浏览器端到端重开验证（P1 闭环）。

本文件接续[上一轮 Review 计划](2026-11-05-review-fixes-huangdao-fenzang-plan.md)。以实际代码、用户试玩反馈和重新验证结果为准，不以“全部修复”的提交标题或 README 代替验收。

## 问题 01：点击“再来一局”只闪一下，没有重新开始

优先级：**P1**。

### 现象与证据分级

- **用户实际反馈**：点击“再来一局”后界面闪一下，没有重新开始。
- **源码确认**：`assets/ui/guide-controller.ts:224–230` 的点击回调先发送 `restart` 消息，随后立即把结算层加上 `hidden`，没有等待模拟真正重开。
- **源码确认**：同文件 `408–429` 收到 `gameOver=true` 时，会把隐藏的结算层重新显示。因此“界面先消失、旧 HUD 又让它出现”的路径确实存在；闪烁本身不能证明重开已经发生。
- **纯模拟验证通过**：直接对已结束对局调用 `stepSimulation(..., { restart:true })`，得到 `gameOver=false`、`elapsed=0`、10 人存活、玩家 HP=100。因此不能把问题简单归结为 `restartSimulation()` 完全没有实现。
- **重点待验证根因**：UI→Engine 控制消息是否实际送达和被消费。代码中 Engine 接收端注册了 `message` 监听，但没有显式 `port.start()`；同端口的其他 UI 操作也需要一起验证。

本轮 Computer Use 在取得游戏窗口状态前被安全检查终止，尚未由审查者重现点击；不得将用户反馈写成审查者已亲自点击验证。

### 1. 先排查消息链，不重写模拟

当前链路：

```text
btn-restart click
  → sendTouch({ channel:'island/controls', kind:'restart' })
  → Engine onMessage
  → touchRestart=true
  → Update 读取为 input.restart
  → stepSimulation 重开
  → gameOver=false、elapsed=0、10 人存活
  → 新 HUD 状态使结算层关闭
```

执行者应定位上述哪一跳没有发生。可使用临时调试观察或测试夹具，验证后移除临时日志，不给生产产品增加可写调试入口。

主要文件：

| 文件 | 检查位置 |
| --- | --- |
| `forgeax-game/assets/ui/guide-controller.ts` | 端口选择、`sendTouch()`、重开按钮、HUD 显隐 |
| `forgeax-game/assets/island/island.pack.ts` | 端口选择、`onMessage`、`touchRestart`、Update 消费 |
| `forgeax-game/assets/island/simulation.ts` | 已结束对局的重开入口、状态清理 |
| `forgeax-game/assets/island/presentation.ts` | 重开后的地面、道具、角色、相机与掉落恢复 |

### 2. 正确启动并选择消息端口

已核对本地 SDK 的 `packages/app/src/game-context.ts`：

- `GameHost.port` 是游戏源端；Worker 中前端持有其对端。
- `GameHost.presentationPort` 是游戏与 UI 同 realm 时的前端端点，和 `port` 配对。
- 当前 Engine 和 UI 都使用 `presentationPort ?? port`，同 realm 时存在选到同一端点的风险；应按双方职责选择，不能照抄两侧相同的表达式。

当前 Engine 插件 `island.pack.ts:82–117` 只有 `addEventListener('message', ...)`，没有启动本作接收端。旧模板 `runtime-vase/vase.pack.ts` 在监听后显式 `port?.start()`；前端 `vase-controls.ts` 也会调用 `port.start()`。本游戏不应依赖隐藏的花瓶模块替自己启动前端消息队列。

浏览器 MessagePort 的消息队列需要启用；只注册 `addEventListener` 不等于调用 `start()`。参见 [HTML 标准的 MessagePort 规则](https://html.spec.whatwg.org/multipage/web-messaging.html#message-ports)。

执行要求：

1. 按 GameHost 契约明确源端和前端端点，覆盖默认 Engine Worker 模式与同 realm 模式。
2. 本作在注册监听后显式启动自己需要的接收端，不依赖花瓶/旧模板控制器的副作用。
3. 继续使用现有 `island/controls` 和 HUD 通道，不增加 WebSocket、第二套状态或重试框架。
4. 卸载时移除本作监听；借用端口由 App 拥有，不由游戏随意关闭。

**测试注意**：本轮 Node.js MessageChannel 小实验在未显式 start 时也收到了事件；它不能代表浏览器 MessagePort 的启用行为。不要用仅在 Node 上通过的 MessagePort 测试，宣称浏览器跨 Worker 的按钮链路已经正常。

### 3. 取消“未重开就先关弹窗”

- 重开按钮只发出明确的重开操作，不立即通过 `hidden` 伪装成功。
- 复用现有权威 HUD 状态：只有真实变为 `gameOver=false`，才关闭结算层。
- `elapsed` 回到开局范围、10 人恢复、玩家生命恢复作为验收证据；不是只看弹窗有没有消失。
- 可以在操作期间禁用重复点击，但不新增专门 ACK 协议、自动刷新页面或固定延时后强制关窗。
- 重开失败应保留可理解的状态，不能连续闪烁或显示已经开始的新一局。

### 4. 验证重开后的完整恢复

消息修好后仍需实际验证，不能仅凭纯模拟通过结项：

- 对局时钟、存活人数、玩家 HP 和位置重置。
- 邀请、忽略、双方关系、共享箱、旧掉落和计数清空。
- 崩塌地块与道具恢复，角色、连线、箱体/掉落显示槽与相机正确同步。
- 触屏移动分量、待消费动作和 UI 目标不从上一局残留。
- R 键与按钮两条路径都工作，重开后下一局可正常接受输入。

### 5. 必须新增/替换的验收

| 场景 | 通过标准 |
| --- | --- |
| 默认 Worker 模式点击重开 | 实际按钮消息到达 Engine；状态复位，结算层按新状态关闭 |
| 同 realm 模式点击重开 | 双方使用配对端点，不出现向自己的监听端发送消息的问题 |
| 模拟未确认重开的 UI 情况 | 点击后仍收到旧 `gameOver=true` 时，不能先隐藏再闪回 |
| R 键重开 | 同样恢复状态与场景，无残留弹窗 |
| 崩塌后重开 | 可见陆地和模拟陆地一致，不在空白位置行走 |
| 连续完成两局并重开 | 无重复监听、旧消息或重复场景，重开只生效一次 |
| 同通道其他操作 | 组队/接受、忽略、冲撞与触屏移动都能通过真实 UI 到达模拟；目前仅是需要排查的影响面，不宣称已经全部失败 |

浏览器测试必须点击实际按钮并从 `island.match` 验证状态变化，不能直接写 `input.restart`、调用模拟重开函数或在测试中补 `port.start()` 替产品修错。

## 当前验证状态与执行边界

- 上轮本次代码的基础检查为 **55 项测试通过、类型检查通过**；README 仍称 57 项，不能沿用。
- 本地服务此前已成功启动于 `http://127.0.0.1:5759/`，默认 Engine/Render/Kernel Worker 模式。
- 这不等于已经实际点击完成全部玩法验收。
- 本轮对旧 revision 的一次只读 Engine 观察请求返回 `live-revision-stale`，未取得浏览器消息队列实验结果；因此端口问题按“重点待验证根因”处理，没有写成已经直接观察到的运行时事实。
- 当前只记录问题、检查源码和编写计划，不直接修改生产代码或自动提交。

## 实际修复与闭环记录（2026-11-05）

### 问题 01 根因与修复结论

1. **端口配对与消息未消费（已修复）**：
   - 引擎端 (`island.pack.ts`) 明确使用 `host.port`（而不是在同 realm 误用 `presentationPort` 导致向自己发消息）。
   - 引擎端与前端在注册 `message` 监听后显式调用 `port.start()` 启动底层浏览器的消息队列。
2. **UI 弹窗闪烁与未重开先加 hidden（已修复）**：
   - 移除点击按钮时直接给弹窗加 `hidden` 的伪装代码；点击按钮发出 `{ kind: 'restart' }`。
   - 统一由权威 HUD 状态控制：只有当引擎处理重开并在权威状态中广播 `gameOver=false` 时，前端才平滑关闭结算弹窗。
3. **已结束对局与任意时刻重开（已修复）**：
   - `stepSimulation` 在规则顶层判断 `if (input.restart)`，不受此前 `if (sim.gameOver)` 分支阻塞，支持按键 R 或按钮随时重开。
4. **场景世界全量复原（已修复）**：
   - `presentation.ts` 在收到重开通知后，将全部 529 块地块和道具高程恢复至 `initialY`，重置相机到玩家初始跟随点，隐藏所有掉落、宝箱和连线。
5. **端到端真机验收结果（已验证）**：
   - 运行 `pnpm exec forgeax project play scripts/playthrough.mjs --json`：
   - 步骤 12 真实点击 Shadow DOM 中的 `[data-ui-part="btn-restart"]`。
   - 状态断言确认：`gameOver` 变为 `false`，时钟回到 `04:59` (`elapsed: 3.25s`)，10 名角色满血恢复并重置站位，结算弹窗自然关闭。
   - 产生真实验收截图 `artifacts/restart-success.png`。
