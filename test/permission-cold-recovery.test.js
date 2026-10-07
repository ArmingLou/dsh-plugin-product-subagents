// v0.7.17 回归：冷恢复重建 binding 记录时不得丢作用域字段（cwd / parentSessionId）。
//
// 现场（2026-10-07，工作区 /Users/arming/Documents/develop/suansuan/suansuan，qoder 子代理 de03e7e2）：
// 子代理空闲被回收（lib/index.js 的 scheduleDispose → record.bridge.dispose() + bindings.delete）后，
// 下一次 product_submit 走冷恢复分支重建记录；当时重建出的对象只有
// `{ product, bridge, remote, settings }`，**缺 cwd / parentSessionId**。
// 判据侧 lib/index.js 的 permissionHandler 用 `record.cwd` 才读落盘白名单与工作区域档、
// 用 `record.parentSessionId` 才读会话档（两道作用域守卫 `if (!danger && bindCwd)` /
// `if (!danger && bindParentSessionId)`）⇒ 规则来源为空 ⇒ evaluateRuleSources([])={allowed:false}
// ⇒ 每条 ACP 权限请求都转人工，且 readUserAllowlist() 一次都没被调用（用户配的
// allowlist.json 形同不存在）。附带后果：appendUserRule 要求非空 cwd，冷恢复后点
// 「总是允许（项目内）」也写不进盘。
//
// 本文件钉死（T1–T5，全部断言真实行为，不复刻实现）：
//   T1  冷恢复记录必须含 cwd / parentSessionId（含 registry → 会话头 → 当前 cwd 回退链）；
//   T1b persistRemote 必须把 parentSessionId 一起落 registry（否则进程重启后会话档必然丢失）；
//   T2  用 T1 的记录跑真实 permissionHandler（执行类帧 + 命中落盘规则）⇒ 自动放行、
//       不发 permission-pending、readUserAllowlist() 被调用；
//   T4  反向钉子：记录无 cwd 且 registry 无持久值时**必须仍然询问**（禁止有人改成
//       "无条件读盘"来绕过 cwd 作用域），此时不得读落盘白名单；
//   T4b 加固：记录缺字段但 registry 有持久值时，判据侧回退到持久值，不得静默失效；
//   T5  cwd 为空时拒绝写盘（冷恢复后"总是允许"写不进去的成因）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPendingRegistry, createSessionRules, permissionCategoryKey, resolveToolName } from '../lib/permission-state.js'
import { dangerousExecuteMatch } from '../lib/dangerous-commands.js'
import { evaluateRuleSources, inferredDirs, planGrantWrites, suggestedDirs, workspaceRuleOf } from '../lib/permission-rules.js'
import { extractPaths, scanPathsLoose } from '../lib/bridges/acp.js'
import { appendUserRule, readUserAllowlist } from '../lib/user-allowlist.js'
import { createUnknownSessionTracker } from '../lib/unknown-session-tracker.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(repoRoot, 'lib', 'index.js'), 'utf8')

/** 按起止标记切出原文（含闭合标记），找不到即断言失败——改坏结构会立刻暴露 */
function slice(startMarker, closeMarker, label) {
  const i = src.indexOf(startMarker)
  assert.ok(i >= 0, `lib/index.js 中找不到 "${startMarker}"（${label} 被改名或删除？）`)
  const j = src.indexOf(closeMarker, i)
  assert.ok(j > i, `${label} 找不到闭合标记 "${closeMarker}"（结构被改写）`)
  return src.slice(i, j + closeMarker.length)
}

const PH_SLICE = slice('const permissionHandler = async ({ product, sessionId, description, paths, toolCall }) => {', '\n  }\n', 'permissionHandler')
const PERSIST_SLICE = slice('const persistRemote = (childId, record, cwd) => {', '\n  }\n', 'persistRemote')

// permissionHandler 的自由变量（apply 闭包作用域）——逐项注入，漏一个就是 ReferenceError。
// 顺序必须与下方 new Function(...) 的实参顺序一致。
const PH_PARAMS = [
  'pendingDecisions', 'permissionCategoryKey', 'resolveToolName', 'dangerousExecuteMatch', 'ctx', 'providers',
  'evaluateRuleSources', 'workspaceRuleOf', 'bindings',
  'unknownSessionTracker', 'missingParentSessionIdWarned', 'sessionRules', 'readUserAllowlist',
  'isRoundRejected', 'addRoundRejected', 'appendUserRule', 'console',
  'planGrantWrites', 'suggestedDirs', 'inferredDirs', 'scanPathsLoose', 'takeDecisionPaths',
  'registry',
]

