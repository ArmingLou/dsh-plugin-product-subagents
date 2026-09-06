/**
 * dsh-plugin-product-subagents —— 权限自动放行白名单（v0.4.0）
 *
 * ACP 产品（deveco/opencode 等）每次访问"越权路径"都会发 RequestPermission；
 * 交互审批（弹窗）虽已打通，但高频只读场景（如反复读 ~/.dsh 配置）逐次弹窗
 * 太打扰。白名单把"已明确授权的只读路径"直接自动放行：
 *
 *   providers.deveco:
 *     permission: interactive     # 未命中白名单时仍交互弹窗
 *     allowWritePaths:
 *       - ~/.dsh/**               # 家目录 .dsh 下全部只读放行
 *       - /Users/arming/.nvm/**   # 绝对路径前缀
 *
 * 语义：ACP 请求涉及的所有路径【全部】落在某个 allowWritePaths 前缀内时自动
 * allow_once（不弹窗）；任一路径不在白名单 → 走交互审批。路径按语义展开 ~、
 * 去除尾部符号、做前缀匹配（目录边界：/a/b 不匹配 /a/bc）。
 */

import os from 'node:os'
import path from 'node:path'

/** 规范化候选路径：展开 ~、去尾部分隔符与常见干扰符号 */
export function normalizeCandidate(raw) {
  if (typeof raw !== 'string') return null
  let p = raw.trim().replace(/^["']|["']$/g, '')
  // 去掉常见尾部标点（ACP 载荷文本里路径后常跟逗号/引号/括号）
  p = p.replace(/[,;:)\]}>，。；]+$/, '')
  if (!p) return null
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 判断路径是否命中某条白名单规则。
 * 规则支持：目录前缀（含尾部 /** 或 *）、精确文件路径；~ 展开；目录边界匹配
 * （/a/b 规则命中 /a/b/x 但不命中 /a/bc）。路径已存在时用绝对路径比较。
 */
export function pathAllowed(candidate, rules) {
  const p = normalizeCandidate(candidate)
  if (!p || !Array.isArray(rules) || rules.length === 0) return false
  for (const rawRule of rules) {
    if (typeof rawRule !== 'string' || !rawRule.trim()) continue
    let rule = rawRule.trim().replace(/["']/g, '')
    // 目录通配尾：/a/b/**、/a/b/*、或规则以 / 结尾（/tmp/data/）都按目录前缀处理
    const isDir = /[/\\]\*\*$|[/\\]\*$/.test(rule) || /[/\\]$/.test(rule)
    rule = rule.replace(/[/\\]\*\*$|[/\\]\*$/, '')
    // 去掉尾部目录分隔符（保留根 '/' 本身）
    if (rule.length > 1) rule = rule.replace(/[/\\]+$/, '')
    rule = normalizeCandidate(rule)
    if (!rule) continue
    if (!path.isAbsolute(rule) || !path.isAbsolute(p)) continue
    const normP = path.normalize(p)
    const normRule = path.normalize(rule)
    if (normP === normRule) return true
    if (isDir && (normP.startsWith(normRule + path.sep) || normP.startsWith(normRule + '/'))) return true
    // 规则本身就是目录且候选是其子路径（没写通配也按目录宽容）——仅当规则
    // 无扩展名且候选以规则+分隔符开头时视为目录前缀
    if (!isDir && !/\.[A-Za-z0-9]{1,8}$/.test(normRule) && (normP.startsWith(normRule + path.sep) || normP.startsWith(normRule + '/'))) {
      return true
    }
  }
  return false
}

/**
 * 白名单决策：ACP 请求涉及的所有路径是否全部命中白名单。
 * @param {string[]} paths  extractPaths 提取的请求路径（可能为空）
 * @param {string[]} rules  allowWritePaths 白名单规则
 * @returns {{allowed: boolean, covered: string[], uncovered: string[]}}
 */
export function allowlistDecision(paths, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { allowed: false, covered: [], uncovered: [...(paths || [])] }
  }
  const covered = []
  const uncovered = []
  for (const p of paths || []) {
    if (pathAllowed(p, rules)) covered.push(p)
    else uncovered.push(p)
  }
  // 请求没提任何路径：无法证明在授权范围内 → 不自动放行（交互）
  if ((paths || []).length === 0) return { allowed: false, covered: [], uncovered: [] }
  // 全部命中才放行；部分命中（混合越权）→ 交互让用户判断
  return { allowed: uncovered.length === 0, covered, uncovered }
}
