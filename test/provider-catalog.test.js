import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createAcpBridge } from '../lib/bridges/acp.js'
import {
  DEFAULT_TTL_MS,
  createProviderCatalog,
  createProviderProber,
  parseConfigOptions,
} from '../lib/provider-catalog.js'

const tmpDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `pc-${label}-`))

// 本机实测的三种产品载荷（value/name 均为原样抄录；qoder 的 effort 是 reasoning_effort 且挂 category=model）
const OPENCODE = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'deepseek/deepseek-flash', options: [
    { value: 'a/b', name: 'DeepSeek/DeepSeek V4.1 Flash' }, { value: 'c/d', name: 'DeepSeek/DeepSeek V4 Pro', description: 'Reasoning' }] },
  { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
    { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }, { value: 'default', name: 'Default' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'orchestrator', options: [{ value: 'orchestrator', name: 'orchestrator' }] },
]
const DEVECO = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'deveco/GLM-5.3', options: [
    { value: 'deveco/GLM-5.1', name: 'DevEco Code/GLM-5.1' }, { value: 'deveco/GLM-5.3', name: 'DevEco Code/GLM-5.3' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build' }] },
]
const QODER = [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default', description: 'Prompts for approval' }] },
  { id: 'model', category: 'model', type: 'select', currentValue: 'qfmodel', options: [
    { value: 'qmodel_38max', name: 'Qwen3.8-Max (default)', description: 'Reasoning · Vision · New · 0.50x Credit' },
    { value: 'qfmodel', name: 'Qwen3.8-Flash' }] },
  { id: 'reasoning_effort', category: 'model', type: 'select', currentValue: 'xhigh', options: [
    { value: 'xhigh', name: 'Extra High' }, { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'none', name: 'None' }] },
]

describe('parseConfigOptions', () => {
  it('reads models and efforts from a product-defined effort id', () => {
    const parsed = parseConfigOptions(OPENCODE)
    assert.deepEqual(parsed.models, ['a/b', 'c/d'])
    assert.deepEqual(parsed.efforts, ['low', 'high', 'max', 'default'])
    assert.equal(parsed.modelEfforts, undefined, '拿不到关联时必须省略该键')
  })

  it('carries the product-reported display names (GUI 显示名来源，落盘值仍是 value)', () => {
    const parsed = parseConfigOptions(DEVECO)
    assert.deepEqual(parsed.modelOptions, [
      { value: 'deveco/GLM-5.1', name: 'DevEco Code/GLM-5.1' },
      { value: 'deveco/GLM-5.3', name: 'DevEco Code/GLM-5.3' },
    ], 'value 原样保留、不许被改写或丢弃')
    assert.deepEqual(parseConfigOptions(OPENCODE).effortOptions, [
      { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' }, { value: 'default', name: 'Default' },
    ])
    // description 有就带、没有就省略键（空串占位会让消费方以为"产品报了个空描述"）
    const qoderModel = parseConfigOptions(QODER).modelOptions
    assert.deepEqual(qoderModel[0], { value: 'qmodel_38max', name: 'Qwen3.8-Max (default)', description: 'Reasoning · Vision · New · 0.50x Credit' })
    assert.deepEqual(qoderModel[1], { value: 'qfmodel', name: 'Qwen3.8-Flash' })
    // name 缺失时省略该键，由 A 侧回退显示 value
    const anonymous = [{ id: 'model', category: 'model', type: 'select', currentValue: 'x', options: [{ value: 'x' }] }]
    assert.deepEqual(parseConfigOptions(anonymous).modelOptions, [{ value: 'x' }])
  })

  it('values stay pure string arrays and match the options entries 1:1（增量而非替换）', () => {
    for (const payload of [OPENCODE, DEVECO, QODER]) {
      const parsed = parseConfigOptions(payload)
      assert.deepEqual(parsed.models, parsed.modelOptions.map((o) => o.value))
      assert.deepEqual(parsed.efforts, parsed.effortOptions.map((o) => o.value))
      assert.ok(parsed.models.every((m) => typeof m === 'string'))
    }
  })

  it('handles a product without any reasoning option (deveco)', () => {
    const parsed = parseConfigOptions(DEVECO)
    assert.deepEqual(parsed.models, ['deveco/GLM-5.1', 'deveco/GLM-5.3'])
    assert.deepEqual(parsed.efforts, [])
    assert.deepEqual(parsed.effortOptions, [])
  })

  it('handles a reasoning option whose category collides with model (qoder)', () => {
    const parsed = parseConfigOptions(QODER)
    assert.deepEqual(parsed.models, ['qmodel_38max', 'qfmodel'])
    assert.deepEqual(parsed.efforts, ['xhigh', 'low', 'medium', 'none'])
  })

  it('fills modelEfforts only when the effort option is grouped by known models', () => {
    const grouped = [{ id: 'model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1' }, { value: 'm2' }] },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
        { group: 'm1', name: 'M1', options: [{ value: 'low' }, { value: 'high' }] },
        { group: 'm2', name: 'M2', options: [{ value: 'max' }] },
      ] }]
    assert.deepEqual(parseConfigOptions(grouped).modelEfforts, { m1: ['low', 'high'], m2: ['max'] })
    // 分组键对不上任何 model id → 不猜
    const unknown = grouped.map((o) => (o.id === 'effort'
      ? { ...o, options: [{ group: 'zzz', name: 'ZZZ', options: [{ value: 'low' }] }] }
      : o))
    assert.equal(parseConfigOptions(unknown).modelEfforts, undefined)
  })

  it('expands grouped options into modelEffortOptions with names（分组形态不许只留 value）', () => {
    const grouped = [{ id: 'model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
        { group: 'm1', name: 'M1', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
        { group: 'm2', name: 'M2', options: [{ value: 'max', name: 'Max' }] },
      ] }]
    const parsed = parseConfigOptions(grouped)
    assert.deepEqual(parsed.modelEffortOptions, {
      m1: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
      m2: [{ value: 'max', name: 'Max' }],
    })
    assert.deepEqual(parsed.effortOptions, [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }], '当前 model 那组的 name 也要透出')
    assert.deepEqual(parsed.efforts, ['low', 'high'])
    // 组内条目无名 → modelEffortOptions 同样省略 name 键
    const bare = grouped.map((o) => (o.id === 'effort'
      ? { ...o, options: o.options.map((g) => ({ ...g, options: g.options.map((i) => ({ value: i.value })) })) }
      : o))
    assert.deepEqual(parseConfigOptions(bare).modelEffortOptions.m2, [{ value: 'max' }])
  })

  it('scopes grouped efforts to the CURRENT model instead of the union across models', () => {
    const grouped = [{ id: 'model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1' }, { value: 'm2' }] },
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
        { group: 'm1', name: 'M1', options: [{ value: 'low' }, { value: 'high' }] },
        { group: 'm2', name: 'M2', options: [{ value: 'max' }] },
      ] }]
    assert.deepEqual(parseConfigOptions(grouped).efforts, ['low', 'high'], '不能把 m2 的 max 冒充成当前可用档位')
    // 当前 model 没有对应分组 → 退回并集（多给一档比少给安全）
    const orphan = grouped.map((o) => (o.id === 'model' ? { ...o, currentValue: 'unknown' } : o))
    assert.deepEqual(parseConfigOptions(orphan).efforts, ['low', 'high', 'max'])
  })

  it('tolerates a missing / malformed configOptions list', () => {
    const empty = { models: [], modelOptions: [], efforts: [], effortOptions: [] }
    assert.deepEqual(parseConfigOptions(undefined), empty)
    assert.deepEqual(parseConfigOptions([null, { id: 'x' }]), empty)
  })
})

