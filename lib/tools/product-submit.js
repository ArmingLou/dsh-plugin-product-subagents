import { defineTool } from '@deepseek-ai/dsh-tools'
import { jsonSafe } from '../json-safe.js'
import {
  FAILOVER, FAILOVER_EXHAUSTED, FAILOVER_HANDED_OFF, FAILOVER_MODES, classifySubmitFailure,
} from '../submit-failure.js'

export { FAILOVER_HANDED_OFF, FAILOVER_EXHAUSTED }

/**
 * v0.7.4：以 `timeoutMs` 为界等 `promise`，超时后 resolve 一个标记对象。
 * 定时器**不 unref**（它必须在编排层永不兑现时真的触发，否则工具调用永久阻塞），
 * 但正常路径由调用方在 `finally` 里 clearTimeout，不会拖住宿主进程。
 */
function raceDeadline(promise, timeoutMs, timeoutValue) {
  let timer = null
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutValue), timeoutMs) })
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * v0.7.4：依次询问本次 emit 登记的换档处理器，返回第一个非空裁决。
 * 处理器自身抛错 = 编排层基础设施故障，【不是】"换档失败"：记录后问下一个，
 * 全都失败则回落到原始提交错误（绝不把编排层的 bug 改写成 FAILOVER_EXHAUSTED）。
 *
 * @param {Function[]} handlers
 * @param {object} req
 * @returns {Promise<object|null>}
 */
async function negotiateFailover(handlers, req) {
  let last = null
  for (const handler of handlers) {
    try {
      const outcome = await handler(req)
      if (outcome) return outcome
    } catch (handlerError) {
      console.warn(`product-subagents: 换档处理器抛错（不计入换档结果）: ${handlerError?.message ?? handlerError}`)
      last = null
    }
  }
  return last
}

/**
 * The per-child bridge tool: continuable children submit task work to their
 * bound remote product session. Only children with a binding (created by
 * product_delegate) can call it; recovery reconnects a lost session from
 * the durable registry or the child's own session log.
 *
 * v0.7.4: the blocking failover handshake is now mode-aware. `failoverMode`
 * (auto | notify | notify-then-auto, default notify-then-auto) is forwarded to
 * the orchestrator in the event payload; the orchestrator owns the decision
 * (including the notifyWaitMs timeout) and answers with a single outcome shape:
 *   { handedOff: true, ... } → the orchestrator released this child and
 *       dispatched a REPLACEMENT AS A DIRECT CHILD OF THE MAIN AGENT (a sibling,
 *       not a grandchild). This child's submission is over; we throw
 *       FAILOVER_HANDED_OFF and stop. We must NOT emit submit-failed again:
 *       an unknown code grades as `failover`, which would re-register
 *       onFailover and start a second chain.
 *   { text } / { exhausted } → the legacy 1.11.23 auto-chain contract (grandchild
 *       answer returned in place of this submission / aggregated failure).
 *   { timedOut: true, summary } → notify mode, nobody decided in time.
 *   null                      → nobody took over; throw the original error.
 */
