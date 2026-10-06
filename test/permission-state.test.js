import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  createPendingRegistry,
  createSessionRules,
  permissionCategoryKey,
  resolveToolName,
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

// ── v0.7.5：会话级工具名授权 ────────────────────────────────────────────────

describe('v0.7.6 会话级工具名授权（addToolGrant / toolGrantCovers）', () => {
  const noExpand = (p) => (Array.isArray(p) ? p : [])

  it('写入后命中：同一会话内同产品同名工具（不同路径）自动放行', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'Write'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'write'), true, '大小写不敏感')
  })

  it('不同路径的同名工具不再弹窗——这是本需求验收核心', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'bash')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), true)
  })

  it('未授权工具不命中——仍走原路径', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Write')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Read'), false, '未授权工具不得放行')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Edit'), false)
  })

  it('跨产品隔离：同一主代理会话下用户给 A 产品授权过，不应自动放行 B 产品同名工具（B2）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Bash')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'bash'), false, '跨产品不得放行')
    assert.equal(rules.toolGrantCovers('parent-1', 'deveco', 'Bash'), false)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), true, '同产品仍命中')
  })

  it('跨会话隔离：不同 parentSessionId 不互相放行', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Write')
    assert.equal(rules.toolGrantCovers('parent-2', 'qoder', 'Write'), false, '跨主代理会话不得放行')
    assert.equal(rules.toolGrantCovers(null, 'qoder', 'Write'), false)
  })

  it('toolName 缺失/空值不写入、不命中——绝不因缺字段而误放行', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', null), false)
    assert.equal(rules.addToolGrant('parent-1', 'qoder', undefined), false)
    assert.equal(rules.addToolGrant('parent-1', 'qoder', ''), false)
    assert.equal(rules.addToolGrant('parent-1', 'qoder', '   '), false)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', null), false)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', undefined), false)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', ''), false)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', '   '), false)
  })

  it('parentSessionId 缺失不写入', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant(null, 'qoder', 'Write'), false)
    assert.equal(rules.addToolGrant('', 'qoder', 'Write'), false)
  })

  it('product 缺失/空值不写入、不命中', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', null, 'Write'), false)
    assert.equal(rules.addToolGrant('parent-1', '', 'Write'), false)
    assert.equal(rules.addToolGrant('parent-1', '   ', 'Write'), false)
    assert.equal(rules.toolGrantCovers('parent-1', null, 'Write'), false)
    assert.equal(rules.toolGrantCovers('parent-1', '', 'Write'), false)
  })

  it('占位 toolName 不写入、不命中（B1：复用 UNINFORMATIVE_CATEGORY）', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'other'), false, '"other" 是占位值，不得写入')
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'unknown'), false, '"unknown" 是占位值')
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'default'), false, '"default" 是占位值')
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'misc'), false, '"misc" 是占位值')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'other'), false, '占位值查询也不得命中')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'unknown'), false)
  })

  it('归一化：trim + toLowerCase（product 和 toolName 双侧）', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', '  Qoder  ', '  Write  '), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'write'), true, '归一化后大小写不敏感')
    assert.equal(rules.toolGrantCovers('parent-1', '  QODER  ', '  WRITE  '), true, '查询侧也归一化')
  })

  it('幂等：重复写入不报错、不堆积', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'Write'), true)
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'Write'), false, '重复写入返回 false')
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'write'), false, '归一化后等同也返回 false')
  })

  it('会话销毁后工具名授权失效', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Write')
    rules.add('parent-1', ['/tmp/a'], null)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write'), true)
    rules.dispose('parent-1')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write'), false, '会话销毁后工具名授权必须失效')
    assert.equal(rules.cover('parent-1', ['/tmp/a'], null), false, '路径规则也必须失效')
  })

  it('dispose 返回值含工具授权计数（M3 修复）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Write')
    assert.equal(rules.dispose('parent-1'), 1, '只有工具授权时 removed 也应 =1')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write'), false)
  })

  it('dispose 不误伤其他会话的工具名授权', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.addToolGrant('parent-1', 'qoder', 'Write')
    rules.addToolGrant('parent-10', 'qoder', 'Read')
    rules.dispose('parent-1')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'Write'), false)
    assert.equal(rules.toolGrantCovers('parent-10', 'qoder', 'Read'), true, '前缀相近的会话不得被连带清理')
  })

  it('与路径/类别规则并存、互不干扰', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', [], 'qoder:web_search')
    rules.addToolGrant('parent-1', 'qoder', 'bash')
    assert.equal(rules.cover('parent-1', [], 'qoder:web_search'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'web_search'), false)
    assert.equal(rules.cover('parent-1', [], 'qoder:bash'), false)
  })

  it('addToolGrant 传空/undefined parentSessionId 不写入', () => {
    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant(null, 'qoder', 'Write'), false)
    assert.equal(rules.addToolGrant('', 'qoder', 'Write'), false)
    assert.equal(rules.addToolGrant(undefined, 'qoder', 'Write'), false)
    assert.equal(rules.toolGrantCovers(null, 'qoder', 'Write'), false)
    assert.equal(rules.toolGrantCovers('', 'qoder', 'Write'), false)
  })
})

