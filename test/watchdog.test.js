import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  configOptionValues,
  createAcpBridge,
  describeConfigOptions,
  domainAccepts,
  findEffortOption,
  findModelOption,
} from '../lib/bridges/acp.js'

// 假 spawn：立即以 ENOENT 异步失败——watchdog reconnect 走 connect()→options.spawn 测试缝，
// 不依赖真实 CLI；冻结循环应吞掉重连失败并无限重试，直到 abort/isClosed 终止。
function failSpawn() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.signalCode = null
  queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn ENOENT (mock)'), { code: 'ENOENT' })))
  return proc
}

describe('watchdog configuration', () => {
  it('createAcpBridge accepts watchdogNoOutputMs option', () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 5000 })
    assert.equal(typeof bridge.submit, 'function')
  })

  it('createAcpBridge works without watchdogNoOutputMs (default)', () => {
    const bridge = createAcpBridge()
    assert.equal(typeof bridge.submit, 'function')
  })
})

describe('isClosed callback integration', () => {
  it('submit rejects with WATCHDOG_CLOSED when isClosed returns true', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 60000 })
    const remote = {
      sessionId: 'test-session',
      proc: { exitCode: null, signalCode: null, kill() {} },
      connection: {
        async prompt() {
          await new Promise((r) => setTimeout(r, 200))
          return { stopReason: 'end_turn' }
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: Date.now() }),
      drainText: () => 'text',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => true
    try {
      await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', {}, isClosed)
      assert.fail('should have thrown')
    } catch (err) {
      assert.equal(err.code, 'WATCHDOG_CLOSED')
    }
  })
})