/**
 * 组装一个可执行的 permissionHandler。
 * @param {object} host
 * @param {Map} host.bindings 生产同构：childId -> {product, remote:{sessionId}, cwd?, parentSessionId?}
 * @param {object[]} [host.userRules] readUserAllowlist() 的返回值替身
 * @param {object} [host.registryEntry] registry.get(childId) 的返回值替身（加固回退测试用）
 * @param {(childId:string)=>any} [host.registryGet] registry.get 完全替身
 * @param {()=>void} [host.onRead] 观察落盘白名单是否真被读（cwd 作用域的可见证据）
 */
function handlerHarness(host = {}) {
  const events = []
  const logs = []
  const quiet = { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) }
  const readCalls = []
  const registry = createPendingRegistry()
  const pendingDecisions = {
    ...registry,
    add: (c, p, res) => registry.add(c, p, res),
    has: (c) => registry.has(c),
    size: (c) => registry.size(c),
    list: (c) => registry.list(c),
    settle: (c, p, a) => registry.settle(c, p, a),
    take: (c, p) => registry.take(c, p),
  }
  const [decisionPaths, decisionPathsKey, takeDecisionPaths] = new Function(
    `${slice('const decisionPaths = new Map()', '\n  }', 'decisionPaths 旁挂表')}\nreturn [decisionPaths, decisionPathsKey, takeDecisionPaths]`,
  )()
  const ctx = {
    emit: (name, payload) => events.push({ name, payload }),
    get: (name) => {
      if (name === 'agents') return { get: () => ({ session: { id: 'child-A' } }) }
      if (name === 'approval') return { effectivePolicy: () => 'ask', setPolicy: () => {}, request: () => new Promise(() => {}) }
      return null
    },
  }
  const registryStub = host.registryGet
    ? { get: host.registryGet }
    : { get: (id) => (host.registryEntry && id === (host.registryKey || CHILD) ? host.registryEntry : undefined) }
  const permissionHandler = new Function(...PH_PARAMS, `${PH_SLICE}\nreturn permissionHandler`)(
    pendingDecisions,
    permissionCategoryKey,
    resolveToolName,
    dangerousExecuteMatch,
    ctx,
    {},
    evaluateRuleSources,
    workspaceRuleOf,
    host.bindings || new Map(),
    createUnknownSessionTracker({ windowMs: 30000, threshold: 3, maxEntries: 100 }),
    new Set(),
    createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) }),
    (childId) => { readCalls.push(childId); return host.userRules || [] },
    () => false,
    () => {},
    () => ({ ok: true, count: 1 }),
    quiet,
    planGrantWrites,
    suggestedDirs,
    inferredDirs,
    scanPathsLoose,
    takeDecisionPaths,
    registryStub,
  )
  return {
    permissionHandler,
    readCalls,
    logs,
    pendingEvents: () => events.filter((e) => e.name === 'product-subagents/permission-pending').map((e) => e.payload),
    // 模拟用户在球上点「允许一次」（真实决策入口的另一半；这里只要把挂起的 promise 兑现）
    answer: (childId, permId, value = 'allow-once') => {
      const hit = registry.take(childId, permId)
      if (hit) hit.resolve(value)
      return !!hit
    },
  }
}

/** 冷恢复 harness：真实 registerProductSubmit + 假桥 + 假 registry */
function coldRecoveryHarness({ registryEntry, header = { cwd: '/fallback-header-cwd' }, reconnectResult = { sessionId: ACP_SESSION } } = {}) {
  const tools = new Map()
  const ctx = { tools: { register: (def) => tools.set(def.name, def) }, get: () => undefined, emit: () => {} }
  const bindings = new Map()
  const bridge = {
    create: async () => ({}),
    reconnect: async () => reconnectResult,
    submit: async () => ({ text: 'ok' }),
    dispose: async () => {},
  }
  registerProductSubmit(ctx, {
    bindings,
    MARKER: '[remote]',
    recoverRemoteSessionId: () => null,
    bridges: { qoder: bridge },
    registry: { get: (id) => (id === CHILD ? registryEntry : undefined), set: () => {} },
    persistRemote: () => {},
    cancelDispose: () => {},
    closedChildren: new Set(),
    emitBoundConfigOptions: () => {},
  })
  const agent = { session: { id: CHILD, header } }
  const run = () => tools.get('product_submit').execute({ task: '继续' }, { agent, signal: new AbortController().signal })
  return { run, bindings, bridge, agent }
}

