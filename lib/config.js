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