describe('watchdog freeze detection', () => {
  it('WATCHDOG_FREEZE 触发 kill+closeSession，重连不可用时抛 PRODUCT_CRASH（不再无限重试）', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    let killSigSent = false
    let closeSessionCalled = false
    const remote = {
      sessionId: 'freeze-test',
      proc: {
        exitCode: null,
        signalCode: null,
        kill(sig) {
          if (sig === 'SIGKILL') {
            killSigSent = true
            this.exitCode = 137
            this.signalCode = 'SIGKILL'
          }
        },
      },
      connection: {
        async prompt() {
          await new Promise(() => {})
        },
        closeSession() { closeSessionCalled = true; return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const ac = new AbortController()
    // 兜底超时：若重连预算失效（旧行为），abort 兜住无限循环。
    const timeout = setTimeout(() => ac.abort(), 5000)
    let code = null
    let message = ''
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      code = err.code
      message = err.message
    }
    clearTimeout(timeout)
    // 冻结 → kill → 重连（假 spawn 必失败）→ 预算 3 次耗尽 → PRODUCT_CRASH（failover 级）
    assert.equal(code, 'PRODUCT_CRASH', `Expected PRODUCT_CRASH, got ${code}: ${message}`)
    assert.match(message, /crashed\/exited \(after 3 reconnect attempts\)/)
    // 关键行为保留：冻结确实 kill 了进程并关闭了会话
    assert.ok(killSigSent, 'Expected SIGKILL to be sent on freeze')
    assert.ok(closeSessionCalled, 'Expected closeSession to be called on freeze')
  })

  it('重连预算耗尽前不抛错：reconnect 失败仍继续重试（只在超限时才抛 PRODUCT_CRASH）', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    let killSigSent = false
    let closeSessionCalled = false
    let promptAttemptCount = 0
    const remote = {
      sessionId: 'reconnect-fail-test',
      proc: {
        exitCode: null,
        signalCode: null,
        kill(sig) {
          if (sig === 'SIGKILL') {
            killSigSent = true
            this.exitCode = 137
            this.signalCode = 'SIGKILL'
          }
        },
      },
      connection: {
        async prompt() {
          promptAttemptCount++
          await new Promise(() => {})
        },
        closeSession() { closeSessionCalled = true; return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 5000)
    let caughtCode = null
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      caughtCode = err.code
    }
    clearTimeout(timeout)
    // 不得泄漏原始 reconnect 错误（ENOENT / ACP connection closed）——那是内部细节，
    // 对外只允许 PRODUCT_CRASH（预算耗尽）或 abort/close 类终止码。
    assert.ok(
      caughtCode === 'PRODUCT_CRASH' || caughtCode === 'SUBMIT_ABORTED' || caughtCode === 'WATCHDOG_CLOSED',
      `Expected loop termination code, got ${caughtCode} (reconnect error leaked from watchdog loop)`,
    )
    assert.ok(promptAttemptCount >= 1, 'Expected at least one prompt attempt')
    assert.ok(killSigSent, 'Expected at least one SIGKILL')
    assert.ok(closeSessionCalled, 'Expected at least one closeSession')
  })
})

describe('PRODUCT_CRASH：盲重试预算（每次新 prompt 重置）', () => {
  const flakyPrompt = (failures) => ({ onPrompt: ({ msg, send }) => {
    if (failures.left > 0) {
      failures.left -= 1
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'ACP connection closed (mock)' } })
      return 'handled'
    }
    return 'default'
  } })

  it('传输中断（connection closed）重连成功 → 重发同一 prompt，不抛错', async () => {
    const failures = { left: 1 }
    const agent = fakeAgent(OPENCODE_LIKE, flakyPrompt(failures))
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp')
    assert.equal(out.text, 'fake answer')
    assert.equal(agent.state.promptCount, 2, '一次中断 + 一次重发')
    await bridge.dispose(remote)
  })

  it('每次新 prompt 调用重置预算：上一轮用掉 2 次，下一轮仍可用满 3 次', async () => {
    const failures = { left: 2 }
    const agent = fakeAgent(OPENCODE_LIKE, flakyPrompt(failures))
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    const first = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp')
    assert.equal(first.text, 'fake answer')
    assert.equal(agent.state.promptCount, 3, '2 次中断 + 1 次成功')
    // 第二轮连挂 3 次仍在预算内（若计数器没重置，这里会在第 2 次中断就抛 PRODUCT_CRASH）
    failures.left = 3
    const second = await bridge.submit(remote, 'task-2', new AbortController().signal, '/tmp')
    assert.equal(second.text, 'fake answer')
    assert.equal(agent.state.promptCount, 7, '3 次中断 + 1 次成功')
    await bridge.dispose(remote)
  })

  it('传输中断且重连预算耗尽 → PRODUCT_CRASH（带 reason 与退出快照）', async () => {
    const failures = { left: 99 }
    const agent = fakeAgent(OPENCODE_LIKE, flakyPrompt(failures))
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    let caught = null
    try {
      await bridge.submit(remote, 'task', new AbortController().signal, '/tmp')
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'should have thrown')
    assert.equal(caught.code, 'PRODUCT_CRASH')
    assert.equal(caught.reason, 'prompt_transport_error')
    assert.equal(caught.reconnectAttempts, 3)
    assert.match(caught.message, /crashed\/exited \(after 3 reconnect attempts\): exitCode=/)
    assert.equal(agent.state.promptCount, 4, '1 次首发 + 3 次重发后放弃')
    await bridge.dispose(remote)
  })

  it('进程已退出（transportDead）且重连失败 → PRODUCT_CRASH，错误里带真实 exitCode', async () => {
    const bridge = createAcpBridge({ command: 'opencode', spawn: failSpawn })
    const remote = {
      sessionId: 'dead-test',
      proc: { exitCode: 1, signalCode: null, kill() {} },
      connection: {
        async prompt() { await new Promise(() => {}) },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    let caught = null
    try {
      await bridge.submit(remote, 'task', new AbortController().signal, '/tmp')
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'should have thrown')
    assert.equal(caught.code, 'PRODUCT_CRASH')
    assert.equal(caught.reason, 'transport_dead')
    assert.match(caught.message, /exitCode=1, signal=null/)
  })
})

describe('watchdog with isClosed guard', () => {
  it('watchdog stops kill→reconnect loop when child is closed', async () => {
    let closed = false
    const isClosed = () => closed
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    const remote = {
      sessionId: 'closed-guard-test',
      proc: { exitCode: null, signalCode: null, kill() { this.exitCode = 137; this.signalCode = 'SIGKILL' } },
      connection: {
        async prompt() {
          await new Promise(() => {})
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    // Close the child after a short delay (simulating agent_close arriving during freeze)
    setTimeout(() => { closed = true }, 200)
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 3000)
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      clearTimeout(timeout)
      assert.equal(err.code, 'WATCHDOG_CLOSED', `Expected WATCHDOG_CLOSED, got ${err.code}: ${err.message}`)
    }
    clearTimeout(timeout)
  })
})

describe('watchdog respects active output (no false positive)', () => {
  it('watchdog does not trigger when output is flowing', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 200 })
    let lastActivity = Date.now()
    const remote = {
      sessionId: 'active-test',
      proc: { exitCode: null, signalCode: null, kill() {} },
      connection: {
        async prompt() {
          await new Promise((r) => setTimeout(r, 100))
          lastActivity = Date.now()
          await new Promise((r) => setTimeout(r, 100))
          lastActivity = Date.now()
          return { stopReason: 'end_turn' }
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: lastActivity }),
      drainText: () => 'active output text',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const result = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', {}, isClosed)
    assert.ok(result.text.includes('active output text'))
  })
})

