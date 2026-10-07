// v0.7.9 危险命令排除门的纯函数面测试。
//
// 三条模式来自用户自己在 `~/.qoder/settings.json` 的 `permissions.ask`：
// `Bash(rm -rf:*)`、`npm publish`、`git push`（`deny: Bash(sudo:*)` 由 qoder 自己
// 硬拒，不归我们管）。本文件只测判据本身；"门必须排在工具名预检之前、命中不短路"
// 的行为面在 test/permission-handler-wiring.test.js 的 v0.7.9 危险命令门一节。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_DANGER_PATTERNS, MAX_ATTRIBUTION_TOKENS, MAX_DANGER_COMMAND_CHARS, MAX_DANGER_CONFIG_BYTES, MAX_DANGER_PATTERNS, MAX_DANGER_PATTERN_CHARS, MAX_DANGER_TEXT_CHARS, MAX_HEREDOC_OPS, dangerPatternsPath, dangerousCommandMatch, dangerousExecuteMatch, foldCase, heredocTerminatorLines, normalizeCommandText, readDangerPatterns, resetDangerPatternsCache, scanDangerPatterns, splitSubCommands, valueOptionsOf } from '../lib/dangerous-commands.js'
// v0.7.9（复审 M-2 / 第三轮复审 B-1）：门与路径侧的口径关系要能对着 acp.js 的路径兜底
// 断言（**刻意的不对称**：门宁可多问、路径宁可少授权），故直接引它
import { extractPaths, scanExecuteCommandPaths } from '../lib/bridges/acp.js'

/** qoder 形态的执行类载荷：kind=execute + rawInput.command + title=命令正文 */
const exec = (command, extra = {}) => ({
  kind: 'execute',
  rawInput: { command, description: 'x' },
  title: command,
  content: [{ content: { text: command }, type: 'content' }],
  toolCallId: 'tc-1',
  ...extra,
})

describe('v0.7.9 危险命令门：三类模式必须命中', () => {
  it('rm 递归+强制的常见等价写法全命中（含等价顺序与长短选项）', () => {
    for (const command of [
      'rm -rf /tmp/x',
      'rm -fr /tmp/x',
      'rm -r -f /tmp/x',
      'rm -f -r /tmp/x',
      'rm -Rf /tmp/x',
      'rm -rf',
      'rm --recursive --force /tmp/x',
      'rm --force --recursive /tmp/x',
      'rm /tmp/x -rf',
      'rm -v -rf /tmp/x',
      'cd /tmp && rm -rf build',
      'ls; rm -rf /Volumes/proj/dist',
      'rm -rf /a | tee log',
      'FOO=1 rm -rf /tmp/x',
      'sudo -n true && rm -rf /tmp/x',
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${command} 必须判危险`)
      assert.equal(hit.rule, 'rm -rf')
    }
  })

  it('npm publish / git push（含前置全局选项与任意参数）', () => {
    for (const command of ['npm publish', 'npm publish --tag next', 'npm --silent publish', 'cd pkg && npm publish']) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${command} 必须判危险`)
      assert.equal(hit.rule, 'npm publish')
    }
    for (const command of ['git push', 'git push origin main', 'git push --force-with-lease', 'git --no-pager push']) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${command} 必须判危险`)
      assert.equal(hit.rule, 'git push')
    }
  })

  it('命中信息如实给出规则名、命中段与正文来源字段', () => {
    const hit = dangerousExecuteMatch(exec('echo hi; rm -rf /tmp/build'))
    assert.deepEqual({ rule: hit.rule, segment: hit.segment, source: hit.source }, {
      rule: 'rm -rf', segment: 'rm -rf /tmp/build', source: 'rawInput.command',
    })
    const viaTitle = dangerousExecuteMatch({ kind: 'execute', title: 'git push origin main' })
    assert.deepEqual({ rule: viaTitle.rule, source: viaTitle.source }, { rule: 'git push', source: 'title' })
    const viaContent = dangerousExecuteMatch({ kind: 'execute', content: [{ content: { text: 'npm publish' } }] })
    assert.deepEqual({ rule: viaContent.rule, source: viaContent.source }, { rule: 'npm publish', source: 'content[].content.text' })
  })

  it('大小写不敏感比对（macOS 大小写不敏感卷上 RM -RF 真会执行），但只用于比对', () => {
    assert.equal(dangerousExecuteMatch(exec('RM -RF /tmp/x')).rule, 'rm -rf')
    assert.equal(dangerousExecuteMatch(exec('Git Push')).rule, 'git push')
    assert.equal(dangerousExecuteMatch(exec('NPM PUBLISH')).rule, 'npm publish')
    const hit = dangerousExecuteMatch(exec('cd /TMP && RM -Rf ./Build'))
    assert.equal(hit.segment, 'RM -Rf ./Build', 'segment 必须是原文大小写，不得被归一化污染')
  })
})

// ── v0.7.16（用户裁定）：高危弹框要显示"相关命令的操作内容" ──────────────────────
//
// 用户上一轮的误判现场：授权球只给了被截断的说明文字，`rm -rf` 在命令尾部时用户
// 根本看不见，于是把高危请求当成普通请求点了允许。判定归判定，**归因必须能把整条
// 命令原样交给 UI**——所以命中信息里除了 rule/segment，还要带上被判定的那份正文。
// 这一节的字段只用于展示，不参与任何判定（判定逻辑与本文件的既有断言一字不变）。

describe('v0.7.16 归因透出：命中信息带命令正文（供授权弹框原样展示）', () => {
  it('command = 被判定的那份正文**原文**（含未命中的前半段，不折叠空白）', () => {
    const raw = 'cd /x   &&   echo "说明"   &&   rm -rf /tmp/a'
    const hit = dangerousExecuteMatch(exec(raw))
    assert.equal(hit.command, raw, '必须逐字原样，不得归一化/裁剪前半段')
    assert.ok(hit.command.includes('rm -rf /tmp/a'), '尾部命中必须落在这份正文里')
    assert.equal(hit.segment, 'rm -rf /tmp/a')
  })

  it('正文来源与 command 一致（title / content 兜底来源同理）', () => {
    const viaTitle = dangerousExecuteMatch({ kind: 'execute', title: 'git push origin main' })
    assert.equal(viaTitle.source, 'title')
    assert.equal(viaTitle.command, 'git push origin main')
  })

  it(`超长正文按展示上限截断，并如实给出省略字符数（不是静默截断）`, () => {
    const huge = 'echo hi && rm -rf /tmp/a && ' + 'x'.repeat(MAX_DANGER_COMMAND_CHARS * 2)
    const hit = dangerousExecuteMatch(exec(huge))
    assert.equal(hit.command.length, MAX_DANGER_COMMAND_CHARS)
    assert.equal(hit.commandOmitted, huge.length - MAX_DANGER_COMMAND_CHARS)
    const short = dangerousExecuteMatch(exec('rm -rf /tmp/a'))
    assert.equal(short.commandOmitted, 0, '没截断时省略数必须是 0，UI 据此决定要不要提示')
  })

  it('新增字段是**加法**：既有 rule/segment/source 的取值一字不变', () => {
    const hit = dangerousExecuteMatch(exec('echo hi; rm -rf /tmp/build'))
    assert.deepEqual({ rule: hit.rule, segment: hit.segment, source: hit.source }, {
      rule: 'rm -rf', segment: 'rm -rf /tmp/build', source: 'rawInput.command',
    })
    assert.deepEqual({ rule: hit.rule, segment: hit.segment, source: hit.source, command: hit.command, commandOmitted: hit.commandOmitted }, {
      rule: 'rm -rf', segment: 'rm -rf /tmp/build', source: 'rawInput.command', command: 'echo hi; rm -rf /tmp/build', commandOmitted: 0,
    })
  })

  it('没有命中 ⇒ 仍是 null（不得因为多带了展示字段就判出东西来）', () => {
    assert.equal(dangerousExecuteMatch(exec('ls -la /tmp')), null)
    assert.equal(dangerousExecuteMatch(null), null)
  })
})

describe('v0.7.9 危险命令门：误伤守卫', () => {
  it('真反例（程序名/动词/词边界不成立）仍不得判危险', () => {
    // v0.7.15：**提及**类反例（`echo "git push"` / `grep "npm publish"` / 注释里的 `rm -rf` …）
    // 已由用户裁定翻成「命中」——它们的正面断言在 J 组（承认代价）；本用例只留**真反例**：
    // 程序名不同、动词不对、词边界挡住的"包含但不是它"。
    for (const command of [
      'git log --grep push',
      'git log -p --follow src/push.ts',
      'npm run publish',
      'npm run publish-dry',
      'npm --version && echo ok',
      'awk "{print $1}" rm-f.log',
      'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin',
      'python3 - <<\'PY\'\nimport json\nprint(\'ok\')\nPY',
      'git status && npm test',
      'rm -r ./only-recursive',
      'rm -f ./only-force',
      'rm ./plain',
      'rmdir /tmp/x',
      'perform -rf x',
      'legit push origin',
      'digit push origin',
      'npm publisher',
      'git pushd',
      'git pushpin',
      'yarn publishing',
      'rmdir -rf x',
      'format -rf x',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 不得判危险`)
    }
  })

  it('注释行/空段：老口径「注释不是命令 ⇒ 不判」已由 v0.7.15 全文判定取代', () => {
    // v0.7.14 及以前：`# rm -rf /tmp` 只是注释、不是命令 ⇒ 判 null。
    // v0.7.15（用户裁定「文本里出现危险字样就弹」）：注释里的字样同样算 ⇒ 归因 `text:rm -rf`。
    assert.equal(dangerousExecuteMatch(exec('echo a\n# rm -rf /tmp\necho b')).rule, 'text:rm -rf')
    // 纯符号 / 纯空白段本来就不是命令，也没有任何危险字样 ⇒ 仍不判。
    assert.equal(dangerousExecuteMatch(exec(';;&&||')), null)
    assert.equal(dangerousExecuteMatch(exec('   ')), null)
  })

  it('splitSubCommands 引号内不切分、引号外按 ; | || & && 换行切', () => {
    assert.deepEqual(splitSubCommands('a=1&b=2').length, 2)
    assert.deepEqual(splitSubCommands("curl 'a=1&rm -rf'").length, 1)
    assert.deepEqual(splitSubCommands('git push; npm publish'), ['git push', ' npm publish'])
    assert.deepEqual(splitSubCommands('a && b || c | d\ne; f'), ['a ', ' b ', ' c ', ' d', 'e', ' f'])
    assert.deepEqual(splitSubCommands('echo "unclosed && still one'), ['echo "unclosed && still one'])
  })
})

describe('v0.7.9 危险命令门：非执行类与畸形输入不受影响', () => {
  it('Read/Write/Edit 类请求一律不参与本门（哪怕 title 里有 rm -rf 字样）', () => {
    const nonExec = [
      { kind: 'read', title: '/tmp/rm -rf note', toolCallId: 'tc-r' },
      { kind: 'edit', title: 'edit src/index.js', rawInput: { file_path: 'src/index.js', content: 'rm -rf /' }, toolCallId: 'tc-e' },
      { kind: 'write', title: '写入 rm -rf.sh', content: [{ content: { text: 'rm -rf /' } }] },
      { kind: '', title: 'bash' },
      { title: 'git push' },
      { toolCallId: 'tc-1' },
    ]
    for (const toolCall of nonExec) {
      assert.equal(dangerousExecuteMatch(toolCall), null, `${JSON.stringify(toolCall)} 不得命中`)
    }
  })

  it('kind=execute 但没有任何命令正文 ⇒ 不命中', () => {
    assert.equal(dangerousExecuteMatch({ kind: 'execute', toolCallId: 'tc-1' }), null)
    assert.equal(dangerousExecuteMatch({ kind: 'execute', rawInput: {}, title: '  ' }), null)
  })

  it('畸形载荷不抛异常、不命中', () => {
    const broken = [
      null, undefined, {}, 'toolCall', 42, [],
      { kind: 'execute', rawInput: 'x' },
      { kind: 'execute', rawInput: null },
      { kind: 'execute', rawInput: { command: 42 } },
      { kind: 'execute', rawInput: { command: ['rm -rf /'] } },
      { kind: 'execute', content: 'x' },
      { kind: 'execute', content: [null, 7, {}, { content: null }, { content: { text: 42 } }] },
      { kind: 'execute', title: 42 },
      { kind: 42, rawInput: { command: 42 } },
    ]
    for (const toolCall of broken) {
      assert.doesNotThrow(() => dangerousExecuteMatch(toolCall))
      assert.equal(dangerousExecuteMatch(toolCall), null, `${JSON.stringify(toolCall)} 不得命中`)
    }
    // 原型链上的 command/text 不算
    const rawInput = Object.create({ command: 'rm -rf /' })
    assert.equal(dangerousExecuteMatch({ kind: 'execute', rawInput }), null)
    const nested = Object.create({ text: 'rm -rf /' })
    assert.equal(dangerousExecuteMatch({ kind: 'execute', content: [{ content: nested }] }), null)
  })
})

