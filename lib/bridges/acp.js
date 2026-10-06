import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { spawnProduct } from '../run.js'
import { acquireSlot, reportRateLimited, reportSuccess } from '../throttle.js'
import { executeCommandText } from '../execute-frame.js'

/** Rate-limit detection: error messages products return when throttled. */
function isRateLimited(error) {
  if (!error) return false
  if (error.code === 'RATE_LIMITED') return true
  const msg = String((error && (error.message || error.error)) || error)
  return /rate\s*limit|too\s*many\s*requests|throttl|\b429\b|quota|限流|频率限制|请求过于频繁/i.test(msg)
}

/**
 * v0.4.0：从 ACP RequestPermission 的 toolCall 中提取涉及的文件路径。
 *
 * v0.7.9（C 项）：**结构化字段优先，文本扫描只作最后兜底**。
 * 旧实现对整个 toolCall 递归 + 正则扫字符串值，于是"被编辑文件的内容里出现的
 * 路径字符串"会被当成请求路径（实测两条授权球原文即由此而来：Edit 某测试文件
 * 时把 diff 正文里的 `/Volumes/proj/inside`、`/Users/arming/Library/Preferences/x.plist`
 * 一并抓进集合）。会话级授权写的是"每条路径的上一级目录"，一条假路径就足以把
 * 一个无关目录写进授权集 → 这不是显示瑕疵，而是正确性前提。
 *
 * v0.7.9 缺口D 把兜底**收口到执行类帧的命令正文**：
 *   · Edit/Write/delete/move 等帧：只认结构化字段（`content[].path` →
 *     `rawInput.file_path`/`rawInput.path` → `locations[].path`），
 *     **绝不**扫 `newText`/`oldText`/`content[].text` 等 diff 正文；
 *   · 执行类帧（`kind` ∈ execute/exec/shell/bash/command；无 `kind` 时看 `name`/`title`）
 *     且结构化一无所获时：只扫**命令正文**（`rawInput.command`，老模型回退
 *     `arguments.command`）——命令正文里的路径**就是**本次请求的客体，
 *     这是它唯一合法的兜底场景（`cat /etc/hosts` 的请求对象确实是 /etc/hosts）。
 *     `kind` 明确是非执行类时一票否决，即便夹带 command 字段也不扫。
 *   · 其它帧结构化一无所获 ⇒ 返回空集（宁可少一条路径去弹窗，也不写一条假授权）。
 *
 *   ⚠️ 本函数的产物是**唯一**能**自动**变成规则的路径集合（另一条是用户在弹框里
 *   改过/删过后经决议载荷 `paths` 通道的**显式**回传）。文本推测的结果走的是另一条
 *   只用于预填展示的通道（`scanPathsLoose` → `permission-pending` 的 `inferredDirs`），
 *   **不得**把它们的值并进本函数。
 *
 *   ⚠️ 第三轮复审 B-1 的**有意不对称**：危险命令门（`lib/dangerous-commands.js`）已与
 *   `kind` **解耦**（看得到命令字段就多问一次 —— 门宁可多问），而**本函数相反**：
 *   `kind` 明确非执行类即一票否决，哪怕夹带 `command` 字段也不扫（路径宁可少授权）。
 *   原因是本函数的产物会**自动**变成规则，放宽即 fail-open。改任何一侧前先读
 *   `lib/execute-frame.js` 文件头那段「门宁可多问，路径宁可少授权」。
 *
 * 结构化来源清单（有任一命中即以结构化结果为准）：
 *   ① `content[].path`（ACP diff 块的目标文件——Edit/Write 的**真身**）
 *   ② locations[].{path,uri,file}（opencode 系实测；ACP 规范里 `locations` 是
 *      "本调用触碰的文件位置"，语义正确，故**保留**。qoder 目前不填它，保留无害。
 *      限制：它是**来源之一**，不得作为唯一来源，更不得因为"要喂 locations"而
 *      恢复对正文的文本扫描——见 `test/extract-paths.test.js`）
 *   ③ rawInput / arguments 里键名即路径字段的结构化值（qoder/Claude 系 file_path、
 *      notebook_path、dir_path…；camelCase 与 snake_case 同等对待）
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @returns {string[]} 提取到的路径（去重、保序）
 */
export function extractPaths(toolCall) {
  const structured = extractStructuredPaths(toolCall)
  if (structured.length > 0) return structured
  return scanExecuteCommandPaths(toolCall)
}

/**
 * 路径兜底只认**命令字段**这两个来源（`rawInput.command` → `arguments.command`）。
 * 刻意**不含** `content[].content.text` 与 `title`：那两条在别的产品里可能是描述
 * 文字，拿它扫路径等于从散文里猜授权路径（正是缺口D 收口掉的面）。
 */
const PATH_SCAN_COMMAND_SOURCES = ['rawInput.command', 'arguments.command']

/**
 * 执行类帧的**命令正文**（兜底扫描的唯一可扫文本）。
 *
 * 执行类判定与取值来源的**单点在 `lib/execute-frame.js`**（复审 M-2）：此前本文件与
 * `lib/dangerous-commands.js` 各持一份口径且已经漂移——`{kind:'edit',
 * rawInput:{command:'rm -rf /tmp/x'}}` 在危险门命中、在这里被一票否决。现在两处共用
 * 同一个 `executeCommandText`，本调用点只是声明「只认哪几个来源」**与哪一档口径**。
 *
 * ⚠️ 第三轮复审 B-1：这里**必须**传 `requireExecuteFrame: true`。危险门已与 `kind`
 * 解耦（门宁可多问），但本函数的产物是**唯一**能自动变成规则的路径集合（路径宁可
 * 少授权）—— 不传这个选项，`{kind:'edit', rawInput:{command:'cat /etc/passwd'}}`
 * 会把命令正文里的 `/etc/passwd` 当成本次请求的客体收进规则集（fail-open）。
 * 这条不对称是**设计要求**，详见 `lib/execute-frame.js` 文件头。
 * **永不**下探 `newText`/`oldText`/`content[].text` 等 diff 正文。
 */
function executeCommandBody(toolCall) {
  const hit = executeCommandText(toolCall, PATH_SCAN_COMMAND_SOURCES, { requireExecuteFrame: true })
  return hit ? hit.text : ''
}

/**
 * v0.7.9 缺口D 兜底扫描的**唯一**入口：执行类帧的命令正文。
 * 命令正文里的路径**就是**本次请求的客体（`cat /etc/hosts` 请求的对象确实是
 * /etc/hosts），这是文本扫描唯一合法的场合。非执行类帧 ⇒ 空集。
 */
export function scanExecuteCommandPaths(toolCall) {
  const command = executeCommandBody(toolCall)
  if (!command) return []
  const out = new Set()
  for (const m of command.matchAll(PATH_TOKEN_RE)) out.add(m[0].replace(/[,;:)\]}>，。；]+$/, ''))
  return [...out]
}

/**
 * 从一段文本里扫绝对路径 token。v0.7.9 起匹配在分号/中文标点处即断：旧写法一路吃到
 * 下一个空白，于是"写入 /tmp/proj/a.txt；cwd 是 …"会产出一条 `/tmp/proj/a.txt；cwd`
 * 的脏 token——它匹配不上任何规则，却会被"取上一级目录"写进会话授权集。
 */
