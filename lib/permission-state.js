/**
 * v0.6.2：权限审批的**可测状态层**（A + D）。
 *
 * 拆出动机：`lib/index.js` 的 `permissionHandler` 是一个 200 行闭包，挂起审批表
 * 与_sessionRules 都以它为作用域，无法单测——上一版的两个缺陷（并发授权折叠成
 * 一条、无路径「会话内允许」写成空规则）正是在没有测试覆盖的地方烂掉的。这里把
 * 两处纯状态搬出来，index.js 只保留编排。
 */

import {
  CATEGORY_RULE_PREFIX,
  categoryRule,
  expandPathsWithParents,
} from './allowlist.js'
import { UNINFORMATIVE_CATEGORY, evaluateRuleSources } from './permission-rules.js'

/**
 * 挂起审批登记表：**每个权限请求一条**（旧实现是 childId 单槽）。
 *
 * 单槽的失败模式：同一 child 并发 2 条请求时 `map.set(childId, resolve)` 覆盖前
 * 一条的 resolve → 前者永远挂起；用户点一次按钮只能兑现后者，前一条从蓝球
 * （宿主弹窗通道）再次冒出来。改为 `childId -> Map<permId, resolve>` 后，
 * 每条请求独立登记、独立兑现。
 *
 * 向后兼容（v0.6.2(M3) 收紧）：permId **缺省**（老 payload：旧版 client 不发
 * permId）时降级为**最早一条**（FIFO），请求不会被静默丢弃；permId **给了却没
 * 命中**时返回 null（不决议 + 调用方 warn）——绝不拿别的请求来顶，否则用户的
 * 「总是允许」会记到另一条请求上。
 */
export function createPendingRegistry() {
  /** @type {Map<string, Map<string, Function>>} */
  const byChild = new Map()
  let seq = 0
  const bucket = (childId) => byChild.get(String(childId))
  const take = (childId, permId) => {
    const key = String(childId)
    const m = byChild.get(key)
    if (!m || m.size === 0) return null
    const wanted = permId === undefined || permId === null ? '' : String(permId)
    // v0.6.2(M3)：**给了 permId 却没命中 → 不决议**（返回 null，调用方 warn）。
    // 旧实现退到 FIFO 摘最早一条：同一 child 并发 2 条请求时，用户对 A 点的
    // 「总是允许」会被记到 B 上——这是整条链路里唯一能产出**错误授权**的路径
    // （客户端按钮态在每次轮询重建，旧快照上的重复点击一定会落到错的 permId）。
    // permId **缺失**（老 payload：旧版 product-subagents 不发 permId）才走 FIFO，
    // 那种情况下客户端一次只显示一条，FIFO 与登记顺序天然对齐。
    let hitId = null
    if (wanted) {
      if (m.has(wanted)) hitId = wanted
    } else {
      hitId = m.keys().next().value
    }
    if (hitId === null) return null
    const resolve = m.get(hitId)
    m.delete(hitId)
    if (m.size === 0) byChild.delete(key)
    return { permId: hitId, resolve }
  }

  return {
    /**
     * 生成请求 id。优先用产品侧 toolCallId（同一 toolCall 的重复询问可对齐），
     * 缺失时退回进程内自增，保证唯一。
     */
    nextPermId(hint) {
      seq += 1
      const prefix = typeof hint === 'string' && hint.trim() ? hint.trim() : 'perm'
      return `${prefix}#${seq}`
    },
    add(childId, permId, resolve) {
      if (typeof resolve !== 'function') return false
      const key = String(childId)
      let m = byChild.get(key)
      if (!m) {
        m = new Map()
        byChild.set(key, m)
      }
      m.set(String(permId), resolve)
      return true
    },
    /** 该 child 是否还有未决审批（看门狗/空闲回收豁免据此判定） */
    has(childId) {
      const m = bucket(childId)
      return !!m && m.size > 0
    },
    size(childId) {
      const m = bucket(childId)
      return m ? m.size : 0
    },
    list(childId) {
      const m = bucket(childId)
      return m ? [...m.keys()] : []
    },
    /**
     * 摘除一条并返回它的 resolve（调用方负责兑现）。
     * @returns {{permId: string, resolve: Function} | null}
     */
    take,
    /** 摘除并兑现一条（授权球按钮通道） */
    settle(childId, permId, answer) {
      const taken = take(childId, permId)
      if (!taken) return null
      taken.resolve(answer)
      return taken
    },
    /** 弹窗通道先答：作废该 child 的全部按钮通道登记，返回被作废的 permId 列表 */
    clearChild(childId) {
      const key = String(childId)
      const m = byChild.get(key)
      if (!m) return []
      const ids = [...m.keys()]
      byChild.delete(key)
      return ids
    },
  }
}

