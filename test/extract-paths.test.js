// v0.7.9（C 项）：请求路径提取必须是**结构化字段优先，文本扫描只作最后兜底**。
//
// 现场证据是两条真实授权球文案（用户提供的原文，路径为被编辑文件内容里的字符串）：
//   Edit permission-handler-wiring.test.js | 📁 /Volumes/proj/inside | 📁 /Users/arming/Library/Preferences/x.plist
//   Edit tool-grant-session.test.js | 📁 /tmp/proj/a.txt | 📁 /home/test | 📁 …/tool-grant-session.test.js
// 旧实现（对 toolCall 全量递归 + 正则扫字符串值）会把 diff 正文里的路径字符串
// 当成"本次请求涉及的路径"。会话授权写的是"每条路径的上一级目录"，于是一条假
// 路径就能把一个无关目录写进授权集——这是正确性前提，不是显示瑕疵。
//
// v0.7.9 缺口D 把这条正确性前提**收口**：全量递归的 scanPathsLoose 在生产路径上
// 已不可达，兜底只剩 `scanExecuteCommandPaths`（执行类帧的 rawInput.command /
// 老模型 arguments.command）。因此本文件里三处 0.7.9 早期的断言被改成期望空集，
// 每处都就地写明了理由；scanPathsLoose 仍被直接调用，只用于"旧实现确实会抓到
// 正文假路径"的差分证明。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractPaths, extractStructuredPaths, scanPathsLoose } from '../lib/bridges/acp.js'

/** qoder Edit 载荷形态（实测）：真实目标在 rawInput.file_path，正文在 content[].content.text */
const qoderEdit = (target, fileContent) => ({
  toolCallId: 'tc-edit-1',
  name: 'Edit',
  kind: 'edit',
  status: 'pending',
  title: `Edit ${target.split('/').pop()}`,
  rawInput: { file_path: target, old_string: 'const x = 1', new_string: fileContent },
  content: [{ type: 'diff', content: { text: fileContent } }],
})

