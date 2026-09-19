/**
 * dsh-plugin-product-subagents —— provider 级「可用模型 / 可用 effort」目录（v0.6.0）
 *
 * 为什么要 provider 级：ACP 协议没有"无会话清单"能力（`initialize` 只回
 * protocolVersion + agentCapabilities，protocolVersion 恒为 1，不能靠版本号判
 * 能力），模型与 reasoning 档位只能从一次真实会话的 `configOptions` 里取。
 * 编排层（GUI「编辑 Agent」表单）需要"选中产品即可下拉"，所以这里用一条
 * **建完就弃**的会话探测一次，把结果落盘缓存（复用 product-delegate 的
 * create→…→dispose 链路，不重写 ACP 客户端）。
 *
 * 落盘位置（与 allowlist.json 同目录，$DSH_HOME 可覆盖）：
 *   $DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json
 *
 * 文件形状（外部插件按此读取，属跨插件数据面契约）：
 * {
 *   "version": 1,
 *   "updatedAt": "<ISO>",
 *   "providers": {
 *     "<provider>": {
 *       "models": ["<value>"],                             // 纯 value：落盘/生效用的就是它
 *       "modelOptions": [{ "value", "name"?, "description"? }],   // 显示名来源
 *       "efforts": ["<value>"],
 *       "effortOptions": [{ "value", "name"?, "description"? }],
 *       "modelEfforts": { "<modelValue>": ["<effortValue>"] },  // 仅在能明确关联时存在
 *       "modelEffortOptions": { "<modelValue>": [{ "value", "name"? }] },
 *       "defaultModel": "<value>",     // 可选：会话初始 model 的 currentValue（GUI 的 default 项）
 *       "defaultEffort": "<value>",    // 可选：同上，拿不到就省略键
 *       "source": "probe",
 *       "probedAt": "<ISO>",
 *       "error": "<失败原因，成功时省略>"
 *     }
 *   }
 * }
 *
 * 三条硬约束（消费方按此假设）：
 *   1. 本模块**只读产品、只写自己这个缓存**，绝不写用户配置（agents.json 等）；
 *      用户已存的值（如 `deveco/GLM-5.1`）原样保留，探测只填候选与显示名。
 *   2. `models` / `efforts` 纯 value 数组是既有读取路径，永远是增量、不删。
 *   3. 拿不到清单时写空数组 + `error`；空数组的含义是"这次没探到"，
 *      不是"该产品没有这些值"，消费方不得据此纠正用户数据。
 *
 * 注意：efforts 是该产品 effort 配置项（`effort` / `reasoning_effort` /
 * category=`thought_level`，id 与 category 都由产品自定）的**取值域**，由产品
 * 自定义（实测 opencode：low/high/max/default，换 model 后多出 medium/xhigh；
 * qoder：xhigh/low/medium/none）；绝不要把它和 LLM 侧的 reasoning 档位
 * （minimal/xhigh/max 那套）混为一谈。
 * effort 取值域依赖 model，provider 级快照只能是"探测时那个 model 下的档位"，
 * 联动后的权威快照走 child 级 `product-subagents/config-options` 事件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridgeFor } from './providers.js'
import {
  configOptionEntries,
  configOptionValues,
  findEffortOption,
  findModelOption,
} from './bridges/acp.js'

const DEFAULT_DIR = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'data',
  'dsh-plugin-product-subagents',
)
const FILE_NAME = 'provider-catalog.json'
const VERSION = 1
const SOURCE = 'probe'
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_PROBE_TIMEOUT_MS = 30000

/**
 * 从一份 configOptions 解析出模型 / effort 的取值域。
 *
 * 每个维度都同时给两种形态：`models`/`efforts` 是**纯 value 数组**（落盘值，A 侧既有
 * 读取路径依赖它，不能删），`modelOptions`/`effortOptions` 带 `{value,name,description?}`
 * （GUI 显示名的唯一正经来源）。value 与 name 的区别就是契约本身：喂给
 * `session/set_config_option` 的只能是 value。
 *
 * 另给两个**可选**的默认值字段 `defaultModel`/`defaultEffort`：它们是「可选集合」之外的
 * 另一语义——下拉框里那个显示为 default 的项，落盘 value 为空/`default`，ACP 侧就是
 * 沿用会话自身档位。取值只能是 option 的 `currentValue`，且**必须是没被任何 set 覆盖过的
 * 初始快照**（探测链路本来就只 `session/new`、不发 set，天然满足）。拿不到就省略键，
 * 绝不写空串冒充默认值。
 */
