/**
 * v0.7.9：权限规则的**单一评估器**（用户裁决「统一模型」）。
 *
 * 一条规则 = `{ cwd, paths[], tools[] }`（外加既有的 `categories[]`——无路径请求
 * 的会话期记忆维度，语义不变）。三个来源喂同一个评估函数：
 *   ① 落盘 `~/.dsh/data/dsh-plugin-product-subagents/allowlist.json`（跨会话）
 *   ② 内存会话规则（主代理会话内）
 *   ③ 工作区默认规则（`{ cwd, paths: [cwd] }`，自动，无需用户授权）
 *   ④ provider `allowWritePaths`（配置声明、无 cwd ⇒ 通配）也走同一条路，
 *      避免"两套判断逻辑对同一份语义给出不同答案"。
 *
 * 语义变化（均为**放宽**，CHANGELOG 有标注）：
 *   · `paths` = **目录子树**：请求路径等于规则路径、或落在规则路径之下（按路径
 *     分隔符对齐边界，`/a/b` 不命中 `/a/bc`）即命中；不再是"请求集合 ⊆ 存储集合"
 *     的字面全等。规则路径是目录（显式 `/`、`/**`、`/*` 结尾，或 statSync 判定）
 *     时整棵子树命中；是文件时只命中自身。
 *   · `tools` = 工具名档：命中条件「请求 cwd 与规则 cwd 全等 **且** 解析出的工具名
 *     ∈ tools」，与本次路径无关。工具名必须带产品前缀（`"qoder:Bash"`），裸工具名
 *     （`"Bash"`）只在规则自带 `product` 字段时补前缀——补不出就不参与匹配，
 *     绝不退化成"所有产品通用"（不变式③：qoder 的 Bash 不得放行 deveco 的 Bash）。
 *
 * 保守面：
 *   · `..` 与软链**都先解析再比较**：`/proj/a/../../etc/passwd` 归一后是
 *     `/etc/passwd`，不在 `/proj` 子树内；`/proj/link/x`（link→/etc）经 realpath
 *     后是 `/etc/x`，同样不命中 `/proj`。请求路径的尾段可以不存在（写入新文件），
 *     此时只对"最近的存在祖先"做 realpath 再拼回剩余段。
 *   · 请求**没有任何路径**时，路径档永不命中（无从证明落在授权范围内）；
 *     部分覆盖 ⇒ 该条规则不命中（继续看下一条，但绝不会因"覆盖了一半"而放行）。
 *   · cwd 作用域**只单向收紧**：规则带 cwd 时请求必须带着解析后全等的 cwd 才算命中
 *     （请求 cwd 缺失不得消费项目级规则）；只有规则不带 cwd（provider 白名单、
 *     缺 cwd 时写入的会话规则）才按通配处理。
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeCandidate } from './allowlist.js'

/** title/kind 里不承担类别语义的值（opencode 常把 kind 固定成 'other'）。
 *  定义在叶子模块，供 permission-state 与本模块共用——占位值既不能当类别，
 *  也不能当工具名（写入等于通配授权）。 */
export const UNINFORMATIVE_CATEGORY = new Set(['other', 'unknown', 'default', 'misc', ''])

/** 规则/请求路径归一：展开 ~、去尾部标点与分隔符；可给 baseDir 解相对路径。
 *  `.` / `./` 按"工作区自身"解释（用户要求「整棵工作区」必须可表达）。 */
export function canonicalPath(raw, baseDir = null) {
  let p = normalizeCandidate(raw)
  if (!p) return null
  if (p === '.' || p === './' || p === '..' || p.startsWith('../') || p.startsWith('./')) {
    const base = typeof baseDir === 'string' && baseDir.trim() ? normalizeCandidate(baseDir) : null
    if (!base || !path.isAbsolute(base)) return null
    p = path.join(base, p)
  }
  if (!path.isAbsolute(p)) return null
  return p.replace(/[/\\]+$/, '') || p
}

function tryRealpath(p, fsImpl) {
  try {
    const r = fsImpl.realpathSync(p)
    return typeof r === 'string' && r ? r.replace(/[/\\]+$/, '') || r : null
  } catch {
    return null
  }
}

