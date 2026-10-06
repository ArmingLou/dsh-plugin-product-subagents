/**
 * v0.7.9：危险命令排除门（用户裁决）。
 *
 * 会话级**工具名**授权（`sessionRules.addToolGrant` / `toolGrantCovers`，0.7.6 起）
 * 完全不看路径，命中即放行。0.7.9 把 qoder 的 `_meta.qoder.toolName` 也接进 L1 之后，
 * 「本会话授权过一次 Bash」等于此后该会话内**所有** bash 请求免弹——包括
 * `rm -rf`、`npm publish`、`git push`。用户在 `~/.qoder/settings.json` 的
 * `permissions.ask` 里明确要这几类每次都问，本模块就是把这份裁决落到我们这一层：
 * 命中危险模式 ⇒ **跳过工具名短路**，回到交互审批（不静默放行、仍弹球）。
 *
 * 只关掉工具名这一条通道：provider 白名单快速路径、会话期**路径**记忆、
 * 用户落盘白名单都不受本门影响（它们的授权客体是具体路径，语义与"允许整个工具"
 * 不同，且都来自用户显式逐条裁决）。
 *
 * ## 名单与口径：**规则名单**与 `dsh-agent-dispatch` 的 `lib/host-approval.js` 一致；
 * ## **覆盖边界不一致**（宿主更严，逐条列在下面）
 *
 * 宿主那条通道（`tool/call`）与 ACP 这条通道（`toolCall`）判据无法直接复用，各自留
 * 一份实现。**规则名单**（本文件 `RULES` ↔ 宿主 `DANGEROUS_COMMAND_RULES`：5 条 id 与
 * 判据语义逐条相同）需人工保持同步；宿主侧注释里也写着「与 product-subagents 的
 * `lib/dangerous-commands.js` 同一份，需人工保持同步」。
 * 0.7.9 追加裁定：用户裁决「这几类命令在**任何档位**都必须走交互询问」，而先前产品侧
 * 只有 3 条、且不跳过"取值选项" ⇒ 宿主已生效、ACP 通道没生效（跨仓不同步）。
 *
 * ⚠️ **第四轮终审实测（两侧跑同一份 45 条语料）：名单一致 ≠ 覆盖边界一致。**
 * 宿主另有 5 处覆盖，本仓实测 `null`（不额外弹窗）。此处逐条列出并给出本仓现状 ——
 * **不得**再写"名单与覆盖边界必须一致"这类不成立的表述。除 `wrapper-nesting`
 * 已在本轮对齐外，其余四处**刻意不改行为**（只登记分歧）：
 *   · `coreutils rm -rf x` —— 宿主把 `coreutils` 当多调用二进制（与 `busybox`/`toybox`
 *     同一处理，程序名在**后一个** token）；本仓 `TRANSPARENT_WRAPPERS` 只收
 *     `busybox`/`toybox` ⇒ **null**。
 *   · `find /tmp -exec rm -rf {} +`（含 `-execdir`/`-ok`/`-okdir`）—— 宿主把 `-exec`
 *     之后的子命令再喂给同一份规则；本仓不解析 `-exec` 语法 ⇒ **null**。
 *   · 裸解释器读 stdin/脚本（`printf 'rm -rf /x' | bash`、`bash <<< 'rm -rf /x'`、
 *     `bash deploy.sh`）—— 宿主按 `SHELL_STDIN_RULE='shell-stdin'` 保守转交互；本仓 ⇒ **null**。
 *   · `bash -C rm -rf /x` —— 宿主判 `rm -rf`；本仓 `shellBody` 对 `-c` **大小写敏感**
 *     （`-C` 是 bash 的 noclobber、不是 `-c`）⇒ **null**。本机实测 `/bin/rm` 是二进制、
 *     `bash -C rm` 的语义是"执行名为 rm 的脚本"（无同名脚本时 exit 126）⇒ 符合裁决，
 *     **保留分歧、不改行为**。
 *   · 自定义执行工具（命令不在固定字段里，如 `{kind:'execute', rawInput:{shell:'rm -rf x'}}`）
 *     —— 宿主用 `argsTextOf` 把 args 里**所有字符串值**拼起来再判；本仓的正文来源只有
 *     固定的四个字段（见 `lib/execute-frame.js`）⇒ **null**。
 * 方向说明：这五条**都不是"本仓放行更宽"的安全豁免** —— 门判 `null` 只表示"本门不额外
 * 弹窗"，工具名档以上的规则照旧生效；要覆盖它们需要额外的词法/语义分析，属独立改动范围。
 *
 * ## 覆盖边界（诚实声明；与宿主侧**规则名单**一致，边界差异见上）
 *
 * - 覆盖：
 *   · `rm -rf` / `rm -fr` / `rm -r -f` / `rm -f -R` / `rm --recursive --force`
 *     （必须**同时**具备递归与强制，`rm -r`、`rm -f` 单旗帜不触发），含程序名带路径
 *     （`/bin/rm -rf`、`./rm -rf`）与 `busybox`/`toybox` 包装；
 *   · `npm publish` / `pnpm publish` / `yarn publish`（含 `yarn npm publish`）
 *     与 `git push`；
 *   · **透明包装**：`sudo` / `command` / `env` / `nohup` / `nice` / `time` / `timeout` /
 *     `stdbuf` / `xargs`，含各自的选项与数值参数（`sudo -u root rm -rf x`、
 *     `nice -n 10 rm -rf x`、`timeout 5 rm -rf x`），可叠加；**跳数预算 8**
 *     （`MAX_WRAPPER_HOPS`），用尽后段首仍是包装器 ⇒ 按 `WRAPPER_DEPTH_RULE`
 *     （`wrapper-nesting`，**可疑**）保守转交互（第四轮终审 Minor-1，与宿主同名对齐）；
 *   · **`env -S '<命令>'` / `env --split-string='<命令>'`**：取值是**多 token 的整条
 *     命令**（GNU env 的 split-string 语义），拼回重新分词后再喂给同一份规则
 *     （第四轮终审 Major-1：只吃掉一个 token 会命令头错位 ⇒ 判 null ⇒ 已授权 bash 时
 *     静默放行；真机已证明 `env -S "rm -rf <dir>"` 能真的删掉目录）；
 *   · **解一层 shell 包装**：`sh|bash|zsh|dash|ksh -c '<body>'`（含 `-lc`/`-ec` 组合
 *     短选项与 `-c'rm -rf x'` 粘连写法、反斜杠转义引号）把 body 再喂给同一份规则，
 *     **递归上限 2 层**，第 3 层起按「可疑」保守转交互（`SHELL_DEPTH_RULE`），
 *     不做无限展开、也不做完整 shell 解析器；
 *   · **命令动词判定跳过"取值选项"**：`git -C <dir> push`、`git -c k=v push`、
 *     `npm --prefix <p> publish`、`npm -C /tmp publish`、`pnpm -C /tmp publish`、
 *     `pnpm --dir /tmp publish`、`yarn --cwd /tmp publish`。
 *     ⚠️ **查表前必须把 token 归一大小写**：取值选项表里存的是 `-C`、`--user` 这类
 *     **大小写原样**的值，而 token 侧先 `toLowerCase()` ⇒ 不归一的实现里
 *     `-C` 永远匹配不上 `-c`，`npm -C /tmp publish`、`pnpm -C /tmp publish` 会
 *     **静默放行**（宿主侧实测踩过这个坑，本轮两侧一起修）。本文件把**表与 token
 *     都小写化**后再查（`lowerSet`），并有用例 `pnpm -C /tmp publish` 钉住。
 * - 分段：按 `;`、`|`、`||`、`&`、`&&` 与换行切子命令，**只对每段开头那条命令**判；
 *   引号内不切分（`curl 'a=1&rm -rf'` 的引号段不会被误当新命令）。故
 *   `echo "git push"`、`grep "git push" f`、`git commit -m "git push"`、
 *   `# rm -rf /tmp` 都不算危险命令。
 * - **v0.7.13：内容规则与形状判据都对整段命令文本生效，没有任何「载荷豁免」层。**
 *   ① **所有行一视同仁**（包括 heredoc 载荷行）：载荷文本永远不被隐藏。B 仓**没有**宿主
 *   那条 `wrapper-option-ambiguity` 规则 —— 当年那次误报是宿主规则造成的，本仓 0.7.10 对
 *   同一输入本就判 `null`，所以这里不需要（也曾经有过、见下）任何载荷豁免；
 *   ② **归因顺序：形状规则只在没有内容命中时才作为兜底返回。** `unwrapTransparentWrappers`
 *   预算用尽（`sudo`×9+/`command`×9+…）与 shell 展开深度用尽（三层 `sh -c`）这两条形状分支，
 *   在返回 `wrapper-nesting` / `shell-nesting` **之前**先对同一段的 token **后缀**求值内容
 *   规则（纯词法、无递归成本），命中就归因为内容规则：`sudo×9 rm -rf /tmp/x` 的留痕理由是
 *   `rm -rf`，而内容规则不覆盖的形态（`sudo×9 dd if=/dev/zero of=/dev/disk2`）仍按
 *   `wrapper-nesting` 保守转交互（预算本身不取消）。
 *   **终审 B-1 修复点**：0.7.12 的载荷豁免是按**归因 id** 做的，而这两条分支会直接返回形状
 *   规则、不再求值内容规则 ⇒ 载荷里的 `sh -c`×N / 包装 ×N 被豁免 ⇒ 判 `null` ⇒ 命中
 *   会话级工具名授权后**零弹框零留痕静默放行**（终审 E2E 实测 7 条 SILENT_ALLOW）；
 *   ③ 唯一按语法豁免的是 **heredoc 终止行**（整行恰好是某个已开启 heredoc 的 tag，
 *   `heredocTerminatorLines`）—— 它不是命令。该豁免对现有 7 条规则**可证明无观测差异**
 *   （终止行是单 token：内容规则需要「程序名 + 动词/开关」，形状规则需要跳数用尽时后面还有
 *   token 或 `-c` 正文）⇒ 保留它是为了语法正确与 CRLF 文本的终止行识别，**不声称它有牙**。
 *   ④ `git commit -F - <<'EOF'` 的**代价**（如实登记，0.7.10 起的既有行为）：正文里真的写出
 *   `rm -rf` / `git push` 字样会多弹一次 —— 载荷不是免检区。
 * - **v0.7.14：判定前加一层「文本归一化」**（用户裁定，保守策略；只做文本层，**不**解析
 *   `-c`/`-Command` 这类 flag）—— 堵住「跨行命令被判 `null`」的两类真漏判：
 *   ① **行尾未转义的 `\`**（可带行尾空白/CR，含 CRLF）= shell 续行 ⇒ 与下一行**直接拼接**
 *   （`git \` ⏎ `push origin main` ⇒ `git push origin main`、`rm \` ⏎ `-rf /tmp/x` ⇒ `rm -rf /tmp/x`）；
 *   ② **换行转义形态 / 空白规避** ⇒ 字面 `\n`/`\r`/`\t` 与裸 CR 折成**一个空格**、连续空白折叠成
 *   单个空格；**换行在引号内也切段** ⇒ `sh -c "true` ⏎ `rm -rf /tmp/x"`、
 *   `pwsh -Command "x` ⏎ `npm publish"` 的第二行能独立判定。
 *   方向**只多不少**：三遍兜底（规范化+新口径 → 原文+新口径 → 原文+旧引号口径）保证
 *   「0.7.13 会命中的形态永不变成 MISS」，40 万条自造语料差分实测**变松 0 条**；
 *   代价是这类跨行/转义写法此后**多弹一次**（用户明确接受）。
 * - **v0.7.15：全文危险词判定（用户裁定 —— 判定模式变更，不是缺陷修复）**。在**归一化后的整段
 *   文本**上再扫一遍「危险字样」，**不再限定段界 / 命令头**：文本里**出现**危险字样就弹，包括提交
 *   正文、注释、文档、`grep` 参数里的**提及**（`echo "git push"`、`git log --grep "git push"`、
 *   `git commit -m "fix: avoid rm -rf"`）。**有意取舍**：这是用户明确选择并接受的代价，逐条登记在
 *   CHANGELOG「模式变更与代价（用户裁定）」；**0.7.14 及以前那句「句中只是提到 ⇒ 不弹」的口径
 *   被本裁定作废**（不要把旧口径当现行语义读）。
 *   危险字样是**配置项**（`$DSH_HOME/data/dsh-danger-patterns.json`，预设 `rm -rf` / `git push` /
 *   `npm publish`）—— 配置只做**追加**（新增/删除追加项立刻生效；`[]` / 缺 `patterns` 键 / **空文件或
 *   纯空白** / 坏 JSON / 非数组一律等于"没有追加项"，内置三串**恒生效**，**没有任何配置能关掉这一层**；
 *   其中"还没填内容的模板文件"（空 / 纯空白 / 只有 `_readme`）**连告警都不打**，只有真配置错误才告警）
 *   ：见 `DEFAULT_DANGER_PATTERNS` 一节。匹配**大小写不敏感**（两侧按小写比对，归因串保留配置原串）。
 *   读取与规模另有**四道防线 + 一道有界读**（终审 B1 / m6 残余 TOCTOU / m7 / m8）；类型判据**只看
 *   fd**（`open(O_RDONLY|O_NONBLOCK)` + `fstat`）：不是普通文件（FIFO / 字符设备 / 目录）**根本不读**
 *   —— 读它会同步无限阻塞、冻结宿主事件循环（"先 stat 再读"不够：stat 与 read 之间类型可变，
 *   谎报成普通文件照样冻死）；超过 `MAX_DANGER_CONFIG_BYTES`（1MB）不读；有界读（缓冲＝fd 自报尺寸）；
 *   条数超过 `MAX_DANGER_PATTERNS`（1024，与 `dsh-agent-dispatch` 1.12.13 同值 —— 配置文件两仓共用）
 *   只取前 N 条；单串超过 `MAX_DANGER_PATTERN_CHARS`（4096）
 *   跳过该条。
 *   五种情况都**只降级、不关层**（内置三串恒生效）并各告警一次；兜住栈溢出的是**条数上限**。
 *   **文本上限（fail-closed）**：文本超过 `MAX_DANGER_TEXT_CHARS`（256KB）⇒ 全文层直接判
 *   `command-too-long`（**照拦**，与 `dsh-agent-dispatch` 的 `COMMAND_TOO_LONG_RULE` 同向）。
 *   结构/计数类判据（`shell-nesting` 第 3 层、`wrapper-nesting` 第 9 跳）**保持不变**：全文子串
 *   表达不了"嵌套几层"，用子串替换它们会直接丢掉 612 条形状命中（终审实测）。
 *   只做加法：新扫描是**兜底的最后一遍**，前面各遍命中即返回 ⇒ 相对 0.7.14 无任何变松。
 * - 大小写：命令名与子命令动词按**小写比对**（macOS APFS 默认大小写不敏感卷上
 *   `RM -RF x` 真的会执行 rm）。比对用的是小写副本，不改写任何被记录/展示的原文
 *   （`segment` 留痕仍是原文大小写）。v0.7.15 的全文判定同样大小写不敏感（配置串与文本都按小写比对）。
 * - 前导环境变量赋值会被跳过（`FOO=1 rm -rf x` 仍判危险）。
 * - **不覆盖（诚实的已知边界，不静默漏掉；每条都附实测的本仓结果）**：
 *   · `lerna publish`、`git` 其它破坏性子命令（`git clean -fdx`、`git reset --hard`）
 *     —— 超出用户裁决的名单，且文本里**没有任何危险字样** ⇒ 全文判定也不命中（实测 `null`）；
 *   · 变量间接（`S=rm; $S -rf x`）、`sh -c "$(curl …)"` —— 静态不可判定，需要完整 shell 解析器
 *     + 变量求值 + 读文件，且文本里没有危险字样（实测 `null`）；
 *   · `make deploy` / `npm-scripts` 里的自定义 publish、`bash deploy.sh` —— 把命令写进脚本/构建
 *     目标再执行（实测 `null`；`bash deploy.sh` 在宿主按 `shell-stdin` 保守转交互，本仓仍 `null`）；
 *   · **v0.7.15 起由全文判定"顺手"覆盖、但机制是「字面命中」而不是「看懂了语法」**：
 *     `python -c 'os.system("rm -rf")'`、`eval "rm -rf /x"`、`printf 'rm -rf /x' | bash`、
 *     `bash <<< 'rm -rf /x'`、`find /tmp -exec rm -rf {} +`、`coreutils rm -rf x`、
 *     `bash -C rm -rf /x` —— 它们**命中**（归因 `text:rm -rf`），原因是文本里**写着** `rm -rf`，
 *     不是本层解析了 `-exec` / `coreutils` / `-C` / herestring 这些语法（把 `rm -rf` 换成变量或
 *     `$CMD` 就退回不命中）；
 *   · heredoc 载荷：载荷文本**全量参与判定** —— 不是免检区（正文里的 `rm -rf` / `git push` 一样
 *     判危险，形状判据也照旧看它）；唯一按语法豁免的是终止行本身（它不是命令，见文件头 ③ 与
 *     `heredocTerminatorLines`）；
 *   · 超过 2 层的 shell 嵌套**不算"确认危险"**，而是按 `SHELL_DEPTH_RULE`
 *     （**可疑**）保守转交互；超过 8 跳的透明包装同理（`WRAPPER_DEPTH_RULE`）
 *     —— 宁可多问一次，也不无限展开。
 *   这些方向都不在这里兜底（判不出的方向不是放行：工具名档以上的规则照旧，只是本门
 *   不额外弹窗）；真机抓手是 `lib/bridges/acp.js` 的 `logRequestPermissionToolCall`。
 *
 * v0.7.9（复审 M-1/M-2）：**执行类判定与命令正文取值不再是本模块自己的事**——
 * 单点搬到 `lib/execute-frame.js`（`isExecuteFrame` / `executeCommandText`），与
 * `lib/bridges/acp.js` 的路径兜底共用同一份实现；正文来源补上 `arguments.command`
 * （对象与 JSON 字符串两种形状，老模型形态）。
 *
 * v0.7.9（第三轮复审 B-1 阻断）：**门与 `kind` 解耦，与路径侧的不对称是设计要求。**
 * 上一版把「两处口径统一」当成目标，让门跟着 `kind` 一起对非执行类帧一票否决 ⇒
 * `{kind:'other', name:'bash', title:'bash', rawInput:{command:'rm -rf /tmp/build'}}`
 * 判 null ⇒ 门整档关闭 ⇒ `lib/index.js` 的 `!danger` 分支把 session/disk/workspace
 * 三档全部推入 ⇒ 命中会话级工具名授权后**静默放行**（改前的老口径是"只要拿得到
 * `rawInput.command` 就判危险"，这道保守冗余被"口径统一"关掉了）。
 * 现在：**门只要看得到命令字段就判**（多问一次是安全方向），**路径兜底照旧只认执行类帧**
 * （它的产物会自动变成规则，放宽即 fail-open）。这条「门宁可多问，路径宁可少授权」的
 * 不对称写在本模块与 `lib/execute-frame.js` 的文件头，也在 CHANGELOG 里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeCommandText } from './execute-frame.js'

/** 前导环境变量赋值 token（`FOO=1 rm -rf x` 里的 `FOO=1`） */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** 透明包装器：不改变被包装命令的语义，剥掉后继续判（`sudo rm -rf x`） */
const TRANSPARENT_WRAPPERS = new Set([
  'sudo', 'command', 'env', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs',
  // busybox/toybox 是"多合一"二进制：`busybox rm -rf x` 里第二个 token 才是真命令
  'busybox', 'toybox',
])

