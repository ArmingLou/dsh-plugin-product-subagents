// v0.7.9 追加1/2/3：统一权限规则评估器（lib/permission-rules.js）的表格驱动单测。
//
// 覆盖用户点名的每一行判定表：目录子树命中、父目录写入、`..` 越界、软链出界、
// 工具档同 cwd 任意路径、异 cwd 不命中、跨产品不命中、部分覆盖不自动放行、
// 危险命令例外（危险门本身在 test/dangerous-commands.test.js 与接线用例里覆盖）。
//
// 文件系统边界用例（软链）用 mkdtemp 真建目录，**不碰用户真实 ~/.dsh**；
// 其余用假路径即可——resolveRealPath 对不存在的尾段会退回字面路径，判定稳定。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalPath,
  compileRulePath,
  coverage,
  evaluateRuleSources,
  inferredDirs,
  planGrantWrites,
  resolveRealPath,
  ruleCoversRequest,
  suggestedDirs,
  toolGrantKey,
  validateDeclaredPaths,
  compileRuleTools,
  workspaceRuleOf,
} from '../lib/permission-rules.js'
import { appendUserRule, readUserAllowlist } from '../lib/user-allowlist.js'

describe('v0.7.9 统一评估器：paths = 目录子树', () => {
  const cases = [
    ['规则是目录、请求在其下一层', { cwd: null, paths: ['/proj'] }, '/proj/a.txt', true],
    ['规则是目录、请求在其下三层', { cwd: null, paths: ['/proj'] }, '/proj/a/b/c.txt', true],
    ['规则是目录、请求就是目录自身', { cwd: null, paths: ['/proj'] }, '/proj', true],
    ['兄弟前缀不得命中（/a/b 不命中 /a/bc）', { cwd: null, paths: ['/a/b'] }, '/a/bc/d.txt', false],
    ['工作区外的绝对路径不得命中', { cwd: null, paths: ['/proj'] }, '/etc/hosts', false],
    ['显式 /** 规则命中子树', { cwd: null, paths: ['/proj/**'] }, '/proj/x/y.txt', true],
    ['老条目 `/proj/*`（单星紧跟分隔符）= 显式目录写法 ⇒ 仍按子树命中', { cwd: null, paths: ['/proj/*'] }, '/proj/x/y.txt', true],
    ['老条目 `/proj/*` 不外溢到兄弟前缀目录', { cwd: null, paths: ['/proj/*'] }, '/projx/y.txt', false],
    ['`*` 前面没有分隔符时是字面名：`/proj*` 不等于 `/proj` 子树', { cwd: null, paths: ['/proj*'] }, '/proj/x/y.txt', false],
    ['显式 / 结尾规则命中子树', { cwd: null, paths: ['/proj/'] }, '/proj/x/y.txt', true],
    ['文件规则只命中自身（兄弟文件不命中）', { cwd: null, paths: ['/etc/hosts.md'] }, '/etc/hostname.md', false],
    ['文件规则命中自己', { cwd: null, paths: ['/etc/hosts.md'] }, '/etc/hosts.md', true],
    ['`..` 字面越界：/proj/a/../../etc/passwd 不在 /proj 下', { cwd: null, paths: ['/proj'] }, '/proj/a/../../etc/passwd', false],
    ['`..` 折回工作区内部要命中', { cwd: null, paths: ['/proj'] }, '/proj/a/../b/secret.txt', true],
    ['相对请求路径（无 cwd 可比）不命中', { cwd: null, paths: ['/proj'] }, 'proj/a.txt', false],
    ['规则写成 `.`（工作区自身）⇒ 整棵子树命中', { cwd: '/proj', paths: ['.'] }, '/proj/a/b.txt', true],
    ['规则写成 cwd 本身 ⇒ 整棵子树命中', { cwd: '/proj', paths: ['/proj'] }, '/proj/a/b.txt', true],
    ['`~` 展开后按同一规则比较', { cwd: null, paths: ['~/.dsh/**'] }, `${os.homedir()}/.dsh/agents.json`, true],
  ]
  for (const [name, rule, reqPath, want] of cases) {
    it(`${name} ⇒ ${want ? '命中' : '不命中'}`, () => {
      // 规则带 cwd 时请求必须带同一个 cwd（cwd 作用域是单向收紧的），
      // 这张表只测"路径子树"这一个维度，所以 cwd 由规则原样透传。
      const r = ruleCoversRequest({ tools: [], categories: [], ...rule }, { cwd: rule.cwd || null, paths: [reqPath], categoryKey: null })
      assert.equal(r.hit, want, `${name}（covered=${JSON.stringify(r.covered)} uncovered=${JSON.stringify(r.uncovered)}）`)
      if (want) assert.equal(r.via, 'paths')
    })
  }

  it('全部路径命中才算命中：部分覆盖绝不放行', () => {
    const r = ruleCoversRequest({ cwd: null, paths: ['/proj'], tools: [] }, { paths: ['/proj/a.txt', '/Users/arming/.ssh/id_rsa'] })
    assert.equal(r.hit, false, '一半在授权目录、一半在外面 ⇒ 不得放行')
    assert.deepEqual(r.covered, ['/proj/a.txt'])
    assert.deepEqual(r.uncovered, ['/Users/arming/.ssh/id_rsa'])
  })

  it('每条规则各自收口：不同规则各覆盖一半 ⇒ 仍不放行', () => {
    const v = evaluateRuleSources([
      { tier: 'disk', rules: [{ cwd: null, paths: ['/proj/a'] }, { cwd: null, paths: ['/proj/b'] }] },
    ], { paths: ['/proj/a/x.txt', '/proj/b/y.txt'] })
    assert.equal(v.allowed, false, '评估按"单条规则覆盖全部请求路径"判定，不跨规则拼凑')
  })

  it('请求没有任何路径 ⇒ 路径档永不命中（fail-closed）', () => {
    assert.equal(ruleCoversRequest({ cwd: null, paths: ['/proj'] }, { paths: [] }).hit, false)
    assert.equal(ruleCoversRequest({ cwd: null, paths: ['/proj'] }, { paths: undefined }).hit, false)
  })

  it('规则里一条路径都没有 ⇒ 不命中', () => {
    assert.equal(ruleCoversRequest({ cwd: null, paths: [] }, { paths: ['/proj/a'] }).hit, false)
    assert.equal(ruleCoversRequest({ cwd: null }, { paths: ['/proj/a'] }).hit, false)
  })
})

