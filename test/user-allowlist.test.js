import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendUserRule, readUserAllowlist, userRulesCover } from '../lib/user-allowlist.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ual-'))
const file = path.join(tmp, 'allowlist.json')

test('appendUserRule: 写入 cwd 作用域规则并可读回', () => {
  const r = appendUserRule({ cwd: '/proj/A', product: 'deveco', paths: ['/Users/x/.dsh/AGENTS.md', '/Users/x/.dsh'] }, tmp)
  assert.equal(r.ok, true)
  assert.ok(existsSync(file))
  const rules = readUserAllowlist(tmp)
  assert.equal(rules.length, 1)
  assert.equal(rules[0].cwd, '/proj/A')
  assert.equal(rules[0].product, 'deveco')
})

test('appendUserRule: 幂等——同 (cwd, paths) 不重复', () => {
  appendUserRule({ cwd: '/proj/A', product: 'deveco', paths: ['/Users/x/.dsh/AGENTS.md', '/Users/x/.dsh'] }, tmp)
  const rules = readUserAllowlist(tmp)
  assert.equal(rules.length, 1)
})

test('userRulesCover: 同 cwd 命中', () => {
  const rules = readUserAllowlist(tmp)
  assert.equal(userRulesCover(rules, '/proj/A', ['/Users/x/.dsh/AGENTS.md', '/Users/x/.dsh']), true)
})

test('userRulesCover: 不同 cwd 不命中（项目级隔离）', () => {
  const rules = readUserAllowlist(tmp)
  assert.equal(userRulesCover(rules, '/proj/B', ['/Users/x/.dsh/AGENTS.md']), false)
  assert.equal(userRulesCover(rules, '/proj/B', ['/Users/x/.dsh/AGENTS.md', '/Users/x/.dsh']), false)
})

test('userRulesCover: 无 cwd/无路径 → false', () => {
  const rules = readUserAllowlist(tmp)
  assert.equal(userRulesCover(rules, null, ['/Users/x/.dsh/AGENTS.md']), false)
  assert.equal(userRulesCover(rules, '/proj/A', []), false)
  assert.equal(userRulesCover(rules, '/proj/A', undefined), false)
})

test('userRulesCover: 混合越权（部分在白名单内）不命中', () => {
  const r = appendUserRule({ cwd: '/proj/C', paths: ['/safe/**'] }, tmp)
  assert.equal(r.ok, true)
  const rules = readUserAllowlist(tmp)
  assert.equal(userRulesCover(rules, '/proj/C', ['/safe/a', '/unsafe/b']), false)
})

test('appendUserRule: 缺 cwd 或 paths → ok:false', () => {
  assert.equal(appendUserRule({ paths: ['/x'] }, tmp).ok, false)
  assert.equal(appendUserRule({ cwd: '/p' }, tmp).ok, false)
})

rmSync(tmp, { recursive: true, force: true })
