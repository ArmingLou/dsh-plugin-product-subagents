/**
 * v0.7.4 回归测试：product_submit 的【换档交接】语义（同一级 sibling 替补的新模型）。
 *
 * v0.7.3 的孙代链把替补的答案当本次 `product_submit` 的返回值；v0.7.4 起换档决定权
 * 归主代理、替补是主代理的**直接子级**，于是本档只可能被"交接"或"判失败"：
 *
 *   - 编排层回 `{ handedOff: true, nextProvider }` → 本工具抛 FAILOVER_HANDED_OFF 收尾，
 *     且【绝不】再 emit 一次 submit-failed（FAILOVER_HANDED_OFF 是未知码，兜底分级是
 *     failover，二次 emit 会让编排层重复登记 onFailover 并再跑一条链 → 同一任务两个替补）；
 *   - 编排层回 `{ timedOut: true, summary, message }`（notify 模式超时）→ 抛
 *     FAILOVER_EXHAUSTED，错误文本必须自解释（含已试档 + 为什么没换档）；
 *   - 编排层不接管（null）→ 照原样抛裸错误；
 *   - 旧编排层的 `{ text }` / `{ exhausted }` 契约继续兼容（向后兼容回归）。
 *
 * 断言的是真实行为：抛出码、错误文本、事件条数与载荷，而不是源码里有某字符串。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  FAILOVER, FATAL, FAILOVER_EXHAUSTED, FAILOVER_HANDED_OFF, INTERRUPTED, classifySubmitFailure,
} from '../lib/submit-failure.js'
import { registerProductSubmit } from '../lib/tools/product-submit.js'

describe('FAILOVER_HANDED_OFF 的分级（v0.7.4：交接后绝不可再触发换档链）', () => {
  it('交接收尾码判为 interrupted（人为停止），绝不可判为 failover', () => {
    assert.equal(
      classifySubmitFailure(FAILOVER_HANDED_OFF, '本档已由编排层换档到下一档'),
      INTERRUPTED,
      '交接完成后再触发一条换档链 ⇒ 同一任务出现两个替补子代理',
    )
    // 分级顺序护栏：即使文本里含"失败/timeout"等 failover 特征，错误码优先
    assert.equal(
      classifySubmitFailure(FAILOVER_HANDED_OFF, 'timeout: 429 rate limit'),
      INTERRUPTED,
      '错误码必须压过文本正则',
    )
  })
})

function makeHarness({ submit, onEmit = () => {}, deps = {} }) {
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
  const bridge = { create: async () => ({}), submit, reconnect: async () => ({}), dispose: async () => {} }
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
    ...deps,
  })
  bindings.set('child-1', { product: 'fake', bridge, remote: { sessionId: 'remote-1' } })
  const run = () => tools.get('product_submit').execute(
    { task: '修复导航栏样式问题' },
    { agent, signal: new AbortController().signal },
  )
  return { run, emitted, tools }
}

const emptyResponse = () => {
  const err = new Error('fake 返回空正文（无任何文本输出）')
  err.code = 'EMPTY_RESPONSE'
  return err
}
const submits = (emitted, name) => emitted.filter((e) => e.name === name)
const throwsCode = async (promise) => promise.then(() => null, (e) => e)

describe('v0.7.4 换档交接：handedOff', () => {
  it('① handedOff → 抛 FAILOVER_HANDED_OFF，且【只】emit 一次 submit-failed', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({ handedOff: true, nextProvider: 'opencode', newChildId: 'child-2' }))
      },
    })

    const err = await throwsCode(h.run())

    assert.ok(err, '交接完成后必须以错误收尾（本次提交确实没拿到答案）')
    assert.equal(err.code, FAILOVER_HANDED_OFF, `实际 code=${err.code}`)
    assert.match(err.message, /已由编排层换档到下一档/, '错误文本必须说明已换档')
    assert.match(err.message, /opencode/, '错误文本必须点名下一档')
    assert.match(err.message, /替补档为主代理的直接子级/, '错误文本必须说明替补的形态')
    assert.match(err.message, /不要再对本档重复提交/, '必须劝阻模型重试（重试会再触发一条链）')

    // ★ 最关键：不得二次 emit。FAILOVER_HANDED_OFF 会被重试路径再判一次，
    //   二次 emit 会让编排层重复登记 onFailover → 同一任务出现两个替补子代理。
    assert.equal(submits(h.emitted, 'product-subagents/submit-failed').length, 1,
      `交接路径绝不可再 emit 一次 submit-failed，实际 ${submits(h.emitted, 'product-subagents/submit-failed').length} 次`)
    assert.equal(submits(h.emitted, 'product-subagents/submit-ok').length, 0,
      '交接不算成功，不得补发 submit-ok（那会让编排层把本档标成成功）')
  })

  it('② 交接文案把下一档信息带在文案里，模型据此不会再重试同一档', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({ handedOff: true, nextProvider: 'deepseek-official' }))
      },
    })
    const err = await throwsCode(h.run())
    assert.match(err.message, /deepseek-official/)
    assert.equal(err.code, FAILOVER_HANDED_OFF)
  })
})

describe('v0.7.4 换档交接：notify 模式超时按失败收尾', () => {
  it('③ timedOut → 抛 FAILOVER_EXHAUSTED，错误文本自解释（含已试档 + 为什么没换档）', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({
          handedOff: false,
          timedOut: true,
          summary: '已尝试 1 档: fake → EMPTY_RESPONSE fake 返回空正文',
          message: '主代理在 90000ms 内未调用 agent_failover，failoverMode=notify 不自动换档',
        }))
      },
    })

    const err = await throwsCode(h.run())

    assert.ok(err)
    assert.equal(err.code, FAILOVER_EXHAUSTED, `实际 code=${err.code}`)
    assert.match(err.message, /已尝试 1 档: fake → EMPTY_RESPONSE fake 返回空正文/,
      `失败报告必须自解释（哪一档、什么错），实际：${err.message}`)
    assert.match(err.message, /未调用 agent_failover/, '必须说明"为什么没换档"')
    assert.match(err.message, /agent_failover/, '必须告诉模型/主代理该怎么补救')
    assert.match(err.message, /本次提交按失败计/, '必须明说结果是失败')
    assert.equal(submits(h.emitted, 'product-subagents/submit-ok').length, 0)
  })
})

describe('v0.7.4 载荷与向后兼容', () => {
  it('④ submit-failed 载荷带 failoverMode 与 notifyWaitMs（编排层据此决定"谁来换档"）', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: () => {},
      deps: { failoverMode: 'notify-then-auto', notifyWaitMs: 45000 },
    })
    await throwsCode(h.run())
    const payload = submits(h.emitted, 'product-subagents/submit-failed')[0].payload
    assert.equal(payload.failoverMode, 'notify-then-auto')
    assert.equal(payload.notifyWaitMs, 45000)
    assert.equal(payload.grade, FAILOVER)
  })

  it('⑤ 默认载荷 = notify-then-auto / 90000（未配置时的生效值）', async () => {
    const h = makeHarness({ submit: async () => { throw emptyResponse() }, onEmit: () => {} })
    await throwsCode(h.run())
    const payload = submits(h.emitted, 'product-subagents/submit-failed')[0].payload
    assert.equal(payload.failoverMode, 'notify-then-auto')
    assert.equal(payload.notifyWaitMs, 90000)
  })

  it('⑥ 非法 failoverMode 归一到默认（不得让编排层收到乱值）', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: () => {},
      deps: { failoverMode: 'nonsense' },
    })
    await throwsCode(h.run())
    assert.equal(submits(h.emitted, 'product-subagents/submit-failed')[0].payload.failoverMode, 'notify-then-auto')
  })

  it('⑦ 旧编排层契约（v0.7.3 的 {text}）继续可用 —— 向后兼容回归', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({ text: '旧编排层的孙代答案' }))
      },
    })
    const value = await h.run()
    assert.match(value.text, /旧编排层的孙代答案/, '旧编排层返回 {text} 时仍必须当本次答案返回')
    assert.equal(submits(h.emitted, 'product-subagents/submit-ok').at(-1).payload.viaFailover, true)
  })

  it('⑧ 旧编排层契约（{exhausted}）继续可用', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => ({ exhausted: true, message: '所有路由均失败；已尝试 2 档' }))
      },
    })
    const err = await throwsCode(h.run())
    assert.equal(err.code, 'FAILOVER_EXHAUSTED')
    assert.match(err.message, /已尝试 2 档/)
  })

  it('⑨ fatal 分级 → 处理器完全不被调用（交接/超时分支都不得触发）', async () => {
    let calls = 0
    const h = makeHarness({
      submit: async () => {
        const err = new Error('HTTP 401 Unauthorized: invalid api key')
        err.code = 'INVALID_API_KEY'
        throw err
      },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => { calls += 1; return { handedOff: true } })
      },
    })
    const err = await throwsCode(h.run())
    assert.equal(err.code, 'INVALID_API_KEY')
    assert.equal(calls, 0)
    assert.equal(submits(h.emitted, 'product-subagents/submit-failed')[0].payload.grade, FATAL)
  })

  it('⑩ 编排层既不接管也不抛错 → 照原样抛裸错误（不伪造任何换档语义）', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        payload.onFailover(async () => null)
      },
    })
    const err = await throwsCode(h.run())
    assert.equal(err.code, 'EMPTY_RESPONSE')
  })

  it('⑪ 安全网：编排层永不兑现 → 本工具不会无限期阻塞，按 notifyWaitMs+宽限 后报可解释失败', async () => {
    const h = makeHarness({
      submit: async () => { throw emptyResponse() },
      onEmit: (name, payload) => {
        if (name !== 'product-subagents/submit-failed') return
        // 编排层存在、但 rendezvous 永远不兑现（模拟编排层定时器失效的极端情况）
        payload.onFailover(() => new Promise(() => {}))
      },
      deps: { notifyWaitMs: 10 },
    })
    const t0 = Date.now()
    const err = await throwsCode(h.run())
    const elapsed = Date.now() - t0
    assert.ok(err, '必须收尾而不是挂死')
    // 宽限 = 编排层自己的 notifyWaitMs 定时器之后再多给 2s（见 raceDeadline 的调用点）
    assert.ok(elapsed >= 10 && elapsed < 4000, `安全网必须在宽限窗口（notifyWaitMs+2s）内触发，实际 ${elapsed}ms`)
    assert.match(err.message, /编排层未在合理时间内兑现换档裁决|未调用 agent_failover/,
      `实际：${err.message}`)
  })
})