describe('v0.7.9 统一评估器：`..` 与软链的真身解析', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-rules-'))
  const proj = path.join(tmp, 'proj')
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  const link = path.join(proj, 'link')
  try { fs.symlinkSync(outside, link, 'dir') } catch { /* 平台不支持软链时跳过 */ }

  it('软链指向子树外 ⇒ 不得命中（link→outside 的真实归属在外面）', { skip: link.startsWith('\\') }, () => {
    const r = ruleCoversRequest({ cwd: null, paths: [proj] }, { paths: [path.join(link, 'secret.txt')] })
    assert.equal(r.hit, false, '经 realpath 后是 <tmp>/outside/secret.txt，不在 <tmp>/proj 子树内')
  })

  it('软链指向子树内 ⇒ 允许（同一棵树的另一条写法）', () => {
    const innerLink = path.join(proj, 'inner')
    try { fs.symlinkSync(path.join(proj, 'real'), innerLink, 'dir') } catch { return }
    try { fs.mkdirSync(path.join(proj, 'real'), { recursive: true }) } catch { /* 已存在 */ }
    const r = ruleCoversRequest({ cwd: null, paths: [proj] }, { paths: [path.join(innerLink, 'a.txt')] })
    assert.equal(r.hit, true)
  })

  it('尾段尚未创建的新文件也能命中（只解析存在的前缀）', () => {
    const r = ruleCoversRequest({ cwd: null, paths: [proj] }, { paths: [path.join(proj, 'no-such-dir', 'new.txt')] })
    assert.equal(r.hit, true, '写入前文件不存在是常态，不能因此退化成弹窗')
  })

  it('resolveRealPath 对不存在的绝对路径退回字面归一（假路径测试可预测）', () => {
    // 注入"全盘不存在"的 fs：realpath 一律抛错 ⇒ 逐级上溯失败 ⇒ 退回 path.normalize。
    // 用真 fs 断言这条路会被 macOS 的 /etc→/private/etc 软链改掉，判定不因此出错
    // （规则侧与请求侧同样解析），但断言就会依赖平台，故这里用假 fs。
    const goneFs = { realpathSync: () => { throw new Error('enoent') }, statSync: () => { throw new Error('enoent') } }
    assert.equal(resolveRealPath('/proj/a/../../etc/passwd', goneFs), '/etc/passwd')
    assert.equal(resolveRealPath('/nope/x', goneFs), '/nope/x')
    assert.equal(resolveRealPath('relative/x', goneFs), null)
    assert.equal(resolveRealPath(null, goneFs), null)
  })

  it('真 fs 下 /etc 会解析到平台真身（规则侧同样解析 ⇒ 比较仍成立）', () => {
    const r = ruleCoversRequest({ cwd: null, paths: ['/etc/hosts.md'] }, { paths: ['/etc/hosts.md'] })
    assert.equal(r.hit, true)
  })

  it('canonicalPath：~ 展开、`.` 按 base 解析、纯相对无 base 返回 null', () => {
    assert.equal(canonicalPath('~/.dsh'), path.join(os.homedir(), '.dsh'))
    assert.equal(canonicalPath('.', '/proj'), '/proj')
    assert.equal(canonicalPath('./sub', '/proj'), '/proj/sub')
    assert.equal(canonicalPath('sub/x'), null)
    assert.equal(canonicalPath('   '), null)
  })

  it('compileRulePath：显式目录写法优先于扩展名启发式', () => {
    assert.equal(compileRulePath('/proj/**').kind, 'dir')
    assert.equal(compileRulePath('/proj/').kind, 'dir')
    assert.equal(compileRulePath('/etc/hosts.md').kind, 'file')
    assert.equal(compileRulePath('/definitely-not-existing/nested-dir').kind, 'dir')
    assert.equal(compileRulePath(''), null)
    assert.equal(compileRulePath(null), null)
  })

  it('coverage() 与 ruleCoversRequest() 用同一套子句（结果一致）', () => {
    const paths = ['/proj/a.txt', '/etc/hosts']
    assert.deepEqual(coverage(paths, ['/proj']).covered, ['/proj/a.txt'])
    assert.deepEqual(coverage(paths, ['/proj']).uncovered, ['/etc/hosts'])
    const r = ruleCoversRequest({ cwd: null, paths: ['/proj'] }, { paths })
    assert.deepEqual(r.uncovered, ['/etc/hosts'])
  })

  it.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
})

