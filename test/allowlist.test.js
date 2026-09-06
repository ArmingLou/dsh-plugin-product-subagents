import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPaths } from '../lib/bridges/acp.js'
import { normalizeCandidate, pathAllowed, allowlistDecision } from '../lib/allowlist.js'

// ── extractPaths ──
test('extractPaths: arguments 对象里的 path/file 字段', () => {
  const toolCall = {
    name: 'read_file',
    arguments: { path: '/Users/arming/.dsh/AGENTS.md', lines: 10 },
  }
  assert.deepEqual(extractPaths(toolCall), ['/Users/arming/.dsh/AGENTS.md'])
})

test('extractPaths: 嵌套 arguments 与 content 文本', () => {
  const toolCall = {
    name: 'shell',
    content: [{ type: 'text', text: 'cat ~/.dsh/settings.yaml 的内容' }],
    arguments: { command: 'cat ~/.dsh/settings.yaml' },
  }
  const paths = extractPaths(toolCall)
  assert.ok(paths.length > 0 && paths.some((p) => p.includes('settings.yaml')))
})

test('extractPaths: 无路径返回空数组', () => {
  assert.deepEqual(extractPaths({ name: 'noop' }), [])
  assert.deepEqual(extractPaths(null), [])
})

// ── normalizeCandidate ──
test('normalizeCandidate: ~ 展开', () => {
  const p = normalizeCandidate('~/.dsh/AGENTS.md')
  assert.ok(p.startsWith('/') && p.endsWith('.dsh/AGENTS.md'))
})
test('normalizeCandidate: 去尾部标点', () => {
  assert.equal(normalizeCandidate('/tmp/a.txt,'), '/tmp/a.txt')
  assert.equal(normalizeCandidate('"/tmp/a.txt"'), '/tmp/a.txt')
})

// ── pathAllowed ──
const RULES = ['~/.dsh/**', '/Users/arming/.nvm/**', '/tmp/data/', '/etc/hosts']
test('pathAllowed: 目录前缀 ** 命中子路径', () => {
  assert.equal(pathAllowed('/Users/arming/.dsh/AGENTS.md', RULES), true)
  assert.equal(pathAllowed('/Users/arming/.dsh/settings.yaml', RULES), true)
})
test('pathAllowed: 目录前缀边界（不命中兄弟前缀）', () => {
  assert.equal(pathAllowed('/Users/arming/.nvmrc', RULES), false)
  assert.equal(pathAllowed('/Users/arming/.dshell/x', RULES), false)
})
test('pathAllowed: 无通配目录规则宽容命中', () => {
  assert.equal(pathAllowed('/tmp/data/x/y.txt', RULES), true)
  assert.equal(pathAllowed('/tmp/data', RULES), true)
})
test('pathAllowed: 精确文件规则', () => {
  assert.equal(pathAllowed('/etc/hosts', RULES), true)
  assert.equal(pathAllowed('/etc/hostname', RULES), false)
})
test('pathAllowed: 无关路径 false', () => {
  assert.equal(pathAllowed('/Users/arming/other/x.txt', RULES), false)
})

// ── allowlistDecision ──
test('allowlistDecision: 全部命中 → allowed', () => {
  const r = allowlistDecision(['/Users/arming/.dsh/AGENTS.md', '/Users/arming/.dsh/settings.yaml'], RULES)
  assert.equal(r.allowed, true)
  assert.equal(r.covered.length, 2)
  assert.equal(r.uncovered.length, 0)
})
test('allowlistDecision: 部分命中 → 不自动放行（转交互）', () => {
  const r = allowlistDecision(['/Users/arming/.dsh/AGENTS.md', '/Users/arming/secret.txt'], RULES)
  assert.equal(r.allowed, false)
  assert.deepEqual(r.uncovered, ['/Users/arming/secret.txt'])
})
test('allowlistDecision: 无路径 → 不自动放行', () => {
  assert.equal(allowlistDecision([], RULES).allowed, false)
})
test('allowlistDecision: 无规则 → 不自动放行', () => {
  assert.equal(allowlistDecision(['/x'], undefined).allowed, false)
  assert.equal(allowlistDecision(['/x'], []).allowed, false)
})