describe('v0.7.9 C 项：结构化路径优先，正文里的假路径不入请求集合', () => {
  it('真实 fixture①：编辑测试文件时，正文里的 /Volumes/proj/inside 与 x.plist 不得成为请求路径', () => {
    const diff = [
      ' --- a/test/permission-handler-wiring.test.js',
      ' +++ b/test/permission-handler-wiring.test.js',
      '+const target = "/Volumes/proj/inside"',
      '+// 参考 /Users/arming/Library/Preferences/x.plist 里的配置',
    ].join('\n')
    const real = '/Volumes/proj/test/permission-handler-wiring.test.js'
    const paths = extractPaths(qoderEdit(real, diff))
    assert.deepEqual(paths, [real], '请求路径只有被编辑的那个文件')
    assert.equal(paths.some((p) => p.includes('/Volumes/proj/inside')), false, '假路径不得进入集合（它的父目录 /Volumes/proj 会被写进会话授权）')
    assert.equal(paths.some((p) => p.endsWith('x.plist')), false)
    // 双向断言：旧的全量文本扫描确实会抓到这两条——证明 fixture 复现的是真实现场
    const loose = scanPathsLoose(qoderEdit(real, diff))
    assert.ok(loose.length > paths.length, `兜底扫描应比结构化提取抓得多（实际 ${loose.length} vs ${paths.length}）`)
    assert.ok(loose.some((p) => p.includes('Library/Preferences')), '旧实现确实把正文里的路径当请求路径')
  })

  it('真实 fixture②：三条 📁 里只有被编辑文件是真目标，/tmp/proj/a.txt 与 /home/test 来自正文', () => {
    const real = '/Volumes/proj/test/tool-grant-session.test.js'
    const body = `写入 /tmp/proj/a.txt；cwd 是 /home/test；本文件 ${real} 自身\n`
    assert.deepEqual(extractPaths(qoderEdit(real, body)), [real], '结构化层命中即以其为准，正文一条都不进')
    // 兜底层（0.7.8 行为）确实会把正文里的 2 条假路径也当成请求路径——断言"分层"而不是"总数 4"：
    // v0.7.9 顺手收紧了匹配边界（分号/中文标点后即断），所以这里是 3 条干净 token，
    // 而非旧实现那种 '/tmp/proj/a.txt；cwd' 的脏 token（脏 token 匹配不上规则，却会被取父目录写进授权集）。
    assert.deepEqual(scanPathsLoose(qoderEdit(real, body)), [real, '/tmp/proj/a.txt', '/home/test'])
  })

  it('编辑 dangerous-commands.js 时，正文里列出的 ~/.qoder/settings.json 不算请求路径', () => {
    const real = '/Volumes/proj/dsh-plugin-product-subagents/lib/dangerous-commands.js'
    const body = 'const HOME_RULE = "~/.qoder/settings.json" // 用户自己的 ask 规则\n'
    assert.deepEqual(extractPaths(qoderEdit(real, body)), [real])
  })

  it('结构化字段覆盖面：locations / rawInput / arguments / camelCase / JSON 字符串', () => {
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }, { file: '/proj/b.txt' }] }), ['/proj/a.txt', '/proj/b.txt'])
    assert.deepEqual(extractPaths({ rawInput: { filePath: '/proj/camel.txt' } }), ['/proj/camel.txt'], '旧 PATH_KEY 吃不到 camelCase filePath')
    assert.deepEqual(extractPaths({ rawInput: { notebookPath: '/proj/nb.ipynb' } }), ['/proj/nb.ipynb'])
    // ⚠️ v0.7.9（第六轮裁定）**更正既有断言**（改前原文见下行注释）：
    //   改前：`assert.deepEqual(extractPaths({ rawInput: { paths: ['/proj/1.txt', '/proj/2.txt'] } }), ['/proj/1.txt', '/proj/2.txt'])`
    //   改后：期望 `[]`。理由：`rawInput.paths` 是**工具参数正文里的数组**，不是 toolCall
    //   顶层的块数组 —— 正文由被编辑/被写入的内容决定，`paths:[…]` 里完全可以写着
    //   `/etc/passwd`、`~/.ssh`；只要"信封内数组按 PATH_KEYS 取值"这条路还在，
    //   补多少个键名都会漏下一个。裁定：`rawInput`/`arguments` 下的数组**一律不取路径、
    //   也不下钻**（本函数的产物是**唯一**能自动变成规则的路径集合，见 `extractPaths` 的 ⚠️）。
    //   代价（明确记录、方向 fail-closed）：真出现"产品把路径以数组形式放在 rawInput 下"
    //   的形状会少预填一条 ⇒ 弹框预填为空、用户手填。本仓全量语料（lib/roles/docs）中
    //   没有任何产品以此形状下发路径的确证证据；确证真帧走的是信封**顶层标量**
    //   （`rawInput.file_path` / `arguments.file_path`），那一路照旧工作（见下方 `:70` 与
    //   「信封边界」describe 的零损失组）。
    assert.deepEqual(extractPaths({ rawInput: { paths: ['/proj/1.txt', '/proj/2.txt'] } }), [],
      '第六轮裁定：rawInput 下的数组是工具参数正文 ⇒ 一条都不取（改前期望为两条）')
    assert.deepEqual(extractPaths({ arguments: JSON.stringify({ path: '/Users/arming/.dsh/AGENTS.md' }) }),
      ['/Users/arming/.dsh/AGENTS.md'], 'arguments 以 JSON 字符串下发时同样解析')
  })

  it('非文件系统的值不当路径：http/data URI、说明性文字、空值', () => {
    assert.deepEqual(extractPaths({ rawInput: { url: 'https://example.com/a/b', path: '/tmp/real.txt' } }), ['/tmp/real.txt'])
    assert.deepEqual(extractStructuredPaths({ rawInput: { target: 'the file at /tmp/x.txt is missing' } }), [],
      '结构化层：散文 blob 不是路径（键名叫 target 也不算）')
    assert.deepEqual(extractPaths({ rawInput: { path: '', dir: '   ', file: null } }), [])
    assert.deepEqual(extractStructuredPaths({ rawInput: { path: '/tmp/a\r\nb' } }), [], '结构化层：含换行的值不是单条路径')
    // v0.7.9 缺口D（改的是**本文件既有断言**，理由如下）：
    //   改前：extractPaths 结构化层为空 ⇒ 退回 scanPathsLoose ⇒ 期望 ['/tmp/a']。
    //   改后：兜底只对执行类帧的命令正文开放，这条载荷既无 kind 也无 command ⇒ []。
    //   取 [] 而不是 '/tmp/a' 是**刻意的**：含换行的值本身就不是"单条路径"，
    //   0.7.8 把它按行切一半塞进请求集合，正是"半条路径被取父目录写进授权"的来源之一。
    assert.deepEqual(extractPaths({ rawInput: { path: '/tmp/a\r\nb' } }), [],
      '缺口D：非执行类帧不再走正文兜底（多行 blob 连半条都不给）')
    // 缺口D 的核心效果：散文 blob 不再被扫描（0.7.8 会从这里扫出一条猜出来的路径）。
    assert.deepEqual(extractPaths({ rawInput: { target: 'the file at /tmp/x.txt is missing' } }), [],
      '缺口D：结构化层为空且不是执行类帧 ⇒ 返回空集，不再从说明文字里猜路径')
  })

  it('file:// URI 归一成文件系统路径（%20 解码）', () => {
    assert.deepEqual(extractPaths({ locations: [{ uri: 'file:///tmp/x%20y' }] }), ['/tmp/x y'])
  })

  it('兜底的唯一合法场合：执行类帧的命令正文（Bash 帧仍能从 rawInput.command 识别）', () => {
    const req = { name: 'Bash', kind: 'execute', title: 'cat /etc/hosts', rawInput: { command: 'cat /etc/hosts' } }
    assert.deepEqual(extractStructuredPaths(req), [], 'command 不是路径字段')
    assert.deepEqual(extractPaths(req), ['/etc/hosts'], '执行类帧：命令正文里的路径就是本次请求的客体')
    // 老模型（无 kind、命令在 arguments）同样识别：Claude/Codex 形态的 shell 帧
    assert.deepEqual(extractPaths({ name: 'shell', arguments: { command: 'cat ~/.dsh/settings.yaml' } }),
      ['~/.dsh/settings.yaml'], 'arguments.command 是 command 字段的老模型回退（与 dangerous-commands 的正文来源同一口径）')
    assert.deepEqual(extractPaths({ name: 'shell', arguments: JSON.stringify({ command: 'ls /tmp/data' }) }),
      ['/tmp/data'], 'arguments 以 JSON 字符串下发时同样取到 command')
  })

  it('缺口D：非执行类帧即便夹带 command 字段也不扫；kind 明确非执行类时一票否决', () => {
    const editWithCommand = {
      toolCallId: 'tc-x', kind: 'edit', name: 'Edit',
      rawInput: { command: 'cat /etc/passwd', new_string: 'see /etc/shadow' },
      content: [{ type: 'diff', path: '/proj/a.ts', newText: 'const p = "/etc/shadow"' }],
    }
    assert.deepEqual(extractPaths(editWithCommand), ['/proj/a.ts'],
      'kind=edit ⇒ 只认结构化 diff path；命令字段与正文都不参与')
    const noKindNoName = { rawInput: { command: 'cat /etc/hosts' } }
    assert.deepEqual(extractPaths(noKindNoName), [],
      '既无 kind 也无执行类 name ⇒ 不认定执行类，不扫')
  })

  it('缺口D：Edit 帧的路径集合恰好是 content[] 各 diff 块的 path（多块、去重、保序）', () => {
    const frame = {
      toolCallId: 'tc-multi', kind: 'edit', name: 'Edit', title: 'Edit 3 files',
      content: [
        { type: 'diff', path: '/proj/src/a.ts', oldText: 'x = "/etc/passwd"', newText: 'x = "/home/test"' },
        { type: 'diff', path: '/proj/src/b.ts', newText: 'const HOME = "/Users/arming/.dsh"' },
        { type: 'diff', path: '/proj/src/a.ts', newText: '重复同一文件' },
      ],
      rawInput: { file_path: '/proj/src/a.ts' },
    }
    assert.deepEqual(extractPaths(frame), ['/proj/src/a.ts', '/proj/src/b.ts'],
      '路径集合 = diff 块 path 去重保序；正文里的 /etc/passwd、/home/test、.dsh 一条都不许进')
    // 回退顺序：content[] 没有 path 时用 rawInput.file_path，再退 rawInput.path
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', newText: 'body' }], rawInput: { file_path: '/proj/c.md' } }), ['/proj/c.md'])
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', newText: 'body' }], rawInput: { path: '/proj/d.md' } }), ['/proj/d.md'])
  })

  it('缺口D：newText 里塞满假路径 ⇒ 不进入路径集合、不影响判定（差分证明旧实现会进）', () => {
    const decoys = [
      '/tmp/proj/a.txt', '/home/test', '/etc/passwd', '/Volumes/proj/inside',
      '~/.qoder/settings.json', '~/.dsh。', '/Users/arming/Library/Preferences/x.plist',
    ]
    const real = '/Volumes/proj/lib/dangerous-commands.js'
    const frame = {
      toolCallId: 'tc-decoy', kind: 'edit', name: 'Edit', title: `Edit ${real.split('/').pop()}`,
      rawInput: { file_path: real, old_string: 'x', new_string: `${decoys.join('\n')}\nconst re = /[A-Za-z]:[\\/]/.test(p)` },
      content: [{ type: 'diff', path: real, newText: decoys.join('\n'), oldText: 'x' }],
    }
    assert.deepEqual(extractPaths(frame), [real], '请求路径**恰好**是被编辑的那个文件')
    for (const decoy of decoys) {
      assert.equal(extractPaths(frame).some((p) => p.includes(decoy.replace(/[。.]/g, ''))), false, `${decoy} 不得进入路径集合`)
    }
    // 双向断言（差分）：0.7.8 的兜底确实会把这一整堆假路径当请求路径——
    // 证明本 fixture 复现的是真实现场，而不是一个恰好为空的弱断言。
    const loose = scanPathsLoose(frame)
    assert.ok(loose.length > decoys.length - 1, `兜底扫描应抓到一批正文路径（实际 ${loose.length} 条）`)
    assert.ok(loose.some((p) => p.includes('Library/Preferences')), '旧实现确实把 diff 正文里的路径当请求路径')
    // scanPathsLoose 在生产路径上已不可达：extractPaths 的任何出口都不等于它的结果
    assert.notDeepEqual(extractPaths(frame), loose, 'extractPaths 不再走 scanPathsLoose')
  })

  it('兜底仍在：产品一个结构化路径字段都不给时，从描述文本里扫（已知误报面）', () => {
    const req = { name: 'Bash', kind: 'execute', title: 'cat /etc/hosts', rawInput: { command: 'cat /etc/hosts' } }
    assert.deepEqual(extractStructuredPaths(req), [], 'command 不是路径字段')
    assert.deepEqual(extractPaths(req), ['/etc/hosts'], '无结构化路径时退回文本扫描，行为与 0.7.8 一致')
  })

  it('畸形载荷不抛异常', () => {
    for (const bad of [null, undefined, 42, 'string', [], { rawInput: null }, { rawInput: [] }, { locations: [null, 3] }]) {
      assert.ok(Array.isArray(extractPaths(bad)), `${JSON.stringify(bad)} 必须返回数组`)
    }
  })

  it('深度护栏：极深嵌套不至于爆栈', () => {
    let node = { path: '/proj/deep.txt' }
    for (let i = 0; i < 200; i += 1) node = { nested: node }
    assert.deepEqual(extractStructuredPaths(node), [], '结构化层到 depth>6 即停，不下探也不误报')
    // v0.7.9 缺口D（改的是**本文件既有断言**）：改前期望 ['/proj/deep.txt']——那是
    // scanPathsLoose 无深度护栏一路扫到 200 层的结果。兜底收口到"执行类帧的命令正文"
    // 之后，这条没有 kind/command 的深嵌套载荷什么都扫不出，返回空集是**更严格**的方向：
    // 结构化层因护栏没吃到、文本层又不许猜 ⇒ 宁可弹窗也不写一条猜出来的授权。
    assert.deepEqual(extractPaths(node), [], '缺口D：兜底不再全量递归，深嵌套载荷返回空集且不爆栈')
    // 反证护栏本身仍有效：同样的深嵌套若带上执行类 command，仍只扫 command
    const deepExec = { kind: 'execute', rawInput: { command: 'cat /etc/hosts' }, deep: node }
    assert.deepEqual(extractPaths(deepExec), ['/etc/hosts'], '执行类帧只扫 command，深嵌套里的 path 不参与')
  })
})

