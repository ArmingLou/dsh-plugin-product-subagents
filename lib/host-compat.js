/**
 * Host-version compatibility shims for the DSH subagent seam.
 *
 * The plugin is built against the dsh 0.2.x subagent/tools surface. Three host
 * surfaces it reads changed in that generation; all are served here so one
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
 *
 *  3. `SubagentCapabilities` — the interface a registered provider advertises —
 *     was reshaped: 0.1.0-rc.6 declared
 *     `{ outputSchema, depthLimit, toolFilter, persona }`, 0.2.1-alpha.3
 *     declares `{ agentOptions, agentPreset, outputSchema, depthLimit }`.
 *     `PROVIDER_CAPABILITIES` below is the single advertisement this plugin
 *     registers, and the guardrails read it instead of scraping a literal.
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

/**
 * The capability advertisement every product provider is registered with
 * (`ctx.subagents.registerProvider({ capabilities: PROVIDER_CAPABILITIES })`).
 *
 * Lives here, not inline at the registration site, because the host's
 * `assertCapabilities` rejects the FIRST requested-but-undeclared capability
 * with `UNSUPPORTED_CAPABILITY`, and an undeclared member is `undefined`
 * (falsy) — so a member the source forgot to write is not a downgrade, it is a
 * provider that a caller can never reach. A guardrail that scrapes a literal
 * out of lib/index.js cannot notice a member that was never written; sharing
 * the object here lets `scripts/check-host-compat.mjs` and
 * `test/capabilities-contract.test.js` assert against the exact value the
 * runtime is handed.
 *
 * Contract history (the shape is the host's, not ours):
 *  - dsh 0.1.0-rc.6 `SubagentCapabilities` =
 *    `{ outputSchema, depthLimit, toolFilter, persona }`.
 *  - dsh 0.2.1-alpha.3 `SubagentCapabilities` =
 *    `{ agentOptions, agentPreset, outputSchema, depthLimit }`; `persona` and
 *    `toolFilter` are gone from the interface AND from the start request the
 *    host reads (0 hits for `request.persona` / `request.toolFilter` in the
 *    0.2.1-alpha.3 runtime), and `assertCapabilities` no longer consults
 *    either flag — see `.../dsh-subagent/lib/types/types.d.ts:115-121` and
 *    `lib/index.js:3311-3327`.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  // Unchanged false, and deliberately loud: a host-level provider/model/
  // reasoningEffort override cannot apply to an external product CLI, whose
  // model and effort come from the role and the product's own config options.
  // Declaring false makes such a request fail loud (UNSUPPORTED_CAPABILITY)
  // instead of being silently dropped. Continuable children are composed by
  // the continuation manager and never consult this flag.
  agentOptions: false,
  // True, and the flag answers ONE question: may the HOST attach a preset to a
  // child started through this provider? It does not ask who picks the preset.
  // The host picks it — `startLocal` reads `request.agentPreset` itself and
  // composes `{ agentPreset: request.agentPreset }` for the child
  // (`.../dsh-subagent/lib/index.js:1452`), so the plugin never reads that
  // field (0 hits under lib/) and `prepareContinuable` is consulted for `seed`
  // only. Advertising false does not make the plugin honest about anything it
  // owns; it only makes the host refuse a preset-bearing request before
  // `prepareContinuable` is ever reached — the same loud-but-unreachable
  // failure mode as the 0.7.19 `depthLimit: false` outage. The remaining
  // capability members below stay honest as advertised: `agentOptions` and
  // `outputSchema` are genuinely unsupported by this plugin and must keep
  // failing loud (UNSUPPORTED_CAPABILITY), never be silently dropped.
  agentPreset: true,
  // This plugin never reads `request.outputSchema`; its tools declare fixed
  // output schemas instead (`defineTool`), and remote product replies arrive
  // as free text.
  outputSchema: false,
  // True, and the maxDepth contract IS honoured — by the HOST, on the only
  // path this provider takes: registering `prepareContinuable` makes
  // `startActivation` route to `manager.startLocal`
  // (`.../dsh-subagent/lib/index.js:3053`), which runs
  // `resolveChildDepth(parent, request.maxDepth)` (`lib/index.js:1399`,
  // `lib/types/child-agent.js:31-39`) and throws `SubagentDepthError` BEFORE
  // any remote product session is created. The plugin needs no maxDepth
  // accounting of its own, so `false` would not buy safety: it would only make
  // every ACP provider unreachable whenever a caller sends maxDepth (exactly
  // the 0.7.19 outage, where dsh-agent-dispatch always sends it).
  depthLimit: true,
  // Legacy members: still declared by 0.1.x hosts, no longer part of the
  // interface and ignored (never asserted) by 0.2.1-alpha.3. Kept so an older
  // host that still consults them is not regressed; the matching request
  // fields (`request.persona` / `request.toolFilter`) are now dropped by the
  // host — see the 0.7.19 CHANGELOG "遗留" note.
  persona: true,
  toolFilter: true,
})
