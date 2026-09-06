import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * The per-child bridge tool: continuable children submit task work to their
 * bound remote product session. Only children with a binding (created by
 * product_delegate) can call it; recovery reconnects a lost session from the
 * durable registry or the child's own log.
 */
export function registerProductSubmit(ctx, deps) {
  const { bindings, MARKER, recoverRemoteSessionId, bridges, registry, persistRemote, cancelDispose, closedChildren } = deps
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
        record = { product: recovered.product, bridge, remote, settings: undefined }
        bindings.set(childSessionId, record)
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
          })
        } catch {
          // 事件总线故障不影响本工具正常返回
        }
        return { text }
      } catch (err) {
        // v0.3.7：提交失败（空正文/超时/限流耗尽/断连等产品侧故障）通过事件总线
        // 通知编排层（dsh-agent-dispatch 订阅 'product-subagents/submit-failed'）——
        // relay child 是 LLM agent，工具报错后它会"转达错误"并以 completed 正常结束
        // 回合，编排层无法从 stopReason 感知产品故障；必须由本工具层发出结构性信号，
        // 编排层才能按 fallback 链自动换档重试同一任务。
        try {
          ctx.emit?.('product-subagents/submit-failed', {
            childId: childSessionId,
            product: record.product,
            code: err && err.code ? err.code : null,
            message: err && err.message ? err.message : String(err),
            interrupted: err && (err.code === 'SUBMIT_ABORTED' || err.code === 'WATCHDOG_CLOSED'),
          })
        } catch {
          // 事件总线故障不影响本工具正常抛错
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
