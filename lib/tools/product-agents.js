import { defineTool } from '@deepseek-ai/dsh-tools'
import { childActivity } from '../host-compat.js'
import { jsonSafe } from '../json-safe.js'

/** Overview tool: detected provider availability + live children. */
export function registerProductAgents(ctx, deps) {
  const { bindings, availability } = deps
  ctx.tools.register(defineTool({
    name: 'product_agents',
    description: 'List detected product CLI agents with availability, plus every live product subagent with its pinned product and activity.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const availabilityView = Object.fromEntries(
        Object.entries(availability).map(([name, v]) => [name, {
          registered: v.registered,
          commandPresent: v.command,
          auth: v.auth.ok ? v.auth.note : v.auth.note,
          note: v.reason,
        }]),
      )
      const children = []
      const sessionsSvc = ctx.get('sessions')
      try {
        const list = await ctx.subagents.listChildren(exec.agent.session.id, exec.signal)
        for (const child of list) {
          const record = bindings.get(child.id)
          children.push({
            id: child.id,
            product: record ? record.product : undefined,
            // dsh 0.2.x：目录条目不再带 activity，按会话驻留性推导
            // （与宿主 listDescendants 的判定同规则，见 host-compat.js）。
            activity: childActivity(sessionsSvc, child.id),
            mode: child.mode,
            label: child.label,
            pinned: Boolean(record),
            model: record && record.settings && record.settings.model ? record.settings.model : 'inherit',
          })
        }
      } catch {
        // children listing unavailable; availability still reported
      }
      return jsonSafe({ availability: availabilityView, children })
    },
  }))
}
