#!/usr/bin/env node
/**
 * Host-contract check: does the *installed* DSH runtime accept this plugin?
 *
 * `npm test` is host-free by design (CI has no dsh). This script is the
 * opt-in counterpart: it runs against a real dsh installation and fails loud
 * when an upgrade invalidated one of the seams this plugin depends on.
 *
 * It checks, in order:
 *   1. the runtime can be located and its version read;
 *   2. the host's OWN compatibility predicate
 *      (`dsh-app-boot` → `evaluatePluginCompatibility`, the exact function
 *      that disabled the plugin on dsh 0.2.0-rc.1) accepts this package.json;
 *   3. the subagent service still exposes every `ctx.subagents.<method>()` this
 *      plugin calls (the names are EXTRACTED from lib/**, never hand-listed: a
 *      hand-written list drifted through the 0.2.1-alpha.3 rename and kept
 *      naming methods the runtime had already removed);
 *   4. `SubagentCapabilities` is covered EXACTLY by the object this plugin
 *      registers: every member the runtime's own d.ts declares must be present
 *      (a missing member is `undefined` ⇒ falsy ⇒ `assertCapabilities` rejects
 *      the provider outright — that was the 0.7.19 outage), members the runtime
 *      no longer declares must be marked legacy, and the advertisement must be
 *      the shared constant rather than a re-inlined literal that can silently
 *      lose a member;
 *   5. `depthLimit` is CHECKED, not taken on faith: the plugin advertises it
 *      true, the host really enforces maxDepth on the path this provider takes
 *      (`resolveChildDepth` is called and throws for an over-deep child), and
 *      the runtime's own `assertCapabilities` accepts a `maxDepth`-bearing
 *      request for this advertisement (and rejects one for each capability the
 *      plugin declares false);
 *   6. the plugin is WIRED to the names the previous checks resolved (a green
 *      advertisement proves nothing when the call site still uses the removed
 *      name), including the required `delivery` field;
 *   7. the session seam still offers a synchronous log reader
 *      (`snapshotEvents()` on 0.2.x, `events` on 0.1.x) — the session-continuity
 *      recovery chain reads it;
 *   8. every tool this plugin registers is accepted by the RUNTIME's
 *      `defineTool` + `ToolRuntime.register` shape (output { schema, render },
 *      supported JSON schema). The plugin sources are copied into a scratch
 *      tree whose `@deepseek-ai/dsh-tools` resolves to the runtime copy, so the
 *      check exercises the real DSL, not the repo's (possibly stale) install;
 *   9. the tool-result value contract still matches `jsonSafe()`.
 *
 * Usage:
 *   npm run check:host
 *   DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run check:host
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRATCH = join(root, '.host-check')
const results = []

const ok = (label, detail = '') => results.push({ pass: true, label, detail })
const bad = (label, detail = '') => results.push({ pass: false, label, detail })
const warn = (label, detail = '') => results.push({ warn: true, label, detail })

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Walk up from `from` looking for the package whose manifest has `name`. */
function findPackageRoot(from, name) {
  let dir = from
  for (let i = 0; i < 8; i += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (readJson(manifest).name === name) return dir
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Locate the installed @deepseek-ai/dsh package root. */
function resolveRuntimeRoot() {
  const explicit = process.env.DSH_RUNTIME_ROOT
  if (explicit) {
    if (!existsSync(join(explicit, 'package.json'))) {
      throw new Error(`DSH_RUNTIME_ROOT=${explicit} does not look like a package directory`)
    }
    return realpathSync(explicit)
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const bin = execFileSync(which, ['dsh'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
    const found = findPackageRoot(dirname(realpathSync(bin)), '@deepseek-ai/dsh')
    if (found) return found
  } catch { /* fall through to the global install */ }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(globalRoot, '@deepseek-ai', 'dsh')
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  } catch { /* fall through */ }
  throw new Error('cannot locate the installed @deepseek-ai/dsh package; set DSH_RUNTIME_ROOT to its directory')
}

const load = (runtimeRoot, ...segments) =>
  import(pathToFileURL(join(runtimeRoot, 'node_modules', '@deepseek-ai', ...segments)).href)

/** Scratch tree: this plugin's lib/ with @deepseek-ai/dsh-tools from the runtime. */
function buildScratch(runtimeRoot) {
  rmSync(SCRATCH, { recursive: true, force: true })
  cpSync(join(root, 'lib'), join(SCRATCH, 'lib'), { recursive: true })
  const modules = join(SCRATCH, 'node_modules')
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  // Runtime copy first, so the plugin's `@deepseek-ai/dsh-tools` import wins.
  symlinkSync(
    join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-tools'),
    join(modules, '@deepseek-ai', 'dsh-tools'),
    'dir',
  )
  // Plugin runtime deps (zod, @agentclientprotocol/sdk, …) come from the repo.
  const repoModules = join(root, 'node_modules')
  if (existsSync(repoModules)) {
    for (const entry of readdirNames(repoModules)) {
      if (entry === '@deepseek-ai') continue
      const target = join(modules, entry)
      if (!existsSync(target)) symlinkSync(join(repoModules, entry), target, 'dir')
    }
  }
  const runtimeScoped = join(runtimeRoot, 'node_modules', '@deepseek-ai')
  for (const entry of readdirNames(runtimeScoped)) {
    if (entry === 'dsh-tools') continue
    const target = join(modules, '@deepseek-ai', entry)
    if (!existsSync(target)) symlinkSync(join(runtimeScoped, entry), target, 'dir')
  }
  return SCRATCH
}

function readdirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Capability keys 0.1.x hosts declared and 0.2.1-alpha.3 no longer does. */
const LEGACY_CAPABILITY_KEYS = ['persona', 'toolFilter']

/** Every .js under the plugin's lib/, recursively (the sources the runtime runs). */
function pluginSources(dir = join(root, 'lib')) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...pluginSources(path))
    else if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

/**
 * Every `ctx.subagents.<method>` referenced anywhere under lib/, extracted so
 * the checked list cannot drift from the code (the hand-written list did).
 */
function pluginSubagentMethods() {
  const methods = new Set()
  for (const file of pluginSources()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/ctx\.subagents\.([A-Za-z_$][\w$]*)/g)) methods.add(match[1])
  }
  return methods
}