/**
 * 会话期授权表（D + v0.7.9 统一模型）：`parentSessionId -> 规则数组`，
 * 每条规则是 `{ cwd, paths[], categories[] }`；工具名授权单独一层
 * `{cwd, tools[]}`，两者一起喂 `permission-rules.js` 的**同一个**评估器
 * （落盘规则、工作区默认规则、provider 白名单走的也是它）。
 *
 * 匹配矩阵（读侧，语义与 v0.6.2 一致）：
 *   请求有路径  → 只按路径规则判定（类别规则不参与，防止"允许过一次 bash"
 *                变成"任何越权路径都放行"）；
 *   请求无路径  → 只按分类规则判定（这才是"Allow searching the web?"那类
 *                请求唯一可被记住的维度）；
 *   工具名档    → 与路径无关，但要求「请求 cwd 与规则 cwd 全等」+ 产品前缀。
 */
export function createSessionRules({ expand = expandPathsWithParents } = {}) {
  /** @type {Map<string, Array<{cwd: string|null, paths: string[], categories: string[]}>>} */
  const rules = new Map()
  /**
   * v0.7.6：会话级工具名授权表（与路径/类别规则并存，不替代）。
   * Map<sessionKey, Map<productSlug:normalizedToolName, cwd|null>>
   *
   * 键含 product 前缀（与 permissionCategoryKey 同构）：同一主代理会话下用户给
   * A 产品点过「会话内允许」，不应自动放行 B 产品的同名工具。
   *
   * v0.7.9：值位存写入时的 cwd（统一模型的 `tools` 档要求「规则 cwd === 请求
   * cwd」）；取不到 cwd 时记 null = 通配，与历史行为一致。
   *
   * 归一化规则：trim() + toLowerCase()。空值/undefined 不写不命中。
   * 占位 toolName（other/unknown/default/misc）不写不命中——与 permissionCategoryKey
   * 的 UNINFORMATIVE_CATEGORY 过滤一致：这些值不承担类别语义，写入等于通配授权。
   *
   * 匹配时严格按归一化后的 product:toolName 判定（大小写不敏感）。
   * toolName 缺失时必须退化为现有行为（照常弹授权球），绝不因缺字段而误放行。
   */
  const toolGrants = new Map()
  const sessionKey = (parentSessionId) => `${parentSessionId || '?'}`

  /** 该会话在评估器眼里的规则集：路径/类别规则 + 一条工具名规则（每 grant 一条，
   *  因为各次点击记的 cwd 可能不同，全等判定必须逐条做） */
  const rulesOf = (sid) => {
    const out = []
    for (const r of rules.get(sessionKey(sid)) || []) out.push(r)
    for (const [grantKey, cwd] of (toolGrants.get(sessionKey(sid)) || new Map()).entries()) {
      const i = grantKey.indexOf(':')
      out.push({ cwd: cwd || null, product: grantKey.slice(0, i), paths: [], categories: [], tools: [grantKey.slice(i + 1)] })
    }
    return out
  }
  const runEvaluate = (sid, request) => evaluateRuleSources(
    [{ tier: 'session', rules: sid ? rulesOf(sid) : [] }],
    request,
  )

  return {
    sessionKey,
    /** v0.7.9：把该会话的路径/类别规则与工具名规则摊平成统一评估器的输入形状 */
    rulesOf: (parentSessionId) => (parentSessionId ? rulesOf(parentSessionId) : []),
    /**
     * v0.7.9：会话层统一评估（index.js 用它一次问完路径/工具名/类别三个维度）。
     * @returns {{allowed:boolean, via:string|null}}
     */
    evaluate(parentSessionId, request) {
      if (!parentSessionId) return { allowed: false, via: null }
      const r = runEvaluate(parentSessionId, { ...(request || {}), paths: Array.isArray(request && request.paths) ? request.paths : [] })
      return { allowed: r.allowed, via: r.via }
    },
    /**
     * @param {string} parentSessionId 主代理会话 id
     * @param {string[]} reqPaths 本次请求涉及路径（可为空）
     * @param {string|null} categoryKey 本次请求的归一化类别键（`product:slug`）
     * @param {string|null} [requestCwd] 本次请求的工作目录（v0.7.9 统一模型用；
     *        缺省 = 不参与 cwd 判定，与历史调用方一致）
     * @param {{expand?: boolean}} [opts] v0.7.9 缺口A：`expand:false` = **不做**
     *        「文件路径补父目录」展开。自动分析给的是文件路径，补父目录是为了
     *        兄弟文件不再弹窗；而用户在弹框里声明的已经是**目录**，再补一次父目录
     *        会把「放行 /tmp/newproj」放大成「放行 /tmp」（目录尚不存在时 statSync
     *        失败 ⇒ 按文件处理 ⇒ 放大得更狠）。缺省 true = 历史行为逐字节不变。
     * @returns {boolean}
     */
    cover(parentSessionId, reqPaths, categoryKey, requestCwd = null) {
      if (!parentSessionId) return false
      const r = runEvaluate(parentSessionId, { cwd: requestCwd, paths: Array.isArray(reqPaths) ? reqPaths : [], categoryKey })
      return r.allowed && (r.via === 'paths' || r.via === 'category')
    },
    /**
     * 写入一条授权。无路径时**拒绝写空规则**（旧实现写 `[]`，读侧永远不命中），
     * 改落分类规则；连类别都归一化不出来时返回 ok:false，调用方按"仅本次放行"处理。
     * @param {string|null} [cwd] v0.7.9：写入时的工作目录，随规则一起存
     * @param {{expand?: boolean}} [opts] v0.7.9 缺口A：见 `cover` 的同名说明
     * @returns {{ok: boolean, rule: string[]|null, kind: 'paths'|'category'|'none', reason?: string}}
     */
    add(parentSessionId, paths, categoryKey, cwd = null, opts = {}) {
      if (!parentSessionId) return { ok: false, rule: null, kind: 'none' }
      const expandDeclaredDirs = opts.expand !== false
      const expanded = (expandDeclaredDirs
        ? (typeof expand === 'function' ? expand(paths) : paths || [])
        : (Array.isArray(paths) ? paths : []))
        .filter((p) => typeof p === 'string' && p.trim())
      const rulePaths = []
      const categories = []
      let kind = 'none'
      if (expanded.length > 0) {
        rulePaths.push(...new Set(expanded))
        kind = 'paths'
      } else {
        // v0.6.2(m5)：执行类类别（bash/exec/shell…）即使归得出指纹也拒写——无路径
        // 的执行授权没有可记忆的边界，记一次等于该会话内任意命令静默放行。
        if (isExecutionCategory(categoryKey)) {
          return { ok: false, rule: null, kind: 'none', reason: 'execution-class' }
        }
        const cat = categoryRule(categoryKey)
        if (cat) {
          categories.push(cat.slice(CATEGORY_RULE_PREFIX.length))
          kind = 'category'
        }
      }
      // m-6：走到这里 = 路径一条都不可用（非字符串/相对路径被 expand 滤掉）**且**归不出
      // 类别。必须给 reason，否则调用侧日志只能打出「（未知）」，误导排障。
      if (rulePaths.length === 0 && categories.length === 0) {
        return { ok: false, rule: null, kind: 'none', reason: 'no-usable-paths' }
      }
      const key = sessionKey(parentSessionId)
      const stored = rules.get(key) || []
      const normCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
      const signature = (r) => JSON.stringify([r.cwd, [...r.paths].sort(), [...r.categories].sort()])
      const dup = stored.find((r) => signature(r) === JSON.stringify([normCwd, [...rulePaths].sort(), [...categories].sort()]))
      if (!dup) {
        stored.push({ cwd: normCwd, paths: rulePaths, categories })
        rules.set(key, stored)
      }
      return {
        ok: true,
        // 返回值维持 v0.6.2 的字符串数组形状（`cat:` 前缀照旧），调用侧日志与既有
        // 断言都读它；内部存储才是 {cwd,paths,categories} 结构。
        rule: [...rulePaths, ...categories.map((c) => `${CATEGORY_RULE_PREFIX}${c}`)],
        kind,
      }
    },
    /**
     * v0.7.6：写入会话级工具名授权。
     * 归一化规则：trim() + toLowerCase()，空字符串/非字符串不写入。
     * 键含 product 前缀（与 permissionCategoryKey 同构），防止跨产品越权放行。
     * 占位 toolName（other/unknown/default/misc 等）不写入——这些值不承担类别
     * 语义，写入等于通配授权（B1 修复：复用 UNINFORMATIVE_CATEGORY）。
     * 同一 sessionKey + 同一归一化 product:toolName 幂等（不重复写入）。
     * @param {string} parentSessionId 主代理会话 id
     * @param {string} product 产品名
     * @param {string} toolName 工具名（原始值，方法内部归一化）
     * @param {string|null} [cwd] v0.7.9：写入时的工作目录（统一模型的 tools 档要求全等）
     * @returns {boolean} 是否写入了新条目（false = 已存在或参数无效）
     */
    addToolGrant(parentSessionId, product, toolName, cwd = null) {
      if (!parentSessionId || typeof product !== 'string' || typeof toolName !== 'string') return false
      const productSlug = product.trim().toLowerCase()
      const normalized = toolName.trim().toLowerCase()
      if (!productSlug || !normalized) return false
      if (UNINFORMATIVE_CATEGORY.has(normalized)) return false
      const grantKey = `${productSlug}:${normalized}`
      const key = sessionKey(parentSessionId)
      let map = toolGrants.get(key)
      if (!map) {
        map = new Map()
        toolGrants.set(key, map)
      }
      if (map.has(grantKey)) return false
      map.set(grantKey, typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null)
      return true
    },
    /**
     * v0.7.6：判定会话级工具名授权是否命中。
     * 归一化规则与 addToolGrant 一致（trim + toLowerCase + product 前缀）。
     * 占位 toolName 不命中（与写入侧过滤一致）。
     * toolName 为空/非字符串/undefined 时返回 false（不误放行）。
     * @param {string|null} [requestCwd] v0.7.9：给了就要求与规则 cwd 全等；
     *        缺省沿用历史语义（不看 cwd）
     * @param {string} parentSessionId 主代理会话 id
     * @param {string} product 产品名
     * @param {string} toolName 本次请求的工具名（原始值，方法内部归一化）
     * @returns {boolean}
     */
    toolGrantCovers(parentSessionId, product, toolName, requestCwd = null) {
      if (!parentSessionId || typeof product !== 'string' || typeof toolName !== 'string') return false
      const r = runEvaluate(parentSessionId, { product, toolName, cwd: requestCwd, paths: [] })
      return r.allowed && r.via === 'tools'
    },
    /** 该主代理会话已有的路径/类别规则条数（不含工具名授权，后者用 toolGrantSize 查询） */
    size(parentSessionId) {
      const stored = rules.get(sessionKey(parentSessionId))
      return stored ? stored.length : 0
    },
    /** 该主代理会话已有的工具名授权条数 */
    toolGrantSize(parentSessionId) {
      const set = toolGrants.get(sessionKey(parentSessionId))
      return set ? set.size : 0
    },
    /**
     * 会话销毁清理。**必须与写入侧 sessionKey 同构**：旧实现写入用
     * `${parentSessionId}`、清理却匹配 `${sid}::`，两者永不相等 → 会话级授权
     * 随进程泄漏（跨会话越权放行）。这里同时匹配精确键与 `${sid}::` 前缀。
     */
    dispose(parentSessionId) {
      const sid = parentSessionId === undefined || parentSessionId === null ? '' : String(parentSessionId)
      if (!sid) return 0
      let removed = 0
      for (const key of [...rules.keys()]) {
        if (key === sid || key.startsWith(`${sid}::`)) {
          rules.delete(key)
          removed += 1
        }
      }
      for (const key of [...toolGrants.keys()]) {
        if (key === sid || key.startsWith(`${sid}::`)) {
          toolGrants.delete(key)
          removed += 1
        }
      }
      return removed
    },
  }
}

