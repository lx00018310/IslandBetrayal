# 荒岛分赃

造化首届体素游戏创作大赛参赛项目。当前仓库包含核心玩法模拟、天工引擎原生 2.5D 正交体素场景呈现、多端 HUD 界面与全量自动化验收脚本。

> 注：原企划名《荒岛合纵：破箱局》，已正式更名为《荒岛分赃》。

## 目录

| 路径 | 用途 | Git 管理 |
| --- | --- | --- |
| `docs/GAME_DESIGN.md` | 游戏设计案与核心规则细节 | 纳入 |
| `docs/plans/` | 视觉改造计划、玩法修改计划与 Review 修复计划 | 纳入 |
| `docs/references/` | 视觉风格参考图与基线对比图 | 纳入 |
| `forgeax-game/assets/` | 游戏源码、界面、资源定义及单元测试 | 纳入 |
| `forgeax-game/scripts/` | 端到端玩法试玩与验收脚本 | 纳入 |
| `forgeax-game/vendor/zaohua-platform-sdk/` | 游戏依赖的本地平台 SDK 源码 | 纳入 |
| `forgeax-game/skills/`、`AGENTS.md` | ForgeaX 开发指南 | 纳入 |
| `forgeax-game/.game-builder/project.json` | 造化插件项目元数据 | 纳入 |
| `forgeax-game/package.json`、`pnpm-lock.yaml` 等 | 依赖版本和工具配置 | 纳入 |
| `forgeax-sdk-0.4.19/` | 下载的引擎 SDK、源码快照、模板与工具 | 忽略，本地保留 |
| `forgeax-game/node_modules/`、`dist/`、`.forgeax/` 等 | 依赖、构建产物与缓存 | 忽略，本地保留 |

## 本地开发与验收（Windows PowerShell）

项目使用 Node.js `>=22.13.0`、pnpm `12.15.0` 和引擎 `0.4.19`。

```powershell
Set-Location .\forgeax-game
pnpm.cmd install --frozen-lockfile
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd exec forgeax project check --json
pnpm.cmd exec forgeax project play scripts/playthrough.mjs --json
```

## Review 修复与更名记录（2026-11-05）

依据 `docs/plans/2026-11-05-review-fixes-huangdao-fenzang-plan.md`，完成 R01 至 R12 全部 12 项缺陷修复与统一更名：

| 修复项 | 状态 | 说明 |
| --- | --- | --- |
| **R01** 外部致命破箱财物释放 | 已修复 | 修复 `destroyChest` 检查条件，确保外部致命伤害完整释放全部财物、增加爆箱计数并不解除队伍关系 |
| **R02** 结局后玩法与结算冻结 | 已修复 | `gameOver` 后彻底冻结模拟移动与战斗，记录真实淘汰名次与胜者身份，胜负判定精准对应 `winnerId` |
| **R03** 重开场景与 UI 完整恢复 | 已修复 | 场景呈现层记录地块与道具初始高度，重开时完整复原塌陷地面；R 键重开同步隐藏结算弹窗并清空输入缓存 |
| **R04** 忽略计时与候选选择修复 | 已修复 | 忽略期内重复操作不延长 60 秒时长；附近选择过滤已屏蔽角色，优先选出有效候选人 |
| **R05** AI 合作约束与坠落优先级 | 已修复 | 正常结盟 AI 追物受合作距离保护；移动物理后优先执行边缘坠落淘汰，再执行幸存队伍超距检测 |
| **R06** 掉落物显示容量扩容 | 已修复 | 实体池扩容至 72 个，支持大爆箱全量可见，超出部分按距玩家最近优先呈现 |
| **R07** 真实端到端验收与无吞错 | 已修复 | 移除了试玩脚本中掩盖超时的 catch，通过正常移动、非空爆箱、争抢与缩圈获得真实状态断言与完整截图 |
| **R08** 单一邀请约束与目标绑定 | 已修复 | 角色同时只能参与一条有效邀请，忙碌不被覆盖；反向邀请直接原子成队；操作绑定具体 ID |
| **R09** 财物与合作攻击收益成立 | 已修复 | 个人宝物提供至多 +10 伤害，结盟提供 +3 伤害，共享箱财富提供至多 +5 伤害，解散/破箱后正确撤销 |
| **R10** 队伍列表与结算信息同步 | 已修复 | HUD 动态渲染场上队伍与宝箱；展示自己队伍箱内财物与耐久；触屏操作补充丢失捕获清零；适配各视口 |
| **R11** 体素行走动画与受击红闪 | 已修复 | 角色移动时呈现步伐起伏微动画；受击时材质短暂红闪；怪物保持呼吸浮动 |
| **R12** 统一更名为《荒岛分赃》 | 已修复 | 全工程配置文件、UI 标题、HUD 状态、说明文档统一更名为《荒岛分赃》，清理旧踢箱矛盾表述 |
| **问题01** 点击“再来一局”真实重开 | 已修复 | 修正 GameHost 消息端口绑定并显式调用 `port.start()`，重开受权威引擎状态驱动并复原塌陷地形，消除 UI 闪烁 |

### 质量与验证结果

| 检查项 | 状态 | 验证结果 |
| --- | --- | --- |
| `pnpm.cmd exec forgeax project check --json` | 通过 | `ok: true`，项目依赖配置合规 |
| `pnpm.cmd test` | 通过 | 11 个测试套件，**56 项单元测试 100% 全部通过** |
| `pnpm.cmd typecheck` | 通过 | 全工程无 TypeScript 编译错误 |
| `pnpm.cmd exec forgeax project play scripts/playthrough.mjs --json` | 通过 | 14 个测试步骤端到端全部通过（含点击【再来一局】重开对局），实测帧率稳定在 118~120 FPS，生成全套状态截图 |