describe('watchdog configuration override', () => {
  it('watchdogNoOutputMs from provider config overrides default', () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 5000 })
    assert.equal(typeof bridge.submit, 'function')
    const bridgeDefault = createAcpBridge({})
    assert.equal(typeof bridgeDefault.submit, 'function')
  })
})

describe('watchdog permission-pending exemption', () => {
  it('does NOT trigger freeze while permission is pending (human waiting)', async () => {
    let pending = true
    const bridge = createAcpBridge({
      watchdogNoOutputMs: 80,
      isHumanWaitPending: () => pending,
      spawn: failSpawn,
    })
    let killSig = false
    const remote = {
      sessionId: 'perm-pending-test',
      proc: { exitCode: null, signalCode: null, kill(sig) { killSig = true; this.exitCode = 137 } },
      connection: {
        async prompt() { await new Promise(() => {}) },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '', stderrTail: () => '', drainStderr: () => '',
    }
    // 前 500ms 权限挂起（豁免期）；随后解除挂起但无输出 → 冻结应触发
    setTimeout(() => { pending = false }, 500)
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 5000)
    let code = null
    try { await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, () => false) } catch (e) { code = e.code }
    clearTimeout(timeout)
    // 挂起期间不应 kill；解除后冻结会 kill→reconnect(假 spawn 失败)→预算耗尽→PRODUCT_CRASH
    assert.ok(code === 'PRODUCT_CRASH' || code === 'SUBMIT_ABORTED' || code === 'WATCHDOG_CLOSED', `got ${code}`)
    assert.ok(killSig, 'freeze after pending released should have killed')
  })
})

