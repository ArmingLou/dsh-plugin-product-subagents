// v0.7.9 缺口C：requestPermission 载荷日志的**结构化摘要**测试。
//
// 现场痛点：旧实现打的是 `JSON.stringify(params.toolCall).slice(0, 500)`。Edit/Write
// 帧的 `newText`/`new_string` 动辄几 KB，排在正文之后的字段被整段挤出 500 字符窗口。
// 本文件因此把「丢了什么」逐条写清楚（差分断言，两个方向都断）：
//   · 旧写法**并非什么都打不出**——`toolCallId`/`kind`/`title`/`rawInput.file_path`
//     因为在 JSON 里排在正文之前，仍然露得出来（下面的用例如实承认这一点）；
//   · 被挤掉的是排在正文**之后**的那些：`content[].path`（diff 块目标文件）、
//     `_meta.qoder.toolName`（qoder 唯一真工具名）、`rawInput` 的完整键名；
//   · 若产品把 `content` 排在前面（各产品字段顺序并不统一，这里两个形状都测），
//     那么连被编辑文件的路径都会消失——这正是历次取证拿不到路径的现场。
// 新摘要不受该窗口约束：每个字段各自限长、互不挤占，正文预览单独限长（默认 200）。
//
// 另加一条源码不变量：调用点上那个 `slice(0, 500)` 不许回来（注释里提它无害）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { logRequestPermissionToolCall, summarizeToolCallForLog } from '../lib/bridges/acp.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const acpSrc = readFileSync(path.join(repoRoot, 'lib', 'bridges', 'acp.js'), 'utf8')

/** 0.7.8 的旧写法逐字复刻，仅用于「修复前丢哪些字段、修复后一个不丢」的双向断言 */
const legacyLog = (params) => `requestPermission ${JSON.stringify(params.toolCall)?.slice(0, 500)}`

const DIFF_PATH = '/Volumes/proj/lib/permission-rules.js'
/** 约 10KB 正文：足够把 500 字符窗口吃干 */
const BIG_BODY = `${'const re = /[A-Za-z]:[\\\\/]/.test(p)\n'.repeat(250)}`
const BIG_ONE_LINE = BIG_BODY.replace(/[\r\n\t]+/g, ' ')

/** 形状①：rawInput（含 10KB new_string）排在 content 之前 —— Edit 帧常见形状 */
const EDIT_FRAME_RAWFIRST = {
  toolCallId: 'call_edit_bigbody_1',
  kind: 'edit',
  title: 'Edit permission-rules.js',
  rawInput: { file_path: DIFF_PATH, old_string: 'const x = 1', new_string: BIG_BODY },
  content: [{ type: 'diff', path: DIFF_PATH, newText: BIG_BODY, oldText: 'const x = 1' }],
  _meta: { qoder: { toolName: 'Edit' } },
  status: 'pending',
}

/** 形状②：正文块排在 diff 块之前（qoder 实测就是这个位置）⇒ 旧写法把 diff 路径整条挤没 */
const EDIT_FRAME_CONTENTFIRST = {
  content: [
    { type: 'content', content: { text: BIG_BODY } },
    { type: 'diff', path: DIFF_PATH, newText: 'x' },
  ],
  toolCallId: 'call_edit_contentfirst_2',
  kind: 'edit',
  title: 'Edit permission-rules.js',
  rawInput: { file_path: DIFF_PATH, new_string: 'x' },
  _meta: { qoder: { toolName: 'Edit' } },
}