// ── v0.7.9（第三轮复审追加裁定）：名单 5 条 + 取值选项 + 包装/解一层 shell ────────────
//
// 跨仓不同步：`dsh-agent-dispatch` 的 `lib/host-approval.js` 声明「与 product-subagents
// 的 `lib/dangerous-commands.js` 同一份，需人工保持同步」，而产品侧先前只有 3 条、
// 且 `subCommandVerb` 不跳过取值选项 ⇒ 用户裁决「这几类命令在任何档位都必须走交互」
// 在**宿主通道**已生效、在 **ACP 通道**没生效。本组把两侧对齐（名单、取值选项、
// 包装、`-c` 解一层）。
//
// 本组**改掉了 1 条既有断言**（原文与理由见用例内注释）。
describe('v0.7.9 追加裁定：名单与宿主侧对齐（5 条）+ 取值选项跳过（大小写归一）', () => {
  it('名单 5 条：pnpm publish / yarn publish / yarn npm publish 与 npm publish 同语义', () => {
    for (const [command, rule] of [
      ['pnpm publish', 'pnpm publish'],
      ['pnpm publish --tag next', 'pnpm publish'],
      ['pnpm --silent publish', 'pnpm publish'],
      ['cd pkg && pnpm publish', 'pnpm publish'],
      ['yarn publish', 'yarn publish'],
      ['yarn publish --new-version 1.2.3', 'yarn publish'],
      // yarn 2+ 的 `yarn npm publish`（同一动作的另一种写法）
      ['yarn npm publish', 'yarn publish'],
      ['yarn --silent npm publish', 'yarn publish'],
      // 三条 publish 一条不变
      ['npm publish', 'npm publish'],
      ['npm publish --tag next', 'npm publish'],
      ['npm --silent publish', 'npm publish'],
      ['git push', 'git push'],
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${command} 必须判危险（与宿主侧 DANGEROUS_COMMAND_RULES 对齐）`)
      assert.equal(hit.rule, rule)
    }
  })

  it('取值选项要跳过（否则动词被挤到第三个 token 之后 ⇒ 静默放行）', () => {
    for (const [command, rule] of [
      ['git -C /tmp push', 'git push'],
      ['git -c k=v push', 'git push'],
      ['git --git-dir=/tmp/g push', 'git push'], // --opt=value 是单个 token
      ['npm --prefix /tmp publish', 'npm publish'],
      ['npm -C /tmp publish', 'npm publish'],
      ['pnpm -C /tmp publish', 'pnpm publish'],
      ['pnpm --dir /tmp publish', 'pnpm publish'],
      ['yarn --cwd /tmp publish', 'yarn publish'],
      ['npm -C/tmp publish', 'npm publish'], // 粘连取值
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${command} 的动词被取值选项挤后置，必须跳过取值选项后仍命中`)
      assert.equal(hit.rule, rule)
    }
  })

  it('⚠️ 取值选项表必须**归一大小写**后再查（宿主侧实测坑：`-C` 匹配不上 `-c`）', () => {
    // 表里存的是 `-C` 这类大小写原样的值，而 token 侧先 toLowerCase()
    // ⇒ 直接 has(token) 永远匹配不上 ⇒ `pnpm -C /tmp publish` / `npm -C /tmp publish`
    // 静默放行。这条用例专门钉住那个坑。
    for (const command of ['pnpm -C /tmp publish', 'npm -C /tmp publish', 'pnpm --dir /tmp publish']) {
      assert.ok(dangerousExecuteMatch(exec(command)), `${command} 必须命中（大小写归一后才查表）`)
    }
    // 直接钉"唯一查表入口"的归一契约：喂一张**混合大小写**的表，任何大小写写法都要查得到。
    // 把 valueOptionsOf 里的 `.toLowerCase()` 删掉，这几条立刻转红（这就是变异哨兵）。
    const fakeTable = { demo: new Set(['-C', '-I', '--Dir', '--plain']) }
    const opts = valueOptionsOf(fakeTable, 'demo')
    for (const key of ['-C', '-c', '-I', '-i', '--Dir', '--dir', '--DIR', '--plain']) {
      assert.equal(opts.has(key.toLowerCase()), true, `${key} 必须查得到（表与 token 两侧都归一）`)
    }
    assert.equal(valueOptionsOf(fakeTable, 'nope').size, 0, '表里没有的程序名 ⇒ 空集合，不抛')
    // 纯防御（第四轮终审 Minor-4）：不改这两行会抛 —— `table['__proto__']` 顺原型链取到
    // `Object.prototype`（"set is not iterable"）、表为 null 时读属性直接抛。
    // 两条都不可达（表是模块内常量、name 是 basename 过的命令名），纯防御、不影响判定。
    assert.equal(valueOptionsOf(fakeTable, '__proto__').size, 0, '__proto__ 不得顺原型链取到东西')
    assert.equal(valueOptionsOf(fakeTable, 'constructor').size, 0, 'constructor 同样')
    assert.equal(valueOptionsOf(null, 'x').size, 0, '表为 null 不抛')
    assert.equal(valueOptionsOf({}, 'demo').size, 0, '空表不抛')
    // 反向：大写的**子命令动词**也要认（命令名/动词按小写比对）
    assert.equal(dangerousExecuteMatch(exec('NPM PUBLISH')).rule, 'npm publish')
    assert.equal(dangerousExecuteMatch(exec('PNPM -C /tmp PUBLISH')).rule, 'pnpm publish')
    assert.equal(dangerousExecuteMatch(exec('Yarn --cwd /tmp Publish')).rule, 'yarn publish')
    // 大写短选项 `-I`（xargs 标准写法，表里就按大写存）也要能吃掉它的取值
    assert.ok(dangerousExecuteMatch(exec('xargs -I {} rm -rf /tmp/x')), 'xargs -I {} rm -rf x 必须命中')
  })

  it('透明包装：sudo/command/env/nohup/nice/time/timeout/stdbuf/xargs/busybox 剥掉后继续判', () => {
    for (const command of [
      'sudo rm -rf /tmp/x',
      'command rm -rf /tmp/x',
      'env rm -rf /tmp/x',
      'nohup rm -rf /tmp/x',
      'xargs rm -rf',
      'find . | xargs rm -rf',
      'busybox rm -rf /tmp/x',
      'toybox rm -rf /tmp/x',
      'sudo -u root rm -rf /tmp/x',
      'nice -n 10 rm -rf /tmp/x',
      'timeout 5 rm -rf /tmp/x',
      'timeout 1m rm -rf /tmp/x',
      'env FOO=1 rm -rf /tmp/x',
      'env FOO=1 sudo -u root nice -n 10 rm -rf /tmp/x',
      '/bin/rm -rf /tmp/x',
      './rm -rf /tmp/x',
      '/usr/bin/env rm -rf /tmp/x',
      // v0.7.9（第四轮终审 Major-1）：`env -S`/`--split-string` 的取值是**多 token 的整条
      // 命令**，改前只吃掉一个 token ⇒ 命令头错位 ⇒ 判 null ⇒ 静默放行（真机已证明
      // `env -S "rm -rf <dir>"` 真的把目录删掉）。四条写法都要命中。
      'env -S "rm -rf /tmp/x"',
      "env -S 'rm -rf /tmp/x'",
      'env --split-string="rm -rf /tmp/x"',
      'env --split-string "rm -rf /tmp/x"',
      "env -S'rm -rf /tmp/x'",
    ]) {
      assert.ok(dangerousExecuteMatch(exec(command)), `${command} 经透明包装剥除后必须命中`)
    }
  })

  it('解一层 shell 包装：sh|bash|zsh|dash|ksh -c 的正文再喂给同一份规则', () => {
    for (const command of [
      'bash -c "rm -rf /tmp/x"',
      "sh -c 'rm -rf /tmp/x'",
      'zsh -c "git push"',
      'bash -lc "rm -rf /tmp/x"',
      'bash -ec "npm publish"',
      // `-c` 与正文粘连（token 被空白切成 `-c'rm` + `-rf` + `/x'`）
      "bash -c'rm -rf /x'",
      // 转义引号的嵌套
      'bash -c "bash -c \\"rm -rf /x\\""',
    ]) {
      assert.ok(dangerousExecuteMatch(exec(command)), `${command} 解开 -c 包装后必须命中`)
    }
    // 第 3 层起不展开，按「可疑」保守转交互（不是放行）。
    // v0.7.13 归因变化：这一段的正文里**有** `rm -rf`，按「先内容、后形状」归因为内容规则
    // （改前是 `shell-nesting`；判定本身两边都是「拦下」，只是留痕理由更准）。
    const deep = dangerousExecuteMatch(exec('bash -c "bash -c \\"bash -c \\\\\\"rm -rf /x\\\\\\"\\""'))
    assert.ok(deep, '超过 2 层必须拦下，不许放行')
    assert.equal(deep.rule, 'rm -rf', '内容规则优先归因（留痕理由给出真正的命令）')
    // 形状兜底仍必须在：同样三层嵌套但正文里没有内容规则命中
    assert.equal(dangerousExecuteMatch(exec('bash -c "bash -c \\"bash -c \\\\\\"ls /x\\\\\\"\\""')).rule,
      'shell-nesting', '没有内容命中时仍按 shell-nesting 保守转交互')
    // `-C` 是 noclobber，不是 `-c`：shell 选项字母大小写敏感，不得误判。
    // v0.7.15：全文判定会因文本里的 `rm -rf` 命中 ⇒ 断言改成**区分归因**（仍是有牙的判据）：
    // 若 `-C` 被错当 `-c` 解包，正文会走按段判定、归因为 `rm -rf`；现在归因必须是 `text:rm -rf`。
    assert.equal(dangerousExecuteMatch(exec('bash -C rm -rf /tmp/x')).rule, 'text:rm -rf',
      '`-C` 不是 `-c`：不得当命令正文解包（归因是全文判定，不是段判定）')
  })

  it('误伤守卫（追加名单后仍然全绿）：真反例逐条', () => {
    for (const command of [
      'git log --grep push', 'git log -p --follow src/push.ts',
      'npm run publish', 'pnpm run publish', 'yarn run publish', 'npm run publish-dry',
      'rm -r ./only-recursive', 'rm -f ./only-force',
      'ls -la', 'echo hi', 'bash --norc',
      'lerna publish', 'git clean -fdx', 'git reset --hard', 'make deploy', 'bash deploy.sh',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 不得判危险`)
    }
    // 正文（非命令字段）里提到这些词：kind=edit + 正文不含命令字段 ⇒ 门不命中
    // （v0.7.15 的全文判定只作用于**执行类帧的命令正文**，不把任意文件的 content 当命令扫）
    assert.equal(dangerousExecuteMatch({ kind: 'edit', title: '写入 rm -rf.sh', rawInput: { file_path: 'a.sh', content: 'rm -rf /' } }), null)
  })
})

describe('v0.7.9 危险命令门：已知不覆盖写法（文档锚点，改动必须同步注释）', () => {
  it('【改动的既有断言③】包装/解一层 shell/取值选项/pnpm·yarn publish 已**不再**是盲区', () => {
    // 改前（原文）：下面这一批全部断言为 null，理由是"本版不覆盖（间接调用与带值全局选项
    //   按现状放行，与 qoder 自己的前缀规则同等盲区）"：
    //     'sudo rm -rf /tmp/x', 'command rm -rf /tmp/x', 'env rm -rf /tmp/x',
    //     'bash -c "rm -rf /tmp/x"', "sh -c 'rm -rf /tmp/x'", 'find . | xargs rm -rf',
    //     'git -C /repo push', 'pnpm publish', 'yarn publish'
    // 改后：第三轮追加裁定把名单与宿主侧对齐、并补上透明包装 / 解一层 shell / 取值选项
    //   跳过 ⇒ 这些**必须命中**（改前它们在 ACP 通道静默放行，正是跨仓不同步的现场）。
    for (const command of [
      'sudo rm -rf /tmp/x', 'command rm -rf /tmp/x', 'env rm -rf /tmp/x',
      'bash -c "rm -rf /tmp/x"', "sh -c 'rm -rf /tmp/x'", 'find . | xargs rm -rf',
      'git -C /repo push', 'pnpm publish', 'yarn publish',
    ]) {
      assert.ok(dangerousExecuteMatch(exec(command)), `${command} 本版已覆盖（见模块头注释的"覆盖"清单）`)
    }
  })

  it('仍然不覆盖（诚实声明，不静默漏掉）：文本里没有危险字样 / 静态不可判定', () => {
    for (const command of [
      // 名单之外 / 用户裁决范围之外（文本里没有任何危险字样）
      'lerna publish',
      'git clean -fdx',
      'git reset --hard HEAD~1',
      // 变量间接：字面被变量替换 ⇒ 全文判定也看不见
      'S=rm; $S -rf x',
      'bash deploy.sh',
      'make deploy',
      'python -c "os.system(\'$CMD -rf /\')"',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 本版不覆盖（见模块头注释的"不覆盖"清单）`)
    }
    // v0.7.15：下面这些**现在是命中的** —— 命中原因是文本里**写着** `rm -rf`（**字面命中**），
    // 不是本层解析了 `os.system` / `eval` / herestring / `-exec` 语法（同形状换成变量即退回 null，
    // 上面 `python -c ...'$CMD -rf /'` 就是那条对照）。
    for (const command of [
      'python -c "os.system(\'rm -rf /\')"',
      'eval "rm -rf /tmp/x"',
      "printf 'rm -rf /x' | bash",
      "bash <<< 'rm -rf /x'",
      'find /tmp -exec rm -rf {} +',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)).rule, 'text:rm -rf', `${command} 由全文判定命中（字面）`)
    }
  })

  // 第四轮终审实测（两侧跑同一份 45 条语料）：**规则名单一致，覆盖边界不一致** ——
  // 宿主另有 5 处覆盖，本仓实测 null。这里把每一条**钉在测试里**：文档的"不覆盖"清单
  // 与实测逐条对应（Minor-7），任何一侧悄悄漂移都会在这里显形。
  // 注意：断言的是**本仓现状**（不是"这样最好"）——判 null 只表示本门不额外弹窗。
  it('跨仓边界差异（v0.7.15 后大幅收窄）：字面命中 vs 语法解析，剩下的真分歧逐条钉住', () => {
    // 0.7.14 及以前：这些形态本仓判 `null`、宿主更严（分歧登记在 lib/dangerous-commands.js 文件头）。
    // v0.7.15 起**全文判定**让它们命中，但机制是「文本里**写着** `rm -rf`」，**不是**解析了
    // coreutils / `-exec` / herestring / `-C` 这些语法 —— 下面最后两条对照钉住这个区别。
    for (const command of [
      'coreutils rm -rf /x',
      'find /tmp -exec rm -rf {} +',
      'find /tmp -execdir rm -rf {} +',
      "printf 'rm -rf /x' | bash",
      "bash <<< 'rm -rf /x'",
      'bash -C rm -rf /x',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)).rule, 'text:rm -rf',
        `${command} 由全文判定命中（字面），不再是跨仓分歧`)
    }
    // 对照：同形状但字面被变量/占位替换 ⇒ 全文判定也不命中（证明上表是"字面命中"，不是"看懂语法"）
    assert.equal(dangerousExecuteMatch(exec('coreutils $CMD -rf /x')), null, '未解析 coreutils（只认字面）')
    assert.equal(dangerousExecuteMatch(exec("printf 'CMD -rf /x' | bash")), null, '未解析管道/herestring（只认字面）')
    // 真分歧仍在：宿主按 SHELL_STDIN_RULE 保守转交互，本仓（不做文件读取）判不出
    assert.equal(dangerousExecuteMatch(exec('bash deploy.sh')), null, '宿主判 shell-stdin，本仓仍 null')
    // `bash -c`（小写）必须仍然命中：`bash -C` 变成全文命中不等于把 shell 正文这条路关了
    assert.equal(dangerousExecuteMatch(exec('bash -c "rm -rf /x"')).rule, 'rm -rf')
    // 自定义执行工具：命令不在本仓的固定四个字段里 ⇒ null（宿主用 argsTextOf 拼所有字符串值）
    assert.equal(dangerousExecuteMatch({ kind: 'execute', name: 'shell', rawInput: { shell: 'rm -rf /x' } }), null,
      '本仓正文来源固定为 rawInput.command / arguments.command / content[].content.text / title')
  })
})

// ── v0.7.9（复审 M-1/M-2）：命令正文来源与「是否执行类」的口径两处统一 ──────────────
//
// M-1（fail-open）：改前本门的正文取值只认 `rawInput.command` → `content[].text` →
// `title`，**不读 `toolCall.arguments`**（而 `lib/bridges/acp.js` 的路径提取支持它）。
// 于是 `{name:'shell', arguments:'{"command":"git push --force"}'}` 判 null ⇒ 工具名档
// 短路（该会话授权过一次 Bash）⇒ 门失效，危险命令被静默放行。
// M-2（口径不一）：改前本条在门上命中、`acp.js` 却对非执行类一票否决
// （`{kind:'edit', rawInput:{command:'rm -rf /tmp/x'}}`）。现在两处共用
// `lib/execute-frame.js` 的 `isExecuteFrame` / `executeCommandText`。
describe('v0.7.9 复审 M-1：命令只在 arguments 里（对象 / JSON 字符串）也必须命中', () => {
  it('arguments 是 JSON 字符串（老模型形态）⇒ 命中', () => {
    const hit = dangerousExecuteMatch({ name: 'shell', arguments: '{"command":"git push --force"}' })
    assert.ok(hit, 'arguments.command 取不到正文 ⇒ 工具名档短路 ⇒ 门失效（fail-open），必须命中')
    assert.equal(hit.rule, 'git push')
    assert.equal(hit.source, 'arguments.command', '来源字段如实给出，便于排障归因')
  })

  it('arguments 是对象（Claude/Codex 系）⇒ 命中', () => {
    const hit = dangerousExecuteMatch({ name: 'shell', arguments: { command: 'rm -rf /tmp/x' } })
    assert.ok(hit)
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'arguments.command')
  })

  it('kind=execute 形态同样支持 arguments（npm publish / rm -rf 各一条）', () => {
    assert.equal(dangerousExecuteMatch({ kind: 'execute', arguments: '{"command":"npm publish"}' }).rule, 'npm publish')
    assert.equal(dangerousExecuteMatch({ kind: 'execute', arguments: { command: 'rm -fr /tmp/y' } }).rule, 'rm -rf')
  })

  it('优先级不变：rawInput.command 仍排在 arguments.command 之前（qoder 实测形态）', () => {
    const hit = dangerousExecuteMatch({ kind: 'execute', rawInput: { command: 'rm -rf /tmp/a' }, arguments: { command: 'git push' } })
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'rawInput.command')
  })

  it('边界：arguments 是数组/数字/畸形 JSON、command 非字符串 ⇒ 不命中也不抛', () => {
    const broken = [
      { name: 'shell', arguments: [1, 2] },
      { name: 'shell', arguments: 42 },
      { name: 'shell', arguments: '{"command":' },
      { name: 'shell', arguments: '{"command":42}' },
      { name: 'shell', arguments: { command: ['rm -rf /'] } },
      { name: 'shell', arguments: 'null' },
    ]
    for (const toolCall of broken) {
      assert.doesNotThrow(() => dangerousExecuteMatch(toolCall))
      assert.equal(dangerousExecuteMatch(toolCall), null, `${JSON.stringify(toolCall)} 不得命中`)
    }
  })
})