const PATH_TOKEN_RE = /(~|\/Users\/|\/Volumes\/|\/tmp\/|\/private\/|\/home\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|\/workspace\/|\/workspaces\/)[^\s"'`;；，。、：:]+/g

/**
 * 结构化路径字段读取：**只认键名，不扫值文本**。
 * 键名判定 = 把 camelCase 折成 snake_case 后小写，再比对白名单——旧写法
 * `/(^|_)(path|file|…)/i` 吃不到 `filePath`（`path` 前面是 `y`，既非串首也非 `_`）。
 * 值判定 = 必须以 `/`、`~`、`./`、`../`、盘符或 `file://` 开头（把"说明文字里
 * 夹了个路径"这类散文 blob 挡掉），且不含换行。
 */
export function extractStructuredPaths(toolCall) {
  const out = new Set()
  const PATH_KEYS = new Set([
    'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'notebook_path',
    'absolute_path', 'target_file', 'target_path', 'target',
    'dir', 'dirs', 'dir_path', 'directory', 'directories',
    'dest', 'destination', 'src', 'source', 'uri', 'location', 'locations',
    // ↑ v0.7.9 裁定**保留** `location`/`locations`：ACP 规范里 `locations` 就是
    //   "本调用触碰的文件位置"，语义正确；qoder 目前不填，保留无害。
    //   限制（写进 CHANGELOG）：它是**结构化来源之一**，不得作为唯一来源，
    //   更不得因为"要保证 locations 有值可填"而恢复对 diff 正文的文本扫描。
  ])
  const accept = (raw) => {
    if (typeof raw !== 'string') return null
    let p = raw.trim()
    if (!p || /[\r\n]/.test(p)) return null
    if (/^file:\/\//i.test(p)) {
      // file:// 是路径的另一种写法；其它 scheme（http/https/data…）不是文件路径
      try { p = decodeURIComponent(new URL(p).pathname) } catch { return null }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null
    if (!/^(\/|~[\\/]|[.]{1,2}[\\/]|[A-Za-z]:[\\/])/.test(p)) return null
    return p.replace(/[\\]+$/, '') || p
  }
  const keyIsPath = (key) => PATH_KEYS.has(String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
  /**
   * v0.7.9（复审 B-1）：**JSON 下钻只允许容器键**。
   *
   * 旧实现对**任意**字符串值做 `JSON.parse` 再下钻。于是当**被编辑文件的正文本身是
   * JSON**（改 `*.json` 配置是常态）时，正文里 `path`/`dest`/`src`/`file_path` 这类
   * 键值会被当成**结构化路径**收进本函数的产物——而本函数的产物是**唯一**能**自动**
   * 变成规则的路径集合（见 `extractPaths` 的 ⚠️）。现场：编辑 `a.json`、正文
   * `{"dest":"~/.ssh"}` ⇒ 会话授权里多出 `~/.ssh`，此后同会话对该目录的请求被静默放行。
   *
   * 现在只有**承载工具参数的容器键**才允许 JSON 下钻（当前确证需要的是 `arguments`：
   * 老模型把参数以 JSON 字符串下发；观察到的其它形状都不是 JSON 字符串）。
   * 正文（`newText`/`oldText`/`new_string`/`old_string`/`text`）里的 JSON **一律不下钻**。
   * 将来若确证某产品把 `rawInput` 也以 JSON 字符串下发，把键名加进本集合即可——**不要**
   * 退回"任意字符串都 try JSON.parse"。
   */
  const CONTAINER_KEYS = new Set(['arguments'])
  /**
   * 正文字段（**一律不参与结构化提取**：不下钻、不取值、不递归）：
   *   · `newText` / `oldText`       —— ACP diff 块的新旧正文
   *   · `new_string` / `old_string` —— Claude/Codex 系 Edit 的新旧正文
   *   · `text`                      —— `content[].content.text` 的内容正文
   *   · `body` / `content`          —— 工具参数里"文件正文/请求体"的常见键名
   * 这些键装的是**被编辑的内容**，不是本次请求的客体：仓库里任何文件都可以写着
   * `/etc/passwd`、`~/.ssh/id_rsa`。
   *
   * ⚠️ 第三轮复审 Major-1：本集合**只是给「已知正文键」留一句显式说明**，真正的
   * 机制是下面的**递归白名单**（`STRUCTURAL_KEYS` + `PATH_KEYS`）——旧实现把
   * 「按键名剪枝」当机制（值若是对象/数组照常下钻），于是 `body: {dest:'~/.ssh'}`、
   * `edits: [{path:'/etc/passwd'}]`、`content: {path:'/etc/passwd'}` 这些**形状**都能
   * 绕过去，把正文里的路径收进唯一能自动变成规则的集合。详见 `walk` 上方那段。
   *
   * 注意 `content` **不在** `STRUCTURAL_KEYS` 里（该集合只有 `rawInput`/`arguments`，见上面那行
   * `new Set(['rawInput','arguments'])`）：它由 `walk` 的**独立分支**处理（`k === 'content' ||
   * 'locations'`：只认 toolCall 顶层 + 形状合格，命中即 `continue`）⇒ 本集合对它不生效（旧注释称"同时出现在 `STRUCTURAL_KEYS` 里"，不属实）。
   */
  const BODY_KEYS = new Set(['newText', 'oldText', 'new_text', 'old_text', 'new_string', 'old_string', 'text', 'body'])
  /**
   * **递归白名单**（第三轮复审 Major-1 的修法）：只有这几个**结构键**才允许继续下钻，
   * 其余键一律视为**数据**、整棵剪掉。
   *
   * 与旧实现（黑名单剪枝）的差别，用一个形状就能看清：
   * `{kind:'edit', rawInput:{file_path:'/p/a.json', body:{dest:'~/.ssh'}}}` ——
   * `body` 不在旧黑名单里，于是 `walk` 照常下钻、命中 `PATH_KEYS` 的 `dest`
   * ⇒ `~/.ssh` 进了产物（终审探针 `b1extract.mjs` 的 F 组四条：`rawInput.content`
   * 为对象 ⇒ `["/p/a.json","/etc/passwd"]`、`arguments.content` 为对象 ⇒ 同样、
   * `rawInput.body` 为对象 ⇒ `["/p/a.json","~/.ssh"]`、`rawInput.edits[]` 内层对象
   * ⇒ `["/p/a.json","/etc/passwd"]`）。白名单下这四条全部只剩真目标。
   *
   * 键的职责分工（**只认键名，不扫值文本**）：
   *   · `STRUCTURAL_KEYS` —— 唯一允许"继续往里走"的键：`rawInput`/`arguments`
   *     （工具参数信封，ACP 里就这两个）。
   *   · `content` / `locations` —— **只认 toolCall 顶层 + 形状合格**的那一个（见下）。
   *   · `PATH_KEYS` —— 键名即路径字段：**取值**（字符串 / 字符串数组 / 该层的
   *     `path`/`file`/`uri` 等），但**不下钻**该值内部的任意结构（见 `walk` 说明）。
   *   · 其余键（含 `_meta`）—— 数据，整棵剪掉。
   *
   * ## ⚠️ v0.7.9（第四轮终审**阻断**）：块形状判定 + "只认顶层"两条一起才是关的
   *
   * 第三轮的"有 `type` 字段就是 ACP 块"被判为**过宽**：被编辑文件的正文本身可以是
   * JSON 对象，`{type:'module', path:'/etc/passwd'}` / `[{type:'object', path:'…'}]`
   * 于是被当成块、`walk` 照常下钻、正文里的 `path` 进了产物。修法三条：
   *
   *   ① **块形状按 type 白名单判**（`ACP_BLOCK_TYPES`，ACP 规范是封闭集合），
   *      不再"有 `type` 字段就是块"；
   *   ② **块数组资格只给 toolCall 顶层** 的 `content`/`locations`：**只有这两个顶层
   *      键下的块内路径会被收集**；`rawInput.*` / `arguments.*` 下的**一切同名键**
   *      （含 `rawInput.content`、`rawInput.locations`，也含 `rawInput.files[].content`、
   *      `rawInput.paths[].content`、`rawInput.dest[].content` 这类**任何** PATH_KEYS
   *      数组元素的 `content`）都是**工具参数正文**，一律当数据剪掉（既不下钻、也不取值）；
   *   ③ 块内**不再**下钻同名键（`content[].content` / `locations[].content` 是块/位置项
   *      自己的内容，不是本次请求的客体）。
   *
   * 三条各堵一个已复现的入口，缺一即漏（对应用例见 test/extract-paths.test.js 的
   * 「第四轮终审阻断」describe，把任一条改回去都转红）。
   */
  const STRUCTURAL_KEYS = new Set(['rawInput', 'arguments'])
  /**
   * ACP 内容块的 **type 取值白名单**（`ContentBlock` ∪ `ToolCallContent`，规范里是封闭集合）。
   *
   * **不得**退化成"有 `type` 字段就是块"（第四轮终审阻断的根因）：正文对象只要带个
   * `type`（哪怕值是 `'module'`/`'object'`）就会被当块下钻，正文里的 `path`/`dest`
   * 随之进产物 —— 而产物是**唯一**能自动变成规则的路径集合。
   *   · `content: [{type:'diff', path:'/proj/a.ts', newText:'…'}]` ⇒ 是块 ⇒ 取块内路径
   *     （这是 Edit 帧目标文件的**主来源**，必须保住）；
   *   · `rawInput.content: {type:'module', path:'/etc/passwd'}` ⇒ 类型不在名单 ⇒ 不是块
   *     ⇒ 当**数据剪掉**（第四轮终审阻断探针的期望）。
   */
  const ACP_BLOCK_TYPES = new Set([
    // ContentBlock（requestPermission 的 content[] 用这套）
    'text', 'image', 'audio', 'resource_link', 'resource',
    // ToolCallContent（工具调用内容：diff 块是 Edit 帧目标文件的主来源）
    'diff', 'content', 'terminal',
  ])
  const isContentBlock = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    && typeof readOwn(v, 'type') === 'string'
    && ACP_BLOCK_TYPES.has(String(readOwn(v, 'type')).trim().toLowerCase())
  /**
   * **块数组判定（唯一一份谓词）**：`content` 那支与 `PATH_KEYS` 数组分支共用它。
   *
   * `contentBlockItems(v)` ⇒ 真正的 ACP 内容块列表（单项对象或数组两种形状都认）；
   * 不是块形状（无 `type` / `type` 不在名单 / 字符串 / 数字 / 任意无名对象）⇒ `null`。
   * 这一份谓词就是"路径偷渡"的口子所在：`files:[{content:{path:'/etc/passwd'}}]`
   * 当初沿 `hasOwn(item,'content')` 一路下钻，正是因为那一支**没有**这张判定。
   */
  const contentBlockItems = (v) => {
    if (isContentBlock(v)) return [v]
    if (Array.isArray(v)) {
      const hit = v.filter(isContentBlock)
      return hit.length > 0 ? hit : null
    }
    return null
  }
  /**
   * `locations` 的合法形状（ACP `ToolCallLocation[]`）：**数组**，元素是位置块
   * （`{path, line?}`；本仓额外接受 `uri`/`file`/`filePath`/`file_path` 与纯字符串——
   * opencode 系实测形态，见文件头）。
   *
   * 与 `content` **同一处**做形状判定（第四轮终审 Minor-2 的统一口径）：单个对象不是
   * ACP 形状（`locations:{path:'/etc/passwd'}` 曾被 `PATH_KEYS` 那一支直接取值），
   * 非数组 / 空数组一律当数据剪掉。
   */
  const isLocationItem = (v) => (typeof v === 'string' && v.trim().length > 0)
    || (!!v && typeof v === 'object' && !Array.isArray(v)
      && ['path', 'file', 'uri', 'filePath', 'file_path'].some((k) => hasOwn(v, k)))
  const locationItems = (v) => (Array.isArray(v) && v.length > 0 && v.every(isLocationItem) ? v : null)
  /**
   * v0.7.9（第五轮终审 Major-1 + 第六轮裁定）：**`path` 只对 `diff` 块成立**。
   *
   * ACP 里只有 `diff`（`ToolCallContent::Diff`）带 `path` —— 规范里**唯一**有这个字段的
   * 变体；`text`/`image`/`audio`/`resource_link`/`resource`/`content`/`terminal` 各带
   * 自己的字段（`text`/`data`/`uri`/`content`/`terminalId`），**没有 `path`**。
   * 此前 `takeFromItem` 对任意键名做 `accept`，于是"形状不对但 type 恰好在白名单里"
   * 的正文照样把 `path` 收进产物（终审探针 B5：`content:[{type:'TEXT', path:'/etc/passwd'}]`
   * ⇒ `["/etc/passwd"]`）。
   *
   * 判定与 `isContentBlock` **同源**（同一份 `ACP_BLOCK_TYPES`）：
   *   · 不是块（无 `type` / `type` 不在名单）⇒ `path` 照收 —— 位置项 `{path:'/p/a.txt'}`、
   *     `rawInput.file_path`/`path` 这些**工具参数路径字段**走的都是这一类；
   *   · 是块 ⇒ **只有 `diff`** 收 `path`，其余六类一律不收。
   *
   * ⚠️ 第六轮裁定：本轮初版曾豁免 `content`（`new Set(['diff','content'])`），理由是要保住
   * `test/extract-paths.test.js:317-319` 那条既有断言。裁定改为 **strict（只含 `diff`）**：
   * ACP 的 `content` 块不带 `path`，那条断言在为**另一个不存在的形状**背书，与 `:410-411`
   * 属同一类问题 ⇒ 本轮一并**更正**该断言（期望 `[]`），不再为它留豁口。
   * 其余字段（`file`/`uri`/`filePath`/`file_path`）不受本闸约束：它们本来就是路径字段的
   * 别名（位置块 `{uri:'file://…'}`、`{file:'/p/b.txt'}`）；但**在 `rawInput`/`arguments`
   * 信封内**它们同样受下面那条"信封内只认标量"的新口径约束。
   */
  const FRAME_PATH_BLOCK_TYPES = new Set(['diff'])
  const blockPathAllowed = (item) => {
    if (!isContentBlock(item)) return true
    return FRAME_PATH_BLOCK_TYPES.has(String(readOwn(item, 'type')).trim().toLowerCase())
  }
  /**
   * `content[]` 块内的 `path` 也走同一道闸：块数组那一支把每个块交给 `walk`
   * （`walk(item, depth+1, k)`），泛化的 `k === 'path'` 分支**不知道**当前节点是块，
   * 于是 `content:[{type:'text', path:'/etc/passwd'}]` 会绕过 `takeFromItem` 的闸。
   * 两个入口共用 `blockPathAllowed`，避免"闸装在一处、绕道在另一处"。
   */
  const pathKeyAllowed = (node, key) => (key === 'path' ? blockPathAllowed(node) : true)
  /**
   * ## ⚠️ v0.7.9（第六轮裁定）：**工具参数信封内只认标量，数组一律不取路径**
   *
   * 第五轮修完"数组元素的 `content` 不再下钻"之后仍留着一族：信封（`rawInput`/
   * `arguments`）下的**数组元素**照样按 PATH_KEYS 取值 —— `files:[{path:L}]`、
   * `files:[{file:L}]`、`files:[{uri:L}]`、`files:[{dest:L}]`、`files:[{type:'text',file:L}]`
   * 全部把正文里的路径送进产物。**补键名是补不完的**（`path`/`file`/`uri`/`filePath`/
   * `file_path`/`dest`/`src`/`target`… 下一个键名又会漏一次），这一族已经吃了五轮。
   *
   * **新口径（信封边界，两条一起才是关的）**：
   *   ① **只有 toolCall 顶层的 `content[]` / `locations[]`** 允许从**块内**取路径
   *      （块类型仍按白名单，`path` 只对 `diff` 成立）；
   *   ② **`rawInput` / `arguments` 下的任何非标量值（数组、对象、任意深度）：一律不取
   *      路径、也不下钻** —— 它们是**工具参数正文**；
   *   ③ 但信封**顶层自己**的**标量**路径字段照旧取（`rawInput.file_path` 是 qoder Edit
   *      帧的命脉；`arguments.file_path`、`arguments` 为 JSON 字符串的信封形态也必须
   *      照旧工作）—— **真实帧命脉，不许弄丢**。
   *
   * 判据落在 `walk` 的 `k === 'path'` / PATH_KEYS 分支上：`inEnv && typeof v !== 'string'`
   * ⇒ 整棵剪掉。为什么把信封内**对象**也一并剪掉（不只是数组）：`rawInput.edits:{path}`、
   * `files:[{file}]` 这类形状本身就是"正文里再嵌一层"的口子，而"信封顶层 scalar"这条
   * 规则已经覆盖全部确证真帧；方向 fail-closed（少预填一条，用户手填），与缺口D 同向。
   * 代价（**明确记录**）：`{rawInput:{paths:['/proj/1.txt','/proj/2.txt']}}` 这种"路径
   * 列表"形状不再产出（见 `test/extract-paths.test.js` 里被更正的对应断言）；本仓
   * 全量语料（lib/roles/docs）中**没有任何**产品以此形状发路径的确证证据。
   */
  /**
   * `PATH_KEYS` 那一层的**取值**（第三轮复审 Major-1 的权衡点，写清楚备查）：
   *   · 字符串 ⇒ `accept`；
   *   · 数组 ⇒ 逐项取**该层的路径字段**（`path`/`file`/`uri`/`filePath`/`file_path`）；
   *   · 对象 ⇒ 只取**该层的路径字段**（同上五个键名），**不再下钻**其它键。这是刻意的
   *     fail-closed 选择：`body`/`edits` 这类"对象形状的正文"是把路径偷渡进产物最省事的
   *     口子；而真·结构化路径字段本来就有 `path`/`file_path` 这些**键名**可走
   *     （它们自己会命中 PATH_KEYS）。代价：真出现"路径包在无名对象里"的新形状会
   *     **少收集**一条 ⇒ 弹框预填为空、需用户手填（方向安全：宁可少预填，也不写一条
   *     从正文里猜出来的授权）。
   *
   * ## ⚠️ v0.7.9（第五轮终审**阻断**）：数组分支**不再**下钻 `item.content`
   *
   * 第四轮把"块数组资格只给 toolCall 顶层"加在了 `walk` 的 `content`/`locations`
   * 键分支，**漏了本函数数组分支**那份同形下钻（`contentBlockItems(readOwn(item,
   * 'content'))` ⇒ `walk(b, depth+1)`）。后果：`rawInput.<任意 PATH_KEYS>` 数组元素
   * 带一个 `type:'diff'` 的 `content` 就能把正文里的路径送进产物 ——
   * `{kind:'edit',rawInput:{file_path:'/p/a.json',files:[{content:{type:'diff',
   * path:'/etc/passwd'}}]}}` ⇒ `["/p/a.json","/etc/passwd"]`（终审探针 LEAK，
   * 23 个 PATH_KEYS 命中 22 个，端到端一次 `allow-session` 后 `~/.ssh` 进会话规则、
   * 后续对 `~/.ssh/known_hosts` 的请求被静默放行）。
   *
   * 根因是**误把 `type` 当"帧字段"的判别器**：`type` 只是正文对象里的一个键，正文
   * 完全可控 —— 白名单对既有的键分支有效，对本分支无效。形状判定与"只认顶层"两条
   * **必须成对**才关得住（第四轮只关了一半）。
   *
   * 删掉这支**不损失任何真帧**：`content[]` 块内的路径已由 `walk` 的
   * `k === 'content'`（顶层）分支收集；`locations[]` 的取值也不依赖它（位置项自己的
   * `path`/`uri`/`file` 由上面的 `takeFromItem` 收）。终审已验真①–⑤与多块 Edit 帧
   * 全部不变；`test/extract-paths.test.js` 的对应断言同步更正（原断言为一个**不存在的
   * ACP 形状** `files[].content` 背书）。
   */
  const descendPathValue = (v, depth) => {
    const takeFromItem = (item) => {
      for (const sub of ['path', 'file', 'uri', 'filePath', 'file_path']) {
        if (sub === 'path' && !blockPathAllowed(item)) continue
        const ok = accept(readOwn(item, sub))
        if (ok) out.add(ok)
      }
    }
    if (typeof v === 'string') {
      const ok = accept(v)
      if (ok) out.add(ok)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') {
          const ok = accept(item)
          if (ok) out.add(ok)
          continue
        }
        if (!item || typeof item !== 'object') continue
        takeFromItem(item)
        // 第五轮终审阻断：**这里刻意不下钻 `item.content`**（见上方说明）。
        // 判「是不是真 ACP 块」靠 `type` 白名单，而 `type` 只是正文对象里的一个键
        // ⇒ 白名单对**正文**不是判别器；只要下钻就必被伪造块偷渡。
      }
      return
    }
    if (v && typeof v === 'object') takeFromItem(v)
  }
  /**
   * 只认**自身属性**：原型链上的 `path`/`file` 不是产品写下的信息（旧实现用 `v[sub]`
   * 直取，原型链会被读到）。
   */
  function hasOwn(obj, key) {
    return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
  }
  /**
   * 读自身属性，**带 throwing getter 防御**（第四轮终审 Minor-3）。
   *
   * 与 `lib/execute-frame.js` 的 `own()` **同口径**：带 throwing getter 的载荷对象会让
   * `obj[key]` / `Object.entries(obj)` 抛。当前**不可达**（载荷经 JSON-RPC 反序列化，
   * 唯一生产调用点在 `lib/index.js` 的 permissionHandler 外层 try 内、异常收敛为 deny），
   * 但这层不该指望调用方兜——口径不一致本身就是下一轮复审的靶子。
   */
  function readOwn(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined
    try {
      return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
    } catch {
      return undefined
    }
  }
  /**
   * @param {object} node
   * @param {number} depth 嵌套深度（`> 6` 截止）
   * @param {string|null} containerKey 当前节点是**哪个键**的值（只用于 `CONTAINER_KEYS` 的 JSON 下钻）
   * @param {boolean} atTop 当前节点是不是 **toolCall 对象本身**（`content`/`locations`
   *   的块数组资格只给顶层，见上方 ② 的说明）
   * @param {boolean} inEnv 当前节点是不是**工具参数信封**（`rawInput`/`arguments`）**内部**
   *   —— 含信封对象自身及其全部后代。为 `true` 时只认**标量**路径字段（第六轮裁定，
   *   见上方那段说明）：数组/对象一律整棵剪掉，既不下钻也不取值。
   *   注意与 `containerKey` 的区别：后者是"当前值挂在哪个键下"（只驱动 `CONTAINER_KEYS`
   *   的 JSON 下钻），前者是"是否已进入信封"，进信封后不会因为下钻而丢失。
   */
  const walk = (node, depth, containerKey = null, atTop = false, inEnv = false) => {
    if (node === null || node === undefined || depth > 6) return
    if (typeof node === 'string') {
      // 只有容器键下的 JSON 字符串才下钻（见 CONTAINER_KEYS / BODY_KEYS 的说明）
      if (containerKey && CONTAINER_KEYS.has(containerKey)
        && (node.trim().startsWith('{') || node.trim().startsWith('['))) {
        try { walk(JSON.parse(node), depth + 1, containerKey, atTop, inEnv) } catch { /* 非 JSON 字符串：结构化层不看文本 */ }
      }
      return
    }
    if (Array.isArray(node)) {
      // 第六轮裁定：信封内的数组是**工具参数正文**（`files[]`/`paths[]`/`edits[]`…），
      // 一律不取路径、也不下钻 —— 补键名补不完，这里一次关干净。
      if (inEnv) return
      // 第三轮复审 nit-1：数组分支此前不递增 depth ⇒ `depth > 6` 护栏可被纯数组嵌套绕过
      for (const x of node) walk(x, depth + 1, containerKey, atTop, inEnv)
      return
    }
    if (typeof node !== 'object') return
    let keys
    // throwing getter 防御（Minor-3）：**只枚举键**（`Object.keys` 不读值 ⇒ 值的 getter
    // 抛不出来），取值一律走 `readOwn` ⇒ 抛的那个键被跳过，其余键照常参与。
    // 连键枚举都被拒（Proxy 的 ownKeys trap）才整棵剪掉。
    try { keys = Object.keys(node) } catch { return }
    for (const k of keys) {
      const v = readOwn(node, k)
      // ── `content` / `locations`：块数组资格**只给 toolCall 顶层**（修法②）────────
      if (k === 'content' || k === 'locations') {
        if (!atTop) continue // rawInput/arguments 下的同名键 = 工具参数正文 ⇒ 整棵剪掉
        if (k === 'content') {
          const blocks = contentBlockItems(v)
          if (!blocks) continue // 形状不合格（无名对象 / type 不在名单）⇒ 数据
          for (const item of blocks) walk(item, depth + 1, k)
        } else {
          if (!locationItems(v)) continue // 单个对象 / 非位置数组 ⇒ 数据（Minor-2 统一口径）
          // 位置块自己的 path/uri/file（含纯字符串项）就是目标路径
          descendPathValue(v, depth)
        }
        continue
      }
      // 正文键：一律不参与结构化提取
      if (BODY_KEYS.has(k)) continue
      // 递归白名单（Major-1 的修法本体）：只有结构键继续下钻，其余键一律当数据剪掉
      if (STRUCTURAL_KEYS.has(k)) {
        // 进信封：`rawInput`/`arguments` 自身及其全部后代都按"信封内只认标量"处理。
        // ⚠️ `atTop` 必须**置回 `false`**（第六轮）：信封里的 `content`/`locations`
        // 是**工具参数正文里的同名键**，不是 toolCall 顶层的块数组。若把 `atTop`
        // 原样透传，`rawInput.content:[{type:'diff',path}]` / `rawInput.locations:[…]`
        // 会被 `k === 'content' || k === 'locations'` 那一支当**顶层块数组**收下，
        // 等于把刚关上的口子从"信封"这一侧重新打开（本轮回归自测转红的正是这两条）。
        walk(v, depth + 1, k, false, true)
        continue
      }
      if (keyIsPath(k)) {
        // 第六轮裁定（信封边界）：信封内的数组/对象是工具参数正文 ⇒ 整棵剪掉
        // （只认标量字符串；`rawInput.file_path: '/p/a.json'` 这类真帧命脉照旧取）。
        if (inEnv && typeof v !== 'string') continue
        // 第五轮终审 Major-1：`path` 只对 `diff` 块成立（其余块类型没有这个字段）
        if (!pathKeyAllowed(node, String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())) continue
        descendPathValue(v, depth)
      }
    }
  }
  walk(toolCall, 0, null, true)
  return [...out]
}

/**
 * v0.4.0 的原始实现（全量递归 + 对每个字符串值跑绝对路径正则）。
 *
 * v0.7.9 缺口D 起 `extractPaths` **不再**调用它 ⇒ 它的产物**不能**自动变成规则；
 * 缺口D 修正起它**只有一条合法出路**：作为 `permission-pending` 的 `inferredDirs`
 * 排在 `suggestedDirs` 之后预填进弹框（用户定稿：无勾选框，每行一个路径的可编辑
 * 文本框，靠**删行**去掉不要的项）。也就是把「正文里提到了某个目录」从**自动授权
 * 依据**降级成**给人看一眼的线索**——正文是被编辑的**内容**，仓库里谁都可以写
 * `/etc/passwd`、`~/.ssh`、`~/.qoder/settings.json`。
 * 用户没删掉的那些行经决议载荷的 `paths` 通道回流，仍要过
 * `validateDeclaredPaths` 的服务端校验，才可能成为规则。
 *
 * 仍然保留的第二个用途：差分证明——`test/extract-paths.test.js` 用它复现
 * "正文里的假路径确实会进请求集合"这个真实现场，证明新 fixture 不是自说自话。
 *
 * **不得**再接回 `extractPaths`、`suggestedDirs` 或任何规则写入路径。
 */
export function scanPathsLoose(toolCall) {
  const out = new Set()
  const PATH_KEY = /(^|_)(path|file|dir|directory|target|src|dest|source|uri|location)(_|$)/i
  // v0.7.9 收紧：匹配在分号/中文标点处即断。旧写法一路吃到下一个空白，于是
  // "写入 /tmp/proj/a.txt；cwd 是 …" 会产出一条 `/tmp/proj/a.txt；cwd` 的脏路径——
  // 它匹配不上任何规则，却会被"取上一级目录"写进会话授权集（污染面同 C 项正文假路径）。
  const PATH_RE = /(~|\/Users\/|\/Volumes\/|\/tmp\/|\/private\/|\/home\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|\/workspace\/|\/workspaces\/)[^\s"'`;；，。、：:]+/g
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      for (const m of node.matchAll(PATH_RE)) out.add(m[0].replace(/[,;:)\]}>，。；]+$/, ''))
      return
    }
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // v0.7.9 收紧：带换行的值绝不可能是单条路径（0.7.8 会把整段多行文本当成路径
        // 塞进请求集合），旧写法只查空格漏了这种。方向仍是只收紧。
        if (PATH_KEY.test(k) && typeof v === 'string' && v.length > 0 && !v.includes(' ') && !/[\r\n]/.test(v)) {
          out.add(v)
        }
        walk(v)
      }
    }
  }
  walk(toolCall)
  return [...out]
}