/**
 * v0.6.2(m5)：**执行类**类别——一律不许进会话期记忆。
 *
 * 无路径的 `bash` / `execute` 请求没有可约束的客体（不像"允许读这两个文件"
 * 那样有路径边界），记一次等于此后该主代理会话内**任意命令**都静默放行，
 * 而且用户点的时候看见的只是"允许执行命令：ls"这一条具体命令。类别记忆的
 * 收益（少弹一次窗）在这种粒度上完全不成立，故 fail-closed：只放行本次。
 * 落盘侧（appendUserRule / userRulesCover）本来就要求路径非空，无此风险。
 *
 * v0.7.8 反转说明：执行类的**路径/类别规则**仍不得记忆（isExecutionCategory
 * 不变），但 bash 等执行类 slug 已被 TOOL_NAME_SLUGS 收录，可按**工具名**
 * 授权记忆（用户意图是允许该工具名，不区分路径）。这与"任意路径放行"不同：
 * 工具名授权只放行同一工具名的后续调用，不会放行 edit/external_directory
 * 等不同工具名的工作区外路径请求。
 */
const EXECUTION_CATEGORY_SLUGS = new Set([
  'bash', 'shell', 'terminal', 'exec', 'execute', 'command', 'run_command', 'runcommand', 'execute_command',
])

