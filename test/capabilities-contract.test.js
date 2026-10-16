/**
 * v0.7.19 regression tests: the provider capability advertisement and the
 * continuable-start seam against dsh 0.2.1-alpha.3.
 *
 * The outage this locks down: `dsh-agent-dispatch` always sends
 * `request.maxDepth`, the host's `assertCapabilities`
 * (`@deepseek-ai/dsh-subagent` lib/index.js:3311-3327) rejects the first
 * requested-but-unadvertised capability, and `depthLimit` was missing from
 * `capabilities` (undefined ⇒ falsy). Every ACP provider therefore died BEFORE
 * `prepareContinuable`, while the one LLM provider in the same route list
 * succeeded — so the v0.7.18 EMPTY_RESPONSE retry could never even be reached.
 *
 * `npm test` is host-free by design, so the fake `assertCapabilities` below is a
 * faithful transcription of the host's own predicate at 0.2.1-alpha.3 and the
 * readiness of the REAL predicate is asserted in `scripts/check-host-compat.mjs`
 * (same object, real runtime).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_CAPABILITIES } from '../lib/host-compat.js'
import { registerProductDelegate } from '../lib/tools/product-delegate.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const indexSource = () => readFileSync(join(root, 'lib', 'index.js'), 'utf8')

/** `SubagentCapabilities` as declared by dsh 0.2.1-alpha.3 (types.d.ts:115-121). */
const CONTRACT_KEYS = ['agentOptions', 'agentPreset', 'outputSchema', 'depthLimit']
/** Declared by 0.1.x hosts, removed from the interface by 0.2.1-alpha.3. */
const LEGACY_KEYS = ['persona', 'toolFilter']
/** The object shipped in 0.7.18 — the negative control for every assertion here. */
const V0718_CAPABILITIES = { agentOptions: false, persona: true, toolFilter: true }

/** The 0.7.18 behaviour, i.e. the defect, as an inspectable value. */
function missingContractMembers(capabilities) {
  return CONTRACT_KEYS.filter((key) => !(key in capabilities))
}

/**
 * Faithful transcription of the host's `assertCapabilities`
 * (`@deepseek-ai/dsh-subagent` lib/index.js:3311-3327 at 0.2.1-alpha.3).
 */
function assertCapabilities(provider, request) {
  const fail = (message) => {
    const error = new Error(message)
    error.code = 'UNSUPPORTED_CAPABILITY'
    throw error
  }
  if (request.agentPreset !== undefined && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
    fail(`subagent provider "${provider.name}" does not support independent agent preset selection`)
  }
  const needs = [
    { when: request.agentOptions !== undefined, cap: 'agentOptions' },
    { when: request.outputSchema !== undefined, cap: 'outputSchema' },
    { when: request.maxDepth !== undefined, cap: 'depthLimit' },
  ]
  for (const { when, cap } of needs) {
    if (when && !provider.capabilities[cap]) fail(`subagent provider "${provider.name}" does not support the "${cap}" capability`)
  }
}

const productProvider = (capabilities) => ({ name: 'qodercli', capabilities, inheritsParentContext: false })
const request = (extra = {}) => ({ prompt: [], parent: {}, signal: new AbortController().signal, ...extra })

/** Register the delegation tool against a fake host and return its definition. */
function registerDelegate(subagents) {
  const registered = []
  const role = { id: 'general', provider: 'acp', permissionMode: 'default', allowDelegation: false, instructions: '' }
  registerProductDelegate(
    { tools: { register: (def) => registered.push(def) }, subagents },
    {
      bindings: new Map(),
      bridges: {},
      availability: { acp: { registered: true } },
      providers: { acp: {} },
      roles: { get: (id) => (id === 'general' ? role : undefined), list: () => [role] },
      state: { activeChildren: 0 },
      maxConcurrent: 4,
      availableProviders: ['acp'],
    },
  )
  return registered[0]
}

const delegateExec = () => ({ agent: { session: { id: 'parent-1' }, options: {} }, signal: new AbortController().signal })

// ── (a) the advertisement covers the host contract ───────────────────────────