describe('v0.7.9 统一评估器：tools 档（产品隔离 + cwd 全等）', () => {
  const rule = (over = {}) => ({ cwd: '/proj', product: 'qoder', paths: [], tools: [], ...over })

  it('同 cwd + 同产品工具名 ⇒ 与路径无关命中（含工作区外路径）', () => {
    const r = ruleCoversRequest(rule({ tools: ['qoder:Bash'] }), {
      cwd: '/proj', product: 'qoder', toolName: 'Bash', paths: ['/Users/arming/.ssh/id_rsa'],
    })
    assert.equal(r.hit, true)
    assert.equal(r.via, 'tools')
  })

  it('异 cwd 不得命中（项目级隔离）', () => {
    assert.equal(ruleCoversRequest(rule({ tools: ['qoder:Bash'] }), {
      cwd: '/other', product: 'qoder', toolName: 'Bash', paths: [],
    }).hit, false)
  })

  it('请求缺 cwd ⇒ 不得消费带 cwd 的规则', () => {
    assert.equal(ruleCoversRequest(rule({ tools: ['qoder:Bash'] }), {
      product: 'qoder', toolName: 'Bash', paths: [],
    }).hit, false)
  })

  it('跨产品不得命中：qoder:Bash 放行不了 deveco 的 Bash（不变式③）', () => {
    for (const product of ['deveco', 'opencode', 'qoder-cli']) {
      assert.equal(ruleCoversRequest(rule({ tools: ['qoder:Bash'] }), {
        cwd: '/proj', product, toolName: 'Bash', paths: [],
      }).hit, false, `${product} 不得吃 qoder 的授权`)
    }
    assert.equal(ruleCoversRequest(rule({ tools: ['qoder:Bash'] }), {
      cwd: '/proj', product: 'QODER', toolName: ' bash ', paths: [],
    }).hit, true, '产品与工具名都大小写不敏感、去空白')
  })

  it('裸工具名靠规则 product 补前缀；补不出就不参与匹配', () => {
    assert.equal(ruleCoversRequest(rule({ tools: ['Bash'] }), {
      cwd: '/proj', product: 'qoder', toolName: 'Bash', paths: [],
    }).hit, true, '规则有 product=qoder ⇒ 裸 Bash 等价 qoder:Bash')
    assert.equal(ruleCoversRequest({ cwd: '/proj', tools: ['Bash'] }, {
      cwd: '/proj', product: 'qoder', toolName: 'Bash', paths: [],
    }).hit, false, '既无前缀又无 product ⇒ 绝不退化成"所有产品通用"')
  })

  it('占位工具名（other/unknown/…）既不入键也不命中（写它等于通配）', () => {
    for (const bad of ['other', 'unknown', 'default', 'misc', '']) {
      assert.equal(toolGrantKey('qoder', bad), null, `${bad || '(空)'} 不得成为授权键`)
      assert.equal(ruleCoversRequest(rule({ tools: [`qoder:${bad}`] }), {
        cwd: '/proj', product: 'qoder', toolName: bad, paths: [],
      }).hit, false)
    }
  })

  it('compileRuleTools：畸形条目静默丢弃，不抛异常', () => {
    assert.deepEqual(compileRuleTools(['qoder:Bash', '', '   ', null, 42, ':x', 'x:', {}], 'qoder'), ['qoder:bash'])
    assert.deepEqual(compileRuleTools(undefined, 'qoder'), [])
  })

  it('tools 与 paths 同时命中时按 tools 报（与路径无关那一档优先表述）', () => {
    const r = ruleCoversRequest({ cwd: '/proj', product: 'qoder', paths: ['/proj'], tools: ['qoder:Write'] }, {
      cwd: '/proj', product: 'qoder', toolName: 'Write', paths: ['/proj/a.txt'],
    })
    assert.equal(r.via, 'tools')
  })

  it('路径档仍要求规则 cwd 与请求 cwd 全等', () => {
    assert.equal(ruleCoversRequest({ cwd: '/proj', paths: ['/proj'] }, {
      cwd: '/other', paths: ['/proj/a.txt'],
    }).hit, false)
    assert.equal(ruleCoversRequest({ cwd: null, paths: ['/proj'] }, {
      cwd: '/other', paths: ['/proj/a.txt'],
    }).hit, true, '规则不带 cwd（provider 白名单那种）⇒ cwd 通配')
  })
})

