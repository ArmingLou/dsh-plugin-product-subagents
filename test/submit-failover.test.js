/**
 * v0.7.3 回归测试：product_submit 的失败分级 + 回合内换档握手。
 *
 * 覆盖用户钉死的语义：
 *   - 限额/限流类（429 / rate limit / quota / insufficient_quota / 余额不足 / overloaded）
 *     判为 failover（允许编排层静默换下一档）；
 *   - 空正文 / 超时 / 传输中断判为 failover；
 *   - 认证失败 / 参数非法 / 语法错误 / 模型不存在 / 链耗尽判为 fatal（**不**换档）；
 *   - 人为中断判为 interrupted；
 *   - 有登记的换档处理器时，本次工具调用【阻塞】等它返回：成功 → 把新档答案当本次
 *     答案返回（提交从未失败）；链耗尽 → 抛出自解释的汇总错误（不是原始的裸错误）。
 *
 * 断言的是【真实行为】：返回值、抛出码、事件载荷与调用次数，而不是源码里有某字符串。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { FAILOVER, FATAL, INTERRUPTED, classifySubmitFailure } from '../lib/submit-failure.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'

describe('classifySubmitFailure：失败分级', () => {
  it('限额/限流类一律 failover（静默换下一档，不得提前释放失败信号）', () => {
    const cases = [
      ['RATE_LIMITED', 'deveco: 429 rate limit exceeded'],
      [null, 'HTTP 429 Too Many Requests'],
      [null, 'rate limit reached for gpt-5'],
      [null, 'You exceeded your current quota, please check your plan and billing details'],
      ['RATE_LIMIT_EXHAUSTED', 'insufficient_quota'],
      [null, '余额不足，请充值'],
      [null, 'The model is overloaded, please try again later'],
      [null, '503 service_unavailable'],
      ['USAGE_LIMIT', 'usage limit reached'],
    ]
    for (const [code, message] of cases) {
      assert.equal(classifySubmitFailure(code, message), FAILOVER, `${code ?? ''} ${message}`)
    }
  })

  it('空正文 / 超时 / 传输中断判为 failover', () => {
    assert.equal(classifySubmitFailure('EMPTY_RESPONSE', 'deveco 返回空正文（无任何文本输出）'), FAILOVER)
    assert.equal(classifySubmitFailure('SUBMIT_TIMEOUT', 'deveco ACP prompt idle timeout'), FAILOVER)
    assert.equal(classifySubmitFailure(null, 'socket hang up'), FAILOVER)
    assert.equal(classifySubmitFailure(null, 'ECONNRESET while reading stream'), FAILOVER)
  })

  it('重试也不会改善的错误判为 fatal（认证 / 参数 / 语法 / 模型不存在 / 链耗尽）', () => {
    const cases = [
      ['INVALID_API_KEY', 'invalid api key'],
      [null, 'HTTP 401 Unauthorized'],
      [null, 'HTTP 403 Forbidden'],
      ['INVALID_ARGUMENT', 'invalid argument: model'],
      [null, 'schema validation failed for tool call'],
      ['SYNTAX_ERROR', '语法错误：unexpected token'],
      ['MODEL_NOT_FOUND', 'model not found: gpt-9'],
      [null, 'permission denied by user'],
      ['FAILOVER_EXHAUSTED', '所有路由均失败'],
    ]
    for (const [code, message] of cases) {
      assert.equal(classifySubmitFailure(code, message), FATAL, `${code ?? ''} ${message}`)
    }
  })

  it('人为中断判为 interrupted（既不换档也不算产品故障）', () => {
    assert.equal(classifySubmitFailure('SUBMIT_ABORTED', 'aborted'), INTERRUPTED)
    assert.equal(classifySubmitFailure('WATCHDOG_CLOSED', 'child 已关闭'), INTERRUPTED)
  })

  it('未知错误兜底 failover——只有被明确归入 fatal 的那一类才停止换档', () => {
    assert.equal(classifySubmitFailure(null, 'something nobody has ever seen'), FAILOVER)
    assert.equal(classifySubmitFailure(null, ''), FAILOVER)
    assert.equal(classifySubmitFailure(undefined, undefined), FAILOVER)
  })

  it('配置覆盖优先于内置分级（submitFailureGrades）', () => {
    assert.equal(classifySubmitFailure('EMPTY_RESPONSE', '空正文', { EMPTY_RESPONSE: 'fatal' }), FATAL)
    assert.equal(classifySubmitFailure('INVALID_API_KEY', 'invalid api key', { INVALID_API_KEY: 'failover' }), FAILOVER)
    assert.equal(classifySubmitFailure('SUBMIT_ABORTED', 'aborted', { SUBMIT_ABORTED: 'failover' }), FAILOVER)
    assert.equal(classifySubmitFailure('SUBMIT_TIMEOUT', 'timeout', { EMPTY_RESPONSE: 'fatal' }), FAILOVER)
  })
})

/**
 * 最小假宿主：只提供 product_submit 需要的 ctx 表面（tools.register / emit / get），
 * 加一个按脚本抛错/返回的桥。`onEmit` 让每个用例决定"编排层登记什么"。
 */