/**
 * 解析到"真身"路径：先整体 realpath；失败（尾段尚不存在）则逐级上溯到最近的
 * 存在祖先做 realpath，再把剩余段拼回。
 * 为什么不能直接 path.normalize：normalize 会把 `link/..` 折成字面同级，
 * 而 POSIX 下 `..` 是**解析软链之后**的父目录——`/proj/link/../x`（link→/etc）
 * 的真身是 `/etc/x`。软链出界必须不命中，就得按后一种语义算。
 */
export function resolveRealPath(absPath, fsImpl = fs) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null
  const whole = tryRealpath(absPath, fsImpl)
  if (whole) return whole
  let cursor = absPath
  const tail = []
  for (let guard = 0; guard < 128; guard += 1) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    tail.unshift(path.basename(cursor))
    cursor = parent
    const real = tryRealpath(cursor, fsImpl)
    if (real) return path.normalize(path.join(real, ...tail))
  }
  return path.normalize(absPath)
}

/**
 * 规则路径 → 匹配子句。
 * kind='dir' 走子树命中，kind='file' 只命中自身。判定顺序：显式目录写法
 * （`/a/b/`、`/a/b/**`、`/a/b/*`）> 磁盘真相（statSync）> 字面启发式
 * （ basename 无扩展名按目录，与 v0.4.0 `pathAllowed` 宽容度一致，避免既有
 *  provider 规则在改版后失效）。
 */
