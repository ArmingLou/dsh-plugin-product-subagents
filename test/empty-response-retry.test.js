/**
 * v0.7.18 回归测试：ACP 空正文（EMPTY_RESPONSE）的**桥内**重试，主代理不可见。
 *
 * 钉死的语义：
 *   - 产品"会话存活但无文本输出"时，在同一会话内投递**延续指令**续跑（不是重投原 task：
 *     产品仍握着原任务，重投 = 重下命令 ⇒ 重复执行风险高）；
 *   - 重试在本次 submit 内完成 ⇒ product_submit 的 'submit-failed' 事件从不被写入
 *     （「主代理不可见」的机械证明）；
 *   - 不 kill、不 reconnect（会话上下文是本方案的全部价值）；
 *   - 预算耗尽（默认 3，即 1+3 次轮询）才抛原错误，仍带 code='EMPTY_RESPONSE'
 *     （分级归 failover 由 lib/submit-failure.js 决定，本改造不碰它）；
 *   - emptyResponseRetries: 0 ⇒ 关闭重试，行为与改造前逐字一致。
 *
 * 断言的是【真实行为】：bridge 收到的 prompt 文本、轮询次数、kill 次数、事件总线载荷。
 *
 * 注意配置通道：这三个旋钮与 rateLimitRetries / requestsPerMinute 同族，读的是
 * **bridge 构造 options**（acp.js:1475-1485），不是 submit() 的 settings 形参
 * （settings 是每会话 ACP 配置：model / reasoningEffort，经 applySettings 下发）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createAcpBridge } from '../lib/bridges/acp.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'

const TASK = '修复导航栏样式问题'
const CONTINUATION_HINT = '继续：若上述任务尚未完成'
const DEFAULT_CONTINUATION = '继续：若上述任务尚未完成，请继续完成；若已完成，请直接汇报结果与产出，不要重复执行已完成的部分。'

/** 构造桥；默认关掉宽限窗口，让用例跑得快（宽限窗口本身另有用例覆盖）。 */
const makeBridge = (extra = {}) => createAcpBridge({
  watchdogNoOutputMs: 60000,
  emptyResponseRetryDelayMs: 0,
  ...extra,
})

/**
 * 假 remote：走 submit() 的真实内部循环（watchdog / drainText / 重试分支），
 * 不依赖真实 CLI。`responses[i]` 决定第 i 次 connection.prompt 之后文本缓冲区里
 * 有什么——返回 null 即"会话存活但无文本输出"（真源 acp.js 的 EMPTY_RESPONSE 分支）。
 * drainText 刻意实现成**消费式清空**，与 makeClient 里的真实实现同形。
 */
function makeFakeRemote(responses) {
  let buffer = ''
  let promptCount = 0
  let kills = 0
  const prompts = []
  const remote = {
    sessionId: 'sess-1',
    proc: {
      exitCode: null,
      signalCode: null,
      kill() { kills += 1 },
    },
    connection: {
      async prompt(params) {
        prompts.push(params.prompt)
        const idx = promptCount
        promptCount += 1
        const fn = responses[Math.min(idx, responses.length - 1)]
        const out = fn ? fn() : null
        if (out && out.text) buffer += out.text
        return { stopReason: 'end_turn' }
      },
      closeSession() { return Promise.resolve() },
    },
    progressRef: () => ({ lastActivityAt: Date.now() }),
    drainText() { const t = buffer; buffer = ''; return t },
    stderrTail: () => '',
    drainStderr: () => '',
  }
  return {
    remote,
    prompts,
    promptCount: () => promptCount,
    kills: () => kills,
  }
}

/** 每次 prompt 都返回空正文（会话存活但无文本输出）。 */
const alwaysEmpty = () => null
/** 前 emptyTimes 次为空，之后返回 text。 */
const emptyThenText = (emptyTimes, text) => Array.from(
  { length: emptyTimes },
  () => alwaysEmpty,
).concat([() => ({ text })])

const submitWith = (bridge, remote, task) => bridge.submit(
  remote,
  task,
  new AbortController().signal,
  '/tmp',
  {},
  () => false,
)

