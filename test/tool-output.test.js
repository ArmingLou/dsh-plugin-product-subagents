import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerProductAgents } from '../lib/tools/product-agents.js'
import { registerSubagentProgress } from '../lib/tools/subagent-progress.js'
import { registerProductWait } from '../lib/tools/product-wait.js'
import { registerProductRoles } from '../lib/tools/product-roles.js'
import { foldProgress, foldTrace, foldTokenUsage } from '../lib/progress.js'

/**
 * Tool-body output contract.
 *
 * The host validates every returned value as lossless JSON: an own enumerable
 * property whose value is `undefined` does not survive a JSON round trip, so
 * the call fails with `value is not lossless JSON`. These tests drive the real
 * tool bodies with a stub context and assert the value survives that round trip
 * unchanged — the host-free encoding of the rule (the runtime predicate itself
 * is asserted in `npm run check:host`).
 */
function assertLossless(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
}

/** Register one tool against a stub context and hand back its definition. */
function define(name, register, deps, stubs = {}) {
  const registry = new Map()
  const ctx = {
    tools: { register: (definition) => registry.set(definition.name, definition) },
    get: (service) => (service === 'sessions' ? stubs.sessions : undefined),
    subagents: stubs.subagents ?? {},
  }
  register(ctx, deps)
  const definition = registry.get(name)
  assert.ok(definition, `${name} was not registered`)
  return definition
}

const parentExec = (id = 'parent-session') => ({ agent: { session: { id } }, signal: undefined })

test('product_agents: children without a binding stay lossless (was: undefined property)', async () => {
  const sessions = { get: (id) => (id === 'child-live' ? {} : undefined) }
  const tool = define('product_agents', registerProductAgents, {
    bindings: new Map([['child-live', { product: 'qoder', settings: { model: 'm' } }]]),
    availability: {
      qoder: { registered: true, command: true, auth: { ok: true, note: 'ok' }, reason: undefined },
    },
  }, {
    sessions,
    subagents: {
      // 0.2 shape: no `activity` / `hasChildren` on the entry any more.
      listChildren: async () => [
        { id: 'child-live', createdAt: 1, mode: 'continuable', label: 'live' },
        { id: 'child-cold', createdAt: 2, mode: 'one-shot' },
      ],
    },
  })

  const value = await tool.execute({}, parentExec())
  assertLossless(value)
  assert.deepEqual(value.children.map((c) => c.id), ['child-live', 'child-cold'])
  assert.equal(value.children[0].activity, 'running')
  assert.equal(value.children[0].pinned, true)
  assert.equal(value.children[0].model, 'm')
  assert.equal(value.children[1].activity, 'inactive')
  assert.equal(value.children[1].pinned, false)
  // A one-shot child has no label and no binding: both keys are dropped, not null.
  assert.equal('label' in value.children[1], false)
  assert.equal('product' in value.children[1], false)
})

test('product_agents: an unavailable sessions service degrades to unknown, still lossless', async () => {
  const tool = define('product_agents', registerProductAgents, {
    bindings: new Map(),
    availability: {},
  }, {
    sessions: undefined,
    subagents: { listChildren: async () => [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'a' }] },
  })
  const value = await tool.execute({}, parentExec())
  assertLossless(value)
  assert.equal(value.children[0].activity, 'unknown')
})

test('subagent_progress: absent child/session state stays lossless', async () => {
  const tool = define('subagent_progress', registerSubagentProgress, {
    bindings: new Map(),
    foldProgress,
    foldTrace,
    foldTokenUsage,
  }, {
    sessions: { get: () => undefined },
    subagents: { listChildren: async (parentId) => (parentId === 'parent-session' ? [] : []) },
  })

  const value = await tool.execute({ subagent_id: 'missing-child' }, parentExec())
  assertLossless(value)
  assert.equal(value.childId, 'missing-child')
  assert.equal(value.status, 'stored')
})

test('subagent_progress: a listed child reports derived activity from one catalog read', async () => {
  const calls = []
  const tool = define('subagent_progress', registerSubagentProgress, {
    bindings: new Map(),
    foldProgress,
    foldTrace,
    foldTokenUsage,
  }, {
    sessions: { get: () => undefined },
    subagents: {
      listChildren: async (parentId) => {
        calls.push(parentId)
        return [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'a' }]
      },
    },
  })

  const value = await tool.execute({ subagent_id: 'child-a' }, parentExec())
  assertLossless(value)
  assert.equal(value.status, 'inactive')
  assert.equal(value.mode, 'continuable')
  assert.equal(value.label, 'a')
  // `hasChildren` was host-entry data this tool never emitted (dead field); the
  // tool must not pay an extra per-child catalog read for it.
  assert.deepEqual(calls, ['parent-session'])
})

test('product_wait: an unknown child returns immediately with a lossless value', async () => {
  const tool = define('product_wait', registerProductWait, {
    bindings: new Map(),
    foldProgress,
    foldTrace,
  }, {
    sessions: { get: () => undefined },
    subagents: { listChildren: async () => [] },
  })

  const value = await tool.execute({ subagent_id: 'missing-child' }, parentExec())
  assertLossless(value)
  assert.equal(value.status, 'unknown')
})

test('product_wait: a settled child reports ready without waiting, losslessly', async () => {
  const tool = define('product_wait', registerProductWait, {
    bindings: new Map(),
    foldProgress,
    foldTrace,
  }, {
    sessions: { get: () => undefined },
    subagents: { listChildren: async () => [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'a' }] },
  })

  const value = await tool.execute({ subagent_id: 'child-a' }, parentExec())
  assertLossless(value)
  assert.equal(value.status, 'ready')
})

test('product_roles: role rows are lossless', async () => {
  const tool = define('product_roles', registerProductRoles, {
    roles: { list: () => [{ id: 'general', description: undefined, permissionMode: 'full', allowDelegation: true }] },
  })
  const value = await tool.execute({}, parentExec())
  assertLossless(value)
  assert.equal(value.roles[0].provider, '(caller chooses)')
})
