/**
 * v0.7.20 回归测试：**模型排队（model_queued / RESOURCE_LIMIT / 10605）**必须被
 * 判成可重试故障，走 `submit()` 里**现成**的限流重试路径。
 * 故障现场（真实 ACP 派发，product_submit 挂起约 8 分钟、attempt_failed × 9）：
 *   code: 'model_queued', httpStatus: 403, status: 'FORBIDDEN',
 *   data: { code: '10605', subCode: 'RESOURCE_LIMIT' },
 *   message: '{"isQueued":true,"modelKey":"qfmodel","queueType":"p3",
 *             "retryAfterSeconds":30,"serviceAvailable":false}'
 *
 * 旧判定只认 `429 / rate limit / quota / 限流…`，对上面这套 qoder 自有信号
 * **全部漏判** ⇒ 重试分支被完全绕过，一次排队直接挂到 SUBMIT_TIMEOUT。
 *
 * 断言的是【真实行为】：判定函数返回值、桥收到的 prompt 次数、kill 次数、
 * 实际退避时长、编排层事件总线载荷。
 *
 * 注意配置通道：rateLimitRetries / rateLimitBackoffMs 读的是 **bridge 构造 options**
 * （acp.js submit 的 1475-1478 一带），不是 submit() 的 settings 形参。
 * 每个用例用**独立的 command 名**，因为 throttle.js 的限流器是**按 command 共享**的
 * 模块级 Map（cooldownUntil / consecutiveFailures 会跨用例累积，串了会互相拖慢）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createAcpBridge, isRateLimited, extractRetryAfterMs } from '../lib/bridges/acp.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'

const TASK = '修复导航栏样式问题'
const QUEUED_JSON = '{"isQueued":true,"modelKey":"qfmodel","queueType":"p3","serviceAvailable":false}'

// ── v0.7.21：真实故障原文（编排层收到的两封，仅 sessionId / request id 不同）──
// 现场：qodercli 的排队是 `queue` + `ing` 形容词形态，旧 token 只认 queued/queueType/
// isQueued，**一个都不匹配** ⇒ 绕过档内退避重试、一秒都没等就上报编排层换档。
const QUEUING_FAILED_5 = `500: Queuing failed. Try again later or enter /model to switch models. | stderr: Error handling request
{ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: '83193b62-2006-41e2-97db-8eb5`
const QUEUING_FAILED_2 = `500: Queuing failed. Try again later or enter /model to switch models. | stderr: Error handling request
{ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: '1c52520f-2f1d-4ff7-993e-555e`

/** 真实观测到的完整错误形态（RequestError 形状：code/message/data）。 */
const qoderQueuedError = (extra = {}) => Object.assign(
  new Error(QUEUED_JSON),
  {
    code: 'model_queued',
    httpStatus: 403,
    status: 'FORBIDDEN',
    data: { code: '10605', subCode: 'RESOURCE_LIMIT' },
  },
  extra,
)

// ─────────────── 单元级：Queuing（-ing 形）漏判回归（v0.7.21）───────────────

/**
 * 真实的 ACP RequestError 形状：`new RequestError(code, message, data)`。
 * 关键：**嵌套** `error.error` 承载底层错误，`message` 是顶层那行 500 文案，
 * `code` 是数字（不是 'RATE_LIMITED'）——所以只能靠文本 token 命中。
 */
const queuingError = (raw) => Object.assign(
  new Error(raw),
  { code: 500, error: Object.assign(new Error('Error handling request'), { code: 500 }) },
)

describe('isRateLimited：Queuing failed 必须命中（v0.7.21 漏判回归）', () => {
  it('命中：真实原文 Error 包着 data（RequestError 形状，id: 5）', () => {
    const err = Object.assign(new Error(QUEUING_FAILED_5), {
      code: 500,
      error: Object.assign(new Error('Error handling request'), { code: 500 }),
      data: { code: '500', message: QUEUING_FAILED_5 },
    })
    assert.equal(isRateLimited(err), true, 'data 形态必须命中（collectErrorText 的 ④ 通道）')
  })

  it('命中：裸字符串消息（id: 5）', () => {
    assert.equal(isRateLimited(QUEUING_FAILED_5), true)
  })

  it('命中：裸字符串消息（id: 2，另一 sessionId）', () => {
    assert.equal(isRateLimited(QUEUING_FAILED_2), true)
  })

  it('命中：拼写变体 Queueing failed（双 e 拼法）', () => {
    assert.equal(isRateLimited(QUEUING_FAILED_5.replace('Queuing', 'Queueing')), true)
    assert.equal(isRateLimited({ message: 'Queueing failed' }), true)
  })

  it('命中：纯 -ing 词形（queuing / queueing / 大写）', () => {
    assert.equal(isRateLimited({ message: 'queuing' }), true)
    assert.equal(isRateLimited({ message: 'queueing' }), true)
    assert.equal(isRateLimited({ message: 'QUEUING FAILED' }), true)
  })
})

