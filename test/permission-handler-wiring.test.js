// v0.6.2 返工：授权链路**真实接线**测试（M1 / M2 / M3② / m5 / D 的行为面）。
//
// 上一轮评审指出：状态层单测（test/permission-state.test.js）只证明了两个纯函数
// 自洽，没有证明 `lib/index.js` 里的 `permissionHandler` 真的按那个契约收发事件。
// 本文件把生产源码原样抠出来执行（编译对象是本仓库第一方源码，仅测试进程内），
// 断言的是**事件载荷形态**与**决议归属**，不是复刻实现。
//
// lib/index.js 是 ESM 插件模块，`permissionHandler` 是 apply() 内的闭包，且真实
// 调用点在 ACP 桥接层（起产品会话才能触达，本次禁止）。故沿用仓库既有做法：
// 按源码标记切出该闭包，注入替身依赖后执行——替身只有 ctx/审批通道/绑定表，
// 挂起登记表与会话规则用的是**生产实现**（lib/permission-state.js）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPendingRegistry, createSessionRules, permissionCategoryKey, resolveToolName } from '../lib/permission-state.js'
import { dangerousExecuteMatch, dangerPatternsPath, resetDangerPatternsCache } from '../lib/dangerous-commands.js'
import { evaluateRuleSources, inferredDirs, planGrantWrites, suggestedDirs, workspaceRuleOf } from '../lib/permission-rules.js'
import { extractPaths, extractStructuredPaths, scanPathsLoose } from '../lib/bridges/acp.js'
import { appendUserRule, readUserAllowlist } from '../lib/user-allowlist.js'
import { allowlistDecision, expandPathsWithParents } from '../lib/allowlist.js'
import { createUnknownSessionTracker } from '../lib/unknown-session-tracker.js'

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

// ── 生产源码切片 ──────────────────────────────────────────────────────────────

const PH_START = 'const permissionHandler = async ({ product, sessionId, description, paths, toolCall }) => {'
const PH_SLICE = slice(PH_START, '\n  }\n', 'permissionHandler')
const SETTLE_ALL_SLICE = slice('const settleAllPending = (childId, answer) => {', '\n  }', 'settleAllPending')
const WAIT_SLICE = slice('const isHumanWaitPending = (sessionIdOrThreadId) => {', '\n  }', 'isHumanWaitPending')
const DECISION_SLICE = slice("ctx.on('product-subagents/permission-decision', (info) => {", '\n    }', 'permission-decision 订阅')
const CHILD_END_SLICE = slice("ctx.on('subagent/end', (info) => {", '\n  }', 'subagent/end 订阅')
// v0.7.9 缺口A：决策附带目录的旁挂表（declaration 三连）直接从生产源码切出原样执行，
// 不在此复刻——否则"表写没写、消费即删"这些行为就变成测试自己的断言了。
const DECISION_PATHS_SLICE = slice('const decisionPaths = new Map()', '\n  }', 'decisionPaths 旁挂表')

// permissionHandler 的自由变量（apply 闭包作用域）——逐项注入，漏一个就是 ReferenceError
const PH_PARAMS = [
  'pendingDecisions', 'permissionCategoryKey', 'resolveToolName', 'dangerousExecuteMatch', 'ctx', 'providers',
  'evaluateRuleSources', 'workspaceRuleOf', 'bindings',
  'unknownSessionTracker', 'missingParentSessionIdWarned', 'sessionRules', 'readUserAllowlist',
  'isRoundRejected', 'addRoundRejected', 'appendUserRule', 'console',
  // v0.7.9 缺口A/B/D 修正：写入档位判定点、弹框预填目录、正文推测目录（推测预填档）、
  // 决策附带目录的取用
  'planGrantWrites', 'suggestedDirs', 'inferredDirs', 'scanPathsLoose', 'takeDecisionPaths',
]

/**
 * 组装一个可执行的 permissionHandler。
 * @param {object} host
 * @param {Map} host.bindings 生产同构：childId -> {remote:{sessionId}, cwd, parentSessionId, product}
 * @param {(p:object)=>void} host.onPending / host.onResolved 事件收口
 * @param {Function|undefined} host.request approval.request 替身
 * @param {object} [host.rules] 会话规则表（默认生产实现）
 * @param {Function} [host.resolveToolName] 工具名解析替身（默认生产实现；
 *   仅在需要复现"修复前行为"做双向断言时注入，注入体必须是生产逻辑的逐字复刻）
 * @param {Function} [host.dangerousExecuteMatch] 危险命令门替身（默认生产实现；
 *   注入 `() => null` 即复现 0.7.9 之前"工具名授权把 rm -rf 也放行"的行为）
 * @param {object[]} [host.userRules] 落盘规则（readUserAllowlist 的返回值替身；
 *   默认 `[]`，v0.7.9 用来测磁盘规则与老文件兼容——只给内存数组，不碰真实 ~/.dsh）
 * @param {(paths:string[])=>string[]} [host.expand] 会话规则写入侧的路径展开器
 *   （默认恒等；传生产 `expandPathsWithParents` 才能验证"文件路径落父目录"）
 * @param {(toolCall:object)=>string[]} [host.scanPathsLoose] 正文文本扫描替身
 *   （默认生产实现；注入 `() => { throw new Error() }` 可验证推测档失败不拖垮弹窗）
 */
function harness(host = {}) {
  const events = []
  const logs = []
  const quiet = { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) }
  const registry = createPendingRegistry()
  // 观察每条挂起请求的 resolve 被**什么值**兑现（M1/M2 的判定面就在这里）
  const settled = []
  const pendingDecisions = {
    ...registry,
    add(childId, permId, resolve) {
      return registry.add(childId, permId, (answer) => {
        settled.push({ childId: String(childId), permId, answer })
        resolve(answer)
      })
    },
    has: (c) => registry.has(c),
    size: (c) => registry.size(c),
    list: (c) => registry.list(c),
    settle: (c, p, a) => registry.settle(c, p, a),
    take: (c, p) => registry.take(c, p),
  }
  const bindings = host.bindings || new Map()
  // v0.7.9 缺口A：生产旁挂表原样执行（登记/消费即删都是真代码）
  const [decisionPaths, decisionPathsKey, takeDecisionPaths] = new Function(
    `${DECISION_PATHS_SLICE}\nreturn [decisionPaths, decisionPathsKey, takeDecisionPaths]`,
  )()
  const ctx = {
    emit: (name, payload) => { events.push({ name, payload }) },
    get: (name) => {
      if (name === 'agents') return { get: () => (host.agent === undefined ? { session: { id: 'child-A' } } : host.agent) }
      if (name === 'approval') return host.noApproval ? null : {
        effectivePolicy: () => 'ask',
        setPolicy: () => {},
        request: host.request || (() => new Promise(() => {})),
      }
      return null
    },
  }
  const permissionHandler = new Function(
    ...PH_PARAMS,
    `${PH_SLICE}\nreturn permissionHandler`,
  )(
    pendingDecisions,
    permissionCategoryKey,
    host.resolveToolName || resolveToolName,
    host.dangerousExecuteMatch || dangerousExecuteMatch,
    ctx,
    host.providers || {},
    evaluateRuleSources,
    workspaceRuleOf,
    bindings,
    createUnknownSessionTracker({ windowMs: 30000, threshold: 3, maxEntries: 100 }),
    new Set(),
    host.rules || createSessionRules({ expand: host.expand || ((p) => (Array.isArray(p) ? p : [])) }),
    () => host.userRules || [],
    () => false,
    () => {},
    host._appendUserRule || (() => ({ ok: true, count: 1 })),
    quiet,
    planGrantWrites,
    host.suggestedDirs || suggestedDirs,
    inferredDirs,
    host.scanPathsLoose || scanPathsLoose,
    takeDecisionPaths,
  )
  // 真实决策入口：apply() 里注册的那个回调（含"未知 permId 忽略"分支）
  const onDecision = new Function(
    'pendingDecisions', 'console', 'decisionPaths', 'decisionPathsKey',
    `${DECISION_SLICE.replace("ctx.on('product-subagents/permission-decision', ", 'return ')}`,
  )(pendingDecisions, quiet, decisionPaths, decisionPathsKey)
  // 真实的回合结束回调（M2）：注入同一份挂起表与 isHumanWaitPending 判定
  const isHumanWaitPending = new Function(
    'bindings', 'pendingDecisions', 'pendingQuestions',
    `${WAIT_SLICE}\nreturn isHumanWaitPending`,
  )(bindings, pendingDecisions, new Map())
  const settleAllPending = new Function(
    'pendingDecisions',
    `${SETTLE_ALL_SLICE}\nreturn settleAllPending`,
  )(pendingDecisions)
  const onChildEnd = new Function(
    'clearRoundRejected', 'missingParentSessionIdWarned', 'settleAllPending', 'pendingDecisions', 'bindings', 'scheduleDispose', 'state', 'console',
    `${CHILD_END_SLICE.replace("ctx.on('subagent/end', ", 'return ')}`,
  )(
    () => {},
    new Set(),
    settleAllPending,
    pendingDecisions,
    bindings,
    () => {},
    { activeChildren: 1 },
    quiet,
  )
  return {
    permissionHandler, onDecision, onChildEnd, isHumanWaitPending, events, logs, settled,
    registry, bindings, decisionPaths,
    pendingEvents: () => events.filter((e) => e.name === 'product-subagents/permission-pending').map((e) => e.payload),
    resolvedEvents: () => events.filter((e) => e.name === 'product-subagents/permission-resolved').map((e) => e.payload),
  }
}

/** child 绑定：remote.sessionId 是 ACP 侧会话 id（权限请求带进来的那个） */
function bound(childId = 'child-A', remote = { sessionId: 'acp-1' }, extra = {}) {
  const map = new Map()
  map.set(childId, { product: extra.product || 'qoder', remote, cwd: extra.cwd || '/proj', parentSessionId: extra.parentSessionId || 'parent-1' })
  return map
}

const REQ = { product: 'qoder', sessionId: 'acp-1', description: 'Allow searching the web?', toolCall: { toolCallId: 'tc-1', kind: 'other', title: 'web_search' }, paths: [] }

const flush = async (n = 30) => { for (let i = 0; i < n; i += 1) await Promise.resolve() }

describe('真实接线：permission-pending 载荷与决议归属', () => {
  it('挂起事件带 permId（toolCallId 前缀）与 category；resolved 归属到 child 会话', async () => {
    const h = harness({ bindings: bound() })
    const p = h.permissionHandler(REQ)
    await flush()
    const pending = h.pendingEvents()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].childId, 'child-A')
    assert.equal(pending[0].permId, 'tc-1#1', 'permId 必须由产品侧 toolCallId 生成并回传')
    assert.equal(pending[0].category, 'qoder:web_search')
    assert.equal(pending[0].parentSessionId, 'parent-1')

    // 用户点「允许一次」→ 走 apply() 里真正注册的那个回调
    h.onDecision({ childId: 'child-A', permId: pending[0].permId, answer: 'allow-once' })
    assert.equal(await p, 'allow', '允许一次必须以 allow 回给 ACP')
    assert.deepEqual(h.settled, [{ childId: 'child-A', permId: 'tc-1#1', answer: 'allow-once' }])
    const resolved = h.resolvedEvents()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].childId, 'child-A', 'resolved 的 childId 取自绑定表，不是请求参数')
    assert.equal(resolved[0].permId, 'tc-1#1')
    assert.equal(resolved[0].outcome, 'allowed-once')
  })

  it('并发 2 条请求：各自独立决议，决策互不串台', async () => {
    const h = harness({ bindings: bound() })
    const p1 = h.permissionHandler({ ...REQ, toolCall: { toolCallId: 'tc-1', title: 'web_search' } })
    const p2 = h.permissionHandler({ ...REQ, toolCall: { toolCallId: 'tc-2', title: 'external_directory' }, paths: ['/etc/hosts'] })
    await flush()
    const [a, b] = h.pendingEvents()
    assert.equal(h.registry.size('child-A'), 2, '同一 child 的两条请求都必须挂起')
    h.onDecision({ childId: 'child-A', permId: b.permId, answer: 'allow-once' })
    assert.equal(await p2, 'allow')
    assert.equal(h.registry.size('child-A'), 1, '决议一条不得带走另一条')
    h.onDecision({ childId: 'child-A', permId: a.permId, answer: 'deny' })
    assert.equal(await p1, 'deny')
    assert.equal(h.registry.has('child-A'), false)
  })

  it('老 payload（决策不带 permId）→ 仍按 FIFO 决议最早一条', async () => {
    const h = harness({ bindings: bound() })
    const p = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', answer: 'allow-once' }) // 旧版 client 无 permId
    assert.equal(await p, 'allow')
    assert.equal(h.settled[0].permId, 'tc-1#1')
    assert.match(h.logs.join('\n'), /决策未带 permId，按 FIFO/, '降级必须留痕')
  })

  it('未知 permId 的决策 → 忽略，绝不顶替别的请求（M3）', async () => {
    const h = harness({ bindings: bound() })
    const p = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: 'tc-9#99', answer: 'allow-always' })
    await flush()
    assert.deepEqual(h.settled, [], '未命中的 permId 不得兑现任何一条挂起请求')
    assert.equal(h.registry.size('child-A'), 1, '登记必须还在，等真正的决策')
    assert.match(h.logs.join('\n'), /未命中该 child 的任何挂起请求.*→ 忽略/s)
    const [pending] = h.pendingEvents()
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'deny' })
    assert.equal(await p, 'deny')
  })
})

describe('M1 审批通道抛错：按钮通道必须被兑现', () => {
  it('approval.request 同步抛错 → buttonAnswer 以 deny 兑现 + 广播 resolved（不留悬空请求）', async () => {
    const h = harness({
      bindings: bound(),
      request: () => { throw new Error('no open turn') },
    })
    const decision = h.permissionHandler(REQ)
    assert.equal(await decision, 'deny', 'fail-closed：审批通道异常按拒绝处理')
    assert.equal(h.settled.length, 1, 'buttonAnswer 必须被兑现（旧实现只摘表 → ACP 侧永久悬等）')
    assert.equal(h.settled[0].answer, 'deny')
    assert.equal(h.registry.has('child-A'), false)
    const resolved = h.resolvedEvents()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].outcome, 'error')
    assert.equal(resolved[0].childId, 'child-A')
  })

  it('无绑定的未知会话 → deny 且不产生挂起登记', async () => {
    const h = harness({ bindings: new Map() })
    assert.equal(await h.permissionHandler(REQ), 'deny')
    assert.deepEqual(h.pendingEvents(), [])
    assert.equal(h.settled.length, 0)
  })
})

describe('M2 subagent/end：挂起审批兑现并解除豁免', () => {
  it('回合结束时尚有未决请求 → 兑现 deny、表清空、人类决策豁免解除', async () => {
    const h = harness({ bindings: bound() })
    const p = h.permissionHandler(REQ)
    await flush()
    assert.equal(h.registry.has('child-A'), true)
    assert.equal(h.isHumanWaitPending('acp-1'), true, '等待人类决策期间应豁免看门狗/空闲回收')
    h.onChildEnd({ id: 'child-A', stopReason: 'aborted' })
    assert.equal(await p, 'deny')
    assert.deepEqual(h.settled, [{ childId: 'child-A', permId: 'tc-1#1', answer: 'deny' }])
    assert.equal(h.registry.has('child-A'), false, '旧实现这里永不清空 → 该会话永久豁免回收')
    assert.equal(h.isHumanWaitPending('acp-1'), false, '豁免判定必须随之转 false')
    assert.equal(h.resolvedEvents().length, 1, '授权球那一行要靠 resolved 事件消失')
    assert.match(h.logs.join('\n'), /回合结束时尚有 1 条权限请求未决/)
  })

  it('无挂起时 subagent/end 不误报、不抛', () => {
    const h = harness({ bindings: bound() })
    assert.doesNotThrow(() => h.onChildEnd({ id: 'child-A' }))
    assert.deepEqual(h.settled, [])
    assert.equal(h.logs.join('\n').includes('回合结束时尚有'), false)
    assert.doesNotThrow(() => h.onChildEnd({}))
    assert.doesNotThrow(() => h.onChildEnd(null))
  })
})

describe('m5 执行类无路径请求：不许按类别记忆', () => {
  const BASH = { product: 'qoder', sessionId: 'acp-1', description: '执行命令：rm -rf build', toolCall: { toolCallId: 'tc-b', kind: 'other', title: 'bash' }, paths: [] }

  it('点「本会话总是允许」→ 类别规则不写，但工具名授权生效，同会话内同名工具自动放行', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p = h.permissionHandler(BASH)
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.category, 'qoder:bash', '类别指纹仍要照常透出（展示用）')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p, 'allow', '本次仍按用户意愿放行')
    assert.equal(rules.size('parent-1'), 0, '执行类路径/类别规则一律不得记忆')
    assert.match(h.logs.join('\n'), /工具名授权.*bash.*同会话内同名工具自动放行/s, '日志应反映工具名授权生效')
    // v0.7.5：第二次请求命中工具名授权，预检直接放行（不再弹窗）
    const p2 = h.permissionHandler(BASH)
    assert.equal(await p2, 'allow', 'v0.7.5：工具名授权生效，同会话内同名工具预检直接放行')
  })

  it('对照：非执行类（web_search）无路径请求仍可记忆', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p, 'allow')
    assert.equal(rules.size('parent-1'), 1)
    assert.equal(await h.permissionHandler(REQ), 'allow', '同类第二次请求自动放行，不再询问')
    assert.equal(h.pendingEvents().length, 1, '第二次不得再发 pending 事件')
  })
})