/** qoder Bash 帧：既无 name 也无 toolName，真名只在 _meta.qoder.toolName */
const QODER_BASH_FRAME = {
  _meta: { qoder: { toolName: 'Bash' } },
  content: [{ content: { text: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin' }, type: 'content' }],
  kind: 'execute',
  rawInput: { command: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin', description: 'List node bin dir' },
  status: 'pending',
  title: 'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin',
  toolCallId: 'call_19e6d181e8be4bfb942073ce',
}

/** 捕获 console.warn（logRequestPermissionToolCall 的诊断通道 = stderr） */
const captureWarn = (fn) => {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return lines.join('')
}

describe('缺口C：结构化摘要必须无条件打出关键字段', () => {
  it('Edit 帧（10KB 正文）：toolCallId/kind/diff path/_meta 工具名/rawInput 键名全部在场且单行', () => {
    const out = summarizeToolCallForLog(EDIT_FRAME_RAWFIRST)
    assert.equal(out.includes('\n'), false, '日志必须一行一条（正文里的换行不得把它切断）')
    assert.match(out, /toolCallId=call_edit_bigbody_1/)
    assert.match(out, /kind=edit/)
    assert.match(out, new RegExp(`paths=\\[${DIFF_PATH.replace(/[/.]/g, (c) => `\\${c}`)}\\]`), '被编辑文件路径是本次取证的主角')
    assert.match(out, /pathCount=1/)
    assert.match(out, /metaToolName=qoder\.Edit/)
    assert.match(out, /metaKeys=\[qoder\]/)
    assert.match(out, /rawInputKeys=\[file_path,old_string,new_string\]/, 'rawInput 打键名即可定位载荷形态')
    assert.match(out, /bodyChars=\d+/, '正文长度要如实报数')
    assert.ok(Number(out.match(/bodyChars=(\d+)/)[1]) > 500, '正文长度必须显著超过旧窗口，否则这个 fixture 证明不了什么')
  })

  it('差分①（rawInput 在前）：旧写法仍丢 content[].path 与 _meta 工具名，新写法一个不丢', () => {
    const legacy = legacyLog({ toolCall: EDIT_FRAME_RAWFIRST })
    // 如实承认旧写法没丢的部分——字段顺序决定了它能露出排在正文之前的键
    assert.ok(legacy.includes('call_edit_bigbody_1'), '旧写法能打到 toolCallId（排在最前）')
    assert.ok(legacy.includes('"kind":"edit"'), '旧写法能打到 kind')
    assert.ok(legacy.includes(DIFF_PATH), '旧写法能打到 rawInput.file_path')
    // 被 10KB 正文挤掉的字段
    assert.equal(legacy.includes('_meta'), false, '旧写法打不到 _meta ⇒ qoder 真工具名在日志里根本不存在')
    assert.equal(legacy.includes('qoder'), false, '同上：命名空间键名也被挤掉')
    assert.match(legacy, /const re/, '旧写法窗口里全是正文——历次取证失败的现场')
    assert.ok(legacy.length <= 18 + 500, `旧写法被截在 500 字符窗口内（实际 ${legacy.length}）`)

    const fixed = summarizeToolCallForLog(EDIT_FRAME_RAWFIRST)
    assert.match(fixed, /metaToolName=qoder\.Edit/, '新摘要把 _meta 工具名打了回来')
    assert.match(fixed, /pathCount=1/)
    assert.ok(fixed.length > 500, '结构化摘要不受 500 字符窗口约束（字段各自限长、互不挤占）')
  })

  it('差分②（content 在前）：旧写法连被编辑文件的路径都消失，新摘要照样打全', () => {
    const legacy = legacyLog({ toolCall: EDIT_FRAME_CONTENTFIRST })
    assert.equal(legacy.includes(DIFF_PATH), false, 'diff 块 path 排在 10KB newText 之后 ⇒ 整条被截没')
    assert.equal(legacy.includes('call_edit_contentfirst_2'), false, 'toolCallId 也跟着消失')
    assert.equal(legacy.includes('_meta'), false)
    const fixed = summarizeToolCallForLog(EDIT_FRAME_CONTENTFIRST)
    assert.ok(fixed.includes(DIFF_PATH), '新写法按字段取值打印，与载荷键序无关')
    assert.match(fixed, /toolCallId=call_edit_contentfirst_2/)
    assert.match(fixed, /metaToolName=qoder\.Edit/)
  })

  it('qoder Bash 帧：_meta 里的真工具名必现，且 title 是命令正文也不淹没字段', () => {
    const out = summarizeToolCallForLog(QODER_BASH_FRAME)
    assert.match(out, /metaToolName=qoder\.Bash/, '0.7.9 的定位依据就是这一跳，日志必须能自证')
    assert.match(out, /name=\(无\)/, 'qoder 不给 name/toolName，摘要要如实说「没有」')
    assert.match(out, /kind=execute/)
    assert.match(out, /toolCallId=call_19e6d181e8be4bfb942073ce/)
    assert.match(out, /rawInputKeys=\[command,description\]/)
    assert.match(out, /preview=ls -la \/Users\/arming\/\.nvm/, '无 diff 正文时预览回退命令正文')
  })

  it('正文预览单独限长：恰好 200 字符，超出部分以 +N字符 标注且可自定义', () => {
    const previewOf = (s) => s.slice(s.lastIndexOf('preview=') + 'preview='.length)
    const out = summarizeToolCallForLog(EDIT_FRAME_RAWFIRST)
    assert.ok(previewOf(out).startsWith(BIG_ONE_LINE.slice(0, 200)), '预览取正文前 200 字符')
    assert.equal(previewOf(out).includes(BIG_ONE_LINE.slice(0, 201)), false, '必须真的截断在 200，不多一个字')
    assert.match(previewOf(out), /\[\+\d+字符\]$/, '超长正文要标注被截掉了多少')
    const custom = summarizeToolCallForLog(EDIT_FRAME_RAWFIRST, { previewLimit: 40 })
    assert.ok(previewOf(custom).startsWith(BIG_ONE_LINE.slice(0, 40)))
    assert.equal(previewOf(custom).includes(BIG_ONE_LINE.slice(0, 41)), false, 'previewLimit 必须生效')
    assert.ok(previewOf(custom).length < previewOf(out).length, '调小限长后预览段真的变短')
    // 限长不是把整行砍短：关键字段一个都没少
    assert.match(custom, /rawInputKeys=\[file_path,old_string,new_string\]/)
  })

  it('无 diff path 时回退 rawInput.file_path/path/filePath（结构化字段优先级如实反映）', () => {
    for (const key of ['file_path', 'path', 'filePath']) {
      const out = summarizeToolCallForLog({ toolCallId: `tc-${key}`, kind: 'edit', rawInput: { [key]: `/proj/${key}.txt` } })
      assert.match(out, new RegExp(`paths=\\[/proj/${key.replace(/[._]/g, (c) => `\\${c}`)}\\.txt\\]`))
    }
    const none = summarizeToolCallForLog({ toolCallId: 'tc-none', kind: 'other', title: 'web_search' })
    assert.match(none, /paths=\[\] pathCount=0/, '没有结构化路径就如实打空，不猜')
  })

  it('locations 与 arguments 也在场（opencode 系实测字段 / 老模型载荷）', () => {
    const out = summarizeToolCallForLog({
      toolCallId: 'tc-loc', kind: 'edit', title: 'edit a',
      locations: [{ path: '/proj/a.txt' }, { uri: 'file:///proj/b.txt' }, { file: '/proj/c.txt' }, null, 3],
      arguments: { command: 'cat /etc/hosts', extra: 'x'.repeat(400) },
    })
    assert.match(out, /locations=\[\/proj\/a\.txt, file:\/\/\/proj\/b\.txt, \/proj\/c\.txt\]/, '畸形条目被滤掉，合法三种写法都在')
    assert.match(out, /arguments=\{"command":"cat \/etc\/hosts"/)
    assert.ok(out.includes('x'.repeat(400)) === false, 'arguments 的超长值必须被限长')
    assert.ok(out.length < 1200, `整行保持可读长度（实际 ${out.length} 字符）`)
  })

  it('载荷不是对象：如实打类型，绝不抛异常', () => {
    for (const bad of [null, undefined, 42, 'a string', [1, 2], true, () => {}]) {
      const out = summarizeToolCallForLog(bad)
      assert.equal(typeof out, 'string')
      assert.match(out, /type=/)
      assert.equal(out.includes('\n'), false)
    }
    assert.match(summarizeToolCallForLog(null), /type=null/)
    assert.match(summarizeToolCallForLog(undefined), /type=undefined/)
    assert.match(summarizeToolCallForLog('x'.repeat(500)), /type=string raw=x+…\[\+\d+字符\]/)
  })

  it('原型链上的 path/toolName 不算产品写下的信息（只看自身属性）', () => {
    const proto = { toolName: 'Inherited', path: '/invented/from/prototype.txt' }
    const frame = Object.create(proto)
    Object.assign(frame, { toolCallId: 'tc-proto', kind: 'edit', title: 't' })
    const out = summarizeToolCallForLog(frame)
    assert.match(out, /metaToolName=\(无 _meta\)/)
    assert.match(out, /paths=\[\] pathCount=0/, '继承来的 path 不得进摘要')
    assert.match(out, /name=\(无\)/, '继承来的 toolName 不得被当成 name')
    assert.equal(out.includes('prototype'), false)
  })

  it('多 diff 块全部列出（一次请求改多个文件时不能只显示第一个）', () => {
    const out = summarizeToolCallForLog({
      toolCallId: 'tc-multi', kind: 'edit',
      content: [
        { type: 'diff', path: '/proj/a.txt', newText: 'a' },
        { type: 'diff', path: '/proj/b.txt', oldText: 'b' },
        { type: 'content', content: { text: '无路径的块' } },
        null,
      ],
    })
    assert.match(out, /paths=\[\/proj\/a\.txt, \/proj\/b\.txt\]/)
    assert.match(out, /pathCount=2/)
    assert.match(out, /bodyChars=7/, 'a(1)+b(1)+无路径的块(5)：正文长度按全部块统计')
  })
})

describe('缺口C：logRequestPermissionToolCall 打到 stderr（诊断通道，前缀形状不变）', () => {
  it('一行「前缀 + 摘要 + options」，且确实走 console.warn（stderr）', () => {
    const out = captureWarn(() => logRequestPermissionToolCall('qoder', {
      toolCall: EDIT_FRAME_RAWFIRST,
      options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
    }))
    assert.match(out, /^\[product-subagents:perm\] qoder requestPermission /, '前缀形状与 0.4.2 一致，既有 grep 抓法不变')
    assert.match(out, new RegExp(`paths=\\[${DIFF_PATH.replace(/[/.]/g, (c) => `\\${c}`)}\\]`))
    assert.match(out, /options=\[\{"optionId":"allow-once"/)
    assert.equal(out.includes('\n\n'), false, '日志仍是一行一条')
  })

  it('差分：同一个 params 用旧写法打，_meta 工具名与 diff path 都在窗口外', () => {
    const legacy = legacyLog({ toolCall: EDIT_FRAME_CONTENTFIRST })
    assert.equal(legacy.includes(DIFF_PATH), false)
    const fresh = captureWarn(() => logRequestPermissionToolCall('qoder', { toolCall: EDIT_FRAME_CONTENTFIRST, options: [] }))
    assert.ok(fresh.includes(DIFF_PATH), '新写法打出来了')
  })

  it('畸形 params 不抛（诊断失败必须静默，绝不反过来搞崩审批链路）', () => {
    for (const params of [undefined, null, {}, { toolCall: null }, { toolCall: 'x' }, { toolCall: {}, options: null }]) {
      assert.doesNotThrow(() => captureWarn(() => logRequestPermissionToolCall('qoder', params)))
    }
    // toolCall 整个缺失时如实打类型；空对象才走「字段存在但没值」那条路
    assert.match(captureWarn(() => logRequestPermissionToolCall('qoder', undefined)), /type=undefined/)
    assert.match(captureWarn(() => logRequestPermissionToolCall('qoder', { toolCall: {} })), /toolCallId=\(无\) kind=\(无\)/)
    assert.match(captureWarn(() => logRequestPermissionToolCall('qoder', { toolCall: {} })), /metaToolName=\(无 _meta\)/)
    assert.match(captureWarn(() => logRequestPermissionToolCall('qoder', undefined)), /options=\[\]/, 'options 缺失要打空数组，不是 undefined')
  })

  it('源码不变量：调用点不再用 500 字符截断（注释里提到旧写法无害）', () => {
    const codeLines = acpSrc.split('\n').filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    const hits = codeLines.filter((l) => /JSON\.stringify\([^)]*[tT]oolCall[^)]*\)\s*\??\.slice\(\s*0\s*,\s*500\s*\)/.test(l))
    assert.deepEqual(hits, [], `requestPermission 日志不得退回 JSON.stringify(toolCall).slice(0,500)：${hits.join(' | ')}`)
    const callSites = codeLines.filter((l) => l.trim().startsWith('logRequestPermissionToolCall(command, params)'))
    assert.equal(callSites.length, 1, `调用点必须只有一处（实际 ${callSites.length}）`)
    const exportLines = codeLines.filter((l) => /^export function (summarizeToolCallForLog|logRequestPermissionToolCall)\(/.test(l))
    assert.equal(exportLines.length, 2, '两个函数都必须在导出面上（测试直接调用，不靠抓 stdout）')
  })
})