// ── v0.7.8 终审 m-1 / m-2：resolveToolName 取值与来源同源、name 占位不吞真名 ──

describe('v0.7.8 resolveToolName 返回 {value, source}', () => {
  it('m-1：source 报告**真正命中**的分支，不是调用点反推', () => {
    assert.deepEqual(resolveToolName({ name: 'Write' }), { value: 'Write', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ toolName: 'Read' }), { value: 'Read', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ title: 'bash' }), { value: 'bash', source: 'title(TOOL_NAME_SLUGS)' })
    assert.equal(resolveToolName(null), null, 'null toolCall → L1 未命中')
    assert.equal(resolveToolName({}), null, '空 toolCall → L1 未命中')
    assert.equal(resolveToolName({ title: 'external_directory' }), null, '白名单外的 title 不参与 L1')
    assert.equal(resolveToolName({ title: 'doom_loop' }), null, '保护机制 slug 不参与 L1')
  })

  it('m-2：name 缺失/空白/占位时继续回退 toolName，不吞掉真工具名', () => {
    // 0.7.7 与 0.7.8 初版都是 `tool.name || tool.toolName`：name 是非空占位值或
    // 纯空白时会被当成"取到了值"，占位过滤后直接放弃，把 toolName 里的真名一起吞掉。
    assert.deepEqual(resolveToolName({ name: 'other', toolName: 'Write' }), { value: 'Write', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ name: '   ', toolName: 'Write' }), { value: 'Write', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ name: '', toolName: 'Write' }), { value: 'Write', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ name: 'unknown', toolName: 'default', title: 'edit' }), { value: 'edit', source: 'title(TOOL_NAME_SLUGS)' }, '两个名字字段都占位 → 才轮到 title')
  })

  it('m-2 不放宽占位过滤：全占位仍然是 null（不得把 other 当工具名）', () => {
    assert.equal(resolveToolName({ name: 'other', toolName: 'misc' }), null)
    assert.equal(resolveToolName({ name: 'default', toolName: 'unknown' }), null)
    assert.deepEqual(resolveToolName({ name: 'other', toolName: ' Read ' }), { value: 'Read', source: 'name/toolName' }, '回退到的 toolName 仍要 trim')
  })
})

// ── v0.7.8 终审 m-6：add() 无可用路径且归不出类别时必须给 reason ───────────────

describe('v0.7.8 m-6：add() 拒写时的 reason 不得留空', () => {
  it('路径全不可用（相对路径被生产 expand 滤掉）且无类别 → reason=no-usable-paths', () => {
    const rules = createSessionRules() // 生产 expand：非绝对路径会被丢弃
    const res = rules.add('parent-1', ['relative/only.txt', 'another/one.txt'], null)
    assert.equal(res.ok, false)
    assert.equal(res.kind, 'none')
    assert.equal(res.reason, 'no-usable-paths', '日志据此打印原因，缺了就是「（未知）」')
    assert.equal(rules.size('parent-1'), 0, '未写入任何规则')
  })

  it('执行类仍报 execution-class（既有 reason 不被覆盖）', () => {
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    const res = rules.add('parent-1', [], 'qoder:bash')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'execution-class')
  })
})

// ── v0.7.8 G-1：权限范围 slug 在 name / toolName / title 三个来源上无条件拒绝 ────