describe('isRateLimited：Queuing 词形不得误伤（v0.7.21 克制口径）', () => {
  it('不命中：裸 queue / 排队 / 队列已清空（0.7.20 已论证的误伤面）', () => {
    assert.equal(isRateLimited({ message: 'queue' }), false)
    assert.equal(isRateLimited({ message: '排队' }), false)
    assert.equal(isRateLimited({ message: '队列已清空' }), false)
  })

  it('不命中：-ing 词形嵌在更长单词里（dequeuing / enqueueing）', () => {
    assert.equal(isRateLimited({ message: 'dequeuing the pending items' }), false)
    assert.equal(isRateLimited({ message: 'enqueueing jobs now' }), false)
  })

  it('不命中：裸 Try again later（泛化短语，刻意留给 submit-failure 的 FAILOVER_TEXT）', () => {
    assert.equal(
      isRateLimited({ message: 'Try again later' }),
      false,
      '该短语已在 lib/submit-failure.js:106 的 FAILOVER_TEXT 里 ⇒ failover 分级已覆盖，'
      + '纳入限流词表会把任何含它的错误一票挂进限流族，伤害面 > 收益',
    )
  })
})

// ─────────────────────── 单元级：既有 v0.7.20 判定 ───────────────────────

describe('isRateLimited：模型排队信号必须命中（v0.7.20）', () => {
  // 任务书逐个实测过的 5 个样本——改造前**全部未命中**，现在必须全部命中。
  const MUST_HIT = [
    ['model_queued（裸 code）', { code: 'model_queued', message: 'model_queued' }],
    ['排队载荷 JSON 进 message', { message: QUEUED_JSON }],
    ['RESOURCE_LIMIT', { message: 'RESOURCE_LIMIT' }],
    ['10605', { message: '10605' }],
    ['Resource limit reached', { message: 'Resource limit reached' }],
  ]
  for (const [label, error] of MUST_HIT) {
    it(`命中：${label}`, () => {
      assert.equal(isRateLimited(error), true, `${label} 必须判为可重试故障`)
    })
  }

  it('命中：真实 qoder 完整错误对象（含 data.code/subCode）', () => {
    assert.equal(isRateLimited(qoderQueuedError()), true)
  })

  it('命中：结构化字段单点即可（data.code=model_queued，message 无关）', () => {
    assert.equal(isRateLimited({ message: 'boom', data: { code: 'model_queued' } }), true)
  })

  it('命中：403 + serviceAvailable:false（结构化兜底）', () => {
    assert.equal(isRateLimited({ message: 'boom', data: { httpStatus: 403, serviceAvailable: false } }), true)
  })

  it('命中：10605 大小写/形态变体（大写下划线形 RESOURCE_LIMIT）', () => {
    assert.equal(isRateLimited({ message: 'resource_limit' }), true)
  })

  // 反例：这些**必须不命中**——判宽了会让正常失败被当成限流，白等退避 + 重投任务。
  const MUST_MISS = [
    ['普通错误 invalid api key', { message: 'invalid api key' }],
    ['普通错误 boom', { message: 'boom' }],
    ['含 queue 字样的普通文本', { message: 'the queue backlog is now drained' }],
    ['enqueued（非排队信号）', { message: 'tasks are enqueued for later' }],
    ['更长数字里的 10605', { message: 'error 1106050 occurred' }],
    ['serviceAvailable:true', { message: '{"serviceAvailable":true}' }],
    ['无关 subCode', { message: 'boom', data: { subCode: 'NOT_FOUND' } }],
    ['空/null', null],
    ['裸字符串普通文本', 'something went wrong'],
    ['正常完成任务（中文成功文案）', { message: '正常完成任务' }],
  ]
  for (const [label, error] of MUST_MISS) {
    it(`不命中：${label}`, () => {
      assert.equal(isRateLimited(error), false, `${label} 不得被误判为限流/排队`)
    })
  }

  it('回归：原有 429 / rate limit / RATE_LIMITED 判定不被削弱', () => {
    assert.equal(isRateLimited({ message: 'HTTP 429 Too Many Requests' }), true)
    assert.equal(isRateLimited({ message: 'rate limit exceeded' }), true)
    assert.equal(isRateLimited({ message: '请求过于频繁' }), true)
    assert.equal(isRateLimited({ code: 'RATE_LIMITED' }), true)
  })
})

