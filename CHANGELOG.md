# Changelog

All notable changes to this project are documented in this file.

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
