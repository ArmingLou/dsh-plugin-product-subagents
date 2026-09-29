/**
 * Lossless-JSON guard for tool results.
 *
 * The host validates every tool body's return value against the same rule as
 * `snapshotJsonValue` / `isJsonValue` (`@deepseek-ai/dsh-util-values`; the
 * older `dsh-session` re-export enforces it too): the value must survive a
 * JSON round trip without loss. An own enumerable property whose value is
 * `undefined` does NOT survive — a round trip drops the key — and the whole
 * call fails with
 *
 *   tool "<name>" returned invalid output: value is not lossless JSON
 *
 * (`ToolOutputError`, raised by the tool runtime). Verified on both
 * `0.1.0-rc.6` and `0.2.0-rc.1`, so this is not a version difference: a single
 * optional field left `undefined` — `product: undefined` for a child with no
 * binding, `stopReason: undefined` for a ready child — is enough to break an
 * entire tool.
 *
 * `jsonSafe()` returns a structurally equal value with exactly those losses
 * removed: `undefined`-valued properties are dropped (the key would not
 * survive anyway), and `undefined` array entries become `null` (dropping them
 * would shift the remaining indices). Every register* tool funnels its return
 * value through it so that adding an optional field can never break a call.
 *
 * Only plain objects/arrays are rebuilt; a non-plain value is passed through
 * untouched so the host still rejects it loudly instead of being silently
 * coerced. Values handled here are small and acyclic by construction.
 *
 * @param value - the candidate tool result.
 * @returns a value that JSON-round-trips without loss.
 */
export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : jsonSafe(item)))
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out = {}
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (item === undefined) continue
    out[key] = jsonSafe(item)
  }
  return out
}
