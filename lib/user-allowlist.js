/**
 * dsh-plugin-product-subagents —— 用户手动授权落盘（v0.5.0）
 *
 * 原则：授权记忆必须是"用户手动交互 → 明确落盘"的产物，插件/AI 不自动记忆、
 * 不代决。用户在授权球点「总是允许」→ 本模块把该决定原子写入
 *   $DSH_HOME/data/dsh-plugin-product-subagents/allowlist.json
 * （$DSH_HOME 缺省 ~/.dsh；与 agents.json 同款原子写：tmp + rename）。
 *
 * 作用域：每条规则绑定【工作目录 cwd】（点选时子代理所在项目）——"总是允许"
 * 只在记录它的项目内生效；不同项目各自维护自己的 always 授权集。
 * 全局性授权应走 provider.allowWritePaths（cordis 配置，显式、跨项目）。
 *
 * 文件格式（v0.7.9 起规则是统一的 `{cwd, paths[], tools[]}` 三元组）：
 * {
 *   "version": 1,
 *   "rules": [
 *     { "cwd": "/Volumes/.../projectA", "product": "deveco",
 *       "paths": ["/Users/.../AGENTS.md", "/Users/..."],
 *       "tools": ["qoder:Bash"],
 *       "grantedAt": "2026-09-06T...", "note": "用户在授权界面点击总是允许(项目内)" }
 *   ]
 * }
 *
 * 判定（与内存会话规则、工作区默认规则、provider 白名单**共用**
 * `lib/permission-rules.js` 的同一个评估器）：
 *   路径档 —— 请求 cwd === 规则 cwd，且请求路径**全部**落在规则 paths 某项的
 *              子树内（目录子树；不再是字面全等集合包含）；
 *   工具档 —— 请求 cwd === 规则 cwd，且解析出的工具名 ∈ 规则 tools
 *              （与本次路径无关；tools 名必须带产品前缀，裸名靠规则的 product 补，
 *               补不出就不参与匹配）。
 * tools 是**用户手写**维度：授权球的「总是允许(项目内)」仍只落 paths，
 * 不会因为点过一次某条命令就把该工具名永久写进磁盘。
 * 老文件（没有 tools 字段）必须照旧能读、能命中。
 * 文件损坏 → 按空处理并告警（下次写入自愈）；AI 从不写入，只有用户交互触发。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { evaluateRuleSources } from './permission-rules.js'

const DEFAULT_DIR = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'data',
  'dsh-plugin-product-subagents',
)
const FILE_NAME = 'allowlist.json'
const VERSION = 1

const stringList = (v) => (Array.isArray(v) ? [...new Set(v.filter((p) => typeof p === 'string' && p.trim()))] : [])

/** 读用户授权白名单（只读；损坏/缺失 → 空规则 + 告警） */
export function readUserAllowlist(dataDir = DEFAULT_DIR) {
  try {
    const file = path.join(dataDir, FILE_NAME)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rules = Array.isArray(raw && raw.rules) ? raw.rules : []
    // v0.7.9：paths **或** tools 任一存在即为合法规则——只有 tools 的规则是用户手写的
    // 工具名档；两者都没有的规则没有任何可命中维度，丢掉（旧写法只认 paths，
    // 会让手写 tools 规则被静默忽略）。
    return rules.filter((r) => r && typeof r === 'object'
      && (stringList(r.paths).length > 0 || stringList(r.tools).length > 0))
      .map((r) => ({ ...r, paths: stringList(r.paths), tools: stringList(r.tools) }))
  } catch (err) {
    console.warn(`[product-subagents] 用户授权白名单读取失败（按空处理，下次写入自愈）: ${err.message}`)
    return []
  }
}

/**
 * 追加一条用户手动授权（原子写）。rule.cwd 为必填作用域（工作目录）；
 * 相同 (cwd, paths, tools) 幂等合并（只更新时间）。
 */
export function appendUserRule(rule, dataDir = DEFAULT_DIR) {
  const rules = readUserAllowlist(dataDir)
  const norm = {
    cwd: typeof rule.cwd === 'string' && rule.cwd.trim() ? path.normalize(rule.cwd.trim()) : null,
    product: typeof rule.product === 'string' ? rule.product : null,
    paths: stringList(rule.paths),
    tools: stringList(rule.tools),
    grantedAt: rule.grantedAt || new Date().toISOString(),
    note: typeof rule.note === 'string' ? rule.note : '用户在授权界面点击总是允许（项目内）',
  }
  if (!norm.cwd || (norm.paths.length === 0 && norm.tools.length === 0)) return { ok: false, error: 'cwd 或 paths/tools 缺失' }
  const sig = (r) => JSON.stringify([r.cwd, [...(r.paths || [])].sort(), [...(r.tools || [])].sort()])
  const dup = rules.find((r) => sig(r) === sig(norm))
  if (dup) {
    dup.grantedAt = norm.grantedAt
    dup.note = norm.note
    if (norm.product) dup.product = norm.product
  } else {
    rules.push(norm)
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const file = path.join(dataDir, FILE_NAME)
    const tmp = path.join(dataDir, `.${FILE_NAME}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, rules }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, count: rules.length }
  } catch (err) {
    console.error(`[product-subagents] 用户授权白名单写入失败: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

/**
 * 用户落盘规则是否覆盖本次请求：与内存/工作区/provider 规则走同一个评估器。
 * @param {object[]} rules readUserAllowlist 结果
 * @param {string|null} cwd 当前子代理工作目录（规范化后比较）
 * @param {string[]} reqPaths 本次请求涉及路径
 * @param {{product?:string, toolName?:string}} [toolCtx] v0.7.9：给了才可能命中
 *        工具名档（`tools`）；缺省时行为与历史一致（只按路径判定）
 */
export function userRulesCover(rules, cwd, reqPaths, toolCtx = null) {
  if (!cwd) return false
  const paths = Array.isArray(reqPaths) ? reqPaths : []
  if (paths.length === 0 && (!toolCtx || !toolCtx.toolName)) return false
  const r = evaluateRuleSources(
    [{ tier: 'disk', rules: Array.isArray(rules) ? rules : [] }],
    { cwd, paths, product: toolCtx && toolCtx.product, toolName: toolCtx && toolCtx.toolName },
  )
  return r.allowed
}
