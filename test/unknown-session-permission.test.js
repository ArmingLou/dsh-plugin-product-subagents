import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePermission } from '../lib/bridges/acp.js'

function opts() {
  return [
    { kind: 'allow_once', name: '允许一次', optionId: 'opt-allow-once' },
    { kind: 'allow_always', name: '总是允许', optionId: 'opt-allow-always' },
    { kind: 'reject_once', name: '拒绝一次', optionId: 'opt-reject-once' },
    { kind: 'reject_always', name: '总是拒绝', optionId: 'opt-reject-always' },
  ]
}

test('permissionHandler 返回 deny → decidePermission 映射为 reject_once', () => {
  const r = decidePermission({
    product: 'deveco',
    permissionHandler: () => 'deny',
  }, { sessionId: 'unknown-ses', options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('permissionHandler 无 binding 仍返回 deny（fail-closed）', () => {
  let handlerCalled = false
  const r = decidePermission({
    product: 'deveco',
    permissionHandler: () => { handlerCalled = true; return 'deny' },
  }, { sessionId: 'missing-session-id', options: opts() })
  assert.equal(handlerCalled, true)
  assert.equal(r.outcome.outcome, 'selected')
  assert.equal(r.outcome.optionId, 'opt-reject-once')
})

test('permissionHandler 异步 deny → 仍 fail-closed', async () => {
  const r = await decidePermission({
    product: 'deveco',
    permissionHandler: async () => 'deny',
  }, { sessionId: 'unknown-ses', options: opts() })
  assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'opt-reject-once' } })
})

test('permissionHandler 收到 sessionId/paths 供诊断', () => {
  let seen = null
  decidePermission({
    product: 'deveco',
    permissionHandler: (payload) => { seen = payload; return 'deny' },
  }, {
    sessionId: 'ses-mismatch-123',
    options: opts(),
    toolCall: { name: 'read_file', arguments: { path: '/etc/hosts' } },
  })
  assert.equal(seen.sessionId, 'ses-mismatch-123')
  assert.ok(seen.paths.includes('/etc/hosts'))
  assert.equal(seen.product, 'deveco')
})

import { createUnknownSessionTracker } from '../lib/unknown-session-tracker.js'

test('熔断场景：模拟 permissionHandler 对未知会话连续 deny + tracker 检测', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  const handlerResults = []
  for (let i = 0; i < 5; i++) {
    const trackerResult = tracker.check('deveco', 'ses-stale-xyz')
    handlerResults.push(trackerResult)
    decidePermission({
      product: 'deveco',
      permissionHandler: () => 'deny',
    }, { sessionId: 'ses-stale-xyz', options: opts() })
  }
  assert.equal(handlerResults[0].escalated, false, '第1次不熔断')
  assert.equal(handlerResults[1].escalated, false, '第2次不熔断')
  assert.equal(handlerResults[2].escalated, true, '第3次触发熔断')
  assert.equal(handlerResults[4].escalated, true, '第5次仍熔断')
  assert.equal(handlerResults[4].count, 5)
})
