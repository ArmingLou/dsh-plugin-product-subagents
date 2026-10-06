// v0.7.9 危险命令排除门的纯函数面测试。
//
// 三条模式来自用户自己在 `~/.qoder/settings.json` 的 `permissions.ask`：
// `Bash(rm -rf:*)`、`npm publish`、`git push`（`deny: Bash(sudo:*)` 由 qoder 自己
// 硬拒，不归我们管）。本文件只测判据本身；"门必须排在工具名预检之前、命中不短路"
// 的行为面在 test/permission-handler-wiring.test.js 的 v0.7.9 危险命令门一节。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dangerousCommandMatch, dangerousExecuteMatch, splitSubCommands, valueOptionsOf } from '../lib/dangerous-commands.js'
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

describe('v0.7.9 危险命令门：误伤守卫', () => {
  it('字符串包含不等于危险命令：只在每段子命令开头判', () => {
    for (const command of [
      'echo "git push"',
      'echo npm publish',
      'echo "rm -rf is dangerous"',
      'grep "git push" CHANGELOG.md',
      'grep -rn "npm publish" docs/',
      'cat notes.txt # rm -rf /tmp',
      'printf "rm -rf\\n"',
      'git log --grep push',
      'git log -p --follow src/push.ts',
      'npm run publish-dry',
      'npm --version && echo ok',
      'curl -s "https://x.example/a?b=1&rm -rf"',
      'awk "{print $1}" rm-f.log',
      'sed -e "s/git push/x/" notes.md',
      'ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin',
      'python3 - <<\'PY\'\nimport json\nprint(\'ok\')\nPY',
      'git status && npm test',
      'rm -r ./only-recursive',
      'rm -f ./only-force',
      'rm ./plain',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 不得判危险`)
    }
  })

  it('注释行/空段不得被当成子命令开头', () => {
    assert.equal(dangerousExecuteMatch(exec('echo a\n# rm -rf /tmp\necho b')), null)
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
    // 第 3 层起不展开，按「可疑」保守转交互（不是放行）
    const deep = dangerousExecuteMatch(exec('bash -c "bash -c \\"bash -c \\\\\\"rm -rf /x\\\\\\"\\""'))
    assert.ok(deep, '超过 2 层必须按 shell-nesting 拦下，不许放行')
    assert.equal(deep.rule, 'shell-nesting')
    // `-C` 是 noclobber，不是 `-c`：shell 选项字母大小写敏感，不得误判
    assert.equal(dangerousExecuteMatch(exec('bash -C rm -rf /tmp/x')), null, '`-C` 不是 `-c`，不许当命令正文')
  })

  it('误伤守卫（追加名单后仍然全绿）', () => {
    for (const command of [
      'echo "git push"', 'echo npm publish', 'echo "pnpm publish"',
      'grep "git push" file', 'grep -rn "npm publish" docs/',
      'git commit -m "git push"', 'git log --grep push', 'git log -p --follow src/push.ts',
      'npm run publish', 'pnpm run publish', 'yarn run publish', 'npm run publish-dry',
      'rm -r ./only-recursive', 'rm -f ./only-force',
      'ls -la', 'echo hi', 'cat notes.txt # rm -rf /tmp',
      'curl -s "https://x.example/a?b=1&rm -rf"',
      'sed -e "s/git push/x/" notes.md',
      'bash --norc', 'bash -C rm -rf',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 不得判危险`)
    }
    // 正文（非命令字段）里提到这些词：kind=edit + 正文不含命令字段 ⇒ 门不命中
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

  it('仍然不覆盖（诚实声明，不静默漏掉）：静态不可判定与名单之外', () => {
    for (const command of [
      // 名单之外 / 用户裁决范围之外
      'lerna publish',
      'git clean -fdx',
      'git reset --hard HEAD~1',
      // 静态不可判定：需要 shell 解析器 + 变量求值 + 读脚本文件
      'python -c "os.system(\'rm -rf /\')"',
      'eval "rm -rf /tmp/x"',
      'bash deploy.sh',
      'make deploy',
      // "把正文当 stdin 喂给 shell"的两种写法（`|` 会把两段切开，第二段只剩 bash）
      "printf 'rm -rf /x' | bash",
      "bash <<< 'rm -rf /x'",
      // `-exec` 的取值是"命令 + 参数"，本层只做词法判定，不解析 -exec 语法
      'find /tmp -exec rm -rf {} +',
    ]) {
      assert.equal(dangerousExecuteMatch(exec(command)), null, `${command} 本版不覆盖（见模块头注释的"不覆盖"清单）`)
    }
  })

  // 第四轮终审实测（两侧跑同一份 45 条语料）：**规则名单一致，覆盖边界不一致** ——
  // 宿主另有 5 处覆盖，本仓实测 null。这里把每一条**钉在测试里**：文档的"不覆盖"清单
  // 与实测逐条对应（Minor-7），任何一侧悄悄漂移都会在这里显形。
  // 注意：断言的是**本仓现状**（不是"这样最好"）——判 null 只表示本门不额外弹窗。
  it('跨仓边界差异逐条钉住（宿主更严、本仓 null）：coreutils / -exec / shell-stdin / -C / argsText', () => {
    const hostStricter = [
      // 宿主把 coreutils 当多调用二进制（同 busybox/toybox）⇒ 'rm -rf'
      ['coreutils rm -rf /x', 'rm -rf'],
      // 宿主解析 find -exec/-execdir/-ok/-okdir 后的子命令 ⇒ 'rm -rf'
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['find /tmp -execdir rm -rf {} +', 'rm -rf'],
      // 宿主对"裸解释器读 stdin/脚本"按 SHELL_STDIN_RULE 保守转交互 ⇒ 'shell-stdin'
      ["printf 'rm -rf /x' | bash", 'shell-stdin'],
      ["bash <<< 'rm -rf /x'", 'shell-stdin'],
      ['bash deploy.sh', 'shell-stdin'],
      // 宿主判 'rm -rf'；本仓 shellBody 对 -c 大小写敏感（-C 是 noclobber）⇒ null
      // 实测本机 /bin/rm 是二进制、`bash -C rm` 是"执行名为 rm 的脚本"（无同名脚本 exit 126）
      ['bash -C rm -rf /x', 'rm -rf'],
    ]
    for (const [command, hostRule] of hostStricter) {
      assert.equal(dangerousExecuteMatch(exec(command)), null,
        `${command} 本仓不覆盖（宿主判 ${hostRule}）—— 分歧登记在 lib/dangerous-commands.js 文件头`)
    }
    // `bash -c`（小写）必须仍然命中：上面放开 `-C` 不等于把 shell 正文这条路关了
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

  it('不过度命中：payload 不是危险命令时照旧 null', () => {
    assert.equal(dangerousCommandMatch('env -S "ls /x"'), null, '取值拼回不等于一律判危险')
    assert.equal(dangerousCommandMatch('env -S "echo rm -rf /tmp/x"'), null, '命令头是 echo ⇒ 正文里的字样不算命令（不误伤）')
    assert.equal(dangerousCommandMatch('env -S'), null, '空取值 ⇒ 判不出命令，不抛')
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
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /x`).rule, 'wrapper-nesting', '第 9 跳起不再展开 ⇒ 可疑')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(20)}rm -rf /x`).rule, 'wrapper-nesting')
    assert.equal(dangerousCommandMatch(`${'command '.repeat(9)}rm -rf /x`).rule, 'wrapper-nesting', '其它透明包装同样计数')
    // 端到端（门）：必须命中 ⇒ 已授权 bash 时仍会新增 pending（见 wiring 测试的监听器层用例）
    assert.equal(dangerousExecuteMatch(exec(`${'sudo '.repeat(9)}rm -rf /x`)).rule, 'wrapper-nesting')
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