// ── v0.7.9（复审 B-1）：正文本身是 JSON 时，JSON 下钻不得把正文键当结构化路径 ────────
//
// 现场：改 `*.json` 配置时，被编辑文件的**正文本身就是 JSON**。旧实现对任意字符串值
// try `JSON.parse` 再下钻，于是正文里 `{"dest":"~/.ssh"}`、`{"path":"/etc/passwd"}` 的
// 键值被当成**结构化路径**收进 `extractPaths`——而它是**唯一**能自动变成规则的路径集合。
// 会话规则写的是"每条路径的上一级目录"，一条假路径就足以把 `~/.ssh`、`/etc` 写进会话授权。
//
// 修法两条：① JSON 下钻只允许**容器键**（当前确证需要的是 `arguments`）；
// ② 正文键（`newText`/`oldText`/`new_string`/`old_string`/`text`）**一律不参与**提取。
describe('v0.7.9 复审 B-1：JSON 形状的正文不得让结构化提取下钻', () => {
  /** 验收用例给定的载荷（复审原文） */
  const b1Frame = () => ({
    kind: 'edit',
    rawInput: { file_path: '/p/a.json', new_string: '{"path":"/etc/passwd"}' },
    content: [{ type: 'diff', path: '/p/a.json', newText: '{"dest":"~/.ssh"}' }],
  })

  it('验收用例：只返回被编辑的那个文件，正文里的 path/dest 不是请求路径', () => {
    assert.deepEqual(extractPaths(b1Frame()), ['/p/a.json'])
    assert.deepEqual(extractStructuredPaths(b1Frame()), ['/p/a.json'])
  })

  it('正文键逐个剪枝：newText/oldText/new_string/old_string/content[].content.text', () => {
    const cases = [
      { rawInput: { file_path: '/p/a.json', new_string: '{"dest":"~/.ssh/id_rsa"}' } },
      { rawInput: { file_path: '/p/a.json', old_string: '{"path":"/etc/passwd"}' } },
      { rawInput: { file_path: '/p/a.json', newText: '{"dest":"~/.ssh/id_rsa"}' } },
      { rawInput: { file_path: '/p/a.json', oldText: '{"path":"/etc/shadow"}' } },
      { rawInput: { file_path: '/p/a.json' }, content: [{ type: 'diff', newText: '{"dest":"~/.ssh/id_rsa"}' }] },
      { rawInput: { file_path: '/p/a.json' }, content: [{ type: 'content', content: { text: '{"path":"/etc/passwd"}' } }] },
      { rawInput: { file_path: '/p/a.json', content: '{"dest":"~/.ssh/id_rsa"}' } },
    ]
    for (const extra of cases) {
      const frame = { kind: 'edit', ...extra }
      assert.deepEqual(extractPaths(frame), ['/p/a.json'],
        `${JSON.stringify(extra)}：正文里的 JSON 一条都不许进请求集合`)
    }
  })

  it('差分证明：同样的正文 JSON，旧实现确实会把它当结构化路径收进来', () => {
    // ① 旧的全量文本扫描（0.7.8 实现，仍在仓库里，只作差分）确实会抓到正文里的路径
    const loose = scanPathsLoose(b1Frame())
    assert.ok(loose.includes('/etc/passwd'), `旧文本扫描确实抓到了正文里的 /etc/passwd（实际 ${JSON.stringify(loose)}）`)
    assert.ok(loose.includes('~/.ssh'), '同样抓到 ~/.ssh —— 本 fixture 复现的是真实现场，不是恰好为空的弱断言')
    // ② 旧的结构化下钻分支（已删除，这里逐字复刻**仅**用于差分）：对任意字符串 try JSON.parse
    const legacyDrill = (node, depth = 0) => {
      const found = []
      const walk = (n, d) => {
        if (n === null || n === undefined || d > 6) return
        if (typeof n === 'string') {
          if (n.trim().startsWith('{') || n.trim().startsWith('[')) {
            try { walk(JSON.parse(n), d + 1) } catch { /* 非 JSON 字符串 */ }
          }
          return
        }
        if (Array.isArray(n)) { for (const x of n) walk(x, d); return }
        if (typeof n !== 'object') return
        for (const [k, v] of Object.entries(n)) {
          if (k === 'path' || k === 'dest') {
            if (typeof v === 'string' && v.trim()) found.push(v.trim())
          }
          walk(v, d + 1)
        }
      }
      walk(node, 0)
      return found
    }
    const legacyFound = legacyDrill(b1Frame())
    assert.ok(legacyFound.includes('/etc/passwd') && legacyFound.includes('~/.ssh'),
      `旧下钻分支确实从正文里取到了这两条（实际 ${JSON.stringify([...legacyFound].sort())}）——修复前后的差别能被这条用例抓住（把下钻改回去即转红）`)
    assert.equal(legacyFound.includes('/p/a.json'), true,
      '旧的把正文假路径与真目标混进同一个集合：这正是 B-1 的危险之处（无法区分内容与客体）')
    assert.deepEqual(extractStructuredPaths(b1Frame()), ['/p/a.json'], '修复后只剩真目标')
  })

  it('容器键下钻仍然保留：arguments 的 JSON 字符串照常解析（不能因噎废食）', () => {
    assert.deepEqual(extractPaths({ arguments: JSON.stringify({ path: '/Users/arming/.dsh/AGENTS.md' }) }),
      ['/Users/arming/.dsh/AGENTS.md'])
    assert.deepEqual(extractStructuredPaths({ kind: 'edit', arguments: JSON.stringify({ file_path: '/p/b.json', dest: '/tmp/out' }) }),
      ['/p/b.json', '/tmp/out'])
  })

  it('下钻只对容器键开放：JSON 字符串放在别的键下不下钻（不再"任意字符串都 try parse"）', () => {
    assert.deepEqual(extractStructuredPaths({ kind: 'edit', notAKey: JSON.stringify({ path: '/etc/passwd' }) }), [],
      '非容器键下的 JSON 字符串不下钻——这是 B-1 的第二个入口')
    assert.deepEqual(extractStructuredPaths({ kind: 'edit', rawInput: JSON.stringify({ file_path: '/p/c.json' }) }), [],
      'rawInput 以 JSON 字符串下发的形状未被确证，不纳入容器键（要支持得显式加进 CONTAINER_KEYS）')
  })

  it('JSON 正文里嵌套多层的正文键同样被剪枝（content[].content.text 是常用形状）', () => {
    const frame = {
      kind: 'write',
      content: [{ type: 'content', content: { text: JSON.stringify({ file_path: '/etc/passwd', dest: '/Users/arming/.ssh/id_rsa' }) } }],
      rawInput: { file_path: '/p/notes.json' },
    }
    assert.deepEqual(extractPaths(frame), ['/p/notes.json'])
  })
})

