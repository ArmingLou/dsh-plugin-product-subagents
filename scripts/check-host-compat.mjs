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
 *   3. the subagent service still exposes registerProvider / startContinuable /
 *      listChildren / listDescendants / start, and still advertises the
 *      `agentOptions` capability key;
 *   4. the session seam still offers a synchronous log reader
 *      (`snapshotEvents()` on 0.2.x, `events` on 0.1.x) — the session-continuity
 *      recovery chain reads it;
 *   5. every tool this plugin registers is accepted by the RUNTIME's
 *      `defineTool` + `ToolRuntime.register` shape (output { schema, render },
 *      supported JSON schema). The plugin sources are copied into a scratch
 *      tree whose `@deepseek-ai/dsh-tools` resolves to the runtime copy, so the
 *      check exercises the real DSL, not the repo's (possibly stale) install;
 *   6. the provider capability keys this plugin advertises are a subset of the
 *      runtime's SubagentCapabilities keys (and warns about keys the runtime
 *      has that the plugin does not declare).
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

  // 3. subagent service surface
  const subagent = await load(runtimeRoot, 'dsh-subagent', 'lib', 'index.js')
  const runtime = subagent.SubagentRuntime ?? subagent.default
  for (const method of ['registerProvider', 'startContinuable', 'start', 'listChildren', 'listDescendants', 'getProvider']) {
    if (runtime && typeof runtime.prototype[method] === 'function') ok(`ctx.subagents.${method}() present`)
    else bad(`ctx.subagents.${method}() missing`)
  }
  const capabilityKeys = subagent.NO_START_CAPABILITIES ? Object.keys(subagent.NO_START_CAPABILITIES) : []
  if (capabilityKeys.includes('agentOptions')) ok('runtime advertises the agentOptions capability key')
  else bad('runtime has no agentOptions capability key')
  const declared = /capabilities:\s*\{([^}]*)\}/.exec(readFileSync(join(root, 'lib', 'index.js'), 'utf8'))
  if (declared) {
    const advertised = [...declared[1].matchAll(/([A-Za-z]+)\s*:/g)].map((m) => m[1])
    const unknown = advertised.filter((key) => !capabilityKeys.includes(key))
    if (unknown.length > 0) bad('plugin advertises capabilities the runtime does not define', unknown.join(', '))
    else ok(`plugin capability keys are known to the runtime (${advertised.join(', ')})`)
    const missing = capabilityKeys.filter((key) => !advertised.includes(key))
    if (missing.length > 0) warn('runtime capability keys the plugin does not declare (default false)', missing.join(', '))
  } else {
    warn('could not read the provider capabilities literal from lib/index.js')
  }

  // 4. session log reader (the recovery chain reads it synchronously)
  const { Session } = await load(runtimeRoot, 'dsh-session', 'lib', 'index.js')
  const hasNew = typeof Session?.prototype?.snapshotEvents === 'function'
  const hasOld = Object.getOwnPropertyDescriptor(Session?.prototype ?? {}, 'events') !== undefined
  if (hasNew || hasOld) ok(`session log reader available (${hasNew ? 'snapshotEvents()' : 'events'})`)
  else bad('no synchronous session log reader: sessionEvents() would return undefined (cold-resume recovery breaks)')

  // 5. tool definitions against the runtime DSL
  buildScratch(runtimeRoot)
  const tools = await load(runtimeRoot, 'dsh-tools', 'lib', 'index.js')
  const definitions = await pluginToolDefinitions(SCRATCH, tools.assertSupportedJsonSchema)
  if (definitions.size === 0) bad('no plugin tool definitions were registered')
  else ok(`all ${definitions.size} plugin tools registered against the runtime defineTool`)

  // 6. tool-result value contract: the host rejects an undefined-valued
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
