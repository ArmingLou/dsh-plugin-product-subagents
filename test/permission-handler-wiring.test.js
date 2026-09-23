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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPendingRegistry, createSessionRules, permissionCategoryKey } from '../lib/permission-state.js'
import { allowlistDecision } from '../lib/allowlist.js'
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

// permissionHandler 的自由变量（apply 闭包作用域）——逐项注入，漏一个就是 ReferenceError
const PH_PARAMS = [
  'pendingDecisions', 'permissionCategoryKey', 'ctx', 'providers', 'allowlistDecision', 'bindings',
  'unknownSessionTracker', 'sessionRules', 'readUserAllowlist', 'userRulesCover',
  'isRoundRejected', 'addRoundRejected', 'appendUserRule', 'console',
]

/**
 * 组装一个可执行的 permissionHandler。
 * @param {object} host
 * @param {Map} host.bindings 生产同构：childId -> {remote:{sessionId}, cwd, parentSessionId, product}
 * @param {(p:object)=>void} host.onPending / host.onResolved 事件收口
 * @param {Function|undefined} host.request approval.request 替身
 * @param {object} [host.rules] 会话规则表（默认生产实现）
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
    ctx,
    host.providers || {},
    allowlistDecision,
    bindings,
    createUnknownSessionTracker({ windowMs: 30000, threshold: 3, maxEntries: 100 }),
    host.rules || createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) }),
    () => [],
    () => false,
    () => false,
    () => {},
    () => ({ ok: true, count: 1 }),
    quiet,
  )
  // 真实决策入口：apply() 里注册的那个回调（含"未知 permId 忽略"分支）
  const onDecision = new Function(
    'pendingDecisions', 'console',
    `${DECISION_SLICE.replace("ctx.on('product-subagents/permission-decision', ", 'return ')}`,
  )(pendingDecisions, quiet)
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
    'clearRoundRejected', 'settleAllPending', 'pendingDecisions', 'bindings', 'scheduleDispose', 'state', 'console',
    `${CHILD_END_SLICE.replace("ctx.on('subagent/end', ", 'return ')}`,
  )(
    () => {},
    settleAllPending,
    pendingDecisions,
    bindings,
    () => {},
    { activeChildren: 1 },
    quiet,
  )
  return {
    permissionHandler, onDecision, onChildEnd, isHumanWaitPending, events, logs, settled,
    registry, bindings,
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

  it('点「本会话总是允许」→ 本次放行，但不写会话规则，下次照旧弹窗', async () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const h = harness({ bindings: bound(), rules })
    const p = h.permissionHandler(BASH)
    await flush()
    const [pending] = h.pendingEvents()
    assert.equal(pending.category, 'qoder:bash', '类别指纹仍要照常透出（展示用）')
    h.onDecision({ childId: 'child-A', permId: pending.permId, answer: 'allow-session' })
    assert.equal(await p, 'allow', '本次仍按用户意愿放行')
    assert.equal(rules.size('parent-1'), 0, '执行类一律不得记忆')
    assert.match(h.logs.join('\n'), /执行类请求 qoder:bash 不允许按类别记忆.*仅本次放行/s)

    const p2 = h.permissionHandler(BASH)
    await flush()
    assert.equal(h.pendingEvents().length, 2, '第二次必须仍然询问')
    h.onDecision({ childId: 'child-A', permId: h.pendingEvents()[1].permId, answer: 'deny' })
    assert.equal(await p2, 'deny')
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
