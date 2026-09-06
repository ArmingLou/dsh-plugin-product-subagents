import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUnknownSessionTracker } from '../lib/unknown-session-tracker.js'

test('首次未知会话 → count=1, 不触发熔断', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 1)
  assert.equal(r.escalated, false)
})

test('同一 (product, sessionId) 连续 2 次 → count=2, 不触发熔断', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  tracker.check('deveco', 'ses-abc')
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 2)
  assert.equal(r.escalated, false)
})

test('同一 (product, sessionId) 连续 3 次 → count=3, 触发熔断', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  tracker.check('deveco', 'ses-abc')
  tracker.check('deveco', 'ses-abc')
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 3)
  assert.equal(r.escalated, true)
})

test('不同 (product, sessionId) 独立计数', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  tracker.check('deveco', 'ses-abc')
  tracker.check('deveco', 'ses-abc')
  const r = tracker.check('opencode', 'ses-xyz')
  assert.equal(r.count, 1)
  assert.equal(r.escalated, false)
})

test('窗口过期后计数重置', async () => {
  const tracker = createUnknownSessionTracker({ windowMs: 10, threshold: 3 })
  tracker.check('deveco', 'ses-abc')
  tracker.check('deveco', 'ses-abc')
  await new Promise(resolve => setTimeout(resolve, 30))
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 1)
  assert.equal(r.escalated, false)
})

test('deleteEntry 清除对应条目', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3 })
  tracker.check('deveco', 'ses-abc')
  tracker.deleteEntry('deveco', 'ses-abc')
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 1)
})

test('maxEntries 超限时清理最旧条目', () => {
  const tracker = createUnknownSessionTracker({ windowMs: 30000, threshold: 3, maxEntries: 3 })
  tracker.check('prod-a', 'ses-1')
  tracker.check('prod-b', 'ses-2')
  tracker.check('prod-c', 'ses-3')
  assert.equal(tracker.check('prod-a', 'ses-1').count, 2, 'prod-a|ses-1 被 check 续期，不算最旧')
  tracker.check('prod-d', 'ses-4')
  const r = tracker.check('prod-b', 'ses-2')
  assert.equal(r.count, 2, 'prod-b|ses-2 仍在（prod-a 被续期，prod-c 是最旧被淘汰）')
})

test('默认参数：windowMs=30000, threshold=3, maxEntries=100', () => {
  const tracker = createUnknownSessionTracker()
  let r
  for (let i = 0; i < 3; i++) r = tracker.check('p', 's')
  assert.equal(r.count, 3)
  assert.equal(r.escalated, true)
})

test('threshold=1 时首次即触发熔断', () => {
  const tracker = createUnknownSessionTracker({ threshold: 1 })
  const r = tracker.check('deveco', 'ses-abc')
  assert.equal(r.count, 1)
  assert.equal(r.escalated, true)
})
