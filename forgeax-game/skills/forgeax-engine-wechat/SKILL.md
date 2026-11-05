---
name: forgeax-engine-wechat
description: >-
  ForgeaX WeChat Mini Game development and diagnosis. Use when building or running
  an ordinary game with official AI DevTools, validating simulator/phone behavior,
  or investigating native UI, rendering, performance and memory.
---

# forgeax-engine-wechat

Use Tencent's installed `wechatide-skill` for the exact official CLI contract.
This skill supplies Engine integration, reusable tools and field-tested diagnosis.
Start with the relevant row; the historical observations in Sources are scoped
results, not a requirement to repeat every past experiment.

## Choose the next action

| Task | Read |
| --- | --- |
| New session or an unfamiliar symptom | [Field guide](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/field-guide.md) |
| Install/find official tools; connect a remote machine | [Setup](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/setup.md) |
| Login QR, client authorization, pending tasks and tool-result handling | [Tooling](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/tooling.md) |
| Build, compress, validate and transfer the ordinary publication | [Build](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/build.md) |
| Own one simulator, find the actual game realm, inspect UI and drive controls | [Simulator](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/simulator.md) |
| Discover a phone, use official preview, capture original failures and edit forms | [Android device](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/android-device.md) |
| Startup stalls, missing native error fields, package reads or plugin waits | [Structured startup workflow](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/android-device.md#retrieve-structured-startup-errors) |
| Prepare independent native contacts on Android | [Multi-touch](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/android-multitouch.md) |
| WASM growth, native completion or resources not retiring | [Memory diagnosis](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/memory-diagnosis.md) |
| Slow frames, host contention, UI/scene CPU and GPU attribution | [Performance](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/performance.md) |
| Reusable Engine optimization techniques or offline CPU/GPU and A/B analysis | [Engine performance](../forgeax-engine-performance/SKILL.md) |
| Repeatable walk/run/jump and camera rotation with completed-frame timing | [Gameplay benchmark](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/gameplay-performance.md) |
| HTML/CSS layout, glyphs, controls and GPU UI parity | [Blitz](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/blitz.md) |
| Joystick, run, jump, camera and input cancellation | [Mobile game](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/mobile-game.md) |
| Clipped/missing pixels or an unexplained backend difference | [Canvas positive control](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/canvas-readback.md), then [RHI capture](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/rhi-capture.md) and [shader sources](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/shader-sources.md) |
| Native clock/display, missing globals, resource startup or Host lifecycle | [Engine integration](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/engine-integration.md) |
| Local execution, classic Worker or V2 admission and integration | [Worker execution](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/worker-execution.md) |
| Native sockets, audio, remote resources or disk cache | [Native services](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/native-services.md) |
| Select a reusable script or its regression suite | [Toolbox](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/toolbox.md) |
| Decide what a result proves and publish evidence | [Verification](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/verification.md) |
| Check official authorities or dated qualification | [Sources](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-wechat/references/sources.md) |

## Keep the actual game authoritative

Confirm `compileType: "game"`, the project path on the DevTools machine, AppID
and intended target. Reuse supplied values. Read the installed official skill
version, check its status, and resolve actual login/client setup through its UI.
For a QR that needs the user, show the real image and send an explicit input
notification; a progress image alone can be missed.

Build through the owning Engine/DevKit producer. Preserve the complete matched
WASM/glue/provenance and artifact inventory. A successful import, preview upload,
fixture or standalone GL fence cannot substitute for the ordinary
App/World/Catalog path and completed Renderer scene frames.

Choose the cheapest environment that reproduces the failure. A Mac browser
using hardware WebGL can accelerate owner fixes; an official simulator checks
its native Host, and a phone checks its own runtime/driver. A phone-only failure
needs direct phone evidence without an unchanged simulator detour. Record the
actual target and backend on every result. Honor the user's current priority.

Default iteration is an owner regression, then the complete ordinary game in the
official simulator, then the phone. Shared CPU work, Bundle validation and startup
logic should be reproduced locally before another long phone cycle. Once that
simulator path is healthy, use the phone for native download/network, device GPU,
touch, lifecycle and final FPS evidence; simulator throughput cannot qualify a
phone's budget. If a failure is already proven phone-only, retain that simulator
control and diagnose the failing target directly.

Rendering failures without a named startup/asset cause follow
[forgeax-engine-rhi-debug](../forgeax-engine-rhi-debug/SKILL.md): capture the
failing frame and inspect its work/resources before speculative shader changes.
For performance, first establish host headroom and a repeatable workload;
separate correctness capture, intrusive profiling and uninstrumented acceptance.

Keep one owned simulator active and close it when unused. Preserve other sessions'
projects and phone activity. Observe foreground before native input and stop when
the target changes. Match input coordinates to a reviewed current screenshot.

Turn reproduced owner failures into narrow regressions; reuse unchanged builds
and assets. Keep commands, source identity, actual interactions, completed frames,
original failures and reviewed screenshots together. Publish only sanitized
results with accessible image links. Account state, AppIDs, device identities,
QR images and raw logs remain outside tracked sources.

Extend the owning diagnostic entrypoint when evidence is missing. Keep collection,
bounded transport, cleanup, tests and interpretation together in this directory;
graduate a successful temporary probe into that path before relying on it again.
Do not make routine investigations depend on generated-chunk edits or private
globals. Keep unavailable capabilities and incomplete reports visible.
