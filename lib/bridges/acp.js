import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { spawnProduct } from '../run.js'
import { acquireSlot, reportRateLimited, reportSuccess } from '../throttle.js'

/** Rate-limit detection: error messages products return when throttled. */
function isRateLimited(error) {
  if (!error) return false
  if (error.code === 'RATE_LIMITED') return true
  const msg = String((error && (error.message || error.error)) || error)
  return /rate\s*limit|too\s*many\s*requests|throttl|\b429\b|quota|限流|频率限制|请求过于频繁/i.test(msg)
}

/**
 * v0.4.0：从 ACP RequestPermission 的 toolCall 中提取涉及的文件路径。
 * 不同产品载荷形态不同：有的放 arguments（{path/file/dir/...}），有的把
 * 人类可读描述放 content text。递归提取 arguments 对象里的字符串值 + 从
 * content 文本里正则抓绝对/家目录路径，供白名单自动放行与弹窗展示使用。
 * @param {object|null} toolCall ACP requestPermission 的 toolCall
 * @returns {string[]} 提取到的路径（去重、保序）
 */
export function extractPaths(toolCall) {
  const out = new Set()
  const PATH_KEY = /(^|_)(path|file|dir|directory|target|src|dest|source|uri|location)(_|$)/i
  const PATH_RE = /(~|\/Users\/|\/Volumes\/|\/tmp\/|\/private\/|\/home\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|\/workspace\/|\/workspaces\/)[^\s"'`]+/g
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      for (const m of node.matchAll(PATH_RE)) out.add(m[0].replace(/[,;:)\]}>]+$/, ''))
      return
    }
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (PATH_KEY.test(k) && typeof v === 'string' && v.length > 0 && !v.includes(' ')) {
          out.add(v)
        }
        walk(v)
      }
    }
  }
  walk(toolCall)
  return [...out]
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

/**
 * ACP bridge: one persistent child process speaking the Agent Client Protocol
 * over stdio (e.g. `opencode acp`, `agent acp` (Cursor), `cbc --acp`). A session
 * lives in that process; later prompts on the same session continue the
 * conversation, and `session/load` reconnects a persisted session id.
 *
 * Model / effort selection: ACP has no portable model flag. `settings.model`
 * is attempted through `setSessionConfigOption` and `settings.reasoningEffort`
 * through the `effort` config option (opencode-style agents expose it only when
 * the selected model declares effort variants, and the value must be one of
 * those variants). Both are best-effort: on failure the agent keeps its own
 * configuration and a warning is logged; configure the agent's own model via
 * its CLI flags / config (`args` option) instead.
 */
export function createAcpBridge(options = {}) {
  const command = options.command || 'opencode'
  const args = options.args || ['acp']
  const env = options.env || {}

  function makeClient(onText, onActivity) {
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
        try {
          console.warn(`[product-subagents:perm] ${command} requestPermission toolCall=${JSON.stringify(params && params.toolCall)?.slice(0, 500)} options=${JSON.stringify((params && params.options) || [])?.slice(0, 300)}`)
        } catch { /* 诊断失败忽略 */ }
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

  async function connect(cwd) {
    return new Promise((resolve, reject) => {
      // 测试缝：options.spawn 注入假进程工厂（watchdog 单测不依赖真实 CLI）；
      // 生产路径无 options.spawn → 走 spawnProduct 真实拉起。
      const spawnFn = typeof options.spawn === 'function' ? options.spawn : spawnProduct
      const proc = spawnFn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, ...env },
      })
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
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
      })
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
   * Re-establish the ACP connection after the server process died: spawn a
   * fresh server, try session/load for the same session id (when the agent
   * supports it), else fall back to a new session. Mutates `remote` in place.
   */
  async function reconnectRemote(remote, cwd) {
    const handle = await connect(cwd)
    let id = remote.sessionId
    try {
      // ACP session/load requires cwd + mcpServers: strict agents (deveco /
      // opencode) validate the request and reject it without them, so an
      // incomplete call would silently reset every reconnect to a new session.
      const loaded = await handle.connection.loadSession({ sessionId: id, cwd, mcpServers: [] })
      handle.sessionId = id
      handle.configOptions = loaded && loaded.configOptions
    } catch (error) {
      if (id) console.warn(`product-subagents: session/load failed for ${id} (${error && error.message ? error.message : error}); starting a new session`)
      const session = await handle.connection.newSession({ cwd, mcpServers: [] })
      handle.sessionId = session.sessionId
      handle.configOptions = session.configOptions
    }
    remote.proc = handle.proc
    remote.connection = handle.connection
    remote.drainText = handle.drainText
    remote.progressRef = handle.progress
    remote.stderrTail = handle.stderrTail
    remote.drainStderr = handle.drainStderr
    remote.sessionId = handle.sessionId
    remote.configOptions = handle.configOptions
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
          const progress = remote.progressRef ? remote.progressRef() : {}
          const lastActivity = progress.lastActivityAt || startedAt
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
      const session = await handle.connection.newSession({ cwd, mcpServers: [] })
      handle.sessionId = session.sessionId
      handle.configOptions = session.configOptions
      handle.progressRef = handle.progress
      return { kind: 'acp', ...handle }
    },
    async submit(remote, task, signal, cwd, settings = {}, isClosed = () => false) {
      if (settings.model) {
        try {
          await remote.connection.setSessionConfigOption({ sessionId: remote.sessionId, configId: 'model', value: settings.model })
        } catch (error) {
          console.warn(`product-subagents: setSessionConfigOption(model=${settings.model}) failed (${error && error.message ? error.message : error}); using the agent's default model`)
        }
      }
      if (settings.reasoningEffort) {
        try {
          await remote.connection.setSessionConfigOption({ sessionId: remote.sessionId, configId: 'effort', value: settings.reasoningEffort })
        } catch (error) {
          if (!remote.effortWarned) {
            remote.effortWarned = true
            const advertised = Array.isArray(remote.configOptions)
              ? remote.configOptions.map((o) => o && o.id).filter(Boolean).join(', ')
              : 'not reported'
            console.warn(`product-subagents: effort "${settings.reasoningEffort}" not accepted by the agent (advertised config options: ${advertised}); effort request ignored`)
          }
        }
      }
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
      try {
        // session/load must carry cwd + mcpServers (strict agents like
        // deveco/opencode validate params and would reject sessionId alone).
        const loaded = await handle.connection.loadSession({ sessionId: id, cwd, mcpServers: [] })
        handle.configOptions = loaded && loaded.configOptions
      } catch (error) {
        if (id) console.warn(`product-subagents: session/load failed for ${id} (${error && error.message ? error.message : error}); starting a new session`)
        // the agent does not support loadSession (negotiated per child) or
        // the session is gone: fall back to a fresh session
        const session = await handle.connection.newSession({ cwd, mcpServers: [] })
        id = session.sessionId
        handle.configOptions = session.configOptions
      }
      handle.sessionId = id
      handle.progressRef = handle.progress
      return { kind: 'acp', ...handle }
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
