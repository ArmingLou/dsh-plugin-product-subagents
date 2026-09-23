/**
 * v0.6.2：权限审批的**可测状态层**（A + D）。
 *
 * 拆出动机：`lib/index.js` 的 `permissionHandler` 是一个 200 行闭包，挂起审批表
 * 与_sessionRules 都以它为作用域，无法单测——上一版的两个缺陷（并发授权折叠成
 * 一条、无路径「会话内允许」写成空规则）正是在没有测试覆盖的地方烂掉的。这里把
 * 两处纯状态搬出来，index.js 只保留编排。
 */

import {
  allowlistDecision,
  categoryAllowed,
  categoryRule,
  expandPathsWithParents,
  isCategoryRule,
} from './allowlist.js'

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
 * 会话期授权表（D）：`parentSessionId -> 规则数组`，每条规则是路径列表
 * 或单条分类规则（`cat:<product>:<slug>`）。
 *
 * 匹配矩阵（读侧）：
 *   请求有路径  → 只按路径规则判定（分类规则不参与，防止"允许过一次 bash"
 *                变成"任何越权路径都放行"）；
 *   请求无路径  → 只按分类规则判定（这才是"Allow searching the web?"那类
 *                请求唯一可被记住的维度）。
 */
export function createSessionRules({ expand = expandPathsWithParents } = {}) {
  /** @type {Map<string, string[][]>} */
  const rules = new Map()
  const sessionKey = (parentSessionId) => `${parentSessionId || '?'}`

  return {
    sessionKey,
    /**
     * @param {string} parentSessionId 主代理会话 id
     * @param {string[]} reqPaths 本次请求涉及路径（可为空）
     * @param {string|null} categoryKey 本次请求的归一化类别键（`product:slug`）
     * @returns {boolean}
     */
    cover(parentSessionId, reqPaths, categoryKey) {
      if (!parentSessionId) return false
      const stored = rules.get(sessionKey(parentSessionId))
      if (!stored || stored.length === 0) return false
      const paths = Array.isArray(reqPaths) ? reqPaths : []
      if (paths.length === 0) {
        for (const rulePaths of stored) {
          if (categoryAllowed(categoryKey, rulePaths)) return true
        }
        return false
      }
      for (const rulePaths of stored) {
        const pathRules = rulePaths.filter((r) => !isCategoryRule(r))
        if (pathRules.length === 0) continue
        if (allowlistDecision(paths, pathRules).allowed) return true
      }
      return false
    },
    /**
     * 写入一条授权。无路径时**拒绝写空规则**（旧实现写 `[]`，读侧永远不命中），
     * 改落分类规则；连类别都归一化不出来时返回 ok:false，调用方按"仅本次放行"处理。
     * @returns {{ok: boolean, rule: string[]|null, kind: 'paths'|'category'|'none', reason?: string}}
     */
    add(parentSessionId, paths, categoryKey) {
      if (!parentSessionId) return { ok: false, rule: null, kind: 'none' }
      const expanded = (typeof expand === 'function' ? expand(paths) : paths || [])
        .filter((p) => typeof p === 'string' && p.trim())
      let rule = null
      let kind = 'none'
      if (expanded.length > 0) {
        rule = [...new Set(expanded)]
        kind = 'paths'
      } else {
        // v0.6.2(m5)：执行类类别（bash/exec/shell…）即使归得出指纹也拒写——无路径
        // 的执行授权没有可记忆的边界，记一次等于该会话内任意命令静默放行。
        if (isExecutionCategory(categoryKey)) {
          return { ok: false, rule: null, kind: 'none', reason: 'execution-class' }
        }
        const cat = categoryRule(categoryKey)
        if (cat) {
          rule = [cat]
          kind = 'category'
        }
      }
      if (!rule) return { ok: false, rule: null, kind: 'none' }
      const key = sessionKey(parentSessionId)
      const stored = rules.get(key) || []
      const dup = stored.find((r) => JSON.stringify([...r].sort()) === JSON.stringify([...rule].sort()))
      if (!dup) {
        stored.push(rule)
        rules.set(key, stored)
      }
      return { ok: true, rule, kind }
    },
    /** 该主代理会话是否已有任何授权（清理/诊断用） */
    size(parentSessionId) {
      const stored = rules.get(sessionKey(parentSessionId))
      return stored ? stored.length : 0
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
      return removed
    },
  }
}

/** title/kind 里不承担类别语义的值（opencode 常把 kind 固定成 'other'） */
const UNINFORMATIVE_CATEGORY = new Set(['other', 'unknown', 'default', 'misc', ''])

/**
 * v0.6.2(m5)：**执行类**类别——一律不许进会话期记忆。
 *
 * 无路径的 `bash` / `execute` 请求没有可约束的客体（不像"允许读这两个文件"
 * 那样有路径边界），记一次等于此后该主代理会话内**任意命令**都静默放行，
 * 而且用户点的时候看见的只是"允许执行命令：ls"这一条具体命令。类别记忆的
 * 收益（少弹一次窗）在这种粒度上完全不成立，故 fail-closed：只放行本次。
 * 落盘侧（appendUserRule / userRulesCover）本来就要求路径非空，无此风险。
 */
const EXECUTION_CATEGORY_SLUGS = new Set([
  'bash', 'shell', 'terminal', 'exec', 'execute', 'command', 'run_command', 'runcommand', 'execute_command',
])

/**
 * @param {string|null} categoryKey `product:slug`
 * @returns {boolean} 该类别是否属于"不可记忆"的执行类
 */
export function isExecutionCategory(categoryKey) {
  if (typeof categoryKey !== 'string' || !categoryKey) return false
  const slug = categoryKey.slice(categoryKey.lastIndexOf(':') + 1).trim().toLowerCase()
  return EXECUTION_CATEGORY_SLUGS.has(slug)
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