/**
 * v0.7.8：具有**工具语义**的类别 slug——可用作工具名授权的键。
 *
 * 判定标准：一个 slug 被收入此集合当且仅当它指代**一个具体的工具/操作**，
 * 而非**一个权限范围或保护机制**。用户点「本会话总是允许」时，授权球上
 * 展示的是这个 slug 对应的操作，用户期望「同工具不再弹」，而非「同类权限
 * 范围下的所有路径都不再弹」。
 *
 * 映射表（opencode 已知类别 slug → 归类理由）：
 * ┌──────────────────────┬─────────────────────────────────────────────────┐
 * │ slug                 │ 理由                                           │
 * ├──────────────────────┼─────────────────────────────────────────────────┤
 * │ bash                 │ 具体工具（执行命令），授权=允许该工具跨路径      │
 * │ shell                │ 同上（bash 的别名）                             │
 * │ terminal             │ 同上（bash 的别名）                             │
 * │ exec                 │ 同上（bash 的别名）                             │
 * │ execute              │ 同上（bash 的别名）                             │
 * │ command              │ 同上（bash 的别名）                             │
 * │ edit                 │ 具体工具（写入/修改文件），授权=允许该工具跨路径 │
 * │ webfetch             │ 具体工具（发起网络请求），授权=允许该工具跨路径  │
 * │ web_fetch            │ 同上（webfetch 的归一化变体）                   │
 * │ web_search           │ 具体工具（搜索网页），无路径，按工具名授权安全   │
 * │ read                 │ 具体工具（读取文件），授权=允许该工具跨路径      │
 * │ write                │ 具体工具（写入文件），授权=允许该工具跨路径      │
 * ├──────────────────────┼─────────────────────────────────────────────────┤
 * │ external_directory   │ ❌ 权限范围（工作区外读+写），非工具——授权等于  │
 * │                      │    允许任意工作区外路径的读和写，无路径约束       │
 * │ doom_loop            │ ❌ 保护机制（循环检测），非工具——授权等于允许    │
 * │                      │    任意触发循环检测的操作跳过保护                 │
 * └──────────────────────┴─────────────────────────────────────────────────┘
 *
 * 不收录的 slug 按以下原则判定：
 * - 描述的是**权限范围**（如 external_directory=工作区外）而非具体操作 → 不收录，
 *   因为授权它会放行该范围内的所有操作（读+写），无路径约束，等于通配放行。
 * - 描述的是**保护机制**（如 doom_loop=循环保护）而非具体操作 → 不收录，
 *   因为授权它会绕过该保护，语义不符用户期望。
 *
 * 此集合与 UNINFORMATIVE_CATEGORY 互斥：占位值不承担任何语义（包括工具语义），
 * 已被 UNINFORMATIVE_CATEGORY 过滤的值不会再进入此集合的判定。
 */
