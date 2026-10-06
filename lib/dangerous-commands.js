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
 * - 大小写：命令名与子命令动词按**小写比对**（macOS APFS 默认大小写不敏感卷上
 *   `RM -RF x` 真的会执行 rm）。比对用的是小写副本，不改写任何被记录/展示的原文
 *   （`segment` 留痕仍是原文大小写）。
 * - 前导环境变量赋值会被跳过（`FOO=1 rm -rf x` 仍判危险）。
 * - **不覆盖（诚实的已知边界，不静默漏掉；每条都附第四轮终审实测的本仓结果）**：
 *   · `lerna publish`、`git` 其它破坏性子命令（`git clean -fdx`、`git reset --hard`）
 *     —— 超出用户裁决的名单（实测本仓 `null`，宿主同为 `null`）；
 *   · `python -c 'os.system("rm -rf")'`、`eval "rm -rf /x"`、变量间接（`S=rm; $S -rf x`）、
 *     `sh -c "$(curl …)"` —— 静态不可判定，需要完整 shell 解析器 + 变量求值 + 读文件
 *     （实测本仓 `null`，宿主同为 `null`）；
 *   · `make deploy` / `npm-scripts` 里的自定义 publish —— 把命令写进脚本/构建目标再执行
 *     （实测本仓 `null`，宿主同为 `null`）；
 *   · `bash deploy.sh`（**宿主按 `shell-stdin` 保守转交互**）、
 *     `printf 'rm -rf /x' | bash` 与 `bash <<< 'rm -rf /x'`（`|` 会把两段切开，第二段只剩
 *     `bash` 自己；**宿主同上按 `shell-stdin`**）—— 本仓实测 `null`（边界差异见文件头）；
 *   · `find /tmp -exec rm -rf {} +` / `-execdir`（**宿主判 `rm -rf`**）—— `-exec` 的取值
 *     是"命令 + 参数"，本层只做词法判定、不解析 `-exec` 语法；本仓实测 `null`；
 *   · `coreutils rm -rf x`（**宿主判 `rm -rf`**）、`bash -C rm -rf /x`（**宿主判 `rm -rf`**）
 *     —— 本仓实测 `null`，理由见文件头的边界差异逐条说明；
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
    const t = stripOuterQuotes(tokens[i]).toLowerCase()
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
 * 单引号/双引号内部不切分（`curl 'a=1&rm -rf'` 保持一段）。反斜杠转义引号按"前一个
 * 字符不是 `\\`"粗略处理，够用；未闭合引号会从该处一路保留到结尾（宁可少判一段，
 * 也不把引号内的字面量当命令）。
 */
export function splitSubCommands(text) {
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
  if (unwrapped.nesting) return { rule: WRAPPER_DEPTH_RULE, segment: segment.trim().slice(0, 200) }
  const tokens = unwrapped.tokens
  if (tokens.length === 0) return null
  if (SHELL_WRAPPERS.has(basenameOf(tokens[0]))) {
    const { glued, restAt } = shellBody(tokens)
    if (restAt >= 0) {
      if (depth >= MAX_SHELL_UNWRAP_DEPTH) {
        // 第 3 层起不再展开：**可疑**（保守转交互），不做无限展开
        return { rule: SHELL_DEPTH_RULE, segment: segment.trim().slice(0, 200) }
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

/** 逐段判定（`dangerousExecuteMatch` 的递归实现，深度由 depth 携带） */
function matchText(text, depth) {
  for (const segment of splitSubCommands(text)) {
    const hit = matchSegment(segment, depth)
    if (hit) return hit
  }
  return null
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
