import { z } from 'zod'

/**
 * Configuration validation for the plugin. Invalid config fails LOUDLY at
 * apply time with a precise message, instead of surfacing as a confusing
 * runtime error later.
 */

const providerDefSchema = z.object({
  type: z.enum(['claude', 'codex', 'acp']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  // Optional client-side request throttling, shared across ALL sessions of
  // this command (the quota is account-level, not per-session). 0/absent = no
  // throttling. e.g. requestsPerMinute: 50 for a product that rate-limits at
  // 50 requests/minute — tasks then simply queue and complete at that pace.
  requestsPerMinute: z.number().int().min(0).optional(),
  // Optional retry budget for rate-limit responses (429 / "rate limit" etc.).
  // Default 3 attempts when absent. The submit waits
  // rateLimitBackoffMs * 2^attempt (default 60s) between retries so the task
  // is eventually served at the slow allowed pace instead of failing fast;
  // set rateLimitRetries: 0 for fail-fast.
  rateLimitRetries: z.number().int().min(0).optional(),
  rateLimitBackoffMs: z.number().int().positive().optional(),
  // v0.4.0 权限策略：ACP requestPermission 如何处理。
  //   'interactive'（默认）：经宿主审批服务向用户弹窗（允许一次/总是允许/拒绝）；
  //   'read'：只读类请求自动放行（allow_once），其余交互；
  //   'all'：全部自动放行（危险，仅信任产品时使用）；
  //   'deny'：一律拒绝（旧版 unattended 行为，fail-closed）。
  permission: z.enum(['interactive', 'read', 'all', 'deny']).optional(),
  // v0.4.0 完全信任路径白名单：请求路径全部命中时直接授权（可读可写），不再
  // 弹窗，且优先回 allow_always（ACP 服务端记住授权，后续同类请求不再询问）。
  // 示例：~/.dsh/**、/Users/xxx/.nvm/**。未命中/未提取到路径 → 按 permission 交互。
  allowWritePaths: z.array(z.string()).optional(),
})

export const pluginConfigSchema = z.object({
  providers: z.record(z.string(), providerDefSchema).optional(),
  registryPath: z.string().optional(),
  idleTimeoutMs: z.number().int().min(0).optional(),
  maxConcurrentChildren: z.number().int().positive().optional(),
  rolesDir: z.string().optional(),
  // v0.6.0 provider 级「可用模型 / 可用 effort」目录（lib/provider-catalog.js）。
  // 探测 = 一条建完就弃的 ACP 会话，读其 configOptions，落盘
  // $DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json 供跨插件消费。
  // 该路径**不可配置**：消费方（dsh-agent-dispatch）按同一路径硬编码读取，
  // 开放目录只会让两仓分叉，因此故意不提供 providerCatalogDir。
  providerCatalogTtlMs: z.number().int().positive().optional(),
  providerProbeOnStart: z.boolean().optional(),
  providerProbeTimeoutMs: z.number().int().positive().optional(),
  // v0.7.3 提交失败分级覆盖：{ "<错误码>": "failover" | "fatal" | "interrupted" }。
  // 默认分级见 lib/submit-failure.js：
  //   failover    → 允许编排层静默换下一档 routes（限额/限流/空正文/超时/传输中断…）
  //   fatal       → 不换档，直接作为最终失败（认证失败/参数非法/语法错误/模型不存在…）
  //   interrupted → 人为中断，尊重取消意图
  // 未列出的错误码走内置分级（兜底 = failover，只有明确归入 fatal 的才停止换档）。
  submitFailureGrades: z.record(z.string(), z.enum(['failover', 'fatal', 'interrupted'])).optional(),
  // v0.7.4 换档交接模式（与 dsh-agent-dispatch 的 `failoverMode` 同名同义）——三种模式
  // 一律使用【同级】替补档（主代理的直接子级），差别只在"谁来决定、何时决定"：
  //   'notify-then-auto'（默认）→ 发唤醒信号等主代理 agent_failover；超时由编排层自动换档
  //   'notify'                 → 只等主代理；超时按失败收尾，绝不自动换档
  //   'auto'                   → 不等待，立即由编排层换档（保持 v0.7.3 的全自动手感）
  failoverMode: z.enum(['auto', 'notify', 'notify-then-auto']).optional(),
  // v0.7.4：notify 模式下等主代理决定的上限（默认 90s），超时按模式收尾。
  notifyWaitMs: z.number().int().positive().optional(),
}).passthrough()

/** Validate and return a normalized config; throws with a clear message. */
export function validateConfig(config = {}) {
  const result = pluginConfigSchema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`product-subagents: invalid config — ${issues.join('; ')}`)
  }
  return result.data
}