function makeSubmitHarness({ submit, onEmit = () => {} }) {
  const emitted = []
  const tools = new Map()
  const agent = { session: { id: 'child-1', header: { cwd: '/tmp' } } }
  const ctx = {
    tools: { register: (def) => tools.set(def.name, def) },
    get: () => undefined,
    emit: (name, payload) => {
      emitted.push({ name, payload })
      onEmit(name, payload)
    },
  }
  const bridge = {
    create: async () => ({}),
    submit,
    reconnect: async () => ({}),
    dispose: async () => {},
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
  bindings.set('child-1', { product: 'fake', bridge, remote: { sessionId: 'remote-1' } })
  const run = () => tools.get('product_submit').execute({ task: '修复导航栏样式问题' }, { agent, signal: new AbortController().signal })
  return { run, emitted, tools }
}

const lastPayload = (emitted, name) => emitted.filter((e) => e.name === name).at(-1)?.payload
const throwsCode = async (promise) => promise.then(() => null, (e) => e)

describe('product_submit：回合内换档握手', () => {
  it('无换档处理器 → 行为与 v0.3.7 逐字等价：照原样抛裸错误，事件载荷带上 grade', async () => {
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('fake 返回空正文（无任何文本输出）')
        err.code = 'EMPTY_RESPONSE'
        throw err
      },
    })

    const err = await throwsCode(harness.run())

    assert.ok(err, '无处理器时必须抛错')
    assert.equal(err.code, 'EMPTY_RESPONSE', '原始错误码必须原样透出')
    assert.equal(lastPayload(harness.emitted, 'product-subagents/submit-failed').grade, FAILOVER)
    assert.equal(harness.emitted.filter((e) => e.name === 'product-subagents/submit-ok').length, 0)
  })

  it('① 空正文 → 换档成功：工具调用阻塞到链走完，把新档答案当本次答案返回，并补发 submit-ok', async () => {
    let handlerCalls = 0
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('fake 返回空正文（无任何文本输出）')
        err.code = 'EMPTY_RESPONSE'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => {
          handlerCalls += 1
          return { text: '第二档的最终答案' }
        })
      },
    })

    const value = await harness.run()

    assert.equal(handlerCalls, 1, '换档处理器必须被调用且只调用一次')
    assert.match(value.text, /第二档的最终答案/, '新档答案必须当作本次提交的答案返回')
    const okPayload = lastPayload(harness.emitted, 'product-subagents/submit-ok')
    assert.ok(okPayload, '成功路径必须补发 submit-ok（清除编排层的失败标记）')
    assert.equal(okPayload.viaFailover, true)
  })

  it('② 429/限额 → 换档成功：同样阻塞并返回新档答案，失败信号一次都不外泄', async () => {
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('HTTP 429 rate limit exceeded for fake')
        err.code = 'RATE_LIMITED'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({ text: '限额后重试的答案' }))
      },
    })

    const value = await harness.run()

    assert.match(value.text, /限额后重试的答案/)
    assert.equal(lastPayload(harness.emitted, 'product-subagents/submit-failed').grade, FAILOVER)
    assert.equal(lastPayload(harness.emitted, 'product-subagents/submit-ok').viaFailover, true)
  })

  it('③ 链走完仍失败 → 抛 FAILOVER_EXHAUSTED，错误文本含已尝试 route 与各自错误', async () => {
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('fake 返回空正文')
        err.code = 'EMPTY_RESPONSE'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({
          exhausted: true,
          message: '所有路由均失败；已尝试 2 档: fake → EMPTY_RESPONSE 空正文；other → RATE_LIMITED 429',
        }))
      },
    })

    const err = await throwsCode(harness.run())

    assert.ok(err, '链走完仍失败必须抛错')
    assert.equal(err.code, 'FAILOVER_EXHAUSTED')
    assert.match(err.message, /fake → EMPTY_RESPONSE 空正文/, '失败报告必须自解释：哪一档、什么错')
    assert.match(err.message, /other → RATE_LIMITED 429/)
    assert.equal(harness.emitted.filter((e) => e.name === 'product-subagents/submit-ok').length, 0, '失败不得补发 submit-ok')
  })

  it('④ 不可重试错误（认证失败）→ 处理器不被调用，原始错误码原样透出', async () => {
    let handlerCalls = 0
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('HTTP 401 Unauthorized: invalid api key')
        err.code = 'INVALID_API_KEY'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => {
          handlerCalls += 1
          return { text: '不该被使用' }
        })
      },
    })

    const err = await throwsCode(harness.run())

    assert.ok(err)
    assert.equal(err.code, 'INVALID_API_KEY', '不得被改写成 FAILOVER_EXHAUSTED')
    assert.equal(handlerCalls, 0, 'fatal 分级不得触发换档')
    assert.equal(lastPayload(harness.emitted, 'product-subagents/submit-failed').grade, FATAL)
  })

  it('⑤ 换档处理器自身抛错 → 不吞掉原始提交错误（降级为原错误）', async () => {
    const harness = makeSubmitHarness({
      submit: async () => {
        const err = new Error('fake 返回空正文')
        err.code = 'EMPTY_RESPONSE'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => { throw new Error('编排层炸了') })
      },
    })

    const err = await throwsCode(harness.run())

    assert.ok(err)
    assert.equal(err.code, 'EMPTY_RESPONSE', '处理器抛错时回落到原始提交错误，不伪造汇总')
  })
})
