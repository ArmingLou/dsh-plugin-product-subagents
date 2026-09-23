import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  createPendingRegistry,
  createSessionRules,
  permissionCategoryKey,
} from '../lib/permission-state.js'
import { categoryRule, expandPathsWithParents, isCategoryRule } from '../lib/allowlist.js'

// ── A：挂起审批每请求一条 ────────────────────────────────────────────────────

describe('A 挂起审批登记表（每请求一条，不再 childId 单槽）', () => {
  it('同一 childId 并发 2 条：两条都能各自独立决议', () => {
    const reg = createPendingRegistry()
    const answers = []
    const r1 = new Promise((res) => reg.add('child-A', reg.nextPermId('tc-1'), res))
    const r2 = new Promise((res) => reg.add('child-A', reg.nextPermId('tc-2'), res))
    assert.equal(reg.size('child-A'), 2, '旧实现在这里只有 1（后到者覆盖前者）')

    reg.settle('child-A', 'tc-2#2', 'allow-once')
    assert.equal(reg.size('child-A'), 1)
    reg.settle('child-A', 'tc-1#1', 'deny')
    assert.equal(reg.size('child-A'), 0)

    return Promise.all([r1, r2]).then(([a, b]) => {
      answers.push(a, b)
      assert.deepEqual(answers.sort(), ['allow-once', 'deny'])
    })
  })

  it('决议一条不会把同 child 的其他挂起一起清空', async () => {
    const reg = createPendingRegistry()
    let settled2 = null
    const p1 = new Promise((res) => reg.add('child-A', 'perm-1', res))
    reg.add('child-A', 'perm-2', (v) => { settled2 = v })
    reg.settle('child-A', 'perm-1', 'allow-once')
    await p1
    assert.equal(reg.has('child-A'), true, 'perm-2 必须仍然挂起')
    assert.deepEqual(reg.list('child-A'), ['perm-2'])
    assert.equal(settled2, null, '不能被连带兑现')
  })

  it('老 payload 无 permId → FIFO 降级摘最早一条（不静默丢请求）', async () => {
    const reg = createPendingRegistry()
    const got = []
    reg.add('child-A', 'perm-1', (v) => got.push(['first', v]))
    reg.add('child-A', 'perm-2', (v) => got.push(['second', v]))
    reg.settle('child-A', undefined, 'allow-once')
    reg.settle('child-A', '', 'deny')
    assert.deepEqual(got, [['first', 'allow-once'], ['second', 'deny']])
    assert.equal(reg.has('child-A'), false)
  })

  it('未知 permId → **忽略**（绝不代替决议别的请求）；无挂起时返回 null', () => {
    // v0.6.2(M3)：旧实现在这里降级 FIFO，把用户对 A 的「总是允许」记到 B 上——
    // 客户端按钮态每次轮询重建，重复点击必然带着旧 permId 落到别的请求。
    const reg = createPendingRegistry()
    let hit = null
    reg.add('child-A', 'real', (v) => { hit = v })
    assert.equal(reg.settle('child-A', 'not-exist', 'allow-always'), null, 'permId 不命中必须整条忽略')
    assert.equal(hit, null, '未被命中的请求不得被兑现')
    assert.equal(reg.has('child-A'), true, '被忽略的决策不得顺手摘走登记')
    assert.equal(reg.settle('child-A', 'anything', 'deny'), null)
    assert.equal(hit, null)
    assert.equal(reg.take('other-child'), null)
  })

  it('弹窗通道先答：clearChild 只作废该 child，别的 child 不受影响', () => {
    const reg = createPendingRegistry()
    reg.add('child-A', 'a1', () => {})
    reg.add('child-A', 'a2', () => {})
    reg.add('child-B', 'b1', () => {})
    assert.deepEqual(reg.clearChild('child-A').sort(), ['a1', 'a2'])
    assert.equal(reg.has('child-A'), false)
    assert.equal(reg.has('child-B'), true)
  })

  it('permId 生成唯一且带 toolCallId 前缀（同一 toolCall 重复询问可对齐）', () => {
    const reg = createPendingRegistry()
    const ids = [reg.nextPermId('chatcmpl-tool-x'), reg.nextPermId('chatcmpl-tool-x'), reg.nextPermId(null)]
    assert.equal(new Set(ids).size, 3)
    assert.match(ids[0], /^chatcmpl-tool-x#\d+$/)
    assert.match(ids[2], /^perm#\d+$/)
  })

  it('childId 数字/字符串混用不串桶', () => {
    const reg = createPendingRegistry()
    reg.add(7, 'p', () => {})
    assert.equal(reg.has('7'), true)
    assert.equal(reg.take('7', 'nope'), null, 'permId 不命中 → 不顶替（M3）')
    assert.deepEqual(reg.take('7', undefined).permId, 'p', 'permId 缺省 → FIFO')
  })
})

// ── D：会话期「总是允许」对无路径请求生效 ───────────────────────────────────

describe('D 会话期授权（无路径请求落类别指纹，不再写空规则）', () => {
  const noExpand = (p) => (Array.isArray(p) ? p : [])

  it('无路径 + 无类别 → 拒绝写入（旧实现写 []，读侧永不命中＝点了等于没点）', () => {
    const rules = createSessionRules({ expand: noExpand })
    const res = rules.add('parent-1', [], null)
    assert.equal(res.ok, false)
    assert.equal(rules.size('parent-1'), 0)
    assert.equal(rules.cover('parent-1', [], null), false)
  })

  it('无路径请求：点「会话内允许」后，第二次同类请求不再弹窗', () => {
    const rules = createSessionRules({ expand: noExpand })
    const key = permissionCategoryKey({ title: 'web_search' }, 'qoder', 'Allow searching the web?')
    assert.equal(key, 'qoder:web_search')
    const res = rules.add('parent-1', [], key)
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'category')
    assert.deepEqual(res.rule, ['cat:qoder:web_search'])
    // 第二次同类请求
    assert.equal(rules.cover('parent-1', [], key), true)
  })

  it('类别作用域隔离：不同产品 / 不同主代理会话 / 不同类别都不命中', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [], 'qoder:web_search')
    assert.equal(rules.cover('parent-1', [], 'deveco:web_search'), false, '跨产品不得放行')
    assert.equal(rules.cover('parent-1', [], 'qoder:bash'), false, '跨类别不得放行')
    assert.equal(rules.cover('parent-2', [], 'qoder:web_search'), false, '跨主代理会话不得放行')
    assert.equal(rules.cover(null, [], 'qoder:web_search'), false)
  })

  it('带路径请求不被类别规则绕过（分类规则只在无路径时参与判定）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [], 'qoder:web_search')
    assert.equal(rules.cover('parent-1', ['/etc/passwd'], 'qoder:web_search'), false)
  })

  // v0.6.2(m5)：执行类无路径请求 = 不可记忆
  it('执行类类别（bash/exec/shell）拒绝写会话规则 → 退回仅本次', () => {
    const rules = createSessionRules({ expand: noExpand })
    for (const key of ['qoder:bash', 'deveco:execute', 'qoder:run_command', 'QODER:SHELL']) {
      const res = rules.add('parent-1', [], key)
      assert.equal(res.ok, false, `${key} 不得被记住`)
      assert.equal(res.reason, 'execution-class', `${key} 需给出可区分的拒写原因`)
      assert.equal(rules.size('parent-1'), 0)
      assert.equal(rules.cover('parent-1', [], key), false)
    }
  })

  it('执行类判定不误伤：edit/read/external_directory 仍可记忆，路径授权不受影响', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.add('parent-1', [], 'qoder:edit').ok, true)
    assert.equal(rules.add('parent-1', [], 'qoder:external_directory').ok, true)
    assert.equal(rules.add('parent-1', ['/tmp/x'], 'qoder:bash').ok, true, '有真实路径时仍是路径记忆，与执行类无关')
  })

  it('带路径授权仍按路径命中；未覆盖的路径不放行', () => {
    // 注：fixture 故意不用 `~/.dsh` 这类目录——pathAllowed 的"无扩展名才算目录前缀"
    // 判定会把 `.dsh` 当成带扩展名的文件（本模块之外的既有行为，本次不改）。
    const dir = path.join(os.homedir(), 'dsh-fixtures')
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [dir], 'qoder:edit')
    assert.equal(rules.cover('parent-1', [path.join(dir, 'AGENTS.md')], 'qoder:edit'), true)
    assert.equal(rules.cover('parent-1', ['/etc/hosts'], 'qoder:edit'), false)
  })

  it('写入侧补父目录（与蓝球 host-approval 规则粒度对齐）', () => {
    const file = path.join(os.homedir(), '.dsh', 'AGENTS.md')
    const rules = createSessionRules() // 默认 expand = expandPathsWithParents
    const res = rules.add('parent-1', [file], null)
    assert.deepEqual([...res.rule].sort(), [file, path.join(os.homedir(), '.dsh')].sort(), res.rule)
    // 只请求父目录（external_directory 形态）也能命中——旧实现会重复弹窗
    assert.equal(rules.cover('parent-1', [path.join(os.homedir(), '.dsh')], null), true)
  })

  it('重复授权幂等（不堆积规则）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [], 'qoder:web_search')
    rules.add('parent-1', [], 'qoder:web_search')
    assert.equal(rules.size('parent-1'), 1)
  })

  it('会话销毁清理键与写入键同构（旧实现写 `sid`、清 `sid::`，永不清理）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [], 'qoder:web_search')
    rules.add('parent-1', ['/tmp/a'], null)
    assert.equal(rules.size('parent-1'), 2)
    assert.equal(rules.dispose('parent-1'), 1, '返回值是清掉的会话键数')
    assert.equal(rules.cover('parent-1', [], 'qoder:web_search'), false)
    assert.equal(rules.cover('parent-1', ['/tmp/a'], null), false)
    assert.equal(rules.size('parent-1'), 0)
  })

  it('dispose 不误伤其他会话，且兼容 `${sid}::xxx` 变体键', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', ['/tmp/a'], null)
    rules.add('parent-10', ['/tmp/b'], null)
    rules.add('parent-1::thread-2', ['/tmp/c'], null)
    assert.equal(rules.dispose('parent-1'), 2)
    assert.equal(rules.size('parent-10'), 1, '前缀相近的会话不得被连带清理')
  })

  it('dispose 空 id 不动表', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', ['/tmp/a'], null)
    assert.equal(rules.dispose(null), 0)
    assert.equal(rules.size('parent-1'), 1)
  })
})