describe('extractRetryAfterMs：尊重产品给的 retryAfterSeconds', () => {
  it('从 message 里的 JSON 载荷解析', () => {
    assert.equal(extractRetryAfterMs({ message: '{"isQueued":true,"retryAfterSeconds":30}' }), 30000)
  })
  it('从结构化字段解析（顶层与 data 两层）', () => {
    assert.equal(extractRetryAfterMs({ retryAfterSeconds: 45 }), 45000)
    assert.equal(extractRetryAfterMs({ data: { retryAfterSeconds: 12 } }), 12000)
  })
  it('解析不出时返回 0（调用方回落到 rateLimitBackoffMs）', () => {
    assert.equal(extractRetryAfterMs({ message: 'boom' }), 0)
    assert.equal(extractRetryAfterMs(null), 0)
    assert.equal(extractRetryAfterMs({ message: '{"retryAfterSeconds":0}' }), 0)
  })
})

// ─────────────────────────── 集成级：桥内重试真的发生 ───────────────────────────

/** 构造桥；默认关掉看门狗与宽限窗口，让用例跑得快。 */
const makeBridge = (extra = {}) => createAcpBridge({
  watchdogNoOutputMs: 60000,
  emptyResponseRetryDelayMs: 0,
  ...extra,
})

/**
 * 假 remote：走 submit() 的真实内部循环（watchdog / drainText / 限流重试分支），
 * 不依赖真实 CLI。`outcomes[i]` 决定第 i 次 connection.prompt 的行为：
 *   - 函数 ⇒ 其返回值即 { text } 结果（写入文本缓冲区）；
 *   - Error 实例 ⇒ 直接 throw（模拟产品返回排队错误）。
 */