export function parseConfigOptions(configOptions) {
  const modelOption = findModelOption(configOptions)
  const effortOption = findEffortOption(configOptions)
  const effortEntries = effortEntriesForModel(effortOption, modelOption && modelOption.currentValue)
  const linked = linkModelEfforts(modelOption, effortOption)
  const out = {
    models: configOptionValues(modelOption),
    modelOptions: configOptionEntries(modelOption),
    efforts: effortEntries.map((entry) => entry.value),
    effortOptions: effortEntries,
  }
  const defaultModel = currentValue(modelOption)
  if (defaultModel) out.defaultModel = defaultModel
  const defaultEffort = currentValue(effortOption)
  if (defaultEffort) out.defaultEffort = defaultEffort
  if (linked) {
    out.modelEfforts = linked.modelEfforts
    if (linked.modelEffortOptions) out.modelEffortOptions = linked.modelEffortOptions
  }
  return out
}

/** 产品自报的当前值；非字符串 / 空串一律视为「没有默认值可报」。 */
function currentValue(option) {
  const value = option && option.currentValue
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 分组键：ACP 的 SessionConfigSelectGroup 用 `group`，部分产品用 `name`。 */
function groupKey(group) {
  if (!group) return ''
  if (typeof group.group === 'string') return group.group
  return typeof group.name === 'string' ? group.name : ''
}

/** 该 effort 选项是否为「全部分组」形态（混合形态一律按并集处理）。 */
function isGrouped(option) {
  const list = option && option.options
  if (!Array.isArray(list) || list.length === 0) return false
  return list.every((g) => g && Array.isArray(g.options))
}

/**
 * 分组形态的取值域必须按「当前 model 所属分组」取——并集会把别的模型的档位
 * 冒充成当前可用档位，而 provider 级快照的语义就是"探测时那个 model 下的档位"。
 * 对不上分组时退回并集：多给一档比少给安全（真不接受会有 config-option-error）。
 */
function effortEntriesForModel(effortOption, currentModel) {
  const union = configOptionEntries(effortOption)
  if (!isGrouped(effortOption) || !currentModel) return union
  const group = effortOption.options.find((g) => groupKey(g) === currentModel)
  const entries = group ? configOptionEntries(group) : []
  return entries.length > 0 ? entries : union
}

/**
 * 只有当 thought_level 选项本身按模型分组、且分组键能对上已知 model id 时
 * 才认为"可明确关联"；否则省略 modelEfforts（不猜）。
 */
function linkModelEfforts(modelOption, effortOption) {
  if (!modelOption || !effortOption || !isGrouped(effortOption)) return null
  const known = new Set(configOptionValues(modelOption))
  const modelEfforts = {}
  const modelEffortOptions = {}
  for (const group of effortOption.options) {
    const key = groupKey(group)
    if (!known.has(key)) return null
    const entries = configOptionEntries(group)
    if (entries.length === 0) continue
    modelEfforts[key] = entries.map((entry) => entry.value)
    modelEffortOptions[key] = entries
  }
  return Object.keys(modelEfforts).length > 0 ? { modelEfforts, modelEffortOptions } : null
}

/**
 * 目录文件读写（可注入目录，测试用临时目录）。照抄 registry.js 的
 * 「缓存 + tmp 文件 rename 原子写」模板：读失败按空目录处理（下次写入自愈）。
 */
export function createProviderCatalog(dir = DEFAULT_DIR) {
  const file = path.join(dir, FILE_NAME)
  let cache

  const load = () => {
    if (cache !== undefined) return cache
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      cache = raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object'
        ? { version: VERSION, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, providers: raw.providers }
        : { version: VERSION, updatedAt: null, providers: {} }
    } catch {
      cache = { version: VERSION, updatedAt: null, providers: {} }
    }
    return cache
  }

  const save = () => {
    const data = load()
    data.version = VERSION
    data.updatedAt = new Date().toISOString()
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = path.join(dir, `.${FILE_NAME}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (err) {
      console.warn(`[product-subagents] provider 目录写入失败（不影响探测结果本身）: ${err.message}`)
      return false
    }
  }

  return {
    file,
    /** 完整快照（含 version / updatedAt / providers）。 */
    read() {
      return { ...load(), providers: { ...load().providers } }
    },
    /** 单个 provider 条目，未探测过 → undefined。 */
    get(name) {
      return load().providers[name]
    },
    /** 条目是否已过期（缺失 / 时间戳不可解析都算过期）。 */
    isStale(name, ttlMs = DEFAULT_TTL_MS) {
      const entry = load().providers[name]
      if (!entry || !entry.probedAt) return true
      const at = Date.parse(entry.probedAt)
      if (!Number.isFinite(at)) return true
      return Date.now() - at > ttlMs
    },
    /** 合并写入若干条目（`{provider: entry}`）并原子落盘；返回实际写入的 provider 名。 */
    merge(entriesByName = {}) {
      const data = load()
      const written = []
      for (const [name, entry] of Object.entries(entriesByName)) {
        data.providers[name] = { ...entry }
        written.push(name)
      }
      if (written.length === 0) return []
      save()
      return written
    },
  }
}

function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} 超时（${ms}ms）`), { code: 'PROBE_TIMEOUT' }))
    }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 探测编排：一条「建完就弃」的会话即可拿到该 provider 的取值域。
 * 关键点：`bridgeFactory` 必须 **不传** permissionHandler/autoGrant ——
 * 传了会走宿主交互审批、产生 permission-pending 噪声，且审批不可用时 fail-closed。
 * 探测失败只写 `error` 字段，不抛异常、不影响其他 provider。
 */
