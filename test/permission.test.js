import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePermission } from '../lib/bridges/acp.js'

/** 模拟 ACP server 提供的 options（deveco/opencode 风格的四个选项） */
function opts() {
  return [
    { kind: 'allow_once', name: '允许一次', optionId: 'opt-allow-once' },
    { kind: 'allow_always', name: '总是允许', optionId: 'opt-allow-always' },
    { kind: 'reject_once', name: '拒绝一次', optionId: 'opt-reject-once' },
    { kind: 'reject_always', name: '总是拒绝', optionId: 'opt-reject-always' },
  ]
}

test('fail-closed：无 handler 无 autoGrant → 选择 reject option（协议合法拒绝）', () => {
  const r = decidePermission({}, { options: opts(), toolCall: { name: 'read_file' } })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('fail-closed：无任何 reject option → cancelled', () => {
  const r = decidePermission({}, { options: [{ kind: 'allow_once', optionId: 'a' }] })
  assert.deepEqual(r, { outcome: { outcome: 'cancelled' } })
})

test('autoGrant=all → 放行（allow_once 优先）', () => {
  const r = decidePermission({ autoGrant: 'all' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } })
})

test('autoGrant=read：只读请求放行', () => {
  const r = decidePermission({ autoGrant: 'read' }, {
    options: opts(),
    toolCall: { name: 'read_file', content: [{ type: 'text', text: '读取 /Users/arming/.dsh/agents.json' }] },
  })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } })
})

test('autoGrant=read：写操作不放行（fall 到拒绝）', () => {
  const r = decidePermission({ autoGrant: 'read' }, {
    options: opts(),
    toolCall: { name: 'write_file', content: [{ type: 'text', text: '写入 /tmp/x' }] },
  })
  assert.equal(r.outcome.outcome, 'selected')
  assert.equal(r.outcome.optionId, 'opt-reject-once')
})

test('permissionHandler 同步 allow → 放行', () => {
  const r = decidePermission({ permissionHandler: () => 'allow' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } })
})

test('permissionHandler 同步 deny → 拒绝（reject_once）', () => {
  const r = decidePermission({ permissionHandler: () => 'deny' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('permissionHandler 同步 cancelled → cancelled', () => {
  const r = decidePermission({ permissionHandler: () => 'cancelled' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'cancelled' } })
})

test('permissionHandler 异步（Promise）allow → 放行', async () => {
  const r = await decidePermission({ permissionHandler: async () => 'allow' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } })
})

test('permissionHandler 直接返回 optionId → 原样选中', () => {
  const r = decidePermission({ permissionHandler: () => ({ optionId: 'opt-allow-always' }) }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-always' } })
})

test('permissionHandler 返回垃圾值 → fail-closed 拒绝（不猜测放行）', () => {
  const r = decidePermission({ permissionHandler: () => 'whatever' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('permissionHandler 抛异常 → fail-closed 拒绝', () => {
  const r = decidePermission({ permissionHandler: () => { throw new Error('boom') } }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('handler 收到 sessionId 与描述（编排层反查/弹窗用）', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    sessionId: 'ses-abc',
    options: opts(),
    toolCall: { name: 'shell', content: [{ type: 'text', text: 'ls ~/.dsh' }] },
  })
  assert.equal(seen.product, 'deveco')
  assert.equal(seen.sessionId, 'ses-abc')
  assert.ok(seen.description.includes('ls ~/.dsh'))
  assert.equal(seen.options.length, 4)
})

test('v0.4.2：描述含 arguments 的 path（弹窗不再只显示"工具调用"）', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    sessionId: 'ses-x',
    options: opts(),
    toolCall: { name: 'read_file', arguments: { path: '/Users/arming/.dsh/AGENTS.md' } },
  })
  assert.ok(seen.description.includes('read_file'), seen.description)
  assert.ok(seen.description.includes('/Users/arming/.dsh/AGENTS.md'), seen.description)
  assert.ok(seen.paths.includes('/Users/arming/.dsh/AGENTS.md'))
})

test('v0.4.2：arguments 为 JSON 字符串时也能解析出路径', () => {
  let seen = null
  decidePermission({
    product: 'opencode',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    options: opts(),
    toolCall: { name: 'file_read', arguments: '{"file": "/Users/arming/Downloads/x.srt"}' },
  })
  assert.ok(seen.description.includes('file=/Users/arming/Downloads/x.srt'), seen.description)
  assert.ok(seen.paths.includes('/Users/arming/Downloads/x.srt'))
})

test('无 allow_once 只有 allow_always 时放行选 allow_always', () => {
  const r = decidePermission({ autoGrant: 'all' }, {
    options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'reject_once', optionId: 'r1' }],
  })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'always' } })
})

test('allow-always（白名单命中）→ 优先选 allow_always 而非 allow_once', () => {
  const r = decidePermission({ permissionHandler: () => 'allow-always' }, { options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-allow-always' } })
})

test('allow-always 但服务端无 allow_always 选项 → 退回 allow_once', () => {
  const r = decidePermission({ permissionHandler: () => 'allow-always' }, {
    options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'r1' }],
  })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'once' } })
})

test('v0.4.3：opencode 系真实载荷（title=external_directory + locations）→ 显示类别与路径', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    sessionId: 'ses-x',
    options: opts(),
    toolCall: {
      kind: 'other',
      locations: [{ path: '/Users/arming/.dsh/AGENTS.md' }, { path: '/Users/arming/.dsh' }],
      rawInput: { filepath: '/Users/arming/.dsh/AGENTS.md', parentDir: '/Users/arming/.dsh' },
      status: 'pending',
      title: 'external_directory',
      toolCallId: 'chatcmpl-tool-x',
    },
  })
  assert.ok(seen.description.includes('访问外部目录'), seen.description)
  assert.ok(seen.description.includes('/Users/arming/.dsh/AGENTS.md'), seen.description)
  assert.ok(seen.description.includes('/Users/arming/.dsh'), seen.description)
})

test('v0.4.3：title=edit → 写入/修改文件', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    options: opts(),
    toolCall: { title: 'edit', locations: [{ path: '/tmp/a.txt' }] },
  })
  assert.ok(seen.description.includes('写入/修改文件'), seen.description)
})

test('v0.4.3：title=bash → 执行命令', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'allow' },
  }, {
    options: opts(),
    toolCall: { title: 'bash', locations: [{ path: '/bin/ls' }] },
  })
  assert.ok(seen.description.includes('执行命令'), seen.description)
})
