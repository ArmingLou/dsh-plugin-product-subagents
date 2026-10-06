/**
 * v0.7.9（复审修复）：**执行类帧判定与命令正文取值的单点**。
 *
 * 为什么要有这个模块：`lib/bridges/acp.js` 的路径兜底扫描（`scanExecuteCommandPaths`）
 * 与 `lib/dangerous-commands.js` 的危险命令门（`dangerousExecuteMatch`）都要回答
 * 同一个问题——「这一帧是不是执行类请求、它的命令正文是什么」。此前两处各写一份，
 * 口径已经漂移：危险门把「取得到 `rawInput.command`」也算执行类（不看 `kind`），
 * 而路径层对 `kind` 明确非执行类的帧**一票否决**。现场反例：
 * `{kind:'edit', rawInput:{command:'rm -rf /tmp/x'}}` 在危险门里命中、在路径层被否，
 * 同一个载荷两处给出相反答案（复审 M-2）。
 *
 * 本模块把这两件事收敛成**一份**实现（口径改动只需改这里）。
 *
 * ## ⚠️ 有意的不对称：**门宁可多问，路径宁可少授权**（两个调用方**不是**同一口径）
 *
 * 第三轮复审抓到：把「两处必须一致」当成目标，会让危险门跟着 `kind` 一起退化成
 * 非执行类就一票否决 —— 于是 `{kind:'other', name:'bash', title:'bash',
 * rawInput:{command:'rm -rf /tmp/build'}}` 在门上判 null ⇒ 门整档关闭 ⇒
 * `lib/index.js` 的 `!danger` 分支把 session/disk/workspace 三档全部推入 ⇒
 * 命中会话级工具名授权后**静默放行**（复审实测：一条 pending 事件都不发）。
 * 仓库自己的 fixture 就是把 bash 帧建模成 `kind:'other'`（
 * `test/permission-handler-wiring.test.js` 的 `BASH`），opencode 的真实载荷从未抓到
 * ⇒ 无法排除「某产品用非执行类 kind 发 shell」。
 *
 * 故两者的口径**刻意**不同，且这个不对称是设计要求，不是遗漏：
 *
 *   · **危险命令门（`dangerousExecuteMatch`，要一个布尔）**：`kind` 前置**一律取消**。
 *     只要请求里存在**命令字段**（`rawInput.command` / `arguments.command`，字符串或
 *     对象两种形状）就把正文交给规则判一遍 —— 门的产物只是「**要不要多问一次**」，
 *     多问一次是安全方向（最坏是多弹一个窗，`kind` 写错的代价是问到用户，不是放行）。
 *   · **路径兜底（`scanExecuteCommandPaths`，产出会**自动变成规则**的路径集合）**：
 *     `kind` 前置**保持严格** —— `kind` 明确非执行类即一票否决，即便夹带命令字段也不扫。
 *     这里放宽会把「文件正文里的命令字符串」当成授权客体写进会话/落盘规则，
 *     方向是 fail-open，绝对不行。
 *
 * 一句话：**门宁可多问，路径宁可少授权。** 改这两处中任何一处之前，先读这段。
 *
 * ## 执行类判定（`isExecuteFrame`，只服务路径侧与「title/content 是否可信」）
 *
 *   · `kind` 有值且属执行类 slug（execute/exec/shell/bash/command） ⇒ 执行类；
 *   · `kind` 有值但不属执行类（edit/read/write/…） ⇒ **否**（一票否决，哪怕夹带
 *     `command` 字段：那是文件正文/代码内容，不是本次要执行的命令）；
 *   · `kind` 缺失/空白 ⇒ 用 `name`/`title` 的执行类 slug 兜底（Claude/Codex 老模型
 *     不带 kind，只给 `name:'shell'` 这类形态）。
 *
 * ## 命令正文的取值来源（有序清单）
 *
 * 两处调用方各自声明接受的前缀子集（`executeCommandText(toolCall, sources)`）：
 *
 *   1. `'rawInput.command'`       —— qoder 实测形态（kind=execute，与 content 同值）
 *   2. `'arguments.command'`      —— 老模型：`arguments` 是对象**或** JSON 字符串
 *      （复审 M-1：危险门此前不认这一来源，`{name:'shell', arguments:'{"command":
 *      "git push --force"}'}` 取不到正文 ⇒ 判 null ⇒ 工具名档短路 ⇒ 门失效）
 *   3. `'content[].content.text'` —— 执行类帧的内容块里装的就是命令正文
 *   4. `'title'`                  —— qoder 的 title 是整条命令正文
 *
 * **1、2 是「命令字段」，与 `kind` 无关（门无条件读）；3、4 只在执行类帧下可信**
 * （`title`/content 在别的产品里可能是描述文字或被编辑文件的正文 ——
 * 现场：`{kind:'edit', title:'写入 rm -rf.sh', rawInput:{file_path, content}}`
 * 的正文里出现 `rm -rf` 是**文件内容**，判危险会天天误伤），故 3、4 仍要求
 * `isExecuteFrame` 成立。
 *
 * 路径兜底扫描只认 1、2（命令**字段**）**且**要求执行类帧，不认 3、4：把它当路径
 * 来源等于从散文里猜授权路径（正是缺口D 要关掉的面）。危险门认全部四条
 * （产物只是"是否危险"这一个布尔，最坏是多弹一次窗，方向安全）。
 */

/** 被视为「执行类」的 kind / name / title 取值（单点，两处调用方共用） */
export const EXECUTE_KIND_SLUGS = new Set(['execute', 'exec', 'shell', 'bash', 'command'])

/** 命令正文的全部取值来源（有序）。调用方按前缀子集取用，见文件头说明。 */
export const COMMAND_SOURCES = ['rawInput.command', 'arguments.command', 'content[].content.text', 'title']