describe('v0.7.8 G-1：PERMISSION_SCOPE_SLUGS 三来源拒绝', () => {
  it('拒绝：external_directory 出现在任一来源都不得成为工具名', () => {
    assert.equal(resolveToolName({ toolName: 'external_directory' }), null, 'toolName 侧（终审实测入口）')
    assert.equal(resolveToolName({ name: 'other', toolName: 'external_directory' }), null, 'name 占位 + toolName 权限范围（终审复现载荷）')
    assert.equal(resolveToolName({ name: 'external_directory' }), null, 'name 侧')
    assert.equal(resolveToolName({ title: 'external_directory' }), null, 'title 侧回归：必须仍是 null')
    assert.equal(resolveToolName({ name: 'other', toolName: 'external_directory', title: 'external_directory' }), null, '三个字段同时塞')
  })

  it('拒绝：doom_loop（保护机制）同样三来源通拒', () => {
    assert.equal(resolveToolName({ title: 'doom_loop' }), null, 'title 侧回归')
    assert.equal(resolveToolName({ name: 'doom_loop' }), null, 'name 侧')
    assert.equal(resolveToolName({ toolName: 'doom_loop' }), null, 'toolName 侧')
  })

  it('拒绝匹配跨写法：大小写 / 分隔符 / 驼峰都要落同一键', () => {
    // permissionScopeKey 会剥掉分隔符与大小写，防止产品换个写法就绕过
    for (const variant of ['external_directory', 'EXTERNAL_DIRECTORY', 'External-Directory', 'external directory', 'ExternalDirectory', ' external_directory ']) {
      assert.equal(resolveToolName({ name: variant }), null, `name=${JSON.stringify(variant)} 必须被拒`)
      assert.equal(resolveToolName({ toolName: variant }), null, `toolName=${JSON.stringify(variant)} 必须被拒`)
      assert.equal(resolveToolName({ title: variant }), null, `title=${JSON.stringify(variant)} 必须被拒`)
    }
    for (const variant of ['doom_loop', 'DoomLoop', 'doom loop']) {
      assert.equal(resolveToolName({ name: variant }), null, `name=${JSON.stringify(variant)} 必须被拒`)
      assert.equal(resolveToolName({ title: variant }), null, `title=${JSON.stringify(variant)} 必须被拒`)
    }
  })

  it('放行锚点：具工具语义的值不得被拒绝集误伤（任一来源都可授权）', () => {
    assert.deepEqual(resolveToolName({ toolName: 'Write' }), { value: 'Write', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ name: 'other', toolName: 'bash' }), { value: 'bash', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ title: 'bash' }), { value: 'bash', source: 'title(TOOL_NAME_SLUGS)' })
    assert.deepEqual(resolveToolName({ name: 'webfetch' }), { value: 'webfetch', source: 'name/toolName' })
  })

  it('不误伤全量白名单：TOOL_NAME_SLUGS 每个成员在 name / toolName / title 三侧都仍可解析', () => {
    const TOOL_SEMANTIC = [
      'bash', 'shell', 'terminal', 'exec', 'execute', 'command',
      'run_command', 'runcommand', 'execute_command',
      'edit', 'write', 'read', 'webfetch', 'web_fetch', 'web_search',
    ]
    for (const slug of TOOL_SEMANTIC) {
      assert.deepEqual(resolveToolName({ name: slug }), { value: slug, source: 'name/toolName' }, `name=${slug} 必须仍可授权`)
      assert.deepEqual(resolveToolName({ toolName: slug }), { value: slug, source: 'name/toolName' }, `toolName=${slug} 必须仍可授权`)
      assert.deepEqual(resolveToolName({ title: slug }), { value: slug, source: 'title(TOOL_NAME_SLUGS)' }, `title=${slug} 必须仍可授权`)
    }
  })

  it('拒绝集是"只收紧不放宽"：权限范围值被拒后仍可回退到同载荷里的真工具名', () => {
    // name 是权限范围 → 跳过它继续看 toolName/title，不得因为 name 有值就直接放弃
    assert.deepEqual(resolveToolName({ name: 'external_directory', toolName: 'Read' }), { value: 'Read', source: 'name/toolName' })
    assert.deepEqual(resolveToolName({ name: 'external_directory', title: 'edit' }), { value: 'edit', source: 'title(TOOL_NAME_SLUGS)' })
  })
})

