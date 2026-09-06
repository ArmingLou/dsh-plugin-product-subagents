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
