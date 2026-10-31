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
 *     v0.7.23 唯一的例外是**工作区默认规则**（`workspaceRuleOf` 带 `coversCwd: true`）：
 *     对"命令正文里一个路径都没有"的执行类请求，改判**命令的生效目录**是否落在
 *     规则 cwd 子树内（`req.execCwd` 来自 `bridges/acp.js` 的 `executeScopeOf`）。
 *     其它任何规则（会话档、落盘档、provider 白名单）都不参与这条旁路。
 *   · cwd 作用域**只单向收紧**：规则带 cwd 时请求必须带着解析后全等的 cwd 才算命中
 *     （请求 cwd 缺失不得消费项目级规则）；只有规则不带 cwd（provider 白名单、
 *     缺 cwd 时写入的会话规则）才按通配处理。
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { normalizeCandidate } from './allowlist.js'
import { splitCommandSegments, foldCdTarget } from './command-segments.js'

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
  // v0.7.22【纵深防御】：**纯根路径不编译成规则**。
  // `//` 经 realpath 会归一成 `/`（`canonicalPath` 保留 `//`，`resolveRealPath` 落回 `/`），
  // 于是一条 `paths:['//']` 的规则覆盖全盘（`coverage(['/etc/passwd'],['//'])` = allowed:true）。
  // 上游已有三处入口过滤（extractPaths 的 ROOT_PATH_RE、expandPathsWithParents 的
  // ROOT_ONLY_RE、validateDeclaredPaths 的根目录拒收），但那都是**单点依赖**——
  // 任何新增规则来源都可能绕过。这里在编译点兜底：返回 `null` 即"永不命中"，
  // 与既有契约一致（`:110`/`:112` 本来就返回 null，唯一调用方 `coverage` 用 `.filter(Boolean)`）。
  // 只拒纯根，`/a`、`/a/*`、`/a/b.txt` 的编译结果逐字不变。
  if (/^\/+$/.test(value) || isFileSystemRoot(value)) return null
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

/**
 * v0.7.26【B3 收口】：工作区默认档的**形状闸门**（与主仓
 * `dsh-agent-dispatch/lib/host-approval.js:582` / `:589` 保持一致，改动需双方同步）。
 *
 * 为什么需要：`coverage` 只看"已提取的路径是否都在工作区内"，而路径集合是从
 * **命令正文**里扫出来的。下面两类形态会让"提取到的路径"**不再代表**这条命令
 * 真正会碰什么，此时"全在路径内"不能作为放行理由：
 *   · `relative-traversal` —— 正文出现 `../`：`PATH_TOKEN_RE` 只认绝对路径与
 *     "含分隔符的相对路径"，`../../.ssh/id_rsa` 解析到工作区外，但**从未**作为
 *     独立条目进入 `paths` ⇒ 路径集只剩工作区内那一条 ⇒ 全站 covered ⇒ 放行（实测）。
 *   · `variable-expansion` —— 正文出现 `$VAR` / `${VAR}`：字面量不是真身，
 *     落点静态判不出（`${HOME}/.ssh/id_rsa` 同理）。
 *
 * 方向与 `dangerousExecuteMatch` **不同**：危险门问"这条命令是不是已知高危"，
 * 命中即拒；本闸门问"这条命令的形状还能不能判"，判不了也**不放**——不是判危险，
 * 而是"不猜"（与主仓 `unsafeCommandShape` 同语义）。
 *
 * 语义边界：只对 `coversCwd: true` 的规则（当前仅 `workspaceRuleOf`）生效，
 * 且**路径档与 cwd 旁路一起挡**（见 `ruleCoversRequest`）。会话档/落盘档/provider
 * 白名单一条都不动——那是用户显式授权，不是自动放宽。
 */