// ── v0.7.9（第三轮复审 Major-1）：黑名单 → **递归白名单** ─────────────────────────
//
// 现场（终审探针 `b1extract.mjs` 的 F 组原文）：剪枝只按键名、不看值类型 ⇒ 值若是
// 对象/数组照常下钻、命中 PATH_KEYS 即进产物：
//   `rawInput.content` 为对象     ⇒ ["/p/a.json","/etc/passwd"]
//   `arguments.content` 为对象    ⇒ 同样
//   `rawInput.body` 为对象        ⇒ ["/p/a.json","~/.ssh"]
//   `rawInput.edits[]` 内层对象   ⇒ ["/p/a.json","/etc/passwd"]
// 而产物是**唯一**能自动变成规则的集合 ⇒ 正文形状一换就把假路径写进授权集。
//
// 修法：只允许 `rawInput`/`arguments`/`content`/`locations`/`_meta` 这些**结构键**
// 继续下钻（外加 PATH_KEYS 那一层的取值），其余键视为**数据整棵剪掉**。
// 权衡（写在 lib/bridges/acp.js 的 descendPathValue 注释里，方向 **fail-closed**）：
// `arguments.content` 这类"结构键名出现在工具参数里"的歧义按**正文**处理（少预填，
// 需要用户手填），而 `content[]` 块数组（有 `type` 字段）照旧取块内 `path`。
describe('v0.7.9 第三轮复审 Major-1：正文以对象形状下发也不得进结构化提取（递归白名单）', () => {
  const TARGET = '/p/a.json'
  it('F 组四条（终审探针原文载荷）：只有真目标，正文对象里的路径一条都不进', () => {
    const cases = [
      ['rawInput.content 为对象', { kind: 'edit', rawInput: { file_path: TARGET, content: { path: '/etc/passwd' } } }],
      ['arguments.content 为对象', { kind: 'edit', arguments: { file_path: TARGET, content: { path: '/etc/passwd' } } }],
      ['rawInput.body 为对象', { kind: 'edit', rawInput: { file_path: TARGET, body: { dest: '~/.ssh' } } }],
      ['rawInput.edits[] 内层对象', { kind: 'edit', rawInput: { file_path: TARGET, edits: [{ path: '/etc/passwd' }] } }],
    ]
    for (const [label, frame] of cases) {
      assert.deepEqual(extractPaths(frame), [TARGET], `${label}：正文对象里的路径不得进产物`)
      assert.deepEqual(extractStructuredPaths(frame), [TARGET])
    }
  })

  it('content[].content.text 的值是对象时同样剪枝（BODY_KEY 不看值类型）', () => {
    const frame = { kind: 'edit', content: [{ type: 'content', path: TARGET, content: { text: { path: '/etc/passwd' } } }] }
    // ⚠️ v0.7.9（第六轮裁定）**更正既有断言**（改前原文见下行注释）：
    //   改前：`assert.deepEqual(extractPaths(frame), [TARGET])`
    //   改后：期望 `[]`（连 TARGET 也不取）。两条理由，缺一都不足以定案：
    //   ① **块级 `path` 只对 `diff` 成立**（`FRAME_PATH_BLOCK_TYPES = new Set(['diff'])`）。
    //      ACP 的 `ToolCallContent::Content` 变体是 `{type:'content', content:{…}}`，
    //      它**没有 `path` 字段** —— 帧里那个 `path: TARGET` 不是规范字段，是正文对象里的
    //      一个键。改前那条断言在为**一个不存在的 ACP 形状**背书：它要求实现必须收下
    //      `type:'content'` 块身上的 `path`，而这正是第五轮 B5 探针
    //      （`content:[{type:'TEXT', path:'/etc/passwd'}]`）的同族 —— 只要"块类型名单"
    //      里留着 `content`，就等于给"给正文对象换个 type 值"留了一条常驻的偷渡通道。
    //   ② 它同时充当了偷渡通道的**挡箭牌**：上一轮正是为了保住这条断言，才把
    //      `FRAME_PATH_BLOCK_TYPES` 从 `['diff']` 放宽到 `['diff','content']`（见
    //      `lib/bridges/acp.js` 里那段"本轮刻意保留"的注释）。断言与实现互相为对方
    //      的不收紧背书 —— 这就是"五轮都关不干净"的机制之一。
    //   代价（明确记录、方向 fail-closed）：真实 `type:'content'` 块不产出路径 ⇒
    //   少预填一条，用户手填。真帧零损失：`diff` 块照旧（Edit 帧目标文件的主来源），
    //   `content` 块的**真字段**是 `content`（正文载体），本来就不是请求客体。
    assert.deepEqual(extractPaths(frame), [], '第六轮裁定：path 只对 diff 块成立 ⇒ type:"content" 块身上的 path 是正文（改前期望为 [TARGET]）')
    // 反向（不因噎废食）：`diff` 块照旧取，两个入口共用同一道闸
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: TARGET, content: { text: { path: '/etc/passwd' } } }] }),
      [TARGET], '同为块内 content 下钻形状，diff 块自身是帧字段 ⇒ 取；内层 content 仍不下钻')
  })

  it('递归白名单的边界：只有结构键能下钻，任意数据键内的路径形状一律不通', () => {
    // 这些都是"给个新键名就漏"的形状：白名单下全部拿不到
    for (const key of ['notAKey', 'patch', 'diff', 'data', 'value', 'edits', 'changes', 'preview']) {
      const frame = { kind: 'edit', rawInput: { file_path: TARGET, [key]: { path: '/etc/passwd' } } }
      assert.deepEqual(extractPaths(frame), [TARGET], `rawInput.${key} 是数据键 ⇒ 整棵剪掉`)
      const arr = { kind: 'edit', rawInput: { file_path: TARGET, [key]: [{ path: '/etc/passwd' }] } }
      assert.deepEqual(extractPaths(arr), [TARGET], `rawInput.${key}[] 同样是数据键`)
    }
  })

  it('结构性来源一个都不许砍：content[] 块 path / locations / rawInput / arguments 全保留', () => {
    // content[] 块数组（Edit/Write 目标文件的主来源）
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: '/proj/a.ts' }, { type: 'diff', path: '/proj/b.ts' }] }),
      ['/proj/a.ts', '/proj/b.ts'])
    // 说明（诚实声明，方向 fail-closed）：块**内层**的 `content` 是**块的内容**、不是
    // 本次请求的客体 ⇒ 不再下钻。改前它靠"内层有没有 `type`"决定：内层**无** `type`
    // 时被剪掉（本轮之前的措辞只说到这一半，比实际行为更宽），内层**带** `type` 时
    // 仍被当块下钻、取到 `/proj/c.ts`。现在两条都不取（措辞与实现一致）。
    // 代价 = 少预填一条路径（用户手填），收益 = 关闭"换个键名/加个 type 就漏"的口子。
    // 真实 qoder/ACP Edit 帧零损失：G3/G4/G5 三组真载荷只含真目标。
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: '/proj/a.ts', content: { path: '/proj/c.ts' } }] }),
      ['/proj/a.ts'])
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: '/proj/a.ts', content: { type: 'diff', path: '/proj/c.ts' } }] }),
      ['/proj/a.ts'], '内层带 type 同样不下钻（改前这一条会多出 /proj/c.ts）')
    // locations 块数组 / 纯字符串两种形状
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }, { file: '/proj/b.txt' }] }), ['/proj/a.txt', '/proj/b.txt'])
    assert.deepEqual(extractPaths({ locations: ['/proj/a.txt'] }), ['/proj/a.txt'])
    // rawInput / arguments 信封
    assert.deepEqual(extractPaths({ rawInput: { filePath: '/proj/camel.txt' } }), ['/proj/camel.txt'])
    assert.deepEqual(extractPaths({ arguments: { path: '/proj/arg.txt' } }), ['/proj/arg.txt'])
    assert.deepEqual(extractPaths({ arguments: JSON.stringify({ file_path: '/p/b.json', dest: '/tmp/out' }) }), ['/p/b.json', '/tmp/out'])
    // `_meta` **不再是结构键**（第四轮终审阻断③）：命名空间信封里的 `path`/`dest`
    // 一律当数据剪掉（改前 `_meta:{dest:'…'}` 会把那条路径收进产物）。
    assert.deepEqual(extractPaths({ _meta: { qoder: { toolName: 'Bash', path: '/etc/passwd' } }, rawInput: { file_path: TARGET } }), [TARGET])
    assert.deepEqual(extractPaths({ _meta: { dest: '/etc/passwd' }, rawInput: { file_path: TARGET } }), [TARGET])
  })

  it('深度护栏：纯数组嵌套不再能绕过（数组分支递增 depth）', () => {
    let node = { path: '/proj/deep.txt' }
    for (let i = 0; i < 200; i += 1) node = { rawInput: [node] }
    assert.deepEqual(extractStructuredPaths(node), [], '数组嵌套每层都递增 depth ⇒ 到护栏即停')
  })
})

