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
 * 文件格式：
 * {
 *   "version": 1,
 *   "rules": [
 *     { "cwd": "/Volumes/.../projectA", "product": "deveco",
 *       "paths": ["/Users/.../AGENTS.md", "/Users/..."],
 *       "grantedAt": "2026-09-06T...", "note": "用户在授权界面点击总是允许(项目内)" }
 *   ]
 * }
 *
 * 判定：当前请求的 cwd 相同、且 paths 全部命中该规则 → allow_always。
 * 文件损坏 → 按空处理并告警（下次写入自愈）；AI 从不写入，只有用户交互触发。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { allowlistDecision } from './allowlist.js'

const DEFAULT_DIR = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'data',
  'dsh-plugin-product-subagents',
)
const FILE_NAME = 'allowlist.json'
const VERSION = 1

/** 读用户授权白名单（只读；损坏/缺失 → 空规则 + 告警） */
export function readUserAllowlist(dataDir = DEFAULT_DIR) {
  try {
    const file = path.join(dataDir, FILE_NAME)
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rules = Array.isArray(raw && raw.rules) ? raw.rules : []
    return rules.filter((r) => r && typeof r === 'object' && Array.isArray(r.paths))
  } catch (err) {
    console.warn(`[product-subagents] 用户授权白名单读取失败（按空处理，下次写入自愈）: ${err.message}`)
    return []
  }
}

/**
 * 追加一条用户手动授权（原子写）。rule.cwd 为必填作用域（工作目录）；
 * 相同 (cwd, paths 集合) 幂等合并（只更新时间）。
 */
export function appendUserRule(rule, dataDir = DEFAULT_DIR) {
  const rules = readUserAllowlist(dataDir)
  const norm = {
    cwd: typeof rule.cwd === 'string' && rule.cwd.trim() ? path.normalize(rule.cwd.trim()) : null,
    product: typeof rule.product === 'string' ? rule.product : null,
    paths: Array.isArray(rule.paths) ? [...new Set(rule.paths.filter((p) => typeof p === 'string' && p.trim()))] : [],
    grantedAt: rule.grantedAt || new Date().toISOString(),
    note: typeof rule.note === 'string' ? rule.note : '用户在授权界面点击总是允许（项目内）',
  }
  if (!norm.cwd || norm.paths.length === 0) return { ok: false, error: 'cwd 或 paths 缺失' }
  const dup = rules.find((r) =>
    r.cwd === norm.cwd &&
    JSON.stringify([...(r.paths || [])].sort()) === JSON.stringify([...norm.paths].sort()),
  )
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
 * 用户落盘规则是否覆盖本次请求：要求存在某条规则其 cwd 与请求工作目录一致
 * （同项目）且 paths 全部命中该规则路径集。
 * @param {object[]} rules readUserAllowlist 结果
 * @param {string|null} cwd 当前子代理工作目录（规范化后比较）
 * @param {string[]} reqPaths 本次请求涉及路径
 */
export function userRulesCover(rules, cwd, reqPaths) {
  if (!cwd || !Array.isArray(reqPaths) || reqPaths.length === 0) return false
  const normCwd = path.normalize(String(cwd))
  for (const rule of rules || []) {
    if (!rule.cwd) continue
    if (path.normalize(String(rule.cwd)) !== normCwd) continue // 仅同项目生效
    const { allowed } = allowlistDecision(reqPaths, rule.paths)
    if (allowed) return true
  }
  return false
}
