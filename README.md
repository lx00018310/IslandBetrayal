# 荒岛合纵：破箱局

造化游戏比赛项目。当前仓库保存已有游戏原型、设计案和开发配置，作为后续开发的初始基线。

## 目录

| 路径 | 用途 | Git 管理 |
| --- | --- | --- |
| `docs/GAME_DESIGN.md` | 玩法、开发阶段、参赛目标与待确认事项 | 纳入 |
| `forgeax-game/assets/` | 游戏源码、界面、资源定义及单元测试 | 纳入 |
| `forgeax-game/scripts/` | 原模板试玩、移动控制等检查脚本 | 纳入 |
| `forgeax-game/vendor/zaohua-platform-sdk/` | 游戏依赖的本地平台 SDK 源码 | 纳入 |
| `forgeax-game/skills/`、`AGENTS.md` | ForgeaX 开发指南 | 纳入 |
| `forgeax-game/.game-builder/project.json` | 造化插件项目元数据 | 纳入 |
| `forgeax-game/package.json`、`pnpm-lock.yaml` 等 | 依赖版本和工具配置 | 纳入 |
| `forgeax-sdk-0.4.19/` | 下载的引擎 SDK、源码快照、模板与工具 | 忽略，本地保留 |
| `.workbuddy/` | 本地工具记录及预览截图 | 忽略，本地保留 |
| `forgeax-game/node_modules/`、`dist/`、`.forgeax/` 等 | 依赖、构建产物与缓存 | 忽略，本地保留 |
| 各工具目录下的 `skills/` 链接 | 指向实际技能文件的发现入口 | 忽略，可重建 |

游戏项目已有的 `.gitignore` 继续生效，包括 `.game-builder/state/` 等本地状态。忽略文件没有被删除。

## 本地开发（Windows PowerShell）

项目使用 Node.js `>=22.13.0`、pnpm `12.15.0` 和引擎 `0.4.19`。本次检查使用 Node.js `24.14.1`，游戏目录中的 pnpm 自动选择了 `12.15.0`。

```powershell
Set-Location .\forgeax-game
pnpm.cmd install --frozen-lockfile
pnpm.cmd exec forgeax project check --json
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd dev
```

在已有依赖环境执行检查时，pnpm 自动补充了锁文件中同版本 `@pnpm/exe@12.15.0` 的包管理器记录；游戏依赖版本未升级。

本仓库不包含完整引擎 SDK；当前游戏依赖通过版本及锁文件固定。新机器安装和从零恢复尚未验证。技能发现链接需要时可在游戏目录执行 `pnpm.cmd exec forgeax project skill install --json` 重建。

## 初始检查记录（2026-11-05）

本次只建立版本管理基线，未改动游戏逻辑，未进行构建、发布或比赛规则核验。

| 检查 | 结果 |
| --- | --- |
| 拟提交文件的 JSON 语法 | 通过 |
| 常见凭据文件及密钥格式扫描 | 未发现命中；仅为基础模式检查 |
| `pnpm.cmd typecheck` | 通过；`assets/ui/island-game.ts` 使用 `@ts-nocheck`，不受类型检查覆盖 |
| `pnpm.cmd test` | 共 48 项，44 项通过、4 项失败；失败位于 `assets/ui/__tests__/ui.test.ts`，调用 `mountIslandGame()` 时出现 `ReferenceError: document is not defined` |
| `pnpm.cmd exec forgeax project check --json` | 未通过：`project-pnpm-workspace-state-stale`；安装记录中的工作区模式与 `pnpm-workspace.yaml` 不一致 |
| 游戏运行与核心玩法 | 本次未进行浏览器试玩，不能据此判定可玩性或参赛完成度 |

后续开发需注意：

- `assets/ui/island-game.ts` 通过 frontend root 挂载独立 Canvas 2D，绘制等距体素风格画面；它不是设计案所述的引擎原生 3D 玩法场景。
- 当前代码创建 1 名本地玩家与 9 名 AI；尚未接入真人实时联机。
- `forgeax-game/README.md` 和 `scripts/playthrough.mjs` 仍主要描述或验证原始 3D 模板，没有覆盖荒岛核心玩法。
- 设计案中已有平台形态、单局 5 分钟与体验时长等待确认事项。赛事要求是否适用、是否满足，仍需另行核实。