// ── v0.7.9（第四轮终审**阻断**）：块形状判定 + 「只认 toolCall 顶层」+ `_meta` 出白名单 ──
//
// 终审探针原文（改前实测，四条各自把正文里的路径送进了 `extractPaths`）：
//   `{kind:'edit', rawInput:{file_path:'/p/a.json', content:{type:'module', path:'/etc/passwd'}}}`
//     ⇒ ["/p/a.json","/etc/passwd"]（`isContentBlock` 只看"有没有 type"）
//   `… content:[{type:'object', path:'/etc/passwd'}]` ⇒ 同样
//   `{kind:'edit', rawInput:{file_path:'/p/a.json', files:[{content:{path:'/etc/passwd'}}]}}`
//     ⇒ 同样（`descendPathValue` 的数组分支**完全没有**形状判定）
//   `_meta:{dest|path}`、`locations:{path}` ⇒ 同样（`_meta` 在白名单里 / 单对象也算位置）
// 端到端后果：带 `type` 的 Write 帧一次 `allow-session` 后，会话规则里出现 `~/.ssh`
// ⇒ 后续对 `~/.ssh/known_hosts` 的请求被**静默放行**（见 test/permission-handler-wiring.test.js）。
describe('v0.7.9 第四轮终审阻断：正文对象不得冒充 ACP 块，同名键只认 toolCall 顶层', () => {
  const TARGET = '/p/a.json'
  const LEAK = '/etc/passwd'

  it('修法①（块形状）：带 type 的正文对象不得被当块下钻 ⇒ 改回 hasOwnProperty(type) 即转红', () => {
    // ① 对象形态：
    const objFrame = { kind: 'edit', rawInput: { file_path: TARGET, content: { type: 'module', path: LEAK } } }
    assert.deepEqual(extractPaths(objFrame), [TARGET], 'type:"module" 不在 ACP 块类型名单里 ⇒ 正文对象整棵剪掉')
    assert.deepEqual(extractStructuredPaths(objFrame), [TARGET])
    // ② 数组形态（`content` 是数组、元素带任意 type）：
    const arrFrame = { kind: 'edit', rawInput: { file_path: TARGET, content: [{ type: 'object', path: LEAK }] } }
    assert.deepEqual(extractPaths(arrFrame), [TARGET], 'type:"object" 同样不在名单里')
    // ③ 连"看起来像真块"的 type 也不放行——因为它在 `rawInput.content` 下（修法②才是这一条的闸）
    const realTypeFrame = { kind: 'edit', rawInput: { file_path: TARGET, content: [{ type: 'diff', path: LEAK }] } }
    assert.deepEqual(extractPaths(realTypeFrame), [TARGET], 'rawInput.content 下的同名键一律当正文（修法②）')
    // ④ **顶层** content 里的 type 不在 ACP 名单 ⇒ 也不是块。这一组专门钉"类型白名单"本身：
    //    把 isContentBlock 改回"有 `type` 字段就是块"，下面两条立刻转红（转红验证的哨兵）。
    const topObj = { kind: 'edit', rawInput: { file_path: TARGET }, content: { type: 'module', path: LEAK } }
    assert.deepEqual(extractPaths(topObj), [TARGET], '顶层单个 content 对象、type 不在名单 ⇒ 当数据剪掉')
    const topArr = { kind: 'edit', rawInput: { file_path: TARGET }, content: [{ type: 'module', path: LEAK }] }
    assert.deepEqual(extractPaths(topArr), [TARGET], '顶层 content[] 的元素 type 不在名单 ⇒ 当数据剪掉')
    // ⑤ 反向：名单内的 type 照旧算块（白名单不能收成"什么都不认"，Edit 帧主来源不许砍）
    const topReal = { kind: 'edit', rawInput: { file_path: TARGET }, content: [{ type: 'diff', path: '/proj/real.ts' }] }
    assert.deepEqual(extractPaths(topReal), [TARGET, '/proj/real.ts'])
  })

  it('修法①（同一份谓词）：PATH_KEYS 数组分支下的 item.content 也要过块形状判定', () => {
    // 终审探针第三条：`files:[{content:{path}}]` —— 改前沿 `hasOwn(item,'content')` 直接下钻
    const frame = { kind: 'edit', rawInput: { file_path: TARGET, files: [{ content: { path: LEAK } }] } }
    assert.deepEqual(extractPaths(frame), [TARGET], '无 type 的内层 content 是正文 ⇒ 不下钻')
    const nested = { kind: 'edit', rawInput: { file_path: TARGET, files: [{ content: [{ content: { path: LEAK } }] }] } }
    assert.deepEqual(extractPaths(nested), [TARGET], '再嵌一层（数组）同样不下钻')
    // ⚠️ v0.7.9（第五轮终审阻断）：本条期望由 `[TARGET, '/proj/real.ts']` **更正**为 `[TARGET]`。
    //    改前的断言在为**一个不存在的 ACP 形状**背书：ACP 规范里工具调用内容在**顶层**
    //    `content[]`；`rawInput.files[].content` 只是**工具参数正文**（被编辑文件里写着
    //    一段看起来像块的内容，并不会让它变成块）。`type` 只是正文对象里的一个键、
    //    正文完全可控 ⇒ 只要在这一支下钻，"给正文对象加个 `type:'diff'`"就能把正文里的
    //    任意路径送进产物（终审探针：23 个 PATH_KEYS 命中 22 个；端到端一次 `allow-session`
    //    后 `~/.ssh` 进会话规则、此后对 `~/.ssh/known_hosts` 的请求被静默放行）。
    //    真帧零损失：`content[]` 块内的路径由 `walk` 的**顶层** `k === 'content'` 分支收集。
    const rawBodyNotBlock = { kind: 'edit', rawInput: { file_path: TARGET, files: [{ content: [{ type: 'diff', path: '/proj/real.ts' }] }] } }
    assert.deepEqual(extractPaths(rawBodyNotBlock), [TARGET], 'rawInput.files[].content 是工具参数正文 ⇒ 即便内层带 ACP 名单内的 type 也不下钻')
    // 反向（替代原断言的"不能因噎废食"哨兵）：**顶层** content[] 里的真块照旧取块内路径
    const topRealBlock = { kind: 'edit', rawInput: { file_path: TARGET }, content: [{ type: 'diff', path: '/proj/real.ts' }] }
    assert.deepEqual(extractPaths(topRealBlock), [TARGET, '/proj/real.ts'], '真块（顶层 content[]）仍要取块内路径')
  })

  it('修法②（只认顶层）：arguments/rawInput 下的 content·locations 一律当正文', () => {
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: { file_path: TARGET, content: { type: 'module', path: LEAK } } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: { file_path: TARGET, content: [{ type: 'diff', path: LEAK }] } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, locations: { path: LEAK } } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, locations: [{ path: LEAK }] } }), [TARGET])
    // 反向：**顶层** content[]/locations[] 照旧（真实 Edit 帧的主来源，不许砍）
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: '/proj/a.ts' }], rawInput: { file_path: TARGET } }), ['/proj/a.ts', TARGET])
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }] }), ['/proj/a.txt'])
  })

  it('修法③（_meta 出白名单）：命名空间信封里的 path/dest 不再进产物', () => {
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET }, _meta: { dest: LEAK } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET }, _meta: { path: LEAK } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET }, _meta: { qoder: { path: LEAK, dest: LEAK } } }), [TARGET])
  })

  it('Minor-2（统一口径）：locations 也吃块形状判定（单个对象 / 非位置数组 ⇒ 数据）', () => {
    assert.deepEqual(extractPaths({ locations: { path: LEAK } }), [], '单个对象不是 ACP 形状（locations 恒为数组）')
    assert.deepEqual(extractPaths({ locations: [{ content: { path: LEAK } }] }), [], '元素既不是位置块也不是字符串 ⇒ 整棵剪掉')
    assert.deepEqual(extractPaths({ locations: [] }), [], '空数组 ⇒ 无目标')
    // 位置块的三种合法写法照旧
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }, { file: '/proj/b.txt' }, { uri: 'file:///tmp/c.txt' }] }),
      ['/proj/a.txt', '/proj/b.txt', '/tmp/c.txt'])
    assert.deepEqual(extractPaths({ locations: ['/proj/a.txt'] }), ['/proj/a.txt'])
  })

  it('Minor-3（口径一致）：带 throwing getter 的载荷不抛，且可读的路径字段照常收集', () => {
    const frame = { kind: 'edit', rawInput: { file_path: TARGET } }
    Object.defineProperty(frame.rawInput, 'path', { get() { throw new Error('boom') }, enumerable: true })
    assert.deepEqual(extractPaths(frame), [TARGET], '抛的那个键被跳过，file_path 照常取到（与 execute-frame.js 的 own() 同口径）')
    const nested = { kind: 'edit', rawInput: { path: '/proj/ok.txt' } }
    Object.defineProperty(nested, 'content', { get() { throw new Error('boom') }, enumerable: true })
    assert.deepEqual(extractPaths(nested), ['/proj/ok.txt'])
  })

  it('差分证明：旧判定（有 type 即块）确实会把这几条路径收进产物', () => {
    // 逐字复刻旧谓词**仅**用于差分：证明上面的期望不是"恰好为空的弱断言"
    const legacyIsBlock = (v) => !!v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'type')
    const legacyLeak = (node, depth = 0, atTop = true) => {
      const found = []
      const walk = (n, d, top) => {
        if (n === null || n === undefined || d > 6) return
        if (typeof n === 'string') return
        if (Array.isArray(n)) { for (const x of n) walk(x, d + 1, top); return }
        if (typeof n !== 'object') return
        for (const [k, v] of Object.entries(n)) {
          const isPathKey = ['path', 'dest', 'file_path'].includes(k)
          if (isPathKey && typeof v === 'string' && v.startsWith('/')) found.push(v)
          if (k === 'rawInput' || k === 'arguments' || k === '_meta') { walk(v, d + 1, top); continue }
          if (k === 'content' || k === 'locations') {
            if (Array.isArray(v)) { for (const x of v) { if (legacyIsBlock(x)) walk(x, d + 1, top) } }
            else if (legacyIsBlock(v)) walk(v, d + 1, top)
          }
        }
      }
      walk(node, 0, atTop)
      return found
    }
    for (const [label, frame] of [
      ['rawInput.content 带 type', { kind: 'edit', rawInput: { file_path: TARGET, content: { type: 'module', path: LEAK } } }],
      ['rawInput.content[] 带 type', { kind: 'edit', rawInput: { file_path: TARGET, content: [{ type: 'object', path: LEAK }] } }],
      ['_meta.dest', { kind: 'edit', rawInput: { file_path: TARGET }, _meta: { dest: LEAK } }],
    ]) {
      assert.ok(legacyLeak(frame).includes(LEAK), `旧判定下 ${label} 确实把 ${LEAK} 当成了结构化路径（本 fixture 复现的是真实现场）`)
      assert.equal(extractPaths(frame).includes(LEAK), false, `新判定下 ${label} 拿不到它`)
    }
  })
})