/** 只认自身属性（原型链上的 `path`/`toolName` 不是产品写下的信息） */
function logOwnField(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

/** 压成单行并限长：日志必须一行一条，且超长正文不能把后面的关键字段挤出可视区 */
function clipToSingleLine(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  const oneLine = text.replace(/[\r\n\t]+/g, ' ')
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…[+${oneLine.length - limit}字符]` : oneLine
}

/**
 * v0.7.9 缺口C：requestPermission 载荷的**结构化摘要**（取代 `JSON.stringify(...).slice(0,500)`）。
 *
 * 为什么必须换掉：Edit 帧的 `newText` 动辄几 KB，排在 JSON 前面的正文会把
 * `path`/`rawInput`/`title`/`toolCallId` 一并挤出 500 字符窗口——历次现场取证
 * 拿不到被编辑文件的路径，正是因为它**永远打不出来**。
 *
 * 本摘要**无条件**打印以下字段（每个字段各自限长，互不挤占）：
 *   toolCallId / kind / name / title / `_meta` 里的 toolName 与命名空间键名 /
 *   每个 diff 块的 `path`（无 diff path 时回退 `rawInput.file_path`/`rawInput.path`）/
 *   `locations[]` / `rawInput` 的**键名**（值截断）/ 正文预览（单独限长，默认 200 字符）。
 * 载荷不是对象（null/字符串/数字/数组）时如实打印类型，不抛异常。
 *
 * @param {unknown} toolCall
 * @param {{previewLimit?: number, titleLimit?: number, valueLimit?: number, maxKeys?: number}} [limits]
 * @returns {string} 单行摘要（不含前缀）
 */
export function summarizeToolCallForLog(toolCall, limits = {}) {
  const previewLimit = Number.isFinite(limits.previewLimit) ? limits.previewLimit : 200
  const titleLimit = Number.isFinite(limits.titleLimit) ? limits.titleLimit : 200
  const valueLimit = Number.isFinite(limits.valueLimit) ? limits.valueLimit : 80
  const maxKeys = Number.isFinite(limits.maxKeys) ? limits.maxKeys : 40
  const type = toolCall === null ? 'null' : toolCall === undefined ? 'undefined' : Array.isArray(toolCall) ? 'array' : typeof toolCall
  if (type !== 'object') return `type=${type} raw=${clipToSingleLine(toolCall, previewLimit)}`

  const parts = [`toolCallId=${String(logOwnField(toolCall, 'toolCallId') ?? '(无)')}`,
    `kind=${String(logOwnField(toolCall, 'kind') ?? '(无)')}`,
    `name=${clipToSingleLine(logOwnField(toolCall, 'name') ?? logOwnField(toolCall, 'toolName') ?? '(无)', titleLimit)}`,
    `title=${clipToSingleLine(logOwnField(toolCall, 'title') ?? '(无)', titleLimit)}`]

  // _meta：命名空间键名 + 各命名空间下的 toolName（qoder 的真实工具名只在这里）
  const meta = logOwnField(toolCall, '_meta')
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const metaKeys = Object.keys(meta).slice(0, maxKeys)
    const toolNames = []
    for (const ns of metaKeys) {
      const val = meta[ns]
      if (val && typeof val === 'object' && typeof val.toolName === 'string' && val.toolName.trim()) toolNames.push(`${ns}.${val.toolName}`)
    }
    if (typeof meta.toolName === 'string' && meta.toolName.trim()) toolNames.push(`_.${meta.toolName}`)
    parts.push(`metaToolName=${toolNames.length > 0 ? toolNames.join(',') : '(无)'}`, `metaKeys=[${metaKeys.join(',')}]`)
  } else {
    parts.push(`metaToolName=${meta === undefined ? '(无 _meta)' : '(无)'}`)
  }

  // diff 块的 path：Edit/Write 帧唯一可信的目标文件来源
  const content = logOwnField(toolCall, 'content')
  const diffPaths = []
  const bodyChunks = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const p = typeof block.path === 'string' && block.path.trim() ? block.path : null
      if (p) diffPaths.push(p)
      const nested = block.content && typeof block.content === 'object' ? block.content : null
      const body = typeof block.newText === 'string' ? block.newText
        : typeof block.oldText === 'string' ? block.oldText
          : nested && typeof nested.text === 'string' ? nested.text : null
      if (body) bodyChunks.push(body)
    }
  }
  const rawInput = logOwnField(toolCall, 'rawInput')
  const rawInputObj = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : null
  if (diffPaths.length === 0 && rawInputObj) {
    for (const key of ['file_path', 'path', 'filePath']) {
      const v = rawInputObj[key]
      if (typeof v === 'string' && v.trim()) diffPaths.push(v)
    }
  }
  const locations = Array.isArray(logOwnField(toolCall, 'locations')) ? logOwnField(toolCall, 'locations') : []
  parts.push(`paths=[${diffPaths.join(', ')}]`, `pathCount=${diffPaths.length}`)
  if (locations.length > 0) {
    parts.push(`locations=[${locations.map((l) => (l && typeof l === 'object' ? String(l.path ?? l.uri ?? l.file ?? '') : '')).filter(Boolean).join(', ')}]`)
  }

  // rawInput：打**键名**，值一律截断——键名本身就够定位载荷形态，值不该顶掉关键字段
  if (rawInputObj) {
    const keys = Object.keys(rawInputObj).slice(0, maxKeys)
    parts.push(`rawInputKeys=[${keys.join(',')}]`,
      `rawInput={${keys.map((k) => `${k}=${clipToSingleLine(rawInputObj[k], valueLimit)}`).join(', ')}}`)
  } else if (rawInput !== undefined) {
    parts.push(`rawInput=${clipToSingleLine(rawInput, previewLimit)}`)
  }
  if (typeof logOwnField(toolCall, 'arguments') !== 'undefined') {
    parts.push(`arguments=${clipToSingleLine(toolCall.arguments, previewLimit)}`)
  }

  // 正文预览：单独限长，绝不与上面的字段争窗口
  const previewBody = bodyChunks.length > 0 ? bodyChunks.join(' ')
    : rawInputObj && typeof rawInputObj.command === 'string' ? rawInputObj.command : ''
  parts.push(`bodyChars=${bodyChunks.reduce((n, s) => n + s.length, 0)}`,
    `preview=${clipToSingleLine(previewBody || '(无正文)', previewLimit)}`)
  return parts.join(' ')
}

/**
 * v0.7.9 缺口C：把一条 requestPermission 打到 stderr（诊断通道，与 0.4.2 一致）。
 * 单独成函数以便测试直接调用（`makeClient` 里的 `requestPermission` 不在导出面上）。
 */
export function logRequestPermissionToolCall(command, params) {
  try {
    console.warn(`[product-subagents:perm] ${command} requestPermission ${summarizeToolCallForLog(params && params.toolCall)} options=${JSON.stringify((params && params.options) || [])?.slice(0, 300)}`)
  } catch { /* 诊断失败忽略 */ }
}

/**
 * v0.4.0：把 ACP RequestPermission 请求解析为 ACP 协议合法响应。
 * 决策链（供 makeClient.requestPermission 使用，导出以便单测）：
 *   1. permissionHandler（宿主交互审批注入）→ 'allow' / 'deny' / 'cancelled'；
 *   2. autoGrant：'all' 全放行；'read' 只读描述放行；
 *   3. fail-closed：优先 reject option，无则 cancelled。
 * 返回 { outcome: 'selected', optionId } 或 { outcome: 'cancelled' }。
 * @param {{permissionHandler?: Function, autoGrant?: string}} policy
 * @param {{sessionId?: string, options: Array, toolCall?: object, description?: string}} req
 */
export function decidePermission(policy = {}, req = {}) {
  const { permissionHandler, autoGrant } = policy
  const opts = Array.isArray(req.options) ? req.options : []
  const pick = (kind) => {
    const hit = opts.find((o) => o && o.kind === kind)
    return hit && hit.optionId ? hit.optionId : null
  }
  /**
   * v0.4.3：把 ACP toolCall 解析成人类可读描述（弹窗/审计显示用）。
   * 已实测 deveco/opencode 载荷（opencode 系 ACP 权限模型）：
   *   { kind, locations:[{path}], rawInput, title, status, toolCallId }
   *   title ∈ {edit, bash, webfetch, doom_loop, external_directory}（权限类别）。
   * 解析优先级：① title 权限类别语义化（edit=写入文件 / bash=执行命令 /
   * external_directory=访问外部目录…）② name/arguments ③ locations 路径
   * ④ content 文本。
   */
  const describe = () => {
    if (req.description) return req.description
    const tool = req.toolCall
    const parts = []
    // a) opencode 系权限模型：title = 权限类别 → 语义化（读/写/执行一目了然）
    const toolTitle = tool && typeof tool.title === 'string' ? tool.title.trim() : ''
    const KIND_LABEL = {
      edit: '写入/修改文件',
      bash: '执行命令',
      webfetch: '发起网络请求',
      doom_loop: 'doom_loop',
      external_directory: '访问外部目录(工作区外，读+写)',
    }
    const kindLabel = KIND_LABEL[toolTitle]
    if (kindLabel) parts.push(kindLabel)
    else if (toolTitle) parts.push(toolTitle)
    // b) 传统模型：name / toolName（如 read_file / write_file）
    const name = tool && (tool.name || tool.toolName) ? String(tool.name || tool.toolName) : ''
    if (name && !kindLabel) parts.push(name)
    // c) locations（opencode 系把涉及路径放这）——每路径一行 📁
    const locations = tool && Array.isArray(tool.locations) ? tool.locations : []
    for (const loc of locations) {
      const p = loc && (loc.path || loc.uri || loc.file)
      if (typeof p === 'string' && p.trim()) parts.push(`📁 ${p.trim()}`)
    }
    // d) arguments：对象或 JSON 字符串——提取 key=value（path/file/command 优先）
    if (tool && tool.arguments !== undefined && tool.arguments !== null) {
      let args = tool.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = null }
      }
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const KEY_ORDER = ['path', 'file', 'dir', 'directory', 'command', 'target', 'uri', 'url', 'query', 'text']
        const entries = Object.entries(args)
        const keyed = (k) => entries.find(([ek]) => String(ek).toLowerCase() === k)
        const picked = KEY_ORDER.map((k) => keyed(k)).filter(Boolean)
        const rest = entries.filter(([k]) => !KEY_ORDER.includes(k.toLowerCase())).slice(0, 2)
        for (const [k, v] of [...picked, ...rest]) {
          const s = typeof v === 'string' ? v : JSON.stringify(v)
          if (s && s.length > 0) parts.push(`${k}=${s.slice(0, 160)}`)
        }
      } else if (typeof tool.arguments === 'string' && tool.arguments.trim()) {
        parts.push(tool.arguments.trim().slice(0, 160))
      }
    }
    // e) 兜底路径（无 locations 时从全量提取补显示，避免路径漏掉）
    if (locations.length === 0) {
      for (const p of extractPaths(tool).slice(0, 3)) {
        if (!parts.some((x) => x.includes(p))) parts.push(`📁 ${p}`)
      }
    }
    // f) content 文本
    if (tool && Array.isArray(tool.content)) {
      const text = tool.content.map((b) => (b && (b.text || (b.content && b.content.text))) || '').filter(Boolean).join(' ').trim().slice(0, 200)
      if (text && !parts.some((x) => x.includes(text.slice(0, 30)))) parts.push(text)
    }
    const out = parts.filter(Boolean).join(' | ')
    return out.length > 320 ? out.slice(0, 320) : out
  }
  const selected = (optionId) => ({ outcome: { outcome: 'selected', optionId } })
  const allow = () => selected(pick('allow_once') || pick('allow_always'))
  const deny = () => selected(pick('reject_once') || pick('reject_always'))
  const cancel = () => ({ outcome: { outcome: 'cancelled' } })
  try {
    if (typeof permissionHandler === 'function') {
      const decision = permissionHandler({
        product: policy.product,
        sessionId: req.sessionId,
        description: describe(),
        toolCall: req.toolCall ?? null,
        paths: extractPaths(req.toolCall),
        options: opts.map((o) => ({ kind: o && o.kind, name: o && o.name, optionId: o && o.optionId })),
      })
      if (decision && typeof decision.then === 'function') {
        return decision.then((d) => normalizeDecision(d, { allow, deny, cancel, opts }), () => deny() || cancel())
      }
      return normalizeDecision(decision, { allow, deny, cancel, opts })
    }
    if (autoGrant === 'all') {
      const id = pick('allow_once') || pick('allow_always')
      return id ? selected(id) : cancel()
    }
    if (autoGrant === 'read') {
      const desc = describe().toLowerCase()
      const readLike = /read|查看|读取|cat |ls |stat |open|list|fetch|get |inspect|show|glob|grep/.test(desc)
      if (readLike) {
        const id = pick('allow_once') || pick('allow_always')
        if (id) return selected(id)
      }
    }
    const rejectId = pick('reject_once') || pick('reject_always')
    return rejectId ? selected(rejectId) : cancel()
  } catch (error) {
    console.warn(`product-subagents: requestPermission 处理失败，按拒绝处理: ${error && error.message ? error.message : error}`)
    const rejectId = pick('reject_once') || pick('reject_always')
    return rejectId ? selected(rejectId) : cancel()
  }
}

function normalizeDecision(decision, { allow, deny, cancel, opts = [] }) {
  if (decision === 'cancelled') return cancel()
  if (decision === 'allow') return allow() || cancel()
  if (decision === 'allow-always') {
    // 白名单/长期授权：优先 allow_always（ACP 服务端记住，后续同类请求不再问）
    const always = (opts || []).find((o) => o && o.kind === 'allow_always')
    if (always && always.optionId) return { outcome: { outcome: 'selected', optionId: always.optionId } }
    return allow() || cancel()
  }
  if (decision === 'deny') return deny() || cancel()
  if (decision && typeof decision === 'object' && decision.optionId) {
    return { outcome: { outcome: 'selected', optionId: decision.optionId } }
  }
  // handler 返回了无法识别的值 → fail-closed（不猜测放行）
  return deny() || cancel()
}

/** ACP 会话配置项：模型 id 在本仓库既有约定里就叫 model，effort 由产品自定。 */
export const MODEL_CONFIG_IDS = ['model']
export const EFFORT_CONFIG_IDS = ['effort', 'reasoning_effort', 'thought_level']
export const MODEL_CONFIG_CATEGORY = 'model'
export const EFFORT_CONFIG_CATEGORY = 'thought_level'

/**
 * ACP v1 里模型与 reasoning 档位的唯一可移植来源是 `configOptions`
 * （`session/new|load|fork|resume` 响应、`session/set_config_option` 响应、
 * `config_option_update` 通知各带一份完整快照）。协议没有
 * `availableModels`/`currentModelId`/`session/set_model`。
 *
 * 配置项的 **id 与 category 都由产品自定**，实测三种形态：
 *   opencode → `model`(category=model) + `effort`(category=thought_level)
 *   deveco   → 只有 `model` + `mode`（没有 reasoning 档位）
 *   qoder    → `model`(category=model) + `reasoning_effort`(**category=model**)
 * 所以定位必须「id 精确匹配优先 → category 兜底 → 排除已被对方认领的 id」，
 * 任何一处硬编码都会踩坑（qoder 的 effort 与 model 共享 category）。
 */

/**
 * 取值域条目：`{value, name?, description?}`。
 *
 * `value` 才是能喂给 `session/set_config_option` 的东西（落盘值），`name` 是产品自报
 * 的显示名（GUI 下拉的唯一正经来源，丢了就只能亮裸 id）。name/description 缺失时
 * **省略键**，让消费方回退到 value，而不是写个空串占位。
 * 分组形态（SessionConfigSelectGroup[]）展开收集；同一 value 跨组重复时保留首次元数据。
 */
export function configOptionEntries(option) {
  const out = []
  const seen = new Set()
  const walk = (list) => {
    for (const item of list || []) {
      if (!item) continue
      if (Array.isArray(item.options)) { walk(item.options); continue }
      if (typeof item.value !== 'string' || seen.has(item.value)) continue
      seen.add(item.value)
      const entry = { value: item.value }
      if (typeof item.name === 'string' && item.name) entry.name = item.name
      if (typeof item.description === 'string' && item.description) entry.description = item.description
      out.push(entry)
    }
  }
  walk(option && option.options)
  return out
}

/** 取一个配置项的取值域；兼容扁平 options 与分组（SessionConfigSelectGroup[]）。 */
export function configOptionValues(option) {
  return configOptionEntries(option).map((entry) => entry.value)
}

/**
 * 取值域是否接受该值（用于下发前预校验，见 applySettings 的降级链）。
 * 空域（产品压根没上报 options）**放行**：没有依据就判非法，会把本来能用的
 * 配置挡死；宁可发一次调用让产品自己拒绝——拒绝同样走回退，不会弄坏回合。
 */
export function domainAccepts(option, value) {
  const values = configOptionValues(option)
  if (values.length === 0) return true
  return values.includes(value)
}

/** id 精确匹配优先、category 兜底（排除 exclude 里的 id）；找不到返回 null。 */
export function findConfigOption(configOptions, { ids = [], category, exclude = [] } = {}) {
  const list = Array.isArray(configOptions) ? configOptions : []
  for (const id of ids) {
    const hit = list.find((o) => o && o.id === id)
    if (hit) return hit
  }
  return list.find((o) => o && o.category === category && !exclude.includes(o.id)) || null
}

/** 模型配置项（真实 configId 由产品自定）。 */
export function findModelOption(configOptions) {
  return findConfigOption(configOptions, { ids: MODEL_CONFIG_IDS, category: MODEL_CONFIG_CATEGORY, exclude: EFFORT_CONFIG_IDS })
}

/** reasoning/effort 配置项。 */
export function findEffortOption(configOptions) {
  return findConfigOption(configOptions, { ids: EFFORT_CONFIG_IDS, category: EFFORT_CONFIG_CATEGORY, exclude: MODEL_CONFIG_IDS })
}

/** 诊断串：每个配置项的 id + category + 当前值 + 取值域（失败时一并打出）。 */
export function describeConfigOptions(configOptions) {
  const list = Array.isArray(configOptions) ? configOptions : []
  if (list.length === 0) return '（该 agent 未上报任何 configOptions）'
  return list.map((o) => {
    const values = configOptionValues(o)
    const shown = values.slice(0, 12).join('|') + (values.length > 12 ? `|…共${values.length}` : '')
    return `${o && o.id}(category=${(o && o.category) || '-'}, current=${(o && o.currentValue) || '-'}, values=${shown || '-'})`
  }).join('  ')
}

/**
 * 收走一个再没人引用的子进程。spawn 出的进程一旦被放弃就是孤儿（没人 await 它、
 * 也没人 kill 它），所以每个「已经拉起但拿不到 remote」的出口都必须过这一道。
 * mock 进程可能没有 kill，故逐层守卫。
 */
function killOrphan(proc) {
  if (!proc || typeof proc.kill !== 'function') return
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try { proc.kill('SIGKILL') } catch { /* 已随进程退出 */ }
}

/**
 * ACP bridge: one persistent child process speaking the Agent Client Protocol
 * over stdio (e.g. `opencode acp`, `agent acp` (Cursor), `cbc --acp`). A session
 * lives in that process; later prompts on the same session continue the
 * conversation, and `session/load` reconnects a persisted session id.
 *
 * Model / effort selection: resolved dynamically from the session's
 * `configOptions` (see `findConfigOption`) and applied through
 * `setSessionConfigOption`, whose response carries the refreshed snapshot —
 * effort values depend on the selected model, so the response MUST be written
 * back. Applying a value is a fallback chain, never a failure: a request that
 * is unspecified (empty / `default`), absent from the advertised value domain,
 * or has no matching config option is NOT sent, and a value the agent rejects
 * is caught. Either way the session keeps its current value (= the agent's own
 * default) and the turn proceeds; each skipped/rejected attempt fires
 * `options.onConfigError` with `{requested, optionId, effective, available,
 * reason}` so the plugin layer can say which tier actually took effect.
 * Configure the agent's own defaults via its CLI flags / config (`args`).
 *
 * `options.onSpawn(proc)` is a pure observer fired the instant the child is
 * spawned — callers that may abandon `create()` before it settles (the provider
 * probe) need the handle to SIGKILL it. Abandoned handles are otherwise
 * orphans: every failed connect/session-new path kills its own process.
 */
export function createAcpBridge(options = {}) {
  const command = options.command || 'opencode'
  const args = options.args || ['acp']
  const env = options.env || {}
  const productName = options.product || command

  /** 写入并透出（remote.configOptions 的唯一变化入口，消费方永远看到最新快照）。 */
  function notifyConfigOptions(remote) {
    if (typeof options.onConfigOptions !== 'function' || !remote) return
    try {
      options.onConfigOptions({
        product: productName,
        remoteSessionId: remote.sessionId || null,
        configOptions: Array.isArray(remote.configOptions) ? remote.configOptions : [],
      })
    } catch { /* 事件消费方故障不得影响桥接 */ }
  }

  function setConfigOptions(remote, list) {
    if (remote && Array.isArray(list)) remote.configOptions = list
  }

  function applyConfigOptions(remote, list) {
    setConfigOptions(remote, list)
    notifyConfigOptions(remote)
  }

  /**
   * 回退告警/事件：`console.warn` 按 (kind,value) 去重（长活子代理不刷屏），
   * 但事件**每次都发**——dispatch 日志要能逐回合回答"填了 X 为什么没生效"。
   * payload 里的 `effective` 就是本次真正生效的值（多半是产品默认）。
   */
  function reportConfigFallback(remote, { kind, requested, optionId, effective, available, reason, error }) {
    const seen = remote && (remote.configWarnings || (remote.configWarnings = new Set()))
    const key = `${kind}:${requested}`
    if (seen && !seen.has(key)) {
      seen.add(key)
      console.warn(`product-subagents: [${productName}] ${kind} "${requested}" 未应用（${reason}）→ 回退生效值 "${effective ?? '-'}"；agent 上报的配置项：${describeConfigOptions(Array.isArray(remote && remote.configOptions) ? remote.configOptions : [])}`)
    }
    if (typeof options.onConfigError !== 'function' || !remote) return
    try {
      options.onConfigError({
        product: productName,
        remoteSessionId: remote.sessionId || null,
        kind,
        requested,
        optionId: optionId ?? null,
        effective: effective ?? null,
        available: Array.isArray(available) ? available : [],
        reason,
        error: error ?? null,
        configOptions: Array.isArray(remote.configOptions) ? remote.configOptions : [],
      })
    } catch { /* 事件消费方故障不得影响桥接 */ }
  }

  /** 选项当前的生效值（产品默认）；选项不存在则为 null。 */
  function optionValue(option) {
    return option && typeof option.currentValue === 'string' ? option.currentValue : null
  }

  /**
   * 应用一个配置项，并回写响应里的完整 configOptions。
   * 丢弃响应 = 让后续轮次沿用陈旧的取值域（实测 opencode 切换 model 后
   * thought_level 的档位集合会变），这是 model→effort 联动陈旧的根因。
   *
   * 容错契约（v0.6.0）：**任何失败都不冒泡**。用户手填 agents.json 时写错
   * model/effort 是常态，回合必须照常完成，只是静默沿用产品默认档位。
   */
  async function writeConfigOption(remote, option, value, kind) {
    const available = configOptionValues(option)
    try {
      const res = await remote.connection.setSessionConfigOption({
        sessionId: remote.sessionId,
        configId: option.id,
        value,
      })
      applyConfigOptions(remote, res && res.configOptions)
    } catch (error) {
      const fresh = (Array.isArray(remote.configOptions) ? remote.configOptions : []).find((o) => o && o.id === option.id)
      reportConfigFallback(remote, {
        kind,
        requested: value,
        optionId: option.id,
        effective: optionValue(fresh),
        available,
        reason: 'rejected',
        error: (error && error.message) || String(error),
      })
    }
  }

  /**
   * settings.model / settings.reasoningEffort → 动态解析真实 configId 后应用。
   * 三级降级，全程不抛：①值即"不指定"→ 不发调用；②值不在产品自报取值域 →
   * 不发调用（省一次必然失败的往返，也别让产品回一个错误码污染日志）；
   * ③产品没有该 option → 不发调用。三种都沿用会话当前值 = 产品默认。
   */
  async function applySettings(remote, settings) {
    if (!remote || !remote.connection || typeof remote.connection.setSessionConfigOption !== 'function') return
    const list = Array.isArray(remote.configOptions) ? remote.configOptions : []
    // 空串/'default' 一律当"不指定"：opencode 等产品的 default 档位语义本来就是
    // "由产品自己决定"，发一次调用只会多一个可能失败的往返。
    const wanted = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== 'default'
    if (wanted(settings.model)) {
      const option = findModelOption(list)
      if (!option) {
        reportConfigFallback(remote, { kind: 'model', requested: settings.model, optionId: null, effective: null, available: [], reason: 'no-option' })
      } else if (!domainAccepts(option, settings.model)) {
        reportConfigFallback(remote, { kind: 'model', requested: settings.model, optionId: option.id, effective: optionValue(option), available: configOptionValues(option), reason: 'not-in-values' })
      } else {
        await writeConfigOption(remote, option, settings.model, 'model')
      }
    }
    if (wanted(settings.reasoningEffort)) {
      // 必须重新读：上一步的 model 切换可能已经改变了 effort 取值域
      const fresh = Array.isArray(remote.configOptions) ? remote.configOptions : list
      const option = findEffortOption(fresh)
      if (!option) {
        reportConfigFallback(remote, { kind: 'effort', requested: settings.reasoningEffort, optionId: null, effective: null, available: [], reason: 'no-option' })
      } else if (!domainAccepts(option, settings.reasoningEffort)) {
        reportConfigFallback(remote, { kind: 'effort', requested: settings.reasoningEffort, optionId: option.id, effective: optionValue(option), available: configOptionValues(option), reason: 'not-in-values' })
      } else {
        await writeConfigOption(remote, option, settings.reasoningEffort, 'effort')
      }
    }
  }

  function makeClient(onText, onActivity, configBox) {
    return {
      async sessionUpdate(params) {
        const update = params && params.update
        // Any session activity (text chunks, progress/state updates, tool
        // events) means the agent is alive and working — slow-but-streaming
        // responses must never be mistaken for a dead session. Report every
        // update so promptOnce can distinguish "still active" from "wedged".
        if (onActivity) onActivity()
        if (update && update.sessionUpdate === 'agent_message_chunk') {
          const content = update.content
          if (content && content.type === 'text' && typeof content.text === 'string') onText(content.text)
        }
        // 产品侧自主改动配置（切换 model 会重算 reasoning 档位）→ 刷新快照。
        if (update && update.sessionUpdate === 'config_option_update') {
          const list = update.configOptions
          if (Array.isArray(list)) {
            if (configBox.remote) setConfigOptions(configBox.remote, list)
            else configBox.options = list // 远端尚未建立：先落 box
          }
          if (configBox.remote) notifyConfigOptions(configBox.remote)
        }
        return {}
      },
      async requestPermission(params) {
        // Permission policy (v0.4.0): no longer a hard-coded reject. The
        // harness user may be interactively consulted (approval service /
        // sandbox-style escalation), so a product asking "may I read this
        // path?" can be granted and continue instead of silently dying into
        // an empty-body failure. ACP protocol responses are `cancelled` or
        // `selected` with the optionId the server offered; a bare
        // `{outcome:'rejected'}` is NOT valid ACP and confuses strict agents.
        // v0.4.2 诊断：打印原始 toolCall（结构因产品而异——弹窗"工具调用"占位
        // 说明 name/arguments/content 均未解析到，需按真实载荷调 describe）
        // v0.7.9 缺口C：改为**结构化摘要**——旧写法 JSON.stringify(toolCall).slice(0,500)
        // 会让 Edit 帧的长 newText 把 path/rawInput/title/toolCallId 挤出窗口，
        // 取证时永远拿不到被编辑文件的路径。见 summarizeToolCallForLog。
        logRequestPermissionToolCall(command, params)
        return decidePermission(
          { permissionHandler: options.permissionHandler, autoGrant: options.autoGrant, product: command },
          { sessionId: params && params.sessionId, options: (params && params.options) || [], toolCall: params && params.toolCall },
        )
      },
      async readTextFile() {
        throw new Error('product-subagents: ACP readTextFile is not supported')
      },
      async writeTextFile() {
        throw new Error('product-subagents: ACP writeTextFile is not supported')
      },
    }
  }

  async function connect(cwd, configBox) {
    // box 是 remote.configOptions 的存储位：定义访问器时按 box 取值，reconnect
    // 复用同一个 box，配置快照与 `config_option_update` 通知永远指向同一份状态。
    const box = configBox || { options: [], remote: null }
    return new Promise((resolve, reject) => {
      // 测试缝：options.spawn 注入假进程工厂（watchdog 单测不依赖真实 CLI）；
      // 生产路径无 options.spawn → 走 spawnProduct 真实拉起。
      const spawnFn = typeof options.spawn === 'function' ? options.spawn : spawnProduct
      const proc = spawnFn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, ...env },
      })
      // 观察钩子（不参与协议）：调用方（provider 探测）需要拿到「还没 resolve 就可能
      // 被放弃」的进程句柄，否则超时后僵死 CLI 会留在系统里占着 stdio。
      if (typeof options.onSpawn === 'function') {
        try { options.onSpawn(proc) } catch { /* 钩子故障不得影响连接 */ }
      }
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        // 握手失败后 ACP 进程没人再引用：不杀就是孤儿（探测路径尤其如此，它不复用连接）。
        killOrphan(proc)
        reject(err)
      }
      proc.on('error', (err) => { fail(err) })
      let stderrTail = ''
      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + String(chunk)).slice(-4096)
        })
      }
      const input = Writable.toWeb(proc.stdin)
      const output = Readable.toWeb(proc.stdout)
      const stream = acp.ndJsonStream(input, output)
      let textBuffer = ''
      let progress = {}
      const client = makeClient((text) => {
        textBuffer += text
        progress = { ...progress, lastChunkAt: Date.now(), receivedChars: (progress.receivedChars || 0) + text.length, partialPreview: textBuffer.slice(-200) }
      }, () => {
        progress = { ...progress, lastActivityAt: Date.now() }
      }, box)
      const connection = new acp.ClientSideConnection(() => client, stream)
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }).then(() => {
        if (settled) return
        settled = true
        resolve({
          proc,
          connection,
          configBox: box,
          progress: () => progress,
          drainText() {
            const text = textBuffer
            textBuffer = ''
            return text
          },
          stderrTail: () => stderrTail,
          drainStderr() {
            const text = stderrTail
            stderrTail = ''
            return text
          },
        })
      }, (err) => { fail(err) })
    })
  }

  /** Whether the ACP server process is gone (exited or killed). */
  function transportDead(remote) {
    if (!remote || !remote.proc) return true
    return remote.proc.exitCode !== null || remote.proc.signalCode !== null
  }

  /**
   * 把 connect 出的 handle 变成 remote：`configOptions` 走访问器绑定到 handle 的
   * box，使得「会话响应写入」「set_config_option 响应写入」「config_option_update
   * 通知」三者落在同一份状态上（box 在 reconnect 时按原样复用，故无需重挂）。
   */
  function buildRemote(handle) {
    const remote = { kind: 'acp', ...handle }
    const box = handle.configBox
    Object.defineProperty(remote, 'configOptions', {
      enumerable: true,
      configurable: true,
      get: () => box.options,
      set: (list) => { box.options = Array.isArray(list) ? list : [] },
    })
    box.remote = remote
    return remote
  }

  /**
   * Re-establish the ACP connection after the server process died: spawn a
   * fresh server, try session/load for the same session id (when the agent
   * supports it), else fall back to a new session. Mutates `remote` in place.
   */
  async function reconnectRemote(remote, cwd) {
    const handle = await connect(cwd, remote.configBox)
    let id = remote.sessionId
    let nextOptions
    try {
      // ACP session/load requires cwd + mcpServers: strict agents (deveco /
      // opencode) validate the request and reject it without them, so an
      // incomplete call would silently reset every reconnect to a new session.
      const loaded = await handle.connection.loadSession({ sessionId: id, cwd, mcpServers: [] })
      handle.sessionId = id
      nextOptions = loaded && loaded.configOptions
    } catch (error) {
      if (id) console.warn(`product-subagents: session/load failed for ${id} (${error && error.message ? error.message : error}); starting a new session`)
      const session = await handle.connection.newSession({ cwd, mcpServers: [] })
      handle.sessionId = session.sessionId
      nextOptions = session.configOptions
    }
    remote.proc = handle.proc
    remote.connection = handle.connection
    remote.drainText = handle.drainText
    remote.progressRef = handle.progress
    remote.stderrTail = handle.stderrTail
    remote.drainStderr = handle.drainStderr
    remote.sessionId = handle.sessionId
    // 换进程后取值域可能已变（且 sessionId 可能已重置）→ 写入 + 透出
    applyConfigOptions(remote, nextOptions)
  }

  /** Attach the product's recent stderr to an error for diagnostics. */
  function attachStderr(error, remote) {
    try {
      if (error && remote && typeof remote.stderrTail === 'function') {
        const tail = remote.stderrTail()
        if (tail && tail.trim()) {
          error.stderr = tail.slice(-2000)
          error.message = `${error.message} | stderr: ${tail.trim().slice(-400)}`
        }
      }
    } catch {
      // diagnostics must never break the error path
    }
    return error
  }

  /**
   * v0.5.3(F)：带看门狗的 prompt 执行——冻结检测 + kill→reconnect 无限重试。
   *
   * 状态机（per-round，挂在本次 prompt 上）：
   *   武装：submit 调用时武装看门狗（每轮重新计时）；
   *   循环：in-flight prompt 连续无输出 ≥ watchdogNoOutputMs → kill 进程 →
   *         reconnect → 重新 prompt（无限重试）；
   *   解除/终止：① prompt 自然返回（有输出/结果/错误）→ 看门狗结束；
   *             ② child 被 agent_close（isClosed=true）→ 永久终止，抛 WATCHDOG_CLOSED；
   *             ③ child 被 interrupt（signal aborted）→ 终止进程，抛 SUBMIT_ABORTED；
   *   重新武装：后续 submit（新 round）再次武装，不受此前 interrupt 历史。
   *
   * 合法长生成区分：onActivity 实际输出（lastActivityAt）重置冻结窗口——
   * 慢网络/慢模型只要有输出就继续等待，不触发 kill。
   *
   * @param {object} remote  ACP 远程句柄
   * @param {string} task    任务文本
   * @param {string} cwd     工作目录
   * @param {object} ctx     { signal, isClosed }——isClosed 回调检查 closedChildren + abort
   * @returns {Promise<{text: string, stopReason: string}>}
   */
  async function promptWithWatchdog(remote, task, cwd, ctx) {
    const watchdogMs = Math.max(1000, Number(options.watchdogNoOutputMs) || 180000)
    const idleMs = Math.max(watchdogMs + 60000, Number(options.idleTimeoutMs) || 600000)
    let killCount = 0
    // v0.5.6：人类决策等待（授权 or 预留问答）期间视为活跃（不触发冻结/超时）；
    // virtualLast 记录最近一次"因人类等待而豁免"的检查时刻，决策落定后窗口从此刻重算。
    let virtualLast = 0
    const humanWaitNow = () => {
      try {
        const fn = options.isHumanWaitPending ?? options.isPermissionPending // 兼容旧键名
        return typeof fn === 'function' && fn(remote.sessionId)
      } catch { return false }
    }
    for (;;) {
      if (ctx.signal && ctx.signal.aborted) {
        const err = new Error(`${command} ACP prompt 被 abort 信号中断`)
        err.code = 'SUBMIT_ABORTED'
        err.product = command
        throw err
      }
      if (ctx.isClosed()) {
        const err = new Error(`${command} ACP prompt 被终止——child 已关闭（agent_close 或远程已 dispose）`)
        err.code = 'WATCHDOG_CLOSED'
        err.product = command
        throw err
      }
      // Ensure transport is alive; if dead → reconnect
      if (transportDead(remote)) {
        try {
          await reconnectRemote(remote, cwd)
          killCount++
          console.log(`product-subagents: ${command} 看门狗 reconnect（进程已死，session ${remote.sessionId?.slice(0, 8)}…，累计 kill/重连 ${killCount} 次）`)
        } catch (reconnectErr) {
          console.warn(`product-subagents: ${command} 看门狗 reconnect 失败（${reconnectErr?.message ?? reconnectErr}），将重试`)
          await new Promise((r) => setTimeout(r, 250)) // 防空转：CLI 不可用时避免紧密循环
          continue
        }
      }
      // Race: prompt vs watchdog idle vs total idle
      const startedAt = Date.now()
      let timer
      const watchdogTimeout = new Promise((_, reject) => {
        const check = () => {
          if (ctx.signal && ctx.signal.aborted) {
            reject(Object.assign(new Error(`${command} abort`), { code: '_ABORT' }))
            return
          }
          if (ctx.isClosed()) {
            reject(Object.assign(new Error(`${command} closed`), { code: '_CLOSED' }))
            return
          }
          const now = Date.now()
          // v0.5.6：正等待人类决策（授权/问答）→ 视为活跃（虚拟心跳），不触发冻结/空闲超时
          if (humanWaitNow()) {
            virtualLast = now
            const nextWait = Math.min(5000, Math.max(500, Math.floor(watchdogMs / 4)))
            timer = setTimeout(check, nextWait)
            return
          }
          const progress = remote.progressRef ? remote.progressRef() : {}
          const lastActivity = Math.max(progress.lastActivityAt || startedAt, virtualLast || 0)
          const noOutputMs = now - lastActivity
          if (noOutputMs >= watchdogMs) {
            reject(Object.assign(
              new Error(`${command} 看门狗触发：${watchdogMs}ms 无输出`),
              { code: 'WATCHDOG_FREEZE', product: command },
            ))
            return
          }
          if (noOutputMs >= idleMs) {
            reject(Object.assign(
              new Error(`${command} ACP 会话空闲超时：${idleMs}ms 无任何输出/更新`),
              { code: 'SUBMIT_TIMEOUT', product: command },
            ))
            return
          }
          const nextCheck = Math.min(5000, Math.max(500, Math.floor((watchdogMs - noOutputMs) / 4)))
          timer = setTimeout(check, nextCheck)
        }
        const firstCheck = Math.min(5000, Math.max(500, Math.floor(watchdogMs / 4)))
        timer = setTimeout(check, firstCheck)
      })
      let response
      try {
        response = await Promise.race([
          remote.connection.prompt({ sessionId: remote.sessionId, prompt: [{ type: 'text', text: task }] }),
          watchdogTimeout,
        ])
      } catch (error) {
        clearTimeout(timer)
        // Watchdog freeze: kill process → reconnect → retry prompt
        if (error && error.code === 'WATCHDOG_FREEZE') {
          killCount++
          console.warn(`product-subagents: ${command} 看门狗冻结触发（${watchdogMs}ms 无输出），kill 进程（session ${remote.sessionId?.slice(0, 8)}…，累计 ${killCount} 次）`)
          try { remote.connection?.closeSession?.({ sessionId: remote.sessionId }) } catch { /* gone */ }
          try { remote.proc?.kill('SIGKILL') } catch { /* already gone */ }
          remote.connection = null
          remote.proc = null
          try {
            await reconnectRemote(remote, cwd)
            console.log(`product-subagents: ${command} 看门狗 reconnect 成功（session ${remote.sessionId?.slice(0, 8)}…），继续等待 prompt`)
          } catch (reconnectErr) {
            console.warn(`product-subagents: ${command} 看门狗 kill→reconnect 失败（${reconnectErr?.message ?? reconnectErr}），将重试`)
            await new Promise((r) => setTimeout(r, 250)) // 防空转
          }
          continue
        }
        // Abort: clean kill + throw
        if (error && error.code === '_ABORT') {
          try { remote.connection?.closeSession?.({ sessionId: remote.sessionId }) } catch { /* gone */ }
          try { remote.proc?.kill('SIGKILL') } catch { /* already gone */ }
          remote.connection = null
          remote.proc = null
          const err = new Error(`${command} ACP prompt 被 abort 信号中断`)
          err.code = 'SUBMIT_ABORTED'
          err.product = command
          throw err
        }
        // Closed: permanent termination
        if (error && error.code === '_CLOSED') {
          const err = new Error(`${command} ACP prompt 被终止——child 已关闭`)
          err.code = 'WATCHDOG_CLOSED'
          err.product = command
          throw err
        }
        // SUBMIT_TIMEOUT (idle > idleMs even after watchdog retries): throw
        if (error && error.code === 'SUBMIT_TIMEOUT') {
          try { remote.connection?.closeSession?.({ sessionId: remote.sessionId }) } catch { /* gone */ }
          try { remote.proc?.kill('SIGKILL') } catch { /* already gone */ }
          remote.connection = null
          remote.proc = null
          throw error
        }
        // Other prompt errors: if the transport died (process exited or the
        // ACP connection closed mid-prompt), treat as freeze-equivalent:
        // kill → reconnect → retry the prompt（无限重试语义，仅 isClosed /
        // abort / SUBMIT_TIMEOUT 终止）。真正的产品/协议错误才向上抛。
        const errMsg = String((error && error.message) || error || '')
        if (transportDead(remote) || /connection closed|connection reset|ECONNRESET|socket hang up|stream closed|transport closed|broken pipe/i.test(errMsg)) {
          killCount++
          console.warn(`product-subagents: ${command} prompt 传输中断（${errMsg.slice(0, 140)}），kill→reconnect（累计 ${killCount} 次）`)
          try { remote.connection?.closeSession?.({ sessionId: remote.sessionId }) } catch { /* gone */ }
          try { remote.proc?.kill('SIGKILL') } catch { /* already gone */ }
          remote.connection = null
          remote.proc = null
          try {
            await reconnectRemote(remote, cwd)
            console.log(`product-subagents: ${command} reconnect 成功（session ${remote.sessionId?.slice(0, 8)}…），重发 prompt`)
          } catch (reconnectErr) {
            console.warn(`product-subagents: ${command} reconnect 失败（${reconnectErr?.message ?? reconnectErr}），稍后重试`)
            await new Promise((r) => setTimeout(r, 250))
          }
          continue
        }
        throw error
      }
      clearTimeout(timer)
      const rawStop = response && response.stopReason ? String(response.stopReason) : 'end_turn'
      const stopReason = rawStop === 'end_turn' ? 'completed' : rawStop
      const text = remote.drainText()
      if (!text || !text.trim()) {
        throw Object.assign(new Error(`${command} 返回空正文（会话存活但无文本输出；stopReason=${stopReason}）`), {
          code: 'EMPTY_RESPONSE', product: command, stopReason,
        })
      }
      return { text, stopReason }
    }
  }

  return {
    async create(cwd) {
      const handle = await connect(cwd)
      let session
      try {
        session = await handle.connection.newSession({ cwd, mcpServers: [] })
      } catch (error) {
        killOrphan(handle.proc) // 会话都没建成 → 这个进程再没人引用
        throw error
      }
      handle.sessionId = session.sessionId
      handle.progressRef = handle.progress
      const remote = buildRemote(handle)
      // 静默写入：此刻 childId 还不存在（binding 由调用方在 create 之后建立），
      // 首次透出发生在 lib/index.js 的 prepareContinuable 里。
      setConfigOptions(remote, session.configOptions)
      return remote
    },
    async submit(remote, task, signal, cwd, settings = {}, isClosed = () => false) {
      await applySettings(remote, settings)
      const rpm = Number(options.requestsPerMinute) || 0
      const slotIntervalMs = rpm > 0 ? Math.max(1, Math.round(60000 / rpm)) : 0
      const maxRateRetries = options.rateLimitRetries !== undefined
        ? Math.max(0, Number(options.rateLimitRetries))
        : 3
      const rateBackoffMs = Math.max(1000, Number(options.rateLimitBackoffMs) || 60000)
      let rateAttempt = 0
      const promptCtx = { signal, isClosed }
      for (;;) {
        if (signal && signal.aborted) {
          const err = new Error(`${command} ACP prompt 被 abort 信号中断`)
          err.code = 'SUBMIT_ABORTED'
          err.product = command
          throw err
        }
        if (isClosed()) {
          const err = new Error(`${command} ACP prompt 被终止——child 已关闭`)
          err.code = 'WATCHDOG_CLOSED'
          err.product = command
          throw err
        }
        await acquireSlot(command, slotIntervalMs)
        try {
          const result = await promptWithWatchdog(remote, task, cwd, promptCtx)
          reportSuccess(command)
          return result
        } catch (error) {
          attachStderr(error, remote)
          if (isRateLimited(error)) {
            const cooldownMs = reportRateLimited(command, rateBackoffMs)
            if (rateAttempt < maxRateRetries) {
              console.warn(`product-subagents: ${command} 触发限流(${error.message || error})，熔断冷却 ${cooldownMs}ms 后重试 (${rateAttempt + 1}/${maxRateRetries})`)
              rateAttempt += 1
              continue
            }
            console.warn(`product-subagents: ${command} 触发限流且重试预算耗尽(${maxRateRetries} 次)，任务判失败；熔断已开启(${cooldownMs}ms)`)
            throw error
          }
          // SUBMIT_ABORTED / WATCHDOG_CLOSED / SUBMIT_TIMEOUT / EMPTY_RESPONSE:
          // all are terminal for this submit — surface to caller.
          throw error
        }
      }
    },
    async reconnect(sessionId, cwd) {
      const handle = await connect(cwd)
      let id = sessionId
      let nextOptions
      try {
        // session/load must carry cwd + mcpServers (strict agents like
        // deveco/opencode validate params and would reject sessionId alone).
        const loaded = await handle.connection.loadSession({ sessionId: id, cwd, mcpServers: [] })
        nextOptions = loaded && loaded.configOptions
      } catch (error) {
        if (id) console.warn(`product-subagents: session/load failed for ${id} (${error && error.message ? error.message : error}); starting a new session`)
        // the agent does not support loadSession (negotiated per child) or
        // the session is gone: fall back to a fresh session
        let session
        try {
          session = await handle.connection.newSession({ cwd, mcpServers: [] })
        } catch (inner) {
          killOrphan(handle.proc) // load 与 new 双双失败：进程已无人引用
          throw inner
        }
        id = session.sessionId
        nextOptions = session.configOptions
      }
      handle.sessionId = id
      handle.progressRef = handle.progress
      const remote = buildRemote(handle)
      // 与 create 同理：调用方（product_submit 恢复路径）在 bindings 写好后
      // 才会透出，这里只落快照，避免发出 childId 缺失的事件。
      setConfigOptions(remote, nextOptions)
      return remote
    },
    async dispose(remote) {
      try {
        await remote.connection.closeSession({ sessionId: remote.sessionId })
      } catch {
        // already closed or the process is gone
      }
      try {
        remote.proc.kill('SIGTERM')
      } catch {
        // already gone
      }
    },
  }
}
