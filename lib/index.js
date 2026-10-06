import { bindings, MARKER, recoverRemoteSessionId } from './bindings.js'
import { detectAvailability } from './availability.js'
import { validateConfig } from './config.js'
import { foldProgress, foldTrace, foldTokenUsage } from './progress.js'
import { buildProviders, createBridgeFor } from './providers.js'
import { evaluateRuleSources, inferredDirs, planGrantWrites, suggestedDirs, workspaceRuleOf } from './permission-rules.js'
import { scanPathsLoose } from './bridges/acp.js'
import { createPendingRegistry, createSessionRules, permissionCategoryKey, resolveToolName } from './permission-state.js'
import { dangerousExecuteMatch } from './dangerous-commands.js'
import { readUserAllowlist, appendUserRule } from './user-allowlist.js'
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
  /**
   * v0.7.9 缺口A：决策载荷里**用户给定**的目录集（dispatch 弹框可编辑的 `paths`）。
   *
   * 为什么是一张旁挂表而不是把 `{answer, paths}` 一起塞进 settle：settle 的兑现值
   * 就是决议字符串（`'allow-session'` …），宿主/测试/`settleAllPending`/看门狗豁免
   * 全都按它比对，改形状等于把既有契约整体改掉。
   *
   * 生命周期：只在「本条决议确实命中了一个挂起请求」时登记（permId 对不上 ⇒
   * 不登记，不留残渣），消费即删（`takeDecisionPaths`）。弹窗通道先答的请求根本
   * 不会有登记（那时 settle 返回 null），所以这张表不会随会话增长。
   *
   * v0.7.9（复审 M-5，已知且有界的残渣）：主路径上登记与消费成对出现——决议兑现
   * 后 `permissionHandler` 一定走到 `planGrantWrites(takeDecisionPaths(...))`。唯一
   * 会留下条目的情形是「登记之后、消费之前进程被整体打断」（请求 Promise 的续体不再
   * 运行），此时键里的 permId 已经单调递增过去、**永不可能再被读到**（`permId` 由
   * 产品侧 toolCallId + 自增序号生成，不复用），所以它既不会被别的请求消费、也不
   * 承担任何授权语义——是内存里一条不可达的 `unknown[]`，无可利用性。进程结束即消失。
   * 不复用/不续期 permId 是本条结论的前提，改成复用序号就必须在这里补一次按 childId
   * 的清扫。
   *
   * 这里**不做校验**：客户端送来什么原样存着，校验与「写哪一档」的判定统一收口到
   * `lib/permission-rules.js` 的 `planGrantWrites`（不可盲信客户端）。
   */
  const decisionPaths = new Map() // `${childId}\u0000${permId}` -> unknown[]（未校验）
  const decisionPathsKey = (childId, permId) => `${String(childId)}\u0000${String(permId)}`
  /** 取回并清除本条决议附带的目录；未给 ⇒ null（区别于给了空数组） */
  const takeDecisionPaths = (childId, permId) => {
    const key = decisionPathsKey(childId, permId)
    const raw = decisionPaths.has(key) ? decisionPaths.get(key) : null
    decisionPaths.delete(key)
    return raw
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
        // v0.7.9 缺口A：决策可附带**用户给定**的目录集（dispatch 弹框里编辑过的 paths）。
        // 登记在 `taken.permId` 上——FIFO 降级时它可能与 info.permId 不同，决议落在哪条
        // 目录就跟着哪条走。未命中（permId 对不上）时不登记。
        if (taken && Array.isArray(info.paths)) {
          decisionPaths.set(decisionPathsKey(childId, taken.permId), info.paths)
        }
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
  const missingParentSessionIdWarned = new Set()

  const permissionHandler = async ({ product, sessionId, description, paths, toolCall }) => {
    // v0.6.2(A)：每次请求一个独立 id——授权球按请求渲染/决议，不再互相覆盖。
    // 优先用产品侧 toolCallId（同一 toolCall 重复询问可对齐），缺失时自增兜底。
    const toolCallId = toolCall && typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.trim()
      ? toolCall.toolCallId.trim() : null
    const permId = pendingDecisions.nextPermId(toolCallId || `${String(product || 'acp')}-anon`)
    // v0.6.2(D)：权限类别指纹（无路径请求的会话期记忆维度）
    const categoryKey = permissionCategoryKey(toolCall, product, description)
    // v0.7.8：三级降级工具名解析（L1→L2→L3）。
    // L1：优先从 name/toolName 提取真实工具名；次从 _meta.<product>.toolName 提取
    //     （v0.7.9：qoder 的真名在这里，title 是整条命令正文）；末从 title 提取，但仅限
    //     TOOL_NAME_SLUGS 收录的 slug（bash/edit/webfetch 等具工具语义）。
    //     title 为 external_directory/doom_loop 等权限范围/保护机制时，
    //     不具备工具粒度，不得作为工具名授权键。
    // L2：L1 解析不出工具名时，退化为路径级会话规则（只放行该目录及其子路径）。
    // L3：L1+L2 都解析不出（无工具名且无路径），不写入任何会话级授权。
    // m-1：来源与取值同源——resolveToolName 返回 {value, source}，直接取命中分支
    // 打出的 source，不再用 `toolCall.name || toolCall.toolName` 反推（会把
    // "name 被占位过滤、实际靠 title 命中"错标成 name/toolName）。
    // v0.7.9：传入 product，`_meta` 命名空间与授权键（addToolGrant 的
    // `${productSlug}:${normalized}`）共用同一个 product，不在库内另造产品标识。
    const toolNameResolved = resolveToolName(toolCall, product)
    const toolName = toolNameResolved ? toolNameResolved.value : null
    const toolNameSource = toolNameResolved ? toolNameResolved.source : null
    // rawToolName：原始工具名/标题（供 permission-pending 事件展示，不用于授权判定）
    let rawToolName = null
    if (toolCall && typeof toolCall === 'object') {
      const raw = toolCall.name || toolCall.toolName || toolCall.title
      if (typeof raw === 'string' && raw.trim()) rawToolName = raw.trim()
    }
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
      // v0.7.9 追加2/3：危险命令例外门**先于一切规则/放行决定**。
      // `rm -rf` / `npm publish` / `git push` 即使命中 provider 白名单、工作区默认规则、
      // 会话期路径记忆、会话期工具名授权、用户落盘规则，也必须走交互询问。
      // 规则清单是单点常量 `lib/dangerous-commands.js` 的 RULES——要收窄成"只拦 git push"
      // 就删掉那两条，判定顺序与分词逻辑都不用动。
      const danger = dangerousExecuteMatch(toolCall)
      if (danger) {
        console.log(`product-subagents: [ACP ${product}] 危险命令门命中（${danger.rule}，命令正文取自 ${danger.source}），本次不因任何规则放行（provider 白名单/工作区默认/会话期/落盘一律关闭）`)
      }
      // 0. provider 白名单（v0.4.0）：请求路径全部命中 provider.allowWritePaths →
      //    直接授权（可读可写）不弹窗，返回 'allow-always'（acp.js 优先选
      //    allow_always——ACP 服务端记住授权，后续同类请求不再询问）。
      //    v0.7.9：判定改喂**同一个** evaluateRuleSources（规则形状 {cwd:null, paths}
      //    = 无项目作用域 ⇒ cwd 通配），与下面的会话/落盘/工作区三档共用一套子树语义。
      const providerCfg = providers[product] || providers[String(product).replace(/-cli$/, '')]
      const allowRules = providerCfg && Array.isArray(providerCfg.allowWritePaths) ? providerCfg.allowWritePaths : []
      if (!danger && allowRules.length > 0 && reqPaths.length > 0) {
        const v = evaluateRuleSources(
          [{ tier: 'provider', rules: [{ cwd: null, paths: allowRules, tools: [] }] }],
          { cwd: null, paths: reqPaths },
        )
        if (v.allowed) {
          console.log(`product-subagents: [ACP ${product}] 白名单自动授权读写（${v.covered.length} 路径，不弹窗）`)
          return 'allow-always'
        }
        if (v.uncovered.length > 0 && v.covered.length === 0) {
          // v0.7.9 文案保真：这里只是 provider 白名单维度的判定，**不 return**。
          // 后面还有工作区默认规则、会话期路径/类别、工具名、用户落盘白名单，都可能免弹。
          // 旧文案「转交互审批」在工具名预检命中时会打出一条与事实相反的日志
          // （实测正是它把 0.7.8 的排障方向带偏成"预检顺序不对"）。
          console.log(`product-subagents: [ACP ${product}] 权限请求不在 provider 白名单（${v.uncovered.join(', ')}），继续走会话期/交互判定`)
        } else if (v.uncovered.length > 0) {
          console.log(`product-subagents: [ACP ${product}] 权限请求部分越权（白名单内 ${v.covered.length} + 外 ${v.uncovered.length}），继续走会话期/交互判定`)
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
      // 1.5 v0.7.9 追加1「统一模型」：三个规则来源喂**同一个** evaluateRuleSources，
      //     命中任一档即免弹（规则形状统一为 {cwd, paths[], tools[]}）：
      //       · session  —— 内存会话规则（用户点过「会话内允许」，含工具名档）
      //       · disk     —— 落盘 allowlist.json（跨会话、按 cwd 项目作用域）
      //       · workspace—— 工作区默认规则 paths=[cwd]：**自动、无需用户授权**，
      //                     请求路径全部落在本 child 工作目录子树内即放行。
      //     这是本轮明示的**行为放宽**（对标 DSH `workspace-write` 沙箱语义：
      //     工作区内可写，工作区外才需要问），写在 CHANGELOG 的"行为放宽"一节。
      //     danger 命中时整档关闭：三条危险命令即使路径在工作区内、即使工具名已授权，
      //     也必须走交互询问。
      const ruleSources = []
      if (!danger && bindParentSessionId) ruleSources.push({ tier: 'session', rules: sessionRules.rulesOf(bindParentSessionId) })
      if (!danger && bindCwd) {
        ruleSources.push({ tier: 'disk', rules: readUserAllowlist() })
        ruleSources.push({ tier: 'workspace', rules: workspaceRuleOf(bindCwd) })
      }
      const ruleVerdict = danger
        ? { allowed: false, tier: null, via: null, covered: [], uncovered: reqPaths }
        : evaluateRuleSources(ruleSources, { product, toolName, cwd: bindCwd, paths: reqPaths, categoryKey })
      if (ruleVerdict.allowed) {
        const sid8 = String(bindParentSessionId || '').slice(0, 8)
        if (ruleVerdict.tier === 'session' && ruleVerdict.via === 'tools') {
          // v0.7.5：会话级工具名授权——同一主代理会话内已授权过的工具名（不区分路径）
          // 直接放行，不进 Promise.race；toolName 缺失时不命中（退化为现有行为）。
          console.log(`product-subagents: [ACP ${product}] 命中会话期工具名授权（${toolName}，主代理会话 ${sid8}…），自动放行`)
        } else if (ruleVerdict.tier === 'session') {
          console.log(`product-subagents: [ACP ${product}] 命中会话期授权（主代理会话 ${sid8}…，${ruleVerdict.via === 'category' ? '类别指纹' : `${ruleVerdict.covered.length} 路径（目录子树）`}），自动放行`)
        } else if (ruleVerdict.tier === 'disk') {
          console.log(`product-subagents: [ACP ${product}] 命中用户落盘白名单（项目 ${bindCwd}，${ruleVerdict.via === 'tools' ? `工具名档 ${toolName}` : `${ruleVerdict.covered.length} 路径（目录子树）`}），自动放行`)
        } else {
          console.log(`product-subagents: [ACP ${product}] 命中工作区默认规则（工作区内 ${ruleVerdict.covered.length} 路径，cwd=${bindCwd}），自动放行`)
        }
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
      // v0.7.9 缺口B + 缺口D 修正：弹框是「每行一个路径」的**可编辑文本框**（用户定稿：
      // **没有勾选框**），预填 = suggestedDirs 后接 inferredDirs，用户手动改行/删行——
      // 删一行即去掉该项，也可以把某行改成更上层的目录。两个字段分开是为了**日志归因**
      // 和下面那条「`paths` 缺省 ⇒ 自动分析只用结构化」的规则，不是为了区分勾选状态：
      //   suggestedDirs = 本次请求**实际触达**的目录，只来自**结构化**来源
      //     （diff 块 `content[].path`、`rawInput.file_path`/`rawInput.path`、
      //      `locations[].path`，以及 `kind==='execute'` 时 `rawInput.command` 里的路径）；
      //   inferredDirs = 从命令/正文**文本推测**出的目录（`scanPathsLoose` 的产物，
      //     已排除 suggestedDirs 里的项，所以两档拼接不会重复）。
      //   为什么正文推测项要排在后面、且不并进上一档：正文是被编辑的**内容**，
      //   仓库里谁都能写 `/etc/passwd`、`~/.ssh`、`~/.qoder/settings.json`；把它们与
      //   实际触达项混成一档，用户就没法从数据上看出哪些行值得删。
      // 两个字段都**不参与自动规则**：`paths` 缺省时规则只用 `reqPaths`
      // （= `extractPaths` 的结构化结果，见上面 1.5 的统一评估与下面 `planGrantWrites`
      // 的 `autoPaths`）；用户改过/删过的行经决议载荷的 `paths` 通道回传，那是**显式**
      // 授权，仍要过 `validateDeclaredPaths` 服务端校验（绝对路径、拒 `/`、非法丢弃）。
      // **新增字段**：既有 `paths` 的语义（本次请求的结构化路径原文）一字未改，
      // 老消费方不受影响。
      try {
        const suggestedDirsForUI = suggestedDirs(reqPaths)
        // 推测档单独兜一次异常：文本扫描出任何岔子都不许拖垮 permission-pending 事件本身
        // （事件是审批通道，预填是附赠品）。
        let inferredDirsForUI = []
        try {
          inferredDirsForUI = inferredDirs(scanPathsLoose(toolCall), suggestedDirsForUI)
        } catch { /* 推测档失败不影响审批 */ }
        ctx.emit?.('product-subagents/permission-pending', {
          childId,
          permId,
          product,
          description: description || '未知操作',
          paths: reqPaths,
          suggestedDirs: suggestedDirsForUI,
          inferredDirs: inferredDirsForUI,
          category: categoryKey,
          toolName,
          toolNameSource,
          rawToolName,
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
      //
      // v0.7.9 缺口A：写哪一档由 `planGrantWrites` **单点**决定（paths 与 tools 互斥）：
      //   · 客户端没给 paths            → legacy：路径档 + 工具档照旧同写（行为逐字节不变）
      //   · 给了且最终目录集非空        → paths ：只写路径档，工具档一条都不写
      //   · 给了且为空（[] 或全非法）   → tools ：只写工具档，路径档一条都不写
      // 两个布尔量就是这三条出口的唯一投影——下面 allow-session / allow-always 都只按它
      // 分支，不再各自判断，避免两处逻辑对同一份语义给出不同答案。
      const plan = planGrantWrites(takeDecisionPaths(childId, permId), reqPaths, { product, toolName })
      const writePathTier = plan.mode !== 'tools'
      const writeToolTier = plan.mode !== 'paths'
      // 档位日志（用户要求：打出走了哪一档 + 最终实际写入的规则集原样 + 来源归因）
      if (button === 'allow-session' || button === 'allow-always') {
        const tierNote = plan.mode === 'legacy'
          ? '档位=自动分析（客户端未给定 paths，路径档与工具档同写）'
          : plan.mode === 'paths'
            ? `档位=paths 来源=用户给定 规则=${JSON.stringify(plan.paths)}（工具档不写：与 paths 互斥）`
            : `档位=tools 来源=用户给定空集 规则=[] 工具档=${plan.toolKey || '(工具名解析不出来 ⇒ 实际什么都没写)'}`
        const droppedNote = plan.dropped.length > 0
          ? `；服务端丢弃非法条目 ${plan.dropped.length} 条：${plan.dropped.map((d) => `${d.reason}(${d.value})`).join(' ')}`
          : ''
        console.log(`product-subagents: [ACP ${product}] 授权写入判定点 → ${tierNote}${droppedNote}`)
      }
      if (button !== null) {
        let btnOutcome = 'rejected'
        if (button === 'allow-session') {
          // v0.7.8 L1/L2/L3 三级降级：
          // L1（toolName 非空）→ 写入工具名授权 + 路径/类别规则（类别规则有工具语义约束）
          // L2（toolName=null 但 reqPaths 非空）→ 只写路径级规则，不写类别规则也不写工具名授权
          //     （toolName=null 时类别规则语义过宽：external_directory 等授权等于任意工作区外路径放行）
          // L3（toolName=null 且 reqPaths 空）→ 不写任何会话级授权，仅本次放行
          const effectiveCategoryKey = toolName ? categoryKey : null
          // v0.7.9 缺口A：tools 档不写路径；paths 档写入的是**用户给定目录原集**，
          // 且 expand=false（不做「文件取父目录」展开——声明的已是目录，再升一级
          // 会把 /tmp/newproj 放大成 /tmp）。
          const stored = writePathTier
            ? sessionRules.add(bindParentSessionId, plan.paths, effectiveCategoryKey, bindCwd, { expand: plan.expand })
            : { ok: false, rule: null, kind: 'none', reason: 'plan-tools-only' }
          // M-2：`addToolGrant` 的布尔只回答「这次有没有写进一条**新**条目」——重复
          // 点击（qoder 式同一请求连发多条、用户对每条各点一次）时它返回 false，而授权
          // 其实早已在会话里生效。直接吃这个布尔会把「已存在」误判成「什么都没写」：
          // 既会落下面的 L3 分支、打出与事实相反的「未能解析出工具名」，又会把
          // btnOutcome 从 granted-session 降成 allowed-once（消费方看到的本轮结果失真）。
          // 故先取「点击前是否已授权」，再合并成「本次结束时该授权是否生效」的判定。
          const grantPreexisting = writeToolTier && toolName && bindParentSessionId
            ? sessionRules.toolGrantCovers(bindParentSessionId, product, toolName, bindCwd) : false
          const grantWritten = writeToolTier && toolName && bindParentSessionId
            ? sessionRules.addToolGrant(bindParentSessionId, product, toolName, bindCwd) : false
          const toolGranted = grantWritten || grantPreexisting
          // 首次授权时插空串（文案与 M-2 之前逐字节一致），只有重复点击才追加说明。
          const repeatGrantNote = grantWritten ? '' : '（该会话此前已存在同名工具授权，本次未重复写入）'
          // v0.7.9：paths 档下工具名授权是**按互斥铁律刻意不写**的，不能报「无处可写」。
          if (writeToolTier && toolName && !bindParentSessionId && !missingParentSessionIdWarned.has(childId)) {
            missingParentSessionIdWarned.add(childId)
            console.warn(`product-subagents: [ACP ${product}] 缺少主代理会话 id，本次工具名授权(${toolName})未写入会话级记忆——后续同名工具仍将弹窗`)
          }
          if (stored.ok) {
            btnOutcome = 'granted-session'
            const pathLabel = plan.source === 'user' ? `${stored.rule.length} 路径（用户给定目录子树）` : `${stored.rule.length} 路径（含父目录）`
            console.log(`product-subagents: [ACP ${product}] 授权球：会话期总是允许（主代理会话 ${String(bindParentSessionId || '').slice(0, 8)}…，${stored.kind === 'category' ? `类别 ${stored.rule[0]}` : pathLabel}，内存态${toolGranted ? `；工具名 ${toolName}(${toolNameSource})` : ''}）`)
          } else if (toolGranted) {
            btnOutcome = 'granted-session'
            const memoryFailNote = plan.mode === 'tools'
              ? '用户在弹框里清空了目录，按互斥铁律本轮只写工具档'
              : stored.reason === 'execution-class' ? `执行类请求 ${categoryKey || ''}` : '既无路径也归不出类别'
            console.log(`product-subagents: [ACP ${product}] 授权球：会话期工具名授权（${toolName}(${toolNameSource})，主代理会话 ${String(bindParentSessionId || '').slice(0, 8)}…）${repeatGrantNote}——路径/类别无法记忆（${memoryFailNote}），但同会话内同名工具自动放行`)
          } else if (plan.paths.length > 0) {
            // v0.7.8 L2 路径写入失败（此前误标为 L3）：L1 解析不出工具名，走到 L2 的
            // 路径级写入，但 sessionRules.add 仍拒绝了写入（reqPaths 非空却写不出规则，
            // 不该发生）。路径本身存在说明请求有约束客体，可既然什么会话级记忆都没
            // 落下，安全起见仍只放行本次——与 L3 的区别：L3 是无路径可写，这里是写了没写成。
            btnOutcome = 'allowed-once'
            // M-2 文案保真：「未能解析出工具名」只能在 toolName 真的为 null 时说。
            // （措辞留意：既有测试按「缺少主代理会话 id」子串统计那条专用 warn 的条数，
            // 这里的替代表述不要复用该子串，否则会被误计数。）
            const grantFailNote = toolName
              ? `工具名已解析为 ${toolName}(${toolNameSource})，但无处可写（主代理会话 id 不可用或本次写入被拒）`
              : `未能解析出工具名（title=${toolCall?.title || '(无)'}，不在 TOOL_NAME_SLUGS）`
            console.warn(`product-subagents: [ACP ${product}] 授权球：${grantFailNote}，路径/类别记忆也失败（${stored.reason || '未知'}）→ 仅本次放行`)
          } else {
            // v0.7.8 L3：既无工具名也无路径 → 不写入任何会话级授权
            btnOutcome = 'allowed-once'
            const titleInfo = toolCall?.title ? `title=${toolCall.title}` : '无 title'
            // M-2 文案保真：同上——工具名解析得出来却没处可写，不是「解析不出」。
            const l3Cause = toolName
              ? `工具名已解析为 ${toolName}(${toolNameSource})，但无处可写（主代理会话 id 不可用或本次写入被拒）`
              : `未能解析出工具名（${titleInfo}，不在 TOOL_NAME_SLUGS）且无路径`
            console.warn(`product-subagents: [ACP ${product}] 授权球：${l3Cause} → 未能写入会话级记忆，本次未写入任何授权`)
          }
        } else if (button === 'allow-always') {
          // v0.7.9 缺口A：落盘写什么同样只由 `plan` 决定。
          //   legacy → 与改动前逐字节一致（paths = 自动分析结果，不带 note）
          //   paths  → 落用户给定的那组目录，并写明来源（老形状的 note 维度）
          //   tools  → 目录被清空 ⇒ 落**工具档**（`tools: ["<product>:<toolName>"]`，
          //            readUserAllowlist / evaluateRuleSources 早支持这一维）；
          //            连工具名都解析不出来时什么都不能落（appendUserRule 自身会拒空规则）。
          const grantedAt = new Date().toISOString()
          let diskRule
          if (plan.mode === 'tools') {
            diskRule = plan.toolKey
              ? { cwd: bindCwd, product, tools: [plan.toolKey], grantedAt, note: '用户在授权弹框里清空目录，按 paths/tools 互斥规则落盘为工具档（项目内）' }
              : null
          } else {
            diskRule = { cwd: bindCwd, product, paths: plan.paths, grantedAt }
            if (plan.mode === 'paths') diskRule.note = '用户在授权界面点击总是允许（项目内，目录由用户给定）'
          }
          const saved = diskRule ? appendUserRule(diskRule) : { ok: false, error: '用户清空了目录且未解析出工具名 ⇒ 既无路径档也无工具档可落盘' }
          // v0.7.8：allow-always 同样走 L1/L2/L3——工具名授权只在 L1 命中时写入
          // M-2：与 allow-session 同理，「写了新条目」与「此前已授权」必须分开，
          // 否则重复点击会打出「已写入」（本次其实没写）或反过来什么都不提。
          const grantPreexisting = writeToolTier && toolName && bindParentSessionId
            ? sessionRules.toolGrantCovers(bindParentSessionId, product, toolName, bindCwd) : false
          const grantWritten = writeToolTier && toolName && bindParentSessionId
            ? sessionRules.addToolGrant(bindParentSessionId, product, toolName, bindCwd) : false
          const toolGranted = grantWritten || grantPreexisting
          if (writeToolTier && toolName && !bindParentSessionId && !missingParentSessionIdWarned.has(childId)) {
            missingParentSessionIdWarned.add(childId)
            console.warn(`product-subagents: [ACP ${product}] 缺少主代理会话 id，本次工具名授权(${toolName})未写入会话级记忆——后续同名工具仍将弹窗`)
          }
          if (saved.ok) {
            btnOutcome = 'granted-always'
            const savedNote = diskRule && Array.isArray(diskRule.tools) && diskRule.tools.length > 0
              ? `工具档 ${diskRule.tools.join(', ')}`
              : `${(diskRule && diskRule.paths ? diskRule.paths : []).length} 路径`
            console.log(`product-subagents: [ACP ${product}] 用户点击总是允许 → 已落盘（项目 ${bindCwd}，${savedNote}）${grantWritten ? `；会话级工具名授权(${toolName})已写入` : toolGranted ? `；会话级工具名授权(${toolName})此前已授权（本次未重复写入）` : ''}`)
          } else {
            btnOutcome = 'granted-once-fallback'
            // 归因保真：①解析不出工具名 ②有工具名但无会话级写入目标（addToolGrant 未被
            // 调用）③真调用了、被其自身入参校验拒了，三者必须分开说。去重不落到③——
            // 条目已存在由 :448 grantPreexisting 兜住，故③只剩入参不合法这一种可能。
            const noGrantReason = !toolGranted
              ? (!writeToolTier
                ? '本轮按互斥铁律不写工具档（paths 档非空）'
                : !toolName
                ? '未能解析出工具名（不在 TOOL_NAME_SLUGS）'
                : !bindParentSessionId
                  ? '无会话级写入目标（缺少主代理会话 id，本次未调用 addToolGrant）'
                  : 'addToolGrant 调用后被拒（product 非字符串/空，或工具名归一化后为空/占位）')
              : ''
            console.error(`product-subagents: [ACP ${product}] 总是允许落盘失败(${saved.error})，本次仍放行但不会持久记忆${grantWritten ? `；会话级工具名授权(${toolName})已写入` : toolGranted ? `；会话级工具名授权(${toolName})此前已授权（本次未重复写入）` : `；${noGrantReason}`}`)
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
      missingParentSessionIdWarned.delete(info.id) // v0.7.7：回合结束，warn 去重集清理
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