/**
 * 会**吃掉下一个 token 作为取值**的包装器选项（`sudo -u root rm …`、`nice -n 10 rm …`）。
 *
 * ⚠️ 这里**刻意保留真实大小写**（`-I`、`-S` 就是标准写法的大写短选项）：它们**必须**
 * 靠 `lowerSet` 归一后才匹配得上 token 的小写副本。`xargs -I {} rm -rf x` 因此是
 * "去掉归一化就转红"的变异哨兵（`test/dangerous-commands.test.js` 的对应断言）。
 */
const WRAPPER_VALUE_OPTIONS = {
  sudo: new Set(['-u', '-g', '-p', '-c', '-h', '-r', '-t', '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type']),
  env: new Set(['-u', '-c', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set(['-o', '-f', '--output', '--format']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  xargs: new Set(['-i', '-n', '-l', '-s', '-p', '-e', '-d', '-a', '-I', '--replace', '--max-lines', '--max-args', '--max-chars', '--max-procs', '--eof', '--delimiter', '--arg-file', '--process-slot-var']),
}

/**
 * 子命令动词之前**会吃掉下一个 token 作为取值**的选项（值可能长得像动词，必须跳过）。
 *
 * ⚠️ 这里的键**必须全小写**（`-c` 而不是 `-C`）：查表前 token 会 `toLowerCase()`，
 * 表里留大写就永远匹配不上（宿主侧实测的坑，见文件头）。`--opt=value` 自带取值，
 * 由调用方判 `includes('=')` 后不再吃掉下一个 token。
 */
const PROGRAM_VALUE_OPTIONS = {
  git: new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']),
  npm: new Set(['--prefix', '-c', '--registry', '--userconfig', '--cache', '--loglevel', '--tag', '--workspace', '-w', '--otp', '--omit', '--include', '--before']),
  pnpm: new Set(['--prefix', '--dir', '-c', '--registry', '--filter', '-f', '--config-dir', '--store-dir', '--workspace-root']),
  yarn: new Set(['--cwd', '--registry', '--cache-folder', '--modules-folder', '--network-timeout', '--mutex']),
}

/**
 * 表与 token **两侧都小写**后再查（`-C` ⇒ `-c`）。
 *
 * 这正是宿主侧那处实测坑的另一半：那张表里存的是 `-C`、`-I`、`--user` 这类**大小写
 * 原样**的值，而 token 侧先 `toLowerCase()` ⇒ 不归一就永远匹配不上
 * ⇒ `npm -C /tmp publish` / `pnpm -C /tmp publish` / `xargs -I {} rm -rf x` **静默放行**
 * （宿主侧实测踩过，本轮两侧一起修）。
 *
 * **归一是本函数的唯一职责，也是唯一入口**：两处查表都走 `valueOptionsOf()`，
 * 不直接读表 —— 否则"哪张表已经小写、哪张没小写"又会漂移成另一处静默放行。
 * `test/dangerous-commands.test.js` 里有一条用例**直接喂混合大小写的表**给
 * `valueOptionsOf` 钉住这一点（把 `.toLowerCase()` 删掉即转红）。
 */
const lowerSet = (set) => new Set([...set].map((s) => s.toLowerCase()))

/** 没有"会吃取值"的选项的表（缺省） */
const NO_VALUE_OPTIONS = new Set()

/**
 * 取某程序 / 包装器的"会吃掉取值"的选项集合（**已归一大小写**）。
 *
 * 这是查表的**唯一入口**（`subCommandVerb` 与 `unwrapTransparentWrappers` 都经此），
 * 参数是 `{ 程序名: Set<string> }` 形状的表，便于用例直接喂混合大小写的替身表。
 * @param {Record<string, Set<string>>} table
 * @param {string} name 程序名 / 包装器名（小写）
 * @returns {Set<string>} 归一后（全小写）的选项集合
 */
export function valueOptionsOf(table, name) {
  // 纯防御（第四轮终审 Minor-4；两条都**不可达**：表是模块内常量、name 是 basename 过的
  // 命令名）：`table[name]` 会顺原型链取到 `Object.prototype`（`valueOptionsOf(t,'__proto__')`
  // 曾抛 "set is not iterable"），表本身为 null/undefined 也会抛。
  if (!table || typeof table !== 'object') return NO_VALUE_OPTIONS
  if (!Object.prototype.hasOwnProperty.call(table, name)) return NO_VALUE_OPTIONS
  const hit = table[name]
  return hit instanceof Set ? lowerSet(hit) : NO_VALUE_OPTIONS
}

/** `timeout 5 rm …` / `timeout 1m rm …`：时长是位置参数，不是被包装的命令 */
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/

/** shell 解释器名：`bash -c '<body>'` 解一层包装用（不做完整 shell 解析） */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** shell 包装最多展开 2 层（用户裁定：不做无限展开），再深按 SHELL_DEPTH_RULE 保守转交互 */
export const MAX_SHELL_UNWRAP_DEPTH = 2

/** 超过展开深度上限时给的门名：**可疑**（保守转交互），不是「确认危险」 */
export const SHELL_DEPTH_RULE = 'shell-nesting'

/** 透明包装最多剥 8 层（`sudo sudo … sudo rm -rf x` 的跳数预算） */
export const MAX_WRAPPER_HOPS = 8

/**
 * 跳数用尽而头部**仍是透明包装器**时给的门名（第四轮终审 Minor-1；与宿主侧
 * `host-approval.js` 的 `WRAPPER_DEPTH_RULE` 同名同语义）：**可疑**（保守转交互），
 * 不是「确认危险」。
 *
 * 改前这一支直接落回规则表 ⇒ 规则表只看到 `sudo` 一个 token ⇒ 判 null ⇒
 * **静默放行**（`sudo×9 rm -rf x`、`sudo×20 rm -rf x` 端到端 `gate=null`）。
 * 判 null 的语义是「本门不额外弹窗」，不是「安全」 —— 故此处必须转交互。
 */
export const WRAPPER_DEPTH_RULE = 'wrapper-nesting'

/** 去掉首尾包裹引号（`"'rm -rf /'"` 这类拼回来的正文） */
function stripOuterQuotes(s) {
  const t = String(s == null ? '' : s).trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1)
  return t
}

/**
 * 比较用 token 归一：先去掉**成对**的包裹引号，再去掉**落单**的首尾引号。
 *
 * 落单引号来自 v0.7.14 的「换行在引号内也切段」（见 `splitSubCommands`）：`pwsh -Command "x`
 * ⏎ `npm publish"` 切出来的第二段末尾带一个落单的 `"`（token 是 `npm publish"`），不归一就会
 * 漏判 —— 真机上那个 `npm publish` 是真会执行的。归一后更贴近真命令的字面，方向只多不少。
 *
 * **单向宽松（终审 Minor ③ 登记，代价已知并接受）**：这个"去落单引号"比 `rm` 规则用的
 * `stripOuterQuotes`（只认成对引号）更宽 ⇒ `git push"`、`npm publish"`、`git ""push""`
 * 由 0.7.13 的 `null` 变成命中的**字符串形态**（不是真命令）。选择保留而不是收窄到"仅段尾"：
 * 收窄需要判断 token 在段中的位置与引号是否跨段开启，而漏判方向是真命令被执行；
 * 正面断言钉在 `test/dangerous-commands.test.js` 的 J 组（"承认代价"用例）。
 */
function unquoteToken(s) {
  return stripOuterQuotes(s).replace(/^["']+|["']+$/g, '')
}

/**
 * 程序名归一：去掉路径前缀与包裹引号后小写。
 * `'/bin/rm'` / `'./rm'` / `'/usr/bin/env'` / `'"rm"'` → `rm` / `rm` / `env` / `rm`。
 */
function basenameOf(token) {
  const raw = String(token == null ? '' : token).replace(/^["']+|["']+$/g, '')
  const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase()
}

/**
 * `env -S '<命令>'` / `env --split-string='<命令>'` 的**取值**（第四轮终审 Major-1）。
 *
 * 与其它"吃掉一个 token"的选项不同，`-S` 的取值是**整条命令**（GNU env 的 split-string
 * 语义）：shell 里按空白分词后会被拆成**多个 token**，`unwrapTransparentWrappers` 的
 * 通用分支只 `i += 1` 吃掉一个 ⇒ 命令头错位 ⇒ 整个包装剥不掉 ⇒ 规则表看到 `env`
 * ⇒ 判 null ⇒ **静默放行**（真机已证明 `env -S "rm -rf <dir>"` 真的把目录删掉，exit 0）。
 *
 * 修法：把 `-S`/`--split-string` **之后的所有 token 原样拼回**（连同该 token 内粘连的
 * 取值），重新分词后当作该包装的"命令"继续剥。拼回的文本会再喂给同一份规则。
 * @param {string[]} tokens 程序名**之后**的 token（不含 `env` 本身）
 * @returns {string|null} 拼回的取值文本；本组 token 里没有 `-S`/`--split-string` 时 null
 */
function splitStringPayload(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = String(tokens[i] == null ? '' : tokens[i]).trim()
    const lower = raw.toLowerCase()
    // 独立写法：`env -S "<命令>"`（命令从下一个 token 起）
    if (lower === '-s' || lower === '--split-string') return tokens.slice(i + 1).join(' ')
    // 粘连写法：`env -S"<命令>"` / `env --split-string="<命令>"`
    if (lower.startsWith('--split-string=')) return [raw.slice(raw.indexOf('=') + 1), ...tokens.slice(i + 1)].join(' ')
    if (lower.startsWith('-s') && lower.length > 2) return [raw.slice(2), ...tokens.slice(i + 1)].join(' ')
  }
  return null
}

/**
 * 剥掉透明包装（可叠加：`env FOO=1 sudo -u root nice -n 10 rm -rf x`）。
 * 剩不下真正的命令（`command`、`timeout 5` 后面什么都没有）时返回空 tokens。
 *
 * @returns {{tokens: string[], nesting: boolean}} `nesting: true` ⇒ 跳数预算用尽而头部
 *   **仍是透明包装器** ⇒ 调用方按 `WRAPPER_DEPTH_RULE` 保守转交互（**不许**落回规则表
 *   判 null —— 那是静默放行，见 `WRAPPER_DEPTH_RULE` 的说明）
 */
function unwrapTransparentWrappers(tokens) {
  let out = tokens
  for (let hop = 0; hop < MAX_WRAPPER_HOPS && out.length > 0; hop += 1) {
    const head = basenameOf(out[0])
    if (!TRANSPARENT_WRAPPERS.has(head)) return { tokens: out, nesting: false }
    // `env -S` 的取值是多 token 的整条命令 ⇒ 在通用选项扫描之前先拼回（Major-1）
    if (head === 'env') {
      const payload = splitStringPayload(out.slice(1))
      if (payload !== null) {
        out = tokenizeSegment(stripOuterQuotes(payload))
        continue
      }
    }
    const valueOpts = valueOptionsOf(WRAPPER_VALUE_OPTIONS, head)
    let i = 1
    for (; i < out.length; i += 1) {
      const t = stripOuterQuotes(out[i])
      if (ENV_ASSIGNMENT.test(t)) continue // env FOO=1 cmd
      if (t.startsWith('-')) {
        // `--opt=value` 自带取值（不占下一个 token）；反之要连同它的取值一起跳过
        if (!t.includes('=') && valueOpts.has(t.toLowerCase())) i += 1
        continue
      }
      if (head === 'timeout' && TIMEOUT_DURATION.test(t)) continue
      break
    }
    if (i >= out.length) return { tokens: [], nesting: false }
    out = out.slice(i)
  }
  return { tokens: out, nesting: out.length > 0 && TRANSPARENT_WRAPPERS.has(basenameOf(out[0])) }
}

/**
 * `sh|bash|zsh|dash|ksh -c <body>` 的 body 起点（无 `-c` 返回 -1）。
 * `-lc` / `-ec` 这类组合短选项也认；`--xxx` 长选项不认；`-c'rm -rf x'`（`-c` 与正文
 * **粘连在同一 token** 的写法，shell 里同样合法）也认 —— 此时正文就是该 token 里
 * 跟在 `c` 之后的剩余部分。
 * @returns {{glued: string, restAt: number}} `glued` = 粘连在同一 token 里的正文开头
 *   （非粘连为 `''`）；`restAt` = 其后**还需要拼进来的 tokens 起点**（无剩余时等于长度）
 */
function shellBody(tokens) {
  for (let i = 1; i < tokens.length; i += 1) {
    // 先按**未去引号**的原文判选项形态：`-c'rm` 的首字符是 `-`，去引号后会变成 `c'rm`
    const raw = String(tokens[i] == null ? '' : tokens[i]).trim()
    const lower = raw.toLowerCase()
    if (lower === '-' || lower === '--' || !lower.startsWith('-') || lower.startsWith('--')) continue
    const at = raw.indexOf('c', 1)
    // ⚠️ 这里**大小写敏感**（与取值选项表刻意不同）：shell 的选项字母是大小写敏感的，
    // `-C` 是 noclobber 而不是 `-c`，把它当"命令正文"会把 `bash -C rm -rf x` 误判
    // （那是 bash 的选项，不是 `rm` 命令）。
    if (at < 0) continue
    // `-c'rm -rf x'`：正文与该 token 粘连（`-c` 后面还有内容）⇒ 拼上后续 token
    if (at + 1 < raw.length) return { glued: raw.slice(at + 1), restAt: i + 1 }
    return { glued: '', restAt: i + 1 }
  }
  return { glued: '', restAt: -1 }
}

/**
 * `rm` 是否同时具备递归与强制。
 * 程序名按 basename 比对（`/bin/rm`、`./rm`）；短选项按字符扫（`-rf`/`-fr`/`-Rf`），
 * 长选项精确匹配 `--recursive`/`--force`；选项与路径的**顺序无关**（`rm /tmp/x -rf` 也认）。
 */
function isRecursiveForceRemove(tokens) {
  if (basenameOf(tokens[0]) !== 'rm') return false
  let recursive = false
  let force = false
  for (const token of tokens.slice(1)) {
    const t = stripOuterQuotes(token).toLowerCase()
    if (t.startsWith('--')) {
      if (t === '--recursive') recursive = true
      else if (t === '--force') force = true
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      const chars = t.slice(1)
      if (chars.includes('r')) recursive = true
      if (chars.includes('f')) force = true
    }
  }
  return recursive && force
}

/**
 * `git`/`npm`/`pnpm`/`yarn` 的子命令动词是否命中（`yarn npm publish` 也认）。
 * 程序名（basename）之后**第一个非选项 token**，且跳过该命令自己**会吃掉取值**的
 * 选项（`git -C <dir> push`、`git -c k=v push`、`npm --prefix <p> publish`、
 * `pnpm -C /tmp publish`）。`--opt=value` 是单个 token，不再吃掉下一个。
 * 这样 `pnpm publish` / `git --no-pager push` 能覆盖，而 `git log --grep push` 不会误伤。
 */
function subCommandVerb(tokens, program, verb) {
  if (basenameOf(tokens[0]) !== program) return false
  const valueOpts = valueOptionsOf(PROGRAM_VALUE_OPTIONS, program)
  const words = []
  for (let i = 1; i < tokens.length; i += 1) {
    // v0.7.14：用 `unquoteToken`（连**落单**引号一起去）—— 换行在引号内也切段后，段尾可能带一个
    // 落单引号（`npm publish"`），不归一就会把那条真命令漏判。
    const t = unquoteToken(tokens[i]).toLowerCase()
    if (t.startsWith('-') && t.length > 1) {
      if (!t.includes('=') && valueOpts.has(t)) i += 1
      continue
    }
    words.push(t)
    // 只要前两个非选项 token 就够判 `yarn npm publish` / `npm run publish`
    if (words.length >= 2) break
  }
  if (program === 'yarn') {
    // `yarn publish` 与 `yarn npm publish`（yarn 2+ 的写法）同语义
    if (words[0] !== 'publish') return words[0] === 'npm' && words[1] === 'publish'
    return true
  }
  return words[0] === verb
}

/**
 * ## 全文危险词（danger patterns）—— v0.7.15 · **用户裁定**：「改成全文子串判定：文本里出现危险字样就弹」
 *
 * 与前面所有遍的区别：**不再限定段界 / 命令头** —— 在**归一化后的整段文本**上，只要任意位置
 * 出现危险字样就判高危（提及、注释、提交信息、grep 模式、文档引用一律算）。用户同时裁定把它
 * **做成配置项**，以后可动态增加高危判断字符串。
 *
 * 配置项（**只增不减**：内置三串恒生效，配置文件只能**追加**）：
 *   `$DSH_HOME/data/dsh-danger-patterns.json`（`$DSH_HOME` 缺省 `~/.dsh`）
 *   `{ "patterns": ["deploy --force"] }`（`_readme` 之类注释字段可带）
 *   · **内置三项 `DEFAULT_DANGER_PATTERNS`（`rm -rf` / `git push` / `npm publish`）恒生效，
 *     不可通过配置关闭** —— `~/.dsh/data/` 是**可写**的，若允许 `patterns: []` 关层，
 *     任何一条命令都能写个空表把自己的危险门解除武装，与用户「只加不减、更保守」直接冲突。
 *     用户原话是「以后可以动态**增加**高危判断的字符串」⇒ 配置的语义就是**追加**。
 *   · 文件**缺失** ⇒ 等价于"没有追加项"（内置三串照常生效，正常状态，不告警）；
 *   · **JSON 坏 / `patterns` 不是数组 / `patterns: []`** ⇒ 同样等价于"没有追加项"，
 *     内置三串照常生效；前两种**各告警一次**（按摘要计一次，绝不因读取失败变成"不判"）；
 *   · 追加项逐条 trim、丢空串、去重、与内置三串去重；**按字面字符串匹配，不执行正则**
 *     （配置串不会被当模式编译）；
 *   · **免重启**：按 `(mtimeMs, size)` 变化重读；未变化则走缓存，不读盘。
 *     **新增/删除追加项立刻生效**，但内置三串**始终在场**（配置文件删不掉它们）。
 *   · **大小写不敏感**：配置串与文本两侧都按小写比对（与 `dsh-agent-dispatch` 的全文层同构）；
 *     **归因串保留配置里的原串大小写**（`text:custom:<原串>`）。
 *   · 方向：**配置只会让门更严**（最多是更爱弹一次），不可能放松。
 *
 * 匹配语义（**容忍空白与包裹引号的字面子串、大小写不敏感**）：`rm  -rf`、`rm \t -rf`、续行拼接后的
 * `rm -rf`、`rm "-rf"`、`RM -RF`、`Git Push` 全部命中；左右**词边界**（前一/后一字符不得是
 * `[A-Za-z0-9_-]`）挡住 `perform -rf` / `legit push` / `npm publisher` / `git pushd` 这类"包含但不是它"。
 * 归因：内置三串 ⇒ `text:<串>`；自定义串 ⇒ `text:custom:<原串>`（**原串大小写照抄配置**）。
 *
 * **代价（如实登记，用户裁定接受）**：把危险字样**写进文本**（提交正文 / 注释 / 文档 /
 * `grep` 参数）也会多弹一次 —— 见 CHANGELOG「模式变更与代价（用户裁定）」。
 * **只做加法**：它不替代按段判定与形状判据（那些照旧先跑），只在都不命中时兜底。
 */
export const DEFAULT_DANGER_PATTERNS = ['rm -rf', 'git push', 'npm publish']

/**
 * 配置读取的三道上限 + 全文层的一道文本上限（终审 B1 / m7 / m8 / 跨仓对齐）。
 * **共同方向**：任何超限/异常一律**降级为"没有追加项"**（内置三串照常生效）或**照拦**，
 * 绝不允许变成"不判"，更不允许把内置三串关掉。
 */
export const MAX_DANGER_CONFIG_BYTES = 1024 * 1024 // B1：超过 1MB 不读（读之前先判类型与大小）
export const MAX_DANGER_PATTERNS = 1024 // m8 + 跨仓统一（与 A 仓 1.12.13 同值）：条数上限（超出只取前 N 条 + 告警）
export const MAX_DANGER_PATTERN_CHARS = 4096 // m8：单串长度上限（超出的条目跳过 + 告警）
export const MAX_DANGER_TEXT_CHARS = 256 * 1024 // 跨仓对齐：超长文本判 `command-too-long`（照拦）

const DANGER_PATTERNS_FILE = 'dsh-danger-patterns.json'

let patternsWarned = new Set()
let patternsCache = { file: null, signature: null, patterns: null }

/** 配置文件路径（**懒解析** `$DSH_HOME`，便于测试注入；生产即 `~/.dsh/data/dsh-danger-patterns.json`） */
export function dangerPatternsPath() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'data', DANGER_PATTERNS_FILE)
}

/**
 * 告警**按摘要各一次**（`kind` 区分"坏 JSON"与"非数组"两种情形）：同一摘要不重复刷屏，
 * 但不同情形各自留痕 —— 这样"某一种情况的告警被静默"会被用例单独抓住。
 */
function warnPatternsOnce(kind, message) {
  if (patternsWarned.has(kind)) return
  patternsWarned.add(kind)
  console.warn(`[product-subagents] ${message}`)
}

/**
 * 清空配置缓存与"已告警"标记（**仅供测试/自检**：生产代码无需调用 —— 免重启由 mtime+size 负责，
 * 同尺寸同毫秒改写的极端场景才需要它）。
 */
export function resetDangerPatternsCache() {
  patternsCache = { file: null, signature: null, patterns: null }
  patternsWarned = new Set()
}

/**
 * 读全文危险词配置 —— **只增不减**：返回 `DEFAULT_DANGER_PATTERNS` **加上**配置里的追加项。
 * 文件缺失 / **空文件或纯空白** / **缺 `patterns` 键或 `patterns: []`（含 `{}` 模板）** / JSON 坏 /
 * `patterns` 不是数组 —— 一律等价于"没有追加项"（内置三串照常生效，读失败不会变成"不判"）。
 * **告警口径（终审 Minor-1）**：只有**真配置错误**才告警一次 —— 坏 JSON、`patterns` 存在但**不是数组**、
 * 非普通文件、过大、条数/单串超限；"还没填内容的模板文件"（0 字节 / 纯空白 / 只有 `_readme`）**静默**。
 * 返回值**永不为空**（内置三串恒在场）⇒ 没有任何配置能关掉这层判定。
 *
 * **五道防线（终审 B1 / m6 残余 TOCTOU / m7 / m8）——都在"读"之前或读的当场生效**：
 * ① **类型判据一律取自 fd，不取自路径**：`openSync(file, O_RDONLY | O_NONBLOCK)` 之后
 *    **只认 `fstatSync(fd).isFile()`**，其余（FIFO / 字符设备 / 目录 / 套接字…）⇒ 按"没有追加项"
 *    + 告警、**根本不读** —— `readFileSync` 读 FIFO 或 `/dev/zero` 会**同步无限阻塞**（`try/catch`
 *    拦不住），会把宿主事件循环整条冻死（`lib/index.js` 的 `dangerousExecuteMatch` 是同步调用、
 *    在一切放行判定之前）。**"先 stat 再读"不够**：把 stat 谎报成"普通文件 100B"、实为 FIFO
 *    照样冻死（stat 与 read 之间类型可变）⇒ 类型只看 fd。`O_NONBLOCK` 下 FIFO 的 open
 *    不等待写端（无写端也立刻成功）⇒ 没有任何"先读"的窗口；
 * ② **尺寸 > `MAX_DANGER_CONFIG_BYTES`**（尺寸也取自同一个 fd）⇒ 不读；
 * ③ **有界读**：缓冲就是 fd 自报的尺寸（已 ≤ 1MB），`readSync` 循环**绝不多读一个字节**；
 * ④ **条数 > `MAX_DANGER_PATTERNS`** ⇒ 只取前 N 条 + 告警；⑤ **单串 > `MAX_DANGER_PATTERN_CHARS`**
 *    ⇒ 跳过该条 + 告警。
 *    **兜住栈溢出的是第 ④ 条**（展开面 ≤ `MAX_DANGER_PATTERNS` 个实参）；追加项用 `for…of`
 *    逐条 push 只是**纵深防御**（`push(...arr)` 在 ~20 万条时会抛
 *    `RangeError: Maximum call stack size exceeded`）。fd 一律在 `finally` 里 `closeSync`。
 * @param {string} [file] 配置文件路径（缺省 `dangerPatternsPath()`）
 * @returns {string[]} 内置三串 + 归一化后的追加项（去重、保持内置在前）
 */
export function readDangerPatterns(file = dangerPatternsPath()) {
  // `statSync` **只用来算缓存键**（省一次 open / 支持免重启），决策一律不看它。
  let signature = 'missing'
  try {
    const st = fs.statSync(file)
    signature = `${st.mtimeMs}:${st.size}`
  } catch {
    signature = 'missing'
  }
  if (patternsCache.file === file && patternsCache.signature === signature) return patternsCache.patterns
  const extra = []
  let fd = null
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile()) {
      warnPatternsOnce('not-file', `危险词配置不是普通文件（本次按"没有追加项"处理，内置 ${DEFAULT_DANGER_PATTERNS.length} 项照常生效）: ${file}`)
    } else if (st.size > MAX_DANGER_CONFIG_BYTES) {
      warnPatternsOnce('too-large', `危险词配置过大（${st.size} 字节 > ${MAX_DANGER_CONFIG_BYTES}，本次按"没有追加项"处理，内置 ${DEFAULT_DANGER_PATTERNS.length} 项照常生效）: ${file}`)
    } else {
      const buf = Buffer.allocUnsafe(st.size)
      let off = 0
      while (off < buf.length) {
        const n = fs.readSync(fd, buf, off, buf.length - off, off)
        if (n <= 0) break
        off += n
      }
      const text = buf.subarray(0, off).toString('utf8')
      // **空文件 / 纯空白 ⇒ 静默按"没有追加项"**（终审 Minor-1）：用户 `touch` 一个模板文件、
      // 或先写个空壳（含只剩 BOM/换行的）都是正常用法，不该刷"读取失败"。**不调 JSON.parse**，
      // 免得把空串变成 `SyntaxError`。
      if (text.trim() !== '') {
        const raw = JSON.parse(text)
        const hasKey = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'patterns' in raw
        const list = hasKey ? raw.patterns : undefined
        if (Array.isArray(list) && list.length > 0) {
          if (list.length > MAX_DANGER_PATTERNS) {
            warnPatternsOnce('too-many', `危险词配置条数过多（${list.length} > ${MAX_DANGER_PATTERNS}，只取前 ${MAX_DANGER_PATTERNS} 条，内置 ${DEFAULT_DANGER_PATTERNS.length} 项照常生效）: ${file}`)
          }
          let skippedLong = 0
          for (const p of list.slice(0, MAX_DANGER_PATTERNS)) {
            if (typeof p !== 'string' || !p.trim()) continue
            const norm = p.trim().replace(/\s+/g, ' ')
            if (norm.length > MAX_DANGER_PATTERN_CHARS) {
              skippedLong += 1
              continue
            }
            extra.push(norm)
          }
          if (skippedLong > 0) {
            warnPatternsOnce('too-long', `危险词配置有 ${skippedLong} 条超过 ${MAX_DANGER_PATTERN_CHARS} 字符（这些条目已跳过，其余照常生效）: ${file}`)
          }
        } else if (hasKey && !Array.isArray(list)) {
          // `patterns` **存在但不是数组** ⇒ 真配置错误，告警一次；
          // `patterns` 缺键 / 为 `[]` / 整个文件是 `{}` 之类 ⇒ 静默（用户先写模板是正常用法）。
          warnPatternsOnce('not-array', `危险词配置的 patterns 不是数组（本次按"没有追加项"处理，内置 ${DEFAULT_DANGER_PATTERNS.length} 项照常生效）: ${file}`)
        }
      }
    }
  } catch (err) {
    // 缺失（ENOENT）与自指软链（ELOOP）视同"没有这个文件" ⇒ 静默；其余（EACCES / 坏 JSON / …）
    // ⇒ 告警一次，语义仍是"没有追加项"（内置三串照常生效）。
    const code = err && err.code
    if (code !== 'ENOENT' && code !== 'ELOOP') {
      const kind = err instanceof SyntaxError ? 'broken-json' : 'read-failed'
      warnPatternsOnce(kind, `危险词配置读取失败（本次按"没有追加项"处理，内置 ${DEFAULT_DANGER_PATTERNS.length} 项照常生效）: ${err.message}`)
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 关不掉也不改变"没有追加项"的降级语义
      }
    }
  }
  const patterns = [...DEFAULT_DANGER_PATTERNS, ...new Set(extra.filter((p) => !DEFAULT_DANGER_PATTERNS.includes(p)))]
  patternsCache = { file, signature, patterns }
  return patterns
}