test('capabilities: every SubagentCapabilities member of dsh 0.2.1-alpha.3 is advertised', () => {
  assert.deepEqual(missingContractMembers(PROVIDER_CAPABILITIES), [],
    'a missing member is `undefined` ⇒ falsy ⇒ assertCapabilities rejects the provider outright')
  for (const key of [...CONTRACT_KEYS, ...LEGACY_KEYS]) {
    assert.equal(typeof PROVIDER_CAPABILITIES[key], 'boolean', `${key} must be an explicit boolean`)
  }
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), [...CONTRACT_KEYS, ...LEGACY_KEYS].sort(),
    'no capability key outside the contract and the documented legacy pair')
})

test('capabilities: 0.7.18 genuinely failed this check (the test has teeth)', () => {
  assert.deepEqual(missingContractMembers(V0718_CAPABILITIES), ['agentPreset', 'outputSchema', 'depthLimit'])
})

test('capabilities: legacy persona/toolFilter are kept only for pre-0.2.1 hosts', () => {
  // The 0.2.1-alpha.3 interface no longer declares them and the runtime never
  // reads either flag; they survive so an older host that still asserts them is
  // not regressed. Dropping them is a separate, deliberate decision.
  assert.deepEqual(LEGACY_KEYS.filter((key) => key in PROVIDER_CAPABILITIES).sort(), ['persona', 'toolFilter'])
})

test('capabilities: the registration site uses the shared constant, not an inline literal', () => {
  const source = indexSource()
  assert.match(source, /capabilities:\s*PROVIDER_CAPABILITIES\b/,
    'lib/index.js must register the shared constant: a re-inlined literal is how a member goes missing')
  assert.doesNotMatch(source, /capabilities:\s*\{/,
    'an inline capability literal can silently drop a member — advertise the shared constant instead')
})

// ── (b) a maxDepth-bearing request must no longer be rejected ────────────────

test('maxDepth: the real dispatch shape (maxDepth: 2) is accepted', () => {
  // dsh-agent-dispatch sends maxDepth: Math.max(2, callerDepth + 1) on every route.
  assert.doesNotThrow(
    () => assertCapabilities(productProvider(PROVIDER_CAPABILITIES), request({ maxDepth: 2 })),
    'UNSUPPORTED_CAPABILITY("depthLimit") is the 0.7.19 outage',
  )
})

test('maxDepth: 0.7.18 was rejected with UNSUPPORTED_CAPABILITY("depthLimit")', () => {
  assert.throws(
    () => assertCapabilities(productProvider(V0718_CAPABILITIES), request({ maxDepth: 2 })),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_CAPABILITY')
      assert.match(error.message, /"depthLimit" capability/)
      return true
    },
  )
})

test('maxDepth: a caller that omits it keeps working either way', () => {
  assert.doesNotThrow(() => assertCapabilities(productProvider(PROVIDER_CAPABILITIES), request()))
  assert.doesNotThrow(() => assertCapabilities(productProvider(V0718_CAPABILITIES), request()))
})

test('depthLimit: true is justified — the host enforces maxDepth on this provider\'s path', () => {
  // Registering prepareContinuable is what makes startActivation take
  // manager.startLocal, the only path that calls resolveChildDepth(parent,
  // request.maxDepth) and throws SubagentDepthError for an over-deep child. The
  // plugin itself must NOT keep a second, divergent depth ledger.
  assert.equal(PROVIDER_CAPABILITIES.depthLimit, true,
    'false would not add safety: it only makes every product provider unreachable when a caller sends maxDepth')
  assert.match(indexSource(), /async prepareContinuable\s*\(/,
    'without prepareContinuable the host takes startExternal, where maxDepth is NOT enforced')
  const code = readFileSync(join(root, 'lib', 'index.js'), 'utf8').replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /maxDepth/, 'the host owns depth accounting; the plugin must not add its own')
})

// ── (c) the honest-false semantics are not weakened ──────────────────────────

test('agentOptions: false still fails loud instead of silently dropping the override', () => {
  assert.equal(PROVIDER_CAPABILITIES.agentOptions, false)
  assert.throws(
    () => assertCapabilities(productProvider(PROVIDER_CAPABILITIES), request({ agentOptions: { model: 'probe' } })),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY' && /"agentOptions" capability/.test(error.message),
  )
})