// ── v0.7.9（第五轮终审**阻断**）：`descendPathValue` 数组分支漏 `atTop` 约束 + 块级 `path` 过宽 ──
//
// 终审探针原文（改前实测）：
//   ③原始（无 type）—— 第四轮已修          => ["/p/a.json"]
//   ③+type:"diff" —— 只加一个键            => ["/p/a.json","/etc/passwd"]
//   ③+type:"text"                          => ["/p/a.json","/etc/passwd"]
//   同族：paths[].content / dest[].content / directory[].content / locations[].content + type
//                                          => 同样
// 根因：第四轮把"块数组资格只给 toolCall 顶层"加在 `walk` 的 `content`/`locations` 键分支，
// **漏了 `descendPathValue` 数组分支**那份同形下钻；而判"是不是块"的 `isContentBlock` 只看
// `type` 是否在白名单内 —— `type` 只是**正文对象里的一个键**，正文完全可控 ⇒ 白名单对
// 「帧字段」是有效判别器，对「正文」不是。端到端后果：带 `type` 的 Write 帧一次
// `allow-session` 后会话规则里出现 `~/.ssh`，此后对 `~/.ssh/known_hosts` 的请求
// **pending=0**（静默放行）；见 test/permission-handler-wiring.test.js 同名 describe。
describe('v0.7.9 第五轮终审阻断：正文数组元素的 content 不得再下钻，块级 path 只认帧级块类型', () => {
  const TARGET = '/p/a.json'
  const LEAK = '/etc/passwd'
  const TARGET_KEYS = [
    'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'notebook_path',
    'absolute_path', 'target_file', 'target_path', 'target',
    'dir', 'dirs', 'dir_path', 'directory', 'directories',
    'dest', 'destination', 'src', 'source', 'uri', 'location', 'locations',
  ]

  it('阻断：23 个 PATH_KEYS × {content:{…}} / {content:[{…}]} 两种形状，全部只剩真目标', () => {
    assert.equal(TARGET_KEYS.length, 23, '终审点名的会因 item.content 下钻而泄漏的键共 23 个')
    for (const key of TARGET_KEYS) {
      // TARGET 放在一个**必然 != key** 的路径键上（`key` 自身装被测数组，会覆盖同名字段）
      const carrier = key === 'file_path' ? 'notebook_path' : 'file_path'
      for (const [shape, inner] of [
        ['对象', { content: { type: 'diff', path: LEAK } }],
        ['数组', { content: [{ type: 'diff', path: LEAK }] }],
      ]) {
        const frame = { kind: 'edit', rawInput: { [carrier]: TARGET, [key]: [inner] } }
        assert.deepEqual(extractPaths(frame), [TARGET], `rawInput.${key}[] 的 ${shape} content 是工具参数正文 ⇒ 不下钻`)
      }
    }
  })

  it('阻断（第四轮已修的载荷 + 一个 type 键）：加 type 也不得复漏', () => {
    const base = { kind: 'edit', rawInput: { file_path: TARGET, files: [{ content: { path: LEAK } }] } }
    assert.deepEqual(extractPaths(base), [TARGET], '第四轮已修：无 type 的内层 content 不下钻')
    for (const type of ['diff', 'text', 'TEXT', 'Diff']) {
      const withType = { kind: 'edit', rawInput: { file_path: TARGET, files: [{ content: { type, path: LEAK } }] } }
      assert.deepEqual(extractPaths(withType), [TARGET], `files[].content 是正文 ⇒ type:"${type}" 不改变结论`)
    }
  })

  it('Minor-4（X1）：顶层 content 块的 path 是数组、内嵌带 type 的 content 块也不得偷渡', () => {
    const frame = { content: [{ type: 'diff', path: [LEAK, { content: { type: 'diff', path: '/etc/shadow' } }] }] }
    assert.deepEqual(extractPaths(frame), [LEAK], '元素自身的 path 是帧字段（取），内嵌 content 块不是（不取）')
  })

  it('locations 数组元素下钻自己的 content 也要停（终审同族：locations[].content + type）', () => {
    // 位置项没有 `type` ⇒ 不是块；它的 `content` 同样不是本次请求的客体
    assert.deepEqual(extractPaths({ locations: [{ path: '/p/a.txt', content: { type: 'diff', path: LEAK } }] }), ['/p/a.txt'])
    assert.deepEqual(extractPaths({ locations: [{ path: '/p/a.txt', content: [{ type: 'diff', path: LEAK }] }] }), ['/p/a.txt'])
    // 承载 TARGET 的形状（rawInput.locations 下的同名键一律当正文；顶层 locations 才取）
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, locations: [{ path: '/p/a.txt', content: { type: 'diff', path: LEAK } }] } }),
      [TARGET], 'rawInput.locations 是正文 ⇒ 连 /p/a.txt 都不取')
  })

  it('Major-1：块级 `path` 只对帧级块类型（仅 diff）成立，其余块类型不认', () => {
    // 阴性：这些块类型在 ACP 里**没有** path 字段（text 在 `text`、resource_link 在 `uri`…）
    // v0.7.9（第六轮裁定）：`content` 从豁免名单**移入本列表** —— ACP 的 `content` 变体是
    // `{type:'content', content:{…}}`（正文载体），它没有 `path` 字段。它此前被豁免是
    // 为保住一条为不存在的形状背书的既有断言（见本文件「第三轮复审 Major-1」describe
    // 里那条更正的期望），那条断言本轮已更正 ⇒ 豁免的理由消失。
    for (const type of ['text', 'TEXT', 'Text', 'image', 'audio', 'resource_link', 'resource', 'terminal', 'content', 'CONTENT']) {
      assert.deepEqual(extractPaths({ content: [{ type, path: LEAK }] }), [],
        `type:"${type}" 不是帧级块类型 ⇒ 它身上的 path 是正文`)
    }
    // 阳性（不因噎废食）：帧级块类型的 path 照旧取
    assert.deepEqual(extractPaths({ content: [{ type: 'diff', path: '/proj/a.ts' }] }), ['/proj/a.ts'])
    assert.deepEqual(extractPaths({ content: [{ type: 'DIFF', path: '/proj/a.ts' }] }), ['/proj/a.ts'], 'type 大小写不敏感（终审 B5 用 TEXT 做阴性，同口径折小写）')
    // 其它路径字段别名不受此限（位置块 {uri}/{file} 是既有形状）
    assert.deepEqual(extractPaths({ locations: [{ uri: 'file:///tmp/c.txt' }, { file: '/proj/b.txt' }] }), ['/tmp/c.txt', '/proj/b.txt'])
    assert.deepEqual(extractPaths({ content: [{ type: 'text', uri: 'file:///proj/ok.txt', path: LEAK }] }), ['/proj/ok.txt'],
      'text 块的 uri 是它的真字段（取），path 不是（不取）')
  })

  it('真帧零回归：顶层 content[] / locations[] / rawInput / arguments 一个都不许砍', () => {
    // 现场真帧①–⑤ 的关键形状（qoder Edit/Write 与 opencode 系）
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET }, content: [{ type: 'diff', path: '/proj/real.ts' }] }),
      [TARGET, '/proj/real.ts'])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, old_string: 'a', new_string: 'b' }, content: [{ type: 'diff', content: { text: 'x' } }] }),
      [TARGET], 'qoder 真形状：diff 块无 path ⇒ 只有 rawInput.file_path')
    assert.deepEqual(extractPaths({ content: [{ type: 'diff', path: '/p/a.ts' }, { type: 'diff', path: '/p/b.ts' }] }), ['/p/a.ts', '/p/b.ts'], '多块 Edit')
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }, { file: '/proj/b.txt' }, { uri: 'file:///tmp/c.txt' }] }),
      ['/proj/a.txt', '/proj/b.txt', '/tmp/c.txt'])
    assert.deepEqual(extractPaths({ locations: ['/proj/a.txt'] }), ['/proj/a.txt'])
    assert.deepEqual(extractPaths({ rawInput: { filePath: '/proj/camel.txt' } }), ['/proj/camel.txt'])
    assert.deepEqual(extractPaths({ arguments: { path: '/proj/arg.txt' } }), ['/proj/arg.txt'])
    assert.deepEqual(extractPaths({ arguments: JSON.stringify({ file_path: '/p/b.json', dest: '/tmp/out' }) }), ['/p/b.json', '/tmp/out'])
  })
})