/** Members of the runtime's `SubagentCapabilities` interface, from its shipped d.ts. */
function capabilityMembersFromDts(runtimeRoot) {
  const path = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'types', 'types.d.ts')
  if (!existsSync(path)) return null
  const block = /export interface SubagentCapabilities \{([\s\S]*?)\n\}/.exec(readFileSync(path, 'utf8'))?.[1]
  if (block === undefined) return null
  const members = [...block.matchAll(/readonly\s+([A-Za-z_$][\w$]*)\s*[?:]/g)].map((match) => match[1])
  return members.length > 0 ? members : null
}

/** Order-insensitive comparison of two member-name lists. */
function sameMembers(a, b) {
  return [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
}

/**
 * The concatenated sources with comments removed, so a prose mention of an
 * identifier cannot satisfy (or trip) a code-shaped assertion.
 */
function codeOnly(files) {
  return files
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

/** Register every plugin tool with the RUNTIME's defineTool; return definitions. */
async function pluginToolDefinitions(scratch, assertSupportedJsonSchema) {
  const definitions = new Map()
  const ctx = { tools: { register: (def) => definitions.set(def.name, def) } }
  const { registerProductSubmit } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'product-submit.js')).href)
  const { registerProductDelegate } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'product-delegate.js')).href)
  const { registerProductRoles } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'product-roles.js')).href)
  const { registerSubagentProgress } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'subagent-progress.js')).href)
  const { registerProductWait } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'product-wait.js')).href)
  const { registerProductAgents } = await import(pathToFileURL(join(scratch, 'lib', 'tools', 'product-agents.js')).href)
  // Registration-time dependencies only: every register* function below reads
  // these while defining its tool, then closes over them for `execute`.
  const deps = {
    roles: { list: () => [] },
    bindings: new Map(),
    availability: {},
    providers: {},
    bridges: {},
    state: { activeChildren: 0 },
    maxConcurrent: 1,
    availableProviders: [],
  }
  registerProductSubmit(ctx, deps)
  registerProductDelegate(ctx, deps)
  registerProductRoles(ctx, deps)
  registerSubagentProgress(ctx, deps)
  registerProductWait(ctx, deps)
  registerProductAgents(ctx, deps)
  // Mirror ToolRuntime.register(): output must be { schema, render } and the
  // schema must be a supported JSON schema.
  for (const [name, def] of definitions) {
    const output = def.output
    if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
      bad(`tool "${name}" shape`, 'output must be { schema, render }')
      continue
    }
    assertSupportedJsonSchema(output.schema)
    ok(`tool "${name}" accepted by runtime defineTool`)
  }
  return definitions
}