// ── 类别归一化 ───────────────────────────────────────────────────────────────

describe('D 权限类别指纹归一化', () => {
  it('title 优先（opencode 系 kind 常为无信息量的 other）', () => {
    assert.equal(permissionCategoryKey({ kind: 'other', title: 'external_directory' }, 'deveco'), 'deveco:external_directory')
    assert.equal(permissionCategoryKey({ kind: 'other', title: 'bash' }, 'deveco'), 'deveco:bash')
    assert.equal(permissionCategoryKey({ kind: 'other', title: 'edit' }, 'deveco'), 'deveco:edit')
  })

  it('kind 兜底；title/kind 都无信息量时退 name，再退描述关键词', () => {
    assert.equal(permissionCategoryKey({ kind: 'read' }, 'deveco'), 'deveco:read')
    assert.equal(permissionCategoryKey({ name: 'WebSearch' }, 'qoder'), 'qoder:websearch')
    assert.equal(permissionCategoryKey(null, 'qoder', 'Allow searching the web?'), 'qoder:web_search')
    assert.equal(permissionCategoryKey({}, 'qoder', '发起网络请求 https://example.com'), 'qoder:web_fetch')
    assert.equal(permissionCategoryKey({}, 'qoder', '执行命令 npm test'), 'qoder:bash')
  })

  it('归不出类别时返回 null（调用方据此拒绝写规则，不虚报已记住）', () => {
    assert.equal(permissionCategoryKey({ kind: 'other', title: 'other' }, 'qoder', '做点什么'), null)
    assert.equal(permissionCategoryKey(null, null, null), null)
  })

  it('归一化产物只含安全字符（可安全作为规则键）', () => {
    const key = permissionCategoryKey({ title: 'Bad/../Name' }, 'pro duct')
    assert.equal(key, 'pro_duct:bad_.._name')
    assert.ok(categoryRule(key))
  })

  it('categoryRule / isCategoryRule 形状', () => {
    assert.equal(categoryRule('qoder:web_search'), 'cat:qoder:web_search')
    assert.equal(categoryRule('  '), null)
    assert.equal(categoryRule('bad; rm -rf'), null)
    assert.equal(isCategoryRule('cat:a:b'), true)
    assert.equal(isCategoryRule('/Users/x'), false)
  })

  it('expandPathsWithParents：文件补父目录、目录不补、相对路径丢弃', () => {
    const home = os.homedir()
    const out = expandPathsWithParents([path.join(home, '.dsh'), `${path.join(home, '.dsh')}/AGENTS.md`, 'relative/x'])
    assert.ok(out.includes(path.join(home, '.dsh')), out.join(','))
    assert.ok(out.some((p) => p.endsWith('AGENTS.md')), out.join(','))
    assert.equal(out.filter((p) => p.includes('relative')).length, 0)
  })
})