const TOOL_NAME_SLUGS = new Set([
  'bash', 'shell', 'terminal', 'exec', 'execute', 'command',
  'run_command', 'runcommand', 'execute_command',
  'edit', 'write', 'read',
  'webfetch', 'web_fetch', 'web_search',
])

/**
 * v0.7.8 G-1：已知「权限范围 / 保护机制」slug 的**显式拒绝集**（黑名单）。
 *
 * 与上面白名单的分工，两者不冲突：**白名单防漏、黑名单防误**。
 * - 白名单只能加在 `title` 侧——`name`/`toolName` 的取值空间是各产品自带的工具表，
 *   白名单必然列不全，套上去会把 `WebFetch`、`search_codebase` 这类真名挡在 L1 外。
 * - 但"不套白名单"不等于"来者不拒"：`external_directory`（工作区外读+写这一
 *   **权限范围**）、`doom_loop`（循环保护这一**保护机制**）在任何来源下都不是工具名。
 *   一旦某产品把它们塞进 `name`/`toolName`，就会被写成一条会话级工具名授权，
 *   而工具名授权预检**完全不看路径** → 0.7.7 那类"任意工作区外路径静默放行"回归，
 *   直接违背用户口径「什么都分析不出来时，不要授权任意工作区外路径权限」。
 *   所以这两个值在**三个来源（name / toolName / title）上无条件拒绝**。
 * - 只收紧不放宽：本集合只会让 `resolveToolName` 更多地返回 null（→ 落 L2/L3）。
 * - 存的是"去分隔符、去大小写"后的形态（见 permissionScopeKey），故
 *   `external_directory` / `External-Directory` / `external directory` 都会命中。
 * - **残余风险（诚实声明）**：本集合同样是显式列举的，可能不全。若将来某产品把
 *   **新的**权限范围 slug（如 `filesystem_write`、`network_access` 之类）塞进
 *   `name`/`toolName`，仍会被当作工具名授权——这不是"已彻底解决"，只是把**已知**的
 *   两类堵死。收窄手段只有两条：往本集合追加，或给该产品配白名单。
 *   真机抓手见 CHANGELOG 的「已知限制」：`lib/bridges/acp.js:480` 打印原始 toolCall。
 */
const PERMISSION_SCOPE_SLUGS = new Set(['externaldirectory', 'doomloop'])

/**
 * 归一化到"无分隔符、无大小写"形态：先在驼峰边界插下划线，再toLowerCase，
 * 最后剥掉所有非字母数字字符。注意这只覆盖**同一拼写的不同写法**，
 * 不覆盖缩写/改名（`externalDir` → 'externaldir' **不会**命中）。
 */