export const UNSAFE_SHAPE_RULES = [
  // 相对越界：`../../x`、`=../x`、`'../x'`。只认带分隔符的 `../`；裸 `..`
  // （`cd ..`）由 cwd 旁路的逃逸判定处理，误伤面更小。
  // v0.7.27：前置分隔字符类补 `<` / `>` —— 输入/输出重定向操作数
  // （`cat a.txt<../../.ssh/id_rsa`、`cat a.txt>../../.ssh/id_rsa`）在 shell 里
  // 是真实读取/写入目标，但前面没有空白，旧字符类匹配不到 ⇒ 漏判（实测 ALLOW）。
  { id: 'relative-traversal', test: (t) => /(^|[\s=:'"(\[{<>])\.\.\//.test(t) },
  // 变量展开：`${HOME}/.ssh/x`、`$HOME/.ssh/x`。`$(` 由危险门/既有规则处理；
  // 这里只认变量名形态（`$1`/`$?` 不匹配）。同上补 `<` / `>`。
  { id: 'variable-expansion', test: (t) => /(^|[\s=:'"(\[{<>])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(t) },
]

/**
 * 命令形状是否超出词法可判定范围（工作区默认档的 fail-closed 判据）。
 * @param {string} commandText 命令正文（`executeScopeOf().command`，执行类帧才有）
 * @returns {string|null} 命中则给出规则 id（供日志归因），否则 null
 */
export function unsafeShapeOf(commandText) {
  const text = typeof commandText === 'string' ? commandText.trim() : ''
  if (!text) return null
  for (const rule of UNSAFE_SHAPE_RULES) {
    if (rule.test(text)) return rule.id
  }
  return null
}

// ── v0.7.28：**分段静态判定**（工作区默认档的第二判据）─────────────────────────
//
// 现场（用户真机矩阵，`permission: interactive`）：工作区内这些**日常**命令仍然弹窗：
//   `node -e "console.log('ok')"` / `grep -rn "x" lib | head -3` / `echo hi > a.txt && cat a.txt`
// 原因有两层：
//   ① 宿主 `PATH_RE` 只认**绝对**路径 ⇒ 相对路径/无路径命令提取为空 ⇒ 工作区档无判据；
//   ② 形状闸门一刀切把 `multi-command` / `pipe-to-interpreter` 全转人工（`unsafeShapeOf`）。
// 本轮把 ② 从「一刀切」改成「逐段静态判定」：**每一段的每一个路径 token 归一化后都
// 落在工作区子树内 ⇒ 工作区档可以放行**；只要有一段判不出/越界，仍然转人工。
//
// 判定顺序（不许变）：危险门 → 形状/分段闸门 → workspace 档 → 原四档。
// 危险门在 `lib/index.js` 的调用点，**早于**本函数；本函数只在 `coversCwd` 规则
// （当前仅 `workspaceRuleOf`）的判定里被调用 ⇒ 会话档/落盘档/provider 白名单
// 一条都没放宽。
//
// 仍然**必须**转人工的形态（逐条对应下面的实现，改动前先读这里）：
//   · `$(...)` / 反引号 / `${VAR}` / `$VAR` —— 落点判不出；
//   · 解析后越界的路径、`~/...`、`../`（相对越界）；
//   · 管道右侧是解释器（`curl x | sh`、`cat a | node`）；
//   · **内联代码执行**（`node -e` / `python -c` / `perl -e` / `ruby -e` / `sh -c`…）——
//     这是**刻意保留**：`node -e` 的正文是一条完整程序，静态判不出它会写哪；
//     放行它等于放行任意代码执行（搬文件、写工作区外），与本轮"放行日常命令"是
//     两件事，不为减少弹窗而放开；
//   · 通配符只能由 shell 展开的 token（`*` `?` `[` `]` `{` `}`）：保守转人工，
//     **唯一例外**是"非通配前缀目录"落在工作区内且不含 `..`
//     （`<WS>/test/*.test.js` 可放行，`/etc/*` 不可）；
//   · 伪文件系统（`/dev` `/proc` `/sys` `/run`）按既有口径跳过（`2>/dev/null` 不该弹）。

/** 管道右侧 / 内联代码的解释器名单（与 acp.js `WORKSPACE_TIER_INTERPRETERS` 同族） */
const SEGMENT_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php',
])

/** 管道右侧是解释器（`| sh`、`| sudo bash`）⇒ 正文直接执行，判不出 */
const PIPE_TO_INTERPRETER_RE = new RegExp(
  `\\|\\s*(?:sudo\\s+)?(?:${[...SEGMENT_INTERPRETERS].join('|')})\\b`,
  'i',
)

/** 内联代码执行的开关（`node -e` / `python -c` / `perl -e` / `ruby -e` / `sh -c`） */
const INLINE_CODE_FLAGS = new Set(['-e', '-c', '--eval', '--command', '-p', '--print'])

/** 分词口径与 `bridges/acp.js` 的 `PATH_TOKEN_RE` 一致（`<>` 是重定向符，天然断词） */
const SEGMENT_TOKEN_RE = /[^\s"'`<>；，。、：:]+/g

/** 单个字符的语法残片（`{` `}` `(` `)` `|`…）不是路径客体 */
const TOKEN_JUNK_RE = /^[()[\]{}|`;,]+$/

/** 段首 `cd`（`builtin cd` / `cd --` 也认）；与 acp.js `CD_TARGET_RE` 同一口径 */
const SEGMENT_CD_RE = /^(?:builtin\s+)?cd(?:\s+--)?(?:\s+(.+))?$/

/** 伪文件系统：永不作为"本次请求的客体"，跳过（与 acp.js 同一口径） */
const PSEUDO_FS_RE = /^\/(?:dev|proc|sys|run)(?:\/|$)/

/** 文件系统根：`/`、`//` 一条规则覆盖全盘 ⇒ 永不参与判定（保守转人工） */
const FS_ROOT_RE = /^\/+$|^[A-Za-z]:[\\/]*$/

/**
 * 分词前摘掉**带 scheme 的 URL**（`https://api.github.com/repos/a/b`）。
 *
 * 根因（与 `bridges/acp.js` 的 `stripUrlSchemes` 同一件事）：分词口径按 `:` 断词，
 * `https://host/a/b` 只剩 `https` + `//host/a/b`，后者以 `/` 开头 ⇒ 被当成绝对路径
 * ⇒ 判越界 ⇒ 每条带 URL 的普通命令（`curl`、`npm --registry=…`）都弹窗。
 *
 * 只摘 `scheme://…`，**不摘**协议相对的 `//etc/passwd`（POSIX 下它就是 `/etc/passwd`，
 * 摘掉等于放行越界读取）。这条区别与 acp.js 的 `stripUrls` / `stripUrlSchemes` 同源。
 */
function stripSchemeUrls(text) {
  return text
    .replace(/\bfile:\/\/\/([^\s"'`<>；，。、]+)/gi, (_, p) => ` /${p} `)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>；，。、]*/gi, ' ')
}

/**
 * v0.7.28：**分段静态判定** —— 命令正文按段切分、逐段按生效目录归一化路径，
 * 回答"这条命令碰的每一个路径是否都在工作区子树内"。
 *
 * 返回值三态（调用方必须区分）：
 *   · `{ok: true, reason: null}`        —— 可以凭本判据放行；
 *   · `{ok: false, reason: '<id>'}`     —— **判不出或判出越界** ⇒ 工作区档不参与，转人工；
 *   · `reason === 'no-command-text'`    —— 没有命令正文（非执行类帧，如 Write/Edit 的
 *     结构化路径请求）⇒ **本闸门不适用**，调用方按原有路径档判，行为逐字不变。
 *
 * 语义边界（为什么"全在路径内"这次可以作为放行理由）：
 *   · 每一段单独解析（`&&` `||` `;` `|` 换行），段的生效目录由**前面的 `cd` 链**折算
 *     （`foldCdTarget`，与 `executeScopeOf` 同一实现）；
 *   · 相对路径按**该段的生效目录** `path.resolve` 归一化后再判子树归属
 *     —— 这正是宿主 `PATH_RE` 缺的那一步；
 *   · 归一化走 `resolveRealPath`（软链按真身判），与路径档完全同源。
 *
 * @param {string} commandText 命令正文（执行类帧才有）
 * @param {string} cwd 工作区根（规则 cwd）
 * @param {{fsImpl?: object}} [opts]
 * @returns {{ok: boolean, reason: string|null, segments: {sep: string, text: string, cwd: string|null, reason: string|null}[]}}
 */
export function segmentScopeOf(commandText, cwd, opts = {}) {
  const fsImpl = opts && opts.fsImpl ? opts.fsImpl : fs
  const text = typeof commandText === 'string' ? commandText.trim() : ''
  if (!text) return { ok: false, reason: 'no-command-text', segments: [] }
  const wsRoot = canonicalPath(cwd)
  if (!wsRoot || !path.isAbsolute(wsRoot)) return { ok: false, reason: 'no-cwd', segments: [] }
  const clause = compileRulePath(wsRoot, { fsImpl })
  if (!clause || clause.kind !== 'dir') return { ok: false, reason: 'no-cwd', segments: [] }
  const inside = (abs) => {
    const real = resolveRealPath(abs, fsImpl)
    return !!real && pathMatchesClause(real, clause)
  }
  const fail = (reason, segments) => ({ ok: false, reason, segments })

  // ── 文本级闸门（与"分几段"无关：整条正文判不出落点）──
  if (/\$\(|`/.test(text)) return fail('command-substitution', [])
  if (PIPE_TO_INTERPRETER_RE.test(text)) return fail('pipe-to-interpreter', [])
  // v0.7.28【追加 B2】：`relative-traversal` **不再**是文本级闸门 —— `..` 的归一化是
  // **确定性**的（`path.resolve` 不依赖运行时、不依赖磁盘），算得准就按算准的落点判
  // （该 token 已进 `paths`，由路径档/会话档正常判定）。只有"算不准"的形态才在下面
  // 逐 token 转人工：变量展开、通配符、归一化失败。历史原因见 UNSAFE_SHAPE_RULES 的注释。
  for (const rule of UNSAFE_SHAPE_RULES) {
    if (rule.id !== 'variable-expansion') continue
    if (rule.test(text)) return fail(rule.id, [])
  }

  const segments = []
  let segCwd = wsRoot
  for (const seg of splitCommandSegments(text)) {
    const raw = seg.text.trim()
    const rec = { sep: seg.sep, text: raw, cwd: segCwd, reason: null }
    segments.push(rec)
    if (!raw) continue

    // ① 段首 `cd`：折算生效目录（`..` / `~` / 判不出 ⇒ 直接转人工）
    const cd = SEGMENT_CD_RE.exec(raw)
    if (cd) {
      const target = (cd[1] || '').trim().replace(/^["']|["']$/g, '')
      if (!target || target === '-') { rec.reason = 'cd-unknown'; return fail('cd-unknown', segments) }
      if (target.startsWith('~')) { rec.reason = 'home-path'; return fail('home-path', segments) }
      if (/[`$]/.test(target)) { rec.reason = 'variable-expansion'; return fail('variable-expansion', segments) }
      if (/(^|[/\\])\.\.([/\\]|$)/.test(target)) { rec.reason = 'relative-traversal'; return fail('relative-traversal', segments) }
      const next = foldCdTarget(segCwd, target)
      if (!next || !inside(next)) { rec.reason = 'cwd-escape'; rec.cwd = null; return fail('cwd-escape', segments) }
      segCwd = next
      rec.cwd = next
    }

    // ② 段首解释器 + 内联代码开关（`node -e …`）⇒ 刻意转人工（见上方清单）
    const headTokens = raw.split(/\s+/).filter(Boolean)
    const head = (headTokens[0] || '').split(/[/\\]/).pop().toLowerCase()
    if (SEGMENT_INTERPRETERS.has(head)) {
      if (headTokens.slice(1).some((x) => INLINE_CODE_FLAGS.has(x.toLowerCase()))) {
        rec.reason = 'inline-code'
        return fail('inline-code', segments)
      }
    }

    // ③ 逐 token 判路径（相对路径按**本段**生效目录归一化）
    // 分词前先摘掉带 scheme 的 URL（`https://host/a/b` 不是文件路径，见 stripSchemeUrls）
    for (const m of stripSchemeUrls(raw).matchAll(SEGMENT_TOKEN_RE)) {
      const token = m[0].replace(/[,;:)\]}>，。；]+$/, '').replace(/^["']|["']$/g, '')
      const why = segmentTokenBlock(token, segCwd, inside)
      if (why) { rec.reason = why; return fail(why, segments) }
    }
  }
  return { ok: true, reason: null, segments }
}

/**
 * 单个 token 的判定：返回 null（可放行）或失败原因 id。
 * 顺序即优先级：语法残片 → 变量展开 → `~` → 伪文件系统/根 → 选项取值 → 通配符 → 归一化归属。
 *
 * v0.7.28【追加 B2】：`..` **不再无条件转人工**——它可静态归一化（`path.resolve` 是
 * 确定性的），所以按归一化后的落点判归属：落在区内 ⇒ 不拦（该 token 已在 `paths` 里，
 * 由路径档/会话档正常判定）；落在区外 ⇒ `relative-traversal`。
 * 真正"算不准"的仍是变量展开 / 通配符 / 归一化失败，那些照旧转人工。
 */
function segmentTokenBlock(token, cwd, inside) {
  if (!token) return null
  const raw = token.replace(/^file:\/\//, '')
  if (!raw || TOKEN_JUNK_RE.test(raw)) return null
  if (/[`$]/.test(raw)) return 'variable-expansion'
  if (raw.startsWith('~')) return 'home-path'
  if (PSEUDO_FS_RE.test(raw)) return null
  if (FS_ROOT_RE.test(raw)) return 'path-unresolved'

  // 选项形态（`--file=../x`、`--out=../../o`）：`=` 之后才是路径客体。
  // 不取这一段的话 `--file=../x` 会被当成"含分隔符的相对路径"整条 resolve 成
  // `<cwd>/--file=../x`（落在区内）⇒ 越界被吞。
  const eq = raw.lastIndexOf('=')
  const target = eq >= 0 && eq < raw.length - 1 && !raw.startsWith('=') ? raw.slice(eq + 1) : raw
  const hasDotDot = /(^|[/\\])\.\.([/\\]|$)/.test(target)

  // 通配符：只能由 shell 展开 ⇒ 只认"非通配前缀目录"落在工作区内
  const globAt = target.search(/[*?[\]{}]/)
  if (globAt >= 0) {
    const prefix = target.slice(0, globAt)
    // 前缀以分隔符结尾 ⇒ 它本身就是目录；否则取它的父目录（`test/*.js` ⇒ `test`）
    const dirRaw = /[/\\]$/.test(prefix) ? prefix.replace(/[/\\]+$/, '') : path.dirname(prefix)
    let dirAbs = null
    try { dirAbs = dirRaw && dirRaw !== '.' ? path.resolve(cwd, dirRaw) : cwd } catch { return 'glob-unresolved' }
    return inside(dirAbs) ? null : 'glob-outside'
  }

  const looksAbsolute = /^(?:\/|[A-Za-z]:[\\/])/.test(target)
  // 相对 token 里只有"像路径"的才是客体（`status` / `--short` 这类裸词不是）
  if (!looksAbsolute && !/[\\/]/.test(target) && !/\.[A-Za-z0-9]{1,8}$/.test(target)) return null
  let abs = null
  try { abs = path.resolve(cwd, target) } catch { return 'path-unresolved' }
  if (inside(abs)) return null
  return hasDotDot ? 'relative-traversal' : 'path-outside'
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
  // v0.7.26【B3 收口】→ v0.7.28【分段静态判定】：工作区默认档的**形状/分段闸门**，
  // 必须站在下面**两条放行判据之前**。
  //
  // 位置为什么在这里而不是调用方：`coversCwd` 规则有两条命中路径（下面的 cwd 旁路
  // 与更下面的路径档），挡在单条分支里会漏掉另一条。放在这里一次挡住两条，
  // 且只影响 `coversCwd: true`（当前仅 `workspaceRuleOf`）——会话档/落盘档/
  // provider 白名单是用户显式授权，不参与本闸门。
  //
  // v0.7.28 的变化：判据从 `unsafeShapeOf`（一刀切：多命令/管道/解释器 stdin 全挡）
  // 换成 `segmentScopeOf`（**逐段**按生效目录归一化路径，全部落在工作区内才放行）。
  // 语义边界见 `segmentScopeOf` 的注释：判不出（变量展开/内联代码/通配符越界…）
  // 仍然 `hit: false` ⇒ 继续看后面的规则来源，最终无人覆盖 ⇒ 落到人工审批。
  if (r.coversCwd) {
    const scope = segmentScopeOf(req.commandText, r.cwd || req.cwd || null, { fsImpl })
    // `no-command-text` = 非执行类帧（Write/Edit 的结构化路径请求）⇒ 本闸门不适用，
    // 按原有路径档判，行为逐字不变。
    if (!scope.ok && scope.reason !== 'no-command-text') {
      return { hit: false, via: null, covered: [], uncovered: paths, shapeGate: scope.reason }
    }
    // 分段判定通过：工作区档**可以**放行。但已提取的路径仍要**全部**覆盖
    // （双保险：提取层与分段层口径不同，任一层说越界就转人工）。
    if (scope.ok) {
      if (paths.length > 0) {
        const c = coverage(paths, r.paths || [], { baseDir, fsImpl })
        if (!c.allowed) return { hit: false, via: null, covered: c.covered, uncovered: c.uncovered }
        return { hit: true, via: 'segment', covered: c.covered, uncovered: [] }
      }
      return { hit: true, via: 'segment', covered: [], uncovered: [] }
    }
  }
  // v0.7.23：**工作区默认规则**对「提取不到路径」的执行类请求的补充判据。
  //
  // 为什么需要：`coverage` 要求 `paths.length > 0`（无从证明落在授权范围内 ⇒ 不命中），
  // 于是 `ls` / `git status` / `npm test` 这类**操作当前目录**、命令正文里一个路径
  // token 都没有的命令永远不命中工作区规则 ⇒ 工作区内每条普通命令都弹授权球
  // （用户现场报告的正是这一条）。用户裁定：工作区及子目录内所有命令直接放行，高危除外。
  //
  // 判据来源是 `req.execCwd`（命令的**生效目录**，由 `bridges/acp.js` 的
  // `executeScopeOf` 按 `cd` 链算出），与规则 cwd 做**目录子树**比较：
  //   · 只有 `coversCwd: true` 的规则（当前仅 `workspaceRuleOf` 产出）参与——
  //     会话档/落盘档/provider 白名单一条都没放宽（它们的"无路径 ⇒ 不命中"语义不变，
  //     `test/allowlist.test.js` 与 `test/user-allowlist.test.js` 钉住的正是这部分）；
  //   · 必须 `paths.length === 0`：带路径的请求仍由下面那条路径档判定，
  //     半覆盖不得因本条旁路放行；
  //   · `execCwd` 缺失（非执行类帧、`cd -` 之类判不出）⇒ 不命中，仍然询问。
  if (paths.length === 0 && r.coversCwd && typeof req.execCwd === 'string' && req.execCwd.trim()) {
    const clause = compileRulePath(r.cwd, { fsImpl })
    const real = resolveRequestPath(req.execCwd, { fsImpl })
    if (clause && real && pathMatchesClause(real, clause)) {
      return { hit: true, via: 'cwd', covered: [], uncovered: [] }
    }
  }
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
  // v0.7.26【B3 收口】：形状闸门命中过哪一条（供调用方日志归因；不影响判定）
  let shapeGate = null
  for (const src of Array.isArray(sources) ? sources : []) {
    const rules = Array.isArray(src && src.rules) ? src.rules : []
    for (const rule of rules) {
      const verdict = ruleCoversRequest(rule, request, { fsImpl })
      if (verdict.hit) {
        return { allowed: true, tier: src.tier, via: verdict.via, rule, covered: verdict.covered, uncovered: [], shapeGate: null }
      }
      if (verdict.shapeGate && !shapeGate) shapeGate = verdict.shapeGate
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
    shapeGate,
  }
}

/** 工作区默认规则（追加3）：`paths = [cwd]` ⇒ 整棵工作区子树。cwd 缺失则无规则。
 *
 * v0.7.23：额外带 `coversCwd: true` —— 允许本条规则消费「无可提取路径」的执行类请求的
 * **生效目录**（`req.execCwd`，见 `ruleCoversRequest` 里的判据）。这个标记是本规则
 * 独有的：会话档、落盘档、provider 白名单都没有，故"无路径 ⇒ 不命中"的既有语义
 * 对它们逐字不变。 */
export function workspaceRuleOf(cwd) {
  const canon = canonicalPath(cwd)
  if (!canon) return []
  return [{ cwd: canon, paths: [canon], tools: [], categories: [], coversCwd: true }]
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
 *   · 逐条丢弃并记录原因（供日志如实归因）；**全被丢弃不再等于**「与 `[]` 同义」——
 *     与 `[]` 同义是 v0.7.9 的旧契约，会把一次被拒的目录声明静默放大成整个工具跨任意
 *     路径的授权（v0.7.10 收口）。本函数只负责校验与归因，写哪一档请看
 *     `planGrantWrites`：声明集非空但全被丢弃 ⇒ `mode: 'none'`（两档都不写）；
 *     只有**客户端明确回传空数组**（用户逐行删空）才走 `mode: 'tools'`；
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
    // v0.7.22【收紧】：URL 形态不是路径。
    // `//example.com` 是协议相对 URL，此前被 normalizeCandidate 归一成 `/example.com`
    // 并**放行**——语义上仍是"把 URL 当路径"，且它派生的 `/` 曾是一条全盘规则的入口。
    // 同理拒绝任何 `scheme://…`（`file://` 也不例外：授权集里要的是本地路径，不是 URL）。
    // 顺序刻意放在「根目录」之后：裸 `//` 仍按根目录归类（与既有归因一致）。
    // 只拒这两种形态，合法绝对路径（`/Users/x`、`/tmp/y`）不受影响。
    if (trimmed.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
      dropped.push({ reason: '非法路径（URL 形态）', value: label })
      continue
    }
    if (!declared.includes(norm)) declared.push(norm)
  }
  return { given, declared, dropped }
}

/**
 * v0.7.9 缺口A：授权写入的**单一判定点**（paths 与 tools 互斥，用户明确定）。
 *
 * 四条出口，且只有这四条：
 *   · `legacy` —— 客户端**没给** `paths`（老 client / 老事件）⇒ 完全沿用改动前的
 *     自动分析行为：路径档 + 工具名档照旧一起写。向后兼容是明示要求，
 *     回归守卫用例「paths 缺省 ⇒ 行为与改动前一致」钉住它。
 *   · `paths`  —— 给了且**最终路径列表非空** ⇒ 只写路径档，工具档一律不写。
 *   · `tools`  —— 客户端**明确**给了空数组 `[]`（用户在弹框里把目录逐行删空）⇒
 *     只写工具档，一条路径都不写。判据 = 「给了、声明集为空、且**没有任何条目被
 *     服务端丢弃**」——只有用户主动清空才算「我要的就是工具档」。
 *   · `none`   —— **v0.7.10 安全收口（新增）**：声明了**非空**的路径集，但**全部**
 *     被服务端校验丢弃（`declared.length === 0 && dropped.length > 0`）⇒ **两档都
 *     不写**（不写路径档、也不写工具档），仅放行/询问**本次**，并把 `dropped` 如实
 *     带回调用方。语义：用户声明的是「授权这些目录」，而这些目录一条都不合法 ⇒
 *     服务端**从未**收到「授权整个工具」的意图。旧逻辑把这种情况退到 `tools` 出口，
 *     等于把一次被拒的目录声明**静默放大**成跨任意路径的工具档授权（已复现：
 *     声明 `./x.txt` 被丢 ⇒ 落 `qoder:read` 工具档 ⇒ 随后 `cat /etc/passwd`
 *     allow、零弹窗）。本出口只影响**写入**，不改变放行侧判定：危险命令门、
 *     `cwd` 作用域、`product` 进键三条例行约束一个都不动。
 *
 * 为什么 `paths` 出口必须绕开 `expandPathsWithParents`：自动分析给的是**文件**
 * 路径，取父目录是为了「兄弟文件不再弹窗」；客户端给的已经是目录，再取一次父目录
 * 会把「放行 /tmp/newproj」放大成「放行 /tmp」——目录不存在时（新建工程是常态）
 * statSync 失败会被当成文件，放大得更狠。所以声明目录按**字面目录**写入。
 *
 * @param {unknown} rawDeclaredPaths 决策载荷里的 `paths`（null/undefined = 未给）
 * @param {string[]} autoPaths 自动分析出的请求路径（仅 legacy 出口使用）
 * @param {{product?: string|null, toolName?: string|null}} [toolCtx]
 * @returns {{mode: 'legacy'|'paths'|'tools'|'none', source: 'auto'|'user', paths: string[],
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
  if (check.given === true && check.declared.length === 0 && check.dropped.length > 0) {
    // v0.7.10：声明了非空路径集却一条都没通过服务端校验 ⇒ 两档都不写。
    // `toolKey` 同时必须是 null——它是「工具档会被写成什么」的唯一投影，留着值
    // 调用方就算不写也会打出与事实相反的日志。
    return { mode: 'none', source: 'user', paths: [], toolKey: null, dropped: check.dropped, expand: false }
  }
  // 走到这里只剩「客户端明确回传空 `paths: []`」（用户逐行删空）——这条语义不得改变。
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