// ── v0.7.9（第三轮复审 B-1 阻断）：门与 `kind` **解耦**，与路径侧是**有意的不对称** ─────
//
// 现场（终审探针实测）：同一会话先授权 `qoder:bash`，随后
//   `{kind:'other', name:'bash', title:'bash', rawInput:{command:'rm -rf /tmp/build'}}`
// 在**补丁后**一条 pending 事件都不发、直接 allow（补丁前 pristine 会弹窗）。
// 根因：上一版把「两处口径统一」当目标 ⇒ 门跟着 `kind` 一起对非执行类一票否决 ⇒
// `executeCommandText` 判 null ⇒ 门整档关闭 ⇒ `lib/index.js` 的 `!danger` 分支把
// session/disk/workspace 三档全部推入 ⇒ 命中会话级工具名授权后静默放行。
//
// 裁定（第三轮复审，语义已定，不要再自选方向）：
//   · **门（`dangerousExecuteMatch`）fail-safe、与 `kind` 解耦**：只要请求里存在命令
//     字段（`rawInput.command` / `arguments.command`，字符串 / 对象两种形状）就拿它跑
//     危险命令规则。门回答的只是「**要不要多问一次**」这一个布尔，多问一次是安全方向。
//   · **路径提取（`scanExecuteCommandPaths`）保持严格不变**：只认执行类 `kind`，
//     非执行类一票否决。它的产物是**唯一**能自动变成规则的集合，放宽即 fail-open。
//   ⇒ **门宁可多问，路径宁可少授权**（见 `lib/execute-frame.js` 文件头）。
//
// 本组因此**改掉了两条既有断言**（原文与理由见各自用例内的注释）。
describe('v0.7.9 第三轮复审 B-1：危险门与 kind 解耦（fail-safe），路径侧仍严格（有意不对称）', () => {
  it('【改动的既有断言①】kind=edit + rawInput.command ⇒ 门上**命中**，路径侧仍不扫（不对称被钉住）', () => {
    // 改前（原文）：assert.equal(dangerousExecuteMatch(editFrame), null,
    //   'kind=edit 的 command 字段是文件正文/代码内容，不是本次要执行的命令')
    // 改后：门必须命中 —— 门看得到命令字段就问一次；放宽的代价只是多弹一次窗，
    // 而按 `kind` 一票否决会让"某产品用非执行类 kind 发 shell"整档绕过。
    const editFrame = { kind: 'edit', rawInput: { command: 'rm -rf /tmp/x' } }
    const hit = dangerousExecuteMatch(editFrame)
    assert.ok(hit, 'kind=edit 夹带命令字段 ⇒ 门宁可多问一次（fail-safe），不得整档关闭')
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'rawInput.command')
    // 路径侧**不变**：非执行类一票否决，命令字段不参与（产物会自动变成规则，方向相反）
    assert.deepEqual(extractPaths(editFrame), [], '路径侧仍不扫命令字段（刻意的不对称：路径宁可少授权）')
    assert.deepEqual(scanExecuteCommandPaths(editFrame), [], '兜底扫描同样只认执行类帧')
    // 阳性对照：同样是"命令藏在字段里"，kind 属执行类 ⇒ 两侧都认
    const execFrame = { kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } }
    assert.equal(dangerousExecuteMatch(execFrame).rule, 'rm -rf')
    assert.deepEqual(extractPaths(execFrame), ['/tmp/x'])
  })

  it('title 仍然是执行类帧才可信的文本来源（非执行类帧的 title 不判危险，避免天天误伤）', () => {
    // 现场：写文件请求的 title 就是文件名，正文里出现 `rm -rf` 是**文件内容**
    // （test/permission-handler-wiring.test.js 的「非 execute 工具不受门影响」用例
    //  依赖这条：`title='写入 rm -rf.sh'` 必须照常免弹）
    assert.equal(dangerousExecuteMatch({ kind: 'edit', title: '写入 rm -rf.sh', rawInput: { file_path: 'scripts/cleanup.sh', content: 'rm -rf /' } }), null)
    assert.equal(dangerousExecuteMatch({ kind: 'edit', title: 'rm -rf /tmp/x' }), null)
    // 命令字段缺席时，执行类帧的 title 照旧可作正文
    assert.equal(dangerousExecuteMatch({ kind: 'execute', title: 'rm -rf /tmp/x' }).rule, 'rm -rf')
  })

  it('门与 kind 无关的边界：kind 缺失、空白、数字都不改变"看得到命令字段就判"', () => {
    // kind 缺失 + 命令字段（qoder 若漏 kind）
    assert.equal(dangerousExecuteMatch({ name: 'bash', title: 'bash', rawInput: { command: 'rm -rf /tmp/x' } }).rule, 'rm -rf')
    assert.equal(dangerousExecuteMatch({ rawInput: { command: 'git push' } }).rule, 'git push')
    assert.equal(dangerousExecuteMatch({ kind: '', rawInput: { command: 'npm publish' } }).rule, 'npm publish')
    assert.equal(dangerousExecuteMatch({ kind: 42, rawInput: { command: 'rm -rf /tmp/x' } }).rule, 'rm -rf')
  })

  it('新增用例1：kind=other + name/title=bash + rawInput.command ⇒ 命中（阻断的现场帧）', () => {
    const fixtureFrame = { kind: 'other', name: 'bash', title: 'bash', rawInput: { command: 'rm -rf /tmp/x' } }
    const hit = dangerousExecuteMatch(fixtureFrame)
    assert.ok(hit, '这正是终审探针的现场帧：库内 fixture 就是这么建模 bash 的，不得静默放行')
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'rawInput.command')
    // 同一帧在**路径侧**仍是空集（保留的阴性断言：不对称本身被用例钉住）
    assert.deepEqual(extractPaths(fixtureFrame), [], '非执行类帧不扫命令字段 ⇒ 不写授权路径')
    assert.deepEqual(scanExecuteCommandPaths(fixtureFrame), [])
  })

  it('新增用例5（阴性对照）：纯 Edit 帧没有任何 command 字段 ⇒ 仍不命中（不得把文件编辑也拦下）', () => {
    const pureEdit = { kind: 'edit', name: 'Edit', title: 'Edit a.json', rawInput: { file_path: '/p/a.json', old_string: '{}', new_string: '{"dest":"~/.ssh"}' }, content: [{ type: 'diff', path: '/p/a.json', newText: '{"dest":"~/.ssh"}' }], toolCallId: 'tc-pure-edit' }
    assert.equal(dangerousExecuteMatch(pureEdit), null, '文件编辑不是命令：正文/标题里的 rm -rf 字样与它无关')
    const withDangerBody = { kind: 'edit', name: 'Write', title: '写入 rm -rf.sh', rawInput: { file_path: 'scripts/cleanup.sh', content: 'rm -rf /' } }
    assert.equal(dangerousExecuteMatch(withDangerBody), null, '正文是文件内容，不是本次要执行的命令')
    assert.deepEqual(extractPaths(pureEdit), ['/p/a.json'], '路径侧照旧只认结构化 path')
  })

  it('新增用例2：kind 缺失 + title 为命令正文 ⇒ 命中', () => {
    const hit = dangerousExecuteMatch({ name: 'bash', title: 'rm -rf /tmp/build' })
    assert.ok(hit, 'name 是执行类 slug ⇒ 按执行类帧处理，title 即命令正文')
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'title')
  })

  it('新增用例3：kind=other + arguments.command（对象 / JSON 字符串）⇒ 命中', () => {
    assert.equal(dangerousExecuteMatch({ kind: 'other', arguments: { command: 'git push' } }).rule, 'git push')
    assert.equal(dangerousExecuteMatch({ kind: 'other', arguments: '{"command":"git push"}' }).rule, 'git push')
    assert.equal(dangerousExecuteMatch({ kind: 'other', name: 'Bash', arguments: '{"command":"rm -rf /tmp/y"}' }).source, 'arguments.command')
  })

  it('新增用例5（阳性对照）：kind=execute + rawInput.command 仍命中', () => {
    assert.equal(dangerousExecuteMatch({ kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } }).rule, 'rm -rf')
  })

  it('【改动的既有断言②】既无 kind 也无执行类 name/title：带命令字段 ⇒ 命中；只有 title ⇒ 不认', () => {
    // 改前（原文）：assert.equal(dangerousExecuteMatch({ rawInput: { command: 'rm -rf /tmp/z' } }), null)
    // 改后：**带命令字段 ⇒ 门命中**（与"改动①"同因：命令字段与 `kind` 无关，门宁可多问）。
    assert.equal(dangerousExecuteMatch({ rawInput: { command: 'rm -rf /tmp/z' } }).rule, 'rm -rf')
    assert.deepEqual(extractPaths({ rawInput: { command: 'rm -rf /tmp/z' } }), [], '路径侧照旧不认这种帧（不对称）')
    // 而没有命令字段时，"执行类 name/title slug 兜底"的判定不变：`title` 不是执行类 slug
    // ⇒ title 不作为命令正文（否则任何标题里出现命令字样的帧都会被问，天天误伤）。
    assert.equal(dangerousExecuteMatch({ title: 'rm -rf /tmp/z' }), null)
    assert.equal(dangerousExecuteMatch({ title: 'npm publish' }), null)
  })
})

// ── v0.7.9（第四轮终审 Major-1）：`env -S` / `env --split-string` 静默放行 ────────────
//
// 现场（终审实测）：已授权 `qoder:bash` 时，`env -S "rm -rf /Users/arming/.ssh"`、
// `env --split-string=…` 全部 `gate=null`、新增 `pending=0`、`allow`；真机证据：
// `env -S "rm -rf /private/tmp/.../envprobe/v1"` **真的把目录删掉了**（exit 0）。
// 根因：`-S` 的取值是**整条命令**（GNU env 的 split-string 语义），shell 按空白分词后
// 是多 token，而通用选项扫描只 `i += 1` 吃掉一个 ⇒ 命令头错位 ⇒ 返回 null。
// 修法：`-S`/`--split-string` **之后的所有 token 拼回**，重新分词后再喂给同一份规则。
describe('v0.7.9 第四轮终审 Major-1：env -S / --split-string 的取值是多 token 的整条命令', () => {
  it('四种写法都必须命中（独立 / 粘连 / 长选项 / 长选项带 =）', () => {
    for (const command of [
      'env -S "rm -rf /tmp/x"',
      "env -S 'rm -rf /tmp/x'",
      'env -S "rm -rf /Users/arming/.ssh"',
      "env -S'rm -rf /tmp/x'",
      'env --split-string "rm -rf /tmp/x"',
      'env --split-string="rm -rf /tmp/x"',
    ]) {
      const hit = dangerousCommandMatch(command)
      assert.ok(hit, `${command} 必须命中（-S 的取值要拼回再判）`)
      assert.equal(hit.rule, 'rm -rf', `${command} 命中的规则名`)
    }
  })

  it('多 token 的 payload 里其它规则同样生效（拼回后喂给同一份规则）', () => {
    assert.equal(dangerousCommandMatch('env -S "npm publish"').rule, 'npm publish')
    assert.equal(dangerousCommandMatch('env -S "git push --force origin main"').rule, 'git push')
    // 包装叠加：`sudo env -S …`（`-S` 那一跳之后继续剥后面的包装）
    assert.equal(dangerousCommandMatch('sudo env -S "rm -rf /tmp/x"').rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('env -S "sudo -u root rm -rf /tmp/x"').rule, 'rm -rf')
  })

  it('不过度命中：payload 不是危险命令时照旧 null（危险字样除外 = v0.7.15 裁定代价）', () => {
    assert.equal(dangerousCommandMatch('env -S "ls /x"'), null, '取值拼回不等于一律判危险')
    assert.equal(dangerousCommandMatch('env -S'), null, '空取值 ⇒ 判不出命令，不抛')
    // v0.7.15 起：正文里**写着** `rm -rf` 就弹（用户裁定的代价，与命令头是 echo 无关）
    assert.equal(dangerousCommandMatch('env -S "echo rm -rf /tmp/x"').rule, 'text:rm -rf',
      '全文判定：文本里出现危险字样即判（提及代价）')
    // 诚实声明（方向 safe）：本层按**空白**分词、不做引号内合并 ⇒ `env "rm -rf /tmp/x"`
    // （shell 里其实是**一个**参数）会被切成 `rm` + `-rf` + `/tmp/x` 而命中 —— 多问一次，
    // 不是漏判。真正的 `env rm -rf /tmp/x` 形状本来就该命中。
    assert.equal(dangerousCommandMatch('env "rm -rf /tmp/x"').rule, 'rm -rf')
  })
})

// ── v0.7.9（第四轮终审 Minor-1）：包装跳数用尽 ⇒ `wrapper-nesting`（可疑，保守转交互）──
//
// 现场：`sudo×9 rm -rf /x` / `sudo×20 rm -rf /x` 端到端 `gate=null`、静默放行。
// 跳数预算（8）用尽后头部仍是透明包装器 ⇒ 规则表只看到 `sudo` 一个 token ⇒ 判 null，
// 而判 null 的语义是"本门不额外弹窗"、**不是**"安全"。宿主侧有同名规则
// `WRAPPER_DEPTH_RULE='wrapper-nesting'`（本仓对齐它）。
describe('v0.7.9 第四轮终审 Minor-1：包装跳数用尽 ⇒ wrapper-nesting（与宿主同名）', () => {
  it('跳数预算边界：8 跳内照常判规则，第 9 跳起转「可疑」', () => {
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(8)}rm -rf /x`).rule, 'rm -rf', '8 跳刚好用完预算，仍能判到真命令')
    // v0.7.13 归因变化（终审 B-1）：预算用尽时先在**同一段**求值内容规则 —— 留痕理由给出
    // 真正的命令（改前统一报 `wrapper-nesting`；判定本身两边都是「拦下」，没有放宽）。
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /x`).rule, 'rm -rf', '第 9 跳起不再展开 ⇒ 内容规则优先归因')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(20)}rm -rf /x`).rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'command '.repeat(9)}rm -rf /x`).rule, 'rm -rf', '其它透明包装同样计数')
    // 内容规则不覆盖的形态仍按形状规则保守转交互（预算本身不取消）
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2`).rule, 'wrapper-nesting')
    // 端到端（门）：必须命中 ⇒ 已授权 bash 时仍会新增 pending（见 wiring 测试的监听器层用例）
    assert.equal(dangerousExecuteMatch(exec(`${'sudo '.repeat(9)}rm -rf /x`)).rule, 'rm -rf')
  })

  it('无害命令不因"跳数用尽"被误报成危险：8 跳内判不出就是 null', () => {
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(8)}ls /x`), null, '剥完 8 跳看到 `ls` ⇒ 不是危险命令')
    // 第 9 跳起按可疑转交互（宁可多问一次，方向安全）——这里钉住规则名是"可疑"而不是三大模式
    const suspicious = dangerousCommandMatch(`${'sudo '.repeat(9)}ls /x`)
    assert.equal(suspicious.rule, 'wrapper-nesting', '可疑规则名与三大模式区分开，留痕能看出是跳数用尽')
    assert.notEqual(suspicious.rule, 'rm -rf')
  })
})

// ── v0.7.9（第四轮终审 Major-4）：kind 缺失 ⇒ 按 title 的执行类 slug 兜底（正向钉回）──
//
// 上一轮删掉了既有断言 `{title:'execute', rawInput:{command}} ⇒ rm -rf`，导致这条兜底
// 只剩阴性用例（"非执行类与畸形输入不受影响"里的 `{title:'git push'}` 等）。
// 行为本身是对的（终审复现 `{title:'bash', content:[{content:{text:'rm -rf /tmp/x'}}]}`
// ⇒ rm -rf），故此处把正向断言补回：`kind` 缺失时，`name`/`title` 的执行类 slug
// （execute/exec/shell/bash/command）决定 `title` 与 `content[].text` 这两条文本来源可不可信。
describe('v0.7.9 第四轮终审 Major-4：kind 缺失时按 title 的执行类 slug 兜底（正向断言）', () => {
  it('kind 缺失 + title 是执行类 slug ⇒ title/content 文本来源可信', () => {
    const hit = dangerousExecuteMatch({ title: 'bash', content: [{ content: { text: 'rm -rf /tmp/x' } }] })
    assert.ok(hit, 'title="bash" 在执行类 slug 里 ⇒ 按执行类帧处理')
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'content[].content.text')
  })

  it('【补回的既有断言】kind 缺失 + title=execute + rawInput.command ⇒ 命中 rm -rf', () => {
    // 上一轮被删的那条（原 test/dangerous-commands.test.js:254）逐字补回
    const hit = dangerousExecuteMatch({ title: 'execute', rawInput: { command: 'rm -rf /tmp/x' } })
    assert.ok(hit, 'kind 缺失时命令字段照旧与 kind 无关（门宁可多问）；title 兜底让来源归因正确')
    assert.equal(hit.rule, 'rm -rf')
    assert.equal(hit.source, 'rawInput.command')
  })

  it('阴性对照：title 不是执行类 slug ⇒ content/title 两条文本来源仍不可信', () => {
    assert.equal(dangerousExecuteMatch({ title: 'edit', content: [{ content: { text: 'rm -rf /tmp/x' } }] }), null,
      'title="edit" 不在执行类 slug 里 ⇒ 文本来源不认（否则编辑正文里的字样天天误伤）')
    assert.equal(dangerousExecuteMatch({ title: 'Edit README' }), null)
  })
})

// ── v0.7.13：0.7.10 基线上新增（0.7.11 / 0.7.12 草案均未发布） ────────────────────
//
// 模型（终审裁定后的最终形态）：
//   ① **内容规则与形状判据都对整段命令文本生效** —— 包括 heredoc 载荷行；没有任何「载荷
//      豁免」层（B 仓没有宿主那条 `wrapper-option-ambiguity` 规则，当年那次误报不是本仓的）；
//   ② **归因顺序：先内容、后形状** —— 包装预算用尽 / shell 深度用尽这两条形状分支，先对同一
//      段的 token 后缀求值内容规则；命中就归因为内容规则（`sudo×9 rm -rf x` 的理由是
//      `rm -rf`），形状规则只在没有内容命中时兜底（`sudo×9 dd …` 仍是 `wrapper-nesting`）。
//      0.7.12 的载荷豁免按**归因 id** 吞掉内容命中 ⇒ 载荷里的真命令判 `null` ⇒ 静默放行
//      （终审 B-1）；本文件 E 组就是这条的回归牙；
//   ③ 唯一按语法豁免的是 **heredoc 终止行**（`heredocTerminatorLines`：整行恰好是某个已开启
//      heredoc 的 tag）—— 它不是命令。该豁免对现有 7 条规则**可证明无观测差异**（终止行是
//      单 token），F 组用**直接单元断言**钉它的语义（CRLF / `<<-` / 五种写法 / 各识别守卫），
//      但**不声称它对最终判定有牙**（变异实测：删掉跳过逻辑不改任何判定的用例）。
//
// 分组：A 内容规则全量扫（含载荷）；B 载荷行没有豁免（形状判据照旧看它）；C 固有多弹的代价；
//      E 交叉维度（内容归因 / 形状兜底 / 误伤守卫）；F 终止行与识别守卫（helper 直测）。
// 存量反放宽清单（17 条）与三条不变量在文件上方的 v0.7.9 各节里，一条未改。

/** 形状判据哨兵：9 跳透明包装（段首仍是包装器 ⇒ 跳数预算用尽） */
const SUDO9 = `${'sudo '.repeat(9)}ls`

/** 形状判据哨兵：三层 shell 嵌套（第 3 层起不再展开） */
const NESTED_SHELL = `sh -c 'sh -c "sh -c ls"'`