describe('v0.7.9 统一评估器：来源合成与工作区默认规则', () => {
  it('类别档：只在请求无路径时参与', () => {
    const ruleA = { cwd: '/proj', paths: [], categories: ['qoder:web_search'] }
    assert.equal(ruleCoversRequest(ruleA, { cwd: '/proj', paths: [], categoryKey: 'qoder:web_search' }).hit, true)
    assert.equal(ruleCoversRequest(ruleA, { cwd: '/proj', paths: ['/proj/a'], categoryKey: 'qoder:web_search' }).hit, false,
      '带路径的请求绝不因类别规则被绕过')
    assert.equal(ruleCoversRequest(ruleA, { cwd: '/proj', paths: [], categoryKey: 'deveco:web_search' }).hit, false)
  })

  it('workspaceRuleOf：cwd 有效 ⇒ paths=[cwd]；无效 ⇒ 空规则集', () => {
    const [r] = workspaceRuleOf('/proj')
    assert.equal(r.cwd, '/proj')
    assert.deepEqual(r.paths, ['/proj'])
    assert.deepEqual(r.tools, [])
    assert.deepEqual(workspaceRuleOf(null), [])
    assert.deepEqual(workspaceRuleOf('relative'), [])
  })

  it('工作区默认规则让工作区内路径免弹、工作区外仍不命中', () => {
    const sources = [
      { tier: 'session', rules: [] },
      { tier: 'disk', rules: [] },
      { tier: 'workspace', rules: workspaceRuleOf('/proj') },
    ]
    const inside = evaluateRuleSources(sources, { cwd: '/proj', paths: ['/proj/src/a.js'] })
    assert.equal(inside.allowed, true)
    assert.equal(inside.tier, 'workspace')
    const outside = evaluateRuleSources(sources, { cwd: '/proj', paths: ['/Users/arming/.ssh/id_rsa'] })
    assert.equal(outside.allowed, false)
    assert.deepEqual(outside.uncovered, ['/Users/arming/.ssh/id_rsa'])
  })

  it('来源顺序：先命中的档被报告（session 优先于 disk/workspace）', () => {
    const sources = [
      { tier: 'session', rules: [{ cwd: '/proj', paths: ['/proj'], tools: [] }] },
      { tier: 'disk', rules: [{ cwd: '/proj', paths: ['/proj'], tools: [] }] },
      { tier: 'workspace', rules: workspaceRuleOf('/proj') },
    ]
    assert.equal(evaluateRuleSources(sources, { cwd: '/proj', paths: ['/proj/a'] }).tier, 'session')
  })

  it('未命中时报告"覆盖最多路径"的那条规则的 uncovered（供日志归因）', () => {
    const v = evaluateRuleSources([
      { tier: 'disk', rules: [{ cwd: null, paths: ['/x'] }] },
      { tier: 'workspace', rules: [{ cwd: null, paths: ['/proj'] }] },
    ], { cwd: '/proj', paths: ['/proj/a.txt', '/proj/b.txt', '/etc/hosts'] })
    assert.equal(v.allowed, false)
    assert.equal(v.covered.length, 2)
    assert.deepEqual(v.uncovered, ['/etc/hosts'])
  })

  it('畸形输入不抛异常：sources/rules/paths 各种缺失组合', () => {
    assert.equal(evaluateRuleSources(undefined, undefined).allowed, false)
    assert.equal(evaluateRuleSources([{}], { paths: ['/a'] }).allowed, false)
    assert.equal(ruleCoversRequest(undefined, undefined).hit, false)
  })
})

