import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionEvents, childActivity } from '../lib/host-compat.js'
import { foldProgress, foldTrace, foldTokenUsage } from '../lib/progress.js'
import { recoverRemoteSessionId } from '../lib/bindings.js'

function events(list) {
  return list.map((e, i) => ({ seq: i + 1, ...e }))
}

function sessionLog() {
  const now = Date.now()
  return events([
    { type: 'turn/start', timestamp: now - 60000, payload: { turn: 1 } },
    { type: 'step/start', timestamp: now - 59000, payload: { turn: 1, step: 1 } },
    { type: 'tool/call', timestamp: now - 58000, payload: { name: 'product_submit', args: { task: 'do thing A' } } },
    { type: 'assistant/message', timestamp: now - 50000, payload: { message: { content: [{ type: 'text', text: 'PROBE_CONT\nPRODUCT_SESSION:acp:sess-123' }], usage: { input_tokens: 4, output_tokens: 2 } } } },
    { type: 'turn/end', timestamp: now - 49000, payload: { turn: 1 } },
  ])
}

test('sessionEvents: prefers the 0.2 snapshotEvents() reader', () => {
  const list = sessionLog()
  let calls = 0
  const session = {
    snapshotEvents() { calls += 1; return list },
    get events() { throw new Error('legacy reader must not be consulted when snapshotEvents exists') },
  }
  assert.deepEqual(sessionEvents(session), list)
  assert.equal(calls, 1)
})

test('sessionEvents: falls back to the legacy events getter (0.1.x host)', () => {
  const list = sessionLog()
  assert.deepEqual(sessionEvents({ events: list }), list)
})

test('sessionEvents: tolerates throwing, non-array, and missing readers', () => {
  const list = sessionLog()
  assert.deepEqual(sessionEvents({ snapshotEvents() { throw new Error('boom') }, events: list }), list)
  assert.deepEqual(sessionEvents({ snapshotEvents: () => 'nope', events: list }), list)
  assert.equal(sessionEvents({ snapshotEvents: () => undefined }), undefined)
  assert.equal(sessionEvents({}), undefined)
  assert.equal(sessionEvents(null), undefined)
  assert.equal(sessionEvents(undefined), undefined)
})

test('childActivity: mirrors the host residency rule (sessions.get)', () => {
  const live = { get: (id) => (id === 'child-a' ? { id: 'child-a' } : undefined) }
  assert.equal(childActivity(live, 'child-a'), 'running')
  assert.equal(childActivity(live, 'child-b'), 'inactive')
  assert.equal(childActivity(undefined, 'child-a'), 'unknown')
  assert.equal(childActivity({}, 'child-a'), 'unknown')
  assert.equal(childActivity(live, undefined), 'unknown')
  assert.equal(childActivity({ get() { throw new Error('boom') } }, 'child-a'), 'unknown')
})

test('recovery chain: a 0.2 session (snapshotEvents only) still yields the marker', () => {
  const session = { snapshotEvents: () => sessionLog() }
  assert.deepEqual(recoverRemoteSessionId(session), { product: 'acp', sessionId: 'sess-123' })
})

test('progress folds: work off the 0.2 snapshotEvents() reader', () => {
  const session = { snapshotEvents: () => sessionLog() }
  const out = foldProgress(session)
  assert.equal(out.turn, 1)
  assert.equal(out.stepCount, 1)
  assert.equal(out.lastTask, 'do thing A')
  assert.match(out.lastAnswer, /PROBE_CONT/)
  assert.equal(out.product, 'acp')
  assert.equal(out.remoteSessionId, 'sess-123')
  assert.equal(foldTrace(session, 10).length, 5)
  assert.deepEqual(foldTokenUsage(session), { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 0 })
})

test('progress folds still accept the legacy 0.1.x session shape', () => {
  const session = { events: sessionLog() }
  assert.equal(foldProgress(session).remoteSessionId, 'sess-123')
  assert.equal(foldTrace(session, 10).length, 5)
  assert.equal(foldTokenUsage(session).inputTokens, 4)
})