export function createProviderProber({
  catalog = createProviderCatalog(),
  bridgeFactory = (def, hooks) => createBridgeFor(def, hooks || {}),
  providers = {},
  defaultNames = [],
  cwd,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onUpdated,
} = {}) {
  const inFlight = new Map() // provider -> Promise<entry|null>

  const probeOne = async (name, probeCwd) => {
    const def = providers[name]
    const probedAt = new Date().toISOString()
    if (!def) {
      console.warn(`product-subagents: provider "${name}" 未注册，跳过探测`)
      return null
    }
    if (def.type !== 'acp') {
      console.warn(`product-subagents: provider "${name}" type=${def.type}，无 ACP configOptions 可探测，跳过`)
      return null
    }
    let bridge = null
    let remote = null
    let spawned = null        // 探测可能在 create 落定前放弃，句柄要留在手边
    let abandoned = null      // 超时后的原 create promise，落定了就得补一次 dispose
    try {
      bridge = bridgeFactory(def, { onSpawn: (proc) => { spawned = proc } })
      const created = bridge.create(probeCwd)
      try {
        remote = await withTimeout(created, timeoutMs, `${name} 探测会话`)
      } catch (error) {
        abandoned = created
        throw error
      }
      return { ...parseConfigOptions(remote.configOptions), source: SOURCE, probedAt }
    } catch (error) {
      const message = (error && error.message) || String(error)
      console.warn(`product-subagents: [${name}] provider 探测失败（本次记为空 + error，不影响其他 provider）: ${message}`)
      // 空清单只是「本次没探到」，消费方绝不能拿它去纠正用户已存的值。
      return { models: [], modelOptions: [], efforts: [], effortOptions: [], source: SOURCE, probedAt, error: message }
    } finally {
      if (bridge && remote) {
        try { await bridge.dispose(remote) } catch { /* 已随进程退出 */ }
      }
      // 超时/异常时进程还活着（bridge.create 内部已经 spawn）：不 SIGKILL 就是孤儿，
      // 而且它还占着 stdio，下一次探测可能撞上同一个产品的锁。
      if (spawned && !remote) {
        if (spawned.exitCode === null && spawned.signalCode === null) {
          try { spawned.kill('SIGKILL') } catch { /* 已随进程退出 */ }
        }
      }
      if (abandoned && bridge) {
        abandoned.then(
          (late) => { bridge.dispose(late).catch(() => {}) },
          () => {},
        )
      }
    }
  }

  /**
   * 探测一批 provider（串行，避免同时拉起多个产品 CLI）。
   * @param {string[]|null} names 缺省 = 全部已注册 ACP provider
   * @returns {Promise<{providers: string[], entries: object}>} 写入缓存的 provider 名
   */
  const probe = async (names, { cwd: probeCwd, reason } = {}) => {
    const targets = (Array.isArray(names) && names.length > 0 ? names : defaultNames)
      .filter((n) => typeof n === 'string' && n)
    if (targets.length === 0) return { providers: [], entries: {} }
    const settle = (name) => {
      const pending = inFlight.get(name)
      if (pending) return pending // 去重：同一 provider 的并发探测请求复用一次会话
      const run = probeOne(name, probeCwd || cwd || process.cwd()).finally(() => inFlight.delete(name))
      inFlight.set(name, run)
      return run
    }
    const entries = {}
    for (const name of targets) {
      const entry = await settle(name)
      if (entry) entries[name] = entry
    }
    const written = catalog.merge(entries)
    if (typeof onUpdated === 'function') {
      try { onUpdated({ providers: written, reason: reason || null }) } catch { /* 事件消费方故障不影响缓存 */ }
    }
    return { providers: written, entries }
  }

  /** 未探测过 / 已过 TTL 的 provider（用于启动时避免无谓拉起进程）。 */
  const staleNames = (names, overrideTtl) => {
    const ttl = overrideTtl !== undefined ? overrideTtl : ttlMs
    return (Array.isArray(names) && names.length > 0 ? names : defaultNames).filter((n) => catalog.isStale(n, ttl))
  }

  return { probe, staleNames, catalog, ttlMs }
}
