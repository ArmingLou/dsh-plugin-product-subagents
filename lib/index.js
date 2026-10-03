import { bindings, MARKER, recoverRemoteSessionId } from './bindings.js'
import { detectAvailability } from './availability.js'
import { validateConfig } from './config.js'
import { foldProgress, foldTrace, foldTokenUsage } from './progress.js'
import { buildProviders, createBridgeFor } from './providers.js'
import { allowlistDecision } from './allowlist.js'
import { createPendingRegistry, createSessionRules, permissionCategoryKey } from './permission-state.js'
import { readUserAllowlist, appendUserRule, userRulesCover } from './user-allowlist.js'
import { createRegistry } from './registry.js'
import { createRoleLibrary, defaultRolesDir } from './roles.js'
import { parentCwd } from './run.js'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  createProviderCatalog,
  createProviderProber,
} from './provider-catalog.js'
import { registerProductSubmit } from './tools/product-submit.js'
import { registerProductDelegate } from './tools/product-delegate.js'
import { registerProductRoles } from './tools/product-roles.js'
import { registerSubagentProgress } from './tools/subagent-progress.js'
import { registerProductWait } from './tools/product-wait.js'
import { registerProductAgents } from './tools/product-agents.js'
import { createUnknownSessionTracker } from './unknown-session-tracker.js'
import { FAILOVER_MODES } from './submit-failure.js'

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
   * v0.5.0：授权球决策表。
   * v0.6.2(A)：改为**每请求一条**（childId → Map<permId, resolve>）。旧实现是
   * childId 单槽——同一 child 并发 2 条权限请求时后到者覆盖前者的 resolve，
   * 用户点一次只能兑现一条，剩下的从宿主弹窗通道（授权球蓝球）再次冒出。
   * 交互审批双通道竞速：宿主弹窗（approval.request）vs 授权球按钮事件
   * （product-subagents/permission-decision）。任一先应答即生效；授权球
   * 「总是允许」先到时落盘 allowlist.json（按 cwd 作用域）并 abort 弹窗。
   */
  const pendingDecisions = createPendingRegistry()
  /**
   * v0.6.2(M2)：兑现并清空某 child 的**全部**挂起审批。
   * 必须是 settle（摘表 + 兑现 resolve）而不是 clearChild（只摘不兑现）：
   * permissionHandler 的 `await Promise.race` 还挂在 buttonAnswer 上，光摘表会让
   * 那条 ACP requestPermission 永远悬着（产品侧会话卡在等决议）。
   */
  const settleAllPending = (childId, answer) => {
    const ids = pendingDecisions.list(childId)
    for (const pid of ids) pendingDecisions.settle(childId, pid, answer)
    return ids
  }
  // v0.5.6：预留"方案问答/其他人类决策"等待注册表（未来 Q&A 通道注册于此，
  // 与 pendingDecisions 一样受看门狗/空闲回收豁免）。当前无写入方，结构就位。
  const pendingQuestions = new Map() // childId -> { resolve, at }（预留）
  // v0.5.5：该 ACP 会话是否有权限请求正等待人类决策（pendingDecisions 命中）——
  // 看门狗与空闲回收据此豁免"无输出"判定（等待决策的静默是正常状态）。
  // v0.5.6：泛化判定——该 ACP 会话是否有【任何人类决策】正等待（授权 or 预留的问答）。
  // 看门狗与空闲回收据此豁免"无输出/空闲"判定：等人类决策的静默是正常状态，不是冻结。
  const isHumanWaitPending = (sessionIdOrThreadId) => {
    if (!sessionIdOrThreadId) return false
    for (const [cid, rec] of bindings.entries()) {
      const remoteId = rec && rec.remote && (rec.remote.sessionId || rec.remote.threadId)
      if (remoteId === sessionIdOrThreadId && (pendingDecisions.has(cid) || pendingQuestions.has(cid))) return true
    }
    return false
  }

  // v0.5.5：本轮（relay 回合）用户拒绝记忆——无 TTL。拒绝作用于"当前回合"：
  // 回合内同路径再次请求（含 relay 自愈重试、deveco 同轮重问）静默拒绝不弹窗；
  // 回合结束（subagent/end）/ 子代理关闭 / 会话销毁时清除 → 新一轮恢复可问。
  const roundRejected = new Map() // childId -> { paths: Set<string>, at }
  const addRoundRejected = (childId, paths) => {
    if (!childId || !Array.isArray(paths) || paths.length === 0) return
    roundRejected.set(childId, { paths: new Set(paths), at: Date.now() })
  }
  const clearRoundRejected = (childId) => { if (childId) roundRejected.delete(childId) }
  const isRoundRejected = (childId, paths) => {
    const rej = roundRejected.get(childId)
    if (!rej || !Array.isArray(paths) || paths.length === 0) return false
    return paths.every((p) => rej.paths.has(p))
  }
  try {
    ctx.on('product-subagents/permission-decision', (info) => {
      const childId = info && info.childId
      if (!childId) return
      if (!pendingDecisions.has(childId)) return // 无挂起审批或已被弹窗通道应答 → 忽略
      const answer = info && info.answer
      if (answer === 'allow-once' || answer === 'allow-session' || answer === 'allow-always' || answer === 'deny') {
        // v0.6.2(A)：按 permId 精确决议。老 client 不带 permId → registry.take
        // 降级为该 child 最早一条（FIFO），请求不会被静默丢弃。
        const taken = pendingDecisions.settle(childId, info.permId, answer)
        if (taken && !info.permId) {
          console.log(`product-subagents: 决策未带 permId，按 FIFO 决议 ${taken.permId}（child=${String(childId).slice(0, 8)}）`)
        }
        if (!taken) {
          // v0.6.2(M3)：上面已确认该 child 确有挂起请求（has 判定），走到这里只可能是
          // **permId 对不上**。绝不退到 FIFO：那会把用户对 A 的决策记到 B 上
          // （客户端按钮态在轮询重建，重复点击/迟到的决策都会落到别的请求）。
          console.warn(`product-subagents: 决策 permId=${info.permId} 未命中该 child 的任何挂起请求（${pendingDecisions.list(childId).join(', ')}）→ 忽略，不代替决议其他请求`)
        }
      } else {
        console.warn(`product-subagents: 未知授权决策 ${answer}（child=${String(childId).slice(0, 8)}）`)
      }
    })
  } catch (err) {
    console.warn(`product-subagents: permission-decision 订阅失败: ${err.message}`)
  }
  /**
   * v0.5.0「会话期总是允许」：内存授权，作用域 = 主代理当前会话 parentSessionId
   * （用户确认简化为仅此一个条件，不再叠加工作目录）。用户手动点击产生
   * （非 AI 记忆），主代理会话结束（session/disposed）即清除，不落盘。
   * v0.6.2(D)：状态迁入 createSessionRules——无路径请求改落分类规则
   * （`cat:<product>:<slug>`）而不是空规则；写入键与清理键同构。
   */
  const sessionRules = createSessionRules()
  try {
    ctx.on('session/disposed', (session) => {
      const sid = session && (session.id || (typeof session === 'string' ? session : null))
      if (!sid) return
      // v0.6.2：清理键与 sessionKey 同构（旧实现只匹配 `${sid}::` 前缀，
      // 而写入用的是裸 `${parentSessionId}` → 会话级授权永不清理，随进程泄漏）
      const removed = sessionRules.dispose(sid)
      if (removed > 0) console.log(`product-subagents: 主代理会话 ${String(sid).slice(0, 8)}… 销毁，清除 ${removed} 条会话期授权`)
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

  const permissionHandler = async ({ product, sessionId, description, paths, toolCall }) => {
    // v0.6.2(A)：每次请求一个独立 id——授权球按请求渲染/决议，不再互相覆盖。
    // 优先用产品侧 toolCallId（同一 toolCall 重复询问可对齐），缺失时自增兜底。
    const toolCallId = toolCall && typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.trim()
      ? toolCall.toolCallId.trim() : null
    const permId = pendingDecisions.nextPermId(toolCallId || `${String(product || 'acp')}-anon`)
    // v0.6.2(D)：权限类别指纹（无路径请求的会话期记忆维度）
    const categoryKey = permissionCategoryKey(toolCall, product, description)
    const reqPaths = Array.isArray(paths) ? paths : []
    let resolved = false
    let resolvedChildId = null
    const emitResolved = (payload) => {
      if (!resolvedChildId || resolved) return
      resolved = true
      try {
        ctx.emit?.('product-subagents/permission-resolved', {
          childId: resolvedChildId, product, permId, categoryKey, at: Date.now(), ...payload,
        })
      } catch { /* 通知失败不影响审批 */ }
    }
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
      let bindRemoteSessionId = null
      for (const [cid, record] of bindings.entries()) {
        const remoteId = record && record.remote && (record.remote.sessionId || record.remote.threadId)
        if (remoteId && remoteId === sessionId) {
          childId = cid
          bindCwd = record && record.cwd ? record.cwd : null
          bindParentSessionId = record && record.parentSessionId ? record.parentSessionId : null
          bindRemoteSessionId = remoteId
          resolvedChildId = cid
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
      //     v0.6.2(D)：无路径请求按类别指纹命中。
      if (sessionRules.cover(bindParentSessionId, reqPaths, categoryKey)) {
        console.log(`product-subagents: [ACP ${product}] 命中会话期授权（主代理会话 ${String(bindParentSessionId).slice(0, 8)}…），自动放行`)
        return 'allow'
      }
      // 1.5b 用户落盘白名单（v0.5.0）：手动「总是允许(项目)」的持久授权——
      //     按工作目录 cwd 作用域匹配（同项目内生效，跨会话），命中放行本次。
      const userRules = readUserAllowlist()
      if (bindCwd && userRulesCover(userRules, bindCwd, reqPaths)) {
        console.log(`product-subagents: [ACP ${product}] 命中用户落盘白名单（项目 ${bindCwd}），自动放行`)
        return 'allow'
      }
      // v0.5.5：本轮已被用户拒绝的路径再次请求 → 静默拒绝（不重复弹窗骚扰）
      if (isRoundRejected(childId, reqPaths)) {
        console.warn(`product-subagents: [ACP ${product}] 本轮已拒绝路径再次请求，静默拒绝：${description || '未知操作'}`)
        return 'deny'
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
      // v0.6.2(A)：带 permId——授权球按请求逐条渲染，决策时原样回传。
      try {
        ctx.emit?.('product-subagents/permission-pending', {
          childId,
          permId,
          product,
          description: description || '未知操作',
          paths: reqPaths,
          category: categoryKey,
          cwd: bindCwd,
          parentSessionId: bindParentSessionId,
          remoteSessionId: bindRemoteSessionId,
          at: Date.now(),
        })
      } catch { /* 通知失败不影响审批 */ }
      const buttonAnswer = new Promise((resolve) => {
        pendingDecisions.add(childId, permId, resolve)
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
        // v0.6.2(A)：只作废**本条**按钮通道登记（旧实现 delete(childId) 会把
        // 同一 child 其他并发请求的按钮通道一并抹掉 → 那些请求只能等弹窗）
        pendingDecisions.take(childId, permId)
        outcome = winner.outcome
      } else {
        button = winner.answer
        ac.abort() // 授权球已决，取消弹窗通道（approvalOutcome 以 cancelled 结束，忽略）
        // 按钮通道已由 settle() 摘除本条登记，此处不得再整槽清空
      }
      // 按钮通道处理（v0.5.0）：
      //   allow-session → 会话期授权（内存，按主代理会话，不落盘）
      //   allow-always  → 总是允许（落盘 allowlist.json，按 cwd 项目作用域）
      //   allow-once    → 仅本次；deny → 拒绝
      if (button !== null) {
        let btnOutcome = 'rejected'
        if (button === 'allow-session') {
          // v0.6.2(D)：无路径请求不再写空规则（旧写法读侧永不命中＝点了等于没点），
          // 改落类别指纹；两者都没有时退回"仅本次"，不虚报"已记住"。
          const stored = sessionRules.add(bindParentSessionId, reqPaths, categoryKey)
          if (stored.ok) {
            btnOutcome = 'granted-session'
            console.log(`product-subagents: [ACP ${product}] 授权球：会话期总是允许（主代理会话 ${String(bindParentSessionId || '').slice(0, 8)}…，${stored.kind === 'category' ? `类别 ${stored.rule[0]}` : `${stored.rule.length} 路径（含父目录）`}，内存态）`)
          } else {
            btnOutcome = 'allowed-once'
            // v0.6.2(m5)：执行类（bash/exec…）无路径请求**故意不记**——记住一次
            // 等于本会话内任意命令放行，风险远大于少弹一次窗的收益。
            console.warn(`product-subagents: [ACP ${product}] 授权球：会话期无法记忆（${stored.reason === 'execution-class' ? `执行类请求 ${categoryKey || ''} 不允许按类别记忆` : '既无路径也归不出类别'}）→ 仅本次放行`)
          }
        } else if (button === 'allow-always') {
          const saved = appendUserRule({ cwd: bindCwd, product, paths: reqPaths, grantedAt: new Date().toISOString() })
          if (saved.ok) {
            btnOutcome = 'granted-always'
            console.log(`product-subagents: [ACP ${product}] 用户点击总是允许 → 已落盘（项目 ${bindCwd}，${reqPaths.length} 路径）`)
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
        emitResolved({ outcome: btnOutcome })
        // v0.5.5：记录本轮拒绝（同回合同路径不再弹窗）
        if (button === 'deny') addRoundRejected(childId, reqPaths)
        // v0.5.1：统一返回 'allow'（allow_once）——会话/项目记忆由本层判定掌控，
        // 绝不让 deveco 端 allow_always 持久记忆（会绕过作用域，跨会话跨项目放行）。
        if (button === 'allow-session' || button === 'allow-always' || button === 'allow-once') return 'allow'
        return 'deny'
      }
      // 弹窗通道结果映射（宿主词表：allowed-once / rejected / cancelled / unavailable）
      emitResolved({ outcome })
      if (outcome === 'allowed-once') {
        console.log(`product-subagents: [ACP ${product}] 用户已批准权限请求：${description}`)
        return 'allow'
      }
      if (outcome === 'rejected') {
        console.log(`product-subagents: [ACP ${product}] 用户已拒绝权限请求：${description}`)
        addRoundRejected(childId, reqPaths)
        return 'deny'
      }
      console.warn(`product-subagents: [ACP ${product}] 权限请求无有效审批结果(${outcome})，按拒绝处理：${description}`)
      return 'deny'
    } catch (error) {
      // 审批通道本身异常（无 open turn 等）→ fail-closed 拒绝，绝不放行
      console.warn(`product-subagents: 权限审批异常，按拒绝处理: ${error && error.message ? error.message : error}`)
      // v0.6.2(A)：决议兜底——不广播 resolved 会在授权球留下一条永不消失的幽灵请求，
      // 并让该 child 的按钮通道登记永久占位（看门狗据此一直豁免回收）。
      // v0.6.2(M1)：这里必须 **settle**（摘表 + 兑现 resolve），`take` 只摘不兑现——
      // 抛错发生在 approval.request（:312）时 Promise.race 还没订阅 buttonAnswer，
      // 只摘表会让那个 await 永远悬着（ACP 侧 requestPermission 挂死等一个不会来的
      // 决议）。按 fail-closed 一致性兑现 'deny'：handler 本就以 'deny' 收尾。
      if (resolvedChildId) pendingDecisions.settle(resolvedChildId, permId, 'deny')
      emitResolved({ outcome: 'error' })
      return 'deny'
    }
  }
  /**
   * v0.6.0：configOptions 透出（child 级）。ACP 没有"可用模型清单"接口，会话
   * 建立 / set_config_option 响应 / config_option_update 通知是三个快照来源；
   * 三者都经桥接层回调走到这里，统一补齐 childId 后发冻结契约事件
   * `product-subagents/config-options`。事件失败绝不影响桥接与子代理回合。
   */
  const childIdForRemoteSession = (remoteSessionId) => {
    if (!remoteSessionId) return null
    for (const [cid, rec] of bindings.entries()) {
      const rid = rec && rec.remote && (rec.remote.sessionId || rec.remote.threadId)
      if (rid && rid === remoteSessionId) return cid
    }
    return null
  }
  const emitConfigOptions = ({ childId, product, remoteSessionId, configOptions }) => {
    try {
      ctx.emit?.('product-subagents/config-options', {
        childId: childId ?? null,
        product: product ?? null,
        remoteSessionId: remoteSessionId ?? null,
        configOptions: Array.isArray(configOptions) ? configOptions : [],
        at: Date.now(),
      })
    } catch { /* 事件总线故障不影响子代理 */ }
  }
  /** 会话建立/恢复后的首次透出（只有 ACP 远端有 configOptions）。 */
  const emitBoundConfigOptions = (childId, record) => {
    const remote = record && record.remote
    if (!remote || remote.kind !== 'acp') return
    emitConfigOptions({
      childId,
      product: record.product,
      remoteSessionId: remote.sessionId,
      configOptions: remote.configOptions,
    })
  }
  const onConfigOptions = ({ product, remoteSessionId, configOptions }) => {
    emitConfigOptions({
      childId: childIdForRemoteSession(remoteSessionId),
      product,
      remoteSessionId,
      configOptions,
    })
  }
  const onConfigError = ({ product, remoteSessionId, kind, requested, optionId, effective, available, reason, error, configOptions }) => {
    // 请求的 model/effort 没被应用（已回退到产品默认）：编排层据此回答"填了 X 为什么没生效"。
    try {
      ctx.emit?.('product-subagents/config-option-error', {
        childId: childIdForRemoteSession(remoteSessionId) ?? null,
        product: product ?? null,
        remoteSessionId: remoteSessionId ?? null,
        kind,
        requested: requested ?? null,
        optionId: optionId ?? null,
        effective: effective ?? null,
        available: Array.isArray(available) ? available : [],
        reason: reason ?? null,
        error: error ?? null,
        configOptions: Array.isArray(configOptions) ? configOptions : [],
        at: Date.now(),
      })
    } catch { /* 事件总线故障不影响桥接 */ }
  }
  const bridges = Object.fromEntries(
    Object.entries(providers)
      .filter(([name]) => availability[name].registered)
      .map(([name, def]) => [name, createBridgeFor(def, { permissionHandler, isHumanWaitPending, onConfigOptions, onConfigError })]),
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
  // v0.5.3(C)：已关闭子代理集合——child-closed 事件标记的 childId 不允许 reconnect。
  const closedChildren = new Set()
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
        // v0.5.5：权限等待人类决策期间豁免空闲回收（静默等待 ≠ 空闲）——
        // 若仍挂起则重排回收，直到决策落定或子代理关闭。
        const remoteId = record.remote && (record.remote.sessionId || record.remote.threadId)
        const pending = remoteId && isHumanWaitPending(remoteId)
        if (pending) {
          console.log(`product-subagents: 空闲回收推迟——child ${String(childId).slice(0, 8)}… 有权限请求等待人类决策`)
          scheduleDispose(childId)
          return
        }
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
      //
      // `agentOptions` (dsh 0.2.x: a required SubagentCapabilities member) is
      // honestly false: host-level provider/model/reasoningEffort overrides
      // cannot apply to an external product CLI, whose model and effort are
      // chosen by the role and the product's own config options. Declaring it
      // false makes such a one-shot request fail loud (UNSUPPORTED_CAPABILITY)
      // instead of being silently dropped. Continuable children are composed
      // by the continuation manager and never consult this flag.
      capabilities: { agentOptions: false, persona: true, toolFilter: true },
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
        // 会话刚建立 → 立刻透出该 child 的可用模型/档位（此时才拿得到 childId）
        emitBoundConfigOptions(request.sessionId, bindings.get(request.sessionId))
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
    closedChildren, // v0.5.3(C)：reconnect 守卫
    clearRoundRejected, // v0.5.5：回合级拒绝记忆清理
    emitBoundConfigOptions, // v0.6.0：恢复路径绑定后透出 configOptions
    submitFailureGrades: cfg.submitFailureGrades, // v0.7.3：提交失败分级覆盖（lib/submit-failure.js）
    // v0.7.4：换档交接模式 / 等待上限（随 submit-failed 事件下发给编排层）。
    // 默认 notify-then-auto：发唤醒信号等主代理 agent_failover，超时由编排层自动换档。
    failoverMode: FAILOVER_MODES.has(cfg.failoverMode) ? cfg.failoverMode : 'notify-then-auto',
    notifyWaitMs: Number.isFinite(cfg.notifyWaitMs) && cfg.notifyWaitMs > 0 ? cfg.notifyWaitMs : 90000,
  }

  registerProductSubmit(ctx, deps)
  registerProductDelegate(ctx, deps)
  registerProductRoles(ctx, deps)
  registerSubagentProgress(ctx, deps)
  registerProductWait(ctx, deps)
  registerProductAgents(ctx, deps)

  // ── provider 级模型/effort 目录（v0.6.0） ──────────────────────────────────
  // ACP 拿不到"无会话清单"，所以这里用一条建完就弃的会话探测一次，把结果落盘
  // 成跨插件数据面（$DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json）：
  // 编排层选中产品即可填下拉，不必先建 child。探测**不传** permissionHandler
  // （否则会走宿主交互审批、产生 permission-pending 噪声并 fail-closed）。
  // 路径固定为 $DSH_HOME/data/dsh-plugin-product-subagents/：消费方按同一路径硬编码
  // 读取，所以这里不提供目录覆盖，配了也只提示一次、绝不静默分叉。
  if (cfg.providerCatalogDir) {
    console.warn('product-subagents: providerCatalogDir 已不再支持（provider-catalog.json 是跨插件契约，路径固定）；忽略该配置')
  }
  const catalog = createProviderCatalog()
  const acpCatalogNames = Object.keys(providers).filter(
    (name) => providers[name].type === 'acp' && availability[name] && availability[name].registered,
  )
  const prober = createProviderProber({
    catalog,
    providers,
    defaultNames: acpCatalogNames,
    ttlMs: Number(cfg.providerCatalogTtlMs) || DEFAULT_TTL_MS,
    timeoutMs: Number(cfg.providerProbeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS,
    onUpdated: ({ providers: written }) => {
      // 每次缓存写完后发（失败也发：消费方读该条目的 error 字段）
      try { ctx.emit?.('product-subagents/provider-catalog-updated', { providers: written, at: Date.now() }) } catch { /* 忽略 */ }
    },
  })
  const requestProbe = (names, { cwd, reason } = {}) => prober
    .probe(names, { cwd, reason })
    .catch((error) => {
      console.warn(`product-subagents: provider 目录探测失败（不影响委派链路）: ${error && error.message ? error.message : error}`)
    })
  try {
    ctx.on('product-subagents/probe-provider', (payload) => {
      const provider = payload && typeof payload.provider === 'string' && payload.provider ? payload.provider : null
      const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined
      void requestProbe(provider ? [provider] : null, { cwd, reason: (payload && payload.reason) || 'request' })
    })
  } catch (err) {
    console.warn(`product-subagents: probe-provider 订阅失败: ${err.message}`)
  }
  // 启动异步探测（不阻塞 apply）：只探缺失/过期（TTL 默认 24h）的 provider，
  // 单个 provider 超时即写 error 条目、不重试，缓存命中时不会拉起任何进程。
  if (cfg.providerProbeOnStart !== false) {
    const stale = prober.staleNames(acpCatalogNames)
    if (stale.length > 0) setTimeout(() => { void requestProbe(stale, { reason: 'startup' }) }, 0)
  }

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
      clearRoundRejected(info.id) // v0.5.5：回合结束，本轮拒绝记忆失效（新一轮可问）
      // v0.6.2(M2)：回合结束而审批仍未决（用户直接关掉子代理会话/产品中止）→
      // 兑现为 deny 并清空。不清的话 isHumanWaitPending 永远命中，该 ACP 会话
      // 从此**永久豁免**看门狗无输出判定与空闲回收（lib/bridges/acp.js 的 watchdog、
      // 本文件 scheduleDispose 两个消费点），进程/会话泄漏到插件卸载为止。
      const stale = settleAllPending(info.id, 'deny')
      if (stale.length > 0) {
        console.warn(`product-subagents: child ${String(info.id).slice(0, 8)}… 回合结束时尚有 ${stale.length} 条权限请求未决 → 按拒绝兑现（${stale.join(', ')}）`)
      }
      if (bindings.has(info.id)) scheduleDispose(info.id)
      state.activeChildren = Math.max(0, state.activeChildren - 1)
    }
  })

  // v0.5.3(A)：agent-dispatch close → 立即 dispose 远程（不等待 idleTimeoutMs）。
  // 事件 payload: { childId, immediate: true }。close = 明确不再复用 → 立即终止
  // 远程 ACP 进程/会话。不可达时回退：至少 subagent/end 的 scheduleDispose 路径保留。
  ctx.on('product-subagents/child-closed', (payload) => {
    const childId = payload && payload.childId
    if (!childId) return
    closedChildren.add(childId)
    const record = bindings.get(childId)
    if (!record) return
    cancelDispose(childId)
    record.bridge.dispose(record.remote).catch(() => {})
    bindings.delete(childId)
    console.log(`product-subagents: child-closed 立即释放远程会话（childId=${String(childId).slice(0, 8)}…）`)
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