async function main() {
  const runtimeRoot = resolveRuntimeRoot()
  const runtimeVersion = readJson(join(runtimeRoot, 'package.json')).version
  ok(`runtime located: @deepseek-ai/dsh@${runtimeVersion}`, runtimeRoot)

  // 2. the host's own compatibility predicate
  const appBoot = await load(runtimeRoot, 'dsh-app-boot', 'lib', 'index.js')
  const manifest = readJson(join(root, 'package.json'))
  const issue = appBoot.evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  if (issue === undefined) ok('host compatibility predicate accepts this package.json')
  else if (issue.exempted) warn(`peer ranges need an exemption on dsh ${runtimeVersion}`, JSON.stringify(issue.peers))
  else bad(`host compatibility predicate REJECTS this package.json`, appBoot.pluginCompatibilityWarning(issue))

  // 3. subagent service surface: the names come from the plugin's own call
  //    sites, never from a hand-written list (the old list still named
  //    startContinuable/start after 0.2.1-alpha.3 had renamed/removed them).
  const subagent = await load(runtimeRoot, 'dsh-subagent', 'lib', 'index.js')
  const runtime = subagent.SubagentRuntime ?? subagent.default
  const proto = runtime && runtime.prototype
  if (!proto) throw new Error('dsh-subagent no longer exports SubagentRuntime — the export surface changed again')
  // A renamed pair: either name satisfies the call, but WHICH one the runtime
  // still has is reported — a silent fallback is how the 0.2.1-alpha.3 rename
  // stayed invisible until every ACP provider stopped starting.
  const ALIASES = { startContinuable: 'startActivation', drainContinuableChildren: 'drainChildren' }
  const called = pluginSubagentMethods()
  if (called.size === 0) bad('no ctx.subagents.<method>() call site found under lib/ — the extractor is stale, not the plugin')
  for (const method of [...called].sort()) {
    const alias = ALIASES[method]
    if (alias) {
      const hasNew = typeof proto[alias] === 'function'
      const hasOld = typeof proto[method] === 'function'
      if (hasNew) ok(`ctx.subagents.${alias}() present (plugin prefers it; old name ${method} is ${hasOld ? 'still there' : 'gone'})`)
      else if (hasOld) warn(`ctx.subagents.${alias}() missing, only the old ${method}() (the plugin falls back to it)`)
      else bad(`ctx.subagents.${alias}() and ${method}() are both missing: the plugin's soft-compat chain is fully broken`)
      continue
    }
    if (typeof proto[method] === 'function') ok(`ctx.subagents.${method}() present`)
    else bad(`ctx.subagents.${method}() missing (the plugin calls it; the host removed or renamed it)`)
  }
  // Arity: "renamed but same shape" must be verified, not assumed.
  const arity = (name, expected) => {
    const fn = proto[name]
    if (typeof fn !== 'function') return
    if (fn.length === expected) ok(`ctx.subagents.${name}.length === ${expected} (call shape matches)`)
    else bad(`ctx.subagents.${name}.length === ${fn.length}, expected ${expected}: the call site has to be re-checked`)
  }
  arity('listChildren', 2) // (parentSessionId, signal)
  arity(typeof proto.startActivation === 'function' ? 'startActivation' : 'startContinuable', 1) // (spec)

  // 4. the capability advertisement must cover the runtime's contract EXACTLY.
  //    An absent member is `undefined` ⇒ falsy ⇒ assertCapabilities rejects the
  //    provider outright for any caller sending the matching request field; that
  //    is a dead provider, not a downgrade, so "missing" is a FAILURE here (the
  //    pre-0.7.19 script only warned, which is why the outage shipped).
  const { PROVIDER_CAPABILITIES } = await import(pathToFileURL(join(root, 'lib', 'host-compat.js')).href)
  const advertised = Object.keys(PROVIDER_CAPABILITIES)
  const valueKeys = subagent.NO_START_CAPABILITIES ? Object.keys(subagent.NO_START_CAPABILITIES) : []
  const dtsKeys = capabilityMembersFromDts(runtimeRoot)
  if (valueKeys.length === 0) bad('the runtime no longer exports NO_START_CAPABILITIES — re-derive the capability contract before shipping')
  if (dtsKeys === null) warn('could not read SubagentCapabilities from dsh-subagent/lib/types/types.d.ts; using the runtime value object only')
  else if (valueKeys.length > 0) {
    if (sameMembers(dtsKeys, valueKeys)) ok(`SubagentCapabilities members (${dtsKeys.join(', ')}) agree between the d.ts and NO_START_CAPABILITIES`)
    else bad('the d.ts and NO_START_CAPABILITIES disagree about SubagentCapabilities members',
      `d.ts: ${dtsKeys.join(', ')} | NO_START_CAPABILITIES: ${valueKeys.join(', ')}`)
  }
  const contractKeys = dtsKeys ?? valueKeys
  const missing = contractKeys.filter((key) => !advertised.includes(key))
  if (missing.length > 0) {
    bad(`provider capability advertisement is MISSING ${missing.join(', ')}`,
      `advertised: ${advertised.join(', ')} — undefined is falsy, so assertCapabilities rejects the provider whenever a caller sends the matching request field`)
  } else {
    ok(`capability advertisement covers every SubagentCapabilities member (${contractKeys.join(', ')})`)
  }
  const extra = advertised.filter((key) => !contractKeys.includes(key))
  const undocumented = extra.filter((key) => !LEGACY_CAPABILITY_KEYS.includes(key))
  if (undocumented.length > 0) bad('advertises capability keys that are neither in the contract nor known-legacy', undocumented.join(', '))
  else if (extra.length > 0) ok(`legacy capability keys kept for older hosts (${extra.join(', ')}); the runtime no longer declares them`)
  for (const key of contractKeys) {
    if (typeof PROVIDER_CAPABILITIES[key] === 'boolean') continue
    bad(`capability "${key}" is not a boolean`, String(PROVIDER_CAPABILITIES[key]))
  }
  // Reverse assertion: a re-inlined literal is how a member goes missing, so the
  // registration site must consume the shared constant and nothing else.
  const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  if (/capabilities:\s*PROVIDER_CAPABILITIES\b/.test(indexSrc)) ok('lib/index.js registers capabilities: PROVIDER_CAPABILITIES (single source of truth)')
  else bad('lib/index.js no longer registers the shared PROVIDER_CAPABILITIES constant')
  if (/capabilities:\s*\{/.test(indexSrc)) bad('lib/index.js re-inlined a `capabilities: {` literal instead of using the shared constant')
  else ok('no re-inlined capabilities literal in lib/index.js')

  // 5. depthLimit: the advertisement must match how the host really behaves.
  //    The plugin takes the continuable path (it registers prepareContinuable,
  //    so startActivation routes to manager.startLocal), and THAT path is where
  //    the host enforces maxDepth — verified behaviourally below.
  const { resolveChildDepth, SubagentDepthError } = subagent
  if (typeof resolveChildDepth !== 'function') {
    bad('dsh-subagent no longer exports resolveChildDepth — the depth contract moved')
  } else {
    let threw = false
    try {
      resolveChildDepth({ session: { header: { delegationDepth: 0 } }, options: {} }, 0)
    } catch (error) {
      threw = error instanceof SubagentDepthError || (error && error.name === 'SubagentDepthError')
    }
    if (threw) ok('the host enforces maxDepth on the continuable path (resolveChildDepth throws SubagentDepthError)')
    else bad('resolveChildDepth no longer rejects an over-deep child: depthLimit: true must be re-justified before shipping')
  }
  if (/async prepareContinuable\s*\(/.test(indexSrc)) {
    ok('the plugin registers prepareContinuable, so startActivation takes manager.startLocal (the maxDepth-enforcing path)')
  } else {
    bad('the plugin no longer registers prepareContinuable: startActivation would take startExternal, where the host does NOT enforce maxDepth')
  }
  if (PROVIDER_CAPABILITIES.depthLimit === true) {
    ok('depthLimit is advertised true: the host owns maxDepth enforcement on this provider\'s only path')
  } else {
    bad('depthLimit is advertised false while callers send maxDepth: every product provider is unreachable (the 0.7.19 outage)')
  }
  if (/maxDepth/.test(codeOnly(pluginSources().filter((file) => !file.endsWith('host-compat.js'))))) {
    warn('plugin sources mention maxDepth in code: the host owns depth accounting, so any local accounting must be justified')
  } else {
    ok('the plugin does no depth accounting of its own (the host owns it)')
  }
  // The runtime's OWN predicate, called for real against this advertisement.
  if (typeof proto.assertCapabilities !== 'function') {
    warn('SubagentRuntime.assertCapabilities is not directly callable; the request-shape probe was skipped')
  } else {
    const probe = { name: 'contract-probe', capabilities: PROVIDER_CAPABILITIES, inheritsParentContext: false }
    const base = { prompt: [], parent: {}, signal: new AbortController().signal }
    try {
      proto.assertCapabilities.call({}, probe, { ...base, maxDepth: 2 })
      ok('assertCapabilities accepts a maxDepth-bearing request for this advertisement')
    } catch (error) {
      bad('assertCapabilities REJECTS a maxDepth-bearing request for this advertisement', error && error.message ? error.message : String(error))
    }
    // agentPreset is advertised true (the host composes the preset itself, see
    // lib/host-compat.js), so it is checked for ACCEPTANCE here; it must not sit
    // in the honest-false probe table below, which asserts rejection.
    try {
      proto.assertCapabilities.call({}, probe, { ...base, agentPreset: 'probe-preset' })
      if (PROVIDER_CAPABILITIES.agentPreset !== true) {
        bad(`assertCapabilities accepted an agentPreset request while the plugin advertises agentPreset: ${PROVIDER_CAPABILITIES.agentPreset}`)
      } else {
        ok('assertCapabilities accepts an agentPreset request (advertised true; the host composes the preset)')
      }
    } catch (error) {
      bad('assertCapabilities REJECTS an agentPreset request although the plugin advertises agentPreset: true', error && error.message ? error.message : String(error))
    }
    for (const [field, value] of [['agentOptions', { model: 'probe' }], ['outputSchema', { type: 'object' }]]) {
      try {
        proto.assertCapabilities.call({}, probe, { ...base, [field]: value })
        bad(`assertCapabilities accepted a ${field} request while the plugin advertises ${field}: false (honest-false must fail loud, not silently drop)`)
      } catch {
        ok(`assertCapabilities rejects a ${field} request (advertised false ⇒ loud, never silently dropped)`)
      }
    }
  }

  // 6. wiring: a green advertisement proves nothing if the plugin still calls
  //    the removed name. The background delegation path must prefer the new
  //    name, keep the old one only as a pre-rename fallback, and carry the
  //    delivery field the new host requires.
  const delegateSrc = readFileSync(join(root, 'lib', 'tools', 'product-delegate.js'), 'utf8')
  for (const [label, needle] of [
    ['startActivation preferred', 'ctx.subagents.startActivation?.bind(ctx.subagents)'],
    ['startContinuable kept as the pre-0.2.1 fallback', 'ctx.subagents.startContinuable?.bind(ctx.subagents)'],
    ['loud throw when both names are gone', 'exposes neither startActivation nor startContinuable'],
    ["delivery: 'parent' (the pre-rename announcement semantics)", "delivery: 'parent'"],
  ]) {
    if (delegateSrc.includes(needle)) ok(`lib/tools/product-delegate.js ${label}`)
    else bad(`lib/tools/product-delegate.js is missing: ${label}`)
  }
  if (/await ctx\.subagents\.startContinuable\(\{/.test(delegateSrc)) {
    bad('lib/tools/product-delegate.js still calls the removed startContinuable directly (throws "startContinuable is not a function" on this host)')
  } else {
    ok('lib/tools/product-delegate.js has no direct call to the removed startContinuable')
  }

  // 7. session log reader (the recovery chain reads it synchronously)
  const { Session } = await load(runtimeRoot, 'dsh-session', 'lib', 'index.js')
  const hasNew = typeof Session?.prototype?.snapshotEvents === 'function'
  const hasOld = Object.getOwnPropertyDescriptor(Session?.prototype ?? {}, 'events') !== undefined
  if (hasNew || hasOld) ok(`session log reader available (${hasNew ? 'snapshotEvents()' : 'events'})`)
  else bad('no synchronous session log reader: sessionEvents() would return undefined (cold-resume recovery breaks)')

  // 8. tool definitions against the runtime DSL
  buildScratch(runtimeRoot)
  const tools = await load(runtimeRoot, 'dsh-tools', 'lib', 'index.js')
  const definitions = await pluginToolDefinitions(SCRATCH, tools.assertSupportedJsonSchema)
  if (definitions.size === 0) bad('no plugin tool definitions were registered')
  else ok(`all ${definitions.size} plugin tools registered against the runtime defineTool`)

  // 9. tool-result value contract: the host rejects an undefined-valued
  //    property (a JSON round trip would drop the key) and jsonSafe() removes
  //    exactly that loss. Both halves are asserted against the real predicate.
  const { isJsonValue } = await load(runtimeRoot, 'dsh-util-values', 'lib', 'index.js')
  const { jsonSafe } = await import(pathToFileURL(join(root, 'lib', 'json-safe.js')).href)
  const sample = { a: undefined, b: { c: undefined, d: 1 }, e: [1, undefined], f: null }
  const rawAccepted = isJsonValue(sample)
  const safeAccepted = isJsonValue(jsonSafe(sample))
  if (rawAccepted === false && safeAccepted === true) {
    ok('tool results: undefined-valued properties are rejected; jsonSafe() output is accepted')
  } else {
    bad('tool-result lossless-JSON contract changed',
      `isJsonValue(raw)=${rawAccepted}, isJsonValue(jsonSafe(raw))=${safeAccepted}`)
  }

  const failures = results.filter((r) => r.pass === false)
  for (const r of results) {
    const mark = r.pass === false ? 'FAIL' : r.warn ? 'warn' : 'ok  '
    console.log(`${mark}  ${r.label}${r.detail ? `\n      ${r.detail}` : ''}`)
  }
  console.log(`\n${failures.length === 0 ? 'host contract OK' : `${failures.length} host-contract failure(s)`} on @deepseek-ai/dsh@${runtimeVersion}`)
  return failures.length === 0 ? 0 : 1
}

main()
  .then((code) => {
    rmSync(SCRATCH, { recursive: true, force: true })
    process.exitCode = code
  })
  .catch((error) => {
    rmSync(SCRATCH, { recursive: true, force: true })
    console.error(`check:host could not run: ${error && error.message ? error.message : error}`)
    if (process.env.DSH_CHECK_DEBUG) console.error(error)
    process.exitCode = 1
  })
