import { createClaudeBridge } from './bridges/claude.js'
import { createCodexBridge } from './bridges/codex.js'
import { createAcpBridge } from './bridges/acp.js'
import { authChecks } from './availability.js'

/**
 * Config-driven provider registry.
 *
 * Built-ins: `claude-code` (type claude), `codex` (type codex), `acp`
 * (type acp, default command `opencode acp`).
 *
 * Custom providers are added (or built-ins overridden) through
 * `config.providers`:
 *
 *   config:
 *     providers:
 *       cursor:    { type: acp, command: agent, args: [acp] }      # Cursor CLI: `agent acp`
 *       codebuddy: { type: acp, command: cbc, args: [--acp] }      # CodeBuddy: `cbc --acp`
 *       gemini:    { type: acp, command: gemini, args: [--acp] }   # Gemini CLI: `gemini --acp`
 *       opencode:  { type: acp, command: opencode, args: [acp] }   # opencode: `opencode acp`
 *       claude-code: { command: claude, env: { ANTHROPIC_API_KEY: '...' } }
 *
 * Invocations verified against each product's own docs (Cursor 2026: the CLI
 * binary is `agent`, so ACP mode is `agent acp` — older references to
 * `cursor-agent acp` are outdated).
 *
 * Any ACP-capable CLI works through the generic acp bridge (persistent
 * process, session/load resume, dead-process reconnect). type may also be
 * `claude` or `codex` to override a built-in's command/env/timeout.
 */
const BUILT_INS = {
  'claude-code': { type: 'claude', command: 'claude', checkAuth: authChecks['claude-code'] },
  codex: { type: 'codex', command: 'codex', checkAuth: authChecks.codex },
  acp: { type: 'acp', command: 'opencode', args: ['acp'], checkAuth: authChecks.acp },
}

export function buildProviders(config = {}) {
  const providers = {}
  const entries = { ...BUILT_INS, ...(config.providers || {}) }
  for (const [name, def] of Object.entries(entries)) {
    const base = BUILT_INS[name] || {}
    const type = def.type || base.type || 'acp'
    const command = def.command || base.command || (type === 'claude' ? 'claude' : type === 'codex' ? 'codex' : 'opencode')
    providers[name] = {
      name,
      type,
      command,
      args: def.args || base.args || (type === 'acp' ? ['acp'] : []),
      env: def.env || base.env || {},
      timeoutMs: def.timeoutMs !== undefined ? def.timeoutMs : base.timeoutMs,
      requestsPerMinute: def.requestsPerMinute !== undefined ? def.requestsPerMinute : base.requestsPerMinute,
      rateLimitRetries: def.rateLimitRetries !== undefined ? def.rateLimitRetries : base.rateLimitRetries,
      rateLimitBackoffMs: def.rateLimitBackoffMs !== undefined ? def.rateLimitBackoffMs : base.rateLimitBackoffMs,
      watchdogNoOutputMs: def.watchdogNoOutputMs !== undefined ? def.watchdogNoOutputMs : base.watchdogNoOutputMs,
      permission: def.permission !== undefined ? def.permission : base.permission,
      allowWritePaths: def.allowWritePaths !== undefined ? def.allowWritePaths : base.allowWritePaths,
      checkAuth: def.checkAuth || base.checkAuth || authChecks.acp,
    }
  }
  return providers
}

/**
 * Create the right bridge for one provider definition.
 * @param {object} provider  buildProviders 产出的 provider 定义
 * @param {{permissionHandler?: Function}} [extra] 注入 ACP requestPermission 交互处理器
 */
export function createBridgeFor(provider, extra = {}) {
  const options = {
    command: provider.command,
    env: provider.env,
    ...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
    ...(provider.requestsPerMinute !== undefined ? { requestsPerMinute: provider.requestsPerMinute } : {}),
    ...(provider.rateLimitRetries !== undefined ? { rateLimitRetries: provider.rateLimitRetries } : {}),
    ...(provider.rateLimitBackoffMs !== undefined ? { rateLimitBackoffMs: provider.rateLimitBackoffMs } : {}),
    ...(provider.watchdogNoOutputMs !== undefined ? { watchdogNoOutputMs: provider.watchdogNoOutputMs } : {}),
  }
  // v0.4.0 权限策略映射到 acp.js 决策参数：
  //   interactive → permissionHandler（经宿主审批弹窗）；
  //   read → autoGrant='read'（只读自动放行，其余 fail-closed）；
  //   all → autoGrant='all'；deny → 无 handler 无 autoGrant（fail-closed 拒绝）。
  if (provider.type === 'claude') return createClaudeBridge(options)
  if (provider.type === 'codex') return createCodexBridge(options)
  const acpOptions = { ...options, args: provider.args && provider.args.length ? provider.args : ['acp'] }
  // v0.5.6：人类决策等待（授权/问答）期间豁免看门狗/空闲回收的判定回调（index.js 注入）
  if (typeof extra.isHumanWaitPending === 'function') acpOptions.isHumanWaitPending = extra.isHumanWaitPending
  const permission = provider.permission ?? 'interactive'
  if (permission === 'interactive' && typeof extra.permissionHandler === 'function') {
    acpOptions.permissionHandler = extra.permissionHandler
  } else if (permission === 'read') {
    acpOptions.autoGrant = 'read'
  } else if (permission === 'all') {
    acpOptions.autoGrant = 'all'
  }
  return createAcpBridge(acpOptions)
}

/** Relay persona for one provider; custom providers get a generic ACP one. */
export function providerPersona(name, provider) {
  const display = provider && provider.command ? `${name} (${provider.command})` : name
  if (provider && provider.type === 'claude') {
    return `You are a relay bridge to the Claude Code CLI agent. For every user message you receive, call product_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — Claude Code owns the full context and file access in this workspace. After product_submit returns Claude Code's answer, relay it faithfully to the agent that started you with the report tool.`
  }
  if (provider && provider.type === 'codex') {
    return `You are a relay bridge to the Codex CLI agent. For every user message you receive, call product_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — Codex owns the full context and file access in this workspace. After product_submit returns Codex's answer, relay it faithfully to the agent that started you with the report tool.`
  }
  return `You are a relay bridge to the ACP CLI agent ${display} in this workspace. For every user message you receive, call product_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — the ACP agent owns the full context and file access. After product_submit returns the ACP agent's answer, relay it faithfully to the agent that started you with the report tool.`
}