export function compileRulePath(rawRule, { baseDir = null, fsImpl = fs } = {}) {
  if (typeof rawRule !== 'string' || !rawRule.trim()) return null
  const src = rawRule.trim().replace(/^["']|["']$/g, '')
  let body = src
  let explicitDir = false
  const glob = body.match(/[/\\](\*\*|\*)$/)
  if (glob) {
    explicitDir = true
    body = body.slice(0, glob.index)
  } else if (/[/\\]$/.test(body) && body.length > 1) {
    explicitDir = true
  }
  const canon = canonicalPath(body, baseDir)
  if (!canon) return null
  const value = resolveRealPath(canon, fsImpl)
  if (!value) return null
  let kind = explicitDir ? 'dir' : null
  if (!kind) {
    let st = null
    try { st = fsImpl.statSync(value) } catch { /* 不存在：按字面启发式 */ }
    if (st) kind = st.isDirectory() ? 'dir' : 'file'
    else kind = /\.[A-Za-z0-9]{1,8}$/.test(path.basename(value)) ? 'file' : 'dir'
  }
  return { raw: rawRule, value, kind }
}

/** 请求路径 → 真身（相对路径按 baseDir 解析；解析不出返回 null = 无法证明在范围内） */
export function resolveRequestPath(rawPath, { baseDir = null, fsImpl = fs } = {}) {
  const canon = canonicalPath(rawPath, baseDir)
  if (!canon) return null
  return resolveRealPath(canon, fsImpl)
}

/** 单个请求路径是否被某条子句覆盖 */
export function pathMatchesClause(reqReal, clause) {
  if (!reqReal || !clause || !clause.value) return false
  if (reqReal === clause.value) return true
  if (clause.kind !== 'dir') return false
  // 目录边界：只接受 `<dir>/<子路径>`，拒绝 `/a/b` 命中 `/a/bc`
  return reqReal.startsWith(clause.value.endsWith(path.sep) ? clause.value : clause.value + path.sep)
}

/** 请求路径集相对一组规则路径的覆盖情况（`allowed` = 有路径且**全部**覆盖） */
export function coverage(reqPaths, rulePaths, { baseDir = null, fsImpl = fs } = {}) {
  const paths = Array.isArray(reqPaths) ? reqPaths.filter((p) => typeof p === 'string' && p.trim()) : []
  const clauses = (Array.isArray(rulePaths) ? rulePaths : [])
    .map((r) => compileRulePath(r, { baseDir, fsImpl }))
    .filter(Boolean)
  const covered = []
  const uncovered = []
  for (const p of paths) {
    const real = resolveRequestPath(p, { baseDir, fsImpl })
    const hit = !!real && clauses.some((c) => pathMatchesClause(real, c))
    ;(hit ? covered : uncovered).push(p)
  }
  return { allowed: paths.length > 0 && uncovered.length === 0, covered, uncovered }
}

/** `product:toolName` 归一化授权键（与 v0.7.6 addToolGrant 同构） */
export function toolGrantKey(product, toolName) {
  const p = typeof product === 'string' ? product.trim().toLowerCase() : ''
  const t = typeof toolName === 'string' ? toolName.trim().toLowerCase() : ''
  if (!p || !t) return null
  if (UNINFORMATIVE_CATEGORY.has(t)) return null
  return `${p}:${t}`
}

/**
 * 规则里的 tools → 归一化授权键集合。
 * 带前缀（`qoder:Bash`）原样归一；裸名（`Bash`）只在规则自带 product 时补前缀，
 * 补不出（既无前缀又无 product）则丢弃——不匹配任何请求，而不是匹配所有产品。
 */
export function compileRuleTools(tools, ruleProduct) {
  const out = new Set()
  for (const entry of Array.isArray(tools) ? tools : []) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const s = entry.trim()
    const i = s.indexOf(':')
    if (i >= 0) {
      // 只有 `product:name` 这一种带前缀写法认；`:x` / `x:` / `a:b:c` 之类是脏数据，
      // 丢弃——否则会归一成 "qoder::x" 这种永远匹配不上的键，掩盖规则写错了的事实。
      const head = s.slice(0, i)
      const tailName = s.slice(i + 1)
      if (!head || !tailName || tailName.includes(':')) continue
      const key = toolGrantKey(head, tailName)
      if (key) out.add(key)
      continue
    }
    const key = toolGrantKey(ruleProduct, s)
    if (key) out.add(key)
  }
  return [...out]
}

/** cwd 全等判定（两侧都做真身解析：同一目录的不同写法/软链入口不该被当成两个项目） */
export function sameCwd(a, b, fsImpl = fs) {
  const ra = typeof a === 'string' && a.trim() ? resolveRealPath(canonicalPath(a) || a, fsImpl) : null
  const rb = typeof b === 'string' && b.trim() ? resolveRealPath(canonicalPath(b) || b, fsImpl) : null
  if (!ra || !rb) return false
  return ra === rb
}

/**
 * 单条规则是否覆盖本次请求。判定顺序：工具名档 → 路径档 → 类别档。
 * @param rule {cwd?:string|null, paths?:string[], tools?:string[], categories?:string[], product?:string|null}
 * @param request {product, toolName, cwd, paths[], categoryKey}
 * @returns {{hit:boolean, via:string|null, covered:string[], uncovered:string[]}}
 */
export function ruleCoversRequest(rule, request, { fsImpl = fs } = {}) {
  const r = rule && typeof rule === 'object' ? rule : {}
  const req = request && typeof request === 'object' ? request : {}
  const paths = Array.isArray(req.paths) ? req.paths : []
  // cwd 作用域是**单向**收紧：规则写了 cwd，请求就必须带着同一个 cwd——请求 cwd
  // 取不到时不得消费项目级规则（落盘规则的"项目级隔离"是既有安全属性，
  // 见 test/user-allowlist.test.js「无 cwd → false」）。只有规则本身没有 cwd
  // （provider 白名单、缺 cwd 时写入的会话规则）才按通配处理。
  const cwdOk = !r.cwd || sameCwd(r.cwd, req.cwd, fsImpl)
  if (cwdOk && Array.isArray(r.tools) && r.tools.length > 0) {
    const key = toolGrantKey(req.product, req.toolName)
    if (key && compileRuleTools(r.tools, r.product).includes(key)) {
      return { hit: true, via: 'tools', covered: [], uncovered: [] }
    }
  }
  const baseDir = r.cwd || req.cwd || null
  if (cwdOk && paths.length > 0 && Array.isArray(r.paths) && r.paths.length > 0) {
    const c = coverage(paths, r.paths, { baseDir, fsImpl })
    if (c.allowed) return { hit: true, via: 'paths', covered: c.covered, uncovered: [] }
    return { hit: false, via: null, covered: c.covered, uncovered: c.uncovered }
  }
  if (cwdOk && paths.length === 0 && Array.isArray(r.categories) && r.categories.length > 0) {
    const key = typeof req.categoryKey === 'string' ? req.categoryKey.trim().toLowerCase() : ''
    if (key && r.categories.some((c) => typeof c === 'string' && c.trim().toLowerCase() === key)) {
      return { hit: true, via: 'category', covered: [], uncovered: [] }
    }
  }
  return { hit: false, via: null, covered: [], uncovered: [] }
}

/**
 * 遍历所有来源，第一条覆盖即放行（顺序 = 调用方传入顺序）。
 * @param sources {tier: string, rules: object[]}[]
 * @returns {{allowed:boolean, tier:string|null, via:string|null, rule:object|null,
 *            covered:string[], uncovered:string[]}}
 */
export function evaluateRuleSources(sources, request, { fsImpl = fs } = {}) {
  let best = null
  for (const src of Array.isArray(sources) ? sources : []) {
    const rules = Array.isArray(src && src.rules) ? src.rules : []
    for (const rule of rules) {
      const verdict = ruleCoversRequest(rule, request, { fsImpl })
      if (verdict.hit) {
        return { allowed: true, tier: src.tier, via: verdict.via, rule, covered: verdict.covered, uncovered: [] }
      }
      if (verdict.covered.length > 0 && (!best || verdict.covered.length > best.covered.length)) {
        best = { tier: src.tier, ...verdict }
      }
    }
  }
  const reqPaths = Array.isArray(request && request.paths) ? request.paths : []
  return {
    allowed: false,
    tier: null,
    via: null,
    rule: null,
    covered: best ? best.covered : [],
    uncovered: best && best.uncovered.length > 0 ? best.uncovered : reqPaths,
  }
}

/** 工作区默认规则（追加3）：`paths = [cwd]` ⇒ 整棵工作区子树。cwd 缺失则无规则。 */
export function workspaceRuleOf(cwd) {
  const canon = canonicalPath(cwd)
  if (!canon) return []
  return [{ cwd: canon, paths: [canon], tools: [], categories: [] }]
}

/**
 * v0.7.9 缺口A：词法根目录判定（`/`、`C:\`、`\\` UNC 根都算）。
 * 根目录一旦写进授权集 = 该会话内任意路径免弹，必须单独拒掉。
 */
function isFileSystemRoot(absPath) {
  return !!absPath && path.dirname(absPath) === absPath
}

/**
 * v0.7.9 缺口A：**不可盲信客户端**——dispatch 弹框回传的 `paths` 在服务端重新校验。
 *
 * 只认「非空字符串 + 绝对路径」，做**词法**规范化（解析 `.`/`..`、去尾部分隔符、
 * 展开 `~`），不做 realpath（客户端声明的是目录意图，不是磁盘真相；跟着软链走
 * 反而会把授权挪到链外）。规则：
 *   · 非字符串 / 空串 / 纯空白 / 含 NUL / 相对路径 / 规范化后是文件系统根 ⇒ 丢弃；
 *   · 逐条丢弃并记录原因（供日志如实归因），**全被丢弃 ⇒ 与 `[]` 同义**（只写工具档）；
 *   · 未给（非数组）与给了空数组必须可区分：前者 = 老客户端 = 沿用自动分析。
 *
 * @param {unknown} raw 决策载荷里的 `paths`
 * @returns {{given: boolean, declared: string[], dropped: {reason: string, value: string}[]}}
 */
export function validateDeclaredPaths(raw) {
  const given = Array.isArray(raw)
  const declared = []
  const dropped = []
  if (!given) return { given, declared, dropped }
  for (const entry of raw) {
    const label = typeof entry === 'string' ? entry : `${typeof entry}:${String(entry).slice(0, 80)}`
    if (typeof entry !== 'string') {
      dropped.push({ reason: '非字符串', value: label })
      continue
    }
    const trimmed = entry.replace(/^["']|["']$/g, '').trim()
    if (!trimmed) {
      dropped.push({ reason: '空字符串', value: label })
      continue
    }
    if (trimmed.includes('\0')) {
      dropped.push({ reason: '含 NUL', value: label })
      continue
    }
    if (trimmed.includes('\r') || trimmed.includes('\n')) {
      dropped.push({ reason: '含换行', value: label })
      continue
    }
    const expanded = normalizeCandidate(trimmed)
    if (!expanded || !path.isAbsolute(expanded)) {
      dropped.push({ reason: '非绝对路径', value: label })
      continue
    }
    const norm = path.resolve(expanded).replace(/[/\\]+$/, '') || path.sep
    if (isFileSystemRoot(norm)) {
      dropped.push({ reason: '根目录', value: label })
      continue
    }
    if (!declared.includes(norm)) declared.push(norm)
  }
  return { given, declared, dropped }
}

/**
 * v0.7.9 缺口A：授权写入的**单一判定点**（paths 与 tools 互斥，用户明确定）。
 *
 * 三条出口，且只有这三条：
 *   · `legacy` —— 客户端**没给** `paths`（老 client / 老事件）⇒ 完全沿用改动前的
 *     自动分析行为：路径档 + 工具名档照旧一起写。向后兼容是明示要求，
 *     回归守卫用例「paths 缺省 ⇒ 行为与改动前一致」钉住它。
 *   · `paths`  —— 给了且**最终路径列表非空** ⇒ 只写路径档，工具档一律不写。
 *   · `tools`  —— 给了且**为空**（`[]` 或全被服务端校验丢弃）⇒ 只写工具档，
 *     一条路径都不写。
 *
 * 为什么 `paths` 出口必须绕开 `expandPathsWithParents`：自动分析给的是**文件**
 * 路径，取父目录是为了「兄弟文件不再弹窗」；客户端给的已经是目录，再取一次父目录
 * 会把「放行 /tmp/newproj」放大成「放行 /tmp」——目录不存在时（新建工程是常态）
 * statSync 失败会被当成文件，放大得更狠。所以声明目录按**字面目录**写入。
 *
 * @param {unknown} rawDeclaredPaths 决策载荷里的 `paths`（null/undefined = 未给）
 * @param {string[]} autoPaths 自动分析出的请求路径（仅 legacy 出口使用）
 * @param {{product?: string|null, toolName?: string|null}} [toolCtx]
 * @returns {{mode: 'legacy'|'paths'|'tools', source: 'auto'|'user', paths: string[],
 *            toolKey: string|null, dropped: {reason: string, value: string}[], expand: boolean}}
 */
export function planGrantWrites(rawDeclaredPaths, autoPaths, toolCtx = {}) {
  const check = validateDeclaredPaths(rawDeclaredPaths)
  if (!check.given) {
    // 老客户端：原样把自动分析结果交给既有写入逻辑，一个字节都不改（不过滤、不重排）。
    const auto = Array.isArray(autoPaths) ? autoPaths : []
    return { mode: 'legacy', source: 'auto', paths: auto, toolKey: null, dropped: [], expand: true }
  }
  if (check.declared.length > 0) {
    return { mode: 'paths', source: 'user', paths: check.declared, toolKey: null, dropped: check.dropped, expand: false }
  }
  const key = toolGrantKey(toolCtx.product, toolCtx.toolName)
  return { mode: 'tools', source: 'user', paths: [], toolKey: key, dropped: check.dropped, expand: false }
}

/**
 * v0.7.9 缺口B：请求路径 → dispatch 弹框预填的**目录**集合。
 * 「取父目录 + 去重 + 规范化」：文件取其父目录，已存在的目录保留自身
 * （与 `expandPathsWithParents` 的判定同构，避免把一个目录莫名升到它的上一级）。
 * 只做展示/预填用途——写规则时用的仍是 `planGrantWrites` 的结果，本函数的输出
 * **不会**被服务端当授权依据；根目录同样丢弃。
 *
 * v0.7.9 缺口D 修正（语义收窄，入参来源被约束）：本函数的输入**只允许**来自
 * `extractPaths` 的**结构化**结果——diff 块 `content[].path`、
 * `rawInput.file_path`/`rawInput.path`、`locations[].path`，以及 `kind==='execute'`
 * 时从 `rawInput.command` 识别出的路径，即"本次请求实际触达的目录"。
 *
 * 弹框形态（用户定稿）：**没有勾选框**，是一个「每行一个路径」的可编辑文本框，
 * 预填 `suggestedDirs` 后接 `inferredDirs`，用户手动改行/删行（删一行即去掉该项，
 * 也可以把某行改成更上层的目录）。两个字段仍然分开，用途是**日志归因**与
 * 「`paths` 缺省时的自动分析只用结构化结果」这条规则——不是勾选状态。
 */
export function suggestedDirs(paths, { fsImpl = fs } = {}) {
  const out = []
  for (const raw of Array.isArray(paths) ? paths : []) {
    const canon = canonicalPath(raw)
    if (!canon || isFileSystemRoot(canon)) continue
    let isDir = false
    try { isDir = fsImpl.statSync(canon).isDirectory() } catch { /* 不存在按文件处理 */ }
    const dir = isDir ? canon : path.dirname(canon)
    if (dir && !isFileSystemRoot(dir) && !out.includes(dir)) out.push(dir)
  }
  return out
}

/**
 * v0.7.9 缺口D 修正：正文/命令文本**推测**出的目录 —— 弹框预填里排在
 * `suggestedDirs` **之后**的那几行（用户定稿：无勾选框，全部候选都预填、都可手编，
 * 靠**删行**去掉不要的项）。
 *
 * 为什么要单独一档（而不是直接拼进 `suggestedDirs`）：被编辑的文件正文是**内容**，
 * 不是意图。仓库里任何文件都可以写下 `/etc/passwd`、`~/.ssh/id_rsa`、
 * `~/.qoder/settings.json` 这类字符串，旧版（0.7.8 的 `scanPathsLoose` 兜底）会把
 * 它们当成"请求路径"送进规则写入。分成两档之后：
 *   ① `paths` **缺省**时（老客户端、或宿主没回传该字段）的自动分析只用结构化结果，
 *     正文假路径**不可能**被自动写成规则；
 *   ② 日志与 UI 能区分"实际触达"与"文本推测"，用户知道哪些行该重点看一眼。
 * ⚠️ 残留风险（用户已知并选择的形态）：既然推测项也被**预填**，用户不改不删就点确认，
 *   这些目录仍会经 `paths` 通道落进规则（还要过 `validateDeclaredPaths`：绝对路径、
 *   拒 `/`、非法逐条丢弃）。这一条由"删行"这一人工动作兜底，服务端不再假装能识别
 *   哪一行来自正文；危险命令门（`lib/dangerous-commands.js`）是另一道独立闸门。
 *
 * 不变的安全性质（`test/permission-handler-wiring.test.js` 钉住）：
 *   ① 本函数的输出**绝不**进入任何**自动**规则写入路径（`planGrantWrites` 的
 *     `autoPaths`、`sessionRules.add`、`appendUserRule`、`tools` 档判定一律只用结构化
 *     结果）；用户删改后显式回传的 `paths` 是另一条通道，不受本条约束；
 *   ② 输出与 `structuredDirs` **不重复**（同一目录预填两遍会让人以为要删两次）；
 *   ③ 规范化口径与 `suggestedDirs` 完全一致（同一套 `canonicalPath` + 取父目录 +
 *     丢根目录），否则两侧无法正确去重、拼接顺序也无意义。
 *
 * @param {unknown} rawInferred 文本扫描产物（`scanPathsLoose(toolCall)` 的返回值）
 * @param {string[]} structuredDirs 已算好的 `suggestedDirs`，用于排除重复
 * @param {{fsImpl?: object}} [opts]
 * @returns {string[]}
 */
export function inferredDirs(rawInferred, structuredDirs, opts = {}) {
  const taken = Array.isArray(structuredDirs) ? structuredDirs : []
  return suggestedDirs(rawInferred, opts).filter((dir) => !taken.includes(dir))
}