export function registerProductSubmit(ctx, deps) {
  const { bindings, MARKER, recoverRemoteSessionId, bridges, registry, persistRemote, cancelDispose, closedChildren, emitBoundConfigOptions, submitFailureGrades, failoverMode = 'notify-then-auto', notifyWaitMs = 90000 } = deps
  ctx.tools.register(defineTool({
    name: 'product_submit',
    description: 'Submit one task to the persistent remote product session bound to this agent (Codex / Claude Code / ACP CLI) and return the product agent\'s answer. The remote session remembers the full conversation, so later submissions continue it. Use this for all task work while you are a product subagent.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task text to send to the remote product agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec && exec.agent
      if (!agent || !agent.session) throw new Error('product_submit requires a calling agent session')
      const childSessionId = agent.session.id
      // This child is being used again — cancel any pending idle disposal so a
      // fast continuation never pays a reconnect.
      cancelDispose(childSessionId)
      let record = bindings.get(childSessionId)
      if (!record) {
        // v0.5.3(C)：reconnect 守卫——已被 child-closed 标记的 child 不允许重连
        if (closedChildren.has(childSessionId)) {
          const err = new Error('product_submit: RECONNECT_BLOCKED — this child was explicitly closed; remote session is gone')
          err.code = 'RECONNECT_BLOCKED'
          throw err
        }
        // The binding is gone (idle disposal or restart). Recovery order:
        // 1) the durable registry (reliable — written when the remote id was
        //    first known), 2) the child's own session log (marker fallback).
        const cwd = (agent.session.header && agent.session.header.cwd) || process.cwd()
        const persisted = registry.get(childSessionId)
        const recovered = persisted && bridges[persisted.product]
          ? { product: persisted.product, sessionId: persisted.remoteId }
          : recoverRemoteSessionId(agent.session)
        const bridge = recovered ? bridges[recovered.product] : undefined
        if (!bridge) throw new Error('product_submit: no remote product session is bound to this agent (recovery failed)')
        const remote = await bridge.reconnect(recovered.sessionId, cwd)
        // v0.7.17 修复：冷恢复必须重建出与建卡点（lib/index.js 的 bindings.set）同形的记录。
        // 判据侧 lib/index.js 的 permissionHandler 用 record.cwd 才读落盘白名单与工作区域档、
        // 用 record.parentSessionId 才读会话档（两道作用域守卫），缺任一字段都会让规则来源为空
        // ⇒ 每条 ACP 权限请求都转人工（用户配的 allowlist.json 形同不存在，且 appendUserRule
        // 因缺 cwd 拒绝写盘，"总是允许（项目内）"也失效）。
        // 取值优先级：registry 里的持久值 > 会话头 > 本次恢复用的 cwd。
        const header = agent.session.header || {}
        record = {
          product: recovered.product,
          bridge,
          remote,
          settings: undefined,
          cwd: (persisted && persisted.cwd) || header.cwd || cwd,
          parentSessionId: (persisted && persisted.parentSessionId) || header.parentSession || null,
        }
        bindings.set(childSessionId, record)
        // 冷恢复后取值域是新会话的（且可能刚被产品侧改过）→ 重新透出
        if (emitBoundConfigOptions) emitBoundConfigOptions(childSessionId, record)
      }
      const cwd = (agent.session.header && agent.session.header.cwd) || process.cwd()
      const isClosed = () => closedChildren.has(childSessionId) || (exec.signal && exec.signal.aborted)
      try {
        const out = await record.bridge.submit(record.remote, args.task, exec.signal, cwd, record.settings, isClosed)
        // Backstop for bridges that do not detect a live-but-mute session
        // themselves (only a marker, no body): an empty answer is a failure,
        // not a successful no-op — surface it with the product name so the
        // parent can attribute and re-route.
        const body = out && out.text ? out.text.trim() : ''
        if (!body) {
          const err = new Error(`product_submit: ${record.product} 返回空正文（无任何文本输出）`)
          err.code = 'EMPTY_RESPONSE'
          err.product = record.product
          throw err
        }
        const remoteId = record.remote.sessionId || record.remote.threadId
        const marker = remoteId ? `${MARKER}${record.product}:${remoteId}` : ''
        const text = marker ? `${out.text}\n${marker}` : out.text
        // v0.3.7：成功也通知编排层——清除可能残留的失败标记
        // （relay child 失败后若再次调用 product_submit 成功，不应再按失败处理）
        try {
          ctx.emit?.('product-subagents/submit-ok', {
            childId: childSessionId,
            product: record.product,
            remoteSessionId: (record.remote && record.remote.sessionId) ? record.remote.sessionId : null,
          })
        } catch {
          // 事件总线故障不影响本工具正常返回
        }
        return jsonSafe({ text })
      } catch (err) {
        // v0.3.7：提交失败（空正文/超时/限流耗尽/断连等产品侧故障）通过事件总线
        // 通知编排层（dsh-agent-dispatch 订阅 'product-subagents/submit-failed'）——
        // relay child 是 LLM agent，工具报错后它会"转达错误"并以 completed 正常结束
        // 回合，编排层无法从 stopReason 感知产品故障；必须由本工具层发出结构性信号，
        // 编排层才能按 fallback 链自动换档重试同一任务。
        //
        // v0.7.3：把「失败分级 + 回合内换档」合到同一个发射点——
        //   1) grade 是分级的权威来源，随事件下发（编排层优先采信，见 lib/submit-failure.js）；
        //   2) onFailover 允许编排层在本次 emit【同步】登记换档处理器；
        //   3) 失败可换档且有处理器时，本工具调用在此处【阻塞】等编排层给出裁决：
        //      v0.7.4 起裁决语义统一为「换档决定权归主代理，替补档是主代理的直接子级」，
        //      本档只可能被"交接"（→ FAILOVER_HANDED_OFF 收尾）或"判失败"，不再由本层
        //      拿替补的答案当本次返回值（旧版 v0.7.3 的孙代链返回 { text } 仍被兼容）。
        //      无处理器（旧版编排层）时行为与 v0.3.7 逐字等价：照原样抛错。
        const code = err && err.code ? err.code : null
        const message = err && err.message ? err.message : String(err)
        const grade = classifySubmitFailure(code, message, submitFailureGrades)
        const mode = FAILOVER_MODES.has(failoverMode) ? failoverMode : 'notify-then-auto'
        const waitMs = Number.isFinite(notifyWaitMs) && notifyWaitMs > 0 ? notifyWaitMs : 90000
        const failoverHandlers = []
        try {
          ctx.emit?.('product-subagents/submit-failed', {
            childId: childSessionId,
            product: record.product,
            remoteSessionId: (record.remote && record.remote.sessionId) ? record.remote.sessionId : null,
            code,
            message,
            grade,
            // v0.7.4：把换档模式与等待上限随事件下发——编排层据此决定"谁来换档"。
            // 两仓各自也可配置，载荷只是让本仓的设置生效。
            failoverMode: mode,
            notifyWaitMs: waitMs,
            interrupted: err && (err.code === 'SUBMIT_ABORTED' || err.code === 'WATCHDOG_CLOSED'),
            onFailover: (handler) => {
              if (typeof handler === 'function') failoverHandlers.push(handler)
            },
          })
        } catch {
          // 事件总线故障不影响本工具正常抛错
        }
        if (grade === FAILOVER && failoverHandlers.length > 0) {
          // 安全网：编排层自己也有 waitMs 计时器（权威），这里的 2s 宽限窗口只在编排层
          // 存在却不兑现时兜底，保证本工具调用不会无限期阻塞在 rendezvous 上。
          // 【不】race exec.signal：abort 解不开被阻塞的工具（宿主调度器等 in-flight
          // 工具 settle），释放只能由编排层显式兑现。
          const outcome = await raceDeadline(
            negotiateFailover(failoverHandlers, {
              childId: childSessionId,
              product: record.product,
              code,
              message,
              grade,
              task: args.task,
            }),
            waitMs + 2000,
            { timedOut: true, message: '编排层未在合理时间内兑现换档裁决' },
          )
          if (outcome && typeof outcome.text === 'string' && outcome.text.trim()) {
            // 兼容 v0.7.3 编排层（孙代链）：换档成功也补发 submit-ok（清除编排层的失败标记）
            try {
              ctx.emit?.('product-subagents/submit-ok', {
                childId: childSessionId,
                product: record.product,
                remoteSessionId: (record.remote && record.remote.sessionId) ? record.remote.sessionId : null,
                viaFailover: true,
              })
            } catch {
              // 事件总线故障不影响本次返回
            }
            return jsonSafe({ text: outcome.text })
          }
          if (outcome && outcome.handedOff) {
            // 主代理（或超时自动路径）已换档：替补档是主代理的直接子级，其结算通知
            // 直接回主代理；本档到此为止。
            // 【不得】再 emit 一次 submit-failed —— FAILOVER_HANDED_OFF 是未知码，
            // 兜底分级就是 failover，会重复登记 onFailover 并再跑一条链。
            const handed = new Error(
              `product_submit: ${record.product} 提交失败（${code ?? 'PRODUCT_FAILED'}），`
              + `本档已由编排层换档到下一档（${outcome.nextProvider ?? '下一档'}，替补档为主代理的直接子级），本档停止等待。`
              + '请不要再对本档重复提交；结果由替补档直接汇报给主代理。',
            )
            handed.code = FAILOVER_HANDED_OFF
            handed.product = record.product
            throw handed
          }
          let exhausted = null
          if (outcome && outcome.exhausted && !exhausted) {
            exhausted = new Error(outcome.message || message)
          }
          if (outcome && outcome.timedOut) {
            const detail = outcome.summary
              ? `${outcome.summary}；`
              : `${record.product} → ${code ?? 'PRODUCT_FAILED'}: ${String(message).replace(/\s+/g, ' ').slice(0, 200)}；`
            exhausted = new Error(
              `${detail}换档未执行（${outcome.message ?? `failoverMode=${mode}，主代理未在 ${waitMs}ms 内决定`}）。`
              + '如需换到下一档，请以主代理身份调用 agent_failover；本次提交按失败计。',
            )
          }
          if (exhausted) {
            const aggregate = new Error(`product_submit: ${exhausted.message}`)
            aggregate.code = 'FAILOVER_EXHAUSTED'
            aggregate.product = record.product
            throw aggregate
          }
        }
        throw err
      } finally {
        // Persist the remote id whenever it becomes known (after a successful
        // submit, or after the claude bridge recovered it from disk on a
        // failed/interrupted submit).
        persistRemote(childSessionId, record, cwd)
      }
    },
  }))
}