function permissionScopeKey(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** 该字符串是否是"描述权限范围/保护机制"的 slug（任何来源都不得当工具名） */
function isPermissionScopeSlug(value) {
  return PERMISSION_SCOPE_SLUGS.has(permissionScopeKey(value))
}

/**
 * @param {string|null} categoryKey `product:slug`
 * @returns {boolean} 该类别是否属于"不可记忆"的执行类
 */
export function isExecutionCategory(categoryKey) {
  if (typeof categoryKey !== 'string' || !categoryKey) return false
  const slug = categoryKey.slice(categoryKey.lastIndexOf(':') + 1).trim().toLowerCase()
  return EXECUTION_CATEGORY_SLUGS.has(slug)
}

/**
 * v0.7.8：判定一个归一化后的 slug 是否具有工具语义（可按工具名授权）。
 *
 * 判定流程：先过 UNINFORMATIVE_CATEGORY（占位值一律返回 false），
 * 再查 TOOL_NAME_SLUGS（只收录指代具体工具/操作的 slug）。
 * 不收录的 slug（如 external_directory、doom_loop）描述的是权限范围
 * 或保护机制，授权它们等于无约束放行，必须走 L2/L3 降级。
 *
 * @param {string} slug 归一化后的类别片段（小写、slugified）
 * @returns {boolean}
 */
export function isToolNameSlug(slug) {
  if (typeof slug !== 'string') return false
  const normalized = slug.trim().toLowerCase()
  if (!normalized || UNINFORMATIVE_CATEGORY.has(normalized)) return false
  return TOOL_NAME_SLUGS.has(normalized)
}

/**
 * v0.7.8：三级降级解析——从 toolCall 载荷中解析出可用于工具名授权的标识。
 *
 * L1（优先）：按 `name` → `toolName` → `_meta` → `title` 的顺序提取真实工具名。
 *   - name/toolName 优先（直接是工具名，如 'Write'、'bash'）
 *   - `_meta` 次之（v0.7.9）：qoder 的实测载荷把真实工具名放在
 *     `toolCall._meta.qoder.toolName`，而 `title` 里是整条命令正文——不读 `_meta`
 *     就永远走不到 L1。取值必须过**三重**过滤（TOOL_NAME_SLUGS 白名单 +
 *     UNINFORMATIVE_CATEGORY 占位集 + isPermissionScopeSlug 拒绝集），见下文。
 *   - title 最后：若 title 是 TOOL_NAME_SLUGS 收录的 slug（如 'bash'、'edit'、
 *     'webfetch'），则作为工具名；若 title 不在 TOOL_NAME_SLUGS 中（如
 *     'external_directory'、'doom_loop'），则**不具备工具粒度**，不得作为工具名。
 *   - 任何归一化结果落入 UNINFORMATIVE_CATEGORY 的，视同未解析出。
 *
 * L2（L1 失败时）：退化为路径——本次授权只写路径/目录规则，不写工具名授权。
 *   调用方根据返回的 toolName=null + reqPaths 非空自行走路径授权。
 *
 * L3（L1+L2 都失败时）：toolName=null 且无路径——不得写入任何会话级授权。
 *
 * 为什么 name/toolName 只要非占位就收、title 却必须命中 TOOL_NAME_SLUGS：
 * 这两个字段的**语义不同**，不是同一类字符串的两种写法——同一条链路的展示侧
 * 就是分开处理的（lib/bridges/acp.js:78-90：title 查 KIND_LABEL 权限类别表，
 * name/toolName 走"传统模型工具名"分支）。
 *   - `toolCall.name` / `toolCall.toolName` 按 ACP 协议就是工具名（`Bash`、
 *     `Write`、`read_file`），取值空间是工具表。这里只过滤 UNINFORMATIVE_CATEGORY
 *     （other/unknown/default/misc）——那几个值是宿主拿不到名字时的兜底占位
 *     （见本文件 UNINFORMATIVE_CATEGORY 处的注释：opencode 常把 kind 固定成
 *     'other'），收下等于通配授权。除此之外不设白名单：工具名由各产品自带，
 *     白名单必然列不全。
 *   - `toolCall.title` 在 opencode 这条链路上被当成**权限类别 slug**用，取值
 *     空间是权限分类（KIND_LABEL 那一张表）：既有 `bash`/`edit` 这种恰好指代
 *     一个工具的，也有 `external_directory`（工作区外读+写这一**权限范围**）、
 *     `doom_loop`（循环保护这一**保护机制**）这种指代不了一年工具的。title 是
 *     唯一会把"权限范围"伪装成"工具名"的入口，所以只有它需要白名单。
 *   - `toolCall._meta`（v0.7.9）是产品的**扩展元数据**，命名空间键就是产品名
 *     （qoder → `_meta.qoder.toolName='Bash'`）。它和 name/toolName 同属"产品自带的
 *     工具名通道"，理论上也该只挡占位值；但本分支按白名单**收紧**执行，理由有二：
 *     ① `_meta` 是各产品自由扩展的口袋，取值空间未经协议约束，比 name/toolName
 *        更不可控；② 新增来源的目的只是把 qoder 这类"真名藏在 `_meta`、title 是
 *        命令正文"的产品拉回 L1，白名单已覆盖其实际取值（`Bash`→`bash`）。
 *     代价（诚实声明）：白名单外的 `_meta` 工具名（如某产品的 `search_codebase`）
 *     仍会退回 L2/L3 逐路径弹窗——只收紧不放宽，将来按需追加白名单即可。
 *   - **G-1 补充（白名单防漏、黑名单防误，两者不冲突）**：不设白名单 ≠ 来者不拒。
 *     `PERMISSION_SCOPE_SLUGS`（定义在本函数上方）在 **name / toolName / title 三个
 *     来源上无条件拒绝** `external_directory`、`doom_loop` 这类"描述权限范围/保护机制"
 *     的值——产品把它们塞进 name/toolName 与塞进 title 是同一个洞（0.7.7 的任意路径
 *     静默放行）。该集合只会让本函数更多地返回 null（→ 落 L2/L3），只收紧不放宽。
 * 后来人若"顺手统一"成两边都过白名单，会把产品侧真实工具名（`WebFetch`、
 * `search_codebase` 等）挡在 L1 之外，退化成 L2 逐路径弹窗；若反过来统一成两边
 * 都不过白名单，就是 0.7.7 那个漏洞的回归（见 test/permission-handler-wiring.test.js
 * 里的 "L1 regression" 用例：external_directory 被当工具名后，任意路径都静默放行）。
 */
/**
 * toolName 来源标签（v0.7.8 m-1）：由 resolveToolName 在**真正命中的那个分支**里
 * 打出，不再由调用点用 `toolCall.name || toolCall.toolName` 反推——反推会把
 * `{name:'other', title:'bash'}` 这种"name 被占位过滤掉、实际靠 title 命中"的
 * 情况标成 name/toolName。标签值对外可见（授权球展示 + 日志），改动需同步测试。
 */
const TOOL_NAME_SOURCE = {
  name: 'name/toolName',
  meta: '_meta(TOOL_NAME_SLUGS)',
  title: 'title(TOOL_NAME_SLUGS)',
}

/**
 * v0.7.9：`_meta` 的命名空间候选键。产品 slug 的取法与**唯一调用点**保持一致
 * （lib/index.js 里 permissionHandler 的 `product` 就是 provider 注册名，
 * 授权键用 `product.trim().toLowerCase()`，见 addToolGrant/toolGrantCovers），
 * 并沿用 lib/index.js 对白名单快速路径同一条 `-cli` 后缀宽容
 * （`providers[product] || providers[product.replace(/-cli$/,'')]`），
 * 以免在库内另造一套产品标识。
 *
 * @param {string|undefined} product 产品名
 * @returns {string[]} 命名空间候选（小写），product 非字符串/空白时为空数组
 */
function metaNamespaceCandidates(product) {
  if (typeof product !== 'string') return []
  const slug = product.trim().toLowerCase()
  if (!slug) return []
  const stripped = slug.replace(/-cli$/, '')
  return stripped && stripped !== slug ? [slug, stripped] : [slug]
}

/**
 * 取对象的**自身**属性（原型链上的同名值一律不认）：`_meta` 是产品侧外部载荷，
 * 命名空间键与 `toolName` 都只认它自己写下的字段。
 */
function ownValue(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

/**
 * m-1/m-2：返回 `{value, source}` 而非裸字符串——来源必须与取值同源，否则
 * 日志会声称工具名来自 name 而它其实来自 title。null = L1 未命中（走 L2/L3）。
 *
 * v0.7.9：新增第二参 `product`，用于定位 `_meta.<product>.toolName` 命名空间。
 * 省略 product（既有单参调用）只是跳过命名空间那一跳，扁平 `_meta.toolName`
 * 兜底与其余分支行为不变。
 *
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @param {string} [product] 产品名（provider 注册名，与授权键同源）
 * @returns {{value: string, source: string}|null}
 */
export function resolveToolName(toolCall, product) {
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : {}
  // m-2：name / toolName **逐个**尝试——旧写法 `tool.name || tool.toolName` 一旦
  // name 是非空占位值（'other'）或纯空白，就会被当成"取到了值"并在占位过滤后
  // 直接放弃，把 toolName 字段里真实的 'Write' 一起吞掉。现在缺失/空白/占位都
  // 继续回退 toolName（占位过滤本身保留），方向是尽量吃到真工具名 → 走 L1。
  for (const raw of [tool.name, tool.toolName]) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const trimmed = raw.trim()
    if (UNINFORMATIVE_CATEGORY.has(trimmed.toLowerCase())) continue
    // G-1：白名单不套在 name/toolName 侧，但权限范围 slug 必须在这里也堵掉——
    // 塞进 name/toolName 的 external_directory 与塞进 title 的是同一个洞。
    if (isPermissionScopeSlug(trimmed)) continue
    return { value: trimmed, source: TOOL_NAME_SOURCE.name }
  }
  // v0.7.9：`_meta` 通道。qoder 实测把真实工具名放在 `_meta.qoder.toolName`
  // （恒为 'Bash' 这类工具名），`title` 里却是整条命令正文 → 老实现三条来源全空，
  // addToolGrant 从不被调用，「本会话总是允许」只落地路径级记忆，换路径就重复弹窗。
  // 三重过滤一条都不能少（占位集 / 权限范围拒绝集 / TOOL_NAME_SLUGS 白名单）。
  // 畸形输入一律跳过：`_meta` 非对象、命名空间值非对象、toolName 缺失/非字符串/
  // 纯空白/数字，都不抛异常、都不放行。
  const meta = tool._meta
  if (meta && typeof meta === 'object') {
    const candidates = []
    for (const ns of metaNamespaceCandidates(product)) {
      const namespaced = ownValue(meta, ns)
      if (namespaced && typeof namespaced === 'object') candidates.push(ownValue(namespaced, 'toolName'))
    }
    candidates.push(ownValue(meta, 'toolName'))
    for (const raw of candidates) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const trimmed = raw.trim()
      const lower = trimmed.toLowerCase()
      if (UNINFORMATIVE_CATEGORY.has(lower)) continue
      if (isPermissionScopeSlug(trimmed)) continue
      if (!TOOL_NAME_SLUGS.has(lower)) continue
      return { value: trimmed, source: TOOL_NAME_SOURCE.meta }
    }
  }
  const titleRaw = tool.title
  if (typeof titleRaw === 'string' && titleRaw.trim()) {
    const titleSlug = slugify(titleRaw)
    if (titleSlug && !UNINFORMATIVE_CATEGORY.has(titleSlug) && TOOL_NAME_SLUGS.has(titleSlug)
      && !isPermissionScopeSlug(titleRaw)) {
      return { value: titleRaw.trim(), source: TOOL_NAME_SOURCE.title }
    }
  }
  return null
}