// ── v0.7.9（第六轮裁定）：信封边界 —— `rawInput`/`arguments` 下的数组一律不取路径 ────────
//
// 第五轮修完"数组元素的 `content` 不再下钻"之后仍留着一族：信封（`rawInput`/`arguments`）
// 下的**数组元素**照样按 PATH_KEYS 取值 —— `files:[{path:L}]`、`files:[{file:L}]`、
// `files:[{file_path:L}]`、`files:[{uri:L}]`、`files:[{dest:L}]`、
// `files:[{type:'text',file:L}]` 全部把**工具参数正文**里的路径送进产物。
//
// 这一族的要害是"**补键名补不完**"：`path`/`file`/`uri`/`filePath`/`file_path`/`dest`/
// `src`/`target`… 每修一个键名，下一个键名又会漏一次 —— 同一族已经吃了五轮。根因不是
// 名单不全，而是**边界错了**：只要还允许"信封里的数组按路径键取值"，就等于让**正文**
// 参与决定授权，而正文是被编辑/被写入的**内容**，仓库里任何文件都可以写着 `/etc/passwd`、
// `~/.ssh`。补名单是把一个开放式问题当成封闭式问题在修。
//
// 裁定（**两条一起才是关的**，缺一即漏）：
//   ① **只有 toolCall 顶层**的 `content[]` / `locations[]` 允许从**块内**取路径
//      （块类型仍按 `ACP_BLOCK_TYPES` 白名单，且 `path` 只对 `diff` 成立）；
//   ② **`rawInput` / `arguments` 下的数组/对象（任何键名、任何深度）一律不取路径、
//      也不下钻** —— 它们是工具参数**正文**；块内再嵌 `content` 同样不下钻；
//   ③ 但信封**顶层自己**的**标量**路径字段照旧取（`rawInput.file_path` 是 qoder Edit 帧
//      的命脉；claude/codex 的 `arguments.file_path`、以及 `arguments` 为 JSON 字符串的
//      信封形态也必须照旧工作）—— **真实帧的命脉，不许弄丢**。
//
// 产物是**唯一**能自动变成规则的路径集合（见 `extractPaths` 的 ⚠️）⇒ 方向必须 fail-closed：
// 少预填一条，用户手填；绝不能写一条从正文里猜出来的授权。
//
// 转红哨兵（两处，任一改回本 describe 立刻转红）：
//   · `walk` 的 `if (inEnv && typeof v !== 'string') continue` 去掉 ⇒ 数组重新按键名取值；
//   · `STRUCTURAL_KEYS` 分支的 `walk(v, depth + 1, k, false, true)` 把 `atTop` 重新透传
//     ⇒ 信封内 `content`/`locations` 复成"顶层块数组"（本轮实测过的回归）。
describe('v0.7.9 第六轮裁定：信封边界（rawInput/arguments 下数组一律不取路径）', () => {
  const TARGET = '/p/a.json'
  const LEAK = '/etc/passwd'
  /** 与实现同源的 23 个 PATH_KEYS（改实现名单时本列表必须同步，长度断言会先转红） */
  const TARGET_KEYS = [
    'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'notebook_path',
    'absolute_path', 'target_file', 'target_path', 'target',
    'dir', 'dirs', 'dir_path', 'directory', 'directories',
    'dest', 'destination', 'src', 'source', 'uri', 'location', 'locations',
  ]
  /** 9 种"正文里嵌了一层"的形状（L 是正文里的路径，必须一条都取不到） */
  const SHAPES = [
    ['[{path}]', (L) => [{ path: L }]],
    ['[{file}]', (L) => [{ file: L }]],
    ['[{file_path}]', (L) => [{ file_path: L }]],
    ['[{uri}]', (L) => [{ uri: L }]],
    ['[{dest}]', (L) => [{ dest: L }]],
    ["[{type:'text',file}]", (L) => [{ type: 'text', file: L }]],
    ["[{type:'diff',path}]", (L) => [{ type: 'diff', path: L }]],
    ["[{content:{type:'diff',path}}]", (L) => [{ content: { type: 'diff', path: L } }]],
    ["[{content:[{type:'diff',path}]}]", (L) => [{ content: [{ type: 'diff', path: L }] }]],
  ]

  it('验收：23 个 PATH_KEYS × 9 种形状 × 2 种信封（23 × 9 × 2 = 414 次迭代 / 828 条断言），全部只返回真目标 [TARGET]', () => {
    assert.equal(TARGET_KEYS.length, 23, '实现侧 PATH_KEYS 共 23 个；名单漂移时本断言先转红')
    let checked = 0
    for (const key of TARGET_KEYS) {
      // TARGET 放在一个**必然 != key** 的路径键上（`key` 自身装被测数组，会覆盖同名字段）
      const carrier = key === 'file_path' ? 'notebook_path' : 'file_path'
      for (const [label, shape] of SHAPES) {
        for (const [envName, wrap] of [
          ['rawInput', (v) => ({ kind: 'edit', rawInput: { [carrier]: TARGET, [key]: v } })],
          ['arguments', (v) => ({ kind: 'edit', arguments: { [carrier]: TARGET, [key]: v } })],
        ]) {
          const frame = wrap(shape(LEAK))
          assert.deepEqual(extractStructuredPaths(frame), [TARGET], `${envName}.${key} = ${label} ⇒ 信封下的数组是工具参数正文，一条都不取`)
          assert.deepEqual(extractPaths(frame), [TARGET], `${envName}.${key} = ${label}（含兜底）`)
          checked += 1
        }
      }
    }
    assert.equal(checked, 23 * 9 * 2, '形状矩阵必须跑满（防"循环提前退出"式的假绿）')
  })

  it('同族一次关干净：信封下**对象**与**深层嵌套**同样不取路径（不只数组）', () => {
    // 对象形态：`rawInput.edits:{path:L}` —— 与数组同一族，只关数组等于没关
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, edits: { path: LEAK } } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: { file_path: TARGET, edits: { path: LEAK } } }), [TARGET])
    // 深层嵌套：数组里再套对象、再套数组（"任何深度"）
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, files: [{ a: { b: [{ path: LEAK }] } }] } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, files: [[[{ path: LEAK }]]] } }), [TARGET])
    // 裸字符串数组：`rawInput.paths:['/etc/passwd']`（本轮更正的那条既有断言的形状）
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, paths: [LEAK] } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: { file_path: TARGET, paths: [LEAK] } }), [TARGET])
    // JSON 字符串信封里的数组同样不取（信封形态换了，边界不变）
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: JSON.stringify({ file_path: TARGET, files: [{ path: LEAK }] }) }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: JSON.stringify({ file_path: TARGET, paths: [LEAK] }) }), [TARGET])
  })

  it('信封内再嵌 content/locations 也**不是**块数组（atTop 不得透传进信封）——本轮实测回归的哨兵', () => {
    // 上一版实现把 `atTop` 原样透传进信封，于是下面四条又变成"顶层块数组"、正文路径复漏。
    for (const env of ['rawInput', 'arguments']) {
      const withBlocks = (v) => ({ kind: 'edit', [env]: v })
      assert.deepEqual(extractPaths(withBlocks({ content: [{ type: 'diff', path: LEAK }] })), [],
        `${env}.content:[{type:'diff'}] 是工具参数正文里的同名键，不是顶层块数组`)
      assert.deepEqual(extractPaths(withBlocks({ content: { type: 'diff', path: LEAK } })), [],
        `${env}.content:{…} 单对象同上`)
      assert.deepEqual(extractPaths(withBlocks({ locations: [{ path: LEAK }] })), [],
        `${env}.locations:[…] 同上（位置块资格也只给顶层）`)
      assert.deepEqual(extractPaths(withBlocks({ locations: [LEAK] })), [], `${env}.locations:['…'] 同上`)
      // 带真目标一起验：正文那一条不得混进来
      assert.deepEqual(extractPaths({ kind: 'edit', [env]: { file_path: TARGET, content: [{ type: 'diff', path: LEAK }] } }), [TARGET])
      assert.deepEqual(extractPaths({ kind: 'edit', [env]: { file_path: TARGET, locations: [{ path: LEAK }] } }), [TARGET])
    }
    // 反向（不因噎废食）：toolCall **顶层**的同名键照旧是块数组
    assert.deepEqual(extractPaths({ kind: 'edit', content: [{ type: 'diff', path: '/proj/real.ts' }] }), ['/proj/real.ts'])
    assert.deepEqual(extractPaths({ kind: 'edit', locations: [{ path: '/proj/a.txt' }] }), ['/proj/a.txt'])
  })

  it('验收（任务点名）：locations[].content 不作为块取路径，位置项自身的 path 照旧取', () => {
    assert.deepEqual(extractPaths({ locations: [{ path: '/p/a.txt', content: { type: 'diff', path: LEAK } }] }), ['/p/a.txt'])
    assert.deepEqual(extractPaths({ locations: [{ path: '/p/a.txt', content: [{ type: 'diff', path: LEAK }] }] }), ['/p/a.txt'])
    assert.deepEqual(extractPaths({ locations: [{ path: '/p/a.txt', content: [{ type: 'diff', path: LEAK }] }, { path: '/p/b.txt' }] }),
      ['/p/a.txt', '/p/b.txt'])
  })

  it('验收（任务点名）：块级 `path` 只认 `diff`——text/TEXT/image/audio/resource_link/resource/terminal/content 全不产出', () => {
    for (const type of ['text', 'TEXT', 'Text', 'image', 'IMAGE', 'audio', 'resource_link', 'resource', 'terminal', 'content', 'CONTENT']) {
      assert.deepEqual(extractPaths({ content: [{ type, path: LEAK }] }), [], `type:"${type}" 在 ACP 里没有 path 字段 ⇒ 它身上的 path 是正文`)
    }
    // 阳性：diff / DIFF 照旧产出
    assert.deepEqual(extractPaths({ content: [{ type: 'diff', path: '/proj/a.ts' }] }), ['/proj/a.ts'])
    assert.deepEqual(extractPaths({ content: [{ type: 'DIFF', path: '/proj/a.ts' }] }), ['/proj/a.ts'], 'type 大小写不敏感')
    assert.deepEqual(extractPaths({ content: [{ type: 'diff', path: '/p/a.ts' }, { type: 'diff', path: '/p/b.ts' }] }), ['/p/a.ts', '/p/b.ts'], '多块 Edit')
    // 阳性：`text` 块的**真字段** `uri` 照旧产出（path 不产出）
    assert.deepEqual(extractPaths({ content: [{ type: 'text', uri: 'file:///proj/ok.txt', path: LEAK }] }), ['/proj/ok.txt'])
    // 两个入口共用同一道闸：`locations` 里的块形状（位置项一般无 type ⇒ 不受限）
    assert.deepEqual(extractPaths({ locations: [{ type: 'diff', path: '/p/a.txt' }] }), ['/p/a.txt'])
  })

  it('真帧零损失：真①–⑤ / 多块 content[] / locations[] 三写法 / arguments JSON 字符串信封 一个都不许砍', () => {
    // 真① qoder Edit：目标在 rawInput.file_path；diff 块无 path（正文在 content.text）
    assert.deepEqual(extractPaths({ kind: 'edit', name: 'Edit', title: 'Edit a.ts', rawInput: { file_path: '/proj/a.ts', old_string: 'x', new_string: 'y' }, content: [{ type: 'diff', content: { text: 'z' } }] }),
      ['/proj/a.ts'])
    // 真② Write：目标在 rawInput.file_path，diff 块也带 path（同一条路径，去重）
    assert.deepEqual(extractPaths({ kind: 'write', name: 'Write', rawInput: { file_path: '/proj/b.ts' }, content: [{ type: 'diff', path: '/proj/b.ts', newText: 'z' }] }),
      ['/proj/b.ts'])
    // 真③ opencode 系：顶层 locations[]
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/c.ts' }] }), ['/proj/c.ts'])
    // 真④ claude/codex 系：arguments.file_path（对象信封）
    assert.deepEqual(extractPaths({ name: 'Edit', arguments: { file_path: '/proj/d.ts', old_string: 'a', new_string: 'b' } }), ['/proj/d.ts'])
    // 真⑤ 老模型：arguments 是 JSON 字符串信封（含 camelCase / snake_case 混用）
    assert.deepEqual(extractPaths({ name: 'Write', arguments: JSON.stringify({ filePath: '/proj/e.ts', content: 'body' }) }), ['/proj/e.ts'])
    assert.deepEqual(extractPaths({ name: 'Write', arguments: JSON.stringify({ notebook_path: '/proj/f.ipynb' }) }), ['/proj/f.ipynb'])
    // 信封顶层标量：`path` / `file` / `uri` / `dest` 四个别名照旧
    assert.deepEqual(extractPaths({ rawInput: { path: '/proj/g.ts' } }), ['/proj/g.ts'])
    assert.deepEqual(extractPaths({ rawInput: { file: '/proj/h.ts' } }), ['/proj/h.ts'])
    assert.deepEqual(extractPaths({ rawInput: { dest: '/proj/i.ts' } }), ['/proj/i.ts'])
    assert.deepEqual(extractPaths({ arguments: JSON.stringify({ file_path: '/p/b.json', dest: '/tmp/out' }) }), ['/p/b.json', '/tmp/out'])
    // 信封顶层标量 + 信封内数组同时出现：只取标量那一条（新口径的核心读数）
    assert.deepEqual(extractPaths({ kind: 'edit', rawInput: { file_path: TARGET, files: [{ path: LEAK }, { file: LEAK }] } }), [TARGET])
    assert.deepEqual(extractPaths({ kind: 'edit', arguments: JSON.stringify({ file_path: TARGET, files: [{ path: LEAK }] }) }), [TARGET])
    // 多块 content[] + locations[] 三写法（path / file / uri）+ 纯字符串
    assert.deepEqual(extractPaths({ content: [{ type: 'diff', path: '/p/a.ts' }, { type: 'diff', path: '/p/b.ts' }] }), ['/p/a.ts', '/p/b.ts'])
    assert.deepEqual(extractPaths({ locations: [{ path: '/proj/a.txt' }, { file: '/proj/b.txt' }, { uri: 'file:///tmp/c.txt' }] }),
      ['/proj/a.txt', '/proj/b.txt', '/tmp/c.txt'])
    assert.deepEqual(extractPaths({ locations: ['/proj/a.txt'] }), ['/proj/a.txt'])
  })
})