/**
 * 其中的**命令字段**：取值与 `kind` 无关（危险门无条件读 —— 门宁可多问，见文件头
 * 的"有意的不对称"）。路径侧虽然也用这两个名字，但**要求执行类帧**才会走到它们。
 */
export const COMMAND_FIELD_SOURCES = ['rawInput.command', 'arguments.command']

/** 只认自身属性：原型链上的同名字段不是载荷写下的信息 */
function own(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  // 纯防御（复审 nit-2）：带 throwing getter 的载荷对象会让 `obj[key]` 抛。
  // 当前不可达（载荷经 JSON-RPC 反序列化，唯一生产调用点在 `lib/index.js:260` 的
  // try 内、异常收敛为 deny），但这层不该指望调用方兜。
  try {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
  } catch {
    return undefined
  }
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() ? value : ''
}

/**
 * 这一帧是不是执行类请求（口径单点，见文件头）。
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @returns {boolean}
 */
export function isExecuteFrame(toolCall) {
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : null
  if (!tool) return false
  const kind = nonBlankString(own(tool, 'kind')).trim().toLowerCase()
  if (kind) return EXECUTE_KIND_SLUGS.has(kind)
  const nameSlug = (nonBlankString(own(tool, 'name')) || nonBlankString(own(tool, 'title'))).trim().toLowerCase()
  return EXECUTE_KIND_SLUGS.has(nameSlug)
}

/** `content: [{ content: { text } }, …]` 里第一段非空白文本（只认自身属性） */
function firstContentText(content) {
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const text = nonBlankString(own(own(item, 'content'), 'text'))
    if (text) return text
  }
  return ''
}

/** 单个来源的读取（`arguments` 是 JSON 字符串时先 parse，与旧实现同口径） */
function readCommandSource(tool, source) {
  if (source === 'rawInput.command') return nonBlankString(own(own(tool, 'rawInput'), 'command'))
  if (source === 'arguments.command') {
    let args = own(tool, 'arguments')
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { args = null }
    }
    if (args && typeof args === 'object' && !Array.isArray(args)) return nonBlankString(own(args, 'command'))
    return ''
  }
  if (source === 'content[].content.text') return firstContentText(own(tool, 'content'))
  if (source === 'title') return nonBlankString(own(tool, 'title'))
  return ''
}

/**
 * 命令正文 + 命中的来源字段名（**单点实现，被门与路径侧共用**）。
 *
 * ## ⚠️ 调用方必须自己声明口径（第三轮复审 B-1：这里**不能**隐式放宽）
 *
 * 本函数是**两个方向相反**的调用方共用的取值器，故它只做「按你想要的口径取值」，
 * 不替调用方决定「非执行类帧要不要判」：
 *
 *   · **危险门**（`dangerousExecuteMatch`）要 fail-safe：命令字段（`rawInput.command` /
 *     `arguments.command`）**与 `kind` 无关**——只要请求里存在命令字段就拿它跑规则。
 *     门回答的只是「要不要多问一次」，多问一次是安全方向（`kind` 写成 `'other'`、
 *     漏了、或某产品用非执行类 kind 发 shell，都只该让门多问一次，不该让门整档关闭）。
 *   · **路径兜底**（`scanExecuteCommandPaths`）要 fail-closed：它的产物是**唯一**能
 *     自动变成规则的路径集合，`kind` 明确非执行类时**一票否决**（哪怕夹带命令字段）。
 *     故它**额外**用 `requireExecuteFrame: true` 声明这一条 —— 见下面的选项说明。
 *
 * 取值顺序（source 清单内的顺序）：
 *   1. 命令字段（`rawInput.command` → `arguments.command`）：老模型 `arguments` 是
 *      对象**或** JSON 字符串；`rawInput.command` 是 qoder 实测形态。
 *   2. 文本来源（`content[].content.text` → `title`）：**只在执行类帧下可信** ——
 *      非执行类帧里这两条是描述文字或被编辑文件的正文（现场：`{kind:'edit',
 *      title:'写入 rm -rf.sh', rawInput:{file_path…, content:'rm -rf /'}}` 的正文
 *      不是命令），放宽会天天误伤。因此**文本来源恒以 `isExecuteFrame` 为前置**，
 *      与调用方声明的口径无关。
 *
 * 全部来源都取不到正文 ⇒ `null`（调用方各自 fail-safe）。
 *
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @param {string[]} [sources] 允许的来源（有序子集，见文件头；缺省 = 全部四条）
 * @param {{requireExecuteFrame?: boolean}} [options] `requireExecuteFrame: true` ⇒
 *   连**命令字段**也要求 `isExecuteFrame` 成立（路径兜底用；缺省 false = 门的 fail-safe 口径）
 * @returns {{text: string, source: string}|null}
 */
export function executeCommandText(toolCall, sources = COMMAND_SOURCES, options = {}) {
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : null
  if (!tool) return null
  const allowed = Array.isArray(sources) ? sources : []
  const requireExecuteFrame = options && options.requireExecuteFrame === true
  // ① 命令字段：默认**不被 `kind` 前置否决**（B-1 阻断的修复点）；路径侧显式要求执行类帧
  if (!requireExecuteFrame || isExecuteFrame(tool)) {
    for (const source of allowed) {
      if (!COMMAND_FIELD_SOURCES.includes(source)) continue
      const text = readCommandSource(tool, source)
      if (text) return { text, source }
    }
  }
  // ② 文本来源（content / title）：恒以 isExecuteFrame 为前置（见上方说明）
  if (!isExecuteFrame(tool)) return null
  for (const source of allowed) {
    if (COMMAND_FIELD_SOURCES.includes(source)) continue
    const text = readCommandSource(tool, source)
    if (text) return { text, source }
  }
  return null
}
