/**
 * 回归测试：ACP 语义性拒绝（`stopReason='refusal'`）不得被静默吞掉。
 *
 * 钉死的语义：
 *   - refusal **带正文**过去会被当成成功返回（正文原样交给编排层），拒绝信号消失；
 *     现在无论有无正文一律抛 `code='ACP_REFUSAL'`，文案与 dsh-acp-adapter 的
 *     `profile-adapter.ts` `finishReason('refusal')` 逐字一致；
 *   - refusal **无正文**同样抛 ACP_REFUSAL（优先级高于 EMPTY_RESPONSE：语义不同，
 *     "拒绝回答" ≠ "会话存活但无输出"，后者还会触发桥内续跑重试）；
 *   - refusal **不进**桥内续跑重试（重投同一请求极可能再次被拒），也不 kill /
 *     reconnect（会话仍然健康）；
 *   - 分级：`classifySubmitFailure('ACP_REFUSAL')` = failover（换一档模型可能不再拒绝），
 *     随 `product-subagents/submit-failed` 事件下发给编排层；
 *   - EMPTY_RESPONSE 的既有行为不变（回归保护）。
 *
 * 断言的是【真实行为】：prompt 次数、kill 次数、事件总线载荷、错误码与文案。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createAcpBridge } from '../lib/bridges/acp.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'
import { classifySubmitFailure, FAILOVER } from '../lib/submit-failure.js'

const TASK = '写一个批量重命名脚本'
const REFUSAL_MESSAGE = 'The ACP agent declined to answer this request.'

const makeBridge = (extra = {}) => createAcpBridge({
  watchdogNoOutputMs: 60000,
  emptyResponseRetryDelayMs: 0,
  ...extra,
})

/**
 * 假 remote：`steps[i]` 决定第 i 次 connection.prompt 的文本分片与 stopReason。
 * drainText 是消费式清空，与 makeClient 的真实实现同形。
 */
function makeFakeRemote(steps) {
  let buffer = ''
  let promptCount = 0
  let kills = 0
  const prompts = []
  const remote = {
    sessionId: 'sess-refusal',
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
        const step = steps[Math.min(idx, steps.length - 1)] || {}
        if (step.text) buffer += step.text
        return { stopReason: step.stopReason || 'end_turn' }
      },
      closeSession() { return Promise.resolve() },
    },
    progressRef: () => ({ lastActivityAt: Date.now() }),
    drainText() { const t = buffer; buffer = ''; return t },
    stderrTail: () => '',
    drainStderr: () => '',
  }
  return { remote, prompts, promptCount: () => promptCount, kills: () => kills }
}

const submitWith = (bridge, remote, task) => bridge.submit(
  remote,
  task,
  new AbortController().signal,
  '/tmp',
  {},
  () => false,
)

/** 最小假宿主（与 empty-response-retry.test.js 的 makeSubmitHarness 同形）。 */
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

describe('acp submit：stopReason=refusal 不得被吞', () => {
  it('refusal 带正文 ⇒ 抛 ACP_REFUSAL（正文不再被当成成功返回）', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([{ text: '抱歉，我不能协助这个请求。', stopReason: 'refusal' }])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.ok(err, 'refusal 必须抛错，不能返回正文')
    assert.equal(err.code, 'ACP_REFUSAL')
    assert.equal(err.message, REFUSAL_MESSAGE, '文案须与 dsh-acp-adapter 的 finishReason 一致')
    assert.ok(err.product, '错误须带 product，供编排层归因')
    assert.equal(err.stopReason, 'refusal')
  })

  it('refusal 无正文 ⇒ 仍抛 ACP_REFUSAL（优先级高于 EMPTY_RESPONSE）', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([{ text: '', stopReason: 'refusal' }])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'ACP_REFUSAL', '语义是"拒绝回答"，不得归入 EMPTY_RESPONSE')
  })

  it('refusal 不进桥内续跑重试、不 kill 进程', async () => {
    const bridge = makeBridge() // 默认 emptyResponseRetries=3，本可重试 4 次
    const fake = makeFakeRemote([{ text: '拒绝', stopReason: 'refusal' }])
    await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(fake.promptCount(), 1, '重投同一请求极可能再次被拒 ⇒ 不得桥内重试')
    assert.equal(fake.prompts.length, 1)
    assert.equal(fake.kills(), 0, '会话仍健康，不得 kill/reconnect')
  })

  it('stopReason=end_turn 且空正文 ⇒ 仍是 EMPTY_RESPONSE（既有行为不变）', async () => {
    const bridge = makeBridge({ emptyResponseRetries: 0 })
    const fake = makeFakeRemote([{ text: '', stopReason: 'end_turn' }])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'EMPTY_RESPONSE')
  })
})

describe('submit-failure 分级：ACP_REFUSAL = failover', () => {
  it('精确错误码命中 failover（不靠文本正则兜底）', () => {
    assert.equal(classifySubmitFailure('ACP_REFUSAL', REFUSAL_MESSAGE), FAILOVER)
    // 大小写不敏感（classifySubmitFailure 内部 toUpperCase）
    assert.equal(classifySubmitFailure('acp_refusal', ''), FAILOVER)
    // 仍可被配置覆盖为 fatal
    assert.equal(classifySubmitFailure('ACP_REFUSAL', '', { ACP_REFUSAL: 'fatal' }), 'fatal')
  })
})

describe('product_submit：refusal 必须让编排层看见', () => {
  it('带正文的 refusal ⇒ 提交失败，submit-failed 恰好一次且 grade=failover', async () => {
    const bridge = makeBridge()
    const fake = makeFakeRemote([{ text: '抱歉，我不能协助这个请求。', stopReason: 'refusal' }])
    const harness = makeSubmitHarness({ bridge, remote: fake.remote })
    const err = await harness.run().then(() => null, (e) => e)
    assert.ok(err, 'product_submit 必须失败')
    assert.equal(err.code, 'ACP_REFUSAL')
    const failed = harness.emitted.filter((e) => e.name === 'product-subagents/submit-failed')
    assert.equal(failed.length, 1, `submit-failed 应恰好一次，实发 ${failed.length}`)
    assert.equal(failed[0].payload.code, 'ACP_REFUSAL')
    assert.equal(failed[0].payload.grade, FAILOVER, '换一档模型可能不再拒绝 ⇒ 归 failover')
    assert.equal(harness.emitted.filter((e) => e.name === 'product-subagents/submit-ok').length, 0)
  })
})
