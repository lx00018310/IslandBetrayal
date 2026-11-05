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

## 视觉改造与原生呈现记录（2026-11-05）

依据 `docs/plans/2026-11-05-tibo-style-visual-plan.md`，已将原有独立 Canvas 2D 挂载原型完整重构为天工引擎原生 2.5D 场景与 Plugin 驱动架构：

| 模块 | 职责与交付状态 |
| --- | --- |
| `assets/island/simulation.ts` | 纯 TypeScript 提取的荒岛玩法规则（双向邀请确认成队、忽略 60 秒屏蔽、4.0m 连线预警、超 5.0m 断线爆箱、外部掠夺打爆箱体保留队伍、物理哄抢、冲撞击退、边缘缩圈与胜负结算），无 DOM/Canvas 依赖，单元测试覆盖 |
| `assets/island/art.pack.ts` | 原生体素草地、平整薄层地面、10 色体素角色、虚空水面、怪物、宝箱、发光连线束（正常绿与预警红）、48 个战利品池与脚底投影网格/材质包 |
| `assets/island/presentation.ts` | 原生正交相机跟随（55° 俯角近景跟随主角）、脚底接触影、地块下沉崩塌、队伍实时连线与预警变色、前后深度遮挡与体素朝向同步 |
| `assets/island/island.pack.ts` | 原生 Cordis 插件，驱动 ECS Update 循环与模拟推进，注册 `island.match` 验收只读投影（含候选人、邀请、忽略与断线事件），跨领域同步 HUD 状态 |
| `assets/guide.ui.html` / `guide.ui.css` / `ui/guide-controller.ts` | 符合天工引擎 UiAuthoringProfile 的原生 HUD 界面（计时器、阶段、存活/宝物、队伍列表、候选人选择与邀请横幅、超距警报、虚拟摇杆与组队/忽略/冲撞按键、结算卡片） |
| `assets/ui/island-game.ts` | 已安全退役并移除独立可见 Canvas 画布与 `@ts-nocheck` |
| `scripts/playthrough.mjs` | 更新为全流程核心玩法端到端验收（含出生、移动、冲撞、靠近选择、忽略、邀请结盟、距离预警、超距爆箱、战利品争抢、缩圈、结算等阶段截图断言） |

### 质量与验证结果

| 检查项 | 状态 | 验证结果 |
| --- | --- | --- |
| `pnpm.cmd exec forgeax project check --json` | 通过 | 补充 `pnpm-workspace.yaml` packages 声明，消除 `project-pnpm-workspace-state-stale` |
| `pnpm.cmd test` | 通过 | 11 个测试套件，**57 项单元测试 100% 全部通过** |
| `pnpm.cmd typecheck` | 通过 | 全工程无 TypeScript 编译错误 |
| `pnpm.cmd exec forgeax project play scripts/playthrough.mjs --json` | 通过 | 13 个测试步骤端到端全部通过，实测帧率稳定在 115~120 FPS，生成全套状态截图 |

