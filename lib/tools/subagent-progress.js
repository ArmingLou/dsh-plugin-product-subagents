import { defineTool } from '@deepseek-ai/dsh-tools'
import { childActivity } from '../host-compat.js'
import { jsonSafe } from '../json-safe.js'

/** Progress tool: latest status, internal trace, token usage of one child. */
export function registerSubagentProgress(ctx, deps) {
  const { bindings, foldProgress, foldTrace, foldTokenUsage } = deps
  ctx.tools.register(defineTool({
    name: 'subagent_progress',
    description: 'Report the latest progress of one product subagent: lifecycle status, the pinned product and remote session, the current/last task, the latest answer, and live activity while a turn is in flight.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The child session id returned by product_delegate.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const childId = args.subagent_id
      const record = bindings.get(childId)
      const sessionsSvc = ctx.get('sessions')
      const session = sessionsSvc ? sessionsSvc.get(childId) : undefined
      const fold = session ? foldProgress(session) : null
      let listStatus = null
      try {
        const children = await ctx.subagents.listChildren(exec.agent.session.id, exec.signal)
        const me = children.find((c) => c.id === childId)
        if (me) {
          // dsh 0.2.x：listChildren 的条目（SubagentCatalogEntry）只保留
          // { id, createdAt, mode, label }——activity 不再随条目返回，按会话
          // 驻留性推导（见 host-compat.js）。
          // 注：旧实现把条目的 hasChildren 拷进 listStatus 后从未输出（死数据），
          // 这里不再为它多读一次该 child 的目录。
          listStatus = {
            activity: childActivity(sessionsSvc, childId),
            mode: me.mode,
            label: me.label,
          }
        }
      } catch {
        listStatus = null
      }
      const remoteId = record && (record.remote.sessionId || record.remote.threadId)
      const inFlight = record && record.remote.progress && record.remote.progress.busySince
        ? { ...record.remote.progress, busySince: new Date(record.remote.progress.busySince).toISOString() }
        : undefined
      return jsonSafe({
        childId,
        status: listStatus ? listStatus.activity : session ? 'running' : 'stored',
        mode: listStatus ? listStatus.mode : undefined,
        label: listStatus ? listStatus.label : undefined,
        pinnedProduct: record ? record.product : (fold && fold.product) || undefined,
        remoteSessionId: remoteId || (fold && fold.remoteSessionId) || undefined,
        // model: explicit override, else inherited from the product's own config
        model: record && record.settings && record.settings.model
          ? record.settings.model
          : 'inherit (product default)',
        reasoningEffort: record && record.settings && record.settings.reasoningEffort
          ? record.settings.reasoningEffort
          : 'inherit (product default)',
        turn: fold ? fold.turn : undefined,
        stepCount: fold ? fold.stepCount : 0,
        lastTask: fold ? fold.lastTask : undefined,
        lastAnswer: fold ? fold.lastAnswer : undefined,
        lastActivityAt: fold && fold.lastActivityAt ? new Date(fold.lastActivityAt).toISOString() : undefined,
        tokenUsage: session ? foldTokenUsage(session) : undefined,
        // internal trace: recent turn/step/tool/answer events from the child's own log
        trace: session ? foldTrace(session) : undefined,
        inFlight,
      })
    },
  }))
}
