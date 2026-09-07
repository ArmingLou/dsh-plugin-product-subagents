## 0.5.6（2026-09-07）
- 重构：isPermissionPending 泛化为 isHumanWaitPending——豁免判定覆盖任何人类决策等待（授权 pendingDecisions + 预留问答 pendingQuestions 注册表，后者当前无写入方、结构就位）；acp.js 兼容旧键名。设计约束（记档）：ACP 会话任何等待人类决策的期间，看门狗不触发 kill/超时、10 分钟空闲回收自动推迟——问答功能落地时只需把问答挂起注册进 pendingQuestions 即自动获得豁免。

## 0.5.5（2026-09-07）
- 权限等待豁免：ACP 权限请求正等待人类决策期间（pendingDecisions 命中），看门狗不触发无输出冻结/空闲超时（虚拟心跳），10 分钟空闲回收自动推迟——静默等待决策是正常状态而非冻结；决策落定后冻结窗口从该刻重算。新增 isPermissionPending 回调（index.js→providers→acp.js）与 scheduleDispose 推迟逻辑，附单测。

## 0.5.4（2026-09-07）
- submit-ok / submit-failed / permission-pending 事件载荷补 remoteSessionId（binding 的远程会话 id），供编排层透出尾号排查 binding 失配归属。

- 修复（独立复跑发现）：① prompt 传输中断（ACP connection closed/ECONNRESET 等）不再逃逸看门狗循环——按 kill→reconnect→无限重试处理（仅 isClosed/abort/SUBMIT_TIMEOUT 终止）；② reconnect 失败路径加 250ms 防空转延迟；③ connect() 增加 options.spawn 测试缝，watchdog 单测纯 mock 不依赖真实 CLI。watchdog 测试 8/8，全量 95/95。
# Changelog

All notable changes to this project are documented in this file.

## [0.5.3] — 2026-09-07

### Added
- **child-closed 事件订阅**（A）：订阅 `product-subagents/child-closed` 事件 → 取消空闲定时器 + 立即 dispose 远程会话（bridge.dispose → closeSession + SIGTERM），agent-dispatch closeChild 不再依赖 idleTimeoutMs 被动回收。
- **中断语义**（B）：ACP bridge submit 监听 `exec.signal` abort → closeSession + SIGKILL 终止 in-flight prompt，保留 binding 允许后续 reconnect 冷恢复；抛出 `SUBMIT_ABORTED` 错误，submit-failed 事件附带 `interrupted: true` 标记。
- **reconnect 守卫**（C）：新增 `closedChildren` Set——已被 child-closed 标记的 childId 不允许恢复重连，抛出 `RECONNECT_BLOCKED` 错误，不再拉起进程。
- **自动冻结恢复看门狗**（F）：
  - in-flight prompt 连续无输出 ≥ `watchdogNoOutputMs`（默认 180000ms=3 分钟，可通过 provider config 配置）→ kill ACP 进程 → reconnect → 继续等待 prompt。
  - **无限重试**：冻结条件持续则 kill→reconnect 无限循环，唯一终止条件为 child 被 agent_close（`WATCHDOG_CLOSED`）或 interrupt（`SUBMIT_ABORTED`）或 prompt 自然返回。
  - **per-round 状态机**：每轮 submit 重新武装看门狗，prompt 返回/close/interrupt 解除；后续 submit 不受此前 interrupt 影响。
  - **与 C 守卫共用状态源**：`isClosed` 回调检查 `closedChildren` + `signal.aborted`，看门狗 kill→reconnect 循环复用同一判定。
  - 合法长生成区分：`lastActivityAt`（onActivity 实际输出）重置冻结窗口，慢网络/慢模型只要有输出继续等待。
  - `idleTimeoutMs`（默认 10 分钟）作为看门狗之上的兜底上限——超过此时间仍无输出则 `SUBMIT_TIMEOUT`。
  - kill 计数仅日志用途（"累计 N 次 kill 恢复"），不限制重试。
- **watchdogNoOutputMs 配置**：provider 定义新增 `watchdogNoOutputMs` 字段（如 `deveco: { type: acp, command: opencode, args: [acp], watchdogNoOutputMs: 120000 }`），透传至 acp bridge。

