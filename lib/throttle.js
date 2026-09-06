/**
 * Cross-session request throttling and 429 circuit-breaking for product CLIs.
 *
 * Rate limits on product/account level (e.g. "deveco allows 50 requests per
 * minute") are shared by EVERY child session of the same CLI — the quota is
 * not per conversation. A per-session limiter would be useless: N parallel
 * sessions each assuming they may fire every 1.2s would blow the shared quota
 * N times over. So this module keeps ONE limiter per product command, shared
 * across all sessions in this host process.
 *
 * Two cooperating mechanisms:
 *
 * 1. Pacing (requestsPerMinute): at most `intervalMs` between two granted
 *    request slots of the same command. `acquireSlot` resolves when the slot
 *    is granted; callers await it right before sending a prompt. If no limit
 *    is configured for the command (interval 0) this part resolves
 *    immediately. Slots are granted FIFO, so under sustained load each waiter
 *    is delayed just enough to keep the global rate under the ceiling.
 *
 * 2. 429 circuit breaker: when the product answers "rate limited", callers
 *    report it via `reportRateLimited(command, baseMs)` and every subsequent
 *    `acquireSlot` on that command waits out the cooldown before sending —
 *    so a burst of queued messages behind a still-hot rate limit queues
 *    instead of each one slamming the limit again and burning its own retry
 *    budget. Cooldown grows exponentially with consecutive failures
 *    (base * 2^failures, capped at maxCooldownMs). A successful submit
 *    reports `reportSuccess(command)`, which resets the breaker to closed.
 */

const limiters = new Map() // command -> { intervalMs, nextAt, chain, cooldownUntil, consecutiveFailures }

const MAX_COOLDOWN_MS = 10 * 60 * 1000 // 10 min hard cap per cooldown step

function limiterFor(command, intervalMs) {
  let limiter = limiters.get(command)
  if (!limiter) {
    limiter = {
      intervalMs,
      nextAt: 0,
      chain: Promise.resolve(),
      cooldownUntil: 0,
      consecutiveFailures: 0,
    }
    limiters.set(command, limiter)
  }
  return limiter
}

/**
 * Request a slot for `command`. Resolves (possibly after waiting) once both
 * the circuit cooldown (if the breaker is open) and the configured
 * inter-request interval have elapsed since the previous grant.
 * intervalMs <= 0 disables the pacing part only — an open breaker still gates
 * the request until its cooldown expires.
 */
export function acquireSlot(command, intervalMs) {
  const limiter = limiterFor(command, intervalMs)
  const slot = limiter.chain.then(() => {
    const now = Date.now()
    const cooldownWait = Math.max(0, limiter.cooldownUntil - now)
    const paceWait = intervalMs > 0 ? Math.max(0, limiter.nextAt - now) : 0
    limiter.nextAt = Math.max(now, limiter.nextAt) + (intervalMs > 0 ? intervalMs : 0)
    return new Promise((resolve) => setTimeout(resolve, Math.max(cooldownWait, paceWait)))
  })
  // keep the chain alive even if a caller abandons its slot
  limiter.chain = slot.catch(() => {})
  return slot
}

/**
 * Report a rate-limit (429 / "rate limit") response for `command`: opens the
 * circuit for baseMs * 2^consecutiveFailures (capped at 10 min). Returns the
 * cooldown duration just applied, for logging.
 */
export function reportRateLimited(command, baseMs) {
  const limiter = limiterFor(command, 0)
  const base = Math.max(1000, Number(baseMs) || 60000)
  const cooldownMs = Math.min(MAX_COOLDOWN_MS, base * 2 ** limiter.consecutiveFailures)
  limiter.cooldownUntil = Date.now() + cooldownMs
  limiter.consecutiveFailures += 1
  return cooldownMs
}

/**
 * Report a successful submit for `command`: closes the circuit and resets the
 * consecutive-failure counter, so the next rate limit starts from a fresh
 * base backoff again.
 */
export function reportSuccess(command) {
  const limiter = limiters.get(command)
  if (!limiter) return
  limiter.cooldownUntil = 0
  limiter.consecutiveFailures = 0
}