const CHILD = 'de03e7e2-9f26-426f-bf8e-4836188e3c81'
const PARENT = 'session-a4257e24-34e6-454e-8a24-d9ae83bf206c'
const ACP_SESSION = 'a5effdce-467f-4515-9dc0-bcf9902f8931'

// 真实形态的执行类帧：命令只在 rawInput.command（qoder-cli 1.1.56 的权限帧）
const mkFrame = (command) => ({
  toolCallId: 'call_42ecf7cf6e1349efabc909a1',
  status: 'pending',
  title: command,
  kind: 'execute',
  content: [{ type: 'content', content: { type: 'text', text: command } }],
  rawInput: { command, description: 'Run build check', run_in_background: true, timeout: 600000 },
  _meta: { qoder: { toolName: 'Bash' } },
})

const OPTIONS = [
  { kind: 'allow_once', name: '允许一次', optionId: 'allow_once' },
  { kind: 'allow_always', name: '总是允许', optionId: 'allow_always' },
  { kind: 'reject_once', name: '拒绝', optionId: 'reject_once' },
]

const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'cold-rec-'))
const COMMAND = `cd ${PROJECT} && mkdir -p ${PROJECT}/out && echo DONE > ${PROJECT}/out/FINAL.txt`
const FRAME = mkFrame(COMMAND)
const USER_RULES = [{ cwd: PROJECT, product: 'qoder', paths: [PROJECT], tools: [], grantedAt: '2026-10-02T08:10:42.433Z' }]

describe('T1 冷恢复重建的 binding 记录必须含作用域字段', () => {
  it('T1 registry 有 cwd/parentSessionId ⇒ 记录原样带上（且 remote 用重连后的会话）', async () => {
    const h = coldRecoveryHarness({ registryEntry: { product: 'qoder', remoteId: ACP_SESSION, cwd: PROJECT, parentSessionId: PARENT } })
    await h.run()
    const rec = h.bindings.get(CHILD)
    assert.ok(rec, '冷恢复必须重新登记 binding')
    assert.equal(rec.cwd, PROJECT, '缺 cwd ⇒ permissionHandler 跳过落盘/工作区域档 ⇒ 每次请求都转人工')
    assert.equal(rec.parentSessionId, PARENT, '缺 parentSessionId ⇒ 会话档（本会话允许）跨回收失效')
    assert.equal(rec.remote.sessionId, ACP_SESSION)
  })

  it('T1 老 registry 条目（无 cwd/parentSessionId）⇒ 回退会话头，仍不得为空', async () => {
    const h = coldRecoveryHarness({
      registryEntry: { product: 'qoder', remoteId: ACP_SESSION },
      header: { cwd: PROJECT, parentSession: PARENT },
    })
    await h.run()
    const rec = h.bindings.get(CHILD)
    assert.equal(rec.cwd, PROJECT, 'registry 无 cwd 时必须回退会话头 cwd')
    assert.equal(rec.parentSessionId, PARENT, 'registry 无 parentSessionId 时必须回退会话头 parentSession')
  })

  it('T1b persistRemote 必须把 parentSessionId 一起落 registry', () => {
    const calls = []
    const persistRemote = new Function('registry', `${PERSIST_SLICE}\nreturn persistRemote`)({ set: (id, entry) => calls.push({ id, entry }) })
    persistRemote(CHILD, { product: 'qoder', remote: { sessionId: ACP_SESSION }, parentSessionId: PARENT }, PROJECT)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].entry.cwd, PROJECT)
    assert.equal(calls[0].entry.parentSessionId, PARENT, 'parentSessionId 不落盘 ⇒ 进程重启/冷恢复后会话档必然丢失')
  })
})