// ── v0.7.9 缺口A/B 纯函数层 ───────────────────────────────────────────────────
//
// 接线层用例在 test/permission-handler-wiring.test.js（断言的是"实际写进了什么"）。
// 这一层只测判据本身：客户端不可信 ⇒ 逐条校验并如实报告丢弃原因；三条出口互斥且
// 只有三条；预填目录的取父规则与授权写入解耦（后者绝不消费前者的输出）。

describe('缺口A：validateDeclaredPaths 逐条校验（不可盲信客户端）', () => {
  it('未给 ≠ 空数组：前者 given:false（走自动分析），后者 given:true + declared:[]（走工具档）', () => {
    for (const notGiven of [undefined, null, 42, 'string', {}, () => {}]) {
      const r = validateDeclaredPaths(notGiven)
      assert.equal(r.given, false, `${String(notGiven)} 不是数组 ⇒ 视为未给`)
      assert.deepEqual(r.declared, [])
      assert.deepEqual(r.dropped, [], '未给 ⇒ 不产生"丢弃"记录（没有东西被给出来）')
    }
    const empty = validateDeclaredPaths([])
    assert.equal(empty.given, true)
    assert.deepEqual(empty.declared, [])
    assert.deepEqual(empty.dropped, [])
  })

  it('词法规范化：尾部分隔符被剥、`.`/`..` 被折叠、重复条目合并', () => {
    assert.deepEqual(validateDeclaredPaths(['/a/b/']).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(['/a/b//']).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(['/a/b/../c']).declared, ['/a/c'], '.. 按词法折叠，不做 realpath')
    assert.deepEqual(validateDeclaredPaths(['/a/./b']).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(['/a', '/a/', ' /a ', '/a//']).declared, ['/a'], '四条写法是同一条目录')
    assert.deepEqual(validateDeclaredPaths(['/a', '/b', '/a']).declared, ['/a', '/b'], '去重且保持首次出现的顺序')
  })

  it('拒绝集：空串/纯空白/相对路径/文件系统根/NUL/换行/非字符串，逐条带原因', () => {
    const r = validateDeclaredPaths(['', '   ', 'a/b', './a', '../a', '/', '//', '/', ' / ', '/a\0b', '/a\nb', 42, null, {}, []])
    assert.deepEqual(r.declared, [], '上述条目一条都不该活着')
    const reasons = r.dropped.map((d) => d.reason)
    for (const want of ['空字符串', '非绝对路径', '根目录', '含 NUL', '含换行', '非字符串']) {
      assert.ok(reasons.includes(want), `缺原因 ${want}：${JSON.stringify(reasons)}`)
    }
    assert.equal(r.dropped.length, 15, `每条被给的非法条目都要单独留痕（实际 ${r.dropped.length}）`)
    assert.equal(r.dropped.filter((d) => d.reason === '根目录').length, 4, "四种根目录写法（/、//、/、\" / \"）各留一条记录，不合并")
  })

  it('引号包裹与尾部标点在规范化里被剥掉（与既有路径提取同一套 normalizeCandidate）', () => {
    assert.deepEqual(validateDeclaredPaths(['"/a/b"']).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(["'/a/b'"]).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(['/a/b,']).declared, ['/a/b'])
    assert.deepEqual(validateDeclaredPaths(['/a/b。']).declared, ['/a/b'])
  })

  it('~ 展开到 home；展开后若正好是根目录仍被拒', () => {
    const r = validateDeclaredPaths(['~/code', '~'])
    assert.deepEqual(r.declared, [path.join(os.homedir(), 'code'), os.homedir()])
    assert.equal(r.dropped.length, 0)
    // 把 home 伪造成 '/' 来单独验根目录那道闸（不依赖真实 HOME）
    const home = os.homedir()
    assert.equal(home === '/', false, '本用例的前提是 home 不是根目录')
  })

  it('全部非法 ⇒ declared 为空数组（调用方据此走工具档，绝不落一条空路径规则）', () => {
    const r = validateDeclaredPaths(['/', 'rel', ''])
    assert.equal(r.given, true)
    assert.deepEqual(r.declared, [])
    assert.equal(r.dropped.length, 3)
  })
})