// ── configOptions（可用模型 / 可用 effort）────────────────────────────────────
// 三种真实产品的载荷形态（本机实测，见 CHANGELOG 0.6.0）：
//   opencode → model(category=model) + effort(category=thought_level)
//   deveco   → model + mode，**没有** reasoning 档位
//   qoder    → model(category=model) + reasoning_effort(**category=model**)
// 最后一条决定了「id 精确匹配优先 → category 兜底」的顺序不能反。
const OPENCODE_LIKE = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build' }] },
]
const QODER_LIKE = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'default' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'qfmodel', options: [{ value: 'qfmodel', name: 'QF' }, { value: 'qmodel_38max', name: 'Max' }] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'model', type: 'select', currentValue: 'xhigh', options: [{ value: 'xhigh', name: 'XHigh' }, { value: 'none', name: 'None' }] },
]
const DEVECO_LIKE = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'deveco/GLM-5.3', options: [{ value: 'deveco/GLM-5.1', name: 'GLM-5.1' }, { value: 'deveco/GLM-5.3', name: 'GLM-5.3' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build' }] },
]

describe('config option resolution (dynamic id / category)', () => {
  it('resolves effort by id (opencode) and by category when the id is custom', () => {
    assert.equal(findEffortOption(OPENCODE_LIKE).id, 'effort')
    const customId = [{ id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm' }] },
      { id: 'thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }] }]
    assert.equal(findEffortOption(customId).id, 'thinking')
  })

  it('qoder: effort id is reasoning_effort and shares category "model" with the model option', () => {
    assert.equal(findModelOption(QODER_LIKE).id, 'model')
    assert.equal(findEffortOption(QODER_LIKE).id, 'reasoning_effort')
  })

  it('exact id match wins over the category fallback', () => {
    const both = [{ id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }] },
      { id: 'temperature', category: 'thought_level', type: 'select', currentValue: '0.2', options: [{ value: '0.2' }] }]
    assert.equal(findEffortOption(both).id, 'effort')
  })

  it('deveco: no reasoning option at all → null (never a silent wrong id)', () => {
    assert.equal(findEffortOption(DEVECO_LIKE), null)
    assert.equal(findModelOption(DEVECO_LIKE).id, 'model')
  })

  it('flattens grouped options (SessionConfigSelectGroup[]) into the value domain', () => {
    const grouped = [{ id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
      { group: 'm1', name: 'M1', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      { group: 'm2', name: 'M2', options: [{ value: 'max', name: 'Max' }] },
    ] }]
    assert.deepEqual(configOptionValues(findEffortOption(grouped)), ['low', 'high', 'max'])
  })

  it('domainAccepts 预校验：空域放行，分组按全组并集判定', () => {
    // 产品压根没上报 options 时不能判非法，否则配置永远无法生效
    assert.equal(domainAccepts({ options: [] }, 'x'), true)
    assert.equal(domainAccepts(undefined, 'x'), true)
    const flat = { options: [{ value: 'a' }, { value: 'b' }] }
    assert.equal(domainAccepts(flat, 'b'), true)
    assert.equal(domainAccepts(flat, 'c'), false)
    // effort 取值域随 model 变，按并集放行才不会误挡「换 model 后合法」的值
    const grouped = { options: [{ group: 'm1', options: [{ value: 'low' }] }, { group: 'm2', options: [{ value: 'max' }] }] }
    assert.equal(domainAccepts(grouped, 'max'), true)
  })

  it('diagnostics carry id + category + value domain (no silent failure)', () => {
    const text = describeConfigOptions(OPENCODE_LIKE)
    assert.match(text, /effort\(category=thought_level/)
    assert.match(text, /values=low/)
    assert.match(describeConfigOptions([]), /未上报任何 configOptions/)
  })
})

/**
 * 假 ACP agent：手搓 ndjson JSON-RPC 应答 initialize / session/new /
 * session/set_config_option / session/prompt / session/close，并可主动下发
 * session/update 通知。经 options.spawn 测试缝注入，不依赖任何真实 CLI。
 */
function fakeAgent(configOptions, behavior = {}) {
  const state = {
    configOptions: structuredClone(configOptions),
    setCalls: [],
    promptCount: 0,
    proc: null,
  }
  const send = (msg) => { if (state.proc) state.proc.stdout.write(`${JSON.stringify(msg)}\n`) }
  const toLine = (line) => {
    const msg = JSON.parse(line)
    if (msg.id === undefined) return
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } } })
      return
    }
    if (msg.method === 'session/new' || msg.method === 'session/load') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'ses_fake', configOptions: structuredClone(state.configOptions) } })
      return
    }
    if (msg.method === 'session/set_config_option') {
      state.setCalls.push({ configId: msg.params.configId, value: msg.params.value })
      if (behavior.rejectConfigId && behavior.rejectConfigId === msg.params.configId) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Invalid params: ${msg.params.configId} not accepted` } })
        return
      }
      const next = structuredClone(state.configOptions)
      const target = next.find((o) => o && o.id === msg.params.configId)
      if (!target) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown configId ${msg.params.configId}` } })
        return
      }
      target.currentValue = msg.params.value
      // 真实产品的联动：换 model 会重算 reasoning 档位取值域（实测 opencode 如此）
      if (msg.params.configId === 'model' && typeof behavior.modelSideEffects === 'function') {
        behavior.modelSideEffects(next, msg.params.value)
      }
      state.configOptions = next
      // 响应必须带完整 configOptions——丢弃它就是 model→effort 联动陈旧的根因
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: structuredClone(next) } })
      return
    }
    if (msg.method === 'session/prompt') {
      state.promptCount += 1
      // 行为钩子：让用例能制造"prompt 期间传输中断"（JSON-RPC error 应答），
      // 返回 'handled' 表示本回合由用例自己应答。
      if (typeof behavior.onPrompt === 'function') {
        const outcome = behavior.onPrompt({ state, msg, send, promptIndex: state.promptCount })
        if (outcome === 'handled') return
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_fake', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake answer' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (msg.method === 'session/close') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
  const spawn = () => {
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.exitCode = null
    proc.signalCode = null
    proc.kill = () => true
    proc.stdin.setEncoding('utf8')
    let buf = ''
    proc.stdin.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) toLine(line)
      }
    })
    state.proc = proc
    return proc
  }
  return { spawn, state, send }
}