describe('源码不变量（防止链路被悄悄改回旧形态）', () => {
  it('catch 分支用 settle 而非 take（take 只摘表、不兑现 promise）', () => {
    const catchBlock = PH_SLICE.slice(PH_SLICE.lastIndexOf('catch (error)'))
    assert.match(catchBlock, /pendingDecisions\.settle\(resolvedChildId, permId, 'deny'\)/)
    assert.doesNotMatch(catchBlock, /pendingDecisions\.take\(/, '决议兜底不得再用 take')
  })

  it('subagent/end 必须清理挂起表', () => {
    assert.match(CHILD_END_SLICE, /settleAllPending\(info\.id, 'deny'\)/)
  })

  it('permission-decision 未命中时不得回退 FIFO', () => {
    assert.match(DECISION_SLICE, /if \(!taken\) \{[\s\S]*?\}/)
    assert.doesNotMatch(DECISION_SLICE, /settle\(childId, null/, '不得把 permId 抹成空再触发 FIFO')
  })
})

// ── v0.7.5：会话级工具名授权集成测试 ──────────────────────────────────────────

describe('v0.7.6 会话级工具名授权：预检直接放行，不进弹窗', () => {
  const REQ_WRITE = {
    product: 'qoder', sessionId: 'acp-1',
    description: 'Allow writing file?',
    toolCall: { toolCallId: 'tc-w', name: 'Write', kind: 'write', title: 'edit' },
    paths: ['/tmp/file1.txt'],
  }
  const REQ_WRITE_DIFF_PATH = {
    product: 'qoder', sessionId: 'acp-1',
    description: 'Allow writing another file?',
    toolCall: { toolCallId: 'tc-w2', name: 'Write', kind: 'write', title: 'edit' },
    paths: ['/tmp/file2.txt'],
  }
  const REQ_READ = {
    product: 'qoder', sessionId: 'acp-1',
    description: 'Allow reading file?',
    toolCall: { toolCallId: 'tc-r', name: 'Read', kind: 'read', title: 'read' },
    paths: ['/etc/hosts'],
  }

  it('allow-session 后，不同路径的同名工具请求预检直接放行（不弹窗）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(REQ_WRITE)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, 'Write', 'permission-pending 必须带 toolName')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(await h.permissionHandler(REQ_WRITE_DIFF_PATH), 'allow', '不同路径同名工具必须预检直接放行')
    assert.equal(h.pendingEvents().length, 1, '第二次不得再发 pending 事件')
  })

  it('未授权工具仍走原路径（弹窗/授权球）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(REQ_WRITE)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const p2 = h.permissionHandler(REQ_READ)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '未授权工具必须再发 pending 事件')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('跨产品隔离：qoder 授权后 opencode 同名工具必须弹球（B2 验收）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const bindingsMap = new Map()
    bindingsMap.set('child-A', { product: 'qoder', remote: { sessionId: 'acp-1' }, cwd: '/proj', parentSessionId: 'parent-1' })
    bindingsMap.set('child-B', { product: 'opencode', remote: { sessionId: 'acp-2' }, cwd: '/proj2', parentSessionId: 'parent-1' })
    const h = harness({ bindings: bindingsMap, rules })
    // qoder 授权 bash
    const BASH_QODER = {
      product: 'qoder', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-bq', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const p1 = h.permissionHandler(BASH_QODER)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // opencode 的 bash 必须仍弹球
    const BASH_OPENCODE = {
      product: 'opencode', sessionId: 'acp-2',
      description: 'Run bash command',
      toolCall: { toolCallId: 'tc-bo', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const p2 = h.permissionHandler(BASH_OPENCODE)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '跨产品同名工具必须再发 pending 事件')
    h.onDecision({ childId: 'child-B', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('占位 toolName 不产生工具名授权（B1 验收）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const OTHER_REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: 'Some operation',
      toolCall: { toolCallId: 'tc-ot', kind: 'other', title: 'other' },
      paths: ['/tmp/a.txt'],
    }
    const p1 = h.permissionHandler(OTHER_REQ)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, null, 'toolName 应为 null（占位值不可用于授权）')
    assert.equal(pending1.rawToolName, 'other', 'rawToolName 仍要透出（展示用）')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // 占位 toolName 授权后，同名请求必须仍弹球
    const OTHER_REQ_2 = {
      product: 'qoder', sessionId: 'acp-1',
      description: 'Another operation',
      toolCall: { toolCallId: 'tc-ot2', kind: 'other', title: 'other' },
      paths: ['/etc/sudoers'],
    }
    const p2 = h.permissionHandler(OTHER_REQ_2)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '占位 toolName 授权后同名请求必须仍弹球')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('toolName 缺失时不误放行（退化为现有行为）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(REQ_WRITE)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const NO_TOOL_NAME = {
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow something?',
      toolCall: { toolCallId: 'tc-nt', kind: 'other' },
      paths: [],
    }
    const p2 = h.permissionHandler(NO_TOOL_NAME)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '无 toolName 的请求不得被预检放行')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('会话销毁后工具名授权失效', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(REQ_WRITE)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    rules.dispose('parent-1')
    const p2 = h.permissionHandler(REQ_WRITE_DIFF_PATH)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '会话销毁后不得预检放行')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('permission-pending 载荷新增 toolName 且老字段不变', async () => {
    const h = harness({ bindings: bound() })
    const p = h.permissionHandler(REQ_WRITE)
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.childId, 'child-A')
    assert.equal(pending.permId, 'tc-w#1')
    assert.equal(pending.product, 'qoder')
    assert.equal(pending.description, 'Allow writing file?')
    assert.deepEqual(pending.paths, ['/tmp/file1.txt'])
    assert.equal(pending.category, 'qoder:edit')
    assert.equal(pending.parentSessionId, 'parent-1')
    assert.equal(pending.toolName, 'Write')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-once' })
    assert.equal(await p, 'allow')
  })

  it('permission-pending toolName 取值优先级：name → toolName → title（仅 TOOL_NAME_SLUGS 收录的 title 可授权）', async () => {
    const h = harness({ bindings: bound() })
    const p1 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1', description: 'test',
      toolCall: { toolCallId: 'tc-1', name: 'ToolA', toolName: 'ToolB', title: 'bash' },
      paths: [],
    })
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, 'ToolA', 'name 优先')
    assert.equal(h.pendingEvents()[0].rawToolName, 'ToolA')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'deny' })
    await p1
    const p2 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1', description: 'test',
      toolCall: { toolCallId: 'tc-2', toolName: 'ToolB', title: 'edit' },
      paths: [],
    })
    await flush()
    assert.equal(h.pendingEvents()[1].toolName, 'ToolB', 'toolName 次之')
    assert.equal(h.pendingEvents()[1].rawToolName, 'ToolB')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    await p2
    // title 在 TOOL_NAME_SLUGS 中 → 可授权
    const p3 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1', description: 'test',
      toolCall: { toolCallId: 'tc-3', title: 'bash' },
      paths: [],
    })
    await flush()
    assert.equal(h.pendingEvents()[2].toolName, 'bash', 'title 在 TOOL_NAME_SLUGS 中 → 可授权')
    assert.equal(h.pendingEvents()[2].toolNameSource, 'title(TOOL_NAME_SLUGS)')
    assert.equal(h.pendingEvents()[2].rawToolName, 'bash')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[2].permId, answer: 'deny' })
    await p3
    // title 不在 TOOL_NAME_SLUGS 中（如 ToolC）→ 不可授权，toolName=null
    const p4 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1', description: 'test',
      toolCall: { toolCallId: 'tc-4', title: 'ToolC' },
      paths: [],
    })
    await flush()
    assert.equal(h.pendingEvents()[3].toolName, null, 'title 不在 TOOL_NAME_SLUGS → 不可授权')
    assert.equal(h.pendingEvents()[3].rawToolName, 'ToolC', 'rawToolName 仍透出原始值')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[3].permId, answer: 'deny' })
    await p4
  })

  it('allow-always 同时写入会话级工具名授权', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(REQ_WRITE)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    assert.equal(await h.permissionHandler(REQ_WRITE_DIFF_PATH), 'allow', 'allow-always 后同会话内不同路径同名工具应预检放行')
  })

  it('执行类工具 allow-session 后工具名授权生效（路径/类别不记忆，但工具名记忆）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const BASH_REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-b', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const BASH_REQ_2 = {
      product: 'qoder', sessionId: 'acp-1',
      description: '执行命令：pwd',
      toolCall: { toolCallId: 'tc-b2', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const p1 = h.permissionHandler(BASH_REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.size('parent-1'), 0, '执行类路径/类别不得记忆')
    assert.equal(await h.permissionHandler(BASH_REQ_2), 'allow', '执行类工具名授权应生效，预检直接放行')
  })
})

describe('v0.7.7 M4: bindParentSessionId 缺失时工具名授权不写入 + warn 去重', () => {
  function boundNoParent(childId = 'child-A', remote = { sessionId: 'acp-1' }, extra = {}) {
    const map = new Map()
    map.set(childId, { product: extra.product || 'qoder', remote, cwd: extra.cwd || '/proj', parentSessionId: null })
    return map
  }

  it('bindParentSessionId=null 时 allow-session 不写入工具名授权、warn 按 childId 去重', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: boundNoParent(), rules })
    const REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '执行命令',
      toolCall: { toolCallId: 'tc-1', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const p1 = h.permissionHandler(REQ)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, 'bash')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const warnLogs = h.logs.filter((l) => l.includes('缺少主代理会话 id'))
    assert.equal(warnLogs.length, 1, '第一次 warn 必须出现且仅一条')
    assert.ok(warnLogs[0].includes('bash'), 'warn 必须提及工具名')
    assert.equal(rules.toolGrantCovers(null, 'qoder', 'bash'), false, 'null parentSessionId 不得写入授权')
    const p2 = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'allow-session' })
    assert.equal(await p2, 'allow')
    const warnLogs2 = h.logs.filter((l) => l.includes('缺少主代理会话 id'))
    assert.equal(warnLogs2.length, 1, '同 childId 第二次不得再出 warn（去重）')
  })

  it('bindParentSessionId=null 时 allow-always 失败日志不得出现「已写入」', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const appendFail = () => ({ ok: false, error: 'cwd 或 paths 缺失' })
    const h = harness({ bindings: boundNoParent(), rules, _appendUserRule: appendFail })
    const REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-w', name: 'Write', kind: 'write', title: 'edit' },
      paths: ['/tmp/file.txt'],
    }
    const p1 = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    const errorLogs = h.logs.filter((l) => l.includes('落盘失败'))
    assert.equal(errorLogs.length, 1)
    assert.ok(!errorLogs[0].includes('已写入'), '落盘失败 + null parentSessionId 日志不得出现「已写入」')
  })

  it('bindParentSessionId 存在 + 占位 toolName=other + 落盘失败 → 日志不得出现「已写入」', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const appendFail = () => ({ ok: false, error: 'cwd 或 paths 缺失' })
    const h = harness({ bindings: bound(), rules, _appendUserRule: appendFail })
    const REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: 'Some operation',
      toolCall: { toolCallId: 'tc-ot', kind: 'other', title: 'other' },
      paths: ['/tmp/a.txt'],
    }
    const p1 = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    const errorLogs = h.logs.filter((l) => l.includes('落盘失败'))
    assert.equal(errorLogs.length, 1)
    assert.ok(!errorLogs[0].includes('已写入'), '占位 toolName=other + 落盘失败，日志不得出现「已写入」')
  })

  it('bindParentSessionId 存在 + 有效 toolName + 落盘失败 → 日志应说「已写入」', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const appendFail = () => ({ ok: false, error: 'cwd 或 paths 缺失' })
    const h = harness({ bindings: bound(), rules, _appendUserRule: appendFail })
    const REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-w', name: 'Write', kind: 'write', title: 'edit' },
      paths: ['/tmp/file.txt'],
    }
    const p1 = h.permissionHandler(REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    const errorLogs = h.logs.filter((l) => l.includes('落盘失败'))
    assert.equal(errorLogs.length, 1)
    assert.ok(errorLogs[0].includes('已写入'), '有效 toolName + 有 parentSessionId + 落盘失败，日志应说「已写入」')
    // v0.7.9：统一模型下工具名档要求「规则 cwd === 请求 cwd」，授权是按 binding
    // 的 cwd='/proj' 写进去的，查询侧自然也要带同一个 cwd。
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write', '/proj'), true, '工具名授权确实已写入')
  })

  it('M4 不影响其它工具的正常弹窗与决策', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: boundNoParent(), rules })
    const BASH_REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '执行命令',
      toolCall: { toolCallId: 'tc-1', name: 'bash', kind: 'other', title: 'bash' },
      paths: [],
    }
    const READ_REQ = {
      product: 'qoder', sessionId: 'acp-1',
      description: '读取文件',
      toolCall: { toolCallId: 'tc-2', name: 'Read', kind: 'read', title: 'read' },
      paths: ['/etc/hosts'],
    }
    const p1 = h.permissionHandler(BASH_REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const p2 = h.permissionHandler(READ_REQ)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '其它工具必须仍弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })
})

describe('v0.7.8 L1/L2/L3 三级降级', () => {
  function bound(childId = 'child-A', remote = { sessionId: 'acp-1' }, extra = {}) {
    const map = new Map()
    map.set(childId, { product: extra.product || 'opencode', remote, cwd: extra.cwd || '/proj', parentSessionId: 'parent-1' })
    return map
  }

  it('L1: external_directory 类别 slug 不作为工具名授权（权限范围，非工具）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const EXT_DIR_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '工作区外路径操作',
      toolCall: { toolCallId: 'tc-ed', title: 'external_directory' },
      paths: ['/outside/some/file.txt'],
    }
    const p1 = h.permissionHandler(EXT_DIR_REQ)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, null, 'external_directory 不在 TOOL_NAME_SLUGS → toolName=null')
    assert.equal(pending1.rawToolName, 'external_directory', 'rawToolName 仍透出原始 title')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // 同会话内再次请求不同路径的 external_directory → 必须仍弹球
    // （L2 路径记忆生效，但只覆盖 /outside/some/ 及其父目录，
    //   完全不同的路径 /outside/COMPLETELY/DIFFERENT 仍弹）
    const EXT_DIR_REQ_2 = {
      product: 'opencode', sessionId: 'acp-1',
      description: '另一工作区外路径操作',
      toolCall: { toolCallId: 'tc-ed2', title: 'external_directory' },
      paths: ['/outside/COMPLETELY/DIFFERENT/file.txt'],
    }
    const p2 = h.permissionHandler(EXT_DIR_REQ_2)
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'external_directory 不同路径必须仍弹球（无工具名授权）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('L1: doom_loop 类别 slug 不作为工具名授权（保护机制，非工具）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const DOOM_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '循环保护触发',
      toolCall: { toolCallId: 'tc-dl', title: 'doom_loop' },
      paths: [],
    }
    const p1 = h.permissionHandler(DOOM_REQ)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, null, 'doom_loop 不在 TOOL_NAME_SLUGS → toolName=null')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // L3: 无路径 + 无工具名 → 不写入任何授权，下次仍弹球
    const DOOM_REQ_2 = {
      product: 'opencode', sessionId: 'acp-1',
      description: '循环保护再触发',
      toolCall: { toolCallId: 'tc-dl2', title: 'doom_loop' },
      paths: [],
    }
    const p2 = h.permissionHandler(DOOM_REQ_2)
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'doom_loop 无路径无工具名 → L3 不写入授权，必须仍弹球')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  // L2 用例必须用**生产** expand：L2 的语义就是"沿用既有 cover() 前缀语义"，
  // 而该语义包含 expandPathsWithParents 补父目录（lib/allowlist.js:126）。
  // 注入 identity expand 会让兄弟路径覆盖不了，测的不再是 L2 而是 expand 本身。
  it('L2: toolName 不可解析但有路径 → 只写路径级记忆，不同路径仍弹球', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const EXT_DIR_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '工作区外路径操作',
      toolCall: { toolCallId: 'tc-ed', title: 'external_directory' },
      paths: ['/outside/some/file.txt'],
    }
    const p1 = h.permissionHandler(EXT_DIR_REQ)
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, null, 'external_directory → L1 不命中')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // L2 写入面：只写了一条路径规则，既不写工具名授权也不写类别规则
    assert.equal(rules.size('parent-1'), 1, 'L2: 写入一条路径级会话规则')
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'L2: 未写入工具名授权')
    assert.equal(
      rules.cover('parent-1', [], 'opencode:external_directory'),
      false,
      'L2: 未写入类别规则——否则无路径的 external_directory 请求会被整体放行',
    )
    // 同路径/子路径 → 路径记忆命中（L2）
    const EXT_DIR_REQ_SAME = {
      product: 'opencode', sessionId: 'acp-1',
      description: '同目录下操作',
      toolCall: { toolCallId: 'tc-ed3', title: 'external_directory' },
      paths: ['/outside/some/other.txt'],
    }
    const p2 = h.permissionHandler(EXT_DIR_REQ_SAME)
    assert.equal(await p2, 'allow', '同目录子路径 → L2 路径记忆命中，预检放行')
    assert.equal(h.pendingEvents().length, 1, 'L2 命中必须在弹窗前返回，不得新增授权球')
    // 完全不同路径 → 仍弹球
    const EXT_DIR_REQ_DIFF = {
      product: 'opencode', sessionId: 'acp-1',
      description: '完全不同路径',
      toolCall: { toolCallId: 'tc-ed4', title: 'external_directory' },
      paths: ['/outside/COMPLETELY/DIFFERENT/file.txt'],
    }
    const p3 = h.permissionHandler(EXT_DIR_REQ_DIFF)
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'L2 路径记忆不覆盖不同路径 → 仍弹球')
    assert.equal(rules.size('parent-1'), 1, '被弹球的请求尚未决策，不得凭空多出规则')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
    assert.equal(rules.size('parent-1'), 1, 'deny 不得写入任何规则')
  })

  it('L3: toolName 不可解析且无路径 → 不写入任何会话级授权，日志如实说明', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    // 日志必须读 harness 的 h.logs：harness 把切片里的 console 换成内置收集器，
    // host._console 不会被注入（用它会得到一个恒空的数组，断言形同虚设）。
    const h = harness({ bindings: bound(), rules })
    const DOOM_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '循环保护',
      toolCall: { toolCallId: 'tc-dl', title: 'doom_loop' },
      paths: [],
    }
    const p1 = h.permissionHandler(DOOM_REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // L3 断言：工具名授权未写入
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'L3: 工具名授权未写入')
    // L3 断言：路径/类别规则未写入（无路径 + doom_loop 是保护机制不归类别）
    assert.equal(rules.size('parent-1'), 0, 'L3: 路径/类别规则未写入')
    // 日志如实说明
    const l3Log = h.logs.find(l => l.includes('未能写入会话级记忆') || l.includes('未能解析出工具名'))
    assert.ok(l3Log, 'L3: 日志应说明未能解析出工具名或写入会话级记忆')
    assert.match(l3Log, /本次未写入任何授权/, 'L3: 日志不得虚报"已记住"')
    // 第二次请求仍弹球
    const DOOM_REQ_2 = {
      product: 'opencode', sessionId: 'acp-1',
      description: '循环保护再触发',
      toolCall: { toolCallId: 'tc-dl2', title: 'doom_loop' },
      paths: [],
    }
    const p2 = h.permissionHandler(DOOM_REQ_2)
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'L3: 第二次请求必须仍弹球')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('L1 命中后同产品同类工具跨路径放行，跨产品仍弹', async () => {
    // 三条请求必须共用同一张 rules 表：旧写法 h 用 harness 默认表、h2 用局部
    // 空表，跨产品断言即便产品前缀失效也照样"通过"（空表必然不命中），是假绿。
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const bindings = new Map()
    bindings.set('child-A', { product: 'opencode', remote: { sessionId: 'acp-1' }, cwd: '/proj', parentSessionId: 'parent-1' })
    // 同产品、另一 ACP 会话、同一主代理会话：验证授权作用域是主代理会话而非 child
    bindings.set('child-C', { product: 'opencode', remote: { sessionId: 'acp-3' }, cwd: '/proj', parentSessionId: 'parent-1' })
    const h = harness({ bindings, rules })
    const BASH_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-b', title: 'bash' },
      paths: [],
    }
    const p1 = h.permissionHandler(BASH_REQ)
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, 'bash', 'bash 在 TOOL_NAME_SLUGS → L1 命中')
    assert.equal(h.pendingEvents()[0].toolNameSource, 'title(TOOL_NAME_SLUGS)')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 1, 'L1 命中 → 写入一条工具名授权')
    // 不同路径的同名工具 → L1 工具名授权命中，预检放行
    const BASH_REQ_2 = {
      product: 'opencode', sessionId: 'acp-1',
      description: '执行命令：rm -rf /tmp',
      toolCall: { toolCallId: 'tc-b2', title: 'bash' },
      paths: ['/tmp/something'],
    }
    const p2 = h.permissionHandler(BASH_REQ_2)
    assert.equal(await p2, 'allow', 'L1 命中：同产品同工具名跨路径自动放行')
    assert.equal(h.pendingEvents().length, 1, 'L1 命中不得新增授权球')
    // 同产品换 ACP 会话 → 仍免弹（反证：授权确实写在这张共享表里）
    const BASH_REQ_SIBLING_SESSION = {
      product: 'opencode', sessionId: 'acp-3',
      description: '执行命令：ls（另一子代理）',
      toolCall: { toolCallId: 'tc-b4', title: 'bash' },
      paths: ['/opt/other'],
    }
    const pCtrl = h.permissionHandler(BASH_REQ_SIBLING_SESSION)
    assert.equal(await pCtrl, 'allow', '同产品另一子代理的同名工具也必须免弹（否则下面的跨产品断言是假绿）')
    assert.equal(h.pendingEvents().length, 1, '同产品免弹同样不得弹窗')
    // 跨产品 → 仍弹球
    const bindings2 = new Map()
    bindings2.set('child-B', { product: 'qoder', remote: { sessionId: 'acp-2' }, cwd: '/proj2', parentSessionId: 'parent-1' })
    const h2 = harness({ bindings: bindings2, rules })
    const BASH_REQ_QODER = {
      product: 'qoder', sessionId: 'acp-2',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-b3', title: 'bash' },
      paths: [],
    }
    const p3 = h2.permissionHandler(BASH_REQ_QODER)
    await flush()
    assert.equal(h2.pendingEvents().length, 1, '跨产品 → L1 不命中，仍弹球')
    assert.equal(h2.pendingEvents()[0].rawToolName, 'bash', '弹窗确实来自同名工具（只是产品不同）')
    h2.onDecision({ childId: 'child-B', permId: h2.pendingEvents()[0].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
    assert.equal(rules.toolGrantSize('parent-1'), 1, '跨产品请求被拒，未写入任何授权')
  })

  it('L1 regression: 0.7.7 下 external_directory 会静默放行任意路径 → 0.7.8 不再放行', async () => {
    // 在 0.7.7 中，title=external_directory 会被当作工具名写入 addToolGrant，
    // 导致同会话内任意路径的 external_directory 请求都被静默放行。
    // 0.7.8 修复：external_directory 不在 TOOL_NAME_SLUGS，不会走 L1 工具名授权。
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    // 第一次请求：external_directory + 路径
    const EXT_DIR_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '工作区外路径',
      toolCall: { toolCallId: 'tc-ed', title: 'external_directory' },
      paths: ['/outside/path1/file.txt'],
    }
    const p1 = h.permissionHandler(EXT_DIR_REQ)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // 工具名授权未写入（external_directory 不是工具名）
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'external_directory 不走 L1 → 工具名授权为空')
    // 完全不同的路径 → 仍弹球（0.7.7 会静默放行，0.7.8 不再放行）
    const EXT_DIR_REQ_FAR = {
      product: 'opencode', sessionId: 'acp-1',
      description: '完全不同路径',
      toolCall: { toolCallId: 'tc-ed2', title: 'external_directory' },
      paths: ['/outside/COMPLETELY/DIFFERENT/file.txt'],
    }
    const p2 = h.permissionHandler(EXT_DIR_REQ_FAR)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '0.7.8 修复：external_directory 不同路径不再静默放行')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  // M-2（本版新引入的缺陷）：qoder 式「同一请求连发多条」——两条都先弹窗，用户逐条点。
  // 第一次点击已把工具名授权写进会话，第二次 addToolGrant 因条目已存在返回 false；
  // 旧实现直接吃这个布尔 ⇒ 把「授权已存在」判成「什么都没写」⇒ 落 L3 分支打出两处
  // 与事实相反的文案（bash 明明解析得出、也在白名单里），并把本轮 outcome 从
  // granted-session 降成 allowed-once。
  it('M-2: 同一 toolCall 连发两条、两次 allow-session 均不得失真', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const DUP_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-dup', title: 'bash' },
      paths: [],
    }
    const p1 = h.permissionHandler(DUP_REQ)
    const p2 = h.permissionHandler(DUP_REQ)
    await flush()
    const pending = h.pendingEvents()
    assert.equal(pending.length, 2, '两条连发请求必须各自弹窗')
    assert.equal(pending[0].toolName, 'bash')
    assert.equal(pending[1].toolName, 'bash', '第二次的解析结果不得受第一次点击影响')
    h.onDecision({ childId: 'child-A', permId: pending[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    h.onDecision({ childId: 'child-A', permId: pending[1].permId, answer: 'allow-session' })
    assert.equal(await p2, 'allow')
    const grantLogs = h.logs.filter((l) => l.includes('授权球：会话期工具名授权'))
    assert.equal(grantLogs.length, 2, '两次点击都必须落在「工具名授权」分支，而不是 L3')
    assert.equal(
      h.logs.filter((l) => l.includes('未能解析出工具名')).length,
      0,
      '两次日志都不得出现「未能解析出工具名」（bash 就在 TOOL_NAME_SLUGS 里）',
    )
    assert.ok(grantLogs[0].includes('bash(title(TOOL_NAME_SLUGS))'), '首次授权文案不变')
    assert.ok(grantLogs[0].includes('但同会话内同名工具自动放行'), '首次授权文案不变')
    assert.ok(!grantLogs[0].includes('此前已存在'), '首次点击不得说"此前已存在"')
    assert.ok(grantLogs[1].includes('此前已存在同名工具授权'), '第二次必须如实说明授权早已在会话内')
    const resolved = h.resolvedEvents()
    assert.equal(resolved.length, 2)
    assert.deepEqual(
      resolved.map((r) => r.outcome),
      ['granted-session', 'granted-session'],
      '两次 outcome 都必须是 granted-session（不得退化为 allowed-once）',
    )
    assert.equal(rules.toolGrantSize('parent-1'), 1, '重复写入必须幂等：会话里只有 1 条授权')
  })

  it('M-2: allow-always 重复点击不得把"此前已授权"说成"已写入"', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-aa', title: 'edit' },
      paths: [],
    }
    const p1 = h.permissionHandler(REQ)
    const p2 = h.permissionHandler(REQ)
    await flush()
    const pending = h.pendingEvents()
    assert.equal(pending.length, 2)
    h.onDecision({ childId: 'child-A', permId: pending[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    h.onDecision({ childId: 'child-A', permId: pending[1].permId, answer: 'allow-always' })
    assert.equal(await p2, 'allow')
    const alwaysLogs = h.logs.filter((l) => l.includes('用户点击总是允许 → 已落盘'))
    assert.equal(alwaysLogs.length, 2)
    assert.ok(alwaysLogs[0].includes('会话级工具名授权(edit)已写入'), '首次：确实写了新条目')
    assert.ok(!alwaysLogs[0].includes('此前已存在'), '首次文案不变')
    assert.ok(alwaysLogs[1].includes('此前已授权'), '第二次：不得说"已写入"')
    assert.ok(!alwaysLogs[1].includes('已写入'), '第二次日志不得出现「已写入」（本次并没写）')
    assert.equal(rules.toolGrantSize('parent-1'), 1, '幂等：只有 1 条工具名授权')
  })

  it('m-1: name 被占位过滤时，pending 载荷的 toolNameSource 必须是真实来源', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-m1', name: 'other', title: 'bash' },
      paths: [],
    })
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.toolName, 'bash')
    assert.equal(pending.toolNameSource, 'title(TOOL_NAME_SLUGS)', 'name 是占位值 → 实际来源是 title，不得反推成 name/toolName')
    assert.equal(pending.rawToolName, 'other', 'rawToolName 仍透出原始 name（展示用）')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'deny' })
    assert.equal(await p1, 'deny')
    // 纯空白 name 同理
    const p2 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-m1b', name: '   ', title: 'edit' },
      paths: [],
    })
    await flush()
    const second = h.pendingEvents()[1]
    assert.equal(second.toolName, 'edit')
    assert.equal(second.toolNameSource, 'title(TOOL_NAME_SLUGS)')
    h.onDecision({ childId: 'child-A', permId: second.permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
    // name 真有值时来源标签仍是 name/toolName（既有语义不变）
    const p3 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-m1c', name: 'Write', title: 'edit' },
      paths: [],
    })
    await flush()
    const third = h.pendingEvents()[2]
    assert.equal(third.toolName, 'Write')
    assert.equal(third.toolNameSource, 'name/toolName')
    h.onDecision({ childId: 'child-A', permId: third.permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
  })

  it('m-2: name 为占位值但 toolName 有真名 → 走 L1 用真名（不再退回 title）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: '写入文件',
      toolCall: { toolCallId: 'tc-m2', name: 'other', toolName: 'Write' },
      paths: [],
    })
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.toolName, 'Write', 'name 占位必须继续回退 toolName')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'Write', '/proj'), true, '真名已写入会话级授权')
    // 同工具名换路径 → 预检免弹
    assert.equal(
      await h.permissionHandler({
        product: 'opencode', sessionId: 'acp-1',
        description: '写入另一个文件',
        toolCall: { toolCallId: 'tc-m2b', name: 'other', toolName: 'Write' },
        paths: ['/proj/other.txt'],
      }),
      'allow',
      'L1 命中后跨路径免弹',
    )
    assert.equal(h.pendingEvents().length, 1, '免弹不得新增授权球')
  })

  it('G-1: external_directory 塞进 name/toolName 也不得写出工具名授权（端到端复现终审载荷）', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const G1_REQ = {
      product: 'opencode', sessionId: 'acp-1',
      description: '访问工作区外路径',
      toolCall: { toolCallId: 'tc-g1', name: 'other', toolName: 'external_directory' },
      paths: [],
    }
    const p1 = h.permissionHandler(G1_REQ)
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.toolName, null, '权限范围 slug 在 toolName 侧也必须被拒 → L1 未命中')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // 复现点：修复前这里会写出 1 条 external_directory 的工具名授权，
    // 于是第二次同类请求被预检静默放行（0.7.7 那类"任意工作区外路径"缺口）。
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'G-1：不得写出任何会话级工具名授权')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'external_directory'), false, 'G-1：该 slug 不得成为授权键')
    assert.equal(h.logs.filter((l) => l.includes('授权球：会话期工具名授权')).length, 0, 'G-1：不得落在工具名授权分支')
    const l3Logs = h.logs.filter((l) => l.includes('本次未写入任何授权'))
    assert.equal(l3Logs.length, 1, 'G-1：无工具名 + 无路径 → 必须落 L3 并如实说明')
    assert.deepEqual(h.resolvedEvents().map((r) => r.outcome), ['allowed-once'], 'G-1：本轮只允许"仅本次"')
    // 第二次同类请求：仍必须弹窗（不得被静默放行）
    const p2 = h.permissionHandler({
      ...G1_REQ,
      toolCall: { toolCallId: 'tc-g1-2', name: 'other', toolName: 'external_directory' },
    })
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'G-1：第二次同类请求必须仍弹球（修复前此处静默放行）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'G-1：deny 之后会话内依然没有该 slug 的授权')
    // 反向对照：拒绝集不得吃掉真工具名
    const p3 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: '执行命令：ls',
      toolCall: { toolCallId: 'tc-g1-ctrl', name: 'other', toolName: 'bash' },
      paths: [],
    })
    await flush()
    assert.equal(h.pendingEvents()[2].toolName, 'bash', '对照：真工具名仍须从 toolName 解析出来')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[2].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
  })
})

