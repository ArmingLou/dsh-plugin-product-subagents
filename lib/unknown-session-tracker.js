export function createUnknownSessionTracker(options = {}) {
  const windowMs = options.windowMs || 30000
  const threshold = options.threshold || 3
  const maxEntries = options.maxEntries || 100
  const state = new Map()

  function key(product, sessionId) { return `${product}|${sessionId}` }

  function check(product, sessionId) {
    const k = key(product, sessionId)
    const now = Date.now()
    let entry = state.get(k)
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now }
    } else {
      entry = { count: entry.count + 1, windowStart: entry.windowStart }
    }
    state.set(k, entry)
    if (state.size > maxEntries) {
      const sorted = [...state.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart)
      for (let i = 0; i < sorted.length - maxEntries; i++) {
        state.delete(sorted[i][0])
      }
    }
    const escalated = entry.count >= threshold
    return { count: entry.count, escalated, windowStart: entry.windowStart }
  }

  function deleteEntry(product, sessionId) {
    state.delete(key(product, sessionId))
  }

  return { check, deleteEntry }
}