describe('acp submit：EMPTY_RESPONSE 桥内重试', () => {
  it('首次空正文、二次成功 ⇒ 返回正文，且不 kill 不 reconnect', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote(emptyThenText(1, 'OK-BODY'))
    const out = await submitWith(bridge, fake.remote, TASK)
    assert.equal(out.text, 'OK-BODY')
    assert.equal(fake.promptCount(), 2, '应当轮询两次（1 次原任务 + 1 次延续指令）')
    assert.equal(fake.kills(), 0, '空正文重试不得 kill 进程（那会丢会话上下文）')
    assert.equal(fake.remote.proc.exitCode, null)
  })

  it('重试投递的是【延续指令】而非原 task（不重复执行已完成部分）', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote(emptyThenText(1, 'OK-BODY'))
    await submitWith(bridge, fake.remote, TASK)
    const first = fake.prompts[0]
    const second = fake.prompts[1]
    // 首次 = 原 task 原文（形态不变：ACP prompt 数组，text 部分承载任务文本）
    assert.deepEqual(first, [{ type: 'text', text: TASK }])
    // 重试 = 延续指令（同结构，仅替换文本内容）
    assert.equal(second.length, 1)
    assert.equal(second[0].type, 'text')
    assert.notEqual(second[0].text, TASK, '重试绝不能重投原 task')
    assert.equal(second[0].text, DEFAULT_CONTINUATION, '默认延续指令原文不符')
    assert.ok(second[0].text.includes(CONTINUATION_HINT))
    assert.ok(second[0].text.includes('不要重复执行已完成的部分'))
  })

  it('延续指令可配置（emptyResponseRetryPrompt）', async () => {
    const bridge = makeBridge({ emptyResponseRetryPrompt: 'CONTINUE-CUSTOM' })
    const fake = makeFakeRemote(emptyThenText(1, 'OK-BODY'))
    await submitWith(bridge, fake.remote, TASK)
    assert.equal(fake.prompts[1][0].text, 'CONTINUE-CUSTOM')
  })

  it('连续 4 次（1+3）空正文 ⇒ 预算耗尽，抛 code=EMPTY_RESPONSE 且轮询次数为 4', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([alwaysEmpty])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.ok(err, '预算耗尽必须抛错')
    assert.equal(err.code, 'EMPTY_RESPONSE')
    assert.equal(fake.promptCount(), 4, '1 次原任务 + 3 次重试 = 4 次轮询')
    assert.equal(fake.kills(), 0)
  })

  it('emptyResponseRetries: 0 ⇒ 关闭重试，行为与改造前一致（回归保护）', async () => {
    const bridge = makeBridge({ emptyResponseRetries: 0 })
    const fake = makeFakeRemote(emptyThenText(1, 'OK-BODY')) // 本可重试成功
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.ok(err)
    assert.equal(err.code, 'EMPTY_RESPONSE')
    assert.equal(fake.promptCount(), 1, '关闭重试时只轮询一次')
    assert.equal(fake.prompts.length, 1, '关闭重试时不得投递任何延续指令')
  })

  it('emptyResponseRetries 可调（1 ⇒ 最多 2 次轮询）', async () => {
    const bridge = makeBridge({ emptyResponseRetries: 1 })
    const fake = makeFakeRemote([alwaysEmpty])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'EMPTY_RESPONSE')
    assert.equal(fake.promptCount(), 2)
  })

  it('宽限窗口内迟到的文本分片直接当成功返回（不白花一次产品往返）', async () => {
    const bridge = makeBridge({ emptyResponseRetryDelayMs: 20 })
    let late = ''
    const remote = makeFakeRemote([alwaysEmpty]).remote
    const realDrain = remote.drainText
    let drainCalls = 0
    remote.drainText = () => {
      drainCalls += 1
      if (drainCalls === 1) { late = 'LATE-CHUNK'; return '' } // 首次 drain：空（触发 EMPTY_RESPONSE）
      return realDrain() || late // 宽限后再次 drain：收下迟到的真答案
    }
    const out = await submitWith(bridge, remote, TASK)
    assert.equal(out.text, 'LATE-CHUNK')
    assert.equal(out.stopReason, 'completed')
    assert.equal(drainCalls, 2, '只多花一次缓冲区确认，未再投递 prompt')
  })

  it('EMPTY_RESPONSE 之外的其他失败不受本改造影响（仍原样抛出）', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([alwaysEmpty])
    fake.remote.connection.prompt = async () => {
      const err = new Error('boom: invalid api key')
      err.code = 'INVALID_API_KEY'
      throw err
    }
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'INVALID_API_KEY')
  })
})

/**
 * 最小假宿主（与 test/submit-failover.test.js 的 makeSubmitHarness 同形）：
 * 只提供 product_submit 需要的 ctx 表面 + 一个绑到【真 acp bridge】的 remote，
 * 用来机械证明"重试耗尽前，编排层的事件总线看不到任何失败信号"。
 */
function makeSubmitHarness({ bridge, remote }) {
  const emitted = []
  const tools = new Map()
  const agent = { session: { id: 'child-1', header: { cwd: '/tmp' } } }
  const ctx = {
    tools: { register: (def) => tools.set(def.name, def) },
    get: () => undefined,
    emit: (name, payload) => { emitted.push({ name, payload }) },
  }
  const bindings = new Map()
  registerProductSubmit(ctx, {
    bindings,
    MARKER: '[remote]',
    recoverRemoteSessionId: () => null,
    bridges: { fake: bridge },
    registry: { get: () => undefined },
    persistRemote: () => {},
    cancelDispose: () => {},
    closedChildren: new Set(),
    emitBoundConfigOptions: () => {},
  })
  bindings.set('child-1', { product: 'fake', bridge, remote })
  const run = () => tools.get('product_submit').execute(
    { task: TASK },
    { agent, signal: new AbortController().signal },
  )
  return { run, emitted }
}

describe('product_submit：空正文重试对编排层不可见', () => {
  it('首次空正文、二次成功 ⇒ 正常返回，且 submit-failed 事件从未被发出', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote(emptyThenText(1, 'OK-BODY'))
    const harness = makeSubmitHarness({ bridge, remote: fake.remote })
    const result = await harness.run()
    assert.ok(result.text.includes('OK-BODY'), `应返回产品答案：${result.text}`)
    const failed = harness.emitted.filter((e) => e.name === 'product-subagents/submit-failed')
    assert.equal(failed.length, 0, `主代理不可见：不得发出 submit-failed，实发 ${JSON.stringify(failed)}`)
    assert.equal(harness.emitted.filter((e) => e.name === 'product-subagents/submit-ok').length, 1)
    assert.equal(fake.promptCount(), 2)
  })

  it('重试预算耗尽 ⇒ 才把 EMPTY_RESPONSE 暴露给编排层（submit-failed 恰好一次）', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([alwaysEmpty])
    const harness = makeSubmitHarness({ bridge, remote: fake.remote })
    const err = await harness.run().then(() => null, (e) => e)
    assert.ok(err, '预算耗尽时 product_submit 必须失败')
    const failed = harness.emitted.filter((e) => e.name === 'product-subagents/submit-failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].payload.code, 'EMPTY_RESPONSE')
    assert.equal(fake.promptCount(), 4)
  })
})