// ── v0.7.9 真根因：qoder 的真实工具名在 toolCall._meta.qoder.toolName ───────────
//
// 下面三条载荷逐字取自用户从宿主终端 stdout 贴回的 requestPermission 原文
// （即 lib/bridges/acp.js:480 打印的那个 toolCall）。qoder 既不给 `name` 也不给
// `toolName`，而 `title` 里是**整条命令正文** ⇒ 0.7.8 的 resolveToolName 恒返回
// null ⇒ lib/index.js 的 `toolName && bindParentSessionId` 短路，addToolGrant 根本
// 不被调用 ⇒ 用户点「本会话总是允许」只落地路径级记忆，换一条路径就重复弹窗。
const QODER_LS_PAYLOAD = {
  _meta: { qoder: { toolName: 'Bash' } },
  content: [{ content: { text: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin' }, type: 'content' }],
  kind: 'execute',
  rawInput: { command: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin', description: 'List files in the nvm node bin directory' },
  status: 'pending',
  title: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin',
  toolCallId: 'call_19e6d181e8be4bfb942073ce',
}
const QODER_ECHO_TITLE = 'echo "=== dispatches.jsonl distinct kind values ===" ; grep -o \'"kind":"[^"]*"\' dispatches.jsonl | sort | uniq'
const QODER_ECHO_PAYLOAD = {
  _meta: { qoder: { toolName: 'Bash' } },
  content: [{ content: { text: QODER_ECHO_TITLE }, type: 'content' }],
  kind: 'execute',
  rawInput: { command: QODER_ECHO_TITLE, description: 'Count distinct kind values in dispatches.jsonl' },
  status: 'pending',
  title: QODER_ECHO_TITLE,
  toolCallId: 'call_echo_distinct_kind',
}
const QODER_PY_TITLE = "python3 - <<'PY'\nimport json\nprint('ok')\nPY"
const QODER_PY_PAYLOAD = {
  _meta: { qoder: { toolName: 'Bash' } },
  content: [{ content: { text: QODER_PY_TITLE }, type: 'content' }],
  kind: 'execute',
  rawInput: { command: QODER_PY_TITLE, description: 'Run a python heredoc' },
  status: 'pending',
  title: QODER_PY_TITLE,
  toolCallId: 'call_py_heredoc',
}

/**
 * 0.7.8 生产逻辑的逐字复刻（三条来源 name/toolName/title，没有 `_meta` 那一跳），
 * 只用于「修复前会弹、修复后不弹」的双向断言。与生产实现脱钩是刻意的：它必须
 * 永远描述 0.7.8 的行为，不随 lib/permission-state.js 演进。
 */
function resolveToolNameV078(toolCall) {
  const PLACEHOLDER = new Set(['other', 'unknown', 'default', 'misc', ''])
  const SLUGS = new Set([
    'bash', 'shell', 'terminal', 'exec', 'execute', 'command',
    'run_command', 'runcommand', 'execute_command',
    'edit', 'write', 'read',
    'webfetch', 'web_fetch', 'web_search',
  ])
  const scopeKey = (v) => (typeof v !== 'string' ? '' : v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]/g, ''))
  const isScope = (v) => new Set(['externaldirectory', 'doomloop']).has(scopeKey(v))
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : {}
  for (const raw of [tool.name, tool.toolName]) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const trimmed = raw.trim()
    if (PLACEHOLDER.has(trimmed.toLowerCase())) continue
    if (isScope(trimmed)) continue
    return { value: trimmed, source: 'name/toolName' }
  }
  const titleRaw = tool.title
  if (typeof titleRaw === 'string' && titleRaw.trim()) {
    const slug = titleRaw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
    if (slug && !PLACEHOLDER.has(slug) && SLUGS.has(slug) && !isScope(titleRaw)) {
      return { value: titleRaw.trim(), source: 'title(TOOL_NAME_SLUGS)' }
    }
  }
  return null
}

describe('v0.7.9 qoder _meta 工具名：同会话内换路径/换命令不再重复弹窗', () => {
  /** provider 白名单：只放行工作区内目录，据此复现日志里的「部分越权」 */
  const PROVIDERS = { qoder: { allowWritePaths: ['/Volumes/proj/inside'] } }

  const mkRules = () => createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })

  it('allow-session 后 sessionRules 里查得到 qoder:bash；换完全不同命令+混合越权路径 ⇒ 直接放行', async () => {
    const rules = mkRules()
    const h = harness({ bindings: bound(), rules, providers: PROVIDERS })
    const p1 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_LS_PAYLOAD,
      paths: ['/Users/arming/.nvm/versions/node/v22.22.2/bin'],
    })
    await flush()
    const [pending1] = h.pendingEvents()
    assert.equal(pending1.toolName, 'Bash', '修复前此处为 null：qoder 的 _meta 没被读')
    assert.equal(pending1.toolNameSource, '_meta(TOOL_NAME_SLUGS)', 'm-1 同源：来源必须如实标注 meta')
    h.onDecision({ childId: 'child-A', permId: pending1.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '会话级必须记住 qoder:bash（原始终点：addToolGrant 此前从未被调用）')
    assert.equal(rules.toolGrantSize('parent-1'), 1)

    // 现场第二条命令：路径一半在白名单内、一半在外 ⇒ lib/index.js 打「部分越权…继续走
    // 会话期/交互判定」（0.7.9 之前这条文案是「转交互审批」，但它并不 return）
    const p2 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_ECHO_PAYLOAD,
      paths: ['/Volumes/proj/inside/dispatches.jsonl', '/Users/arming/.ssh/id_rsa'],
    })
    await flush()
    assert.equal(h.pendingEvents().length, 1, '第二条不得再发 pending 事件（不弹窗）')
    assert.equal(await p2, 'allow', '工具名预检必须在交互审批之前命中并直接放行')
    assert.equal(rules.size('parent-1'), 1, '第二条未追加任何路径规则')
    // 顺序证据：越权日志确实先打了，但它不 return；预检随后命中放行
    assert.equal(h.logs.filter((l) => l.includes('部分越权')).length, 1, '这条请求真的走了「部分越权」分支')
    assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 1, '免弹来自工具名预检')
    assert.deepEqual(h.resolvedEvents().map((r) => r.outcome), ['granted-session'], '只有第一条落了授权，第二条没进交互通道')
  })

  it('双向断言：注入 0.7.8 解析逻辑后，同一条「部分越权」请求必须重新弹窗', async () => {
    const rules = mkRules()
    const h = harness({ bindings: bound(), rules, providers: PROVIDERS, resolveToolName: resolveToolNameV078 })
    const p1 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_LS_PAYLOAD,
      paths: ['/Users/arming/.nvm/versions/node/v22.22.2/bin'],
    })
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, null, '修复前：载荷里唯一像工具名的字段是 title，而它是命令正文')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 0, '修复前：会话级工具名记忆为空（只落了路径规则）')
    assert.equal(rules.size('parent-1'), 1, '修复前记的是路径——这正是「同会话内换个路径就重复弹」的根因')

    const p2 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_PY_PAYLOAD,
      paths: ['/Volumes/proj/inside/a.jsonl', '/opt/homebrew/bin'],
    })
    await flush()
    assert.equal(h.pendingEvents().length, 2, '修复前：换命令/换路径必须重新弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('跨产品隔离（不变式①）：opencode 不得吃到 _meta.qoder 的命名空间', async () => {
    const rules = mkRules()
    const h = harness({ bindings: bound(), rules, providers: PROVIDERS })
    const p1 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_LS_PAYLOAD,
      paths: ['/Users/arming/.nvm/versions/node/v22.22.2/bin'],
    })
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    // 同一 _meta 载荷、产品换成 opencode（binding 里的 product 才是授权键前缀）
    const p2 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: QODER_LS_PAYLOAD,
      paths: ['/Users/arming/.ssh/id_rsa'],
    })
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'opencode 侧命名空间取不到 _meta.qoder ⇒ 必须仍弹球')
    assert.equal(h.pendingEvents()[1].toolName, null, '跨产品不得借到 qoder 的工具名')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'bash'), false, '授权键仍只属于 qoder')
  })

  it('不变式②③：_meta 塞占位值或权限范围 slug，一律不落工具名授权（B1/G-1 同理生效）', async () => {
    for (const bad of ['other', 'unknown', 'default', 'misc', 'external_directory', 'doom_loop', 'ExternalDirectory']) {
      const rules = mkRules()
      const h = harness({ bindings: bound(), rules, providers: PROVIDERS })
      const req = (toolCallId, pathList) => ({
        product: 'qoder', sessionId: 'acp-1',
        description: 'Allow bash?',
        toolCall: { _meta: { qoder: { toolName: bad } }, kind: 'execute', title: 'rm -rf /Volumes/proj/inside/build', toolCallId },
        paths: pathList,
      })
      const p1 = h.permissionHandler(req('tc-bad-1', ['/Users/arming/Library/Preferences/x.plist']))
      await flush()
      assert.equal(h.pendingEvents()[0].toolName, null, `_meta=${bad} 不得被解析成工具名`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
      assert.equal(await p1, 'allow')
      assert.equal(rules.toolGrantCovers('parent-1', 'qoder', bad), false, `_meta=${bad} 不得成为授权键`)
      assert.equal(rules.toolGrantSize('parent-1'), 0, `_meta=${bad}：会话级工具名记忆必须为空`)
      const p2 = h.permissionHandler(req('tc-bad-2', ['/Users/arming/.ssh/id_rsa']))
      await flush()
      assert.equal(h.pendingEvents().length, 2, `_meta=${bad}：换路径必须仍弹窗（退回 L2 逐路径判定）`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
      assert.equal(await p2, 'deny')
    }
  })

  it('畸形 _meta 端到端：不抛异常、不放行，行为等同修复前（落 L2 路径级）', async () => {
    const shapes = [
      'Bash', 42, null, true, [],
      { qoder: 'Bash' }, { qoder: null }, { qoder: {} }, { qoder: { toolName: 42 } },
      { qoder: { toolName: '' } }, { qoder: { toolName: '   ' } }, { qoder: { toolName: ['Bash'] } },
      { toolName: 42 }, { QODER: { toolName: 'Bash' } },
    ]
    for (const meta of shapes) {
      const rules = mkRules()
      const h = harness({ bindings: bound(), rules, providers: PROVIDERS })
      const req = (toolCallId, pathList) => ({
        product: 'qoder', sessionId: 'acp-1',
        description: 'Allow bash?',
        toolCall: { _meta: meta, kind: 'execute', title: 'ls -la /tmp', toolCallId },
        paths: pathList,
      })
      const p1 = h.permissionHandler(req('tc-m-1', ['/tmp/one']))
      await flush()
      assert.equal(h.pendingEvents().length, 1, `_meta=${JSON.stringify(meta)} 必须弹窗`)
      assert.equal(h.pendingEvents()[0].toolName, null, `_meta=${JSON.stringify(meta)} 不得解析出工具名`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
      assert.equal(await p1, 'allow')
      assert.equal(rules.toolGrantSize('parent-1'), 0, `_meta=${JSON.stringify(meta)}：不得写入工具名授权`)
      assert.equal(rules.size('parent-1'), 1, `_meta=${JSON.stringify(meta)}：只能落 L2 路径级记忆`)
      const p2 = h.permissionHandler(req('tc-m-2', ['/tmp/two']))
      await flush()
      assert.equal(h.pendingEvents().length, 2, `_meta=${JSON.stringify(meta)}：不同路径必须仍弹窗`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
      assert.equal(await p2, 'deny')
    }
  })

  it('不变式⑥（L3）：_meta 解析不出且无路径 ⇒ 不写任何会话级授权', async () => {
    const rules = mkRules()
    const h = harness({ bindings: bound(), rules, providers: PROVIDERS })
    const req = (toolCallId) => ({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      // 无 title/kind ⇒ 类别只能从 description 归出 'qoder:bash'（执行类，m5 拒写），
      // 无工具名 + 无路径 + 类别不可记 = L3，什么都不许写。
      toolCall: { _meta: { qoder: { toolName: 'search_codebase' } }, toolCallId },
      paths: [],
    })
    const p1 = h.permissionHandler(req('tc-l3-1'))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 0)
    assert.equal(rules.size('parent-1'), 0, 'L3：既无工具名也无路径，不得写任何会话级规则')
    assert.equal(h.logs.filter((l) => l.includes('本次未写入任何授权')).length, 1, 'L3 归因文案必须打出来')
    const p2 = h.permissionHandler(req('tc-l3-2'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'L3：第二次同类请求必须仍弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })
})

// ── v0.7.9 危险命令排除门（用户裁决）：rm -rf / npm publish / git push 仍要问 ─────
//
// 用户在 `~/.qoder/settings.json` 的 `permissions.ask` 里定了 `Bash(rm -rf:*)`、
// `npm publish`、`git push`。0.7.9 把 qoder 的 `_meta.qoder.toolName` 接进 L1 之后，
// 「本会话授权过一次 Bash」= 该会话内所有 bash 免弹，这三类也会被一起放掉。
// 门排在 `toolGrantCovers` 预检之前：命中 ⇒ 不短路，照旧进交互审批。

describe('v0.7.9 危险命令门：已授权 qoder:bash 后仍须交互询问', () => {
  const bashReq = (toolCallId, command, paths = []) => ({
    product: 'qoder', sessionId: 'acp-1',
    description: 'Allow bash?',
    toolCall: {
      _meta: { qoder: { toolName: 'Bash' } },
      kind: 'execute',
      content: [{ content: { text: command }, type: 'content' }],
      rawInput: { command, description: 'x' },
      status: 'pending',
      title: command,
      toolCallId,
    },
    paths,
  })

  /** 先正常授权一次 bash，返回已就绪的 harness */
  async function granted(extra = {}) {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules, providers: { qoder: { allowWritePaths: ['/Volumes/proj/inside'] } }, ...extra })
    const p1 = h.permissionHandler(bashReq('tc-grant', 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin', ['/Users/arming/.nvm/versions/node/v22.22.2/bin']))
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, 'Bash')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '前置条件：本会话确实已授权 qoder 的 bash')
    return { h, rules }
  }

  for (const [name, command] of [['rm -rf', 'rm -rf /tmp/build'], ['npm publish', 'npm publish --tag next'], ['git push', 'git push origin main']]) {
    it(`已授权 bash 后 ${name} 必须不命中工具名短路、进入交互审批`, async () => {
      const { h, rules } = await granted()
      const p2 = h.permissionHandler(bashReq('tc-danger-1', command, ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, 2, `${name} 必须重新弹球（不被会话级工具名授权放行）`)
      assert.equal(h.pendingEvents()[1].toolName, 'Bash', '工具名照样解析得出来，只是本门关掉短路')
      assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 1, `${name} 必须留下归因日志`)
      assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, `${name} 不得走免弹通道`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
      assert.equal(await p2, 'deny')
      assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '危险命令被拒不得撤销既有的工具名授权')
    })
  }

  it('双向断言：注入"没有这道门"后，同一条 rm -rf 会被工具名授权静默放行', async () => {
    const { h } = await granted({ dangerousExecuteMatch: () => null })
    const p2 = h.permissionHandler(bashReq('tc-danger-0', 'rm -rf /tmp/build', ['/tmp/build']))
    assert.equal(await p2, 'allow', '修复前：工具名授权把 rm -rf 一起放掉了')
    assert.equal(h.pendingEvents().length, 1, '修复前：一条命令都没弹')
    assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 1, '修复前走的就是免弹通道')
  })

  // v0.7.9（第三轮复审 B-1 阻断）端到端：**非执行类 kind + 真命令字段**也必须再弹一次。
  //
  // 阻断现场（终审探针实测）：同一会话先授权 `qoder:bash`（正常 `kind:'execute'` 帧），
  // 随后发这条 `{kind:'other', name:'bash', title:'bash', rawInput:{command:'rm -rf …'}}`
  // —— 上一版补丁**一条 pending 事件都不发、直接 allow**（补丁前 pristine 会弹窗）。
  // 根因：门被 `kind` 前置否决 ⇒ `dangerousExecuteMatch` 判 null ⇒ `lib/index.js` 的
  // `!danger` 分支把 session/disk/workspace 三档全部推入 ⇒ 命中会话级工具名授权后静默放行。
  // 这条帧不是编造的：库内 fixture 就是这么建模 bash 的（本文件 m5 一节的 `BASH`、
  // 跨产品隔离用例的 `BASH_QODER`），opencode 的真实载荷也从未抓到。
  it('B-1 阻断端到端：kind=other 的 bash 帧带真命令字段 ⇒ 已授权 qoder:bash 也必须再弹一次（不得静默 allow）', async () => {
    const { h, rules } = await granted()
    const otherKindBash = (toolCallId, command) => ({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow bash?',
      toolCall: { toolCallId, name: 'bash', kind: 'other', title: 'bash', rawInput: { command } },
      // 路径这里刻意给空数组：非执行类帧不扫命令字段（`extractPaths` 侧一票否决，
      // 见 test/dangerous-commands.test.js 的不对称断言），所以本帧确实没有路径可用。
      paths: [],
    })
    const p2 = h.permissionHandler(otherKindBash('tc-other-1', 'rm -rf /tmp/build'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '阻断修复点：必须**再弹一次**，不得一条 pending 都不发就 allow')
    assert.equal(h.pendingEvents()[1].toolName, 'bash', '工具名照样解析得出来，只是本门关掉短路')
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 1, '必须留下归因日志（命令正文取自 rawInput.command）')
    assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, '不得走免弹通道')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '危险命令被拒不得撤销既有的工具名授权')
    // 阴性对照：同形状的安全命令仍走工具名短路（不得把这类帧一律拦下）
    const p3 = h.permissionHandler(otherKindBash('tc-other-2', 'ls -la /tmp'))
    assert.equal(await p3, 'allow', '安全命令不受影响，照旧命中会话级工具名授权')
    assert.equal(h.pendingEvents().length, 2)
  })

  // v0.7.9（第四轮终审 Major-1）**监听器层**：`env -S` / `--split-string` 的取值是
  // 多 token 的**整条命令** ⇒ 改前判 null ⇒ 已授权 `qoder:bash` 时静默 allow（真机已
  // 证明 `env -S "rm -rf <dir>"` 把目录删掉，exit 0）。跳数用尽（`sudo×9`）同理。
  it('Major-1 端到端：env -S / --split-string / sudo×9 必须新增 pending（不得走工具名短路）', async () => {
    const { h } = await granted()
    const dangerous = [
      'env -S "rm -rf /Users/arming/.ssh"',
      'env --split-string="rm -rf /Users/arming/.ssh"',
      `${'sudo '.repeat(9)}rm -rf /Users/arming/.ssh`,
    ]
    for (const [i, command] of dangerous.entries()) {
      const p = h.permissionHandler(bashReq(`tc-envs-${i}`, command, []))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `${command} 必须新增 pending（第 ${i + 1} 条）`)
      assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, `${command} 不得走免弹通道`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[i + 1].permId, answer: 'deny' })
      assert.equal(await p, 'deny', `${command} 必须仍由用户裁决`)
    }
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 3, '三条都必须留下归因日志')
    // 阴性对照：同样的包装写法 + 安全命令 ⇒ 照旧命中工具名授权，不再弹窗
    const p4 = h.permissionHandler(bashReq('tc-envs-ok', 'env -S "ls -la /tmp"', []))
    assert.equal(await p4, 'allow', 'env -S 的安全命令不受影响')
    assert.equal(h.pendingEvents().length, 4, '安全命令不得新增 pending')
  })

  it('正常命令不受影响：ls / echo / python3 heredoc 仍直接放行', async () => {
    const { h } = await granted()
    for (const [toolCallId, command] of [
      ['tc-ok-1', 'ls -la /Users/arming/.dsh/profiles/web'],
      ['tc-ok-2', 'echo "=== dispatches.jsonl distinct kind values ===" ; grep -o \'"kind":"[^"]*"\' dispatches.jsonl | sort | uniq'],
      ['tc-ok-3', "python3 - <<'PY'\nimport json\nprint('ok')\nPY"],
    ]) {
      const p = h.permissionHandler(bashReq(toolCallId, command, ['/Users/arming/.ssh/id_rsa']))
      assert.equal(await p, 'allow', `${command.slice(0, 24)} 应命中工具名授权直接放行`)
    }
    assert.equal(h.pendingEvents().length, 1, '三条正常命令都不得弹窗')
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 0, '正常命令不得被门命中')
  })

  // v0.7.15（用户裁定）：判定模式从「按段/命令头」改成**全文危险词判定** —— 文本里出现危险字样
  // 就弹，包括打印/注释/grep 参数里的**提及**。旧用例断言这四条「不得被门拦下」，本裁定作废该口径
  // ⇒ 翻成"必须各弹一次 + 留痕"，并保留一条**真反例**证明不是"一律弹"。
  it('提及代价（端到端，用户裁定 v0.7.15）：打印/注释/grep 里的危险字样也必须弹一次', async () => {
    const { h } = await granted()
    const mentions = [
      ['tc-safe-1', 'echo "git push"'],
      ['tc-safe-2', 'echo npm publish'],
      ['tc-safe-3', 'ls; # rm -rf /tmp'],
      ['tc-safe-4', 'grep -rn "git push" docs/'],
    ]
    for (const [i, [toolCallId, command]] of mentions.entries()) {
      const p = h.permissionHandler(bashReq(toolCallId, command, ['/Users/arming/.ssh/id_rsa']))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `「${command}」必须弹一次（提及即判，用户裁定的代价）`)
      assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, '不得走免弹通道')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[i + 1].permId, answer: 'deny' })
      assert.equal(await p, 'deny', '必须仍由用户裁决')
    }
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, mentions.length,
      '每条提及都必须留下归因日志（归因是 text:<串>）')
    assert.ok(h.logs.some((l) => l.includes('text:rm -rf')), '留痕里应能看到全文判定的归因 id')
    // 真反例（端到端）：文本里没有任何危险字样 ⇒ 照旧命中工具名授权、免弹
    const safe = h.permissionHandler(bashReq('tc-safe-5', 'ls -la /tmp', ['/Users/arming/.ssh/id_rsa']))
    assert.equal(await safe, 'allow', '真反例不得被门拦下')
    assert.equal(h.pendingEvents().length, mentions.length + 1, '真反例不得新增弹球')
  })

  // v0.7.15（用户裁定）：危险字样是**配置项**（`$DSH_HOME/data/dsh-danger-patterns.json`），
  // 可动态**追加**、免重启生效，但**只增不减** —— 内置三串恒生效，配置文件**关不掉**这层判定
  // （`~/.dsh/data/` 可写，允许关层就等于留了自我解除武装的口子）。本用例走真实 handler：
  // 追加项改文件立即生效；`[]` / 坏 JSON 都只是"没有追加项"，内置三串照旧弹。
  it('E2E：危险词配置项只增不减（追加项免重启生效 / [] 与坏 JSON 都关不掉内置三串）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'psub-danger-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    resetDangerPatternsCache()
    try {
      const { h } = await granted()
      // ① 没有配置文件 ⇒ 内置三串生效，追加词不判
      const none = h.permissionHandler(bashReq('tc-cfg-0', 'deploy --force now', ['/tmp/build']))
      assert.equal(await none, 'allow', '未配置时追加词不判（内置三串不含它）')
      // ② 写配置 ⇒ 下一次判定立即生效（mtime+size 变更重读，不需要重启）
      const file = dangerPatternsPath()
      assert.equal(file, path.join(dir, 'data', 'dsh-danger-patterns.json'), '配置路径与规格一致')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ patterns: ['deploy --force'] }))
      const custom = h.permissionHandler(bashReq('tc-cfg-1', 'deploy --force now', ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, 2, '追加词必须弹（免重启生效）')
      assert.ok(h.logs.some((l) => l.includes('text:custom:deploy --force')), '归因是 text:custom:<原串>')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
      assert.equal(await custom, 'deny')
      // ③ `patterns: []` = "没有追加项"（**不是关闭**）：内置三串的提及照样弹
      writeFileSync(file, JSON.stringify({ patterns: [] }))
      const afterEmpty = h.permissionHandler(bashReq('tc-cfg-2', 'echo "git push"', ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, 3, '`patterns: []` 不得关层：内置三串仍须弹一次')
      assert.ok(h.logs.some((l) => l.includes('text:git push')), '归因仍是内置 id `text:git push`')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[2].permId, answer: 'deny' })
      assert.equal(await afterEmpty, 'deny')
      // ④ 删掉追加项（仍在同一份文件里改）⇒ 追加项立刻失效，内置三串仍在
      writeFileSync(file, JSON.stringify({ patterns: ['something-else'] }))
      const gone = h.permissionHandler(bashReq('tc-cfg-3', 'deploy --force now', ['/tmp/build']))
      assert.equal(await gone, 'allow', '追加项删掉后立刻失效（动态性只作用于追加项）')
      // ⑤ 坏 JSON ⇒ 同样只是"没有追加项"（不因读取失败变成"不判"）
      writeFileSync(file, '{ broken json')
      resetDangerPatternsCache() // 同尺寸同毫秒的极端场景；生产由 mtime+size 负责
      const broken = h.permissionHandler(bashReq('tc-cfg-4', 'echo "npm publish"', ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, 4, '坏 JSON ⇒ 内置三串仍须弹一次')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[3].permId, answer: 'deny' })
      assert.equal(await broken, 'deny')
    } finally {
      resetDangerPatternsCache()
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 execute 工具不受门影响：Write 载荷里带 rm -rf 字样也照常免弹', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    // v0.7.9：路径必须放在**工作区外**（binding cwd='/proj'）。落在 /proj 里会被
    // 新的"工作区默认规则"抢先免弹，本用例就测不到它要测的那条工具名授权链路了。
    const writeReq = (toolCallId, title) => ({
      product: 'qoder', sessionId: 'acp-1',
      description: 'Allow writing?',
      toolCall: { toolCallId, name: 'Write', kind: 'edit', title, rawInput: { file_path: 'scripts/cleanup.sh', content: 'rm -rf /' } },
      paths: ['/Volumes/ext/scripts/cleanup.sh'],
    })
    const p1 = h.permissionHandler(writeReq('tc-w-1', 'edit scripts/cleanup.sh'))
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, 'Write')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const p2 = h.permissionHandler(writeReq('tc-w-2', '写入 rm -rf.sh'))
    assert.equal(await p2, 'allow', '写文件请求的 title 里出现 rm -rf 不得触发执行类门')
    assert.equal(h.pendingEvents().length, 1)
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 0)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'write', '/proj'), true)
  })

  it('用户对危险命令点了「会话期总是允许」也不会把它变成免弹（每次都问）', async () => {
    const { h, rules } = await granted()
    const p2 = h.permissionHandler(bashReq('tc-d-1', 'rm -rf /tmp/build', ['/tmp/build']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'allow-session' })
    assert.equal(await p2, 'allow')
    const p3 = h.permissionHandler(bashReq('tc-d-2', 'rm -rf /Volumes/proj/dist', ['/Volumes/proj/dist']))
    await flush()
    assert.equal(h.pendingEvents().length, 3, '第二次 rm -rf 仍须弹球')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '授权仍在（本门只影响短路，不改授权表）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[2].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
    // 同会话内正常命令依旧免弹，证明没有把工具名授权整体关掉
    const p4 = h.permissionHandler(bashReq('tc-d-3', 'ls -la /tmp', ['/Users/arming/.dsh/x']))
    assert.equal(await p4, 'allow')
    assert.equal(h.pendingEvents().length, 3, '正常命令仍不弹窗')
  })
  // v0.7.13：**内容规则与形状判据都对整段文本生效（含载荷行）、归因先内容后形状** 的端到端证据。
  //
  // 现场：先正常授权 `qoder:bash`（会话级**工具名**授权，不看路径），随后一条载荷里带真命令 /
  // 深嵌套包装的命令。0.7.12 的「载荷行豁免」按归因 id 生效，而形状分支会**直接返回形状规则、
  // 不再求值内容规则** ⇒ 这类帧判 `null` ⇒ `lib/index.js` 的 `!danger` 分支把 session/disk/
  // workspace 三档全部推入 ⇒ **零弹框零留痕静默放行**（终审 E2E 实测 7 条 SILENT_ALLOW）。
  // 本用例钉住：这类帧必须再弹一次（不得 allow），归因日志 ≥1、免弹日志 0。
  it('E2E：载荷里的真命令 / 深嵌套包装 ⇒ 已授权 qoder:bash 也必须再弹一次（不得静默放行）', async () => {
    const { h, rules } = await granted()
    const shapes = [
      // 内容规则命中（载荷里写脚本再执行、进程替换、承载者开关、同名程序、解释器）
      "cat > /tmp/psub-g.sh <<'SH'\nrm -rf /tmp/build\nSH\nsh /tmp/psub-g.sh",
      "cat <<'SH' > >(sh)\nrm -rf /tmp/build\nSH",
      "tar --use-compress-program=sh -xf - <<'TAR'\nrm -rf /tmp/build\nTAR",
      "/tmp/plant/cat <<'SH'\nrm -rf /tmp/build\nSH",
      "pwsh -Command - <<'P'\ngit push origin main\nP",
      // 终审 B-1 回归牙：载荷 + 9 跳透明包装 + 真命令（0.7.12 在这里静默放行）
      `sh <<'SH'\n${'sudo '.repeat(9)}rm -rf /tmp/build\nSH`,
      `ssh host <<'SH'\n${'command '.repeat(9)}rm -rf /tmp/build\nSH`,
      // 终审 B-2：执行型载荷 + 内容规则不覆盖的 `dd` ⇒ 必须由形状判据抓
      `sh <<'SH'\n${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2\nSH`,
      // 三层 `sh -c` 包着真命令写在载荷里
      "sh <<'SH'\nsh -c 'sh -c \"rm -rf /tmp/build\"'\nSH",
    ]
    for (const [i, command] of shapes.entries()) {
      const p = h.permissionHandler(bashReq(`tc-v13-${i}`, command, ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `${command.slice(0, 34)}… 必须再弹一次（第 ${i + 1} 条）`)
      assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, '不得走免弹通道')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[i + 1].permId, answer: 'deny' })
      assert.equal(await p, 'deny', '必须仍由用户裁决')
    }
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, shapes.length,
      `${shapes.length} 条都必须留下归因日志（不得为零）`)
    // 归因必须给出内容规则（不是形状规则）：最后三条是 B-1 的回归牙
    assert.ok(h.logs.some((l) => l.includes('rm -rf')), '留痕里应能看到内容规则名')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true,
      '危险命令被拒不得撤销既有的工具名授权')

    // 阴性对照：**普通正文**的 heredoc（无危险字样、无形状可疑）⇒ 照旧走工具名短路免弹
    const safe = h.permissionHandler(bashReq(
      'tc-v13-safe',
      "git add -A\ngit commit -q -F - <<'EOF'\n- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒\nEOF",
      ['/tmp/build'],
    ))
    await flush()
    assert.equal(h.pendingEvents().length, shapes.length + 1, '阴性对照不得新增弹球（普通正文不判）')
    assert.equal(await safe, 'allow', '普通正文 ⇒ 照旧命中工具名授权免弹')

    // 代价（C 组，如实登记）：载荷正文里**真的写出**危险命令字样 ⇒ 必须再弹一次
    const cost = h.permissionHandler(bashReq(
      'tc-v13-cost',
      "git commit -q -F - <<'EOF'\nfix: note\ngit push 这类命令写在正文里时也只是在描述\nEOF",
      ['/tmp/build'],
    ))
    await flush()
    assert.equal(h.pendingEvents().length, shapes.length + 2, '载荷正文提到危险命令字样 ⇒ 多弹一次')
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, shapes.length + 1)
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[shapes.length + 1].permId, answer: 'deny' })
    assert.equal(await cost, 'deny')
  })
  // v0.7.14：**判定前的文本归一化（续行拼接 / 换行转义折空格 / 折叠空白）** 的端到端证据。
  //
  // 现场：先正常授权 `qoder:bash`，随后一条**跨行**命令 —— `git \` ⏎ `push origin main`
  // （shell 续行）或 `sh -c "true` ⏎ `rm -rf …"`（`-c` 正文里的换行）。改前这两类判 `null`
  // ⇒ 命中会话级工具名授权 ⇒ **零弹框零留痕放行**（真机上它们都真的会执行）。
  // 本用例钉住：这类帧必须再弹一次（不得 allow），归因日志 ≥1、免弹日志 0。
  it('E2E：续行 / 多行 `-c` 实参 ⇒ 已授权 qoder:bash 也必须再弹一次（不得静默放行）', async () => {
    const { h, rules } = await granted()
    const nl = '\n'
    const shapes = [
      [`git \\${nl}push origin main`, 'git push'],
      [`rm \\${nl}-rf /tmp/build`, 'rm -rf'],
      [`npm \\${nl}publish --tag next`, 'npm publish'],
      [`sh -c "true${nl}rm -rf /tmp/build"`, 'rm -rf'],
      [`bash -c "echo hi${nl}git push origin main"`, 'git push'],
      [`pwsh -Command "x${nl}npm publish"`, 'npm publish'],
      ['rm  -rf /tmp/build', 'rm -rf'], // 空白规避（多空格）
      [`git${'\t'}push origin main`, 'git push'], // 空白规避（TAB）
    ]
    for (const [i, [command, rule]] of shapes.entries()) {
      const p = h.permissionHandler(bashReq(`tc-v14-${i}`, command, ['/tmp/build']))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `${JSON.stringify(command)} 必须再弹一次（第 ${i + 1} 条）`)
      assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权')).length, 0, '不得走免弹通道')
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[i + 1].permId, answer: 'deny' })
      assert.equal(await p, 'deny', '必须仍由用户裁决')
      assert.match(h.logs.join('\n'), new RegExp(`危险命令门命中.*${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `留痕里应能看到归因 ${rule}（第 ${i + 1} 条）`)
    }
    assert.ok(h.logs.filter((l) => l.includes('危险命令门命中')).length >= shapes.length,
      `${shapes.length} 条都必须留下归因日志（不得为零）`)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true,
      '危险命令被拒不得撤销既有的工具名授权')

    // 阴性对照：多行但**每行都是普通命令/普通文本** ⇒ 照旧命中工具名授权免弹
    const safe = h.permissionHandler(bashReq(
      'tc-v14-safe',
      `echo hi${nl}ls -la /tmp${nl}git commit -q -F - <<'EOF'${nl}- planGrantWrites 新增 none 出口${nl}EOF`,
      ['/tmp/build'],
    ))
    await flush()
    assert.equal(h.pendingEvents().length, shapes.length + 1, '阴性对照不得新增弹球')
    assert.equal(await safe, 'allow', '普通多行命令 ⇒ 照旧命中工具名授权免弹')
  })
})

// ── v0.7.9 缺口A/B：决策携带 paths（目录子树授权 + paths/tools 互斥）与预填目录 ─────
//
// 客户端（dispatch 授权弹框）现在可以在决议里带一个 `paths: string[]`：
//   · 非空数组且有条目通过校验 → 授权写入的是**用户给定的那组目录**（目录子树语义），
//     自动分析出的路径一条都不写，工具名档也不写；
//   · 非空数组但**一条都没通过校验**（v0.7.10 新增）→ **两档都不写**：用户声明的是
//     目录，而这些目录全被拒 ⇒ 服务端从未收到「授权整个工具」的意图，不得代偿；
//   · `[]`     → 路径档一条不写，只写工具名档（用户逐行删空 = 明示要工具档）；
//   · 缺省     → 完全沿用 0.7.8 之前的自动分析行为（路径档 + 工具档同写）。
// 四条出口由 `planGrantWrites` 单点决定，本块断言的就是接线后的**实际写入结果**，
// 而不是那个纯函数的返回值（纯函数的用例在 test/permission-rules.test.js）。
//
// 安全口径两条，各有一枚用例钉住：
//   ① 不可盲信客户端：给定目录在服务端重新校验（非字符串/相对/根目录/空串一律丢弃）；
//   ② 声明目录**绕开** expandPathsWithParents——目录已存在时取父目录会把
//      「放行 /tmp/newproj」放大成「放行 /tmp」，而新建工程目录大多还不存在。
//
// 落盘面一律走注入的 `appendUserRule` 替身 + `mkdtempSync` 临时目录读回，
// **不碰用户真实 `~/.dsh`**（生产默认路径在测试进程里从未被调用）。

describe('v0.7.9 缺口A：allow-session + 用户给定 paths ⇒ 只写那些目录', () => {
  /** 生产展开器注入：只有绕开它，声明目录才不会被升父级 */
  const prodRules = () => createSessionRules({ expand: expandPathsWithParents })
  const pathRules = (rules, sid) => rules.rulesOf(sid).filter((r) => (r.paths || []).length > 0)
  const toolRules = (rules, sid) => rules.rulesOf(sid).filter((r) => (r.tools || []).length > 0)
  const bashReq = (toolCallId, command, paths) => ({
    product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
    toolCall: {
      _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: command,
      rawInput: { command }, toolCallId,
    },
    paths,
  })

  it('会话规则恰好等于给定目录：自动分析出的另两个路径一条都没进', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-g1', 'ls -la /Users/arming/.ssh', ['/Users/arming/.ssh/id_rsa', '/etc/hosts']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: ['/Users/arming/Downloads'] })
    assert.equal(await p1, 'allow')
    const stored = pathRules(rules, 'parent-1')
    assert.equal(stored.length, 1, '只应落一条路径规则')
    assert.deepEqual(stored[0].paths, ['/Users/arming/Downloads'], '规则集 = 用户给定目录原集，一个不多一个不少')
    assert.equal(stored[0].cwd, '/proj', '规则仍按 child 工作目录作用域')
    assert.equal(JSON.stringify(stored[0].paths).includes('id_rsa'), false, '自动分析的私有路径不得进规则')
    assert.equal(JSON.stringify(stored[0].paths).includes('etc/hosts'), false, '同上')

    // 子树语义：给定目录**里面**的任意路径免弹
    const p2 = h.permissionHandler(bashReq('tc-g2', 'ls -la /Users/arming/Downloads/x', ['/Users/arming/Downloads/2024/report.pdf']))
    assert.equal(await p2, 'allow', '目录子树内的请求应由会话路径档直接放行')
    assert.equal(h.pendingEvents().length, 1, '免弹不得再发 pending 事件')

    // 给定目录**外面**的路径仍须弹窗
    const p3 = h.permissionHandler(bashReq('tc-g3', 'ls -la /Users/arming/Movies', ['/Users/arming/Movies/a.mov']))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '授权目录之外必须仍弹窗（子树不外溢）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
  })

  it('安全护栏：声明一个尚不存在的目录 ⇒ 不得被展开成它的父目录（/tmp 不能被抓进来）', async () => {
    const declared = '/tmp/no-such-proj-9f3a'
    assert.equal(existsSync(declared), false, '前置条件：该目录必须不存在（新建工程是常态）')
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-gp1', 'ls -la /tmp/no-such-proj-9f3a', ['/tmp/no-such-proj-9f3a/main.js']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [declared] })
    assert.equal(await p1, 'allow')
    const stored = pathRules(rules, 'parent-1')
    assert.deepEqual(stored[0].paths, [declared], '写入的就是那一条目录本身')
    assert.equal(stored[0].paths.includes('/tmp'), false, '父目录 /tmp 一旦被展开 = 整台机器临时目录免弹，必须没有')
    const p2 = h.permissionHandler(bashReq('tc-gp2', 'ls -la /tmp', ['/tmp/someone-else-secret']))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '同父目录下的别的路径不得免弹')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('已存在的目录保留自身（不升一级）：mkdtemp 真实目录为证', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapA-dir-'))
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-gd1', `ls -la ${tmp}`, [path.join(tmp, 'a.txt')]))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [tmp] })
    assert.equal(await p1, 'allow')
    assert.deepEqual(pathRules(rules, 'parent-1')[0].paths, [tmp], '给定的是目录本身 ⇒ 规则就是它，不是它的父目录')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('互斥铁律①：paths 档非空 ⇒ 工具名档一条都不写（换目录仍须弹窗，不被 qoder:bash 短路）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-m1', 'ls -la /Users/arming/.ssh', ['/Users/arming/.ssh/id_rsa']))
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, 'Bash', '本例的 toolName 是解析得出来的 ⇒ 「没写工具档」只能是互斥所致')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: ['/Users/arming/Downloads'] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'paths 档下必须一条工具名授权都不写')
    assert.deepEqual(toolRules(rules, 'parent-1'), [], '评估器眼里也不该有任何 tools 条目')
    const p2 = h.permissionHandler(bashReq('tc-m2', 'ls -la /Users/arming/Movies', ['/Users/arming/Movies/a.mov']))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '同工具、授权目录外 ⇒ 仍弹窗（证明短路通道真的关掉了）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
    assert.equal(h.logs.filter((l) => l.includes('工具档不写：与 paths 互斥')).length, 1, '档位日志要如实说明为什么没写工具档')
  })

  it('互斥铁律②：paths 为空数组 ⇒ 无路径规则、工具档写入成功、换路径免弹', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-t1', 'ls -la /Users/arming/.ssh', ['/Users/arming/.ssh/id_rsa']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.size('parent-1'), 0, '清空目录后不得留下任何路径/类别规则')
    assert.deepEqual(pathRules(rules, 'parent-1'), [], '清空目录后不得留下任何路径/类别规则')
    // rulesOf 摊平工具授权时把 product 拆成独立字段（tools 里只放裸名 'bash'），
    // 评估器再用 compileRuleTools 拼回 `qoder:bash` —— 所以这里断言的是摊平形状。
    const grants = toolRules(rules, 'parent-1')
    assert.deepEqual(grants.map((r) => r.tools), [['bash']], '只写了工具名档一条')
    assert.equal(grants[0].product, 'qoder', '授权键仍带产品前缀（跨产品不借键）')
    assert.equal(grants[0].cwd, '/proj', '工具档同样按写入时的 cwd 作用域')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true)
    assert.equal(rules.toolGrantSize('parent-1'), 1)
    assert.equal(h.resolvedEvents().map((r) => r.outcome).join(), 'granted-session', '工具档写了就算授权成功')
    assert.equal(h.logs.filter((l) => l.includes('档位=tools 来源=用户给定空集 规则=[] 工具档=qoder:bash')).length, 1)
    assert.equal(h.logs.filter((l) => l.includes('用户在弹框里清空了目录，按互斥铁律本轮只写工具档')).length, 1, '归因文案要说清是用户清空而非解析失败')

    const p2 = h.permissionHandler(bashReq('tc-t2', 'cat /etc/hosts', ['/etc/hosts']))
    assert.equal(await p2, 'allow', '同会话同名工具换路径免弹')
    assert.equal(h.pendingEvents().length, 1)
    assert.equal(rules.size('parent-1'), 0, '免弹那条不得追加路径规则')
  })

  it('paths: [] 且工具名解析不出来 ⇒ 两档都没处写：仅本次放行 + 归因日志', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const req = (toolCallId) => ({
      product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
      toolCall: { _meta: { qoder: { toolName: 'search_codebase' } }, toolCallId }, // 不在 TOOL_NAME_SLUGS
      paths: ['/Users/arming/.ssh/id_rsa'],
    })
    const p1 = h.permissionHandler(req('tc-n1'))
    await flush()
    assert.equal(h.pendingEvents()[0].toolName, null)
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.size('parent-1'), 0, '用户清空了目录 ⇒ 即使自动分析有路径也不写路径档')
    assert.equal(rules.toolGrantSize('parent-1'), 0)
    assert.equal(h.resolvedEvents()[0].outcome, 'allowed-once', '什么都没写 ⇒ 只能算仅本次放行')
    assert.equal(h.logs.filter((l) => l.includes('工具档=(工具名解析不出来 ⇒ 实际什么都没写)')).length, 1)
    const p2 = h.permissionHandler(req('tc-n2'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '什么都没记住 ⇒ 第二次必须仍弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('不可盲信客户端：空串/相对路径/根目录/非字符串逐条丢弃且不抛异常', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-b1', 'ls -la /Users/x/ok', ['/Users/x/ok/a.txt']))
    await flush()
    h.onDecision({
      childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session',
      paths: ['', '   ', 'relative/dir', '/', 42, null, '/Users/x/ok', ' /Users/x/ok/ '],
    })
    assert.equal(await p1, 'allow', '畸形条目只影响写入内容，不能把审批链路搞崩')
    assert.deepEqual(pathRules(rules, 'parent-1')[0].paths, ['/Users/x/ok'], '只留下合法那一条（尾部分隔符规范化后与首条合并）')
    const dropLog = h.logs.filter((l) => l.includes('服务端丢弃非法条目'))
    assert.equal(dropLog.length, 1)
    assert.match(dropLog[0], /服务端丢弃非法条目 6 条/, `应丢弃 6 条（空串/空白/相对/根/number/object），实际：${dropLog[0]}`)
    for (const reason of ['空字符串', '非绝对路径', '根目录', '非字符串']) {
      assert.ok(dropLog[0].includes(reason), `丢弃原因要逐条写明（缺 ${reason}）`)
    }
  })

  it('v0.7.10 收口：声明集非空但全被丢弃 ⇒ 两档都不写（工具档绝不代偿），且如实回传丢弃原因', async () => {
    // 改前行为（0.7.9 及以前）：`paths: ['/', 'rel', '']` 全被丢弃 ⇒ `declared` 为空 ⇒
    // 退到 `tools` 出口，落 `qoder:bash` 工具档。危害：用户以为只授权了若干目录（实际
    // 一条都没落地），却拿到**整个工具跨任意路径**的授权——`cat /etc/passwd` 从此零弹窗。
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-a1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: ['/', 'rel', ''] })
    assert.equal(await p1, 'allow', '本次请求照常放行（收口只针对"记忆"，不针对"本次"）')
    assert.equal(rules.size('parent-1'), 0, '路径档一条都不写')
    assert.equal(rules.toolGrantSize('parent-1'), 0, '工具档也不得写——这是本收口的要害')
    assert.deepEqual(toolRules(rules, 'parent-1'), [], '没有任何工具档条目')
    assert.equal(h.resolvedEvents()[0].outcome, 'allowed-once', '什么都没记住 ⇒ 只能算仅本次放行')
    assert.equal(h.logs.filter((l) => l.includes('档位=none（用户声明的路径一条都没通过服务端校验 ⇒ 路径档与工具档一律不写，仅放行/询问本次）')).length, 1)
    assert.equal(h.logs.filter((l) => l.includes('服务端丢弃非法条目 3 条')).length, 1)
    const noneLog = h.logs.filter((l) => l.includes('一条都没通过服务端校验')).join('\n')
    for (const reason of ['根目录(/)', '非绝对路径(rel)', '空字符串()']) {
      assert.ok(noneLog.includes(reason), `丢弃原因与原文必须如实回给用户/日志（缺 ${reason}）：${noneLog}`)
    }
    // 危害复现面：若工具档被写进去，下面这条"完全另一条路径"的命令会被静默放行。
    const p2 = h.permissionHandler(bashReq('tc-a2', 'cat /etc/passwd', ['/etc/passwd']))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '什么都没记住 ⇒ 换任意路径的命令必须重新弹窗（这正是旧行为的放大点）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('v0.7.10 收口②：声明集非空但全被丢弃 + allow-always ⇒ 会话档与落盘档都不写', async () => {
    const rules = prodRules()
    const captured = []
    const h = harness({ bindings: bound(), rules, _appendUserRule: (rule) => { captured.push(rule); return { ok: true, count: captured.length } } })
    const p1 = h.permissionHandler(bashReq('tc-aa1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always', paths: ['./relative', 'not-absolute'] })
    assert.equal(await p1, 'allow')
    assert.deepEqual(captured, [], '落盘不得发生（既不落路径档也不落工具档）')
    assert.equal(rules.toolGrantSize('parent-1'), 0)
    assert.equal(rules.size('parent-1'), 0)
    assert.equal(h.resolvedEvents()[0].outcome, 'granted-once-fallback', '没落盘 ⇒ 只能算"本次放行"')
    const failLog = h.logs.filter((l) => l.includes('总是允许落盘失败')).join('\n')
    assert.ok(failLog.includes('一条都没通过服务端校验'), `落盘失败的归因必须说清是路径被拒：${failLog}`)
    assert.ok(failLog.includes('非绝对路径(./relative)'), `丢弃原文要如实带出：${failLog}`)
    assert.ok(failLog.includes('不写工具档'), `不得把工具档当兜底代偿：${failLog}`)
  })

  it('对照（差分）：客户端明确回传空 `paths: []` ⇒ 仍走 tools 档（既有语义不变）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-a3', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 1, '用户逐行删空 ⇒ 工具档照旧写入')
    assert.equal(h.logs.filter((l) => l.includes('档位=tools 来源=用户给定空集')).length, 1)
    const p2 = h.permissionHandler(bashReq('tc-a4', 'ls -la /etc', ['/etc/hosts']))
    assert.equal(await p2, 'allow', '工具档生效 ⇒ 同会话同名工具换路径免弹')
    assert.equal(h.pendingEvents().length, 1)
  })

  it('paths 缺省 ⇒ 回归守卫：自动分析结果与工具档照旧同写（0.7.8 行为逐字节不变）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const auto = ['/Users/x/only/a.txt']
    const p1 = h.permissionHandler(bashReq('tc-l1', 'ls -la /Users/x/only', auto))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.deepEqual(pathRules(rules, 'parent-1')[0].paths, expandPathsWithParents(auto), 'legacy 出口必须仍走生产展开器（文件+父目录）')
    assert.equal(rules.toolGrantSize('parent-1'), 1, 'legacy 出口两档同写')
    assert.equal(h.logs.filter((l) => l.includes('档位=自动分析（客户端未给定 paths，路径档与工具档同写）')).length, 1)
    assert.equal(h.logs.filter((l) => l.includes('来源=用户给定')).length, 0, '没给 paths 却打「用户给定」= 归因失真')
    assert.equal(h.logs.filter((l) => l.includes('服务端丢弃非法条目')).length, 0)
    // 免弹仍然生效（既有链路未被打断）
    const p2 = h.permissionHandler(bashReq('tc-l2', 'ls -la /Users/x/other', ['/Users/x/other/b.txt']))
    assert.equal(await p2, 'allow')
    assert.equal(h.pendingEvents().length, 1)
  })

  it('旁挂表按 permId 隔离、消费即删；未命中的 permId 带 paths 也不登记', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-k1', 'ls -la /Users/k/one', ['/Users/k/one/a.txt']))
    const p2 = h.permissionHandler(bashReq('tc-k2', 'ls -la /Users/k/two', ['/Users/k/two/b.txt']))
    await flush()
    const [a, b] = h.pendingEvents()

    h.onDecision({ childId: 'child-A', permId: 'tc-nope#1', answer: 'allow-session', paths: ['/Users/k/evil'] })
    assert.equal(h.decisionPaths.size, 0, 'permId 未命中 ⇒ 决议被忽略，附带目录也不许登记')

    h.onDecision({ childId: 'child-A', permId: b.permId, answer: 'allow-session', paths: ['/Users/k/two/only'] })
    assert.equal(await p2, 'allow')
    assert.equal(h.decisionPaths.size, 0, '取用即删，不许残留到下一条请求')
    assert.deepEqual(pathRules(rules, 'parent-1').map((r) => r.paths), [['/Users/k/two/only']], '只有被决议的那条吃到给定目录')

    h.onDecision({ childId: 'child-A', permId: a.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const allStored = pathRules(rules, 'parent-1').map((r) => JSON.stringify(r.paths)).sort()
    const wantStored = [JSON.stringify(['/Users/k/two/only']), JSON.stringify(expandPathsWithParents(['/Users/k/one/a.txt']))].sort()
    assert.deepEqual(allStored, wantStored, '第一条走 legacy，不受第二条污染')
    assert.equal(h.decisionPaths.size, 0)
  })

  it('工具档命中后，危险命令三条例外仍须逐次询问（rm -rf / npm publish / git push）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(bashReq('tc-x1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '工具档确实写成了')

    const dangerous = [
      ['rm -rf /tmp/build', ['/tmp/build']],
      ['npm publish', []],
      ['git push origin main', []],
    ]
    for (const [i, [cmd, pathList]] of dangerous.entries()) {
      const p = h.permissionHandler(bashReq(`tc-x-${i}`, cmd, pathList))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `${cmd} 必须弹球（第 ${i + 1} 次危险请求）`)
      const last = h.pendingEvents()[h.pendingEvents().length - 1]
      h.onDecision({ childId: 'child-A', permId: last.permId, answer: 'deny' })
      assert.equal(await p, 'deny', `${cmd} 必须仍由用户裁决，不被工具档放行`)
    }
    assert.equal(h.pendingEvents().length, 4, '一次授权 + 三次危险命令都弹了球')
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 3)
    const p5 = h.permissionHandler(bashReq('tc-x5', 'ls -la /etc', ['/etc/hosts']))
    assert.equal(await p5, 'allow', '正常命令依旧免弹（门只压危险命令）')
    assert.equal(h.pendingEvents().length, 4)
  })
})

describe('v0.7.9 缺口A：allow-always 落盘（只写临时目录，绝不碰真实 ~/.dsh）', () => {
  const bashReq = (toolCallId, command, paths) => ({
    product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
    toolCall: {
      _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: command,
      rawInput: { command }, toolCallId,
    },
    paths,
  })

  /** 用注入替身捕获生产真正要落盘的那条规则，再由测试把它写进临时目录 */
  const captureHarness = (rules) => {
    const captured = []
    const h = harness({
      bindings: bound(),
      rules,
      _appendUserRule: (rule) => { captured.push(rule); return { ok: true, count: captured.length } },
    })
    return { h, captured }
  }

  it('allow-always + 给定 paths ⇒ 落盘内容恰好是那些目录（临时目录写入后读回校验）', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const { h, captured } = captureHarness(rules)
    const p1 = h.permissionHandler(bashReq('tc-d1', 'ls -la /Users/arming/.ssh', ['/Users/arming/.ssh/id_rsa']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always', paths: ['/Users/arming/Downloads', '/Users/arming/Documents'] })
    assert.equal(await p1, 'allow')
    assert.equal(captured.length, 1, '只应调用一次落盘')
    assert.equal(captured[0].cwd, '/proj')
    assert.equal(captured[0].product, 'qoder')
    assert.deepEqual(captured[0].paths, ['/Users/arming/Downloads', '/Users/arming/Documents'], '落盘的就是用户给定那组目录')
    assert.match(String(captured[0].note), /目录由用户给定/, 'note 要写明来源')

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapA-disk-'))
    const w = appendUserRule(captured[0], tmp)
    assert.equal(w.ok, true)
    const diskRules = readUserAllowlist(tmp)
    assert.equal(diskRules.length, 1)
    assert.deepEqual(diskRules[0].paths, ['/Users/arming/Downloads', '/Users/arming/Documents'])
    const covered = evaluateRuleSources([{ tier: 'disk', rules: diskRules }], {
      product: 'qoder', cwd: '/proj', paths: ['/Users/arming/Downloads/2024/x.pdf'],
    })
    assert.equal(covered.allowed, true, '落盘规则对目录子树内请求生效')
    assert.equal(covered.via, 'paths')
    const outside = evaluateRuleSources([{ tier: 'disk', rules: diskRules }], {
      product: 'qoder', cwd: '/proj', paths: ['/Users/arming/Movies/a.mov'],
    })
    assert.equal(outside.allowed, false, '子树外不生效')
    // 同一条规则再点一次 ⇒ 幂等（不重复追加）
    appendUserRule(captured[0], tmp)
    assert.equal(readUserAllowlist(tmp).length, 1, '重复点击不得追加第二条同规则')
    rmSync(tmp, { recursive: true, force: true })
    assert.equal(h.resolvedEvents()[0].outcome, 'granted-always')
    assert.equal(h.logs.filter((l) => l.includes('已落盘（项目 /proj，2 路径') ).length, 1)
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'paths 档下 allow-always 同样不写工具档')
  })

  it('allow-always + paths: [] ⇒ 落盘为工具档 tools:["qoder:bash"]（新增落盘维度，须如实上报）', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const { h, captured } = captureHarness(rules)
    const p1 = h.permissionHandler(bashReq('tc-d2', 'ls -la /etc', ['/etc/hosts']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always', paths: [] })
    assert.equal(await p1, 'allow')
    assert.deepEqual(captured[0].tools, ['qoder:bash'], '落盘侧写的才是带前缀的完整授权键')
    assert.equal((captured[0].paths || []).length, 0, '清空目录 ⇒ 落盘里不许有任何路径')
    assert.match(String(captured[0].note), /互斥规则落盘为工具档/)

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapA-disk2-'))
    assert.equal(appendUserRule(captured[0], tmp).ok, true)
    const diskRules = readUserAllowlist(tmp)
    assert.equal(diskRules.length, 1, '只有 tools 的规则也必须被读回（readUserAllowlist 的 paths||tools 过滤）')
    assert.deepEqual(diskRules[0].paths, [], '落盘归一化后路径档为空集')
    assert.deepEqual(diskRules[0].tools, ['qoder:bash'])
    const hit = evaluateRuleSources([{ tier: 'disk', rules: diskRules }], {
      product: 'qoder', toolName: 'Bash', cwd: '/proj', paths: ['/Users/arming/.ssh/id_rsa'],
    })
    assert.equal(hit.allowed, true, '工具档命中')
    assert.equal(hit.via, 'tools')
    const otherCwd = evaluateRuleSources([{ tier: 'disk', rules: diskRules }], {
      product: 'qoder', toolName: 'Bash', cwd: '/proj2', paths: ['/Users/arming/.ssh/id_rsa'],
    })
    assert.equal(otherCwd.allowed, false, '项目级隔离：换了 cwd 不得吃到该规则')
    const otherProduct = evaluateRuleSources([{ tier: 'disk', rules: diskRules }], {
      product: 'opencode', toolName: 'Bash', cwd: '/proj', paths: ['/etc/hosts'],
    })
    assert.equal(otherProduct.allowed, false, '跨产品不得借键')
    rmSync(tmp, { recursive: true, force: true })
    assert.equal(h.logs.filter((l) => l.includes('已落盘（项目 /proj，工具档 qoder:bash') ).length, 1, '落盘日志要说清落的是工具档')
    assert.equal(rules.toolGrantSize('parent-1'), 1, '会话级工具档照旧同写（tools 档下 writeToolTier 为真）')
  })

  it('allow-always + 给定 paths 且解析不出工具名 ⇒ 仍按路径落盘，归因说「按互斥铁律不写工具档」', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const { h, captured } = captureHarness(rules)
    const req = {
      product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
      toolCall: { _meta: { qoder: { toolName: 'search_codebase' } }, toolCallId: 'tc-d3' },
      paths: ['/Users/x/a.txt'],
    }
    const p1 = h.permissionHandler(req)
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always', paths: ['/Users/x/declared'] })
    assert.equal(await p1, 'allow')
    assert.deepEqual(captured[0].paths, ['/Users/x/declared'])
    assert.equal(h.resolvedEvents()[0].outcome, 'granted-always', '路径档落成功就是 granted-always，与工具名无关')
    assert.equal(rules.toolGrantSize('parent-1'), 0)
  })

  it('落盘失败 ⇒ granted-once-fallback，且归因不得说成「解析不出工具名」（其实是有互斥）', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({
      bindings: bound(),
      rules,
      _appendUserRule: () => ({ ok: false, error: 'EROFS: read-only file system' }),
    })
    const p1 = h.permissionHandler(bashReq('tc-d4', 'ls -la /etc', ['/etc/hosts']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always', paths: ['/Users/x/declared'] })
    assert.equal(await p1, 'allow')
    assert.equal(h.resolvedEvents()[0].outcome, 'granted-once-fallback')
    const err = h.logs.filter((l) => l.includes('总是允许落盘失败'))
    assert.equal(err.length, 1)
    assert.match(err[0], /本轮按互斥铁律不写工具档（paths 档非空）/, `失败归因要说的是互斥，实际：${err[0]}`)
    assert.equal(rules.toolGrantSize('parent-1'), 0)
  })
})

describe('v0.7.9 缺口B：permission-pending 附 suggestedDirs（预填目录，paths 语义不变）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapB-'))
  writeFileSync(path.join(tmp, 'b.txt'), 'x', 'utf8')

  it('给定路径 → 取父目录 + 去重 + 规范化；已存在目录保留自身；既有 paths 字段原样', async () => {
    const h = harness({ bindings: bound() })
    const input = [path.join(tmp, 'a.txt'), tmp, path.join(tmp, 'b.txt'), '/etc/hosts', '/no/such/file.txt']
    h.permissionHandler({
      product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
      toolCall: { _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: 'ls -la', toolCallId: 'tc-s1' },
      paths: input,
    })
    await flush()
    const [pending] = h.pendingEvents()
    assert.deepEqual(pending.paths, input, 'paths 仍是本次请求的结构化路径原文（老消费方不受影响）')
    assert.deepEqual(pending.suggestedDirs, [tmp, '/etc', '/no/such'], 'a.txt/b.txt/目录本身三者归并成同一个 tmp')
    assert.equal(pending.suggestedDirs.includes(path.join(tmp, 'a.txt')), false, '不得把文件当目录预填')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('新增字段而非替换：载荷其余键（permId/category/toolName/cwd/parentSessionId）齐备', async () => {
    const h = harness({ bindings: bound() })
    h.permissionHandler({ ...REQ, toolCall: { ...REQ.toolCall, toolCallId: 'tc-s2' } })
    await flush()
    const [pending] = h.pendingEvents()
    for (const key of ['childId', 'permId', 'product', 'description', 'paths', 'suggestedDirs', 'inferredDirs', 'category', 'toolName', 'toolNameSource', 'rawToolName', 'cwd', 'parentSessionId', 'remoteSessionId', 'at']) {
      assert.ok(key in pending, `老载荷键 ${key} 不得消失`)
    }
    assert.equal(pending.permId, 'tc-s2#1')
    assert.deepEqual(pending.suggestedDirs, [], 'web_search 无路径 ⇒ 空数组（不是 undefined，UI 侧可直接渲染）')
  })

  it('畸形 paths（非数组/含根目录）⇒ suggestedDirs 为 [] 且不抛', async () => {
    for (const bad of [undefined, null, 42, 'string', ['/'], ['/etc'], []]) {
      const h = harness({ bindings: bound() })
      const p = h.permissionHandler({ ...REQ, toolCall: { ...REQ.toolCall, toolCallId: 'tc-s3' }, paths: bad })
      await flush()
      assert.equal(h.pendingEvents().length, 1, `${JSON.stringify(bad)}：仍要正常弹窗`)
      const [pending] = h.pendingEvents()
      assert.deepEqual(pending.paths, Array.isArray(bad) ? bad : [], 'reqPaths 归一化行为不变')
      assert.ok(Array.isArray(pending.suggestedDirs), `${JSON.stringify(bad)}：suggestedDirs 必须是数组`)
      assert.equal(pending.suggestedDirs.includes('/'), false, '根目录不得作为预填目录（等于全放行）')
      h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'deny' })
      assert.equal(await p, 'deny')
    }
  })
})

// ── v0.7.9 缺口D 修正：正文推测目录只进 inferredDirs（推测预填档），绝不进自动规则 ──────
//
// 用户裁决两轮：① 正文扫描**不删**，但它的产物不得与结构化结果混为一谈；② 弹框形态
// 定稿——**没有勾选框**，是一个「每行一个路径」的可编辑文本框，预填
// `suggestedDirs` 后接 `inferredDirs`，靠**改行/删行**表达意图（删一行即去掉该项，
// 也可以把某行改成更上层的目录）。所以这里的分离不是"默认勾/不勾"，而是：
//   · `suggestedDirs` = 本次请求**实际触达**的目录，只来自结构化来源
//     （diff 块 path / rawInput 路径字段 / locations / 执行类帧的 rawInput.command）；
//   · `inferredDirs` = 正文文本**推测**出的目录，排在后面；
//   · **自动**规则写入（`paths` 缺省时的自动分析）只用结构化那一份。
// 为什么要分：正文是被编辑的**内容**，仓库里谁都能写
// /etc/passwd、~/.ssh、~/.qoder/settings.json；让它们和"实际触达"混进同一档，
// 结构化的审计价值就没了，且 `paths` 缺省时的自动分析会把它们直接写成规则。
// 下面三组值（payload 的两个档 + 实际写出的规则）必须互不越界。
describe('v0.7.9 缺口D 修正：inferredDirs 只作推测预填，正文假路径不得进入自动规则', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapD-fix-'))
  const targetFile = path.join(tmp, 'target.txt')
  writeFileSync(targetFile, 'x', 'utf8')
  const prodRules = () => createSessionRules({ expand: expandPathsWithParents })
  const pathRules = (rules, sid) => rules.rulesOf(sid).filter((r) => (r.paths || []).length > 0)

  // 正文里可以随便写的三个敏感目录（/etc、某工程目录、用户自己的 qoder 配置目录）：
  // 它们不是本次请求触达的东西，只是被编辑内容里的字符串。
  const DECOY_TEXT = '先读 /etc/passwd，再写 /tmp/proj/a.txt，顺手改 ~/.qoder/settings.json'
  const DECOY_DIRS = ['/etc', '/tmp/proj', path.join(os.homedir(), '.qoder')]

  // 弹框预填 = 两档顺序拼接（UI 侧的形态，这里按同一顺序拼一次，方便逐行断言）
  const prefilledRows = (pending) => [...pending.suggestedDirs, ...pending.inferredDirs]

  // 与生产链路同形（acp.js:434 `paths: extractPaths(req.toolCall)`）——
  // 测试不自己拼 paths，才能证明"进规则的就是结构化那一份"。
  const reqFor = (frame, extra = {}) => ({
    product: 'qoder', sessionId: 'acp-1', description: 'Allow editing?',
    toolCall: frame, paths: extractPaths(frame), ...extra,
  })

  const editFrame = (toolCallId) => ({
    kind: 'edit',
    title: `edit ${targetFile}`,
    content: [{ type: 'diff', path: targetFile, oldText: '', newText: DECOY_TEXT }],
    rawInput: { file_path: targetFile },
    toolCallId,
  })

  it('Edit 帧：suggestedDirs 只有被编辑文件所在目录，三个正文假目录全在 inferredDirs，两档不重复', async () => {
    const h = harness({ bindings: bound() })
    h.permissionHandler(reqFor(editFrame('tc-d1')))
    await flush()
    const [pending] = h.pendingEvents()
    assert.deepEqual(pending.suggestedDirs, [tmp], '结构化那一档只能是**被编辑文件所在目录**')
    assert.deepEqual(pending.inferredDirs, DECOY_DIRS, '推测档 = 正文扫出的三个目录（同样取父目录 + 去重 + 规范化）')
    for (const decoy of DECOY_DIRS) {
      assert.equal(pending.suggestedDirs.includes(decoy), false, `${decoy} 来自正文，绝不允许混进结构化那一档`)
    }
    assert.equal(pending.inferredDirs.filter((d) => pending.suggestedDirs.includes(d)).length, 0,
      '两档不得重复（预填是同一段文本的先后两截，重复项会让同一目录出现两行）')
    assert.deepEqual(prefilledRows(pending), [tmp, ...DECOY_DIRS],
      '弹框预填顺序：结构化在前、推测在后（UI 侧就是 [...suggestedDirs, ...inferredDirs]）')
    assert.deepEqual(pending.paths, [targetFile], '既有 paths 字段语义未变')
  })

  it('只有正文假路径、无结构化路径的畸形帧 ⇒ 自动分析一条路径规则都不写（推测档照常预填）', async () => {
    const bodyOnly = {
      kind: 'edit', title: '写入配置文件',
      // 只有 content 文本块，没有任何路径型结构化字段：Write/Edit 的 content 装的是文件正文
      content: [{ type: 'content', content: { text: DECOY_TEXT } }],
      toolCallId: 'tc-d2',
    }
    assert.deepEqual(extractPaths(bodyOnly), [], '前置条件：非执行类帧 + 结构化一无所获 ⇒ 空集')
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p = h.permissionHandler(reqFor(bodyOnly))
    await flush()
    const [pending] = h.pendingEvents()
    assert.deepEqual(pending.suggestedDirs, [], '正文里的路径不得进结构化那一档')
    assert.deepEqual(pending.inferredDirs, DECOY_DIRS, '同一批字符串照常预填在后面那几行，由人来删行/改行')
    // 点「会话期总是允许」且**不给** paths ⇒ 走 legacy 自动分析，而自动分析看到的是空集
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p, 'allow')
    assert.equal(rules.size('parent-1'), 0, '自动分析空集 ⇒ 什么都不写；正文假路径若混进来这里就是 3')
    assert.equal(pathRules(rules, 'parent-1').length, 0, '不得写出任何路径规则')
    assert.equal(rules.toolGrantSize('parent-1'), 0, 'title 不是工具名 slug ⇒ 工具档也不写')
  })

  it('用户删行/改行后显式回传 `paths` ⇒ 规则恰等于回传集，被删掉的推测目录一个都不在里面', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p = h.permissionHandler(reqFor(editFrame('tc-d3')))
    await flush()
    const [pending] = h.pendingEvents()
    // 弹框预填 4 行（1 结构化 + 3 推测），用户把后面三行**删掉** ⇒ 回传的 paths 只剩结构化那行
    const keptRows = prefilledRows(pending).filter((dir) => !DECOY_DIRS.includes(dir))
    assert.deepEqual(keptRows, [tmp], '前置：删掉三行推测后，文本框里只剩结构化那行')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session', paths: keptRows })
    assert.equal(await p, 'allow')
    const stored = pathRules(rules, 'parent-1')
    assert.equal(stored.length, 1, '只应落一条路径规则')
    assert.deepEqual(stored[0].paths, [tmp], '显式回传才写，且写的就是文本框里剩下的那一行')
    for (const decoy of DECOY_DIRS) {
      assert.equal(JSON.stringify(stored).includes(decoy), false,
        `${decoy} 只在推测档、被用户删了行 ⇒ 不在回传的 paths 里，也就不得进规则`)
    }
  })

  it('kind=execute 的 Bash 帧：命令正文路径属于 suggestedDirs（实际触达），推测档因排除只剩无关文本目录', async () => {
    const sshDir = path.join(os.homedir(), '.ssh')
    const frame = {
      _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: 'cat /etc/passwd',
      rawInput: { command: 'cat /etc/passwd', description: `顺便看看 ~/.ssh/id_rsa` },
      toolCallId: 'tc-d4',
    }
    assert.deepEqual(extractPaths(frame), ['/etc/passwd'], '命令正文里的路径就是本次请求的客体')
    const h = harness({ bindings: bound() })
    h.permissionHandler({ ...reqFor(frame), description: 'Allow bash?' })
    await flush()
    const [pending] = h.pendingEvents()
    assert.deepEqual(pending.suggestedDirs, ['/etc'], '执行类帧的命令路径**是**"实际触达" ⇒ 归结构化那一档，预填在最前')
    assert.deepEqual(pending.inferredDirs, [sshDir],
      '同一批里已由 suggestedDirs 覆盖的 /etc 被排除，只剩 description 那句无关文本推测出的目录（预填在后）')
  })

  it('不变式：决议**不带** `paths` 时，推测档每一项都不出现在会话规则或落盘规则里（点「总是允许」也一样）', async () => {
    const rules = prodRules()
    const captured = []
    const h = harness({
      bindings: bound(), rules,
      _appendUserRule: (rule) => { captured.push(rule); return { ok: true, count: captured.length } },
    })
    const p = h.permissionHandler(reqFor(editFrame('tc-d5')))
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.inferredDirs.length, 3, '前置：这一帧确实有三个推测目录（否则下面的不变式是空转）')
    // 不传 paths ⇒ 缺省走自动分析，而自动分析只看结构化那一份
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-always' })
    assert.equal(await p, 'allow')
    const written = JSON.stringify([rules.rulesOf('parent-1'), captured])
    for (const dir of pending.inferredDirs) {
      assert.equal(written.includes(dir), false, `推测档目录 ${dir} 出现在自动写入面里 ⇒ 正文扫描又变成自动授权依据了`)
    }
    assert.ok(written.includes(tmp), '结构化目标目录照常落规则（证明不是"什么都没写"造成的假绿）')
    rmSync(tmp, { recursive: true, force: true })
  })

  it('源码不变量：extractPaths 不含正文扫描；scanPathsLoose 在 lib/index.js 只有一个推测档预填调用点', () => {
    const acpSrc = readFileSync(path.join(repoRoot, 'lib/bridges/acp.js'), 'utf8')
    const start = acpSrc.indexOf('export function extractPaths(toolCall) {')
    assert.ok(start >= 0, 'acp.js 里 extractPaths 被改名或删除？')
    const body = acpSrc.slice(start, acpSrc.indexOf('\n}', start) + 2)
    assert.equal(body.includes('scanPathsLoose'), false,
      'extractPaths 再接回正文扫描 ⇒ 规则输入就不再只有结构化来源了')

    const scanCalls = src.split('\n').filter((line) => /scanPathsLoose\s*\(/.test(line))
    assert.equal(scanCalls.length, 1, `lib/index.js 里 scanPathsLoose 的调用点必须只有一处，实际 ${scanCalls.length} 处`)
    assert.match(scanCalls[0], /inferredDirs\(scanPathsLoose\(toolCall\)/,
      '那一处只能是 inferredDirs(scanPathsLoose(toolCall), suggestedDirsForUI)')
    // 写入面的四个实参位置一律不许出现推测档
    for (const marker of ['planGrantWrites(', 'sessionRules.add(', 'appendUserRule(', 'diskRule =']) {
      for (const line of src.split('\n').filter((l) => l.includes(marker))) {
        assert.equal(/scanPathsLoose|inferredDirs/i.test(line), false, `${marker} 的实参里出现推测档 ⇒ 越界：${line.trim()}`)
      }
    }
  })
})

// ── v0.7.9（复审 B-1）：编辑 JSON 配置（正文本身是 JSON）不得把正文里的路径写成授权 ──
//
// 现场：改 `*.json` 配置时被编辑文件的**正文本身就是 JSON**。旧实现对任意字符串值
// try `JSON.parse` 再下钻，正文里的 `{"dest":"~/.ssh/id_rsa"}` 被当成**结构化**路径，
// 与真目标一起进 `extractPaths`（唯一能自动变成规则的集合）⇒ 会话授权里多出 `~/.ssh`
// ⇒ 此后同会话对该目录的请求被静默放行。本用例走完整接线：结构化提取 → 弹窗预填 →
// 决议 → 规则写入 → 第二条请求是否被放行。
describe('v0.7.9 复审 B-1：JSON 形状正文的编辑不得把 ~/.ssh 写进会话授权', () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshKnownHosts = path.join(sshDir, 'known_hosts')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gapB1-json-'))
  const target = path.join(tmp, 'a.json')
  const JSON_BODY = '{"dest":"~/.ssh/id_rsa","path":"/etc/passwd"}'
  const frame = {
    kind: 'edit',
    title: `Edit ${target}`,
    content: [{ type: 'diff', path: target, oldText: '{}', newText: JSON_BODY }],
    rawInput: { file_path: target, old_string: '{}', new_string: JSON_BODY },
    toolCallId: 'tc-b1',
  }
  const req = (toolCall, paths, description = 'Allow editing?') => ({
    product: 'qoder', sessionId: 'acp-1', description, toolCall, paths,
  })

  it('前置：自动规则输入只有被编辑的 JSON 文件（正文里的两条路径不在集合里）', () => {
    assert.deepEqual(extractPaths(frame), [target])
    // 差分：0.7.8 的文本扫描确实会抓到正文里的两条（本 fixture 复现的是真实现场）
    const loose = scanPathsLoose(frame)
    assert.ok(loose.includes('~/.ssh') || loose.some((p) => p.includes('.ssh')),
      `旧文本扫描确实抓到正文里的 ~/.ssh（实际 ${JSON.stringify(loose)}）`)
  })

  it('端到端：正文含 ~/.ssh ⇒ 无任何 ~/.ssh* 进规则；随后 ~/.ssh/known_hosts 仍须弹窗', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    const [pending] = h.pendingEvents()
    assert.deepEqual(pending.suggestedDirs, [tmp],
      '结构化那一档只有被编辑文件所在目录；正文里的 ~/.ssh、/etc 一条都不许混进来')
    assert.equal(pending.suggestedDirs.some((d) => d.startsWith(sshDir) || d === '/etc'), false)
    // 推测档（inferredDirs）允许出现正文里的目录——它只是预填展示，用户可删行；
    // 但下面要证明：**不改不删地走 legacy 出口**时，它也不进规则。
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const stored = JSON.stringify(rules.rulesOf('parent-1'))
    assert.equal(stored.includes('.ssh'), false, `会话规则里不得出现 ~/.ssh（实际 ${stored}）`)
    assert.equal(stored.includes('/etc'), false, `正文里的 /etc/passwd 同样不得进规则（实际 ${stored}）`)
    assert.equal(stored.includes(tmp), true, '被编辑文件所在目录照常写入（修复没有把正常路径一并砍掉）')

    // 第二条请求：同会话、同 child，读 ~/.ssh/known_hosts —— 不得因本次授权被放行
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-b1-2' }
    const p2 = h.permissionHandler(req(readFrame, extractPaths(readFrame), 'Allow reading known_hosts?'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '未被授权覆盖 ⇒ 必须照常弹窗（不得静默放行）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('落盘面同样干净：allow-always 落下的规则里不得有 ~/.ssh*（会话/落盘两条出口都验）', async () => {
    const saved = []
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({
      bindings: bound(), rules,
      _appendUserRule: (rule) => { saved.push(rule); return { ok: true, count: 1 } },
    })
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    const [pending] = h.pendingEvents()
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    assert.equal(saved.length, 1, '落盘通道恰好被调用一次（注入替身，绝不写用户真实 ~/.dsh）')
    const disk = JSON.stringify(saved[0])
    assert.equal(disk.includes('.ssh'), false, `落盘规则里不得出现 ~/.ssh（实际 ${disk}）`)
    assert.equal(disk.includes('/etc'), false, `正文里的 /etc/passwd 同样不得落盘（实际 ${disk}）`)
    assert.equal(disk.includes(tmp), true, '被编辑文件所在目录照常落盘（修复没有把正常路径一并砍掉）')
  })

  it('对照（差分）：同一份正文若走旧的 JSON 下钻，~/.ssh 会被写进规则 —— 证明本用例有牙齿', async () => {
    // 用「正文里的路径当成结构化结果」这一旧行为喂同一条链路：规则里立刻出现 ~/.ssh，
    // 第二条请求被直接放行 ⇒ 说明本组断言不是恒真的空断言。
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const legacyPaths = [target, path.join(sshDir, 'id_rsa')]
    const p1 = h.permissionHandler(req(frame, legacyPaths))
    await flush()
    const [pending] = h.pendingEvents()
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(JSON.stringify(rules.rulesOf('parent-1')).includes('.ssh'), true,
      '旧行为的产物确实会写进 ~/.ssh（这是被修复的现场）')
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-b1-3' }
    const p2 = h.permissionHandler(req(readFrame, [sshKnownHosts], 'Allow reading known_hosts?'))
    assert.equal(await p2, 'allow', '旧行为下这条请求被静默放行 —— 正是 B-1 的危害面')
    assert.equal(h.pendingEvents().length, 1, '第二条没有弹窗')
  })
})

// ── v0.7.9（第四轮终审**阻断**）：正文对象冒充 ACP 块 ⇒ 端到端变成会话授权、静默放行 ────
//
// 终审端到端现场：`content` 带任意 `type` 的 Write 帧 ⇒
// `extractPaths = ["/p/a.json","~/.ssh/id_rsa"]` ⇒ 一次 `allow-session` 后会话规则里出现
// `/Users/arming/.ssh`（+ `tools:["write"]`）⇒ 之后对 `~/.ssh/known_hosts` 的请求
// `pending=0`、`outcome=allow`（**静默放行**）；对照（正文对象**无** `type`）不泄漏、
// 后续请求正常弹窗。本用例走完整接线：结构化提取 → 弹窗 → 决议 → 规则写入
// （会话档与**真实落盘读写**两条出口）→ 第二条请求是否弹窗。
// 把 `isContentBlock` 改回 `hasOwnProperty('type')` ⇒ 本 describe 立刻转红。
describe('v0.7.9 第四轮终审阻断：正文对象冒充 ACP 块不得写进会话/落盘规则', () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshKnownHosts = path.join(sshDir, 'known_hosts')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'blk4-'))
  const diskDir = mkdtempSync(path.join(os.tmpdir(), 'blk4-disk-'))
  const target = path.join(tmp, 'a.json')
  /** 终审探针载荷：顶层 diff 块给出真目标；`rawInput.content` 是**带 type 的正文对象** */
  const frame = {
    kind: 'write',
    name: 'Write',
    title: `Write ${target}`,
    content: [{ type: 'diff', path: target, newText: '{"path":"~/.ssh/id_rsa"}' }],
    rawInput: { file_path: target, content: { type: 'module', path: path.join(sshDir, 'id_rsa') } },
    toolCallId: 'tc-blk',
  }
  const req = (toolCall, paths, description = 'Allow writing file?') => ({
    product: 'qoder', sessionId: 'acp-1', description, toolCall, paths,
  })

  it('前置：结构化提取只拿到被写的那个文件（正文对象里的 ~/.ssh/id_rsa 不在集合里）', () => {
    assert.deepEqual(extractPaths(frame), [target], '带 type 的正文对象不得被当 ACP 块')
    assert.equal(JSON.stringify(extractPaths(frame)).includes('.ssh'), false)
    // 阴性对照：同一形状但正文对象**不带** type（改前就不泄漏的那一支）——行为必须一致
    const noType = { ...frame, rawInput: { file_path: target, content: { path: path.join(sshDir, 'id_rsa') } } }
    assert.deepEqual(extractPaths(noType), [target])
  })

  it('端到端（会话档）：allow-session 后规则里无任何 ~/.ssh*，随后读 known_hosts 仍须弹窗', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(h.pendingEvents().length, 1, '第一条请求照常弹窗')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const stored = JSON.stringify(rules.rulesOf('parent-1'))
    assert.equal(stored.includes('.ssh'), false, `会话规则里不得出现任何 ~/.ssh*（实际 ${stored}）`)
    assert.equal(stored.includes(tmp), true, '被写文件所在目录照常写入（修复没有把正常路径一并砍掉）')
    // 第二条请求：同会话、同 child，读 ~/.ssh/known_hosts —— 不得因本次授权被放行
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-blk-2' }
    const p2 = h.permissionHandler(req(readFrame, extractPaths(readFrame), 'Allow reading known_hosts?'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '阻断修复点：必须**照常弹窗**（pending 增加），不得静默 allow')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('端到端（落盘档）：allow-always 落下的规则（真实 appendUserRule/readUserAllowlist 读回）同样干净', async () => {
    const saved = []
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({
      bindings: bound(), rules,
      _appendUserRule: (rule) => { saved.push(rule); return { ok: true, count: saved.length } },
    })
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    assert.equal(saved.length, 1, '落盘通道恰好被调用一次（注入替身捕获，随后写进临时目录）')
    const disk = JSON.stringify(saved[0])
    assert.equal(disk.includes('.ssh'), false, `落盘规则对象里不得出现 ~/.ssh（实际 ${disk}）`)
    // 真实写入/读回：产线读写器也要读不出 ~/.ssh（写的是临时目录，绝不碰真实 ~/.dsh）
    assert.equal(appendUserRule(saved[0], diskDir).ok, true, '落盘写入成功')
    const readBack = JSON.stringify(readUserAllowlist(diskDir))
    assert.equal(readBack.includes('.ssh'), false, `读回的落盘规则里不得出现 ~/.ssh（实际 ${readBack}）`)
    assert.equal(readBack.includes(tmp), true, '被写文件所在目录照常落盘')
  })

  it('对照（差分）：若正文对象那条路径真的进了产物，第二条请求会被静默放行 —— 证明断言有牙齿', async () => {
    // 用「正文对象里的路径也当成结构化结果」这一旧行为喂同一条链路：规则里立刻出现
    // ~/.ssh，第二条请求直接 allow ⇒ 说明上面那组断言不是恒真的空断言。
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const legacyPaths = [target, path.join(sshDir, 'id_rsa')]
    const p1 = h.permissionHandler(req(frame, legacyPaths))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(JSON.stringify(rules.rulesOf('parent-1')).includes('.ssh'), true,
      '旧行为的产物确实会写进 ~/.ssh（这就是第四轮阻断的现场）')
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-blk-3' }
    const p2 = h.permissionHandler(req(readFrame, [sshKnownHosts], 'Allow reading known_hosts?'))
    assert.equal(await p2, 'allow', '旧行为下这条请求被静默放行 —— 正是本阻断的危害面')
    assert.equal(h.pendingEvents().length, 1, '第二条没有弹窗')
  })
})

// ── v0.7.9（第五轮终审**阻断**）：正文数组元素的 `content` 再下钻 ⇒ 端到端变成会话授权、静默放行 ─
//
// 终审端到端现场：`{kind:'edit', rawInput:{file_path:'/p/a.json', files:[{content:{type:'diff',
// path:'~/.ssh/known_hosts'}}]}}` ⇒ `extractPaths` 含 `~/.ssh/known_hosts` ⇒ 一次
// `allow-session` 后会话规则里出现 `/Users/arming/.ssh`（目录子树）⇒ 此后对
// `~/.ssh/known_hosts` 的请求 `pending` **不增加**、被静默放行。
//
// 根因：第四轮把"块数组资格只给 toolCall 顶层"加在 `walk` 的 `content`/`locations` 键分支，
// **漏了 `descendPathValue` 数组分支**那份同形下钻；而 `type` 只是**正文对象里的一个键**，
// 正文完全可控 ⇒ 白名单对「帧字段」有效、对「正文」无效。
//
// 本组用例两处都钉：① 会话档；② **真实 `appendUserRule`/`readUserAllowlist`**（临时目录，
// 绝不碰真实 `~/.dsh`）。会话规则的**放行判定**也走真实读盘（注入
// `userRules: () => readUserAllowlist(diskDir)`），所以"第二条请求是否弹窗"是端到端的真读数。
// 把 `item.content` 下钻加回去、或去掉块级 `path` 的类型闸，本 describe 立刻转红。
describe('v0.7.9 第五轮终审阻断：正文数组元素的 content 不得写进会话/落盘规则', () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshKnownHosts = path.join(sshDir, 'known_hosts')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'blk5-'))
  const diskDir = mkdtempSync(path.join(os.tmpdir(), 'blk5-disk-'))
  const target = path.join(tmp, 'a.json')
  /** 终审探针载荷：真目标在 `rawInput.file_path`；`files[].content` 是**带 type 的正文对象** */
  const frame = {
    kind: 'write',
    name: 'Write',
    title: `Write ${target}`,
    content: [{ type: 'diff', path: target, newText: '{"path":"~/.ssh/id_rsa"}' }],
    rawInput: { file_path: target, files: [{ content: { type: 'diff', path: sshKnownHosts } }] },
    toolCallId: 'tc-blk5',
  }
  const req = (toolCall, paths, description = 'Allow writing file?') => ({
    product: 'qoder', sessionId: 'acp-1', description, toolCall, paths,
  })
  /** 真实落盘读写器 + 真实读盘判定（写/读都指向临时目录） */
  const diskHarness = (rules) => harness({
    bindings: bound(),
    rules,
    userRules: () => readUserAllowlist(diskDir),
    _appendUserRule: (rule) => appendUserRule(rule, diskDir),
  })

  it('前置：23 个 PATH_KEYS 的 `[].content` 形状一律拿不到正文路径，且带 type 的正文数组不再泄漏', () => {
    assert.deepEqual(extractPaths(frame), [target], 'files[].content 是工具参数正文（终审 23 键命中 22 个的那一族）')
    assert.equal(JSON.stringify(extractPaths(frame)).includes('.ssh'), false)
    const targetKeys = [
      'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'notebook_path',
      'absolute_path', 'target_file', 'target_path', 'target',
      'dir', 'dirs', 'dir_path', 'directory', 'directories',
      'dest', 'destination', 'src', 'source', 'uri', 'location', 'locations',
    ]
    assert.equal(targetKeys.length, 23)
    for (const key of targetKeys) {
      const carrier = key === 'file_path' ? 'notebook_path' : 'file_path'
      for (const inner of [{ content: { type: 'diff', path: sshKnownHosts } }, { content: [{ type: 'diff', path: sshKnownHosts }] }]) {
        const probe = { kind: 'edit', rawInput: { [carrier]: target, [key]: [inner] } }
        assert.deepEqual(extractPaths(probe), [target], `rawInput.${key}[].content 是正文 ⇒ 不下钻`)
      }
    }
    // 阴性对照：改成"块级 path 不看类型"会复漏的那两条（终审 B5）+ 单加一个 type 键的既有载荷
    for (const type of ['TEXT', 'text', 'Diff', 'diff', 'module', 'object']) {
      assert.equal(extractPaths({ content: [{ type, path: sshKnownHosts }] }).includes(sshKnownHosts), type.toLowerCase() === 'diff',
        `块级 path 只对帧级块类型成立（type:"${type}"）`)
    }
  })

  it('端到端（会话档）：allow-session 后规则里无任何 ~/.ssh*，随后读 known_hosts 必须弹窗', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = diskHarness(rules)
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(h.pendingEvents().length, 1, '第一条请求照常弹窗')
    assert.deepEqual(pending.suggestedDirs, [tmp], '结构化档只有被写文件所在目录')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const stored = JSON.stringify(rules.rulesOf('parent-1'))
    assert.equal(stored.includes('.ssh'), false, `会话规则里不得出现任何 ~/.ssh*（实际 ${stored}）`)
    assert.equal(stored.includes(tmp), true, '被写文件所在目录照常写入（修复没有把正常路径一并砍掉）')
    // 第二条请求：同会话、同 child，读 ~/.ssh/known_hosts —— 不得因本次授权被放行
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-blk5-2' }
    const p2 = h.permissionHandler(req(readFrame, extractPaths(readFrame), 'Allow reading known_hosts?'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '阻断修复点：pending 必须增加（照常弹窗），不得静默 allow')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('端到端（落盘档）：allow-always 写进临时目录的规则读回后同样无 ~/.ssh*', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = diskHarness(rules)
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    const onDisk = readUserAllowlist(diskDir)
    assert.equal(onDisk.length >= 1, true, '落盘通道确实写了一条（否则下面的断言是空转）')
    const disk = JSON.stringify(onDisk)
    assert.equal(disk.includes('.ssh'), false, `读回的落盘规则里不得出现 ~/.ssh（实际 ${disk}）`)
    assert.equal(disk.includes(tmp), true, '被写文件所在目录照常落盘')
    // 落盘规则参与后续判定（真实读盘）：已知被授权的那个目录照常放行，~/.ssh 不得被放行
    const again = h.permissionHandler(req({ ...frame, toolCallId: 'tc-blk5-4' }, extractPaths(frame)))
    await flush()
    assert.equal(h.pendingEvents().length, 1, '同目标重复请求被落盘规则覆盖 ⇒ 不弹窗（证明读盘链路真的在生效）')
    assert.equal(await again, 'allow')
  })

  it('对照（差分）：若 `files[].content` 那条路径真的进了产物，第二条请求会被静默放行 —— 证明断言有牙齿', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = diskHarness(rules)
    const legacyPaths = [target, sshKnownHosts]
    const p1 = h.permissionHandler(req(frame, legacyPaths))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(JSON.stringify(rules.rulesOf('parent-1')).includes('.ssh'), true,
      '旧行为的产物确实把 ~/.ssh 写进规则（这就是第五轮阻断的现场）')
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-blk5-3' }
    const p2 = h.permissionHandler(req(readFrame, [sshKnownHosts], 'Allow reading known_hosts?'))
    assert.equal(await p2, 'allow', '旧行为下这条请求被静默放行 —— 正是本阻断的危害面')
    assert.equal(h.pendingEvents().length, 1, '第二条没有弹窗（pending 不增加）')
  })
})

// ── v0.7.9（第六轮裁定）：信封边界 —— `rawInput`/`arguments` 下的数组不得写进授权 ──────────
//
// 现场（第五轮残余）：`{kind:'edit', rawInput:{file_path:'/p/a.json', files:[{path:'~/.ssh/
// known_hosts'}]}}` ⇒ `extractPaths` 含 `~/.ssh/known_hosts` ⇒ 一次 `allow-session` 后会话
// 规则里出现 `/Users/arming/.ssh`（目录子树）⇒ 此后对 `~/.ssh/known_hosts` 的请求
// `pending` **不增加**、被静默放行。同族形状：`files:[{file}]`/`[{file_path}]`/`[{uri}]`/
// `[{dest}]`/`[{type:'text',file}]`/`[{content:{…}}]`，键名换成 `paths`/`dest`/`directory`/
// `edits`/`notebook_path` … 全部同效（本轮 23 个 PATH_KEYS × 9 种形状全跑）。
//
// 裁定是**边界**而非名单：`rawInput`/`arguments` 是**工具参数信封**，它下面的数组/对象是
// **正文**（被编辑/被写入的内容），一律不取路径、也不下钻；只有信封**顶层自己**的**标量**
// 路径字段取（`rawInput.file_path` 是 qoder Edit 帧的命脉）。同时块级 `path` 收窄到只认
// `diff`（`content` 块在 ACP 里没有 `path` 字段）。
//
// 本组两处出口都钉：① 会话档；② **真实 `appendUserRule`/`readUserAllowlist`**（临时目录，
// 绝不碰真实 `~/.dsh`）。放行判定走真实读盘（注入 `userRules: () => readUserAllowlist(diskDir)`），
// 所以"第二条请求是否弹窗"是端到端的真读数。
// 转红哨兵：去掉 `walk` 里 `if (inEnv && typeof v !== 'string') continue`，或把
// `FRAME_PATH_BLOCK_TYPES` 改回 `['diff','content']`，本 describe 立刻转红。
describe('v0.7.9 第六轮裁定：信封内数组不得把正文路径写进会话/落盘规则', () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  const sshKnownHosts = path.join(sshDir, 'known_hosts')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'env6-'))
  const diskDir = mkdtempSync(path.join(os.tmpdir(), 'env6-disk-'))
  const target = path.join(tmp, 'a.json')
  /** 第五轮残余形状：真目标在 `rawInput.file_path`（**标量**）；`files[]` 是工具参数**正文** */
  const frame = {
    kind: 'write',
    name: 'Write',
    title: `Write ${target}`,
    content: [{ type: 'diff', path: target, newText: '{"path":"~/.ssh/id_rsa"}' }],
    rawInput: {
      file_path: target,
      files: [{ path: sshKnownHosts }, { file: sshKnownHosts }, { file_path: sshKnownHosts }, { uri: sshKnownHosts }],
      paths: [sshKnownHosts],
      edits: { path: sshKnownHosts },
    },
    toolCallId: 'tc-env6',
  }
  const req = (toolCall, paths, description = 'Allow writing file?') => ({
    product: 'qoder', sessionId: 'acp-1', description, toolCall, paths,
  })
  /** 真实落盘读写器 + 真实读盘判定（写/读都指向临时目录，绝不写真实 ~/.dsh） */
  const diskHarness = (rules) => harness({
    bindings: bound(),
    rules,
    userRules: () => readUserAllowlist(diskDir),
    _appendUserRule: (rule) => appendUserRule(rule, diskDir),
  })

  it('前置：信封内数组/对象一条路径都不贡献；块级 path 只认 diff（内容块不再产出）', () => {
    assert.deepEqual(extractPaths(frame), [target], '信封下 files[]/paths[]/edits{} 全是工具参数正文')
    assert.equal(JSON.stringify(extractPaths(frame)).includes('.ssh'), false)
    // 第六轮裁定②：块级 `path` 只认 `diff` —— `content` 块在 ACP 里没有 path 字段
    assert.deepEqual(extractPaths({ kind: 'write', content: [{ type: 'content', path: sshKnownHosts }] }), [],
      'type:"content" 块身上的 path 是正文（第五轮为它留的豁口本轮关闭）')
    assert.deepEqual(extractStructuredPaths({ kind: 'write', content: [{ type: 'content', path: sshKnownHosts }] }), [])
    assert.deepEqual(extractPaths({ kind: 'write', content: [{ type: 'diff', path: sshKnownHosts }] }), [sshKnownHosts],
      'diff 块照旧（反向哨兵：闸不能收成"什么都不认"）')
    assert.deepEqual(extractPaths({ kind: 'write', content: [{ type: 'text', uri: 'file:///proj/ok.txt', path: sshKnownHosts }] }),
      ['/proj/ok.txt'], 'text 块的真字段 uri 照旧，path 不产出')
  })

  it('端到端（会话档）：allow-session 后规则里无任何 ~/.ssh*，随后读 known_hosts 必须弹窗', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(h.pendingEvents().length, 1, '第一条请求照常弹窗')
    assert.deepEqual(pending.suggestedDirs, [tmp], '结构化档只有被写文件所在目录（.ssh 一条都不许混进来）')
    assert.equal(pending.suggestedDirs.some((d) => d.startsWith(sshDir)), false)
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    const stored = JSON.stringify(rules.rulesOf('parent-1'))
    assert.equal(stored.includes('.ssh'), false, `会话规则里不得出现任何 ~/.ssh*（实际 ${stored}）`)
    assert.equal(stored.includes(tmp), true, '被写文件所在目录照常写入（修复没有把正常路径一并砍掉）')
    // 第二条请求：同会话、同 child，读 ~/.ssh/known_hosts —— 不得因本次授权被放行
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-env6-2' }
    const p2 = h.permissionHandler(req(readFrame, extractPaths(readFrame), 'Allow reading known_hosts?'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '阻断修复点：pending 必须**增加**（照常弹窗），不得静默 allow')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('端到端（落盘档）：allow-always 经真实 appendUserRule/readUserAllowlist（临时目录）读回后同样无 ~/.ssh*', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = diskHarness(rules)
    const p1 = h.permissionHandler(req(frame, extractPaths(frame)))
    await flush()
    assert.equal(h.pendingEvents().length, 1, '第一条照常弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-always' })
    assert.equal(await p1, 'allow')
    const onDisk = readUserAllowlist(diskDir)
    assert.equal(onDisk.length >= 1, true, '落盘通道确实写了一条（否则下面的断言是空转）')
    const disk = JSON.stringify(onDisk)
    assert.equal(disk.includes('.ssh'), false, `读回的落盘规则里不得出现 ~/.ssh（实际 ${disk}）`)
    assert.equal(disk.includes(tmp), true, '被写文件所在目录照常落盘')
    // 落盘规则参与后续判定（真实读盘）：同目标重复请求被落盘规则覆盖 ⇒ 不弹窗
    const again = h.permissionHandler(req({ ...frame, toolCallId: 'tc-env6-4' }, extractPaths(frame)))
    await flush()
    assert.equal(h.pendingEvents().length, 1, '同目标重复请求被落盘规则覆盖 ⇒ 不弹窗（证明读盘链路真的在生效）')
    assert.equal(await again, 'allow')
    // 而 ~/.ssh/known_hosts 仍不被覆盖 ⇒ 必须弹窗（pending 增加）
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-env6-5' }
    const p3 = h.permissionHandler(req(readFrame, extractPaths(readFrame), 'Allow reading known_hosts?'))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '落盘档口：~/.ssh/known_hosts 的 pending 必须增加')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p3, 'deny')
  })

  it('对照（差分）：若信封内数组那条路径真的进了产物，第二条请求会被静默放行 —— 证明断言有牙齿', async () => {
    const rules = createSessionRules({ expand: expandPathsWithParents })
    const h = harness({ bindings: bound(), rules })
    const legacyPaths = [target, sshKnownHosts]
    const p1 = h.permissionHandler(req(frame, legacyPaths))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(JSON.stringify(rules.rulesOf('parent-1')).includes('.ssh'), true,
      '旧行为的产物确实把 ~/.ssh 写进规则（这就是第六轮裁定的现场）')
    const readFrame = { kind: 'read', title: 'Read known_hosts', rawInput: { file_path: sshKnownHosts }, toolCallId: 'tc-env6-3' }
    const p2 = h.permissionHandler(req(readFrame, [sshKnownHosts], 'Allow reading known_hosts?'))
    assert.equal(await p2, 'allow', '旧行为下这条请求被静默放行 —— 正是本裁定的危害面')
    assert.equal(h.pendingEvents().length, 1, '第二条没有弹窗（pending 不增加）')
  })
})