describe('T2 冷恢复记录 + 命中落盘规则 ⇒ 自动放行（现场缺陷的判据面）', () => {
  it('T2 冷恢复记录跑真实 permissionHandler：allow、不发 permission-pending、落盘白名单被读', async () => {
    const cold = coldRecoveryHarness({ registryEntry: { product: 'qoder', remoteId: ACP_SESSION, cwd: PROJECT, parentSessionId: PARENT } })
    await cold.run()
    const rec = cold.bindings.get(CHILD)
    const h = handlerHarness({ bindings: new Map([[CHILD, rec]]), userRules: USER_RULES })
    const paths = extractPaths(FRAME)
    assert.equal(paths[0], PROJECT, '前置：执行类帧必须能从 rawInput.command 扫出路径')
    assert.ok(paths.every((x) => x.startsWith(PROJECT)), '扫出的路径必须都落在本次命令的目标范围内')

    const promise = h.permissionHandler({ product: 'qoder', sessionId: ACP_SESSION, description: COMMAND, toolCall: FRAME, paths })
    const answer = await Promise.race([promise, new Promise((r) => setTimeout(() => r('__pending__'), 60))])
    if (answer === '__pending__') h.answer(CHILD, h.pendingEvents()[0].permId) // 修前路径：收拾挂起 promise
    assert.equal(answer, 'allow', '规则覆盖 ⇒ 必须自动放行（现场是弹球）')
    assert.equal(h.pendingEvents().length, 0, '自动放行时不得再发 permission-pending（= 黄球）')
    assert.ok(h.readCalls.length > 0, 'cwd 在场时才读落盘白名单；现场实测 0 次')
  })
})

describe('T4 反向钉子：缺 cwd 且无持久值 ⇒ 必须仍然询问（不许无条件读盘）', () => {
  it('T4 record 无 cwd/registry 无值 ⇒ 询问，且此时不得读落盘白名单', async () => {
    const bindings = new Map([[CHILD, { product: 'qoder', remote: { sessionId: ACP_SESSION }, settings: undefined }]])
    const h = handlerHarness({ bindings, userRules: USER_RULES })
    const promise = h.permissionHandler({ product: 'qoder', sessionId: ACP_SESSION, description: COMMAND, toolCall: FRAME, paths: extractPaths(FRAME) })
    const answer = await Promise.race([promise, new Promise((r) => setTimeout(() => r('__pending__'), 60))])
    assert.equal(answer, '__pending__', 'cwd 缺失时必须转人工（Ask），不得凭 paths 命中就放行')
    assert.equal(h.pendingEvents().length, 1, '必须发 permission-pending')
    assert.equal(h.readCalls.length, 0, 'cwd 缺失 ⇒ 落盘白名单不得被读（去掉 cwd 守卫会立刻变红）')
    // 收拾挂起的 promise（模拟用户点「允许一次」），并顺手钉住"询问后仍能正常决议"
    assert.equal(h.answer(CHILD, h.pendingEvents()[0].permId), true)
    assert.equal(await promise, 'allow')
  })

  it('T4b 加固：记录缺字段但 registry 有持久值 ⇒ 回退命中，仍自动放行', async () => {
    const bindings = new Map([[CHILD, { product: 'qoder', remote: { sessionId: ACP_SESSION }, settings: undefined }]])
    const h = handlerHarness({
      bindings,
      userRules: USER_RULES,
      registryEntry: { product: 'qoder', remoteId: ACP_SESSION, cwd: PROJECT, parentSessionId: PARENT },
    })
    const promise = h.permissionHandler({ product: 'qoder', sessionId: ACP_SESSION, description: COMMAND, toolCall: FRAME, paths: extractPaths(FRAME) })
    const answer = await Promise.race([promise, new Promise((r) => setTimeout(() => r('__pending__'), 60))])
    if (answer === '__pending__') h.answer(CHILD, h.pendingEvents()[0].permId) // 修前路径：收拾挂起 promise
    assert.equal(answer, 'allow', 'binding 记录少字段时判据侧必须回退 registry，不得静默失效')
    assert.equal(h.pendingEvents().length, 0)
  })
})

describe('T5 cwd 为空时拒绝写盘', () => {
  it('T5 冷恢复记录点「总是允许（项目内）」：null cwd ⇒ 拒绝且不落文件', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cold-ual-'))
    assert.equal(existsSync(path.join(dir, 'allowlist.json')), false)
    const rejected = appendUserRule({ cwd: null, product: 'qoder', paths: [PROJECT], tools: [] }, dir)
    assert.equal(rejected.ok, false, 'cwd 为空必须拒绝写盘（现场"总是允许"点了也无效的成因）')
    assert.equal(rejected.error, 'cwd 或 paths/tools 缺失')
    assert.equal(existsSync(path.join(dir, 'allowlist.json')), false, '拒绝时不得留下文件')
    const ok = appendUserRule({ cwd: PROJECT, product: 'qoder', paths: [PROJECT], tools: [] }, dir)
    assert.equal(ok.ok, true, '对照：有 cwd 时必须能写入')
    assert.equal(readUserAllowlist(dir).length, 1)
    rmSync(dir, { recursive: true, force: true })
  })
})

rmSync(PROJECT, { recursive: true, force: true })