/** 词字符（词边界判据：命中串的左/右连续词字符即视为"某个更长的词的一部分"） */
const WORD_CHAR_RE = /[A-Za-z0-9_-]/
const QUOTE_CHAR_RE = /["']/

function skipWhitespace(text, at) {
  let i = at
  while (i < text.length && /\s/.test(text[i])) i += 1
  return i
}

function skipQuotes(text, at) {
  let i = at
  while (i < text.length && QUOTE_CHAR_RE.test(text[i])) i += 1
  return i
}

/**
 * 在 `text` 里找 `words`（已按空白切好的字面词序列）：词间**必须有空白**，词的前后可带引号，
 * 首词左侧与末词右侧必须是词边界。**不用正则**（用户配置串只走 `indexOf`/`startsWith`）。
 * @returns {{at: number, end: number}|null}
 */
function findDangerPattern(text, words) {
  const first = words[0]
  let from = 0
  while (from <= text.length - first.length) {
    const at = text.indexOf(first, from)
    if (at < 0) return null
    from = at + first.length + 1
    if (at > 0 && WORD_CHAR_RE.test(text[at - 1])) continue
    let q = at + first.length
    let ok = true
    for (let i = 1; i < words.length; i += 1) {
      const ws = skipWhitespace(text, q)
      if (ws === q) { ok = false; break } // 词间必须有空白：`rm-rf` 不算（它是另一个词）
      q = skipQuotes(text, ws)
      if (!text.startsWith(words[i], q)) { ok = false; break }
      q += words[i].length
    }
    if (!ok) continue
    const end = skipQuotes(text, q)
    if (end < text.length && WORD_CHAR_RE.test(text[end])) continue
    return { at, end }
  }
  return null
}

/** 归因 id：内置三串 ⇒ `text:<串>`；追加串 ⇒ `text:custom:<原串>` */
function dangerPatternRuleId(pattern) {
  return DEFAULT_DANGER_PATTERNS.includes(pattern) ? `text:${pattern}` : `text:custom:${pattern}`
}

/**
 * 大小写折叠（**保持长度** ⇒ 折叠串与原文**逐索引对齐**，命中位置可直接切原文做留痕片段，
 * 词边界判据也不会因折叠位移而误判）。
 *
 * 快路径用原生 `toLowerCase()`（一次调用，长文本上比逐码点循环快一到两个数量级）；
 * 只有原生折叠**改变了长度**时（罕见：如 `İ` U+0130 折叠成 `i̇`，1 → 2 个 UTF-16 码元）才退回
 * 逐码点循环、对这类码点保留原字符 —— 保证返回串与入参**同长**这个不变式。
 *
 * **边界（实测，别按直觉写）**：`ẞ`(U+1E9E) 的 `toLowerCase()` **就是** `ß`(U+00DF)、长度不变 ⇒
 * 走快路径、两者**互相命中**（`foldCase('ẞ') === 'ß'`）；真正需要保长兜底的是 `İ`(U+0130) 这类
 * **折叠会变长**的码点 —— 那类字符保留原字符、该位置不参与折叠（内置/常见模式不受影响：
 * `echo "İİİ" GIT PUSH` 照旧命中且 `segment` 逐字对齐）。
 *
 * 导出（`export`）是**测试缝**：用例直接钉住 `foldCase(x).length === x.length` 这条不变式
 * （终审 m9：那段"保持长度"的兜底路径此前无覆盖，短路成 `return text.toLowerCase()` 竟全绿）。
 */
export function foldCase(text) {
  const low = text.toLowerCase()
  if (low.length === text.length) return low
  let out = ''
  for (const ch of text) {
    const one = ch.toLowerCase()
    out += one.length === ch.length ? one : ch
  }
  return out
}

/**
 * **全文危险词扫描**（v0.7.15 · 用户裁定）。在归一化后的整段文本上做，不看段界/命令头。
 * @param {string} text 归一化后的命令文本
 * @param {string[]} [patterns] 危险词表（缺省 = 读配置 = 内置三串 + 追加项）。
 *   **显式传表即"完全替换"**：传了非空表就只用这张表，内置三串**不**并进来
 *   （如 `scanDangerPatterns('rm -rf /tmp/x', ['deploy --force'])` ⇒ `null`）—— 这是给用例用的
 *   **测试缝**，生产只有 `matchText` 一处调用、走缺省值。传空表 / 非法值（含表里混入非字符串
 *   条目）则**回到内置三串** —— 这层判定**没有"关闭"这个状态**
 *   （见配置项说明：`~/.dsh/data/` 可写，允许配置把内置串撤掉就等于留了自我解除武装的口子）。
 *   比对**大小写不敏感**（两侧折叠后比），归因串保留配置里的原串大小写。
 *   **文本超过 `MAX_DANGER_TEXT_CHARS`（256KB）⇒ 直接返回 `command-too-long`（照拦）**，
 *   与 `dsh-agent-dispatch` 的 `COMMAND_TOO_LONG_RULE` 同向：太长**不是**放行理由。
 * @returns {{rule: string, segment: string}|null} 归因 id 与命中片段（截 200 字符）
 */
export function scanDangerPatterns(text, patterns = readDangerPatterns()) {
  if (typeof text !== 'string' || text.length === 0) return null
  // **跨仓对齐（文本上限，fail-closed）**：超长 ⇒ 判 `command-too-long`（仍然拦），
  // **绝不**变成"太长就不扫、就放行"。放这里＝"前面各遍都没命中"之后的兜底语义保持不变。
  if (text.length > MAX_DANGER_TEXT_CHARS) {
    return { rule: 'command-too-long', segment: text.slice(0, 200) }
  }
  // 入口守卫（**唯一一处** —— 别在循环里再挂一份，那样这层守卫就没人能用变异验牙了）：
  // 逐条丢掉非字符串 / 空白条目（`[null]`/`[123]`/`[{}]` 会 `TypeError`，`['']` 会因空串
  // `indexOf('') === 0` 变成"命中"）。过滤后**没有有效条目**时回到内置三串 —— `[]` / 非法值
  // 都等于"没有追加项"，这层判定**没有"关闭"状态**（见配置项说明）。
  const list = (Array.isArray(patterns) ? patterns : []).filter((p) => typeof p === 'string' && p.trim())
  const effective = list.length > 0 ? list : DEFAULT_DANGER_PATTERNS
  // **大小写不敏感**（与 `dsh-agent-dispatch` 的 `'i'` 同构，方向只会更严）：两侧都折叠后再比。
  // `folded` 与 `text` 逐索引对齐 ⇒ 留痕片段仍切**原文**（保留原串大小写）。
  const folded = foldCase(text)
  for (const pattern of effective) {
    const words = foldCase(pattern.trim().replace(/\s+/g, ' ')).split(' ')
    // 廉价预筛：首词在整段文本里**字面**出现才可能命中（容忍空白/引号只影响词间与词侧）
    if (!folded.includes(words[0])) continue
    const hit = findDangerPattern(folded, words)
    if (hit) return { rule: dangerPatternRuleId(pattern.trim().replace(/\s+/g, ' ')), segment: text.slice(hit.at, hit.at + 200) }
  }
  return null
}

/**
 * 危险命令名单 —— **与 `dsh-agent-dispatch` 的 `lib/host-approval.js`
 * `DANGEROUS_COMMAND_RULES` 同一份，需人工保持同步**（那边是宿主 `tool/call` 通道，
 * 这边是 ACP `toolCall` 通道，判据实现无法直接复用，故各自留一份并按同一口径维护）。
 */
export const RULES = [
  { id: 'rm -rf', match: (tokens) => isRecursiveForceRemove(tokens) },
  { id: 'npm publish', match: (tokens) => subCommandVerb(tokens, 'npm', 'publish') },
  { id: 'pnpm publish', match: (tokens) => subCommandVerb(tokens, 'pnpm', 'publish') },
  { id: 'yarn publish', match: (tokens) => subCommandVerb(tokens, 'yarn', 'publish') },
  { id: 'git push', match: (tokens) => subCommandVerb(tokens, 'git', 'push') },
]

/**
 * 取本次请求的 shell 正文 —— **执行类判定与取值来源的单点是 `lib/execute-frame.js`**。
 *
 * v0.7.9（第三轮复审 B-1 阻断，**fail-safe**）：本门与 `kind` **解耦**。
 * 改前（复审 M-2 的"口径统一"）：`kind` 明确非执行类 ⇒ 不判危险命令。于是
 * `{kind:'other', name:'bash', title:'bash', rawInput:{command:'rm -rf /tmp/build'}}`
 * 判 null ⇒ 门整档关闭 ⇒ `lib/index.js` 的 `!danger` 分支把 session/disk/workspace
 * 三档全部推入 ⇒ 命中会话级工具名授权后**静默放行**（一条 pending 事件都不发；
 * 改前 pristine 会弹窗）。qoder 主链路是 `kind:"execute"` 不受影响，但仓库自己的
 * fixture 就把 bash 帧建模成 `kind:'other'`，opencode 真实载荷从未抓到 ⇒ 无法排除
 * 「某产品用非执行类 kind 发 shell」。
 *
 * v0.7.9（复审 M-1，fail-open 修复）：取值来源与路径提取对齐，**新增
 * `arguments.command`**（对象与 JSON 字符串两种形状都支持）。改前
 * `{name:'shell', arguments:'{"command":"git push --force"}'}` 取不到正文 ⇒ 判 null ⇒
 * 工具名档短路 ⇒ 门失效（该会话此前授权过 Bash 就再也不会问）。
 *
 * 现在：**门只要看得到命令字段就判**（`rawInput.command` / `arguments.command`，
 * 字符串与对象两种形状）—— 门的产物只是「**要不要多问一次**」这一个布尔，多问一次是
 * 安全方向。这与「路径兜底仍对非执行类一票否决」是**有意的不对称**：**门宁可多问，
 * 路径宁可少授权**（详见 `lib/execute-frame.js` 文件头）。反过来，`title` /
 * `content[].content.text` 这两条**文本**来源仍只在执行类帧下可信（Write/Edit 的
 * 正文与标题里出现 `rm -rf` 是文件内容，不是命令），以免天天误伤。
 *
 * 取值优先级（四条，见 `lib/execute-frame.js` 的 `COMMAND_SOURCES`）：
 * `rawInput.command` → `arguments.command` → `content[].content.text` → `title`。
 * **不**把"只有 `content[].content.text`"当生效条件：Write/Edit 类请求的 content 块里
 * 装的是文件正文/diff，其中出现 `rm -rf` 是代码内容而非命令（实测 qoder 的执行类请求
 * 必然带 `kind:"execute"`，且 `rawInput.command` 与 `content[].text` 同值）。
 */

/**
 * 按 shell 分隔符切子命令：`;` `|` `||` `&` `&&` 与换行。
 * 单引号/双引号内部**不**切分 `;` `|` `&`（`curl 'a=1&rm -rf'` 保持一段）。反斜杠转义引号
 * 按"前一个字符不是 `\\`"粗略处理，够用；未闭合引号会从该处一路保留到结尾（宁可少判一段，
 * 也不把引号内的字面量当命令）。
 *
 * **换行例外（v0.7.14 · 用户裁定）**：换行是 shell 的命令分隔符，**引号里也切**，并重置引号
 * 状态（未闭合的引号不跨行）。这样 `bash -c "true` ⏎ `rm -rf /tmp/x"`、`pwsh -Command "x` ⏎
 * `npm publish"` 的第二行能独立判定 —— **不需要**按 `-c` / `-Command` 这类 flag 做任何解析
 * （用户明确不要那个复杂度）。方向是**只多切、多判**（保守侧：多切出来的段各自判定，最多多弹）。
 * 行尾未转义的 `\\`（续行）由 `normalizeCommandText` 在**切段之前**并掉。
 */
export function splitSubCommands(text) {
  const segments = []
  let buffer = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    // v0.7.14：**换行一律当段分隔符**（引号里也照切，并重置引号状态）—— 见函数头说明。
    if (ch === '\n') {
      segments.push(buffer)
      buffer = ''
      quote = ''
      continue
    }
    if (quote) {
      buffer += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i += 1
      segments.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  segments.push(buffer)
  return segments
}

// ── v0.7.13：heredoc 终止行（它不是命令） ───────────────────────────────────────
//
// 0.7.12 曾给形状判据加「载荷行豁免」+ 一个极简行掩码（本轮**整体删除**），本轮按终审裁定
// **整体删除**：B 仓没有宿主那条 `wrapper-option-ambiguity` 规则（当年误报是宿主规则造成的），
// 载荷豁免换来的只是两个阻断 —— B-1：形状规则先归因、再被豁免吞掉 ⇒ 载荷里的真命令
// 判 `null` ⇒ 静默放行；B-2：执行型载荷（`sh <<'SH'` + 载荷 `sudo×9 dd …`）被无条件豁免。
// 现在：内容规则与形状规则对所有行生效；归因顺序「先内容、后形状」（`contentRuleOf`）；
// 只剩**终止行**按语法豁免。
//
// ⚠️ 终止行豁免对现有 7 条规则**可证明无观测差异**：终止行是**单 token**（tag 正则
// `^[A-Za-z_][A-Za-z0-9_.-]*$`，`<<-` 形态还允许前导 TAB），而内容规则要求「程序名 +
// 动词/开关」（`rm -rf`、`git push`…）、形状规则要求跳数用尽时**后面还有 token**
// （`exhausted = out.length > 1`）或 shell 的 `-c` 正文 —— 单 token 两者都不可能命中。
// 保留它的意义是**语法正确**（终止行确实不执行）与 CRLF 文本（`<<'EOF'\r\n…EOF`）识别；
// 变异实测：删掉跳过逻辑不改任何一条用例的判定（如实登记，不假装它有牙）。
//
// 认哪些 `<<` 是 heredoc 起始（其余一律不产生终止行）：
//   · 认：`<<TAG`、`<< TAG`（tag 前可有空格/TAB）、`<<-TAG`（缩进形态）、tag 可带**成对**
//     引号（`<<'EOF'` / `<<"EOF"`）或反斜杠转义（`<<\EOF`）；
//   · 不认：`<<<` here-string（正文在**同一行**）、算术左移（`<<` 前一个非空白字符是
//     数字 / `)` / `]`，如 `$((1<<n))`、`1 << n`）、引号里的 `<<`、注释里的 `<<`、
//     `\<<`（被转义）、tag 不是标识符（`<<$TAG`、`<<1`）、tag 之后不是行尾/空白/`;|&)`
//     （`<<a/b`）、**找不到终止行的起始**（不猜结尾）。
//
// **单趟扫描 + 上限**：最多认 `MAX_HEREDOC_OPS` 个起始；超出即不再识别 —— 少认只会少跳过
// 若干终止行（那些行照旧参与判定），方向仍是多弹不少弹。
//
/** heredoc tag 的字面形态：字母/下划线开头（`<<1`、`<<$TAG`、`<<a/b` 一律不认 ⇒ 不剥） */
const HEREDOC_TAG_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * 宽松取词（只为拿到「候选 tag」再交给 `HEREDOC_TAG_RE` 判形态）：
 * 单条守卫（`HEREDOC_TAG_RE`）同时管住「引号形态」与「裸形态」两条分支。
 */
const HEREDOC_TAG_CANDIDATE_RE = /^[A-Za-z0-9_$][A-Za-z0-9_.$-]*/

/** tag 之后允许出现的字符：行尾、空白、`;` `|` `&` `)`（其余 ⇒ 不认，保守） */
const HEREDOC_TAG_TAIL_RE = /[\s;|&)]/

/**
 * 单次判定最多认多少个 heredoc 起始。
 *
 * 超出（`已认数 + 本行起始数 > 上限`）⇒ **本行起始一个都不认**，且此后**不再识别**任何起始
 * ⇒ 少认若干 heredoc ⇒ 少跳过若干终止行（那些行照旧参与判定，只是它们本来也不可能命中——
 * 终止行是单 token，见文件内注释）。已认下且配到终止行的起始照旧记入终止行集合。
 */
export const MAX_HEREDOC_OPS = 64

/**
 * 形状归因时最多回看多少个 token 后缀（`contentRuleOf` 的窗口上限）。
 *
 * 为什么要有上限：从**每个** token 后缀起求值规则表是 O(n²)，对抗性输入（`sudo ` 重复
 * 几十万次）会把单次判定从毫秒级推到秒级 —— 危险门跑在**授权决策的关键路径**上，必须封顶。
 *
 * 语义（与本文件其它预算一致，方向只允许「更保守」）：
 * - `tokens.length <= 上限` ⇒ 与不设上限**逐字相同**（正常输入零退化，真实包装链从不超过
 *   几十个 token）；
 * - 超出上限 ⇒ 只回看**最后** `上限` 个 token（真命令通常就在末尾）。回看窗口变小**只会**
 *   让归因退回形状规则名（`wrapper-nesting` / `shell-nesting`），**绝不会**判 `null`、
 *   绝不会放行 —— 形状规则本身就是保守转交互。
 */
export const MAX_ATTRIBUTION_TOKENS = 256

/**
 * `#` 是否位于**词首**（shell 注释起点）：行首，或前一个字符是空白 / `;|&()<>`。
 * `foo#bar` 里的 `#` 是词的一部分，不是注释。
 */
function isCommentStart(line, i) {
  if (i === 0) return true
  return /[\s;|&()<>]/.test(line[i - 1])
}

/**
 * **旧口径**切分器（0.7.13 的引号语义）：换行在引号内**不**切段 —— 未闭合的引号会一路吞并后续
 * 文本。只用于 `matchText` 的**兜底那一遍**，目的只有一个：保证「0.7.13 会命中的形态」永不变成
 * MISS。引号跨行错配时两种切法给出不同的段：`sh -c "true` ⏎ `sh -c "true; rm -rf /tmp/x` 里
 * 旧口径把两个引号配成一对、`;` 才切段 ⇒ 第二段就是 `rm -rf /tmp/x`（命中）；新口径按换行切 ⇒
 * 第二段被未闭合引号吞掉 ⇒ 会漏。新口径是**更严**的方向（多切多判），但不能以漏掉旧命中为代价。
 */
function splitSubCommandsQuoted(text) {
  const segments = []
  let buffer = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buffer += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i += 1
      segments.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  segments.push(buffer)
  return segments
}

/** `<<` 之前**跳过空白**看到的那个字符的下标（用于算术左移判据 `1 << n`）；没有则 -1 */
function prevNonSpaceAt(line, i) {
  for (let at = i - 1; at >= 0; at -= 1) {
    if (line[at] !== ' ' && line[at] !== '\t') return at
  }
  return -1
}

/**
 * `$(( … ))` / `(( … ))` 的收尾下标：**算术上下文里没有命令、也不可能有 heredoc**
 * （`<<` 在那里只能是左移）。返回跳过后的下标；本行找不到配平的 `)` 时返回本行长度
 * （保守：宁可少认 heredoc —— 少认只会多弹，把左移认成 heredoc 才会吞掉真命令）。
 * @param {string} line
 * @param {number} at 第一个 `(` 的下标（`$((` 传**第二个** `(`）
 */
function arithmeticEnd(line, at) {
  let depth = 0
  for (let i = at; i < line.length; i += 1) {
    if (line[i] === '(') depth += 1
    else if (line[i] === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return line.length
}

/**
 * `<<` 是不是**算术左移**（`$((1<<n))`、`1 << n`）而不是 heredoc 操作符。
 *
 * 判据 =「左操作数的尾巴」：前一个非空白字符是 `)` / `]`，或是一个**独立操作数**的数字。
 * 后者要再看数字前面是什么 —— `-p1 <<EOF`、`head -1 <<EOF` 里的 `1` 是**选项的一部分**
 * （前面是字母/数字/`_`/`-`/`.`），不是被左移的操作数；真左移的数字前面是
 * 空白 / `(` / `=` / 行首（`1 << n`、`$((1<<n))`、`x=1<<n`）。
 *
 * 方向：**漏判左移 = 放行方向** —— 把 `cat out.$((a << n))` 这类左移认成 heredoc（tag=`n`），
 * 若后面真出现一行 `n`，中间的真命令会被当载荷剥掉。所以数字 / `)` / `]` 这三类必须挡
 * （`arithmeticEnd` 另把整个算术上下文跳过去，覆盖左操作数是变量的形态）。
 */
function isArithmeticShift(line, i) {
  const at = prevNonSpaceAt(line, i)
  if (at < 0) return false
  const prev = line[at]
  if (prev === ')' || prev === ']') return true
  if (!/[0-9]/.test(prev)) return false
  const before = at > 0 ? line[at - 1] : ''
  return !/[A-Za-z0-9_.$-]/.test(before)
}

/**
 * 解析 `<<` / `<<-` 之后的 tag：`EOF`、`'EOF'`、`"EOF"`、`\EOF` 四种写法，tag 前允许
 * 空格/TAB（`<< EOF` **必须认** —— 用户报的最短复发路径）。
 * @param {string} line
 * @param {number} from `<<` 之后的下标
 * @returns {{tag: string, dash: boolean, end: number}|null} `end` 是 tag 之后的下标
 */
function parseHeredocTag(line, from) {
  let at = from
  let dash = false
  if (line[at] === '-') { dash = true; at += 1 }
  while (line[at] === ' ' || line[at] === '\t') at += 1
  if (line[at] === '\\') at += 1 // `<<\EOF`：tag 被反斜杠转义
  const quote = line[at]
  let tag = ''
  let end = at
  if (quote === "'" || quote === '"') {
    const close = line.indexOf(quote, at + 1)
    if (close < 0) return null
    tag = line.slice(at + 1, close)
    end = close + 1
  } else {
    const m = HEREDOC_TAG_CANDIDATE_RE.exec(line.slice(at))
    if (!m) return null
    tag = m[0]
    end = at + tag.length
  }
  if (!HEREDOC_TAG_RE.test(tag)) return null
  // tag 之后必须是行尾 / 空白 / `;|&)`：`<<a/b`、`<<EOF>f` 这类不认（保守；认宽了会
  // 吞掉本行后面的真命令）
  const after = line[end]
  if (after !== undefined && !HEREDOC_TAG_TAIL_RE.test(after)) return null
  return { tag, dash, end }
}

/**
 * 扫一**行**里不在引号/注释内的 heredoc 起始。
 * 引号状态由调用方跨行携带（载荷行不参与引号跟踪 —— heredoc 正文是**数据**，
 * 里面的引号不影响 shell 解析）。
 * @returns {{ops: Array<{tag: string, dash: boolean, at: number}>, quote: string}}
 */
function scanHeredocOpeners(line, quote) {
  const ops = []
  let q = quote
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (q) {
      if (ch === q && line[i - 1] !== '\\') q = ''
      continue
    }
    // 引号体跳过：语义上引号里的 `<<` 不是操作符。若在这里认成 heredoc，后面的行会被
    // 标成载荷 ⇒ **形状判据不再看它们**（放行方向），故必须挡住。
    // （跨行未闭合引号另由 `matchText` 自身的引号吞并兜住，0.7.10 同。）
    if (ch === '"' || ch === "'") { q = ch; continue }
    // 注释：本行剩下部分不是命令（`echo hi # <<EOF` 不是 heredoc —— 认成 heredoc 会
    // 把后面几行真命令一起吞掉，是**放行**方向，必须挡住）
    if (ch === '#' && isCommentStart(line, i)) break
    // 算术上下文里没有命令、也不可能有 heredoc（`<<` 在那里只能是左移）⇒ 整段跳过。
    // 覆盖 `$(( … ))`、`(( … ))`、`for (( … ))` 头、`$( (( … )) )` 命令替换。
    // 跳过**多**了只会少认 heredoc（= 多弹，安全方向）；跳过少了才会把左移认成 heredoc、
    // 吞掉后面的真命令（**放行方向**，见 isArithmeticShift 与终审第 1 类 fail-open）。
    if (ch === '(' && line[i + 1] === '(') {
      i = arithmeticEnd(line, i) - 1
      continue
    }
    if (ch !== '<' || line[i + 1] !== '<') continue
    // `<<<` here-string：正文在**本行**，不是载荷
    if (line[i + 2] === '<') { i += 2; continue }
    // `\<<`：被转义，不是 heredoc 操作符
    if (line[i - 1] === '\\') { i += 1; continue }
    // 算术左移：`x=$((1<<n))`、`1 << n`（前一个非空白字符是数字 / `)` / `]`）
    if (isArithmeticShift(line, i)) { i += 1; continue }
    const parsed = parseHeredocTag(line, i + 2)
    if (!parsed) { i += 1; continue }
    ops.push({ tag: parsed.tag, dash: parsed.dash, at: i })
    i = parsed.end - 1
  }
  return { ops, quote: q }
}

/**
 * 该行是否是这个 heredoc 的终止行：`<<-` 形态允许前导 **TAB**（bash 语义），
 * 行尾的 `\r`（CRLF 文本）一律忽略；其余形态必须**整行就是 tag** —— 尾随空白 / 额外命令
 * 都不算。
 *
 * 方向：这里对齐 shell 语义，而不是「宁严勿宽」——认**宽**（提前结束）只会让那一行照旧参与
 * 判定（多弹方向）；认**严**才会漏掉终止行。CRLF 的 `\r?` 就是按这个方向加的。
 */
function isHeredocTerminator(line, op) {
  const body = (op.dash ? line.replace(/^\t+/, '') : line).replace(/\r$/, '')
  return body === op.tag
}

/**
 * **终止行集合**：本段命令文本里「整行恰好是某个已开启 heredoc 的 tag」的行号（0 起）。
 *
 * 语法上这些行不是命令（它们是 heredoc 的定界符），`matchText` 据此跳过它们。
 * 该豁免对现有 7 条规则**可证明无观测差异**（终止行是单 token，见文件内注释）—— 保留它是
 * 为了语法正确与 CRLF 文本（`<<'EOF'\r\n…EOF`）的识别，**不声称它有牙**。
 *
 * 只有「配到了终止行」的起始才产生终止行：找不到终止行的起始**不猜结尾**（其后的行照旧
 * 参与判定 —— 多弹方向）。
 *
 * @param {string} text shell 正文
 * @returns {Set<number>} 终止行行号；没有 `<<` 或一个都没配到时返回空集合
 */
export function heredocTerminatorLines(text) {
  if (typeof text !== 'string' || !text.includes('<<')) return new Set()
  const lines = text.split('\n')
  const terminated = new Set()
  const queue = [] // 已认下、正在等终止行的起始（一行可有多个 ⇒ 按行内顺序配对）
  let quote = ''
  let ops = 0
  let budgetUsed = false
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (queue.length > 0) {
      // 载荷行：不参与引号跟踪、不参与起始识别（载荷是数据），只在终止行处收尾
      if (isHeredocTerminator(line, queue[0])) {
        terminated.add(idx)
        queue.shift()
      }
      continue
    }
    if (budgetUsed) continue
    const scanned = scanHeredocOpeners(line, quote)
    quote = scanned.quote
    if (scanned.ops.length === 0) continue
    // 超预算：本行的起始一个都不认，且此后不再识别（少认 ⇒ 少跳过终止行，多弹方向）
    if (ops + scanned.ops.length > MAX_HEREDOC_OPS) { budgetUsed = true; continue }
    ops += scanned.ops.length
    for (const op of scanned.ops) queue.push(op)
  }
  return terminated
}

/**
 * 折叠空白切 token、跳过前导环境变量赋值。
 * **保留原大小写**：`-c '<body>'` 解包装后正文会被原样再喂给同一份规则，
 * 小写化会污染留痕里的那段命令（判定侧各自按小写比对，见 basenameOf/subCommandVerb）。
 */
function tokenizeSegment(segment) {
  const raw = segment.trim().split(/\s+/).filter(Boolean)
  let start = 0
  while (start < raw.length && ENV_ASSIGNMENT.test(raw[start])) start += 1
  return raw.slice(start)
}

/**
 * 形状归因前的**内容规则求值**（v0.7.13 · 终审 B-1）。
 *
 * 只在两条形状分支里用：`unwrapTransparentWrappers` 预算用尽、shell 展开深度用尽 ——
 * 这两处段首仍是包装器/`sh -c`，规则表按段首取值看不到后面的真命令，于是形状规则会先归因，
 * 0.7.12 又被「载荷豁免」吞掉 ⇒ 判 `null`（静默放行）。
 *
 * 现在从**每个 token 后缀**起求值内容规则（`rm -rf` / `git push` / `npm publish` /
 * `pnpm publish` / `yarn publish`），命中即返回该规则 id；没有命中才落回形状规则。
 * 纯词法判定、无递归成本；**只在形状分支里做** —— 正常路径仍只看段首，`echo rm -rf x`
 * 这类「把命令当参数打印」的写法不会被误伤。
 *
 * **后缀窗口上限**（`MAX_ATTRIBUTION_TOKENS`，终审 Minor-1 的性能回归修复）：token 数超过上限
 * 时只回看最后 `上限` 个 token —— 把 O(n²) 封顶，且窗口变小只会让步归因退回形状规则名，
 * **不会**判 `null`（形状规则照旧保守转交互）。
 *
 * @param {string[]} tokens 该段（剥完包装后段首仍是包装器）的 token 序列
 * @returns {string|null} 命中的内容规则 id
 */
function contentRuleOf(tokens) {
  const window = tokens.length > MAX_ATTRIBUTION_TOKENS ? tokens.slice(-MAX_ATTRIBUTION_TOKENS) : tokens
  for (let start = 0; start < window.length; start += 1) {
    const slice = window.slice(start)
    for (const rule of RULES) {
      if (rule.match(slice)) return rule.id
    }
  }
  return null
}

/**
 * 单段子命令判定。包装/引号是**文本级**结构，剥完再交给规则 —— 规则只该看到
 * 「真正的程序名 + 它的参数」这一层。
 * @param {string} segment
 * @param {number} depth 已经解开过几层 shell 包装
 * @returns {{rule: string, segment: string}|null}
 */
function matchSegment(segment, depth) {
  const unwrapped = unwrapTransparentWrappers(tokenizeSegment(segment))
  // 跳数用尽而头部仍是包装器（`sudo×9 rm -rf x`）：**可疑** ⇒ 保守转交互。
  // 落回规则表会判 null ⇒ 门整档关闭 ⇒ 会话级工具名授权静默放行（Minor-1）。
  // v0.7.13（终审 B-1）：返回形状规则**之前**先求值内容规则 —— 归因必须是 `rm -rf`，
  // 而且**绝不能**因为「形状规则会被载荷豁免」把这段判成 null（那是静默放行）。
  if (unwrapped.nesting) {
    return { rule: contentRuleOf(unwrapped.tokens) || WRAPPER_DEPTH_RULE, segment: segment.trim().slice(0, 200) }
  }
  const tokens = unwrapped.tokens
  if (tokens.length === 0) return null
  if (SHELL_WRAPPERS.has(basenameOf(tokens[0]))) {
    const { glued, restAt } = shellBody(tokens)
    if (restAt >= 0) {
      if (depth >= MAX_SHELL_UNWRAP_DEPTH) {
        // 第 3 层起不再展开：**可疑**（保守转交互），不做无限展开。
        // v0.7.13（终审 B-1）：同样先求值内容规则再归因 —— 三层 `sh -c` 包着 `rm -rf`
        // 时留痕理由应是 `rm -rf`，且判 null 的路径必须彻底消失。
        return { rule: contentRuleOf(tokens) || SHELL_DEPTH_RULE, segment: segment.trim().slice(0, 200) }
      }
      // 粘连写法（`-c'rm -rf x'` 会被空白切成 `-c'rm` + `-rf` + `/x'`）要把两边拼回来
      const bodyRaw = glued ? `${glued} ${tokens.slice(restAt).join(' ')}` : tokens.slice(restAt).join(' ')
      const body = stripOuterQuotes(bodyRaw).replace(/\\(["'\\])/g, '$1')
      const inner = body ? matchText(body, depth + 1) : null
      // 规则用内层命中的那条；留痕用**外层**那段（排障时要看到 `bash -c` 包装本身）
      return inner ? { rule: inner.rule, segment: segment.trim().slice(0, 200) } : null
    }
  }
  for (const rule of RULES) {
    if (rule.match(tokens)) return { rule: rule.id, segment: segment.trim().slice(0, 200) }
  }
  return null
}

/**
 * 把指定行号的**整行内容**清空（换行符保留 ⇒ 其它行的相对位置与引号状态都不变）。
 * 只用于跳过 heredoc 终止行：清空后该行成为空段（没有任何 token ⇒ 判 `null`）。
 */
function blankOutLines(text, indexes) {
  const lines = text.split('\n')
  for (const idx of indexes) {
    if (idx >= 0 && idx < lines.length) lines[idx] = ''
  }
  return lines.join('\n')
}

/**
 * 位置 `i` 上的 `\` 是否**未被转义**（前面连续反斜杠个数为**偶数**）。
 * `git \` ⏎ ⇒ true（续行）；`git \\` ⏎ ⇒ false（`\\` 是转义的反斜杠，换行仍是分隔符）。
 */
function isUnescapedBackslashAt(text, i) {
  let n = 0
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) n += 1
  return n % 2 === 0
}

/**
 * 判定前的**文本规范化**（v0.7.14 · 用户裁定：保守策略，不做按 flag 的解析）。顺序固定，
 * 在**切段之前**跑（`matchText` 对递归进来的 `-c` 正文同样会跑一遍）：
 *
 *   ① **行尾未转义的 `\`**（后面可带行尾空白 / CR）= shell 续行 ⇒ 删掉 `\` 与行尾空白/CR/换行，
 *      与下一行**直接拼接**（`git \` ⏎ `push origin main` → `git push origin main`、
 *      `rm \` ⏎ `-rf /tmp/x` → `rm -rf /tmp/x`）。**行尾 `\` 后带空格**、**CRLF** 都算续行
 *      （**不与 shell 等价，方向只多不少**：真 shell 里 `\ ` 是**转义空格**，`rm \ ` ⏎ `-rf /tmp/x`
 *      实际是两个命令 —— `rm␠`（带尾空格的词，不是 `rm`）与下一行的 `-rf` ⇒ **不会**执行 `rm -rf`；
 *      本层按续行拼接后照样**多弹一次**。用户裁定接受这种保守偏差，别把它读成"与 shell 等价"。）；
 *      `git \\` ⏎（转义的反斜杠）**不是**续行，不要顺手并掉；
 *   ② **换行形态一律是「段分隔符」**（**不折成空格**）：**真实 `\n` / CRLF / 裸 CR**，以及文本里
 *      的**字面** `\n` / `\r` 两字符序列（在 Python/Node 之类消费者那里它就是真换行；折成空格
 *      等于把危险命令藏进同一段）。**字面 `\t`** 只折成**一个空格**（不切段）；
 *   ③ **连续空白折叠成单个空格**（空格 / TAB / 残留 CR / 残留 LF）⇒ `rm  -rf` / `git<TAB>push`
 *      这类「靠多余空白规避」的写法失效。
 *
 * **为什么换行不折成空格（安全方向，用户裁定 + 已报备）**：折成空格会抹平**行首/段首**语义 ——
 * `git add -A` ⏎ `git commit -m x` ⏎ `git push origin main` 这类多行脚本、`echo hi` ⏎
 * `rm -rf /tmp/x`（**实测**：不折空格时第二行独立成段 ⇒ 命中；折成空格后合成一段
 * `echo hi rm -rf /tmp/x`、段首是 `echo` ⇒ **按段判定**变 MISS）—— 那是**变松**，与「不许变松」的
 * 硬约束直接冲突。（v0.7.15 的**全文判定**会另外把含危险字样的文本兜住，但那是**另一层**兜底，
 * 不能用来给"折空格"背书：折空格丢掉的是段首语义，段判定与形状判据都会一起失明。）
 * 换行仍按 shell 语义交给 `splitSubCommands` 切段（**引号里也切**并重置引号状态）。
 * 本函数**只做文本层**处理：不解析 `-c` / `-Command` 这类 flag、不解释引号结构。
 *
 * 只作用于**判定用文本**，不改写调用方拿到的原文。
 * @param {string} text shell 正文
 * @returns {string} 规范化后的判定文本（无 `\`/裸 CR/多空白时原样返回）
 */
export function normalizeCommandText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  // 快路径：没有 `\`、没有裸 CR、没有多空格/TAB ⇒ 无可规范化
  if (!text.includes('\\') && !text.includes('\r') && !/ {2}|\t/.test(text)) return text
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') { out += '\n'; continue } // 真实换行 = 段分隔符（见上方说明）
    if (ch === '\r') {
      // 裸 CR / CRLF 的 CR 同样是**段分隔符**（用户裁定：换行形态一律切段，不折成空格）
      out += '\n'
      if (text[i + 1] === '\n') i += 1 // CRLF 只算一个分隔符
      continue
    }
    if (ch === ' ' || ch === '\t') {
      // ③ 连续空白折叠；段首/换行之后的空白不产生前导空格
      if (out.length > 0 && out[out.length - 1] !== ' ' && out[out.length - 1] !== '\n') out += ' '
      continue
    }
    if (ch !== '\\') { out += ch; continue }
    const next = text[i + 1]
    if (next === 'n' || next === 'r' || next === 't') {
      // ② 字面转义序列（两字符）：`\n` / `\r` ⇒ **段分隔符**（在 Python/Node 之类消费者那里它就是
      // 真换行；折成空格等于把危险命令藏进同一段 —— 那正是要堵的方向）；`\t` ⇒ **一个空格**（不切段）
      if (next === 't') {
        if (out.length > 0 && out[out.length - 1] !== ' ' && out[out.length - 1] !== '\n') out += ' '
      } else {
        out += '\n'
      }
      i += 1
      continue
    }
    if (!isUnescapedBackslashAt(text, i)) { out += ch; continue }
    // ① 续行：`\` 后面只允许行尾空白/CR，然后是换行（或文本结束）
    let j = i + 1
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j += 1
    if (j >= text.length) continue // 行尾孤立的反斜杠：丢掉（它不构成命令）
    if (text[j] === '\n') { i = j; continue }
    out += ch
  }
  return out
}

/**
 * 逐段判定（规范化后的文本，**不加**双读；深度由 depth 携带）。
 *
 * v0.7.13：**每一行都参与判定** —— 没有掩码、没有载荷豁免；内容规则与形状规则一视同仁。
 * 唯一按语法跳过的是 **heredoc 终止行**（`heredocTerminatorLines`：整行恰好是某个已开启
 * heredoc 的 tag，它不是命令；该豁免对现有规则无观测差异，见文件内注释）。
 */
function judgeSegments(text, depth, splitter = splitSubCommands) {
  const terminators = heredocTerminatorLines(text)
  const judgeable = terminators.size > 0 ? blankOutLines(text, terminators) : text
  for (const segment of splitter(judgeable)) {
    const hit = matchSegment(segment, depth)
    if (hit) return hit
  }
  return null
}

/**
 * 逐段判定的入口（`dangerousExecuteMatch` 的递归实现，深度由 depth 携带）。
 *
 * v0.7.14（用户裁定）：判定文本先过 `normalizeCommandText`（续行拼接 / 换行转义折成空格 /
 * 折叠连续空白）**再切段** —— **切段与判定用的是同一份规范化文本**，递归进来的 `-c` 正文同理。
 *
 * **不许变松（多遍兜底）**：归一化与「换行在引号内也切段」都只会让判定更严，但都**不能以漏掉旧
 * 命中为代价**：
 *   ① 先判**规范化文本**（新口径切段）—— 续行/转义/多空白还原后更容易被看见；
 *   ② 规范化真的改动了文本时，再判一遍**原文**（新口径）—— 合并可能把段首从包装器/形状变成
 *      普通命令（例：`echo hi \` ⏎ `sh -c 'sh -c "sh -c ls"'` 合并后段首是 `echo`，原文那一遍兜住）；
 *   ③ 文本里**既有引号又有换行**时再判一遍**原文 + 旧引号口径**（`splitSubCommandsQuoted`）——
 *      引号跨行错配时两种切法给出不同的段（`sh -c "true` ⏎ `sh -c "true; rm -rf /tmp/x` 旧口径命中）。
 * 三遍都只在「更容易命中」的方向上加，任何一遍命中即返回；普通输入（无 `\`/裸 CR/多空白、且无
 * 「引号+换行」）只跑第一遍，零额外代价。
 */
function matchText(text, depth) {
  const normalized = normalizeCommandText(text)
  const hit = judgeSegments(normalized, depth)
  if (hit) return hit
  if (normalized !== text) {
    const raw = judgeSegments(text, depth)
    if (raw) return raw
  }
  if (text.includes('\n') && /["']/.test(text)) {
    const quoted = judgeSegments(text, depth, splitSubCommandsQuoted)
    if (quoted) return quoted
  }
  // v0.7.15（用户裁定）：最后一遍 —— **全文危险词扫描**（配置项 `~/.dsh/data/dsh-danger-patterns.json`，
  // 预设 `rm -rf` / `git push` / `npm publish`）。前面所有遍都不命中时，只要归一化后的整段文本里
  // 任意位置出现危险字样（含"只是提到"）就判高危。**只做加法**：不替代按段判定与形状判据，
  // 也不改变它们的语义 ⇒ 相对 0.7.14 不可能变松（任何一遍命中即返回）。
  return scanDangerPatterns(normalized)
}

/**
 * 这段命令文本里是否含用户裁决必须交互的命令（**词法级**，覆盖边界见文件头）。
 * @param {string|null} text shell 正文
 * @returns {{rule: string, segment: string}|null}
 */
export function dangerousCommandMatch(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  return matchText(text, 0)
}

/**
 * 本次请求是否是"已被工具名授权、但按用户裁决必须继续问"的危险执行命令。
 *
 * 正文取值走 `lib/execute-frame.js` 的共用实现（复审 M-1/M-2 单点化；第三轮复审 B-1
 * 把 `kind` 前置**取消**）。本函数与 `acp.js` 的路径兜底**不是**同一口径，且这是
 * 设计要求：**门宁可多问（本函数，看不看得到命令字段就判），路径宁可少授权
 * （`scanExecuteCommandPaths` 仍要求执行类帧）**——见 `lib/execute-frame.js` 文件头。
 *
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @returns {{rule: string, segment: string, source: string}|null} 命中则给出
 *   规则名、命中的那段命令（截 200 字符）、命令正文的来源字段
 */
export function dangerousExecuteMatch(toolCall) {
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : {}
  const command = executeCommandText(tool)
  if (!command) return null
  const hit = dangerousCommandMatch(command.text)
  if (!hit) return null
  return { rule: hit.rule, segment: hit.segment, source: command.source }
}