// ── v0.7.10：授权不变式六条（把既有语义用测试钉死 + 本轮新收口的第 ⑥ 条） ─────────
//
// 这一块是 v0.7.10 的**回归钉**：每一条都做了「把旧行为改回去 ⇒ 对应用例必须转红」
// 的验证（变异点与红/绿读数见 CHANGELOG 0.7.10 的"实验读数"表）。语义本身不变：
//  ① 工具档命中 + 真实工具名的越权请求 ⇒ 自动放行；
//  ② **整条请求没有任何工具身份**的越权（opencode/deveco 载荷：无 name/toolName/_meta，
//     title 是权限范围 slug `external_directory`）⇒ 仍弹窗、且不写任何授权键
//     —— 「不新增越权档」是用户拍板的**显式设计决定**：真实工具名可用时越权请求已被
//     工具档覆盖（既有行为），仅当整条请求没有任何工具身份时才保持询问；
//  ③ 危险命令 + 工具档命中 ⇒ 仍弹（危险门先于一切规则）；
//  ④ 跨 product ⇒ 不互相放行（`qoder:bash` ≠ `opencode:bash`）；
//  ⑤ cwd 不匹配 ⇒ 不放行（工具档同样按写入时的 cwd 作用域）；
//  ⑥ 声明了非空路径但全被服务端丢弃 ⇒ 两档都不写（v0.7.10 收口，旧行为下会静默放大）。
describe('v0.7.10 授权不变式（六条 + 终审 M-1 边界）', () => {
  const prodRules = () => createSessionRules({ expand: expandPathsWithParents })
  const toolRules = (rules, sid) => rules.rulesOf(sid).filter((r) => (r.tools || []).length > 0)
  /** qoder 形态：真实工具名在 `_meta.qoder.toolName`，`title` 是整条命令正文 */
  const qoderReq = (toolCallId, command, paths = []) => ({
    product: 'qoder', sessionId: 'acp-1', description: 'Allow bash?',
    toolCall: {
      _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: command,
      rawInput: { command }, toolCallId,
    },
    paths,
  })
  /**
   * opencode/deveco 形态（与 test/permission.test.js:155-163 同形）：整条请求
   * **没有任何工具身份**——无 `name`/`toolName`/`_meta`，只有 `title=external_directory`
   * 这个**权限范围 slug**（不是工具名）+ locations/rawInput 描述触达的路径。
   */
  const externalDirReq = (toolCallId, filePath, parentDir) => ({
    product: 'opencode', sessionId: 'acp-1', description: '工作区外路径',
    toolCall: {
      kind: 'other',
      locations: [{ path: filePath }, { path: parentDir }],
      rawInput: { filepath: filePath, parentDir },
      status: 'pending',
      title: 'external_directory',
      toolCallId,
    },
    paths: [filePath],
  })

  it('不变式①：工具档命中 + 真实工具名的越权请求 ⇒ 自动放行（既有行为，钉死）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(qoderReq('tc-i1-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    assert.equal(h.pendingEvents().length, 1, '首次越权请求必须弹窗')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '工具档 qoder:bash 已写入')
    // 换成**完全另一条越权路径**的同名工具请求 ⇒ 命中工具档，零弹窗
    const p2 = h.permissionHandler(qoderReq('tc-i1-2', 'cat /etc/passwd', ['/etc/passwd']))
    assert.equal(await p2, 'allow', '工具档命中 ⇒ 自动放行（本会话内同名工具不再询问）')
    assert.equal(h.pendingEvents().length, 1, '第二条不得弹窗')
    assert.equal(h.logs.filter((l) => l.includes('命中会话期工具名授权（Bash')).length, 1, '归因要说清是工具档命中的')
  })

  it('不变式②：整条请求没有任何工具身份 ⇒ 仍弹窗且不写任何授权键（显式设计决定，不新增越权档）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound('child-A', { sessionId: 'acp-1' }, { product: 'opencode' }), rules })
    const p1 = h.permissionHandler(externalDirReq('tc-i2-1', '/Users/arming/.dsh/AGENTS.md', '/Users/arming/.dsh'))
    await flush()
    assert.equal(h.pendingEvents().length, 1, '无工具身份 ⇒ 一律询问，不得自动放行')
    assert.equal(h.pendingEvents()[0].toolName, null, 'resolveToolName=null（无 name/toolName/_meta，title 是权限范围 slug）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session' })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 0, '不写任何工具授权键')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'external_directory', '/proj'), false, 'external_directory 永远不能成为授权键')
    assert.deepEqual(toolRules(rules, 'parent-1'), [], '工具档为空')
    assert.equal(h.resolvedEvents()[0].outcome, 'granted-session', '落的是路径级记忆（L2），不是工具档')
    // 换一条完全不同的外部路径 ⇒ 仍须询问（路径记忆只覆盖声明子树，绝不变成"任意外部路径"）
    const p2 = h.permissionHandler(externalDirReq('tc-i2-2', '/outside/other/file.txt', '/outside/other'))
    assert.equal(h.pendingEvents().length, 2, '另一条外部路径必须重新询问')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('不变式③：危险命令 + 工具档命中 ⇒ 仍弹（危险门先于一切规则）', async () => {
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(qoderReq('tc-i3-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '工具档确实命中')
    for (const [i, cmd] of ['rm -rf /tmp/build', 'npm publish', 'git push origin main'].entries()) {
      const p = h.permissionHandler(qoderReq(`tc-i3-${i + 2}`, cmd, []))
      await flush()
      assert.equal(h.pendingEvents().length, i + 2, `${cmd} 必须弹窗`)
      h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[i + 1].permId, answer: 'deny' })
      assert.equal(await p, 'deny', `${cmd} 必须仍由用户裁决，不被工具档放行`)
    }
    assert.equal(h.logs.filter((l) => l.includes('危险命令门命中')).length, 3)
  })

  it('不变式④：跨 product ⇒ 工具档不互相放行', async () => {
    const rules = prodRules()
    const bindings = bound()
    bindings.set('child-B', { product: 'opencode', remote: { sessionId: 'acp-2' }, cwd: '/proj', parentSessionId: 'parent-1' })
    const h = harness({ bindings, rules })
    const p1 = h.permissionHandler(qoderReq('tc-i4-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantSize('parent-1'), 1)
    // 同一主代理会话、同一个真实工具名 bash，但产品是 opencode ⇒ 授权键不同，不得借键
    const p2 = h.permissionHandler({
      product: 'opencode', sessionId: 'acp-2', description: 'Allow bash?',
      toolCall: { name: 'bash', kind: 'execute', title: 'ls -la /etc', rawInput: { command: 'ls -la /etc' }, toolCallId: 'tc-i4-2' },
      paths: ['/etc/hosts'],
    })
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'opencode 不得吃到 qoder:bash 的授权键')
    assert.equal(toolRules(rules, 'parent-1').map((r) => r.product).join(), 'qoder', '工具档仍只属于 qoder')
    h.onDecision({ childId: 'child-B', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('不变式⑤：cwd 不匹配 ⇒ 工具档不放行', async () => {
    const rules = prodRules()
    const bindings = bound()
    bindings.set('child-B', { product: 'qoder', remote: { sessionId: 'acp-2' }, cwd: '/other-proj', parentSessionId: 'parent-1' })
    const h = harness({ bindings, rules })
    const p1 = h.permissionHandler(qoderReq('tc-i5-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: [] })
    assert.equal(await p1, 'allow')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true, '授权写在 /proj')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/other-proj'), false, 'cwd 不同 ⇒ 同一份工具档不算覆盖')
    // 同一个 qoder 工具、同一个主代理会话，但请求来自另一个工作目录的 child ⇒ 必须弹窗
    const p2 = h.permissionHandler({
      product: 'qoder', sessionId: 'acp-2', description: 'Allow bash?',
      toolCall: { _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: 'cat /etc/passwd', rawInput: { command: 'cat /etc/passwd' }, toolCallId: 'tc-i5-2' },
      paths: ['/etc/passwd'],
    })
    await flush()
    assert.equal(h.pendingEvents().length, 2, 'cwd 不同 ⇒ 项目级工具档不得命中')
    h.onDecision({ childId: 'child-B', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('不变式⑥：声明了非空路径但全被丢弃（`./x.txt` 复现形态）⇒ 两档都不写，随后的 cat /etc/passwd 仍弹', async () => {
    // 已复现的危害（0.7.9 及以前）：用户在弹框里声明 `./x.txt`（非绝对路径被服务端丢弃）
    // ⇒ 旧逻辑退到 tools 出口、落 `qoder:bash` 工具档 ⇒ 用户以为只授权了一个目录，
    // 实际拿到整个工具跨任意路径的授权：随后 `cat /etc/passwd` **allow、零弹窗**。
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(qoderReq('tc-i6-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'allow-session', paths: ['./x.txt'] })
    assert.equal(await p1, 'allow', '本次请求照常放行')
    assert.equal(rules.size('parent-1'), 0, '路径档一条都不写（声明的路径一条都不合法）')
    assert.equal(rules.toolGrantSize('parent-1'), 0, '工具档也不得代偿——这是收口的要害')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), false)
    assert.equal(h.resolvedEvents()[0].outcome, 'allowed-once', '什么都没记住 ⇒ 只能算仅本次放行')
    assert.equal(h.logs.filter((l) => l.includes('档位=none（用户声明的路径一条都没通过服务端校验')).length, 1)
    assert.ok(h.logs.some((l) => l.includes('非绝对路径(./x.txt)')), '丢弃原文与原因必须如实回给用户/日志')
    // 「如实回给 UI」：决议载荷（增量键）也要带出档位与丢弃原因，不能只躺在宿主日志里
    assert.equal(h.resolvedEvents()[0].grantTier, 'none', '决议载荷要说明"两档都没写"')
    assert.deepEqual(h.resolvedEvents()[0].grantDropped, [{ reason: '非绝对路径', value: './x.txt' }], '丢弃条目原文逐条回给 UI')
    assert.match(String(h.resolvedEvents()[0].grantReason), /路径档与工具档一律未写/)
    assert.equal(h.resolvedEvents()[0].childId, 'child-A', '既有键（childId/outcome/permId…）一个都没少')
    // 危害面：旧行为下这条会被 qoder:bash 静默放行（零弹窗）
    const p2 = h.permissionHandler(qoderReq('tc-i6-2', 'cat /etc/passwd', ['/etc/passwd']))
    await flush()
    assert.equal(h.pendingEvents().length, 2, '仍须弹窗（旧行为：零弹窗 allow）')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
  })

  it('边界（终审 M-1）：none 档 + 用户**拒绝** ⇒ 决议载荷不得带放行语义的增量键', async () => {
    // 修正前：三个增量键按 `plan.mode === 'none'` **无条件**附加，不分按钮 ⇒ 用户点
    // 「拒绝」时载荷也带 `grantReason: '…一律未写（仅放行本次）'`——请求根本没被放行，
    // 这是与事实相反的文案（兄弟仓正在写渲染逻辑，属定时炸弹）。
    const rules = prodRules()
    const h = harness({ bindings: bound(), rules })
    const p1 = h.permissionHandler(qoderReq('tc-i6d-1', 'ls -la /Users/x', ['/Users/x/a.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[0].permId, answer: 'deny', paths: ['./x.txt'] })
    assert.equal(await p1, 'deny', '拒绝就是拒绝')
    const resolved = h.resolvedEvents()[0]
    assert.equal(resolved.outcome, 'rejected')
    assert.equal(resolved.grantTier, undefined, 'deny 时不得带档位键')
    assert.equal(resolved.grantDropped, undefined, 'deny 时不得带丢弃明细')
    assert.equal(resolved.grantReason, undefined, 'deny 时不得带放行归因')
    assert.equal(JSON.stringify(resolved).includes('仅放行本次'), false, 'deny 载荷里不得出现「仅放行本次」这种与事实相反的文案')
    // 与放行侧对照：同一形状、点「拒绝」以外的按钮时才带增量键
    const p2 = h.permissionHandler(qoderReq('tc-i6d-2', 'ls -la /Users/y', ['/Users/y/b.txt']))
    await flush()
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'allow-once', paths: ['./x.txt'] })
    assert.equal(await p2, 'allow')
    assert.equal(h.resolvedEvents()[1].grantTier, 'none', '放行侧仍要如实带出"两档都没写"')
    assert.match(String(h.resolvedEvents()[1].grantReason), /仅放行本次/)
  })
})