function makeFakeRemote(outcomes) {
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
        const fn = outcomes[Math.min(idx, outcomes.length - 1)]
        const out = fn ? fn() : null
        if (out instanceof Error) throw out
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

const submitWith = (bridge, remote, task) => bridge.submit(
  remote,
  task,
  new AbortController().signal,
  '/tmp',
  {},
  () => false,
)

describe('acp submit：model_queued 走限流重试路径', () => {
  it('首次排队、二次成功 ⇒ 重试发生、返回正文、不 kill 进程', async () => {
    // 独立 command 名：throttle.js 的限流器按 command 共享，隔离避免跨用例串扰。
    const bridge = makeBridge({ command: 'fakeq-a', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => qoderQueuedError(),
      () => ({ text: 'OK-AFTER-QUEUE' }),
    ])
    const out = await submitWith(bridge, fake.remote, TASK)
    assert.equal(out.text, 'OK-AFTER-QUEUE', '排队重试后必须拿到正文')
    assert.equal(fake.promptCount(), 2, '应当重发一次 prompt（1 次原任务 + 1 次重试）')
    assert.equal(fake.kills(), 0, '排队重试不得 kill 进程（会话上下文是本方案的全部价值）')
    assert.equal(fake.remote.proc.exitCode, null)
  })

  it('排队重试投递的是【原 task】而非延续指令（产品并未开始干活）', async () => {
    const bridge = makeBridge({ command: 'fakeq-b', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => qoderQueuedError(),
      () => ({ text: 'OK-BODY' }),
    ])
    await submitWith(bridge, fake.remote, TASK)
    assert.deepEqual(fake.prompts[0], [{ type: 'text', text: TASK }])
    assert.deepEqual(fake.prompts[1], [{ type: 'text', text: TASK }], '排队未执行 ⇒ 重投原任务，不是延续指令')
  })

  it('退避不得短于载荷里的 retryAfterSeconds（下界语义）', async () => {
    const bridge = makeBridge({ command: 'fakeq-c', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => qoderQueuedError({ message: '{"isQueued":true,"retryAfterSeconds":2}' }),
      () => ({ text: 'OK-AFTER-WAIT' }),
    ])
    const startedAt = Date.now()
    const out = await submitWith(bridge, fake.remote, TASK)
    const elapsed = Date.now() - startedAt
    assert.equal(out.text, 'OK-AFTER-WAIT')
    assert.ok(
      elapsed >= 1900,
      `退避应取 max(rateLimitBackoffMs=1000, retryAfterSeconds=2s)=2000ms，实测仅 ${elapsed}ms`,
    )
  })

  it('重试预算耗尽 ⇒ 才把排队错误抛给编排层', async () => {
    const bridge = makeBridge({ command: 'fakeq-d', rateLimitRetries: 1, rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([() => qoderQueuedError()])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.ok(err, '预算耗尽必须抛错')
    assert.equal(err.code, 'model_queued', '抛的是原错误，码不变（分级归 submit-failure，本改造不碰）')
    assert.equal(fake.promptCount(), 2, '1 次原任务 + 1 次重试 = 2 次 prompt')
    assert.equal(fake.kills(), 0)
  })

  it('rateLimitRetries: 0 ⇒ 关闭重试，行为与改造前一致（回归保护）', async () => {
    const bridge = makeBridge({ command: 'fakeq-e', rateLimitRetries: 0, rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => qoderQueuedError(),
      () => ({ text: 'OK-BODY' }), // 本可重试成功
    ])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'model_queued')
    assert.equal(fake.promptCount(), 1, '关闭重试时只投递一次')
  })

  it('非排队失败仍原样抛出（不误判成限流）', async () => {
    const bridge = makeBridge({ command: 'fakeq-f', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([() => Object.assign(new Error('boom: invalid api key'), { code: 'INVALID_API_KEY' })])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.equal(err.code, 'INVALID_API_KEY')
    assert.equal(fake.promptCount(), 1, '非限流错误不得触发重试')
  })
})

// ───────────────── 编排层不可见：排队重试不产生 submit-failed 事件 ─────────────────

/**
 * 最小假宿主（与 test/empty-response-retry.test.js 的 makeSubmitHarness 同形）：
 * 只提供 product_submit 需要的 ctx 表面 + 一个绑到【真 acp bridge】的 remote，
 * 用来机械证明"排队重试在本次 submit 内完成 ⇒ 主代理看不到失败信号"。
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

// ───────────── 集成级：Queuing failed 走档内退避重试（v0.7.21）─────────────
//
// ★ 本族（限流/排队）重试**重发原 task**；EMPTY_RESPONSE 族重发的是**延续指令**。
//   两族并存，下面两条用例专门把这条边界钉死（别把两族混成一族）。

describe('acp submit：Queuing failed 走档内退避重试', () => {
  it('首次排队、二次成功 ⇒ 重试发生且投递【原 task】（不是延续指令）', async () => {
    const bridge = makeBridge({
      command: 'fakeqg-a',
      rateLimitBackoffMs: 1000,
      emptyResponseRetryDelayMs: 0,
    })
    const fake = makeFakeRemote([
      () => queuingError(QUEUING_FAILED_5),
      () => ({ text: 'OK-AFTER-QUEUING' }),
    ])
    const out = await submitWith(bridge, fake.remote, TASK)
    assert.equal(out.text, 'OK-AFTER-QUEUING', '排队退避重试后必须拿到正文')
    assert.equal(fake.promptCount(), 2, '应当重发一次 prompt（1 次原任务 + 1 次重试）')
    assert.deepEqual(fake.prompts[0], [{ type: 'text', text: TASK }])
    assert.deepEqual(
      fake.prompts[1],
      [{ type: 'text', text: TASK }],
      '排队族重投【原 task】——产品在排队时并未开始干活，不得投递延续指令',
    )
    assert.equal(fake.kills(), 0, '档内重试不得 kill 进程（会话上下文是本方案的全部价值）')
  })

  it('退避 ≥ rateLimitBackoffMs（真的等了，不是立刻上报）', async () => {
    const bridge = makeBridge({ command: 'fakeqg-b', rateLimitBackoffMs: 2000 })
    const fake = makeFakeRemote([
      () => queuingError(QUEUING_FAILED_2),
      () => ({ text: 'OK' }),
    ])
    const startedAt = Date.now()
    const out = await submitWith(bridge, fake.remote, TASK)
    const elapsed = Date.now() - startedAt
    assert.equal(out.text, 'OK')
    assert.ok(
      elapsed >= 2000,
      `档内退避必须 ≥ 配置的 rateLimitBackoffMs=2000ms，实测仅 ${elapsed}ms（若为 0 即"一秒都没退避"）`,
    )
  })

  it('排队族与 EMPTY_RESPONSE 族不串：排队重投原 task，空正文才投延续指令', async () => {
    const bridge = makeBridge({
      command: 'fakeqg-c',
      rateLimitBackoffMs: 1000,
      emptyResponseRetries: 1,
      emptyResponseRetryDelayMs: 0,
    })
    const fake = makeFakeRemote([
      () => queuingError(QUEUING_FAILED_5), // 第 1 跳：排队 ⇒ 原 task
      () => ({ text: '' }),                 // 第 2 跳：空正文 ⇒ 延续指令
      () => ({ text: 'OK-MIXED' }),
    ])
    const out = await submitWith(bridge, fake.remote, TASK)
    assert.equal(out.text, 'OK-MIXED')
    assert.equal(fake.promptCount(), 3)
    assert.deepEqual(fake.prompts[0], [{ type: 'text', text: TASK }])
    assert.deepEqual(fake.prompts[1], [{ type: 'text', text: TASK }], '排队重试仍投原 task')
    const cont = String(fake.prompts[2][0].text)
    assert.notEqual(cont, TASK, 'EMPTY_RESPONSE 重试必须投【延续指令】而非原 task')
    assert.ok(cont.includes('继续'), `延续指令应含"继续"：${cont}`)
    assert.ok(!cont.includes('Queuing'), '延续指令与排队族无关')
  })

  it('重试预算耗尽 ⇒ 才把排队错误抛给编排层（分级仍归 submit-failure）', async () => {
    const bridge = makeBridge({ command: 'fakeqg-d', rateLimitRetries: 1, rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([() => queuingError(QUEUING_FAILED_5)])
    const err = await submitWith(bridge, fake.remote, TASK).then(() => null, (e) => e)
    assert.ok(err, '预算耗尽必须抛错')
    assert.match(String(err.message), /Queuing failed/, '抛的是原错误（供 submit-failure 判 failover）')
    assert.equal(fake.promptCount(), 2, '1 次原任务 + 1 次重试 = 2 次 prompt')
    assert.equal(fake.kills(), 0)
  })
})

describe('product_submit：Queuing failed 档内重试对编排层不可见', () => {
  it('首次排队、二次成功 ⇒ 正常返回，且 submit-failed 事件从未被发出', async () => {
    const bridge = makeBridge({ command: 'fakeqg-e', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => queuingError(QUEUING_FAILED_2),
      () => ({ text: 'OK-VISIBLE-QUEUING' }),
    ])
    const harness = makeSubmitHarness({ bridge, remote: fake.remote })
    const result = await harness.run()
    assert.ok(
      result.text.includes('OK-VISIBLE-QUEUING'),
      `应返回产品答案：${result.text}`,
    )
    const failed = harness.emitted.filter((e) => e.name === 'product-subagents/submit-failed')
    assert.equal(
      failed.length,
      0,
      `主代理不可见：排队退避重试在本次 submit 内完成，不得发出 submit-failed，实发 ${JSON.stringify(failed)}`,
    )
    assert.equal(fake.promptCount(), 2)
  })
})

describe('product_submit：排队重试对编排层不可见（v0.7.20 model_queued）', () => {
  it('首次排队、二次成功 ⇒ 正常返回，且 submit-failed 事件从未被发出', async () => {
    const bridge = makeBridge({ command: 'fakeq-h', rateLimitBackoffMs: 1000 })
    const fake = makeFakeRemote([
      () => qoderQueuedError(),
      () => ({ text: 'OK-VISIBLE' }),
    ])
    const harness = makeSubmitHarness({ bridge, remote: fake.remote })
    const result = await harness.run()
    assert.ok(result.text.includes('OK-VISIBLE'), `应返回产品答案：${result.text}`)
    const failed = harness.emitted.filter((e) => e.name === 'product-subagents/submit-failed')
    assert.equal(failed.length, 0, `主代理不可见：不得发出 submit-failed，实发 ${JSON.stringify(failed)}`)
    assert.equal(fake.promptCount(), 2)
  })
})