describe('provider catalog file', () => {
  it('writes the frozen shape and leaves no stray tmp file', () => {
    const dir = tmpDir('shape')
    try {
      const catalog = createProviderCatalog(dir)
      const written = catalog.merge({ opencode: { models: ['a/b'], efforts: ['low'], source: 'probe', probedAt: new Date().toISOString() } })
      assert.deepEqual(written, ['opencode'])
      const file = path.join(dir, 'provider-catalog.json')
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(raw.version, 1)
      assert.ok(typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)))
      assert.deepEqual(Object.keys(raw.providers), ['opencode'])
      assert.deepEqual(raw.providers.opencode.models, ['a/b'])
      assert.equal(raw.providers.opencode.error, undefined)
      assert.equal(fs.existsSync(`${file}.tmp`), false)
      assert.equal(fs.existsSync(path.join(dir, '.provider-catalog.json.tmp')), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is readable by a second instance (cross-plugin data plane) and survives a corrupt file', () => {
    const dir = tmpDir('reload')
    try {
      createProviderCatalog(dir).merge({ qoder: { models: ['qfmodel'], efforts: [], source: 'probe', probedAt: new Date().toISOString() } })
      assert.deepEqual(createProviderCatalog(dir).get('qoder').models, ['qfmodel'])
      fs.writeFileSync(path.join(dir, 'provider-catalog.json'), '{ not json', 'utf8')
      const recovered = createProviderCatalog(dir)
      assert.deepEqual(recovered.read().providers, {})
      recovered.merge({ qoder: { models: ['x'], efforts: [], source: 'probe', probedAt: new Date().toISOString() } })
      assert.deepEqual(createProviderCatalog(dir).get('qoder').models, ['x'], '损坏后下次写入自愈')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats missing, failed and aged entries as stale (TTL)', () => {
    const dir = tmpDir('ttl')
    try {
      const catalog = createProviderCatalog(dir)
      assert.equal(catalog.isStale('nope', DEFAULT_TTL_MS), true)
      const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString()
      catalog.merge({ fresh: { models: ['m'], efforts: [], source: 'probe', probedAt: stamp(1000) } })
      catalog.merge({ aged: { models: ['m'], efforts: [], source: 'probe', probedAt: stamp(DEFAULT_TTL_MS + 60000) } })
      catalog.merge({ failed: { models: [], efforts: [], source: 'probe', probedAt: stamp(1000), error: 'boom' } })
      assert.equal(catalog.isStale('fresh', DEFAULT_TTL_MS), false)
      assert.equal(catalog.isStale('aged', DEFAULT_TTL_MS), true)
      assert.equal(catalog.isStale('failed', DEFAULT_TTL_MS), false, '失败条目按 TTL 才算过期（别在启动时反复拉进程）')
      assert.equal(catalog.isStale('fresh', 500), true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('provider prober', () => {
  const fakeBridgeFactory = (remote, calls, fail) => (def) => ({
    async create(cwd) {
      calls.push({ provider: def.name, cwd })
      if (fail) throw new Error(fail)
      return remote
    },
    async dispose() { calls.push({ disposed: def.name }) },
  })

  it('probes one ACP provider with a throwaway session and caches models/efforts', async () => {
    const dir = tmpDir('probe-ok')
    try {
      const calls = []
      const remote = { kind: 'acp', sessionId: 'ses_1', configOptions: OPENCODE }
      const updated = []
      const catalog = createProviderCatalog(dir)
      const prober = createProviderProber({
        catalog,
        providers: { opencode: { name: 'opencode', type: 'acp', command: 'opencode', args: ['acp'] } },
        defaultNames: ['opencode'],
        bridgeFactory: fakeBridgeFactory(remote, calls),
        cwd: '/workspace',
        onUpdated: (info) => updated.push(info),
      })
      const result = await prober.probe()
      assert.deepEqual(result.providers, ['opencode'])
      assert.deepEqual(calls, [{ provider: 'opencode', cwd: '/workspace' }, { disposed: 'opencode' }], '建完就弃：必须 dispose')
      const entry = catalog.get('opencode')
      assert.deepEqual(entry.models, ['a/b', 'c/d'])
      assert.deepEqual(entry.efforts, ['low', 'high', 'max', 'default'])
      assert.deepEqual(entry.modelOptions, [
        { value: 'a/b', name: 'DeepSeek/DeepSeek V4.1 Flash' },
        { value: 'c/d', name: 'DeepSeek/DeepSeek V4 Pro', description: 'Reasoning' },
      ], '缓存必须带上产品自报显示名，否则 GUI 只能亮裸 id')
      assert.deepEqual(entry.effortOptions.map((o) => o.name), ['Low', 'High', 'Max', 'Default'])
      assert.equal(entry.source, 'probe')
      assert.equal(entry.error, undefined)
      assert.ok(Number.isFinite(Date.parse(entry.probedAt)))
      assert.equal(updated.length, 1)
      assert.deepEqual(updated[0].providers, ['opencode'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records an error entry, never throws, and keeps probing the other providers', async () => {
    const dir = tmpDir('probe-err')
    try {
      const calls = []
      const catalog = createProviderCatalog(dir)
      const prober = createProviderProber({
        catalog,
        providers: {
          broken: { name: 'broken', type: 'acp', command: 'missing-cli' },
          good: { name: 'good', type: 'acp', command: 'opencode' },
        },
        defaultNames: ['broken', 'good'],
        bridgeFactory: (def) => ({
          async create(cwd) {
            calls.push({ provider: def.name, cwd })
            if (def.name === 'broken') throw new Error('spawn missing-cli ENOENT')
            return { kind: 'acp', sessionId: 's', configOptions: DEVECO }
          },
          async dispose() { calls.push({ disposed: def.name }) },
        }),
      })
      const result = await prober.probe(['broken', 'good'], { cwd: '/tmp' })
      assert.deepEqual(result.providers, ['broken', 'good'], '失败方也要写入缓存（消费方读 error）')
      assert.equal(catalog.get('broken').error, 'spawn missing-cli ENOENT')
      assert.deepEqual(catalog.get('broken').models, [])
      assert.deepEqual(catalog.get('broken').modelOptions, [], '失败条目的新字段也要是空数组（消费方不必判 undefined）')
      assert.deepEqual(catalog.get('broken').effortOptions, [])
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'provider-catalog.json'), [], '探测只写自己这个缓存，别碰用户数据')
      assert.deepEqual(catalog.get('good').models, ['deveco/GLM-5.1', 'deveco/GLM-5.3'])
      assert.deepEqual(catalog.get('good').modelOptions[0], { value: 'deveco/GLM-5.1', name: 'DevEco Code/GLM-5.1' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips non-ACP and unknown providers without writing bogus entries', async () => {
    const dir = tmpDir('probe-skip')
    try {
      const calls = []
      const catalog = createProviderCatalog(dir)
      const prober = createProviderProber({
        catalog,
        providers: { 'claude-code': { name: 'claude-code', type: 'claude', command: 'claude' } },
        defaultNames: ['claude-code'],
        bridgeFactory: fakeBridgeFactory({ configOptions: [] }, calls),
      })
      const result = await prober.probe()
      assert.deepEqual(result.providers, [])
      assert.deepEqual(catalog.read().providers, {})
      const unknown = await prober.probe(['ghost'])
      assert.deepEqual(unknown.providers, [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent probes of the same provider into one session', async () => {
    const dir = tmpDir('probe-dedupe')
    try {
      let creates = 0
      let disposes = 0
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const prober = createProviderProber({
        catalog: createProviderCatalog(dir),
        providers: { opencode: { name: 'opencode', type: 'acp' } },
        defaultNames: ['opencode'],
        bridgeFactory: () => ({
          async create() { creates += 1; await gate; return { kind: 'acp', sessionId: 's', configOptions: OPENCODE } },
          async dispose() { disposes += 1 },
        }),
      })
      // 两次探测在同一 tick 发起：settle() 同步登记 inFlight，故第二次必然复用
      const both = Promise.all([prober.probe(['opencode']), prober.probe(['opencode'])])
      await new Promise((resolve) => setImmediate(resolve))
      release()
      const results = await both
      assert.deepEqual(results.map((r) => r.providers), [['opencode'], ['opencode']])
      assert.equal(creates, 1, '并发探测复用同一条会话')
      assert.equal(disposes, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('staleNames drives the startup probe (fresh cache → no process is spawned)', async () => {
    const dir = tmpDir('probe-stale')
    try {
      const prober = createProviderProber({
        catalog: createProviderCatalog(dir),
        providers: { opencode: { name: 'opencode', type: 'acp' } },
        defaultNames: ['opencode'],
        bridgeFactory: () => ({ async create() { throw new Error('should not be called') }, async dispose() {} }),
      })
      assert.deepEqual(prober.staleNames(['opencode']), ['opencode'], '缺失 → 需探测')
      prober.catalog.merge({ opencode: { models: ['m'], efforts: [], source: 'probe', probedAt: new Date().toISOString() } })
      assert.deepEqual(prober.staleNames(['opencode']), [], '缓存命中 → 启动不拉进程')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probes again despite a fresh entry (GUI 刷新语义：绕过 TTL，只有启动预探才看 TTL)', async () => {
    const dir = tmpDir('probe-force')
    try {
      const catalog = createProviderCatalog(dir)
      catalog.merge({ opencode: { models: ['stale'], efforts: [], source: 'probe', probedAt: new Date().toISOString() } })
      let creates = 0
      const prober = createProviderProber({
        catalog,
        providers: { opencode: { name: 'opencode', type: 'acp' } },
        defaultNames: ['opencode'],
        bridgeFactory: () => ({
          async create() { creates += 1; return { kind: 'acp', sessionId: 's', configOptions: OPENCODE } },
          async dispose() {},
        }),
      })
      assert.deepEqual(prober.staleNames(['opencode']), [], '先看：缓存是新鲜的')
      const result = await prober.probe(['opencode'], { reason: 'manual-refresh' })
      assert.equal(creates, 1)
      assert.deepEqual(catalog.get('opencode').models, ['a/b', 'c/d'], '强制重探必须真的覆盖缓存')
      assert.deepEqual(result.providers, ['opencode'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('probe process cleanup (M2)', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // 只 sleep、永不 initialize 的假 ACP 进程：真实的 createAcpBridge 会 spawn 它并永远等不到响应，
  // 正好用来验证「探测超时被放弃」时进程有没有被收走。
  function silentSpawn(sink) {
    return () => {
      const proc = new EventEmitter()
      proc.stdin = new PassThrough()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.exitCode = null
      proc.signalCode = null
      proc.kill = (sig) => {
        sink.kills.push(sig || 'SIGTERM')
        proc.signalCode = sig || 'SIGTERM'
        setImmediate(() => proc.emit('close'))
      }
      sink.procs.push(proc)
      return proc
    }
  }

  it('SIGKILLs the spawned CLI when the probe times out (no orphan process)', async () => {
    const dir = tmpDir('probe-timeout')
    const sink = { procs: [], kills: [] }
    try {
      const prober = createProviderProber({
        catalog: createProviderCatalog(dir),
        providers: { hang: { name: 'hang', type: 'acp', command: 'fake-acp' } },
        defaultNames: ['hang'],
        timeoutMs: 120,
        bridgeFactory: (def, hooks) => createAcpBridge({
          command: def.command, args: [], spawn: silentSpawn(sink), onSpawn: hooks.onSpawn,
        }),
      })
      const result = await prober.probe(['hang'])
      assert.deepEqual(result.providers, ['hang'], '超时也要写缓存条目（消费方读 error）')
      const entry = createProviderCatalog(dir).get('hang')
      assert.deepEqual(entry.models, [])
      assert.match(entry.error, /超时/, 'error 必须说明是超时')
      assert.equal(sink.procs.length, 1, '只 spawn 了一次（不重试）')
      assert.ok(sink.kills.includes('SIGKILL'), `超时必须 SIGKILL 被放弃的进程，实际信号: ${JSON.stringify(sink.kills)}`)
      assert.equal(sink.procs[0].signalCode, 'SIGKILL')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('disposes the session when create() lands after the probe gave up', async () => {
    const dir = tmpDir('probe-late')
    try {
      let disposed = null
      const late = {}
      const prober = createProviderProber({
        catalog: createProviderCatalog(dir),
        providers: { slow: { name: 'slow', type: 'acp' } },
        defaultNames: ['slow'],
        timeoutMs: 60,
        bridgeFactory: () => ({
          async create() { await sleep(200); return late },
          async dispose(remote) { disposed = remote },
        }),
      })
      const result = await prober.probe(['slow'])
      assert.match(createProviderCatalog(dir).get('slow').error, /超时/)
      assert.equal(result.providers.length, 1)
      await sleep(260)
      assert.equal(disposed, late, '迟到的会话也必须被关掉，否则远程会话泄漏')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills the child when session/new fails after a successful handshake', async () => {
    const kills = []
    // 假 ACP agent：initialize 应答成功、session/new 回 JSON-RPC 错误。
    // 走的是真 createAcpBridge，所以验证的是 acp.js 自己的孤儿清理。
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.exitCode = null
    proc.signalCode = null
    proc.kill = (sig) => { kills.push(sig || 'SIGTERM'); proc.signalCode = sig || 'SIGTERM' }
    let buffer = ''
    proc.stdin.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
        } else if (msg.method === 'session/new') {
          proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'session/new rejected by agent' } })}\n`)
        }
      }
    })
    const bridge = createAcpBridge({ command: 'fake-acp', args: [], spawn: () => proc })
    await assert.rejects(() => bridge.create('/tmp'), /session\/new rejected by agent/)
    assert.deepEqual(kills, ['SIGKILL'], '握手成功但会话没建成 → 进程必须被收走')
  })
})