test('agentPreset: true accepts a preset request (the host composes the preset, not the plugin)', () => {
  // The flag gates the HOST's ability to attach a preset to the child, not the
  // plugin's willingness to choose one: `startLocal` is what reads
  // `request.agentPreset` and composes `{ agentPreset: request.agentPreset }`
  // (`.../dsh-subagent/lib/index.js:1452`), so this provider needs no preset
  // logic of its own. `false` would only have the host reject the request
  // before `prepareContinuable` — the 0.7.19 `depthLimit: false` shape.
  assert.equal(PROVIDER_CAPABILITIES.agentPreset, true)
  assert.doesNotThrow(() => assertCapabilities(productProvider(PROVIDER_CAPABILITIES), request({ agentPreset: 'probe' })))
})

test('a preset request still requires inheritsParentContext === false', () => {
  // The host's second half of the same predicate (lib/index.js:3311): an
  // inheriting provider cannot take an independent preset. This plugin
  // registers `inheritsParentContext: false` (lib/index.js:878).
  assert.throws(
    () => assertCapabilities({ ...productProvider(PROVIDER_CAPABILITIES), inheritsParentContext: true }, request({ agentPreset: 'probe' })),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY' && /agent preset selection/.test(error.message),
  )
  assert.match(indexSource(), /inheritsParentContext:\s*false/,
    'flipping agentPreset to true is only valid while the provider does not inherit the parent context')
})

test('outputSchema: false still rejects its request loudly', () => {
  assert.equal(PROVIDER_CAPABILITIES.outputSchema, false)
  assert.throws(() => assertCapabilities(productProvider(PROVIDER_CAPABILITIES), request({ outputSchema: { type: 'object' } })),
    (error) => error.code === 'UNSUPPORTED_CAPABILITY' && /"outputSchema" capability/.test(error.message))
})

// ── the continuable-start seam (same upgrade, same file family) ──────────────

test('product_delegate: prefers startActivation and passes the required delivery', async () => {
  const specs = []
  const def = registerDelegate({ startActivation: async (spec) => { specs.push(spec); return { childId: 'child-new' } } })
  const out = await def.execute({ provider: 'acp', task: 'probe task' }, delegateExec())
  assert.equal(out.childId, 'child-new')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].delivery, 'parent', "0.1.x startContinuable announced the settlement to the parent; 'parent' also keeps the durable persistence this plugin relies on")
  assert.equal(specs[0].provider, 'acp')
  assert.deepEqual(Object.keys(specs[0]).sort(), ['delivery', 'label', 'provider', 'request', 'signal'])
})

test('product_delegate: falls back to the pre-0.2.1 name WITHOUT the unknown delivery field', async () => {
  const specs = []
  const def = registerDelegate({ startContinuable: async (spec) => { specs.push(spec); return { childId: 'child-old' } } })
  const out = await def.execute({ provider: 'acp', task: 'probe task' }, delegateExec())
  assert.equal(out.childId, 'child-old')
  assert.equal('delivery' in specs[0], false, 'an old host never declared delivery; sending it is a shape change it did not agree to')
})

test('product_delegate: throws loudly when the seam exposes neither name', async () => {
  const def = registerDelegate({})
  await assert.rejects(
    () => def.execute({ provider: 'acp', task: 'probe task' }, delegateExec()),
    /exposes neither startActivation nor startContinuable/,
  )
})

test('product_delegate: still sends the legacy persona/toolFilter request fields', async () => {
  // Kept for pre-0.2.1 hosts, which really applied them. 0.2.1-alpha.3 dropped
  // both fields from SubagentStartRequest and never reads them, so the relay
  // child's tool surface is no longer composed from toolFilter — see the 0.7.19
  // CHANGELOG "遗留" note. This assertion pins the deliberate compat choice, not
  // an effective restriction.
  const specs = []
  const def = registerDelegate({ startActivation: async (spec) => { specs.push(spec); return { childId: 'child-legacy' } } })
  await def.execute({ provider: 'acp', task: 'probe task' }, delegateExec())
  assert.deepEqual(specs[0].request.toolFilter, { allow: ['product_submit'] })
  assert.match(specs[0].request.persona, /relay bridge/)
})