// ── v0.7.9：`_meta` 来源（qoder 把真工具名藏在 `_meta.qoder.toolName`）──────────
//
// 现场载荷逐字取自宿主终端 stdout（lib/bridges/acp.js:480 打印的 requestPermission
// toolCall 原文）：qoder 的 `title` 是**整条命令正文**，真实工具名只在
// `_meta.qoder.toolName`。0.7.8 及之前不读 `_meta` ⇒ resolveToolName 恒 null ⇒
// addToolGrant 从不被调用 ⇒「本会话总是允许」只落地路径级记忆、换路径就重复弹窗。

/** 用户贴回的现场载荷原文（第一条：ls -la …），逐字未改 */
const QODER_LIVE_PAYLOAD = {
  _meta: { qoder: { toolName: 'Bash' } },
  content: [{ content: { text: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin' }, type: 'content' }],
  kind: 'execute',
  rawInput: { command: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin', description: 'List files in the nvm node bin directory' },
  status: 'pending',
  title: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin',
  toolCallId: 'call_19e6d181e8be4bfb942073ce',
}

describe('v0.7.9 resolveToolName：_meta 来源', () => {
  it('现场载荷原文 ⇒ 解析出 Bash，source 标注 meta（此前返回 null，是本 bug 的根因）', () => {
    assert.deepEqual(
      resolveToolName(QODER_LIVE_PAYLOAD, 'qoder'),
      { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' },
      'title 是整条命令正文、不在白名单，只有 _meta 能给出工具名',
    )
    // 修复前该载荷确实解析不出（title 被 slugify 成命令正文，必然不在白名单）
    assert.equal(resolveToolName({ title: QODER_LIVE_PAYLOAD.title }, 'qoder'), null)
  })

  it('另两条同形态现场载荷（echo/grep 与 python3 heredoc）同样解析为 Bash', () => {
    const echoCmd = 'echo "=== dispatches.jsonl distinct kind values ===" ; grep -o \'"kind":"[^"]*"\' dispatches.jsonl | sort | uniq'
    const pyCmd = "python3 - <<'PY'\nimport json,sys\nfor line in sys.stdin: print(line.strip())\nPY"
    assert.deepEqual(resolveToolName({ _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: echoCmd, toolCallId: 'call_echo' }, 'qoder'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' })
    assert.deepEqual(resolveToolName({ _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', title: pyCmd, toolCallId: 'call_py' }, 'qoder'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' })
    assert.equal(resolveToolName({ title: echoCmd }, 'qoder'), null, '没有 _meta 时这两条仍解析不出（回到 L2/L3）')
  })

  it('取值顺序：name → toolName → _meta.<product>.toolName → _meta.toolName → title', () => {
    const meta = { qoder: { toolName: 'Bash' } }
    assert.deepEqual(resolveToolName({ name: 'Read', _meta: meta, title: 'bash' }, 'qoder'), { value: 'Read', source: 'name/toolName' }, 'name 最优先')
    assert.deepEqual(resolveToolName({ toolName: 'Write', _meta: meta }, 'qoder'), { value: 'Write', source: 'name/toolName' }, 'toolName 次之')
    assert.deepEqual(resolveToolName({ name: 'other', _meta: meta }, 'qoder'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' }, 'name 占位 → 轮到 _meta 命名空间')
    assert.deepEqual(
      resolveToolName({ _meta: { toolName: 'Read' }, title: 'bash' }, 'qoder'),
      { value: 'Read', source: '_meta(TOOL_NAME_SLUGS)' },
      '扁平 _meta.toolName 排在 title 之前',
    )
    assert.deepEqual(
      resolveToolName({ _meta: { qoder: { toolName: 'search_codebase' } }, title: 'bash' }, 'qoder'),
      { value: 'bash', source: 'title(TOOL_NAME_SLUGS)' },
      '命名空间值过不了白名单 → 继续回退到 title，不硬凑',
    )
  })

  it('命名空间按 product 定位：别的产品的 _meta 命名空间不供名（product 取法与调用点一致）', () => {
    const payload = { _meta: { qoder: { toolName: 'Bash' } }, title: 'ls -la /tmp' }
    assert.equal(resolveToolName(payload, 'opencode'), null, 'opencode 不得吃到 _meta.qoder')
    assert.deepEqual(resolveToolName(payload, ' Qoder '), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' }, 'product 与授权键同构（trim+toLowerCase）')
    assert.deepEqual(resolveToolName(payload, 'qoder-cli'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' }, '与 lib/index.js 白名单快速路径同一条 -cli 宽容')
    assert.equal(resolveToolName(payload), null, '省略 product 时命名空间那一跳跳过（扁平兜底仍可用）')
    assert.deepEqual(resolveToolName({ _meta: { toolName: 'Bash' } }, 'opencode'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' }, '扁平 _meta.toolName 与产品无关')
  })

  it('三重过滤一个都不能绕过：占位值（G-1/B1）与权限范围/保护机制 slug 在 _meta 侧同样拒绝', () => {
    for (const placeholder of ['other', 'unknown', 'default', 'misc', ' Other ']) {
      assert.equal(resolveToolName({ _meta: { qoder: { toolName: placeholder } }, title: 'ls' }, 'qoder'), null, `_meta 占位值 ${JSON.stringify(placeholder)} 不得当工具名`)
    }
    for (const scope of ['external_directory', 'EXTERNAL_DIRECTORY', 'External-Directory', 'external directory', 'ExternalDirectory', 'doom_loop', 'DoomLoop', 'doom loop']) {
      assert.equal(resolveToolName({ _meta: { qoder: { toolName: scope } } }, 'qoder'), null, `_meta 权限范围/保护机制 ${JSON.stringify(scope)} 必须被拒`)
      assert.equal(resolveToolName({ _meta: { toolName: scope } }, 'qoder'), null, `扁平 _meta 同样拒绝 ${JSON.stringify(scope)}`)
    }
    // 白名单收紧：不在 TOOL_NAME_SLUGS 里的名字（哪怕长得像工具）不参与 _meta 分支
    assert.equal(resolveToolName({ _meta: { qoder: { toolName: 'search_codebase' } }, title: 'rm -rf build' }, 'qoder'), null)
    assert.equal(resolveToolName({ _meta: { qoder: { toolName: 'apply_patch' } } }, 'qoder'), null)
  })

  it('_meta 里的真工具名过白名单时用归一化后的小写形态（与写入/命中侧 trim+toLowerCase 同构，不引入 slugify）', () => {
    const got = resolveToolName({ _meta: { qoder: { toolName: ' Bash ' } } }, 'qoder')
    assert.deepEqual(got, { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' }, '返回值保留原样大小写，归一化发生在授权键侧')
    const rules = createSessionRules({ expand: (p) => (Array.isArray(p) ? p : []) })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', got.value), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), true, 'Bash ⇒ 键 qoder:bash')
    assert.equal(rules.toolGrantCovers('parent-1', 'opencode', 'bash'), false, '键必须带产品前缀，跨产品不串号')
  })

  it('畸形 _meta 不抛异常、不放行：非对象、命名空间非对象、值缺失/非字符串/空白', () => {
    const broken = [
      { _meta: null },
      { _meta: undefined },
      { _meta: 'qoder' },
      { _meta: 42 },
      { _meta: true },
      { _meta: [] },
      { _meta: { qoder: null } },
      { _meta: { qoder: 'Bash' } },
      { _meta: { qoder: 7 } },
      { _meta: { qoder: {} } },
      { _meta: { qoder: { toolName: 42 } } },
      { _meta: { qoder: { toolName: '' } } },
      { _meta: { qoder: { toolName: '   ' } } },
      { _meta: { qoder: { toolName: null } } },
      { _meta: { qoder: { toolName: ['Bash'] } } },
      { _meta: { toolName: 42 } },
      { _meta: { toolName: ['Bash'] } },
      { _meta: { qoder: { toolName: 'Bash' } }, title: '   ' },
    ]
    for (const payload of broken.slice(0, broken.length - 1)) {
      assert.equal(resolveToolName({ ...payload, title: 'ls -la /tmp' }, 'qoder'), null, `${JSON.stringify(payload)} 必须解析不出且不抛异常`)
    }
    // 最后一条：_meta 有效但 title 空白 ⇒ 仍由 _meta 给出真名
    assert.deepEqual(resolveToolName(broken[broken.length - 1], 'qoder'), { value: 'Bash', source: '_meta(TOOL_NAME_SLUGS)' })
    // product 畸形也不得抛
    for (const badProduct of [null, undefined, 42, {}, []]) {
      assert.doesNotThrow(() => resolveToolName({ _meta: { qoder: { toolName: 'Bash' } } }, badProduct))
      assert.equal(resolveToolName({ _meta: { qoder: { toolName: 'Bash' } }, title: 'ls' }, badProduct), null)
    }
    assert.doesNotThrow(() => resolveToolName(Object.create({ _meta: { qoder: { toolName: 'Bash' } } }), 'qoder'))
  })

  it('原型链上的 toolName 不得被当成 _meta 取值', () => {
    const meta = Object.create({ toolName: 'Bash' })
    assert.equal(resolveToolName({ _meta: meta }, 'qoder'), null, '扁平 _meta.toolName 必须是自身属性')
    const ns = Object.create({ toolName: 'Bash' })
    assert.equal(resolveToolName({ _meta: { qoder: ns } }, 'qoder'), null, '命名空间值同理')
  })
})

// ── v0.7.9（复审 M-3）：legacy 出口的会话规则按 cwd 绑定，不跨 cwd 生效 ────────────
//
// 改动前：`sessionRules.add(sid, reqPaths, categoryKey)`（cwd 缺省 null ⇒ 通配）。
// 改动后：`add(sid, plan.paths, effectiveCategoryKey, bindCwd, {expand:true})`
// （`lib/index.js` 的 legacy 出口）⇒ 规则带上写入时的 child 工作目录。
// 用户裁定：**保留收紧后的行为**（与「规则按 cwd 作用域」的统一模型一致），
// 代价是同会话下另一 cwd 的同路径请求不再被覆盖、会多弹一次授权球；
// 该行为已写进 CHANGELOG 的「行为收紧」一节，此处把语义钉死。
describe('v0.7.9 复审 M-3：cwd 绑定的会话规则不跨 cwd 生效', () => {
  const noExpand = (p) => (Array.isArray(p) ? p : [])

  it('规则 cwd 与请求 cwd 不等 ⇒ 不覆盖；取不到请求 cwd ⇒ 同样不消费项目级规则', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', ['/proj/shared/x.txt'], null, '/proj')
    assert.equal(rules.evaluate('parent-1', { cwd: '/proj', paths: ['/proj/shared/x.txt'] }).allowed, true,
      '同一 cwd 内：规则照常命中')
    assert.equal(rules.evaluate('parent-1', { cwd: '/other', paths: ['/proj/shared/x.txt'] }).allowed, false,
      '同会话另一 cwd 的请求不得被 /proj 的规则覆盖（会多弹一次，这是刻意的收紧）')
    assert.equal(rules.evaluate('parent-1', { cwd: null, paths: ['/proj/shared/x.txt'] }).allowed, false,
      '请求 cwd 取不到时不得消费项目级规则（与落盘规则的「项目级隔离」同口径）')
    assert.equal(rules.evaluate('parent-1', { cwd: '/proj' }).allowed, false,
      '无路径请求同样受 cwd 约束')
  })

  it('对照：cwd=null（历史通配形状）仍覆盖任意 cwd，且工具名档同样要求 cwd 全等', () => {
    const wild = createSessionRules({ expand: noExpand })
    wild.add('parent-1', ['/proj/shared/x.txt'], null) // cwd 缺省 = null = 通配
    assert.equal(wild.evaluate('parent-1', { cwd: '/other', paths: ['/proj/shared/x.txt'] }).allowed, true,
      '0.7.9 之前写入的规则形状（cwd 缺失）语义不变')

    const rules = createSessionRules({ expand: noExpand })
    assert.equal(rules.addToolGrant('parent-1', 'qoder', 'bash', '/proj'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/proj'), true)
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash', '/other'), false,
      '工具名档与路径档共用同一个 cwd 全等判定')
    assert.equal(rules.toolGrantCovers('parent-1', 'qoder', 'bash'), false,
      '缺省 requestCwd=null 时不命中带 cwd 的授权（不误放行）')
  })

  it('同 cwd 幂等去重仍按 (cwd, paths, categories) 三元组（不因加 cwd 而重复堆规则）', () => {
    const rules = createSessionRules({ expand: noExpand })
    rules.add('parent-1', ['/proj/a.txt'], null, '/proj')
    rules.add('parent-1', ['/proj/a.txt'], null, '/proj')
    assert.equal(rules.size('parent-1'), 1)
    rules.add('parent-1', ['/proj/a.txt'], null, '/other')
    assert.equal(rules.size('parent-1'), 2, '不同 cwd 是两个作用域，各自留一条')
  })
})
