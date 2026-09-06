import { bindings, MARKER, recoverRemoteSessionId } from './bindings.js'
import { detectAvailability } from './availability.js'
import { validateConfig } from './config.js'
import { foldProgress, foldTrace, foldTokenUsage } from './progress.js'
import { buildProviders, createBridgeFor } from './providers.js'
import { allowlistDecision } from './allowlist.js'
import { readUserAllowlist, appendUserRule, userRulesCover } from './user-allowlist.js'
import { createRegistry } from './registry.js'
import { createRoleLibrary, defaultRolesDir } from './roles.js'
import { parentCwd } from './run.js'
import { registerProductSubmit } from './tools/product-submit.js'
import { registerProductDelegate } from './tools/product-delegate.js'
import { registerProductRoles } from './tools/product-roles.js'
import { registerSubagentProgress } from './tools/subagent-progress.js'
import { registerProductWait } from './tools/product-wait.js'
import { registerProductAgents } from './tools/product-agents.js'
import { createUnknownSessionTracker } from './unknown-session-tracker.js'

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
   * v0.5.0：授权球决策表（childId → { resolve }）。
   * 交互审批双通道竞速：宿主弹窗（approval.request）vs 授权球按钮事件
   * （product-subagents/permission-decision）。任一先应答即生效；授权球
   * 「总是允许」先到时落盘 allowlist.json（按 cwd 作用域）并 abort 弹窗。
   */
  const pendingDecisions = new Map()
  try {
    ctx.on('product-subagents/permission-decision', (info) => {
      const entry = info && info.childId ? pendingDecisions.get(info.childId) : undefined
      if (!entry) return // 无挂起审批或已被弹窗通道应答 → 忽略
      const answer = info && info.answer
      if (answer === 'allow-once' || answer === 'allow-session' || answer === 'allow-always' || answer === 'deny') {
        pendingDecisions.delete(info.childId)
        entry.resolve(answer)
      } else {
        console.warn(`product-subagents: 未知授权决策 ${answer}（child=${String(info && info.childId).slice(0, 8)}）`)
      }
    })
  } catch (err) {
    console.warn(`product-subagents: permission-decision 订阅失败: ${err.message}`)
  }
  /**
   * v0.5.0「会话期总是允许」：内存授权，作用域 = 主代理当前会话 parentSessionId
   * （用户确认简化为仅此一个条件，不再叠加工作目录）。用户手动点击产生
   * （非 AI 记忆），主代理会话结束（session/disposed）即清除，不落盘。
   * key `${parentSessionId}` → 该会话下用户已批准过的路径规则数组。
   */
  const sessionRules = new Map()
  const sessionKey = (parentSessionId) => `${parentSessionId || '?'}`
  const sessionRulesCover = (parentSessionId, reqPaths) => {
    if (!parentSessionId || !Array.isArray(reqPaths) || reqPaths.length === 0) return false
    const rules = sessionRules.get(sessionKey(parentSessionId))
    if (!rules || rules.length === 0) return false
    for (const rulePaths of rules) {
      const { allowed } = allowlistDecision(reqPaths, rulePaths)
      if (allowed) return true
    }
    return false
  }
  const addSessionRule = (parentSessionId, paths) => {
    const key = sessionKey(parentSessionId)
    const rules = sessionRules.get(key) || []
    // 幂等：同集合不重复
    const dup = rules.find((r) => JSON.stringify([...r].sort()) === JSON.stringify([...(paths || [])].sort()))
    if (!dup) {
      rules.push([...(paths || [])])
      sessionRules.set(key, rules)
    }
  }
  try {
    ctx.on('session/disposed', (session) => {
      const sid = session && (session.id || (typeof session === 'string' ? session : null))
      if (!sid) return
      // 清该父会话名下的所有会话期授权（也兼容 session 对象形态）
      for (const key of [...sessionRules.keys()]) {
        if (key.startsWith(`${sid}::`)) sessionRules.delete(key)
      }
    })
  } catch (err) {
    console.warn(`product-subagents: session/disposed 订阅失败（会话期授权将随进程存活）: ${err.message}`)
  }
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
  const unknownSessionTracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3, maxEntries: 100 })

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
      // 1. ACP sessionId → child session id → live agent（binding 带 cwd/parentSessionId）
      let childId = null
      let bindCwd = null
      let bindParentSessionId = null
      for (const [cid, record] of bindings.entries()) {
        const remoteId = record && record.remote && (record.remote.sessionId || record.remote.threadId)
        if (remoteId && remoteId === sessionId) {
          childId = cid
          bindCwd = record && record.cwd ? record.cwd : null
          bindParentSessionId = record && record.parentSessionId ? record.parentSessionId : null
          break
        }
      }
      if (!childId) {
        const bindingSnapshots = []
        for (const [cid, rec] of bindings.entries()) {
          bindingSnapshots.push({ childId: String(cid).slice(0, 8), remoteSessionId: rec && rec.remote && (rec.remote.sessionId || rec.remote.threadId) ? String(rec.remote.sessionId || rec.remote.threadId).slice(0, 12) : null, product: rec && rec.product || null })
        }
        console.error(
          `product-subagents: [P1-unknown-session] 权限请求来自未知 ACP 会话（无 binding 匹配），拒绝\n` +
          `  sessionId: ${sessionId}\n` +
          `  product: ${product}\n` +
          `  description: ${description || '(无)'}\n` +
          `  paths: ${Array.isArray(paths) ? paths.join(', ') : '(无)'}\n` +
          `  bindings总数: ${bindings.size}` +
          (bindingSnapshots.length > 0 ? `\n  bindings快照: ${JSON.stringify(bindingSnapshots)}` : ''),
        )
        const trackerResult = unknownSessionTracker.check(product, sessionId)
        const payload = {
          product,
          sessionId,
          description: description || '(无)',
          paths: Array.isArray(paths) ? paths : [],
          at: Date.now(),
          escalated: false,
        }
        if (trackerResult.escalated) {
          console.error(
            `product-subagents: [P1-unknown-session] deny 风暴熔断触发！30 秒窗口内 ${trackerResult.count} 次未知会话拒绝 (product=${product}, sessionId=${sessionId})\n` +
            `  → 无法定位该 ACP 会话的连接句柄（bindings 中无匹配，bridges 无 sessionId 索引注册表），无法 abort/close\n` +
            `  → 上层编排应通过此事件感知并触发 failover`,
          )
          payload.escalated = true
          payload.denyCount = trackerResult.count
          payload.windowStart = trackerResult.windowStart
        }
        try {
          ctx.emit?.('product-subagents/permission-unknown-session', payload)
        } catch { /* 事件发射失败不影响 fail-closed 拒绝 */ }
        return 'deny'
      }
      // 1.5a 会话期白名单（v0.5.0）：手动「会话期总是允许」的授权——
      //     仅按主代理当前会话 parentSessionId 判定（不叠加工作目录），
      //     内存态、会话结束自动清除。命中放行本次（allow_once——绝不让
      //     deveco 端持久记忆，作用域由本层判定掌控）。
      if (bindParentSessionId && sessionRulesCover(bindParentSessionId, paths || [])) {
        console.log(`product-subagents: [ACP ${product}] 命中会话期授权（主代理会话 ${String(bindParentSessionId).slice(0, 8)}…），自动放行`)
        return 'allow'
      }
      // 1.5b 用户落盘白名单（v0.5.0）：手动「总是允许(项目)」的持久授权——
      //     按工作目录 cwd 作用域匹配（同项目内生效，跨会话），命中放行本次。
      const userRules = readUserAllowlist()
      if (bindCwd && userRulesCover(userRules, bindCwd, paths || [])) {
        console.log(`product-subagents: [ACP ${product}] 命中用户落盘白名单（项目 ${bindCwd}），自动放行`)
        return 'allow'
      }
      const agents = ctx.get?.('agents')
      const agent = agents?.get?.(childId)
      const approval = ctx.get?.('approval')
      if (!agent || !approval || typeof approval.request !== 'function') {
        console.warn(`product-subagents: 无审批通道（agent=${!!agent} approval=${!!approval}），权限请求按拒绝处理`)
        return 'deny'
      }
      // 2. 交互授权（v0.5.0 双通道竞速）：
      //    通道 A = 宿主审批弹窗（policy 提升 ask 后经 scope 呈现在子代理会话 UI，
      //            用户可点 允许一次/拒绝——宿主词表无"总是允许"）；
      //    通道 B = agent-dispatch 授权球按钮（允许一次 / 总是允许 / 拒绝），
      //            经 'product-subagents/permission-decision' 事件应答；
      //            「总是允许」= 手动确认 → 落盘 allowlist.json（按 cwd 作用域）→
      //            同时放行当前请求（abort 弹窗通道），后续同项目同路径不再询问。
      //    谁先应答谁生效；弹窗通道若已被授权球先答，以 abort 结束。
      try {
        const policy = typeof approval.effectivePolicy === 'function'
          ? approval.effectivePolicy(agent.session)
          : undefined
        if (policy !== 'ask') {
          console.log(`product-subagents: [ACP ${product}] 提升 child 审批策略 ${policy}→ask（交互授权，child=${String(childId).slice(0, 8)}…）`)
          if (typeof approval.setPolicy === 'function') approval.setPolicy(agent, 'ask')
        }
      } catch (policyErr) {
        console.warn(`product-subagents: approval policy 提升失败: ${policyErr && policyErr.message ? policyErr.message : policyErr}`)
      }
      // 发 pending 通知（授权球/主代理提示），附 paths/cwd/parentSessionId 供 UI 展示与决策
      try {
        ctx.emit?.('product-subagents/permission-pending', {
          childId,
          product,
          description: description || '未知操作',
          paths: Array.isArray(paths) ? paths : [],
          cwd: bindCwd,
          parentSessionId: bindParentSessionId,
          at: Date.now(),
        })
      } catch { /* 通知失败不影响审批 */ }
      const buttonAnswer = new Promise((resolve) => {
        pendingDecisions.set(childId, { resolve })
      })
      const ac = new AbortController()
      const approvalOutcome = approval.request({
        agent,
        toolName: 'product_submit',
        reason: `[ACP ${product}] 请求权限：${description || '未知操作'}`,
        signal: ac.signal,
      })
      // 竞速：弹窗先答 → 用其结果；按钮先答 → abort 弹窗并用按钮决策
      let outcome = null
      let button = null
      const winner = await Promise.race([
        approvalOutcome.then((o) => ({ src: 'approval', outcome: o }), (e) => ({ src: 'approval', error: e })),
        buttonAnswer.then((a) => ({ src: 'button', answer: a })),
      ])
      if (winner.src === 'approval') {
        pendingDecisions.delete(childId) // 弹窗已答，按钮通道作废
        outcome = winner.outcome
      } else {
        button = winner.answer
        ac.abort() // 授权球已决，取消弹窗通道（approvalOutcome 以 cancelled 结束，忽略）
        pendingDecisions.delete(childId)
      }
      // 按钮通道处理（v0.5.0）：
      //   allow-session → 会话期授权（内存，按主代理会话，不落盘）
      //   allow-always  → 总是允许（落盘 allowlist.json，按 cwd 项目作用域）
      //   allow-once    → 仅本次；deny → 拒绝
      if (button !== null) {
        let btnOutcome = 'rejected'
        if (button === 'allow-session') {
          addSessionRule(bindParentSessionId, paths || [])
          btnOutcome = 'granted-session'
          console.log(`product-subagents: [ACP ${product}] 授权球：会话期总是允许（主代理会话 ${String(bindParentSessionId || '').slice(0, 8)}…，${(paths || []).length} 路径，内存态）`)
        } else if (button === 'allow-always') {
          const saved = appendUserRule({ cwd: bindCwd, product, paths: paths || [], grantedAt: new Date().toISOString() })
          if (saved.ok) {
            btnOutcome = 'granted-always'
            console.log(`product-subagents: [ACP ${product}] 用户点击总是允许 → 已落盘（项目 ${bindCwd}，${(paths || []).length} 路径）`)
          } else {
            btnOutcome = 'granted-once-fallback'
            console.error(`product-subagents: [ACP ${product}] 总是允许落盘失败(${saved.error})，本次仍放行但不会记忆`)
          }
        } else if (button === 'allow-once') {
          btnOutcome = 'allowed-once'
          console.log(`product-subagents: [ACP ${product}] 授权球：用户选择允许一次`)
        } else {
          console.warn(`product-subagents: [ACP ${product}] 授权球：用户选择拒绝`)
        }
        try {
          ctx.emit?.('product-subagents/permission-resolved', { childId, product, outcome: btnOutcome, at: Date.now() })
        } catch { /* 通知失败不影响审批 */ }
        // v0.5.1：统一返回 'allow'（allow_once）——会话/项目记忆由本层判定掌控，
        // 绝不让 deveco 端 allow_always 持久记忆（会绕过作用域，跨会话跨项目放行）。
        if (button === 'allow-session' || button === 'allow-always' || button === 'allow-once') return 'allow'
        return 'deny'
      }
      // 弹窗通道结果映射（宿主词表：allowed-once / rejected / cancelled / unavailable）
      try {
        ctx.emit?.('product-subagents/permission-resolved', {
          childId,
          product,
          outcome,
          at: Date.now(),
        })
      } catch { /* 通知失败不影响审批 */ }
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
        const parentSessionId = request.parent && request.parent.session ? request.parent.session.id : null
        bindings.set(request.sessionId, { product: providerName, bridge, remote, settings: undefined, cwd, parentSessionId })
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
