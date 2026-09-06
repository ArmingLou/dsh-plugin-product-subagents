import { bindings, MARKER, recoverRemoteSessionId } from './bindings.js'
import { detectAvailability } from './availability.js'
import { validateConfig } from './config.js'
import { foldProgress, foldTrace, foldTokenUsage } from './progress.js'
import { buildProviders, createBridgeFor } from './providers.js'
import { allowlistDecision } from './allowlist.js'
import { createRegistry } from './registry.js'
import { createRoleLibrary, defaultRolesDir } from './roles.js'
import { parentCwd } from './run.js'
import { registerProductSubmit } from './tools/product-submit.js'
import { registerProductDelegate } from './tools/product-delegate.js'
import { registerProductRoles } from './tools/product-roles.js'
import { registerSubagentProgress } from './tools/subagent-progress.js'
import { registerProductWait } from './tools/product-wait.js'
import { registerProductAgents } from './tools/product-agents.js'

export const name = 'product-subagents'
export const inject = ['subagents', 'tools', 'sessions']

/**
 * Role-based Codex / Claude Code / ACP subagent providers for the DeepSeek
 * Harness.
 *
 * Providers come from a config-driven registry (built-ins plus custom
 * `config.providers`, see lib/providers.js) and are registered ONLY for
 * products whose CLI was detected on PATH. Each provider supports both
 * one-shot `start()` and `prepareContinuable()`. Continuable children are
 * pinned to one product and one remote session for their lifetime: the
 * binding is keyed by the child session id, created once, and never switches
 * products (recovery reads the child's own log and the durable registry, so
 * even recovery cannot cross products).
 *
 * Tools registered (each in lib/tools/):
 *  - `product_delegate` — role-aware delegation (sync one-shot or async
 *    continuable), with optional model / reasoning-effort overrides.
 *  - `product_roles` — the declarative role library.
 *  - `product_submit` — the per-child bridge tool (children only).
 *  - `subagent_progress` — latest progress of one product subagent.
 *  - `product_wait` — attach to a child and block until it settles.
 *  - `product_agents` — detected availability + live children overview.
 */