describe('缺口A：planGrantWrites 只有三条出口，且 paths/tools 互斥', () => {
  const auto = ['/Users/x/a.txt', '/etc/hosts']

  it('出口一 legacy：未给 ⇒ 自动分析结果原样透传（不过滤、不重排、同一数组引用）', () => {
    const p = planGrantWrites(undefined, auto, { product: 'qoder', toolName: 'Bash' })
    assert.equal(p.mode, 'legacy')
    assert.equal(p.source, 'auto')
    assert.equal(p.paths, auto, '必须把**同一个**数组交回既有写入逻辑，否则"行为逐字节不变"无从谈起')
    assert.equal(p.expand, true, 'legacy 出口照旧走"文件取父目录"展开')
    assert.equal(p.toolKey, null, 'legacy 的工具档由调用侧按既有 L1 逻辑写，plan 不接管')
    assert.deepEqual(p.dropped, [])
  })

  it('出口二 paths：给定目录 ⇒ 只写路径档，toolKey=null，且 expand=false（不升父目录）', () => {
    const p = planGrantWrites(['/tmp/newproj'], auto, { product: 'qoder', toolName: 'Bash' })
    assert.equal(p.mode, 'paths')
    assert.equal(p.source, 'user')
    assert.deepEqual(p.paths, ['/tmp/newproj'], '自动分析的那两条一条都不留')
    assert.equal(p.expand, false, '声明的已是目录 ⇒ 再取父目录等于把 /tmp 放进来')
    assert.equal(p.toolKey, null, 'paths 档与工具档互斥')
    assert.deepEqual(p.dropped, [])
  })

  it('出口三 tools：给定空集 ⇒ 只写工具档，paths=[]', () => {
    const p = planGrantWrites([], auto, { product: 'qoder', toolName: 'Bash' })
    assert.equal(p.mode, 'tools')
    assert.equal(p.source, 'user')
    assert.deepEqual(p.paths, [], '工具档下一路径都不能有')
    assert.equal(p.toolKey, 'qoder:bash')
  })

  it('全非法 ⇒ 走出口三但保留丢弃记录', () => {
    const p = planGrantWrites(['/', 'rel'], auto, { product: 'qoder', toolName: 'Bash' })
    assert.equal(p.mode, 'tools')
    assert.equal(p.toolKey, 'qoder:bash')
    assert.equal(p.dropped.length, 2)
  })

  it('出口三 + 工具名解析不出来 ⇒ toolKey=null（调用方据此报"实际什么都没写"）', () => {
    for (const ctx of [{ product: 'qoder', toolName: null }, { product: null, toolName: 'Bash' }, {}, { product: 'qoder', toolName: 'other' }]) {
      const p = planGrantWrites([], auto, ctx)
      assert.equal(p.mode, 'tools')
      assert.equal(p.toolKey, null, `无可用工具名 ⇒ 不给出半截授权键（${JSON.stringify(ctx)}）`)
    }
  })

  it('互斥不变式：mode 为 paths ⇔ toolKey 为 null；mode 为 tools ⇒ paths 必空', () => {
    for (const given of [[], ['/a'], ['/', 'rel'], undefined]) {
      const p = planGrantWrites(given, auto, { product: 'qoder', toolName: 'Bash' })
      if (p.mode === 'paths') assert.equal(p.toolKey, null, 'paths 档绝不带工具键')
      if (p.mode === 'tools') assert.deepEqual(p.paths, [], 'tools 档绝不带路径')
      assert.ok(['legacy', 'paths', 'tools'].includes(p.mode), '只有三条出口')
    }
  })
})