/** 无 title/kind 时从描述文本归类的窄关键词表（顺序即优先级） */
const DESCRIPTION_KEYWORDS = [
  [/web[\s_-]*search|search(ing)?[\s_]+the[\s_]+web|websearch|搜索/i, 'web_search'],
  [/web[\s_-]*fetch|\bfetch\b|网络请求|访问网络|浏览网页|https?:\/\//i, 'web_fetch'],
  [/\bbash\b|\bshell\b|执行命令|run[\s_-]?command|\bexec\b/i, 'bash'],
  [/external[\s_-]?directory|工作区外|外部目录/i, 'external_directory'],
  [/\bedit\b|写入|修改文件|\bwrite\b/i, 'edit'],
]

/** 归一化类别名片段：小写、非字母数字转 '_'，只留安全字符 */
function slugify(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * 从 ACP toolCall 归一化出**权限类别指纹**（D 的写入侧）。
 *
 * 优先级 title → kind → 描述关键词兜底。title 优先是因为实测载荷里
 * `kind` 经常是无信息量的 'other'，真正的类别在 `title`
 * （edit / bash / webfetch / external_directory / doom_loop）。
 *
 * 键里带 product 前缀：同一主代理会话下用户给 A 产品点过「会话内允许」，
 * 不应自动放行 B 产品的同类请求。
 *
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @param {string} [product] 产品名
 * @param {string} [description] 已解析的人类可读描述（兜底归类用）
 * @returns {string|null} `product:slug`，归不出则 null
 */
export function permissionCategoryKey(toolCall, product, description) {
  const tool = toolCall && typeof toolCall === 'object' ? toolCall : {}
  let slug = ''
  const title = slugify(tool.title)
  if (title && !UNINFORMATIVE_CATEGORY.has(title)) slug = title
  if (!slug) {
    const kind = slugify(tool.kind)
    if (kind && !UNINFORMATIVE_CATEGORY.has(kind)) slug = kind
  }
  if (!slug) {
    const name = slugify(tool.name || tool.toolName)
    if (name && !UNINFORMATIVE_CATEGORY.has(name)) slug = name
  }
  if (!slug && typeof description === 'string') {
    for (const [re, mapped] of DESCRIPTION_KEYWORDS) {
      if (re.test(description)) {
        slug = mapped
        break
      }
    }
  }
  if (!slug) return null
  const productSlug = slugify(product) || 'unknown'
  return `${productSlug}:${slug}`
}
