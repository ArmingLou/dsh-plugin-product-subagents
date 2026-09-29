/**
 * Host-version compatibility shims for the DSH subagent seam.
 *
 * The plugin is built against the dsh 0.2.x subagent/tools surface. Two host
 * surfaces it reads changed in that generation; both are served here so one
 * code path keeps working on 0.1.x and 0.2.x alike:
 *
 *  1. `Session.events` (a cached frozen array) is gone in 0.2.x; the
 *     replacement is `Session.snapshotEvents(fromSeq, toSeqExclusive)`
 *     (defaults: whole log). `sessionEvents()` prefers the new method and
 *     falls back to the legacy getter.
 *
 *     NOTE: the host marks `snapshotEvents()`/`ownEvents()` as deprecated for
 *     *new* host code (the migration target is message/tool projections).
 *     Neither projection serves an arbitrary scalar fold over a child's own
 *     tail, and this plugin's children are created with `seed: []` (no
 *     inherited prefix), so the full-log read is the exact pre-0.2 semantics.
 *     The scan is bounded to the tail, as before.
 *
 *  2. `ctx.subagents.listChildren()` now returns `SubagentCatalogEntry`
 *     (`{ id, createdAt, mode, label? }`) — the `activity` / `hasChildren`
 *     fields of the old `SubagentListEntry` are gone. The host still derives
 *     `activity` for `listDescendants()` with exactly
 *     `sessions.get(id) === undefined ? 'inactive' : 'running'`
 *     (`@deepseek-ai/dsh-subagent` lib/index.js, listDescendants fold), so
 *     `childActivity()` mirrors that rule locally instead of paying for a
 *     whole-tree walk.
 */

/**
 * Read a session's durable event log across host versions.
 *
 * @param session - a live `Session`, a session-shaped test double, or nullish.
 * @returns the event array, or undefined when the host exposes neither reader
 *          (callers treat that as "no log available").
 */
export function sessionEvents(session) {
  if (!session) return undefined
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // Fall through to the legacy accessor: a host that throws here (or
      // returns a non-array) must not take the whole tool call down.
    }
  }
  const legacy = session.events
  return Array.isArray(legacy) ? legacy : undefined
}

/**
 * Residency of one child: the pre-0.2 `SubagentListEntry.activity` value,
 * derived locally from the live session store (the host's own rule).
 *
 * `running` means the logical record is live in `ctx.sessions`; `inactive`
 * means it exists only in persistence (a settled/cold child). `unknown` is
 * returned when the session service is unavailable, so callers can degrade
 * instead of inventing an answer.
 *
 * @param sessionsService - `ctx.get('sessions')`, or undefined.
 * @param childId - the child session id to classify.
 * @returns 'running' | 'inactive' | 'unknown'.
 */
export function childActivity(sessionsService, childId) {
  if (!childId || !sessionsService || typeof sessionsService.get !== 'function') return 'unknown'
  try {
    return sessionsService.get(childId) === undefined ? 'inactive' : 'running'
  } catch {
    return 'unknown'
  }
}