describe('v0.7.13 A 组：内容规则全量扫（含 heredoc 载荷行）', () => {
  it('A1 载荷里 / 环绕的真命令逐条命中（含写脚本再执行、进程替换、承载者开关、解释器）', () => {
    for (const [command, rule] of [
      ["ssh host <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' | ssh host\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat > /tmp/g <<'SH'\nrm -rf /tmp/x\nSH\nsh /tmp/g", 'rm -rf'],
      ["cat <<'SH' > /tmp/g; sh /tmp/g\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat > /tmp/g <<'SH'; sh /tmp/g\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' > /tmp/g && sh /tmp/g\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' > >(sh)\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["tee /dev/null <<'SH' \\\\| sh\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' \\\n| ssh host\nsh -c 'rm -rf /tmp/zz'\nSH", 'rm -rf'],
      ["cat() { ssh \"$1\"; }; cat <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["alias cat=ssh; cat <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["/tmp/plant/cat <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["tar --use-compress-program=sh -xf - <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["git -c alias.s='!sh' s <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["pwsh -Command - <<'P'\ngit push origin main\nP", 'git push'],
      ["powershell -Command - <<'P'\nnpm publish\nP", 'npm publish'],
      ["docker exec -i c <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["kubectl exec -i pod -- <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["at now <<'JOB'\nrm -rf /tmp/x\nJOB", 'rm -rf'],
      ["make -f - <<'MK'\nrm -rf /tmp/x\nMK", 'rm -rf'],
      ["fish <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["python3 - <<'PY'\nrm -rf /tmp/x\nPY", 'rm -rf'],
      // 载荷里的左移不得把后面的真命令藏起来
      ["ssh host <<'SH'\nx=$((size << shift))\nrm -rf /tmp/x\nshift\nSH", 'rm -rf'],
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${JSON.stringify(command)} 的载荷/环绕文本里有真命令 ⇒ 必须命中`)
      assert.equal(hit.rule, rule, `${JSON.stringify(command)} 的规则归因`)
    }
  })

  it('A2 载荷行**不是**免检区：`<<` 之前 / 载荷里 / 终止行之后三个位置一视同仁', () => {
    for (const command of [
      "rm -rf /tmp/x\ncat <<'EOF'\n正文\nEOF",
      "cat <<'EOF'\nrm -rf /tmp/x\nEOF",
      "cat <<'EOF'\n正文\nEOF\nrm -rf /tmp/x",
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)).rule, 'rm -rf', `${JSON.stringify(command)} 必须命中`)
    }
  })
})

describe('v0.7.13 B 组：载荷行**没有**豁免（形状判据照旧看它）', () => {
  it('B1 载荷里的透明包装/深嵌套照旧可疑（终审 B-2 回归牙：0.7.12 曾判 null）', () => {
    for (const [command, rule] of [
      // 终审 B-2 原形：执行型载荷 + 内容规则不覆盖的 dd
      [`sh <<'SH'\n${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2\nSH`, 'wrapper-nesting'],
      [`ssh host <<'SH'\n${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2\nSH`, 'wrapper-nesting'],
      [`sh <<'SH'\n${SUDO9}\nSH`, 'wrapper-nesting'],
      [`git commit -q -F - <<'EOF'\n${SUDO9}\nEOF`, 'wrapper-nesting'],
      [`cat <<-EOF\n\t${SUDO9}\n\tEOF`, 'wrapper-nesting'],
      [`sh <<'SH'\n${NESTED_SHELL}\nSH`, 'shell-nesting'],
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${JSON.stringify(command)} 的载荷行必须照旧参与判定（不得豁免）`)
      assert.equal(hit.rule, rule)
    }
  })

  it('B2 对照：同样的哨兵不在载荷里时行为一致（豁免不是「载荷以外才有」）', () => {
    assert.equal(dangerousExecuteMatch(exec(SUDO9)).rule, 'wrapper-nesting')
    assert.equal(dangerousExecuteMatch(exec(NESTED_SHELL)).rule, 'shell-nesting')
    assert.equal(dangerousExecuteMatch(exec('git commit -q -F - <<\'EOF\'\n普通正文\nEOF')), null,
      '普通正文（无危险字样、无形状可疑）⇒ 不判')
  })
})

describe('v0.7.13 C 组：固有多弹的代价（载荷正文提到危险命令字样）', () => {
  it('C1 载荷正文里真的写出危险命令字样 ⇒ 多弹一次（0.7.10 起既有行为，如实登记）', () => {
    for (const [command, rule] of [
      ["git commit -q -F - <<'EOF'\nfix: note\ngit push 这类命令写在正文里时也只是在描述\nEOF", 'git push'],
      ['cat <<EOF > /tmp/f\nrm -rf /tmp/x 是文档里的一句话\nEOF', 'rm -rf'],
      ["tee /tmp/note.md <<'EOF'\nrm -rf /tmp/x 是文档里的一句话\nEOF", 'rm -rf'],
      ["patch -p1 <<'EOF'\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-echo old\n+echo new\nrm -rf /tmp/x\nEOF", 'rm -rf'],
      ["gzip -d <<'G'\nrm -rf /tmp/x 只是正文\nG", 'rm -rf'],
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${JSON.stringify(command)} 的载荷里真有危险命令字样 ⇒ 命中（代价）`)
      assert.equal(hit.rule, rule)
    }
  })

  it('C2 阴性对照：普通正文（无危险字样、无形状可疑）⇒ 不判（不是「一律弹」）', () => {
    for (const command of [
      "git commit -q -F - <<'EOF'\nfix: 调整日志措辞\nEOF",
      "git commit -q -F - <<'EOF'\n- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒\nEOF",
      'cat <<EOF > /tmp/f\njust an ordinary note\nEOF',
      "patch -p1 <<'EOF'\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-echo old\n+echo new\nEOF",
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${JSON.stringify(command)} 的载荷没有危险内容`)
    }
  })
})

describe('v0.7.13 E 组：交叉维度（内容归因优先 / 形状兜底 / 误伤守卫）', () => {
  it('E1 四种承载者 × 载荷 `sudo×9 dd …`（内容规则不覆盖）⇒ 形状判据必须抓到', () => {
    for (const carrier of ["sh <<'SH'", "ssh host <<'SH'", "python3 - <<'PY'", "at now <<'JOB'"]) {
      const command = `${carrier}\n${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2\nSH`
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${carrier} 的载荷会被执行且内容规则不覆盖 dd ⇒ 必须非 null（不得静默放行）`)
      assert.equal(hit.rule, 'wrapper-nesting')
    }
  })

  it('E2 同上 × 载荷 `command×9 rm -rf /tmp/x` ⇒ 必须非 null **且归因是 `rm -rf`**（B-1 回归牙）', () => {
    for (const carrier of ["sh <<'SH'", "ssh host <<'SH'", "python3 - <<'PY'", "at now <<'JOB'"]) {
      const command = `${carrier}\n${'command '.repeat(9)}rm -rf /tmp/x\nSH`
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${carrier} 的载荷里有真命令 ⇒ 必须非 null`)
      assert.equal(hit.rule, 'rm -rf', `${carrier}：留痕理由必须是内容规则，不是形状规则`)
    }
  })

  it('E3 三层 `sh -c` 包着 `rm -rf` 写在载荷里 ⇒ 非 null（归因 `rm -rf`）', () => {
    for (const command of [
      `sh <<'SH'\nsh -c 'sh -c "rm -rf /tmp/x"'\nSH`,
      `cat <<'EOF'\nbash -c "bash -c \\"rm -rf /x\\""\nEOF`,
    ]) {
      const hit = dangerousExecuteMatch(exec(command))
      assert.ok(hit, `${JSON.stringify(command)} 必须非 null`)
      assert.equal(hit.rule, 'rm -rf')
    }
  })

  it('E4 归因表：包装预算用尽 / shell 深度用尽 ⇒ 内容优先，无内容才落形状', () => {
    for (const [command, rule] of [
      [`${'sudo '.repeat(9)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'sudo '.repeat(20)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'command '.repeat(9)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'env '.repeat(9)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'nohup '.repeat(9)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'nice '.repeat(9)}rm -rf /tmp/x`, 'rm -rf'],
      [`${'sudo '.repeat(9)}git push origin main`, 'git push'],
      [`${'sudo '.repeat(9)}npm publish`, 'npm publish'],
      [`${'sudo '.repeat(9)}pnpm publish`, 'pnpm publish'],
      [`${'sudo '.repeat(9)}yarn publish`, 'yarn publish'],
      [`${'sudo '.repeat(8)}rm -rf /tmp/x`, 'rm -rf'],
      // 形状兜底（没有内容命中时仍是「可疑」，预算/深度本身不取消）
      [`${'sudo '.repeat(9)}ls /x`, 'wrapper-nesting'],
      [`${'sudo '.repeat(20)}ls /x`, 'wrapper-nesting'],
      [NESTED_SHELL, 'shell-nesting'],
    ]) {
      const hit = dangerousCommandMatch(command)
      assert.ok(hit, `${JSON.stringify(command)} 必须命中`)
      assert.equal(hit.rule, rule, `${JSON.stringify(command)} 的归因`)
    }
  })

  it('E5 归因守卫：这些「只是被打印/提及」的形态在 v0.7.15 起由全文判定接管（用户裁定代价）', () => {
    // 0.7.13/0.7.14 的口径是「命令只是被打印出来 ⇒ 不判」；v0.7.15 用户裁定改成**全文判定**：
    // 文本里出现危险字样就弹，包括打印/提及。这里逐条钉住新语义（正面断言，不是"没被判"）。
    const expected = [
      ['echo rm -rf /tmp/x', 'text:rm -rf'],
      ['echo "git push"', 'text:git push'],
      ['echo npm publish', 'text:npm publish'],
      ['grep -rn "git push" docs/', 'text:git push'],
      ['ls; # rm -rf /tmp', 'text:rm -rf'],
    ]
    for (const [command, rule] of expected) {
      assert.equal(dangerousExecuteMatch(exec(command)).rule, rule, `${command} 按裁定必须命中（归因 ${rule}）`)
    }
  })
})

describe('v0.7.13 F 组：heredoc 终止行（helper 直测；对最终判定无观测差异）', () => {
  it('F1 五种 tag 写法 + `<<-` 缩进：终止行行号', () => {
    for (const open of ["<<'EOF'", '<<"EOF"', '<<\\EOF', '<<EOF', '<< EOF']) {
      assert.deepEqual([...heredocTerminatorLines(`cat ${open}\n正文\nEOF`)], [2], `${open} 的终止行`)
    }
    assert.deepEqual([...heredocTerminatorLines('cat <<-EOF\n\t正文\n\tEOF')], [2], '`<<-` 允许前导 TAB')
    assert.deepEqual([...heredocTerminatorLines('cat <<-EOF\n正文\n  EOF\nEOF')], [3],
      '空格缩进**不是** `<<-` 的终止行 ⇒ 真正的终止行在下一行')
    assert.deepEqual([...heredocTerminatorLines("cat <<'EOF'\n正文\nEOF \nEOF")], [3],
      '尾随空格不算终止行（非 `<<-` 形态必须整行就是 tag）')
  })

  it('F2 CRLF 文本：`<<\'EOF\'\\r\\n…EOF\\r\\n` 的终止行必须认出来', () => {
    assert.deepEqual([...heredocTerminatorLines("cat <<'EOF'\r\n正文\r\nEOF\r\n")], [2],
      'CRLF 行尾的 `\\r` 不得让终止行失配')
    assert.deepEqual([...heredocTerminatorLines("cat <<-EOF\r\n\t正文\r\n\tEOF\r\n")], [2], '`<<-` + CRLF')
    // 认出来只是「不跳过那一行」的反面：终止行之后的真命令照旧命中
    assert.equal(dangerousExecuteMatch(exec("cat <<'EOF'\r\n正文\r\nEOF\r\nrm -rf /tmp/x")).rule, 'rm -rf')
  })

  it('F3 识别守卫逐条（直接看 helper 的输出：伪 heredoc 不得产生终止行）', () => {
    for (const [name, text] of [
      ['引号里的 <<', 'cat "doc: see <<EOF for details"\nEOF'],
      ['引号里的 <<（尾部引号配平）', 'cat "a <<EOF" "b" "c" x\nEOF'],
      ['注释里的 <<', 'cat x # <<EOF\nEOF'],
      ['算术 $((1<<n))', 'cat out.$((1<<n))\nn'],
      ['算术 $((1 << n))', 'cat out.$((1 << n))\nn'],
      ['算术 $((a << n))（左操作数是变量）', 'cat out.$((a << n))\nn'],
      ['算术 1<<n（非算术上下文，保守不认）', 'cat out 1<<n\nn'],
      ['算术展开 $[1<<n]', 'cat out.$[1<<n]\nn'],
      ['here-string <<<', 'cat <<<EOF\nEOF'],
      ['here-string <<<<（哨兵）', 'cat <<<<EOF\nEOF'],
      ['转义的 \\<<', 'cat \\<<EOF\nEOF'],
      ['tag 是变量 <<$TAG', 'cat <<$TAG\n$TAG'],
      ['tag 是数字 <<1', 'cat <<1\n1'],
      ['tag 带斜杠 <<a/b', 'cat <<a/b\na'],
      ['找不到终止行', "git commit -F - <<'EOF'\n正文"],
    ]) {
      assert.deepEqual([...heredocTerminatorLines(text)], [], `${name}：不得产生终止行`)
    }
  })

  it('F4 多 heredoc 按行内顺序配对；载荷里的 `<<` 不识别；超预算不再认', () => {
    assert.deepEqual([...heredocTerminatorLines('cat <<T1 <<T2\n正文\nT1\n正文\nT2')], [2, 4],
      '两个起始按行内顺序各配一个终止行')
    assert.deepEqual([...heredocTerminatorLines('cat <<A\ncat <<B\n正文\nA\nB')], [3],
      '载荷里的 `<<B` 不被识别 ⇒ 只有 A 的终止行')
    const over = `cat ${Array.from({ length: MAX_HEREDOC_OPS + 1 }, (_, i) => `<<T${i + 1}`).join(' ')}\nT1`
    assert.deepEqual([...heredocTerminatorLines(over)], [], '超预算 ⇒ 本行起始一个都不认（多弹方向）')
    const within = `cat ${Array.from({ length: MAX_HEREDOC_OPS }, (_, i) => `<<T${i + 1}`).join(' ')}\nT1`
    assert.deepEqual([...heredocTerminatorLines(within)], [1], '预算内照旧配对')
  })

  it('F5 终止行不是命令：tag 叫 `sh`/`bash` 也不多弹；终止行之后的真命令照旧判', () => {
    for (const tag of ['sh', 'bash', 'sudo', 'rm', 'git']) {
      assert.equal(dangerousExecuteMatch(exec(`cat <<'${tag}'\n正文\n${tag}`)), null,
        `终止行 \`${tag}\` 不是命令 ⇒ 不得多弹（该豁免对现有规则无观测差异，见 F 组说明）`)
    }
    assert.equal(dangerousExecuteMatch(exec("cat <<'EOF'\n正文\nEOF\nrm -rf /tmp/x")).rule, 'rm -rf',
      '终止行之后的真命令照旧参与判定')
  })
})

describe('v0.7.13 收尾 G 组：形状归因的后缀窗口上限（性能回归）与上限常量', () => {
  // 背景（终审 Minor-1）：`contentRuleOf` 从**每个** token 后缀起求值规则表，不设上限时是
  // O(n²)。实测（`sudo×N + ls`，修复前）32768 个 token 已经 2.9s、100000 个 token（500KB）
  // 35.9s —— 危险门跑在授权决策的关键路径上，必须封顶。现在只回看**最后**
  // `MAX_ATTRIBUTION_TOKENS` 个 token：窗口变小只会让步归因退回形状规则名
  // （`wrapper-nesting` / `shell-nesting`），**不会**判 `null`、不会放行。
  const sudoN = (n, tail) => `${'sudo '.repeat(n)}${tail}`

  it('G1 上限常量是字面量（钉住数值：掩码/窗口的"预算"改动必须显式改断言）', () => {
    // `MAX_HEREDOC_OPS`：单次判定最多认多少个 heredoc 起始，只影响**终止行识别**（终止行是
    // 单 token，对现有 7 条规则无观测差异）⇒ 调小它最多是「少跳过几个终止行」（那些行照旧
    // 参与判定），方向只能是多弹，不会少弹。
    assert.equal(MAX_HEREDOC_OPS, 64, 'heredoc 起始识别预算被改动 ⇒ 请显式确认方向（只能更保守）')
    // `MAX_ATTRIBUTION_TOKENS`：形状归因的后缀窗口；调小它最多让归因退回形状规则名（仍拦），
    // 调大它只影响性能。两者都不允许变成放行。
    assert.equal(MAX_ATTRIBUTION_TOKENS, 256, '形状归因窗口被改动 ⇒ 请同时复核 G3 的性能断言')
  })

  it('G2 超出窗口仍必须 HIT（窗口变小只允许"归因变粗"，绝不允许放行）', () => {
    assert.equal(dangerousCommandMatch(sudoN(1000, 'rm -rf /tmp/x')).rule, 'rm -rf',
      '窗口内（1000 token）照旧精确归因')
    for (const n of [4096, 32768]) {
      const hit = dangerousCommandMatch(sudoN(n, 'rm -rf /tmp/x'))
      assert.ok(hit, `sudo×${n} + rm -rf 必须命中（归因可以是形状规则，但绝不能是 null）`)
      assert.ok(hit.rule === 'rm -rf' || hit.rule === 'wrapper-nesting',
        `sudo×${n} 的归因应是内容规则或形状规则，实际 ${hit.rule}`)
    }
    // 载荷形态（heredoc 里）同理：超限 + 载荷 ⇒ 仍拦。
    const inPayload = dangerousCommandMatch(`cat <<'SH'\n${sudoN(2048, 'rm -rf /tmp/x')}\nSH`)
    assert.ok(inPayload && inPayload.rule, '载荷里的超长包装链照旧命中')
    // 帧路径（真实调用面）也必须是「拦」，不是 null。
    const viaFrame = dangerousExecuteMatch(exec(sudoN(32768, 'git push origin main')))
    assert.ok(viaFrame, '帧路径：超长包装链 + git push ⇒ 必须拦（不得 null）')
    assert.ok(viaFrame.rule === 'git push' || viaFrame.rule === 'wrapper-nesting',
      `帧路径归因应是内容规则或形状规则，实际 ${viaFrame.rule}`)
  })

  it('G3 性能：500KB 对抗性输入单次判定 < 400ms（O(n²) 回归牙；修复前 33.8s）', () => {
    const huge = sudoN(100000, 'ls') // ~500KB
    assert.equal(dangerousCommandMatch(huge).rule, 'wrapper-nesting', '结论不变：仍按形状规则保守转交互')
    const best = () => {
      let ms = Infinity
      for (let i = 0; i < 3; i += 1) {
        const t0 = process.hrtime.bigint()
        dangerousCommandMatch(huge)
        ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6)
      }
      return ms
    }
    // 阈值 400ms（终审 Minor-1：隔离实测 36–65ms，但**全量 534 用例并发加载**下曾见 165.6ms 的
    // 偶发失败 —— 与算法无关的调度抖动）。相对去掉窗口上限的 P1（33.8s / 2.7s@32768）仍留 ~85×
    // 余量，回归牙不钝；同时改后带宽窗口上限的变异 P1 仍然转红（见报告变异表）。
    const pure = best()
    assert.ok(pure < 400, `纯函数面 sudo×100000（~500KB）单次 ${pure.toFixed(1)}ms ≥ 400ms ⇒ 后缀窗口上限失效`)
    const t0 = process.hrtime.bigint()
    dangerousExecuteMatch(exec(huge))
    const viaFrame = Number(process.hrtime.bigint() - t0) / 1e6
    assert.ok(viaFrame < 400, `帧路径 sudo×100000 单次 ${viaFrame.toFixed(1)}ms ≥ 400ms`)
  })
})

describe('v0.7.14 H 组：判定前的文本归一化（续行拼接 / 换行=段分隔符 / 折叠空白）', () => {
  // 用户裁定的**最终规格**（保守策略，只做**文本层**、不做 `-c`/`-Command` 这类按 flag 的解析）：
  //   · 行尾**未转义**的 `\`（含 CRLF、`\` 后带空格）⇒ 去掉 `\` 与换行、**直接拼接**（不留空格）；
  //   · **真实换行 / CRLF / 裸 CR / 字面 `\n`·`\r` 两字符序列** ⇒ 一律当**段分隔符**（切段，
  //     **不折成空格**；引号内也切并重置引号状态）；
  //   · **字面 `\t`** ⇒ 折成**一个空格**（不切段）；其它连续空白折叠成单个空格；
  //   · 奇数个 `\\`、转义空格 `\ ` ⇒ 不属续行族，不动。
  //   为什么换行不折空格：折成空格会抹平**行首/段首**语义 ⇒ 多行脚本从命中变 MISS（那是**变松**）。
  //   见 `normalizeCommandText` 与 `splitSubCommands` 的说明；两处各有断言 + 变异钉住。
  const NL = '\n'

  it('H1 验收：续行 / 多行 `-c` 实参 / 字面 `\\n`·`\\t` / 空白规避 ⇒ 全部命中（改前逐条 MISS）', () => {
    for (const [command, rule] of [
      // A 类：行尾未转义的 `\`（改前 `git \` 与 `push origin main` 各自成段 ⇒ MISS）
      [`git \\${NL}push origin main`, 'git push'],
      [`npm \\${NL}publish`, 'npm publish'],
      [`pnpm \\${NL}publish`, 'pnpm publish'],
      [`yarn \\${NL}publish`, 'yarn publish'],
      [`rm \\${NL}-rf /tmp/x`, 'rm -rf'],
      [`git \\\r${NL}push origin main`, 'git push'], // CRLF 续行
      [`git \\ ${NL}push origin main`, 'git push'], // 行尾 `\` 后带空格
      // B 类：多行 `-c` / `-Command` 实参（引号内的换行现在也切段，见 splitSubCommands）
      [`sh -c "true${NL}rm -rf /tmp/x"`, 'rm -rf'],
      [`bash -c "echo hi${NL}git push origin main"`, 'git push'],
      [`pwsh -Command "x${NL}npm publish"`, 'npm publish'],
      [`powershell -Command "y${NL}git push origin main"`, 'git push'],
      [`sh -c "true${NL}pnpm publish"`, 'pnpm publish'],
      // 空白规避
      ['rm  -rf /tmp/x', 'rm -rf'],
      ['rm \t -rf  /tmp/x', 'rm -rf'],
      [`git${'\t'}push origin main`, 'git push'],
      [`git\\tpush origin main`, 'git push'], // 字面 `\t` 两字符序列 ⇒ 一个空格
      // 字面 `\n` / `\r`（两字符序列）⇒ **段分隔符**（Python/Node 之类消费者里它就是真换行）
      [`sh -c "x\\nnpm publish"`, 'npm publish'],
      [`sh -c "true\\nrm -rf /tmp/x"`, 'rm -rf'],
      [`git add -A\\rgit push origin main`, 'git push'],
    ]) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 必须命中 ${rule}`)
    }
  })

  it('H2 不许变松：改前命中的形态逐条仍在（多行脚本 / 双读保险 / 载荷 / 空白）', () => {
    for (const [command, rule] of [
      // 多行脚本：真实换行仍是段分隔符（折成空格就会从命中变 MISS）
      [`git add -A${NL}git commit -m x${NL}git push origin main`, 'git push'],
      [`true${NL}git push origin main`, 'git push'],
      [`echo x${NL}sudo rm -rf /tmp/y`, 'rm -rf'],
      [`cat <<'EOF'${NL}rm -rf /tmp/x${NL}EOF`, 'rm -rf'],
      ['rm -rf /tmp/x', 'rm -rf'],
      // 双读保险：合并后**段首不再是包装器/形状**、但改前那一行本身命中的形态
      [`echo hi \\${NL}sh -c 'sh -c "sh -c ls"'`, 'shell-nesting'],
      [`echo hi \\${NL}${'sudo '.repeat(9)}ls`, 'wrapper-nesting'],
      [`x=1 \\${NL}rm -rf /tmp/x`, 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 仍必须命中 ${rule}`)
    }
    // **「双读存在」的显式断言**（配变异 P-2READ：删掉原文那一遍 ⇒ 本条转红）：
    // 上面第一条的**合并结果**自己是 MISS（段首成了 `echo`），靠原文那一遍兜住。
    assert.equal(dangerousCommandMatch(`echo hi sh -c 'sh -c "sh -c ls"'`), null,
      '合并结果本身不命中 ⇒ 双读（原文那一遍）是必需的，不是冗余')
    // 旧引号口径兜底（第三遍）的必要性：引号**跨行错配**时两种切法给出不同的段 —— 新口径按换行切，
    // 第二段被未闭合引号吞掉 ⇒ 会漏；旧口径（0.7.13 的切法）把两个引号配成一对，`;` 才切段 ⇒ 命中。
    // 这几条在 0.7.13 上是命中的，改成新口径后一度变 MISS（自造 40 万条语料差分里 28 条），靠这一遍兜住。
    // v0.7.15 起归因可能落在**另一条**内容规则上（全文判定/段判定先看到哪个就是哪个，都是命中）：
    // 例如第 3 条里 `npm publish` 出现在第一段的引号内 ⇒ 归因 `npm publish` 而不是 `rm -rf`。
    // 所以这里只钉「非 null **且是内容型归因**（不是形状兜底）」，不再钉具体是哪条。
    for (const command of [
      `sh -c "true${NL}sh -c "true; rm -rf /tmp/x`,
      `sh -c "true${NL}sh -c "true && git push origin main`,
      `sh -c "true${NL}npm publish"; rm -rf /tmp/x`,
      `sh -c "true\r${NL}sh -c "true; npm publish`,
    ]) {
      const hit = dangerousCommandMatch(command)
      assert.ok(hit, `${JSON.stringify(command)} 必须仍命中（旧引号口径兜底），不得变 MISS`)
      assert.ok(['rm -rf', 'git push', 'npm publish', 'text:rm -rf', 'text:git push', 'text:npm publish'].includes(hit.rule),
        `${JSON.stringify(command)} 的归因必须是内容型（实际 ${hit.rule}）`)
    }
  })

  it('H3 行首语义没有被抹平（真实换行仍是段分隔符）', () => {
    assert.equal(dangerousCommandMatch(`echo x${NL}sudo rm -rf /tmp/y`).rule, 'rm -rf', '第二行独立成段 ⇒ 照旧命中')
    assert.equal(dangerousCommandMatch(`echo hi${NL}git push origin main`).rule, 'git push')
    assert.equal(dangerousCommandMatch(`echo hi${NL}npm publish`).rule, 'npm publish')
    // ⚠️ `echo hi` ⏎ `- rm -rf /tmp/x` 这类「行首是选项」的形状归 **宿主仓** 的
    // `wrapper-option-ambiguity` 规则管，B 仓没有那条规则 ⇒ 改前改后都是 MISS（不是归一化造成的，
    // 见报告与文件头的"不覆盖写法"）。这里**不**断言它的 MISS，免得把边界钉成绿灯。
  })

  it('H4 【口径已被 v0.7.15 取代】句中只是提到 ⇒ 现在**判**（用户裁定的代价，不是缺陷）', () => {
    // 0.7.14 及以前的断言是「只是文本提及 ⇒ 不该弹」。用户 0.7.15 明确裁定改为全文判定后，
    // 这条口径**作废**：提到就弹。这里保留同样的语料，但断言翻成"必须命中 + 归因是全文判定"
    // —— 它们是裁定代价的正面证据（CHANGELOG「模式变更与代价（用户裁定）」引用这组用例）。
    const cost = [
      ['echo "note: never run rm -rf /tmp/x by hand"', 'text:rm -rf'],
      ['git commit -m "fix: never git push --force"', 'text:git push'],
      ['echo rm -rf /tmp/x', 'text:rm -rf'],
      ['# 注释：rm -rf /tmp/x', 'text:rm -rf'],
    ]
    for (const [command, rule] of cost) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 提到即弹（裁定代价）`)
    }
    // 真反例仍必须是 null：文本里没有危险字样（`git log --grep "push"` 只有动词、没有程序名）
    assert.equal(dangerousCommandMatch('git log --grep "push"'), null)
    assert.equal(dangerousCommandMatch('npm run build"'), null)
  })

  it('H5 normalizeCommandText 直测（含折叠空白与"不并"的边界）', () => {
    assert.equal(normalizeCommandText(`git \\${NL}push origin main`), 'git push origin main')
    assert.equal(normalizeCommandText(`git \\\r${NL}push origin main`), 'git push origin main')
    // `\ `（转义空格）**不属**续行族（用户裁定：不要顺手改）⇒ 保留字面 `\`
    assert.equal(normalizeCommandText(`git \\ \\${NL}push origin main`), 'git \\ push origin main')
    // 偶数个反斜杠 = 转义的反斜杠 ⇒ **不是**续行（不要顺手并掉）；换行照旧是分隔符
    assert.equal(normalizeCommandText(`echo a \\\\${NL}git push`), `echo a \\\\${NL}git push`)
    // 字面 `\n`/`\r`（两字符）⇒ **段分隔符**（不折空格）；字面 `\t` ⇒ 一个空格；裸 CR ⇒ 段分隔符
    assert.equal(normalizeCommandText('a\\nb'), `a${NL}b`, '字面 \\n 必须变成真换行（段分隔符），不是空格')
    assert.equal(normalizeCommandText('a\\rb'), `a${NL}b`, '字面 \\r 同理')
    assert.equal(normalizeCommandText('git\\tpush origin main'), 'git push origin main', '字面 \\t 折成一个空格')
    assert.equal(normalizeCommandText('a\rb'), `a${NL}b`, '裸 CR 也是段分隔符')
    // 折叠连续空白（TAB/多空格/混合），并去掉段首空白
    assert.equal(normalizeCommandText('rm  \t  -rf   /tmp/x'), 'rm -rf /tmp/x')
    assert.equal(normalizeCommandText(`   rm -rf /tmp/x${NL}  git push`), `rm -rf /tmp/x${NL}git push`)
    // **真实换行保留为段分隔符**（**绝不折成空格**）—— 「变松 0」的支柱之一，配变异 P-NL 钉住
    assert.equal(normalizeCommandText(`a${NL}b`), `a${NL}b`, '真实换行必须原样保留（折成空格会抹平段首语义）')
    assert.equal(normalizeCommandText(`git add -A${NL}git commit -m x${NL}git push origin main`),
      `git add -A${NL}git commit -m x${NL}git push origin main`)
    // 无 `\`/裸 CR/多空白 ⇒ 原样返回（快路径，普通输入零改写、零代价）
    const plain = 'git push origin main'
    assert.equal(normalizeCommandText(plain), plain)
    assert.equal(normalizeCommandText(`${'x'.repeat(10)}${NL}git push`), `${'x'.repeat(10)}${NL}git push`)
  })

  it('H6 段尾落单引号不影响判定（换行在引号内切段的配套归一）', () => {
    assert.equal(dangerousCommandMatch(`pwsh -Command "x${NL}npm publish"`).rule, 'npm publish',
      '切出来的第二段末尾带落单 `"` ⇒ 比较用 token 必须去掉它')
    assert.equal(dangerousCommandMatch(`git commit -m x${NL}git push"`).rule, 'git push')
    // 反向：落单引号不得把「不是动词」的 token 变成动词；
    // 且全文判定有**词边界**：`npm publishing` 不是 `npm publish`（尾部多出词字符 ⇒ 不命中）。
    assert.equal(dangerousCommandMatch('npm run build"'), null)
    assert.equal(dangerousCommandMatch('echo "npm publishing"'), null, '词边界挡住"包含但不是它"')
  })
})

// ── v0.7.15 J 组：全文危险词判定 + 配置项（用户裁定）──────────────────────────────
//
// 用户裁定原话：「改成全文子串判定：文本里出现危险字样就弹」，并追加「做成一个配置项，
// 以后可以动态增加高危判断的字符串。目前预设 `rm -rf`、`git push`、`npm publish` 三个先」。
// 本组钉住四件事：①内容型规则在**命令头/段中/引号内**三种位置都命中（段中与引号内只能靠全文层）；
// ②容差清单与反例边界（词边界挡住"包含但不是它"）；③配置项语义（缺文件/坏 JSON/非数组/[]/自定义/
// 去重/免重启/不做正则）；④**代价**（提及即弹）是用户裁定，写成正面断言，不加豁免。
describe('v0.7.15 J 组：全文危险词判定（用户裁定：文本里出现危险字样就弹）', () => {
  it('J1 内容型规则 × 三种位置（命令头 / 段中 / 引号内）⇒ 全部命中', () => {
    const cases = [
      // 命令头：按段判定（既有规则）就能命中
      ['rm -rf /tmp/x', 'rm -rf'],
      ['git push origin main', 'git push'],
      ['npm publish --tag next', 'npm publish'],
      // 段中：命令头不是危险程序 ⇒ 只有全文层能看见
      ['echo rm -rf /tmp/x', 'text:rm -rf'],
      ['printf ok git push origin main', 'text:git push'],
      ['mkdir -p out && echo npm publish', 'text:npm publish'],
      // 引号内：同样只有全文层能看见
      ['echo "rm -rf /tmp/x"', 'text:rm -rf'],
      ["echo 'git push origin main'", 'text:git push'],
      ['echo "npm publish --tag next"', 'text:npm publish'],
    ]
    for (const [command, rule] of cases) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 必须命中（${rule}）`)
    }
  })

  it('J2 容差清单（命中）：多空白 / TAB / 续行 / 引号包裹 / 选项分写与顺序 / 提及', () => {
    // 空白与续行（归一化的产物）
    for (const command of ['rm  -rf /tmp/x', 'rm \t -rf /tmp/x', 'rm \\\n-rf /tmp/x',
      'git   push origin main', `git${'\t'}push origin main`, 'npm \\\npublish']) {
      assert.ok(dangerousCommandMatch(command), `${JSON.stringify(command)} 必须命中（空白/续行容差）`)
    }
    // 引号包裹的单 token 与整串
    assert.equal(dangerousCommandMatch('rm "-rf" /tmp/x').rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('rm --recursive --force /tmp/x').rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('/bin/rm -rf /tmp/x').rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('sudo rm -rf /tmp/x').rule, 'rm -rf')
    // 提及（代价，见 J6/J7）
    for (const command of ['git commit -m "fix: avoid rm -rf"', '# 注释：不要用 rm -rf',
      'git log --grep "git push"', 'grep -rn "npm publish" docs/', 'cat notes.txt # rm -rf /tmp',
      'curl -s "https://x.example/a?b=1&rm -rf"', 'printf "rm -rf\\n"']) {
      assert.ok(dangerousCommandMatch(command), `${JSON.stringify(command)} 必须命中（提及代价）`)
    }
  })

  it('J3 反例边界（故意不命中）：程序名/动词/组合不成立，或词边界挡住', () => {
    for (const command of [
      'rmdir /tmp/x', 'rmdir -rf x', 'format -rf x', // 不含 `rm -rf` 这个子串
      'perform -rf x', 'legit push origin', 'digit push origin', // 左边界：前面是词字符
      'npm publisher', 'git pushd', 'git pushpin', 'yarn publishing', // 右边界：后面是词字符
      'rm -r ./only', 'rm -f ./only', 'rm ./plain', // rm 规则要求双标志（既有判据保留）
      'npm run publish', 'pnpm run publish', 'yarn run publish', // 动词不是 publish
      'git log --grep push', 'git log -p --follow src/push.ts',
      'ls -la /tmp', 'echo hi', 'bash --norc', 'npm --version',
      'git clean -fdx', 'git reset --hard', 'lerna publish', 'make deploy', 'bash deploy.sh',
      'S=rm; $S -rf x', 'python -c "os.system(\'$CMD -rf /\')"',
    ]) {
      assert.equal(dangerousCommandMatch(command), null, `${JSON.stringify(command)} 不得命中`)
    }
  })

  it('J4 归因 id：内置三串 `text:<串>`；自定义串 `text:custom:<原串>`；既有规则 id 不变', () => {
    assert.equal(dangerousCommandMatch('echo "rm -rf"').rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push')
    assert.equal(dangerousCommandMatch('echo "npm publish"').rule, 'text:npm publish')
    for (const [command, rule] of [
      ['rm -rf /tmp/x', 'rm -rf'], ['pnpm publish', 'pnpm publish'],
      ['yarn publish', 'yarn publish'], ['git push', 'git push'], ['npm publish', 'npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${command} 的既有归因 id 不得变`)
    }
    // 命中片段非空且是文本里真实存在的一段（排障要看得到现场）
    const hit = dangerousCommandMatch('git commit -m "fix: avoid rm -rf"')
    assert.ok(hit.segment.length > 0 && 'git commit -m "fix: avoid rm -rf"'.includes(hit.segment),
      `segment 必须是原文的一段（实际 ${JSON.stringify(hit.segment)}）`)
  })

  it('J5 两个入口都覆盖：帧的四种正文来源里出现危险字样都必须命中', () => {
    // rawInput.command（qoder 形态）
    assert.equal(dangerousExecuteMatch(exec('echo "npm publish"')).rule, 'text:npm publish')
    // arguments.command（老模型形态）
    assert.equal(dangerousExecuteMatch({ kind: 'execute', arguments: { command: 'echo "git push"' } }).rule,
      'text:git push')
    // content[].content.text（kind=execute 非执行类 name 时 content 文本可信）
    assert.equal(dangerousExecuteMatch({
      kind: 'execute', name: 'shell', content: [{ content: { text: 'echo "rm -rf /tmp/x"' }, type: 'content' }],
    }).rule, 'text:rm -rf')
    // 非执行类帧仍然不认（不是"把所有字段都当命令扫"）
    assert.equal(dangerousExecuteMatch({ kind: 'edit', title: 'echo "rm -rf /tmp/x"', rawInput: { file_path: 'a.sh' } }), null)
  })
})

describe('v0.7.15 J 组：危险词配置项（$DSH_HOME/data/dsh-danger-patterns.json）', () => {
  const withHome = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-danger-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    resetDangerPatternsCache()
    try {
      return fn(dir)
    } finally {
      resetDangerPatternsCache()
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const write = (dir, content) => {
    const file = join(dir, 'data', dangerPatternsPath().split('/data/').pop())
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
  }

  it('J6 缺文件 ⇒ 内置预设三项；路径与规格逐字一致', () => {
    withHome((dir) => {
      assert.equal(dangerPatternsPath(), join(dir, 'data', 'dsh-danger-patterns.json'))
      assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
      assert.deepEqual(DEFAULT_DANGER_PATTERNS, ['rm -rf', 'git push', 'npm publish'])
      // 预设三项的**提及**都命中；预设之外的 `pnpm publish` 提及不命中（配置可加，见 J8）
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push')
      assert.equal(dangerousCommandMatch('echo "pnpm publish"'), null, '预设只含用户指定的三串')
    })
  })

  it('J7 坏 JSON / `patterns` 非数组 / `[]` ⇒ 一律"没有追加项"，内置三串照常生效（按摘要各告警一次）', () => {
    withHome((dir) => {
      const warnings = []
      const realWarn = console.warn
      console.warn = (msg) => warnings.push(String(msg))
      try {
        write(dir, '{ broken json')
        assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
        assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '读取失败也必须照旧判')
        // 按摘要分别计数（静默任一条告警，下面两行就会各自转红）
        assert.equal(warnings.filter((w) => w.includes('危险词配置读取失败')).length, 1, '坏 JSON 恰告警一次')
        assert.equal(warnings.filter((w) => w.includes('不是数组')).length, 0, '此时还没出现非数组那条')
        write(dir, { patterns: 'nope' })
        assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
        assert.equal(warnings.filter((w) => w.includes('危险词配置读取失败')).length, 1, '坏 JSON 仍只 1 次（不重复刷屏）')
        assert.equal(warnings.filter((w) => w.includes('不是数组')).length, 1, '非数组恰告警一次')
        assert.equal(warnings.length, 2, '两种情形各自留痕一次')
        // `[]` = "没有追加项"（**不是**关闭）：内置三串必须照常命中，且不额外告警
        write(dir, { patterns: [] })
        assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
        assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '`[]` 不得关层')
        assert.equal(dangerousCommandMatch('echo "rm -rf"').rule, 'text:rm -rf')
        assert.equal(dangerousCommandMatch('echo "npm publish"').rule, 'text:npm publish')
        assert.equal(warnings.length, 2, '`[]` 是合法状态，不增加告警')
      } finally {
        console.warn = realWarn
      }
    })
  })

  it('J8 追加项生效：内置三串 + 追加项；**只增不减**（删掉追加项后内置仍在）', () => {
    withHome((dir) => {
      write(dir, { patterns: ['pnpm publish', 'deploy  --force'] })
      assert.deepEqual(readDangerPatterns(), ['rm -rf', 'git push', 'npm publish', 'pnpm publish', 'deploy --force'],
        '内置三串在前 + 追加项（逐条 trim + 折叠空白）')
      assert.equal(dangerousCommandMatch('echo "pnpm publish"').rule, 'text:custom:pnpm publish')
      assert.equal(dangerousCommandMatch('echo deploy   --force now').rule, 'text:custom:deploy --force',
        '配置串内部的空白折叠后仍容忍文本里的任意空白')
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '内置串与追加项同时在场')
      // 与内置串重复的追加项被去重，且归因仍按内置串（`text:<串>`）
      write(dir, { patterns: ['rm -rf', 'git push'] })
      assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS, '与内置重复 ⇒ 去重')
      assert.equal(dangerousCommandMatch('echo "rm -rf"').rule, 'text:rm -rf', '归因仍用内置 id')
      // 删掉追加项 ⇒ 追加项立刻失效，但**内置三串仍然在**（只增不减）
      write(dir, { patterns: [] })
      assert.equal(dangerousCommandMatch('echo "pnpm publish"'), null, '追加项删掉后立刻失效')
      for (const [command, rule] of [['echo "rm -rf"', 'text:rm -rf'], ['echo "git push"', 'text:git push'],
        ['echo "npm publish"', 'text:npm publish']]) {
        assert.equal(dangerousCommandMatch(command).rule, rule, `${command} 内置串不可通过配置关闭`)
      }
    })
  })

  it('J9 配置项：去重 / 丢空串 / **不执行正则** / 免重启（mtime+size 变更立即重读）', () => {
    withHome((dir) => {
      write(dir, { patterns: ['  ', '', '   ', '\t', 'deploy --force'] })
      assert.deepEqual(readDangerPatterns(), [...DEFAULT_DANGER_PATTERNS, 'deploy --force'],
        '只留有效追加项（trim + 丢空串），内置三串恒在')
      // 配置文件里混入**非字符串**条目：逐条跳过（不抛、不影响合法条目）—— 去掉 `typeof` 守卫即红
      write(dir, { patterns: ['deploy --force', null, 123, {}, '   '] })
      assert.deepEqual(readDangerPatterns(), [...DEFAULT_DANGER_PATTERNS, 'deploy --force'],
        '非法条目逐条跳过，合法条目照常生效')
      // 不做正则：把正则元字符当**字面**（防注入）
      write(dir, { patterns: ['rm.*-rf'] })
      assert.equal(dangerousCommandMatch('echo "rm.*-rf"').rule, 'text:custom:rm.*-rf', '元字符按字面匹配')
      assert.equal(dangerousCommandMatch('rm -rf /tmp/x').rule, 'rm -rf', '内置 rm 规则照旧命中段首')
      assert.equal(dangerousCommandMatch('echo rm -rf /tmp/x').rule, 'text:rm -rf', '内置串命中（不是 `rm.*-rf` 命中的）')
      // 免重启：改文件（尺寸/时间变了）⇒ 下一次判定立即生效（追加项可动态增删）
      write(dir, { patterns: ['alpha'] })
      assert.equal(dangerousCommandMatch('echo alpha').rule, 'text:custom:alpha')
      write(dir, { patterns: ['alpha beta gamma'] })
      assert.equal(dangerousCommandMatch('echo alpha beta gamma').rule, 'text:custom:alpha beta gamma')
      assert.equal(dangerousCommandMatch('echo alpha'), null, '旧追加项已失效')
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '内置串始终生效')
      // 显式传空表给扫描函数也回到内置三串：这层判定**没有"关闭"状态**
      assert.equal(scanDangerPatterns('echo "git push"', []).rule, 'text:git push')
      assert.equal(scanDangerPatterns('echo "git push"', null).rule, 'text:git push')
      assert.equal(scanDangerPatterns('echo "git push"', 'nope').rule, 'text:git push')
    })
  })

  it('J10 承认代价（终审 Minor ③）：`unquoteToken` 去落单/重复引号带来单向宽松', () => {
    // 这些形态**不是**真命令（shell 里 `git push"` 是未闭合引号），但 v0.7.14 起的落单引号归一
    // （`unquoteToken`）会让**按段判定**命中 —— 选择保留（收窄会漏判真命令），正面断言承认代价。
    assert.equal(dangerousCommandMatch('git push"').rule, 'git push')
    assert.equal(dangerousCommandMatch('npm publish"').rule, 'npm publish')
    assert.equal(dangerousCommandMatch('git ""push""').rule, 'git push')
  })

  it('J11 非法表（含非字符串元素）⇒ 不判、不抛（终审 Minor-5：守卫必须有牙）', () => {
    // 守卫 = `scanDangerPatterns` 入口那一行 `.filter((p) => typeof p === 'string' && p.trim())`。
    // 去掉 `typeof` 那半：`[null]`/`[123]`/`[{}]` 直接 `TypeError`；去掉 `trim` 那半：
    // `['']` 会因空串 `indexOf('') === 0` 变成"命中"。两种改法都必须让本用例转红。
    for (const bad of [[null], [123], [{}], ['']]) {
      assert.equal(scanDangerPatterns('x', bad), null, `非法表 ${JSON.stringify(bad)} ⇒ null（不抛、不误命中）`)
    }
    // 非法/空白条目**逐条跳过**，合法条目照常命中（"过滤"不是"整表报废到不判"）
    assert.equal(scanDangerPatterns('echo "git push"', [null, 'git push']).rule, 'text:git push')
    // 过滤后**没有有效条目** ⇒ 回到内置三串（`[]` / 非法值一律"没有追加项"，这层没有"关闭"状态）
    for (const bad of [[null], [123], [{}], ['']]) {
      assert.equal(scanDangerPatterns('echo "git push"', bad).rule, 'text:git push',
        `非法表 ${JSON.stringify(bad)} 过滤后回退内置三串（fail-closed）`)
    }
  })

  it('J12 大小写不敏感（终审 Minor-6：与 A 仓 `i` 标志同构），归因保留配置原串', () => {
    // 两侧都折叠后比对 ⇒ 大写文本必须照旧命中（去掉 `toLowerCase`/`foldCase` 即全红）
    for (const [command, rule] of [
      ['echo "GIT PUSH"', 'text:git push'],
      ['echo "RM -RF /tmp/x"', 'text:rm -rf'],
      ['echo "Git Push"', 'text:git push'],
      ['echo "NPM PUBLISH"', 'text:npm publish'],
      ['echo "gIt PuSh"', 'text:git push'],
    ]) {
      assert.equal(dangerousCommandMatch(command).rule, rule, `${command} 必须命中（大小写不敏感）`)
    }
    // 留痕片段仍是**原文**大小写（折叠只用于比对，不改写被记录/展示的文本）
    assert.equal(dangerousCommandMatch('echo "GIT PUSH"').segment, 'GIT PUSH"')
    withHome((dir) => {
      // 配置串按小写比对；归因串保留配置里的原串大小写
      write(dir, { patterns: ['DEPLOY --FORCE'] })
      assert.deepEqual(readDangerPatterns(), [...DEFAULT_DANGER_PATTERNS, 'DEPLOY --FORCE'], '配置原串原样保留')
      assert.equal(dangerousCommandMatch('deploy --force now').rule, 'text:custom:DEPLOY --FORCE',
        '小写文本命中大写配置串，归因保留原串')
      assert.equal(dangerousCommandMatch('DEPLOY --FORCE now').rule, 'text:custom:DEPLOY --FORCE')
      assert.equal(dangerousCommandMatch('echo "PNPM PUBLISH"'), null, '未配置的串仍不命中')
    })
  })
})
// ── v0.7.15 K 组：**反退化回归表**（用户重申的不变量：归一化 + 结构化判断 + 子串匹配
// 「只会更保守严格，而不应该退化」）──────────────────────────────────────────────
//
// 本组是常驻防线，不是一次性脚本：K1 钉住**结构/计数判据**（终审实测：用子串**替换**这两条
// 会直接丢 612 条命中）；K2 钉住 `rm` 规则的**双标志**等价写法；K3 是**0.7.14 冻结树上实测命中
// 的 59 条代表输入**（命令头式 / `;` `|` `&&` 拼接 / `-c` 正文 / 包装与形状 / heredoc / 续行归一），
// 逐条要求"判定不变且**归因 id 不变**"（59/59 实测相同；对照表见交付报告）；
// K4 钉住**新增面**（三个预设串 × 命令头/段中/引号内/归一化拼接后 + 配置自定义串）必须 HIT。
describe('v0.7.15 K 组：反退化回归表（只加不减）', () => {
  const withHome = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-k-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    resetDangerPatternsCache()
    try {
      return fn(dir)
    } finally {
      resetDangerPatternsCache()
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('K1 结构/计数判据不许丢：shell-nesting / wrapper-nesting 归因 id 必须逐条不变', () => {
    // 这两条是**计数**判据（第 3 层 shell、第 9 跳包装），全文子串表达不了"嵌套几层"。
    // 断言**严格相等**（不是"非 null"）：新增扫描绝不允许抢走它们的归因，更不允许判 null。
    for (const [command, rule] of [
      [`sh -c 'sh -c "sh -c ls"'`, 'shell-nesting'],
      [`sh -c 'sh -c "sh -c \\"ls\\""'`, 'shell-nesting'],
      [`bash -c "bash -c \\"bash -c ls\\""`, 'shell-nesting'],
      [`${'sudo '.repeat(9)}ls`, 'wrapper-nesting'],
      [`${'command '.repeat(9)}ls`, 'wrapper-nesting'],
      [`${'nohup '.repeat(9)}ls`, 'wrapper-nesting'],
      [`${'nice '.repeat(9)}ls`, 'wrapper-nesting'],
      [`${'time '.repeat(9)}ls`, 'wrapper-nesting'],
      [`echo hi \\\n${'sudo '.repeat(9)}ls`, 'wrapper-nesting'],
      [`${'sudo '.repeat(9)}dd if=/dev/zero of=/dev/disk2`, 'wrapper-nesting'],
    ]) {
      const hit = dangerousCommandMatch(command)
      assert.ok(hit, `${JSON.stringify(command)} 必须 HIT（绝不允许 null）`)
      assert.equal(hit.rule, rule, `${JSON.stringify(command)} 的归因 id 必须仍是 ${rule}`)
    }
  })

  it('K2 现有词法等价写法不许丢：`rm` 规则的双标志判据（含选项顺序/路径位置/包装词）', () => {
    for (const command of [
      'rm -r -f /tmp/x', 'rm -f -r /tmp/x', 'rm -f -R /tmp/x', 'rm --recursive --force /tmp/x',
      'rm /tmp/x -rf', '/bin/rm -rf /tmp/x', './rm -rf /tmp/x', 'sudo rm -rf /tmp/x',
      'command rm -rf /tmp/x', 'nohup rm -rf /tmp/x', 'env FOO=1 rm -rf /tmp/x', 'FOO=1 rm -rf /tmp/x',
      'busybox rm -rf /tmp/x', 'stdbuf -o0 rm -rf /tmp/x', 'xargs rm -rf',
    ]) {
      assert.equal(dangerousCommandMatch(command).rule, 'rm -rf', `${command} 必须仍按 rm -rf 命中`)
    }
  })

  it('K3 0.7.14 冻结树实测命中的 59 条代表输入：判定与归因 id 逐条不变', () => {
    // 数据来源：用 0.7.14 冻结包（lib md5 501aa0e60e77c7b74dcc59e332f30e23）实测 `dangerousCommandMatch`
    // 命中的 59 条，逐条比对 0.7.15 的 `rule`（59/59 相同）。
    withHome(() => {
      for (const [command, rule] of [
      ["rm -rf /tmp/x", "rm -rf"],
      ["rm -r -f /tmp/x", "rm -rf"],
      ["rm -f -R /tmp/x", "rm -rf"],
      ["rm -rf --no-preserve-root /tmp/x", "rm -rf"],
      ["rm --recursive --force /tmp/x", "rm -rf"],
      ["rm /tmp/x -rf", "rm -rf"],
      ["/bin/rm -rf /tmp/x", "rm -rf"],
      ["./rm -rf /tmp/x", "rm -rf"],
      ["sudo rm -rf /tmp/x", "rm -rf"],
      ["sudo sudo rm -rf /tmp/x", "rm -rf"],
      ["command rm -rf /tmp/x", "rm -rf"],
      ["nohup rm -rf /tmp/x", "rm -rf"],
      ["env FOO=1 rm -rf /tmp/x", "rm -rf"],
      ["time rm -rf /tmp/x", "rm -rf"],
      ["FOO=1 rm -rf /tmp/x", "rm -rf"],
      ["RM -RF /tmp/x", "rm -rf"],
      ["npm publish", "npm publish"],
      ["npm --tag next publish", "npm publish"],
      ["npm -w pkg publish", "npm publish"],
      ["pnpm publish", "pnpm publish"],
      ["yarn publish", "yarn publish"],
      ["yarn npm publish", "yarn publish"],
      ["git push", "git push"],
      ["git push origin main", "git push"],
      ["git -C /tmp push", "git push"],
      ["git -c k=v push", "git push"],
      ["git --no-pager push", "git push"],
      ["true && rm -rf /tmp/x", "rm -rf"],
      ["echo x; npm publish", "npm publish"],
      ["ls | git push origin main", "git push"],
      ["echo hi || rm -rf /tmp/y", "rm -rf"],
      ["bash -c \"rm -rf /tmp/x\"", "rm -rf"],
      ["sh -c 'rm -rf /tmp/x'", "rm -rf"],
      ["zsh -c \"git push\"", "git push"],
      ["bash -lc \"rm -rf /tmp/x\"", "rm -rf"],
      ["bash -ec \"npm publish\"", "npm publish"],
      ["bash -c'rm -rf /x'", "rm -rf"],
      ["bash -c \"bash -c \\\"rm -rf /x\\\"\"", "rm -rf"],
      ["sudo sh -c \"rm -rf /tmp/x\"", "rm -rf"],
      ["sh -c 'sh -c \"sh -c ls\"'", "shell-nesting"],
      ["sudo sudo sudo sudo sudo sudo sudo sudo sudo ls", "wrapper-nesting"],
      ["command command command command command command command command command ls", "wrapper-nesting"],
      ["nohup nohup nohup nohup nohup nohup nohup nohup nohup ls", "wrapper-nesting"],
      ["echo hi \\\nsudo sudo sudo sudo sudo sudo sudo sudo sudo ls", "wrapper-nesting"],
      ["git \\\npush origin main", "git push"],
      ["rm \\\n-rf /tmp/x", "rm -rf"],
      ["npm \\\npublish", "npm publish"],
      ["rm  -rf /tmp/x", "rm -rf"],
      ["git\tpush origin main", "git push"],
      ["sh -c \"true\nrm -rf /tmp/x\"", "rm -rf"],
      ["bash -c \"echo hi\ngit push origin main\"", "git push"],
      ["pwsh -Command \"x\nnpm publish\"", "npm publish"],
      ["cat <<'EOF'\nrm -rf /tmp/x\nEOF", "rm -rf"],
      ["sh <<'SH'\ngit push origin main\nSH", "git push"],
      ["git commit -q -F - <<'EOF'\nrm -rf /tmp/x\nEOF", "rm -rf"],
      ["find . | xargs rm -rf", "rm -rf"],
      ["busybox rm -rf /tmp/x", "rm -rf"],
      ["xargs rm -rf", "rm -rf"],
      ["stdbuf -o0 rm -rf /tmp/x", "rm -rf"],
      ]) {
        const hit = dangerousCommandMatch(command)
        assert.ok(hit, `${JSON.stringify(command)} 在 0.7.14 命中过 ⇒ 0.7.15 绝不允许变 MISS`)
        assert.equal(hit.rule, rule, `${JSON.stringify(command)} 的归因 id 必须仍是 ${rule}（0.7.14 实测）`)
      }
    })
  })

  it('K3b 帧路径（`dangerousExecuteMatch`）的四种正文来源：0.7.14 实测命中过 ⇒ 判定与归因不变', () => {
    // 与 K3 同口径，只是走**帧**入口（命令文本之外的来源字段也是正文）。数据来源：0.7.14 冻结包
    // 实测 `dangerousExecuteMatch` 命中的 7 种帧形态，逐条比对 0.7.15（7/7 相同）。
    withHome(() => {
      for (const [frame, rule] of [
        [{ kind: 'execute', name: 'bash', rawInput: { command: 'rm -rf /tmp/x' }, title: 'rm -rf /tmp/x' }, 'rm -rf'],
        [{ kind: 'execute', name: 'bash', arguments: { command: 'git push origin main' } }, 'git push'],
        [{ kind: 'execute', name: 'bash', arguments: JSON.stringify({ command: 'npm publish' }) }, 'npm publish'],
        [{ kind: 'execute', name: 'shell', content: [{ content: { text: 'rm -rf /tmp/x' }, type: 'content' }] }, 'rm -rf'],
        [{ kind: 'other', name: 'bash', title: 'bash', rawInput: { command: 'rm -rf /tmp/x' } }, 'rm -rf'],
        [{ kind: 'execute', name: 'bash', rawInput: { command: 'sudo rm -rf /tmp/x' } }, 'rm -rf'],
        [{ kind: 'execute', name: 'bash', rawInput: { command: 'git \\\npush origin main' } }, 'git push'],
      ]) {
        const hit = dangerousExecuteMatch(frame)
        assert.ok(hit, `${JSON.stringify(frame).slice(0, 60)}… 在 0.7.14 命中过 ⇒ 绝不允许变 MISS`)
        assert.equal(hit.rule, rule, `归因 id 必须仍是 ${rule}`)
      }
    })
  })

  // 独立用例（终审 Minor-6）：这是**新增面**断言，原先塞在 K3b 体内 —— 一旦"删掉末遍全文扫描"，
  // K3b 会因为 `null.rule` 抛 TypeError 整体转红，于是「删掉新层后 K1/K2/K3b 全绿」在**测试粒度**上
  // 就不成立（根因是夹具混装，不是判定退化）。拆开后：K3b = 0.7.14 旧帧回归（删新层必绿），
  // 本用例 = 新增面（删新层必红）。
  it('K3c 新增面走帧入口：命令字段里只是"提到" ⇒ 必须命中（`text:*`）；删掉末遍全文扫描即红', () => {
    withHome(() => {
      assert.equal(
        dangerousExecuteMatch({ kind: 'execute', name: 'bash', rawInput: { command: 'echo "npm publish"' } }).rule,
        'text:npm publish',
      )
      assert.equal(
        dangerousExecuteMatch({ kind: 'execute', name: 'bash', rawInput: { command: 'echo "rm -rf /tmp/x"' } }).rule,
        'text:rm -rf',
      )
    })
  })

  it('K4 新增面必须 HIT：预设三串 × 五种位置（命令头/段中/引号内/归一化拼接后/配置自定义串）', () => {
    withHome((dir) => {
      const positions = [
        // 命令头：既有按段判定
        ['rm -rf /tmp/x', 'rm -rf'], ['git push origin main', 'git push'], ['npm publish', 'npm publish'],
        // 段中（命令头不是危险程序）⇒ 只有全文层能看见
        ['echo rm -rf /tmp/x', 'text:rm -rf'], ['printf ok git push origin main', 'text:git push'],
        ['mkdir -p out && echo npm publish', 'text:npm publish'],
        // 引号内
        ['echo "rm -rf /tmp/x"', 'text:rm -rf'], ["echo 'git push origin main'", 'text:git push'],
        ['echo "npm publish"', 'text:npm publish'],
        // 归一化拼接后（续行 / 多空白 / TAB / 字面 \n）
        ['rm \\\n-rf /tmp/x', 'rm -rf'], ['git \\\npush origin main', 'git push'], ['npm \\\npublish', 'npm publish'],
        ['rm  -rf /tmp/x', 'rm -rf'], [`git${'\t'}push origin main`, 'git push'],
        ['sh -c "true\\nrm -rf /tmp/x"', 'rm -rf'],
      ]
      for (const [command, rule] of positions) {
        assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 必须命中（${rule}）`)
      }
      // 配置自定义串：归因 `text:custom:<原串>`
      mkdirSync(join(dir, 'data'), { recursive: true })
      writeFileSync(join(dir, 'data', 'dsh-danger-patterns.json'),
        JSON.stringify({ patterns: ['rm -rf', 'git push', 'npm publish', 'pnpm publish', 'deploy --force'] }))
      for (const [command, rule] of [
        ['echo "pnpm publish"', 'text:custom:pnpm publish'],
        ['echo deploy --force now', 'text:custom:deploy --force'],
        ['git commit -m "x" && echo "git push"', 'text:git push'],
      ]) {
        assert.equal(dangerousCommandMatch(command).rule, rule, `${JSON.stringify(command)} 必须命中（${rule}）`)
      }
    })
  })
})

// ── v0.7.15 M 组：配置读取的抗挂死（fd 类型判据）+ 规模上限 + 文本上限 ──
//
// B1（阻断）：`readDangerPatterns()` 在"不是普通文件"的目标上会**同步无限阻塞**（FIFO、
// `/dev/zero` 这类"能 open 但永不 EOF"的路径）⇒ 危险门（`lib/index.js` 里同步调用、在一切放行
// 判定之前）永不返回、冻结宿主事件循环。终审 m6 追加：**"先 stat 再读"仍留 TOCTOU**（把 stat
// 谎报成"普通文件 100B"、实为 FIFO ⇒ 照样冻死）⇒ 现行实现**只看 fd**（`open(O_RDONLY|O_NONBLOCK)`
// + `fstatSync`，只认 `isFile()`）+ 有界读。M1/M2/M13/M14 把探测**放进子进程并带超时**：一旦回归，
// 用例**失败**而不是把整个测试套件挂死。
describe('v0.7.15 M 组：配置读取抗挂死 + 规模上限 + 文本上限', () => {
  const withHome = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-m-'))
    const cfg = join(dir, 'data', 'dsh-danger-patterns.json')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    resetDangerPatternsCache()
    const warnings = []
    const realWarn = console.warn
    console.warn = (msg) => warnings.push(String(msg))
    try {
      return fn(dir, cfg, warnings)
    } finally {
      console.warn = realWarn
      resetDangerPatternsCache()
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // 子进程探测：同步阻塞（回归）⇒ timeout 杀进程 ⇒ 用例红（不会挂住整套）。
  // 常态安装 **IO 计数器**（终审 Minor-2：原先的 `readFileSync` 零调用断言对任何实现恒真、没有区分力；
  // 有牙的是「非普通文件档必须 `readSync` 零调用 + `openSync` 恰一次 + fd 被关闭」）。
  // `prelude` 再注入额外桩（如 M13 把 `statSync` 谎报成普通文件）。
  const probe = (home, timeout = 5000, prelude = '') => {
    const lib = new URL('../lib/dangerous-commands.js', import.meta.url).href
    const script = `
import fs from 'node:fs'
const cfgPath = (process.env.DSH_HOME || '') + '/data/dsh-danger-patterns.json'
const realOpen = fs.openSync
const realReadSync = fs.readSync
const realClose = fs.closeSync
globalThis.__io = { openCfg: 0, readCfg: 0, closeCfg: 0, cfgFds: [] }
// 只统计**配置 fd** 上的读写（Node 自己的模块加载内部也会走 fs.readSync，不区分就会把噪声算进来）
fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); if (String(p) === cfgPath) { globalThis.__io.openCfg += 1; globalThis.__io.cfgFds.push(fd) } return fd }
fs.readSync = (fd, ...rest) => { if (globalThis.__io.cfgFds.includes(fd)) globalThis.__io.readCfg += 1; return realReadSync(fd, ...rest) }
fs.closeSync = (fd) => { if (globalThis.__io.cfgFds.includes(fd)) globalThis.__io.closeCfg += 1; return realClose(fd) }
${prelude}
const warns = []
console.warn = (m) => warns.push(String(m))
const t0 = Date.now()
const M = await import(${JSON.stringify(lib)})
const r = M.dangerousExecuteMatch({ _meta: { qoder: { toolName: 'Bash' } }, kind: 'execute', rawInput: { command: 'echo "npm publish" && ls -la /tmp' }, title: 'bash', toolCallId: 'p1' })
const t1 = Date.now()
const list = M.readDangerPatterns()
const t2 = Date.now()
console.log('PROBE ' + JSON.stringify({ rule: r ? r.rule : null, ms1: t1 - t0, len: list.length, ms2: t2 - t1, warns, io: globalThis.__io }))
`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out.split('\n').find((l) => l.startsWith('PROBE ')).slice(6))
  }

  it('M1 配置是 FIFO ⇒ 不读、不阻塞：门照常拦、readDangerPatterns 立刻回内置三串（终审 B1 阻断）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-m-fifo-'))
    try {
      mkdirSync(join(dir, 'data'), { recursive: true })
      execFileSync('mkfifo', [join(dir, 'data', 'dsh-danger-patterns.json')])
      const r = probe(dir)
      assert.equal(r.rule, 'text:npm publish', '门仍然拦（既不是 null，也不是挂住）')
      assert.equal(r.len, DEFAULT_DANGER_PATTERNS.length, '按"没有追加项"降级 ⇒ 只剩内置三串')
      assert.ok(r.ms1 < 1000 && r.ms2 < 1000, `两次调用都必须 ≤1s（实测 ${r.ms1}ms / ${r.ms2}ms）`)
      assert.ok(r.warns.some((w) => w.includes('不是普通文件')), `必须告警一次（实测 ${JSON.stringify(r.warns)}）`)
      assert.equal(r.io.readCfg, 0, '**配置 fd 一个字节都没读**（终审 Minor-2：这条才有区分力）')
      assert.equal(r.io.openCfg, 1, 'openSync 恰一次（类型判据取自该 fd）')
      assert.equal(r.io.closeCfg, 1, '配置 fd 必须被关闭（恰一次）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('M2 配置软链到 /dev/zero（字符设备）⇒ 同上：不读、不阻塞、照常拦', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-m-zero-'))
    try {
      mkdirSync(join(dir, 'data'), { recursive: true })
      symlinkSync('/dev/zero', join(dir, 'data', 'dsh-danger-patterns.json'))
      const r = probe(dir)
      assert.equal(r.rule, 'text:npm publish', '门仍然拦')
      assert.equal(r.len, DEFAULT_DANGER_PATTERNS.length, '降级为"没有追加项"')
      assert.ok(r.ms1 < 1000 && r.ms2 < 1000, `两次调用都必须 ≤1s（实测 ${r.ms1}ms / ${r.ms2}ms）`)
      assert.ok(r.warns.some((w) => w.includes('不是普通文件')), '必须告警一次')
      assert.equal(r.io.readCfg, 0, '**配置 fd 一个字节都没读**')
      assert.equal(r.io.openCfg, 1, 'openSync 恰一次')
      assert.equal(r.io.closeCfg, 1, '配置 fd 必须被关闭（恰一次）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it(`M3 条数上限：5,000 条 ⇒ 只取前 ${MAX_DANGER_PATTERNS} 条 + 告警（不判错、不弃整表）`, () => {
    withHome((dir, cfg, warnings) => {
      writeFileSync(cfg, JSON.stringify({ patterns: Array.from({ length: 5000 }, (_, i) => `pat${i}`) }))
      const list = readDangerPatterns()
      assert.equal(list.length, DEFAULT_DANGER_PATTERNS.length + MAX_DANGER_PATTERNS, `上限 ${MAX_DANGER_PATTERNS} 生效`)
      assert.equal(list[3], 'pat0', '从第 1 条开始取')
      assert.equal(list[3 + MAX_DANGER_PATTERNS - 1], `pat${MAX_DANGER_PATTERNS - 1}`, '取到上限那一条')
      assert.ok(!list.includes(`pat${MAX_DANGER_PATTERNS}`), '超出的条目被跳过（而不是整表丢弃）')
      assert.ok(warnings.some((w) => w.includes('条数过多')), '必须告警一次')
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '内置三串照常生效')
    })
  })

  it(`M3b 条数上限的**恰好等值**边界：${MAX_DANGER_PATTERNS} 条不告警、${MAX_DANGER_PATTERNS + 1} 条才截断（跨仓统一值 1024）`, () => {
    withHome((dir, cfg, warnings) => {
      writeFileSync(cfg, JSON.stringify({ patterns: Array.from({ length: MAX_DANGER_PATTERNS }, (_, i) => `pat${i}`) }))
      const exact = readDangerPatterns()
      assert.equal(exact.length, DEFAULT_DANGER_PATTERNS.length + MAX_DANGER_PATTERNS, '恰好 = 上限 ⇒ 全部保留')
      assert.equal(exact[3 + MAX_DANGER_PATTERNS - 1], `pat${MAX_DANGER_PATTERNS - 1}`, '末条在表里')
      assert.deepEqual(warnings, [], '恰好 = 上限 ⇒ 不告警（`>` 而非 `>=`）')
      writeFileSync(cfg, JSON.stringify({ patterns: Array.from({ length: MAX_DANGER_PATTERNS + 1 }, (_, i) => `pat${i}`) }))
      resetDangerPatternsCache()
      const over = readDangerPatterns()
      assert.equal(over.length, DEFAULT_DANGER_PATTERNS.length + MAX_DANGER_PATTERNS, '多一条 ⇒ 截断到上限')
      assert.ok(!over.includes(`pat${MAX_DANGER_PATTERNS}`), '第 1025 条被跳过')
      assert.equal(warnings.filter((w) => w.includes('条数过多')).length, 1, '必须告警一次')
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '内置三串照常生效')
    })
  })

  it('M4 单串长度上限：超长条目跳过 + 告警，其余条目照常生效', () => {
    withHome((dir, cfg, warnings) => {
      writeFileSync(cfg, JSON.stringify({ patterns: ['deploy --force', 'z'.repeat(MAX_DANGER_PATTERN_CHARS + 1), 'alpha'] }))
      const list = readDangerPatterns()
      assert.deepEqual(list, [...DEFAULT_DANGER_PATTERNS, 'deploy --force', 'alpha'], '只跳过超长那一条')
      assert.ok(warnings.some((w) => w.includes('超过')), '必须告警一次')
      assert.equal(dangerousCommandMatch('echo deploy --force now').rule, 'text:custom:deploy --force')
    })
  })

  it('M5 20 万条 / 4.4MB 配置 ⇒ 尺寸上限拦下：内置三串 + "过大"告警，绝不 RangeError、绝不整表丢失', () => {
    withHome((dir, cfg, warnings) => {
      const big = JSON.stringify({ patterns: Array.from({ length: 200000 }, (_, i) => `pat-${i}-${'x'.repeat(10)}`) })
      assert.ok(Buffer.byteLength(big) > MAX_DANGER_CONFIG_BYTES, `语料必须超过 ${MAX_DANGER_CONFIG_BYTES} 字节（实测 ${Buffer.byteLength(big)}）`)
      writeFileSync(cfg, big)
      const t0 = Date.now()
      const list = readDangerPatterns()
      const ms = Date.now() - t0
      assert.deepEqual(list, DEFAULT_DANGER_PATTERNS, '按"没有追加项"降级（不读超大文件）')
      assert.ok(warnings.some((w) => w.includes('过大')), '必须告警一次')
      assert.ok(!warnings.some((w) => w.includes('Maximum call stack')), '**不得**出现 spread 的栈溢出（m7）')
      assert.ok(ms < 2000, `读取必须有时限（实测 ${ms}ms）`)
      assert.equal(dangerousCommandMatch('echo "npm publish"').rule, 'text:npm publish', '内置三串照常生效')
    })
  })

  it('M6 全文层文本上限 256KB：超长 ⇒ 判 `command-too-long`（照拦，不是"太长就不扫、就放行"）', () => {
    const over = 'x'.repeat(MAX_DANGER_TEXT_CHARS + 1)
    assert.equal(scanDangerPatterns(over).rule, 'command-too-long')
    assert.equal(scanDangerPatterns(over, []).rule, 'command-too-long', '显式空表也照拦')
    assert.equal(scanDangerPatterns('echo rm -rf /tmp/x ' + over).rule, 'command-too-long', '超长文本里的危险词也照样拦')
    assert.equal(scanDangerPatterns('x'.repeat(MAX_DANGER_TEXT_CHARS - 1)), null, '刚好不超 ⇒ 正常扫描（无危险词 ⇒ null）')
    assert.equal(dangerousCommandMatch('ls ' + over).rule, 'command-too-long', '端到端：超长命令整体照拦')
  })

  it('M7 `foldCase` 的"保持长度"不变式（终审 m9：兜底路径此前零覆盖）', () => {
    for (const x of ['İ'.repeat(5), 'aİb', 'ß', 'ẞ', 'e\u0301', 'İstanbul', 'ABC', 'ẞßİ']) {
      assert.equal(foldCase(x).length, x.length, `${JSON.stringify(x)} 折叠后长度必须不变（保证逐索引对齐）`)
    }
    // 兜底路径存在的理由：原生折叠会把 `İ` 变成两个码元
    assert.equal('İ'.toLowerCase().length, 2, '原生 toLowerCase 确实会变长')
    assert.equal(foldCase('İ'), 'İ', '变长时保留原字符 ⇒ 长度不变')
    // 长度不变的折叠走快路径（含 `ẞ → ß`：二者**互命**，不是"永不互命"）
    assert.equal(foldCase('ABC'), 'abc')
    assert.equal(foldCase('ẞ'), 'ß')
    assert.equal('ẞ'.toLowerCase(), 'ß', '`ẞ`(U+1E9E) 折叠为 `ß`(U+00DF)，长度不变')
  })

  it('M8 `İ` 文本：判定不受影响、`segment` 仍按同一索引切原文（终审 m9）', () => {
    const t1 = `echo "${'İ'.repeat(3)} GIT PUSH"`
    const h1 = dangerousCommandMatch(t1)
    assert.equal(h1.rule, 'text:git push', '大小写不敏感 + 保长折叠 ⇒ 判定不受影响')
    assert.equal(h1.segment, t1.slice(t1.indexOf('GIT PUSH')), '片段必须从原文的同一索引切出')
    const t2 = `echo ${'İ'.repeat(4)} rm -rf /tmp/x`
    const h2 = dangerousCommandMatch(t2)
    assert.equal(h2.rule, 'text:rm -rf')
    assert.equal(h2.segment, t2.slice(t2.indexOf('rm -rf')), '危险字样落在 `İ` 之后也要逐字对齐')
  })

  it('M9 缺失配置保持静默（跨仓差异：A 每次 warn，B 只在异常时 warn —— 有意保留）', () => {
    withHome((dir, cfg, warnings) => {
      assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
      assert.deepEqual(warnings, [], '缺失是正常状态，不打日志')
      writeFileSync(cfg, '{ broken')
      resetDangerPatternsCache()
      assert.deepEqual(readDangerPatterns(), DEFAULT_DANGER_PATTERNS)
      assert.equal(warnings.filter((w) => w.includes('读取失败')).length, 1, '坏 JSON 仍告警一次（只增不减语义不回归）')
    })
  })

  it('M10 文本上限的**恰好等值**边界：恰 256KB 仍正常扫描（钉住 `>` 而非 `>=`，终审 m1）', () => {
    const tail = ' rm -rf /tmp/x'
    const exact = 'a'.repeat(MAX_DANGER_TEXT_CHARS - tail.length) + tail
    assert.equal(exact.length, MAX_DANGER_TEXT_CHARS, '夹具必须**恰好**等于上限')
    assert.equal(scanDangerPatterns(exact).rule, 'text:rm -rf', '恰好 = 上限 ⇒ 走正常扫描（不是 command-too-long）')
    assert.equal(scanDangerPatterns(exact + 'a').rule, 'command-too-long', '多一个字符 ⇒ 才转 command-too-long')
    assert.equal(dangerousCommandMatch(exact).rule, 'text:rm -rf', '端到端同向')
  })

  it('M11 ≤1MB 但 15.6 万条 ⇒ **条数上限**兜住栈溢出（终审 m2：逐条 push 只是纵深防御）', () => {
    withHome((dir, cfg, warnings) => {
      // 条数取 156,000：① 远高于上一代 `push(...list)` 的栈溢出阈值（实测 120,000 不抛 / 130,000 抛）；
      // ② 仍是**≤1MB 内的唯一条目**上限附近（唯一条目若要 17 万条必然 >1MB ⇒ 那会走尺寸上限、测不到条数上限）。
      const patterns = []
      for (let i = 0; patterns.length < 156000; i += 1) patterns.push(i.toString(36))
      const big = JSON.stringify({ patterns })
      assert.ok(Buffer.byteLength(big) <= MAX_DANGER_CONFIG_BYTES, `夹具必须 ≤ ${MAX_DANGER_CONFIG_BYTES} 字节（实测 ${Buffer.byteLength(big)}）`)
      assert.ok(patterns.length > 130000, '夹具条数必须超过上一代 spread 的栈溢出阈值')
      writeFileSync(cfg, big)
      const t0 = Date.now()
      const list = readDangerPatterns()
      const ms = Date.now() - t0
      assert.equal(list.length, DEFAULT_DANGER_PATTERNS.length + MAX_DANGER_PATTERNS, `只取前 ${MAX_DANGER_PATTERNS} 条`)
      assert.equal(list[3], '0', '从第 1 条开始取')
      assert.equal(list[3 + MAX_DANGER_PATTERNS - 1], 'sf', '取到上限那一条（1023 的 base36）')
      assert.ok(warnings.some((w) => w.includes('条数过多')), '必须告警一次')
      assert.ok(!warnings.some((w) => w.includes('Maximum call stack')), '**不得**出现 spread 的栈溢出（上一代在同一夹具上抛并被自身 catch 吞掉 ⇒ 整份配置丢弃）')
      assert.ok(ms < 2000, `读取必须有时限（实测 ${ms}ms）`)
      assert.equal(dangerousCommandMatch('echo "git push"').rule, 'text:git push', '内置三串照常生效')
    })
  })

  it('M12 配置读取不泄漏 fd（fd 类型判据 + finally closeSync；终审 m6）', () => {
    withHome((dir, cfg) => {
      writeFileSync(cfg, JSON.stringify({ patterns: ['deploy --force'] }))
      const countFds = () => fs.readdirSync('/dev/fd').length
      resetDangerPatternsCache()
      assert.equal(readDangerPatterns().length, DEFAULT_DANGER_PATTERNS.length + 1, '预热：自定义串生效')
      const before = countFds()
      for (let i = 0; i < 50; i += 1) {
        resetDangerPatternsCache() // 强制每次真正 open（否则命中缓存 ⇒ 测不出泄漏）
        assert.equal(readDangerPatterns().length, DEFAULT_DANGER_PATTERNS.length + 1)
      }
      const after = countFds()
      assert.ok(after <= before, `50 次真实读取后 fd 数不得增长（before ${before}, after ${after}）`)
    })
  })

  // **承重说明（终审 Minor-7）**：本条是**唯一**能抓住「类型判据改回路径 stat（`fstatSync` → `statSync`）」
  // 这个变异的用例 —— 复核方另做的 MD1a 变异体上只有 M13 红，M1/M2/M14 仍绿（它们的档位用真实 stat
  // 也判得出"不是普通文件"，只有"stat 被谎报"这一档必须靠 fd 才挡得住）。改动本条断言前请先跑 MD1a。
  it('M13 模拟 TOCTOU（statSync 谎报"普通文件 100B"、路径实为 FIFO）⇒ 不超时、照常拦（终审 m6）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psub-m-toctou-'))
    try {
      mkdirSync(join(dir, 'data'), { recursive: true })
      execFileSync('mkfifo', [join(dir, 'data', 'dsh-danger-patterns.json')])
      // prelude：把 `statSync` 对配置路径谎报成"普通文件 100B"。**这才是这条用例的牙**：
      // 真实实现若把类型判据取自路径 stat（或先 stat 再 readFileSync），读 FIFO 会同步无限阻塞
      // ⇒ 子进程超时 ⇒ 用例红（上一版冻结 lib 在同一夹具上实测 8058ms 被 SIGTERM）。
      const r = probe(dir, 5000, `
const cfg = process.env.DSH_HOME + '/data/dsh-danger-patterns.json'
const realStat = fs.statSync
fs.statSync = (p, ...rest) => (String(p) === cfg ? { mtimeMs: 1, size: 100, isFile: () => true, isDirectory: () => false } : realStat(p, ...rest))
`)
      assert.equal(r.rule, 'text:npm publish', '门仍然拦（既不是 null，也不是挂住）')
      assert.equal(r.len, DEFAULT_DANGER_PATTERNS.length, '按"没有追加项"降级')
      assert.equal(r.io.readCfg, 0, '**配置 fd 一个字节都没读**（Minor-2：对配置 fd 的 readSync 计数才有区分力）')
      assert.equal(r.io.openCfg, 1, 'openSync 恰一次（类型判据取自该 fd）')
      assert.equal(r.io.closeCfg, 1, '配置 fd 必须被关闭（恰一次）')
      assert.ok(r.ms1 < 1000 && r.ms2 < 1000, `两次调用都必须 ≤1s（实测 ${r.ms1}ms / ${r.ms2}ms）`)
      assert.ok(r.warns.some((w) => w.includes('不是普通文件')), `必须告警一次（实测 ${JSON.stringify(r.warns)}）`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('M14 其余五档（/dev/urandom / 目录 / 悬空软链 / 自指软链 / 缺失）⇒ 全部 ≤1s 且门恒拦', () => {
    const cases = [
      ['urandom', (cfg) => symlinkSync('/dev/urandom', cfg), '不是普通文件'],
      ['目录', (cfg) => mkdirSync(cfg), '不是普通文件'],
      ['悬空软链', (cfg) => symlinkSync(join(tmpdir(), 'psub-not-exist-xyz'), cfg), null],
      ['自指软链', (cfg) => symlinkSync('dsh-danger-patterns.json', cfg), null],
      ['缺失', () => {}, null],
    ]
    for (const [name, build, expectWarn] of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'psub-m-path-'))
      try {
        mkdirSync(join(dir, 'data'), { recursive: true })
        build(join(dir, 'data', 'dsh-danger-patterns.json'))
        const r = probe(dir)
        assert.equal(r.rule, 'text:npm publish', `${name}：门仍然拦`)
        assert.equal(r.len, DEFAULT_DANGER_PATTERNS.length, `${name}：按"没有追加项"降级`)
        assert.ok(r.ms1 < 1000 && r.ms2 < 1000, `${name}：两次调用都必须 ≤1s（实测 ${r.ms1}ms / ${r.ms2}ms）`)
        assert.equal(r.io.readCfg, 0, `${name}：**配置 fd 一个字节都没读**（Minor-2）`)
        if (expectWarn) assert.ok(r.warns.some((w) => w.includes(expectWarn)), `${name}：必须告警一次`)
        else assert.deepEqual(r.warns, [], `${name}：静默（缺失/自指软链视同"没有这个文件"）`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('M15 正常普通文件：自定义串免重启生效（八档里的"正常"档，与上面各档同向收口）', () => {
    withHome((dir, cfg) => {
      writeFileSync(cfg, JSON.stringify({ patterns: ['deploy --force'] }))
      assert.deepEqual(readDangerPatterns(), [...DEFAULT_DANGER_PATTERNS, 'deploy --force'])
      assert.equal(dangerousCommandMatch('echo deploy --force now').rule, 'text:custom:deploy --force')
      assert.equal(dangerousCommandMatch('echo "rm -rf /tmp/x"').rule, 'text:rm -rf', '内置三串不因自定义配置而失效')
    })
  })

  it('M16 空/模板配置**静默**，只有真配置错误才告警（终审 Minor-1）：七种形态的告警条数与表长', () => {
    withHome((dir, cfg, warnings) => {
      const cases = [
        ['0 字节', '', 0],
        ['纯空白', '  \n\t\n', 0],
        ['只有 _readme 的模板', '{"_readme":"x"}', 0],
        ['空对象 {}', '{}', 0],
        ['patterns 为 []', '{"patterns":[]}', 0],
        ['patterns 含 null', '{"patterns":[null]}', 0],
        ['patterns 存在但不是数组', '{"patterns":"x"}', 1],
      ]
      for (const [name, body, expectWarn] of cases) {
        writeFileSync(cfg, body)
        resetDangerPatternsCache()
        warnings.length = 0
        const list = readDangerPatterns()
        assert.equal(list.length, DEFAULT_DANGER_PATTERNS.length, `${name}：表长应为内置 ${DEFAULT_DANGER_PATTERNS.length} 项`)
        assert.equal(warnings.length, expectWarn, `${name}：告警条数应为 ${expectWarn}（实测 ${JSON.stringify(warnings)}）`)
        assert.equal(dangerousCommandMatch('echo "rm -rf /tmp/x"').rule, 'text:rm -rf', `${name}：内置三串照常生效`)
      }
      // 模板补上真内容 ⇒ 免重启生效、仍不告警
      writeFileSync(cfg, JSON.stringify({ _readme: 'x', patterns: ['deploy --force'] }))
      resetDangerPatternsCache()
      warnings.length = 0
      assert.deepEqual(readDangerPatterns(), [...DEFAULT_DANGER_PATTERNS, 'deploy --force'], '模板补内容后正常生效')
      assert.deepEqual(warnings, [], '补内容不该产生告警')
    })
  })
})
