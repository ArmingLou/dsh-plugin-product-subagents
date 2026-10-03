/**
 * v0.7.3：`product_submit` 失败的【等级划分】。
 *
 * 编排层（dsh-agent-dispatch）据此决定三件事：
 *   - `failover`    → 静默换下一档 routes，重投同一任务；【不得】对父代理释放任何
 *                     中间态失败/完成信号（限额、限流、空正文、超时、传输中断、
 *                     服务端 5xx 等"换一档可能就好了"的故障）；
 *   - `fatal`       → 不换档（重试也不会有改善：认证失败、参数非法、语法错误、
 *                     模型/配置不存在、人为拒绝、fallback 链已耗尽）；
 *   - `interrupted` → 人为中断/取消，尊重意图，既不换档也不当产品故障。
 *
 * 判定顺序（先精确后模糊，宁可换档也不误杀）：
 *   1) 配置覆盖 `submitFailureGrades`（code → grade，大小写不敏感）；
 *   2) 精确错误码集合；
 *   3) 错误文本正则：先认"可换档"特征，再认"致命"特征；
 *   4) 兜底 = `failover`——未知错误默认允许换档，只有被明确归入 `fatal`
 *      的那一类才停止换档（避免"任何错误一律报失败"或"一律换档"两种极端）。
 *
 * 与编排层的关系：product-subagents 是分级的**权威来源**，它把 `grade` 随
 * `product-subagents/submit-failed` 事件下发；编排层优先采信该字段，仅在对接
 * 旧版本（无 grade 字段）时退回自己的同构实现兜底。
 */

/** 可换档：静默换下一档，不释放中间态信号。 */
export const FAILOVER = 'failover'
/** 致命：不换档，直接作为最终失败上报。 */
export const FATAL = 'fatal'
/** 人为中断：尊重取消意图，既不换档也不算产品故障。 */
export const INTERRUPTED = 'interrupted'

/**
 * v0.7.4：编排层已把本档换掉之后，product-submit 抛出的收尾错误码。
 * 归入 `interrupted`（人为停止），杜绝交接后再触发一条换档链。
 */
export const FAILOVER_HANDED_OFF = 'FAILOVER_HANDED_OFF'

/**
 * v0.7.4：链走完仍失败（或 notify 模式超时未换档）时，product-submit 抛出的错误码。
 * 归入 `fatal`：重试也不会改善，必须由人/主代理决定是否再派。
 */
export const FAILOVER_EXHAUSTED = 'FAILOVER_EXHAUSTED'

/**
 * v0.7.4：换档交接模式（与 dsh-agent-dispatch 的 `failoverMode` 同名同义）。
 * 三种模式一律使用**同级**替补档（主代理的直接子级），差别只在谁来决定、何时决定：
 *   notify-then-auto（默认）→ 发唤醒信号等主代理 agent_failover；超时由编排层自动换档
 *   notify                 → 只等主代理；超时按失败收尾
 *   auto                   → 不等待，立即由编排层换档
 */
export const FAILOVER_MODES = new Set(['auto', 'notify', 'notify-then-auto'])

/** 人为中断/取消（含桥接层内部信号，与 dispatch 的 INTERRUPT_CODES 同构并更宽）。 */
const INTERRUPT_CODES = new Set([
  'SUBMIT_ABORTED',
  'WATCHDOG_CLOSED',
  'WATCHDOG_FREEZE',
  '_ABORT',
  '_CLOSED',
  // v0.7.4：编排层已把本档换掉（agent_failover / 超时自动换档）后抛出的收尾错误码。
  // 语义是"人为停止本档"——主代理已决定换到下一档。**绝不可**被当成可换档的产品故障：
  // 交接完成后再跑一条链就会让同一任务出现第二个替补子代理。
  FAILOVER_HANDED_OFF,
])

/** 明确的"换一档可能就好"的错误码。 */
const FAILOVER_CODES = new Set([
  'EMPTY_RESPONSE',
  'SUBMIT_TIMEOUT',
  'RATE_LIMITED',
  'RATE_LIMIT_EXHAUSTED',
  'TRANSPORT_DEAD',
  'PRODUCT_CRASH',
  'BRIDGE_DISPOSED',
  'PROVIDER_UNAVAILABLE',
  'USAGE_LIMIT',
])

/** 明确的"重试也不会改善"的错误码。 */
const FATAL_CODES = new Set([
  'FAILOVER_EXHAUSTED',
  'AUTH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_API_KEY',
  'AUTH_FAILED',
  'CONFIG_OPTION_ERROR',
  'PERMISSION_DENIED',
  'PERMISSION_REJECTED',
  'INVALID_ARGUMENT',
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'SYNTAX_ERROR',
  'UNSUPPORTED_CAPABILITY',
  'MODEL_NOT_FOUND',
  'NO_PROVIDER',
  'RECONNECT_BLOCKED',
  'CHILD_CLOSED',
])

/**
 * 文本特征：限额/限流/容量/瞬态传输故障。
 * 注意 `insufficient_quota` 与 `余额不足` 也在此列——按编排需求，它们属于
 * "静默换下一档"，由 routes 链去试别的 provider/模型，而不是立刻报失败。
 */
const FAILOVER_TEXT =
  /rate\s*limit|too\s*many\s*requests|throttl|\b429\b|quota|insufficient_quota|余额不足|欠费|overload|server_error|internal_error|service_unavailable|temporarily\s+unavailable|try\s+again\s+later|timeout|timed\s+out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket\s*hang\s*up|stream\s*closed|connection\s*(closed|reset|refused)|broken\s*pipe|transport|empty\s*(response|body|reply|output)|空正文|无响应|无任何文本输出|无文本输出|进程退出|已退出/

/** 文本特征：认证/鉴权、参数非法、语法错误、模型或配置不存在、人为拒绝。 */
const FATAL_TEXT =
  /\b401\b|\b403\b|unauthor|forbidden|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key[\s_-]*(invalid|missing|not\s*found)|authentication|认证失败|鉴权失败|未授权|invalid[\s_-]*(argument|request|param|parameter)|schema[\s_-]*(validation|error)|语法错误|参数非法|参数错误|bad\s*request|unprocessable|not[\s_-]*supported|unsupported|model[\s_-]*not[\s_-]*found|no\s+such\s+model|unknown\s+model|permission[\s_-]*denied|permission[\s_-]*rejected|已被拒绝|用户拒绝|操作被拒绝/

/**
 * 把一次提交失败划入 `failover` / `fatal` / `interrupted`。
 *
 * @param {string|null|undefined} code    错误码（如 `EMPTY_RESPONSE`）。
 * @param {string|null|undefined} message 错误文本（正则兜底判据）。
 * @param {Record<string,string>|null|undefined} overrides 配置覆盖 code → grade。
 * @returns {'failover'|'fatal'|'interrupted'}
 */
export function classifySubmitFailure(code, message, overrides) {
  const raw = typeof code === 'string' ? code.trim() : ''
  const key = raw.toUpperCase()
  if (overrides && typeof overrides === 'object') {
    const picked = overrides[raw] ?? overrides[key]
    if (picked === FAILOVER || picked === FATAL || picked === INTERRUPTED) return picked
  }
  if (INTERRUPT_CODES.has(key)) return INTERRUPTED
  if (FAILOVER_CODES.has(key)) return FAILOVER
  if (FATAL_CODES.has(key)) return FATAL
  const text = typeof message === 'string' ? message : message == null ? '' : String(message)
  if (!text) return FAILOVER
  if (FAILOVER_TEXT.test(text)) return FAILOVER
  if (FATAL_TEXT.test(text)) return FATAL
  return FAILOVER
}