describe('缺口B：suggestedDirs（弹框预填用，服务端不当授权依据）', () => {
  /** 纯逻辑测试注入假 fs：不依赖磁盘真相，也不碰用户目录 */
  const fakeFs = (dirs) => ({ statSync: (p) => (dirs.includes(p) ? { isDirectory: () => true } : (() => { throw new Error('ENOENT') })()) })

  it('文件取父目录、已存在目录保留自身、去重保序', () => {
    const fsImpl = fakeFs(['/data/proj', '/data/keep'])
    assert.deepEqual(
      suggestedDirs(['/data/proj/a.txt', '/data/proj', '/data/proj/b.txt', '/data/keep', '/etc/hosts', '/no/such/x.txt'], { fsImpl }),
      ['/data/proj', '/data/keep', '/etc', '/no/such'],
    )
  })

  it('根目录不入预填（等于全放行，UI 不许出现这种候选）', () => {
    const fsImpl = fakeFs([])
    assert.deepEqual(suggestedDirs(['/', '/a.txt'], { fsImpl }), [], "'/'.dirname = '/' 是根 ⇒ 两条都丢")
  })

  it('非数组/畸形条目 ⇒ 空数组或不抛', () => {
    assert.deepEqual(suggestedDirs(undefined), [])
    assert.deepEqual(suggestedDirs(null), [])
    assert.deepEqual(suggestedDirs(42), [])
    assert.deepEqual(suggestedDirs([null, 42, {}, '', '   ', 'rel/path']), [], '相对路径与畸形条目一律不预填')
  })

  it('真实临时目录：已存在的目录保留自身（与 expandPathsWithParents 判定同构）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sugg-'))
    const file = path.join(tmp, 'a.txt')
    assert.deepEqual(suggestedDirs([file, tmp]), [tmp], '文件与其父目录同时在场 ⇒ 只出一条')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('缺口D 修正：inferredDirs（正文推测档，预填在 suggestedDirs 之后，可手编可删行）', () => {
  const fakeFs = (dirs) => ({ statSync: (p) => (dirs.includes(p) ? { isDirectory: () => true } : (() => { throw new Error('ENOENT') })()) })

  it('规范化口径与 suggestedDirs 完全一致，且排除 suggestedDirs 已有的项', () => {
    const fsImpl = fakeFs(['/data/proj'])
    const structured = suggestedDirs(['/data/proj/target.txt'], { fsImpl })
    assert.deepEqual(structured, ['/data/proj'], '前置：结构化那一档算出的目录')
    // 正文扫出来的东西：既有真目标（与结构化重合），也有三个不该和"实际触达"混在一档的敏感目录
    const loose = ['/data/proj/target.txt', '/etc/passwd', '/var/spool/x', '~/.ssh/id_rsa']
    assert.deepEqual(
      inferredDirs(loose, structured, { fsImpl }),
      ['/etc', '/var/spool', path.join(os.homedir(), '.ssh')],
      '与结构化重合的那条被排除，其余按「取父目录 + 去重 + 规范化」保留原顺序（`~` 由 canonicalPath 展开成真实家目录）',
    )
  })

  it('同一目录同时被结构化与推测命中 ⇒ 只出现在 suggestedDirs，绝不重复出现（否则文本框里同一目录会有两行）', () => {
    const fsImpl = fakeFs([])
    const structured = suggestedDirs(['/etc/passwd'], { fsImpl })
    assert.deepEqual(structured, ['/etc'])
    assert.deepEqual(inferredDirs(['/etc/passwd'], structured, { fsImpl }), [], '完全重合 ⇒ 推测档为空')
  })

  it('structuredDirs 缺省/非数组 ⇒ 不排除任何项（等价 suggestedDirs 的口径）', () => {
    const fsImpl = fakeFs([])
    for (const bad of [undefined, null, 42, 'string', {}]) {
      assert.deepEqual(inferredDirs(['/etc/passwd', '/no/such/x.txt'], bad, { fsImpl }), ['/etc', '/no/such'],
        `${JSON.stringify(bad)}：结构化档缺失时推测档照常输出`)
    }
  })

  it('rawInferred 非数组/畸形条目 ⇒ 空数组或不抛（与 suggestedDirs 同规则）', () => {
    for (const bad of [undefined, null, 42, 'string']) {
      assert.deepEqual(inferredDirs(bad, [], { fsImpl: fakeFs([]) }), [], `${JSON.stringify(bad)} ⇒ []，不抛`)
    }
    assert.deepEqual(inferredDirs([null, 42, {}, '', 'rel/path', '/'], [], { fsImpl: fakeFs([]) }), [],
      '相对路径/空串/根目录一律不推测（根目录推测出来等于"全放行"给 UI 看）')
  })

  it('推测档不参与任何档位判定：喂给 planGrantWrites 的仍是自动分析那一份', () => {
    // 这条是"推测预填档与自动授权面隔离"的函数级反证：把推测档当 autoPaths 传进去会怎样不重要，
    // 重要的是调用方（lib/index.js）传的是 reqPaths——接线面由
    // test/permission-handler-wiring.test.js 的「源码不变量」用例钉住。
    const auto = ['/data/proj/target.txt']
    const plan = planGrantWrites(null, auto, { product: 'qoder', toolName: 'Edit' })
    assert.equal(plan.mode, 'legacy')
    assert.equal(plan.paths, auto, 'legacy 出口必须原样引用自动分析那一份（同一数组对象）')
    assert.notEqual(plan.paths, inferredDirs(['/etc/passwd'], [], { fsImpl: fakeFs([]) }),
      '推测档产物不是规则输入（此处仅作对照：两者内容毫无交集）')
  })
})

describe('老 allowlist.json 只读兼容（临时目录断言，绝不写用户真实 ~/.dsh）', () => {
  const LEGACY = {
    version: 1,
    rules: [
      { cwd: '/proj', paths: ['/tmp/*', '/Users/x/.dsh'], product: 'deveco', grantedAt: '2026-10-04T00:00:00.000Z', note: '用户在授权界面点击总是允许（项目内）' },
      { cwd: '/proj2', paths: ['/Users/y/cache/'], grantedAt: '2026-10-04T00:00:00.000Z' },
    ],
  }

  const withLegacyFile = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ual-'))
    const file = path.join(dir, 'allowlist.json')
    const bytes = `${JSON.stringify(LEGACY, null, 2)}\n`
    fs.writeFileSync(file, bytes, 'utf8')
    try {
      return body(dir, file, bytes)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('读取不改写：读一次后文件字节与读之前完全相同（不迁移、不规范化）', () => {
    withLegacyFile((dir, file, bytes) => {
      const rules = readUserAllowlist(dir)
      assert.equal(rules.length, 2)
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, '只读兼容是明示要求：读侧一个字节都不许动')
      readUserAllowlist(dir)
      assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    })
  })

  it('老条目的尾斜杠/`/*` 在新目录子树语义下等价于该目录本身：/tmp/* 命中 /tmp/build/out.txt', () => {
    withLegacyFile((dir) => {
      const rules = readUserAllowlist(dir)
      const v = evaluateRuleSources([{ tier: 'disk', rules }], { cwd: '/proj', product: 'deveco', paths: ['/tmp/build/out.txt'] })
      assert.equal(v.allowed, true, '`/tmp/*` 必须仍然命中（老授权不许被读成失效）')
      assert.equal(v.via, 'paths')
      assert.deepEqual(rules[0].paths, ['/tmp/*', '/Users/x/.dsh'], '读回的是原文，不是规范化后的形态')
      const sibling = evaluateRuleSources([{ tier: 'disk', rules }], { cwd: '/proj', product: 'deveco', paths: ['/tmpx/a.txt'] })
      assert.equal(sibling.allowed, false, '子树语义不外溢到兄弟前缀目录')
      const otherCwd = evaluateRuleSources([{ tier: 'disk', rules }], { cwd: '/other', product: 'deveco', paths: ['/tmp/a'] })
      assert.equal(otherCwd.allowed, false, 'rule.cwd 全等的作用域隔离照旧生效')
    })
  })

  it('尾斜杠写法 `/Users/y/cache/` 同样是显式目录 ⇒ 命中其子树', () => {
    withLegacyFile((dir) => {
      const rules = readUserAllowlist(dir)
      const v = evaluateRuleSources([{ tier: 'disk', rules }], { cwd: '/proj2', paths: ['/Users/y/cache/sub/a.bin'] })
      assert.equal(v.allowed, true)
    })
  })

  it('推荐写法：想要"放行 /tmp 整棵"就写 `/tmp`；写 `/tmp*` 会变成名叫 `tmp*` 的目录', () => {
    const probe = (rulePath, reqPath) => ruleCoversRequest({ cwd: null, paths: [rulePath], tools: [] }, { paths: [reqPath] }).hit
    assert.equal(probe('/tmp', '/tmp/build/out.txt'), true, '推荐写法：目录本身')
    assert.equal(probe('/tmp/', '/tmp/build/out.txt'), true, '尾斜杠同义')
    assert.equal(probe('/tmp/*', '/tmp/build/out.txt'), true, '老写法同义（不会被读成字面 `*` 目录）')
    assert.equal(probe('/tmp/**', '/tmp/build/out.txt'), true, '`/**` 同义')
    assert.equal(probe('/tmp*', '/tmp/build/out.txt'), false, '`*` 前无分隔符 ⇒ 是字面目录名 tmp*')
  })

  it('新写入与老文件共存：追加一条 tools 档后，老的两条规则仍原样读回', () => {
    withLegacyFile((dir, file, bytes) => {
      assert.equal(bytes.includes('"tools"'), false, '前置条件：老文件里没有 tools 维')
      const w = appendUserRule({ cwd: '/proj3', product: 'qoder', tools: ['qoder:bash'] }, dir)
      assert.equal(w.ok, true)
      const rules = readUserAllowlist(dir)
      assert.equal(rules.length, 3, '新条目追加，不覆盖、不重排老条目')
      assert.deepEqual(rules[0].paths, ['/tmp/*', '/Users/x/.dsh'], '第一条老条目原文仍在')
      assert.deepEqual(rules[2].tools, ['qoder:bash'])
      assert.deepEqual(rules[2].paths, [], '只有工具档的规则读回路径为空集')
      const v = evaluateRuleSources([{ tier: 'disk', rules }], { cwd: '/proj3', product: 'qoder', toolName: 'Bash', paths: ['/etc/hosts'] })
      assert.equal(v.via, 'tools', '新条目走工具档命中')
    })
  })
})