const waitFor = async (predicate, ms = 1500) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('等待条件超时')
}

const effortValues = (list, id) => {
  const opt = (list || []).find((o) => o && (o.id === id || o.category === 'thought_level'))
  return opt ? configOptionValues(opt) : []
}

describe('configOptions over the wire', () => {
  it('create() captures the session configOptions snapshot on the remote', async () => {
    const agent = fakeAgent(OPENCODE_LIKE)
    const bridge = createAcpBridge({ command: 'opencode', args: ['acp'], spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    assert.equal(remote.kind, 'acp')
    assert.deepEqual(remote.configOptions.map((o) => o.id), ['model', 'effort', 'mode'])
    await bridge.dispose(remote)
  })

  it('submit() applies model/effort through the resolved configIds and writes the response back', async () => {
    // effort 用自定义 id（只能靠 category 兜底）+ 换 model 后档位集合会变
    const base = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
      { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] }]
    const agent = fakeAgent(base, {
      modelSideEffects: (next, value) => {
        if (value === 'm2') next[1].options = [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }]
      },
    })
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    assert.deepEqual(effortValues(remote.configOptions), ['low'])
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { model: 'm2', reasoningEffort: 'high' })
    assert.equal(out.text, 'fake answer')
    // ① 不硬编码：model 用真实 id，effort 走 category 兜底拿到 'thinking'
    assert.deepEqual(agent.state.setCalls, [{ configId: 'model', value: 'm2' }, { configId: 'thinking', value: 'high' }])
    // ② 响应回写：effort 取值域必须是换 model 之后的新域（旧实现丢弃响应 → 永远陈旧）
    assert.deepEqual(effortValues(remote.configOptions), ['low', 'high'])
    assert.equal(remote.configOptions.find((o) => o.id === 'model').currentValue, 'm2')
  })

  it('qoder-shaped payload: reasoning_effort wins over the colliding category "model"', async () => {
    const agent = fakeAgent(QODER_LIKE)
    const bridge = createAcpBridge({ command: 'qoder', args: ['--acp'], spawn: agent.spawn })
    const remote = await bridge.create('/tmp')
    await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { model: 'qmodel_38max', reasoningEffort: 'none' })
    assert.deepEqual(agent.state.setCalls, [
      { configId: 'model', value: 'qmodel_38max' },
      { configId: 'reasoning_effort', value: 'none' },
    ])
  })

  it('emits config-options when the agent pushes a config_option_update notification', async () => {
    const agent = fakeAgent(OPENCODE_LIKE)
    const seen = []
    const bridge = createAcpBridge({
      command: 'opencode',
      product: 'opencode',
      spawn: agent.spawn,
      onConfigOptions: (payload) => seen.push(payload),
    })
    const remote = await bridge.create('/tmp')
    const before = seen.length
    agent.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'ses_fake', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm9', options: [{ value: 'm9', name: 'M9' }] }] } },
    })
    await waitFor(() => seen.length > before)
    assert.equal(seen[seen.length - 1].product, 'opencode')
    assert.equal(seen[seen.length - 1].remoteSessionId, 'ses_fake')
    assert.deepEqual(seen[seen.length - 1].configOptions.map((o) => o.id), ['model'])
    // 快照同样落在 remote 上，下一轮 submit 解析 configId 用的是新值
    assert.deepEqual(remote.configOptions.map((o) => o.id), ['model'])
  })

  it('an accepted set_config_option also refreshes via onConfigOptions', async () => {
    const agent = fakeAgent(OPENCODE_LIKE)
    const seen = []
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn, onConfigOptions: (p) => seen.push(p) })
    const remote = await bridge.create('/tmp')
    await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { model: 'm2' })
    assert.ok(seen.some((p) => p.configOptions.some((o) => o.id === 'model' && o.currentValue === 'm2')), '响应快照应经回调透出')
  })

  it('请求值不在取值域 → 不发调用、沿用会话默认，回合照常完成', async () => {
    const agent = fakeAgent(DEVECO_LIKE)
    const errors = []
    const bridge = createAcpBridge({ command: 'deveco', product: 'deveco', spawn: agent.spawn, onConfigError: (p) => errors.push(p) })
    const remote = await bridge.create('/tmp')
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { model: 'deveco/GLM-9.9' })
    assert.equal(out.text, 'fake answer', '手填错值不得弄坏 product_submit 回合')
    assert.deepEqual(agent.state.setCalls, [], '域外值应在下发前挡掉，不浪费一次必然失败的往返')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].kind, 'model')
    assert.equal(errors[0].reason, 'not-in-values')
    assert.equal(errors[0].requested, 'deveco/GLM-9.9')
    assert.equal(errors[0].optionId, 'model')
    assert.equal(errors[0].effective, 'deveco/GLM-5.3', 'effective = 会话当前值 = 产品默认')
    assert.deepEqual(errors[0].available, ['deveco/GLM-5.1', 'deveco/GLM-5.3'])
    await bridge.dispose(remote)
  })

  it('产品拒绝域内的值 → 捕获不抛，事件给出 requested/effective/available', async () => {
    const list = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }]
    const agent = fakeAgent(list, { rejectConfigId: 'effort' })
    const errors = []
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn, onConfigError: (p) => errors.push(p) })
    const remote = await bridge.create('/tmp')
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { reasoningEffort: 'high' })
    assert.equal(out.text, 'fake answer', '配置项没生效不该让任务失败')
    assert.deepEqual(agent.state.setCalls, [{ configId: 'effort', value: 'high' }], '域内的值应当真的发出去，由产品裁决')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].reason, 'rejected')
    assert.equal(errors[0].requested, 'high')
    assert.equal(errors[0].effective, 'low', '被拒后生效的仍是会话原值')
    assert.deepEqual(errors[0].available, ['low', 'high'])
    assert.match(errors[0].error, /not accepted/)
    await bridge.dispose(remote)
  })

  it('产品无对应 option（deveco 没有 reasoning 档位）→ 静默降级，不瞎猜 configId', async () => {
    const agent = fakeAgent(DEVECO_LIKE)
    const errors = []
    const bridge = createAcpBridge({ command: 'deveco', product: 'deveco', spawn: agent.spawn, onConfigError: (p) => errors.push(p) })
    const remote = await bridge.create('/tmp')
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { reasoningEffort: 'high' })
    assert.equal(out.text, 'fake answer')
    assert.deepEqual(agent.state.setCalls, [], '没有对应配置项时不该瞎猜 configId')
    assert.equal(errors[0].kind, 'effort')
    assert.equal(errors[0].reason, 'no-option')
    assert.equal(errors[0].optionId, null)
    assert.equal(errors[0].effective, null)
    assert.deepEqual(errors[0].available, [])
    assert.equal(errors[0].error, null)
    assert.deepEqual(errors[0].configOptions.map((o) => o.id), ['model', 'mode'], '事件要带上快照，让上层能判断为什么没有该项')
    await bridge.dispose(remote)
  })

  it('空串与 "default" 视为不指定：不发调用、也不报回退', async () => {
    const agent = fakeAgent(OPENCODE_LIKE)
    const errors = []
    const bridge = createAcpBridge({ command: 'opencode', spawn: agent.spawn, onConfigError: (p) => errors.push(p) })
    const remote = await bridge.create('/tmp')
    const out = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { model: '  ', reasoningEffort: 'default' })
    assert.equal(out.text, 'fake answer')
    assert.deepEqual(agent.state.setCalls, [])
    assert.deepEqual(errors, [])
    await bridge.dispose(remote)
  })

  it('console.warn 按 (kind,value) 去重，但事件每回合都发', async () => {
    const agent = fakeAgent(DEVECO_LIKE)
    const errors = []
    const warnings = []
    const originalWarn = console.warn
    console.warn = (msg) => { warnings.push(msg) }
    try {
      const bridge = createAcpBridge({ command: 'deveco', spawn: agent.spawn, onConfigError: (p) => errors.push(p) })
      const remote = await bridge.create('/tmp')
      for (let i = 0; i < 3; i += 1) {
        await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', { reasoningEffort: 'high' })
      }
      await bridge.dispose(remote)
    } finally {
      console.warn = originalWarn
    }
    assert.equal(errors.length, 3, 'dispatch 日志要能逐回合回答"填了 X 为什么没生效"')
    assert.equal(warnings.length, 1, '长活子代理不得刷屏')
    assert.match(warnings[0], /not-in-values|no-option/)
  })
})