export function apply(ctx, config = {}) {
  const cfg = validateConfig(config)
  const providers = buildProviders(cfg)
  const availability = detectAvailability(providers)
  /**
   * v0.4.0：ACP requestPermission 的交互审批处理器。
   *
   * 背景：ACP 产品（deveco/opencode 等）在做敏感操作（读工作区外文件、执行
   * 命令等）前会向 client 发 RequestPermission；旧实现一律拒绝 → 产品零产出 →
   * 空正文失败。宿主有 ApprovalService（bash/fs 越权同款）：policy=ask 时向
   * 用户弹窗，allowed-once 是唯一放行。本 handler 把 ACP 权限请求转成宿主审批：
   *   1. 由 ACP sessionId 反查绑定它的 child session（bindings 以 childId 为 key，
   *      record.remote.sessionId 即 ACP 会话 id），取该 child 的 live agent；
   *   2. 调 ctx.approval.request（要求 open turn——product_submit 恰在 relay
   *      child 回合内执行，满足约束），reason 携带 ACP 请求描述；
   *   3. allowed-once → 返回 'allow'（acp.js 选 allow_once optionId）；
   *      rejected → 'deny'；cancelled/unavailable/异常 → fail-closed（拒绝，
   *      但以 ACP 合法响应的形式——selected reject option 或 cancelled）。
   * 返回 undefined 表示"无审批通道"（交由 acp.js 的 auto/fail-closed 兜底）。
   */
  const permissionHandler = async ({ product, sessionId, description, paths }) => {
    try {
      // 0. 白名单快速路径（v0.4.0）：请求路径全部命中 provider.allowWritePaths →
      //    直接授权（可读可写）不弹窗，返回 'allow-always'（acp.js 优先选
      //    allow_always——ACP 服务端记住授权，后续同类请求不再询问）。
      const providerCfg = providers[product] || providers[String(product).replace(/-cli$/, '')]
      const allowRules = providerCfg && Array.isArray(providerCfg.allowWritePaths) ? providerCfg.allowWritePaths : []
      if (allowRules.length > 0 && Array.isArray(paths) && paths.length > 0) {
        const { allowed, covered, uncovered } = allowlistDecision(paths, allowRules)
        if (allowed) {
          console.log(`product-subagents: [ACP ${product}] 白名单自动授权读写（${covered.length} 路径，不弹窗）`)
          return 'allow-always'
        }
        if (uncovered.length > 0 && covered.length === 0) {
          console.log(`product-subagents: [ACP ${product}] 权限请求不在白名单，转交互审批: ${uncovered.join(', ')}`)
        } else if (uncovered.length > 0) {
          console.log(`product-subagents: [ACP ${product}] 权限请求部分越权（白名单内 ${covered.length} + 外 ${uncovered.length}），转交互审批`)
        }
      }
      // 1. ACP sessionId → child session id → live agent
      let childId = null
      for (const [cid, record] of bindings.entries()) {
        const remoteId = record && record.remote && (record.remote.sessionId || record.remote.threadId)
        if (remoteId && remoteId === sessionId) { childId = cid; break }
      }
      if (!childId) {
        console.warn(`product-subagents: 权限请求来自未知 ACP 会话 ${sessionId}（无 binding），拒绝`)
        return 'deny'
      }
      const agents = ctx.get?.('agents')
      const agent = agents?.get?.(childId)
      const approval = ctx.get?.('approval')
      if (!agent || !approval || typeof approval.request !== 'function') {
        console.warn(`product-subagents: 无审批通道（agent=${!!agent} approval=${!!approval}），权限请求按拒绝处理`)
        return 'deny'
      }
      // 2. B 方案（用户选定"上报主代理/用户中转决策"）：ACP 权限请求应可交互授权，
      //    而非一律拒绝。宿主 delegation 会把子代理 approval policy pin 成 'never'
      //    （子代理不得直接弹窗的安全设计）。ACP relay child 是受控例外：
      //      - 其 toolFilter 只放行 product_submit，审批暴露面仅此一处；
      //      - child 当前正处 open turn（product_submit 执行中），满足 ApprovalService
      //        审计约束（approval/asked+decided 成对、turn 内提交）；
      //      - 宿主 policy 可动态切换（delegation pin 之后 append 的事件胜出——
      //        宿主注释 "later child switches still win over these events"）。
      //    故此处把该 child policy 动态提升为 'ask'：审批请求经宿主 scope 链路由，
      //    由主会话 UI 呈现给用户（允许/拒绝），用户应答后回填 ACP grant/reject。
      try {
        const policy = typeof approval.effectivePolicy === 'function'
          ? approval.effectivePolicy(agent.session)
          : undefined
        if (policy !== 'ask') {
          console.log(`product-subagents: [ACP ${product}] 提升 child 审批策略 ${policy}→ask（交互授权，child=${String(childId).slice(0, 8)}…）`)
          if (typeof approval.setPolicy === 'function') approval.setPolicy(agent, 'ask')
        }
      } catch (policyErr) {
        // 提升失败不阻断：request 按原 policy（never）直接 rejected → fail-closed
        console.warn(`product-subagents: approval policy 提升失败: ${policyErr && policyErr.message ? policyErr.message : policyErr}`)
      }
      // 3. 宿主审批弹窗（policy=ask 时用户可见；审计成对落 child session 日志）。
      //    弹窗按 session scope 路由到【子代理会话】UI——主代理窗口看不到。
      //    为了让主代理环境感知"有子代理在等授权"，在挂起前/决议后发跨插件事件
      //    （dsh-agent-dispatch 订阅 → FAB 徽标/面板「⏳待授权」/主代理提示）。
      try {
        ctx.emit?.('product-subagents/permission-pending', {
          childId,
          product,
          description: description || '未知操作',
          at: Date.now(),
        })
      } catch { /* 通知失败不影响审批 */ }
      const outcome = await approval.request({
        agent,
        toolName: 'product_submit',
        reason: `[ACP ${product}] 请求权限：${description || '未知操作'}`,
      })
      try {
        ctx.emit?.('product-subagents/permission-resolved', {
          childId,
          product,
          outcome,
          at: Date.now(),
        })
      } catch { /* 通知失败不影响审批 */ }
      // 3. outcome 映射（宿主词表：allowed-once / rejected / cancelled / unavailable）
      if (outcome === 'allowed-once') {
        console.log(`product-subagents: [ACP ${product}] 用户已批准权限请求：${description}`)
        return 'allow'
      }
      if (outcome === 'rejected') {
        console.log(`product-subagents: [ACP ${product}] 用户已拒绝权限请求：${description}`)
        return 'deny'
      }
      console.warn(`product-subagents: [ACP ${product}] 权限请求无有效审批结果(${outcome})，按拒绝处理：${description}`)
      return 'deny'
    } catch (error) {
      // 审批通道本身异常（无 open turn 等）→ fail-closed 拒绝，绝不放行
      console.warn(`product-subagents: 权限审批异常，按拒绝处理: ${error && error.message ? error.message : error}`)
      return 'deny'
    }
  }
  const bridges = Object.fromEntries(
    Object.entries(providers)
      .filter(([name]) => availability[name].registered)
      .map(([name, def]) => [name, createBridgeFor(def, { permissionHandler })]),
  )
  // Durable remote-session registry: survives binding disposal and restarts so
  // a cold-resumed child reconnects to the same product session.
  const registry = createRegistry(cfg.registryPath)

  /** Persist the child's currently-known remote session id, if any. */
  const persistRemote = (childId, record, cwd) => {
    const remoteId = record && record.remote && (record.remote.sessionId || record.remote.threadId)
    if (!remoteId) return
    registry.set(childId, { product: record.product, remoteId, cwd })
  }

  // Idle disposal: a settled child's remote session (a persistent ACP server
  // process, or a resumable claude/codex id) is disposed after it stays
  // unreused for `idleTimeoutMs`. 0 disables auto-disposal. Reuse (a
  // product_submit call) cancels the pending timer, so fast continuation
  // (send_message cold resume) never pays a reconnect; long-idle children
  // release their processes instead of leaking until plugin unload.
  const idleTimeoutMs = cfg.idleTimeoutMs !== undefined ? Math.max(0, Number(cfg.idleTimeoutMs) || 0) : 600000
  const disposeTimers = new Map()
  const cancelDispose = (childId) => {
    const timer = disposeTimers.get(childId)
    if (timer !== undefined) {
      clearTimeout(timer)
      disposeTimers.delete(childId)
    }
  }
  const scheduleDispose = (childId) => {
    cancelDispose(childId)
    if (idleTimeoutMs <= 0) return
    const timer = setTimeout(() => {
      disposeTimers.delete(childId)
      const record = bindings.get(childId)
      if (record) {
        record.bridge.dispose(record.remote).catch(() => {})
        bindings.delete(childId)
      }
    }, idleTimeoutMs)
    disposeTimers.set(childId, timer)
  }

  let seq = 0

  const taskText = (request) => {
    const prompt = request && request.prompt
    if (!Array.isArray(prompt)) return ''
    return prompt.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
  }

  // ── providers (only for detected, registered products) ────────────────────
  for (const [providerName, bridge] of Object.entries(bridges)) {
    const provider = {
      name: providerName,
      inheritsParentContext: false,
      // The harness rejects persona/toolFilter requests unless the provider
      // advertises the capability. For continuable children the manager
      // applies both itself (applyChildComposition); for one-shot remote
      // children they are trivially satisfied (no child tool surface).
      capabilities: { persona: true, toolFilter: true },
      async start(request) {
        const cwd = parentCwd(request.parent)
        const task = taskText(request)
        const remote = await bridge.create(cwd)
        try {
          const out = await bridge.submit(remote, task, request.signal, cwd, request.productSettings)
          const id = `${providerName}-${Date.now().toString(36)}-${++seq}`
          return {
            id,
            localAgent: undefined,
            result: Promise.resolve({
              output: [{ type: 'text', text: out.text }],
              stopReason: out.stopReason,
            }),
            async dispose() {
              await bridge.dispose(remote).catch(() => {})
            },
          }
        } catch (error) {
          await bridge.dispose(remote).catch(() => {})
          throw error
        }
      },
      async prepareContinuable(request) {
        const cwd = parentCwd(request.parent)
        const remote = await bridge.create(cwd)
        // NOTE: the host whitelists this request to { sessionId, parent, signal },
        // so per-agent settings (model/effort) can NOT ride along here. They are
        // written after startContinuable resolves via the
        // 'product-subagents/apply-child-settings' event (or by product_delegate
        // itself, which writes bindings directly in-process).
        bindings.set(request.sessionId, { product: providerName, bridge, remote, settings: undefined })
        // acp learns its session id at creation; claude/codex persist it after
        // the first submission via product_submit.
        persistRemote(request.sessionId, { product: providerName, remote }, cwd)
        return { seed: [] }
      },
    }
    ctx.subagents.registerProvider(provider)
  }

  // ── shared tool dependencies ────────────────────────────────────────────────
  const roles = createRoleLibrary(cfg.rolesDir || defaultRolesDir())
  const availableProviders = Object.keys(bridges)
  const state = { activeChildren: 0 }
  const maxConcurrent = Math.max(1, Number(cfg.maxConcurrentChildren) || 8)
  const deps = {
    bindings, MARKER, recoverRemoteSessionId,
    bridges, availability, providers, roles,
    registry, persistRemote, cancelDispose,
    foldProgress, foldTrace, foldTokenUsage,
    state, maxConcurrent, availableProviders,
  }

  registerProductSubmit(ctx, deps)
  registerProductDelegate(ctx, deps)
  registerProductRoles(ctx, deps)
  registerSubagentProgress(ctx, deps)
  registerProductWait(ctx, deps)
  registerProductAgents(ctx, deps)

  // ── cross-plugin channel: post-create child settings ────────────────────────
  // The host's startContinuable calls provider.prepareContinuable with a
  // whitelisted request ({ sessionId, parent, signal }) — unknown fields such
  // as `productSettings` never reach it. Orchestration layers (e.g.
  // dsh-agent-dispatch's ACP agent routes) therefore cannot forward per-agent
  // model/effort through the request. Expose a channel over the cordis event
  // bus instead (ctx properties are inject-gated, events are not): the
  // dispatcher emits after startContinuable resolves — the binding already
  // exists by then, the same sequencing product_delegate relies on when it
  // writes bindings itself. Returns true when applied.
  ctx.on('product-subagents/apply-child-settings', (payload) => {
    const record = payload && payload.childId ? bindings.get(payload.childId) : undefined
    if (!record || !payload.settings || typeof payload.settings !== 'object') return false
    record.settings = payload.settings
    return true
  })

  // ── idle disposal: settle → schedule release (reuse cancels it) ────────────
  // The event is emitted per continuable Activation epoch, i.e. after every
  // completed turn of a leaf child. Scheduling (not immediate) disposal keeps
  // fast send_message continuation on the same remote session, while children
  // that stay idle for `idleTimeoutMs` release their processes/sessions.
  ctx.on('subagent/end', (info) => {
    if (info && info.id) {
      if (bindings.has(info.id)) scheduleDispose(info.id)
      state.activeChildren = Math.max(0, state.activeChildren - 1)
    }
  })

  // ── plugin teardown: dispose every live remote session ─────────────────────
  ctx.effect(() => {
    return () => {
      for (const timer of disposeTimers.values()) clearTimeout(timer)
      disposeTimers.clear()
      for (const record of bindings.values()) {
        record.bridge.dispose(record.remote).catch(() => {})
      }
      bindings.clear()
    }
  })
}
