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
  const describe = () => {
    if (req.description) return req.description
    const tool = req.toolCall
    const name = tool && (tool.name || tool.toolName) ? `${tool.name || tool.toolName}` : '工具调用'
    const text = tool && Array.isArray(tool.content)
      ? tool.content.map((b) => (b && (b.text || (b.content && b.content.text))) || '').filter(Boolean).join(' ').slice(0, 200)
      : ''
    return text ? `${name}: ${text}` : name
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
    const proc = spawnProduct(command, args, {
      // stderr is captured (not inherited) so product-side errors — e.g. a
      // permission request being rejected, an auth/network failure — are not
      // silently lost: they surface attached to submit errors (see promptOnce)
      // and in drainStderr for diagnostics.
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...env },
    })
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
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    return {
      proc,
      connection,
      progress: () => progress,
      drainText() {
        const text = textBuffer
        textBuffer = ''
        return text
      },
      /** Tail of the product's stderr since connect (ring buffer, 4 KiB). */
      stderrTail: () => stderrTail,
      drainStderr() {
        const text = stderrTail
        stderrTail = ''
        return text
      },
    }
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
   * One prompt round bounded by an IDLE timeout, with a wide total-duration
   * safety valve and an empty-body check.
   *
   * ACP cannot cancel an in-flight prompt, so a wedged agent (network fully
   * down, silent model failure, stuck permission loop) would otherwise hold
   * the caller forever. But a slow network or a slow model is NOT a failure:
   * while the session keeps emitting any activity (text chunks, progress or
   * state updates — tracked via lastActivityAt) the round is left running,
   * no matter how long it takes. Only when nothing at all arrives for
   * `idleTimeoutMs` (default 10 min) is the session judged dead. A much
   * wider `timeoutMs` total cap (default 60 min) guards against a pathological
   * endless stream.
   *
   * On timeout the remote may still be executing: the caller (submit's catch)
   * force-disposes the process so the next submit reconnects the same session
   * id instead of piling prompts onto a stuck session. A live session that
   * returns zero text (drainText empty) is treated as a failure too — e.g.
   * deveco answering only a session marker with no body.
   */
  async function promptOnce(remote, task) {
    const idleMs = Math.max(1000, Number(options.idleTimeoutMs) || 600000)
    const totalMs = Math.max(idleMs + 1000, Number(options.timeoutMs) || 3600000)
    const startedAt = Date.now()
    let timer
    const timeout = new Promise((_, reject) => {
      const check = () => {
        const now = Date.now()
        const progress = remote.progressRef ? remote.progressRef() : {}
        const lastActivity = progress.lastActivityAt || startedAt
        if (now - lastActivity >= idleMs) {
          reject(Object.assign(
            new Error(`${command} ACP 会话空闲超时：${idleMs}ms 无任何输出/更新`),
            { code: 'SUBMIT_TIMEOUT', product: command },
          ))
          return
        }
        if (now - startedAt >= totalMs) {
          reject(Object.assign(
            new Error(`${command} ACP prompt 总时长超限(${totalMs}ms)`),
            { code: 'SUBMIT_TIMEOUT', product: command },
          ))
          return
        }
        timer = setTimeout(check, Math.min(5000, Math.max(500, Math.floor(idleMs / 20))))
      }
      timer = setTimeout(check, Math.min(5000, Math.max(500, Math.floor(idleMs / 20))))
    })
    let response
    try {
      response = await Promise.race([
        remote.connection.prompt({ sessionId: remote.sessionId, prompt: [{ type: 'text', text: task }] }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
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

  return {
    async create(cwd) {
      const handle = await connect(cwd)
      const session = await handle.connection.newSession({ cwd, mcpServers: [] })
      handle.sessionId = session.sessionId
      handle.configOptions = session.configOptions
      handle.progressRef = handle.progress
      return { kind: 'acp', ...handle }
    },
    async submit(remote, task, signal, cwd, settings = {}) {
      if (settings.model) {
        try {
          await remote.connection.setSessionConfigOption({ sessionId: remote.sessionId, configId: 'model', value: settings.model })
        } catch (error) {
          // agent does not support the option or the value is not in its list;
          // fall back to the agent's own config — but say so, a typo'd model id
          // must not be silently ignored.
          console.warn(`product-subagents: setSessionConfigOption(model=${settings.model}) failed (${error && error.message ? error.message : error}); using the agent's default model`)
        }
      }
      if (settings.reasoningEffort) {
        try {
          // opencode-style agents expose an "effort" session config option only
          // when the selected model declares effort variants; the value must be
          // one of those variants (e.g. low/medium/high).
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
      // The persistent server process may have died between turns (crash, OOM,
      // manual kill). The session id itself was captured at session/new, so
      // continuity is preserved wherever the agent allows session/load. If the
      // prompt fails on a dead transport, reconnect once and retry (the prompt
      // cannot have been delivered to a dead process, so a retry is safe).
      // A SUBMIT_TIMEOUT means the remote may still be executing (ACP has no
      // in-flight cancellation): force-dispose the process so a wedged agent
      // never keeps an orphan turn, and the next submit reconnects the same
      // session id. EMPTY_RESPONSE is a live-session failure — surface it.
      //
      // Client-side throttling (requestsPerMinute) paces prompts to the
      // product's account-level rate limit (shared across all sessions via
      // acquireSlot). Rate-limit errors (429 / "rate limit") are retried with
      // exponential backoff, so a task slowly queued behind a 50/min ceiling
      // still completes instead of failing fast.
      const rpm = Number(options.requestsPerMinute) || 0
      const slotIntervalMs = rpm > 0 ? Math.max(1, Math.round(60000 / rpm)) : 0
      // Default retry budget for 429-style responses: 3 attempts, gated by
      // the shared circuit breaker (throttle.js) which queues every request
      // behind the cooldown, so parallel/back-to-back submits do not each
      // slam the still-hot rate limit with their own independent retries.
      // Set rateLimitRetries: 0 to restore fail-fast behaviour (the breaker
      // still opens and gates subsequent requests).
      const maxRateRetries = options.rateLimitRetries !== undefined
        ? Math.max(0, Number(options.rateLimitRetries))
        : 3
      const rateBackoffMs = Math.max(1000, Number(options.rateLimitBackoffMs) || 60000)
      let rateAttempt = 0
      let reconnected = false
      for (;;) {
        // Wait for a global (per-command) request slot before every prompt —
        // including retries. When the circuit breaker is open (a recent 429),
        // this queues the request until the cooldown expires, so a burst of
        // messages behind a hot rate limit waits in line instead of retrying
        // concurrently.
        await acquireSlot(command, slotIntervalMs)
        try {
          const result = await promptOnce(remote, task)
          // A genuine product response closes the breaker: the next 429
          // starts from a fresh base backoff again.
          reportSuccess(command)
          return result
        } catch (error) {
          // Surface the product's own stderr (permission rejections, auth or
          // network errors…) on every failure — this is what makes a mute
          // session diagnosable instead of a silent empty reply.
          attachStderr(error, remote)
          if (isRateLimited(error)) {
            // Open/widen the shared breaker (exponential cooldown, capped at
            // 10 min) so queued and future submits wait it out together.
            const cooldownMs = reportRateLimited(command, rateBackoffMs)
            if (rateAttempt < maxRateRetries) {
              console.warn(`product-subagents: ${command} 触发限流(${error.message || error})，熔断冷却 ${cooldownMs}ms 后重试 (${rateAttempt + 1}/${maxRateRetries})`)
              rateAttempt += 1
              continue
            }
            console.warn(`product-subagents: ${command} 触发限流且重试预算耗尽(${maxRateRetries} 次)，任务判失败；熔断已开启(${cooldownMs}ms)`)
            throw error
          }
          if (error && error.code === 'SUBMIT_TIMEOUT') {
            try { remote.connection.closeSession({ sessionId: remote.sessionId }).catch(() => {}) } catch { /* gone */ }
            try { remote.proc.kill('SIGKILL') } catch { /* already gone */ }
            remote.connection = null
            remote.proc = null
            console.warn(`product-subagents: ${command} ACP prompt 超时，已强杀进程；下次提交将 reconnect session ${remote.sessionId}`)
            throw error
          }
          if (error && error.code === 'EMPTY_RESPONSE') throw error
          if (!transportDead(remote) || reconnected) throw error
          // Transport died: reconnect (keeps the same session id) and loop
          // back — the top of the loop re-acquires a throttling slot before
          // the retried prompt. Only one reconnect per submit; if it dies
          // again the error surfaces.
          reconnected = true
          await reconnectRemote(remote, cwd)
          continue
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