### Changed
- `deps` 传递 `closedChildren` 至 product-submit 工具。
- scheduleDispose 路径保留为兜底（事件不可达时仍按 idleTimeoutMs 回收）。
- acp bridge `submit` 签名新增 `isClosed` 回调参数（第六参数，默认 `() => false`）。
- 旧 `promptOnce` 替换为 `promptWithWatchdog`（含看门狗 kill→reconnect 循环）；旧 `reconnect-once` + `SUBMIT_TIMEOUT` 抛错路径整合进看门狗状态机。
- `product-submit.js` 传递 `isClosed` 回调至 bridge.submit。

### Tests
- `test/watchdog.test.js`（7 项）：看门狗配置、isClosed 守卫集成、冻结检测与 kill、守卫耗尽不再重连、活跃输出无误触发、配置覆盖默认值。

## [0.5.2] — 2026-09-06

### Fixed
- **P1: ACP 权限请求「无 binding → 静默 deny → 挂死循环」修复**：deveco 守护进程重启窗口期派发的子代理，ACP binding 的 remote.sessionId 与后续权限请求的 sessionId 失配时，旧代码仅 `console.warn + return 'deny'`，导致秒级重试全部被静默拒绝、挂死 15 分钟直到 idle 看门狗杀会话。
  - 无可见静默路径：未知 ACP 会话的权限请求改为 `console.error` 级富诊断（含 sessionId、product、description、paths、bindings 总数与各 binding 的 sessionId 快照），并 emit `product-subagents/permission-unknown-session` 事件供上层/未来 UI 挂钩。
  - deny 风暴熔断：按 `(product, sessionId)` 维护 30 秒窗口计数，≥3 次未知会话 deny 触发升级动作——console.error 告警 + emit 同一事件（`escalated: true`）。当前无 sessionId → connection handle 注册表，无法自动 abort/close 失配会话；上层编排应订阅此事件触发 failover。
  - 保持 fail-closed：未授权仍返回 `'deny'`，本修复只改可见性/时效，不改授权语义。

### Added
- `lib/unknown-session-tracker.js`：纯函数式窗口计数熔断器（`createUnknownSessionTracker`），可独立单测。
- `test/unknown-session-tracker.test.js`（9 项）+ `test/unknown-session-permission.test.js`（5 项）：覆盖窗口计数、阈值触发、独立键、窗口过期重置、deleteEntry、maxEntries 淘汰、与 decidePermission 集成。

## [0.3.8] — 2026-09-06

### Added
- **ACP 权限交互授权（requestPermission 三层策略）**：不再一律拒绝（旧版 unattended 行为是 deveco/opencode 越权读文件→空正文失败的根因之一）。
  - `permission: 'interactive'`（默认）：ACP 产品请求权限（读文件/执行命令等）时经宿主 `ctx.approval` 向用户弹窗——允许一次 / 总是允许 / 拒绝一次 / 总是拒绝；`allowed-once` 映射 ACP 协议 `selected + allow_once optionId`。
  - `permission: 'read'`：只读类请求自动放行（`allow_once`），其余交互。
  - `permission: 'all'`：全部自动放行（危险，仅信任产品时使用）。
  - `permission: 'deny'`：一律拒绝（旧 fail-closed 行为）。
  - 无审批通道 / 无 open turn / 审批异常 → fail-closed 拒绝（绝不放行）。
- **ACP 协议合规修复**：权限响应此前返回 `{outcome:'rejected'}`——ACP 协议只认 `cancelled` 或 `selected + optionId`，非法值会令严格实现的产品（deveco 等）行为异常；现按协议返回 `selected(reject_once/reject_always)` 或 `cancelled`。
- 权限请求处理器（`decidePermission`）导出为纯函数，新增 `test/permission.test.js` 14 项单测（autoGrant 全放行/只读/写拒绝、handler 同步/异步/optionId 直返/垃圾值 fail-closed/异常 fail-closed、sessionId 透传等）。

### Config
- provider 配置新增 `permission` 字段（interactive/read/all/deny），cordis.patch.yml 中按产品设置。

All notable changes to this project are documented in this file.

## [0.3.7] — 2026-09-06

