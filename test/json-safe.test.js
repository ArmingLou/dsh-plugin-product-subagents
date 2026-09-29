import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSafe } from '../lib/json-safe.js'

/** The host's rule, encoded host-free: a JSON round trip must not lose data. */
const roundTrip = (value) => JSON.parse(JSON.stringify(value))

test('jsonSafe: drops undefined-valued properties, top level and nested', () => {
  assert.deepEqual(jsonSafe({ a: undefined, b: 1 }), { b: 1 })
  assert.deepEqual(jsonSafe({ a: { b: undefined, c: { d: undefined, e: 2 } } }), { a: { c: { e: 2 } } })
  assert.deepEqual(jsonSafe({ a: undefined }), {})
})

test('jsonSafe: keeps every other JSON scalar (null, false, 0, empty string)', () => {
  assert.deepEqual(jsonSafe({ a: null, b: false, c: 0, d: '', e: undefined }), { a: null, b: false, c: 0, d: '' })
})

test('jsonSafe: undefined array entries become null so indices stay stable', () => {
  assert.deepEqual(jsonSafe({ list: [1, undefined, 3] }), { list: [1, null, 3] })
  assert.deepEqual(jsonSafe([{ a: undefined, b: 2 }]), [{ b: 2 }])
})

test('jsonSafe: output survives a JSON round trip unchanged (the host contract)', () => {
  const value = {
    childId: 'abc',
    product: undefined,
    nested: { label: undefined, mode: 'continuable', trace: [1, undefined] },
    list: [{ keep: 1, drop: undefined }, undefined],
  }
  const safe = jsonSafe(value)
  assert.deepEqual(safe, roundTrip(safe))
  assert.deepEqual(safe, {
    childId: 'abc',
    nested: { mode: 'continuable', trace: [1, null] },
    list: [{ keep: 1 }, null],
  })
})

test('jsonSafe: primitives and non-plain values pass through untouched', () => {
  assert.equal(jsonSafe('x'), 'x')
  assert.equal(jsonSafe(undefined), undefined)
  assert.equal(jsonSafe(null), null)
  const date = new Date(0)
  assert.equal(jsonSafe({ at: date }).at, date)
})