### Added
- `product_submit` 抛错/成功时向事件总线 emit `product-subagents/submit-failed` / `submit-ok`（payload: childId/product/code/message）。这是与 dsh-agent-dispatch 1.7.1 自动换档机制的跨插件信号通道：relay child 是 LLM agent，工具报错后以 `completed` 正常结束回合，编排层无法从宿主 stopReason 感知产品侧故障（空正文/超时/限流耗尽），必须由工具层发出结构性失败信号，编排层才能按 fallback 链自动换档重试同一任务；`submit-ok` 供编排层清除同一回合二次提交成功后的残留失败标记。

All notable changes to this project are documented in this file.

## [0.3.1] — 2026-08-17

### Added
- Declare `dsh.bundle` in `package.json` and ship a `cordis.patch.yml` bundle
  patch. `dsh plugin --profile <name> add dsh-plugin-product-subagents` now
  automatically wires the plugin as a profile layer — no manual
  `cordis.patch.yml` editing required, and the "declares no dsh.bundle"
  warning is gone.

### Changed
- README (EN + zh): the recommended install method is now
  `dsh plugin --profile web add dsh-plugin-product-subagents`. The manual
  fallback switched from `npm i` to `pnpm add` with an explanation of why npm
  breaks the harness singleton (it auto-installs peer dependencies, shadowing
  the host's `@deepseek-ai/dsh-tools` symlink — the same root cause as #3).

### Notes
- Issue #3's code fix shipped in 0.3.0 (dsh-tools moved to `peerDependencies`),
  but `dsh plugin add` still resolved to 0.2.0 on machines running pnpm 11:
  pnpm 11 enables `minimumReleaseAge` by default, and 0.3.0 was too new to
  pass the age gate, so pnpm fell back to 0.2.0 (which has dsh-tools in
  `dependencies` and reproduces the crash). Once 0.3.0+ ages past the
  threshold the problem disappears; until then, pin explicitly with
  `dsh plugin --profile web add dsh-plugin-product-subagents@0.3.0`.

## [0.3.0] — 2026-08-17

### Fixed
- Windows: `winArgs()` wraps the whole `cmd /S /C` invocation in one outer
  pair of quotes, so `/S` strips exactly that pair instead of the command's
  own quotes. `product_delegate` (claude-code / codex) no longer fails with
  `'claude" -p ...' is not recognized` (fixes #1).
- Move `@deepseek-ai/dsh-tools` from `dependencies` to `peerDependencies`: the
  harness core package must share a singleton with the host, and a second
  pnpm-installed copy in the profile shadowed the symlink and crashed every
  tool call with `Cannot read properties of undefined (reading 'prepare')`
  (fixes #3).

## [0.2.0] — 2026-08-13

Open-source release restructuring.

### Added
- Standalone npm package (`dsh-plugin-product-subagents`), MIT licensed.
- Unit test suite (`node --test`) with a fake bridge; no product CLIs needed.
- GitHub Actions CI matrix (macOS / Ubuntu / Windows).
- Config validation (`zod`) for `providers`, roles, and plugin config.
- Bilingual README (EN + zh), CONTRIBUTING, SECURITY, ARCHITECTURE docs.
- Split `lib/index.js` into `lib/tools/*` (one module per tool).

## [0.1.0]

### Added
- Config-driven provider registry: built-in `claude-code`, `codex`, `acp` plus
  custom ACP agents via `config.providers` (e.g. `agent acp`, `cbc --acp`,
  `gemini --acp`).
- Declarative role library (`roles/*.json`): `general` (default, full
  permissions, may delegate), `code-review` (readonly), `explore` (readonly,
  never delegates), `debug` (default). Delegation defaults ON; `false` bans it.
- Role-based product permissions (`readonly` / `default` / `full`) mapped to
  each product's own CLI flags; the relay model is always a read-only pipe.
- Delegation permission ceiling: a child cannot spawn a descendant with more
  permission than it has.
- Continuable children with durable session recovery (registry file +
  session-log markers), idle disposal of remote sessions, configurable
  per-product timeouts, and a concurrency cap.
- Tools: `product_delegate`, `product_roles`, `product_submit`,
  `subagent_progress`, `product_wait`, `product_agents`.
- Cross-platform process launching (Windows `.cmd` shims via `cmd.exe`),
  Windows-safe path escaping, `fileURLToPath` for module paths.
