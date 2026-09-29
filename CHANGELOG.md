## [0.7.2] — 2026-09-29

### Changed
- **`subagent_progress` 不再为 `hasChildren` 多读一次目录**：0.7.1 曾按宿主
  `listDescendants` 的规则补回该字段，但复核旧实现发现——它只是被拷进
  `listStatus` 后**从未输出**（`product_agents` 同样从不输出），是彻头彻尾的死数据。
  改为与旧行为一致（输出 `activity` / `mode` / `label`），省掉每次查询的一次
  `listChildren` 调用。
- 新增 `test/tool-output.test.js`：用桩上下文驱动 4 个工具的**真实 execute**，
  断言返回值「能原样 JSON 往返」（宿主无损 JSON 规则的本地等价），并顺带钉住
  `activity` 推导与「只读一次父目录」的行为。这是 0.7.1 那类缺陷的回归闸门——
  `npm test` 即可拦住，不依赖宿主重启。

## [0.7.1] — 2026-09-29

### Fixed
- **工具返回值含 `undefined` 属性 → 整个工具报错（旧缺陷，升级后实测暴露）**：宿主用
  `isJsonValue` / `snapshotJsonValue` 校验工具返回值必须「无损 JSON」——`undefined`
  值的自有属性会在 JSON 往返中被丢弃，因此被判非法，整次调用失败：
  `tool "<name>" returned invalid output: value is not lossless JSON`（`ToolOutputError`）。
  实测 `0.1.0-rc.6` 与 `0.2.0-rc.1` **两版同样严格**（不是升级回归），只要有一个可选字段为空就中招：
  `product_agents` 的子代理没有 binding 时 `product: undefined`、`product_wait` 在
  ready/timeout 时 `stopReason: undefined`、`subagent_progress` 的 `mode/label/lastTask/…` 等。
  新增 `lib/json-safe.js` 的 `jsonSafe()`：递归丢弃 `undefined` 属性值（数组项里的 `undefined`
  转 `null`，避免下标位移），6 个工具的出参全部经它收口，后续再加可选字段不会再弄坏调用。
  新增 `test/json-safe.test.js`（含「输出必须能原样 JSON 往返」这条宿主规则的本地编码），
  并把该规则的**两半**（宿主拒绝 undefined / 接受 `jsonSafe` 输出）加进 `npm run check:host`。

## [0.7.0] — 2026-09-29

### Breaking
- **适配 dsh 0.2.0-rc.1(宿主接口换代)**。旧声明 `@deepseek-ai/dsh-subagent` /
  `@deepseek-ai/dsh-tools` `^0.1.0-rc.6` 会让宿主在加载期直接拒绝本插件
  (peerDependencies 与**运行时版本**做 semver 判定,`dsh-app-boot`),现改为
  `~0.2.0-rc.1`、`@deepseek-ai/cordis` 对齐到 `^4.0.4`。**本版本不再支持 dsh 0.1.x**
  (需要旧宿主请留在 0.6.x)。

### Fixed
- **会话连续性恢复链路(冷恢复)在 0.2 上静默失效**：0.2 移除了 `Session.events`
  取值器(改为 `Session.snapshotEvents(fromSeq, toSeqExclusive)`)。`recoverRemoteSessionId`
  与 `foldProgress` / `foldTrace` / `foldTokenUsage` 原先直接读 `session.events`，
  在新宿主上会读到 `undefined` → 目标子会话「找不到 PRODUCT_SESSION 标记」→
  空闲回收/重启后无法重连远程产品会话(且进度、轨迹、token 统计全部为空，无异常)。
  新增 `lib/host-compat.js` 的 `sessionEvents()`：优先 `snapshotEvents()`，
  回退旧的 `events` 取值器——0.1.x 与 0.2.x 共用一条代码路径。
- **`product_wait` 在 0.2 上恒超时**：0.2 的 `ctx.subagents.listChildren()` 返回
  `SubagentCatalogEntry`(`{ id, createdAt, mode, label }`)，**不再带 `activity`**。
  旧代码 `me ? me.activity : 'unknown'` 取到 `undefined` → 既不是 `'unknown'` 也不是
  `'inactive'` → 已结算的子代理也被当作 live 分支一直阻塞到 timeout。
  现按宿主 `listDescendants` 的同款规则从会话存储推导驻留性
  (`sessions.get(id) === undefined ? 'inactive' : 'running'`，见 `childActivity()`)。
- **`product_agents` / `subagent_progress` 的 `activity` 静默变空**：
  同样源于 `listChildren` 条目字段裁撤，现按会话驻留性推导。
  （`subagent_progress` 里的 `hasChildren` 是旧实现拷进 `listStatus` 后从未输出的**死数据**，
  一并去掉——顺带省掉每次查询多读一次该 child 目录的开销；`product_agents` 从不输出该字段。）

### Added
- **`SubagentCapabilities.agentOptions: false`**：0.2 的能力位新增成员且为必填。填 `false`
  是诚实声明——外部产品 CLI 无法兑现宿主的 provider/model/reasoningEffort 覆盖(产品模型与
  档位由 role 与产品自身的 configOptions 决定)。这样一次性(one-shot)带 `agentOptions` 的
  委派会**显式失败**(`UNSUPPORTED_CAPABILITY`)而不是被静默忽略;continuable 路径由
  continuation manager 自行组装，不看该标志位。
- **`npm run check:host`(`scripts/check-host-compat.mjs`)**：对**真实安装的** dsh 运行时
  校验宿主契约——直接调用宿主自己的兼容性判定函数(`dsh-app-boot` 的
  `evaluatePluginCompatibility`，也就是当初拒绝加载的那一个)、核对 subagent / session
  接口面，并把插件的 6 个工具定义拿**运行时那份 `defineTool`** 跑一遍(源码复制到临时树、
  `@deepseek-ai/dsh-tools` 指向运行时副本)。以后每次 DSH 升级先跑它，能提前发现同类断裂。
- `test/host-compat.test.js`：覆盖 `snapshotEvents()` 新路径、旧 `events` 回退、异常/非数组
  读取器，以及「0.2 会话依然能恢复 PRODUCT_SESSION 标记」的回归用例。

## [0.6.1] — 2026-09-19

### Fixed
- **安装态与源码不一致（本地打包链路的 pnpm 缓存陷阱）**：`pnpm add file:.../dsh-plugin-product-subagents-0.6.0.tgz`
  在**同名同版本**下会按 `pnpm-lock.yaml` 里记录的 `integrity` 命中 store 缓存，于是"重新打包 + 重装"
  看起来成功、`node_modules` 里却仍是旧内容（实测：安装态 `lib/bridges/acp.js` sha256 与源码不一致，
  而 tgz 内容本身是正确的）。
  本版本**代码与 0.6.0 完全相同**，仅提升版本号以改变 specifier（新文件名 → 必然重新解析），
  使安装态与源码逐字节一致。发版建议：本地 `file:` 依赖重装后，务必用逐文件 sha256 复核，不要只看
  pnpm 的输出。（未采用 `--force`：它依赖具体 pnpm 版本的缓存行为，不如换 specifier 确定。）

## [0.6.0] — 2026-09-18

### Added
- **ACP 可用模型 / effort 动态取得并透出**：ACP v1 没有 `availableModels`/`session/set_model`，
  唯一的可移植来源是会话的 `configOptions`。现在 bridge 会采集、回写并向外透出这份快照。
  - `config_option_update` 通知被采集（原先只处理 `agent_message_chunk`，快照会在会话生命周期内失真）。
  - 新增事件 `product-subagents/config-options`
    （payload `{childId, product, remoteSessionId, configOptions, at}`），在子代理首次绑定、
    每次 `config_option_update`、以及 `product_submit` 冷恢复后透出。
  - **选项元数据透出（显示名 / 落盘值分离）**：`provider-catalog.json` 的每个 provider 条目增量
  补 `modelOptions` / `effortOptions`（`[{value, name?, description?}]`）与可选的
  `modelEffortOptions`。`value` 是能喂给 `session/set_config_option` 的落盘 id（原样保留，
  不改写不丢弃），`name` 是产品自报的显示名（GUI 下拉不再有理由亮裸 id）；
  `description` 缺失即省略键。分组形态 `SessionConfigSelectGroup[]` 展开收集。
  `models` / `efforts` 纯 value 数组**保留不删**（消费方既有读取路径），新字段是增量。
  新导出 `configOptionEntries()`（`configOptionValues` 现在由它派生）。
  缓存对用户配置只读：探测不写 `agents.json`、不"纠正"已存值，空清单只代表"这次没探到"。
  实测回报（真机、逐条对得上 `set_config_option` 生效）：
  `deveco/GLM-5.1` = value、`DevEco Code/GLM-5.1` = name（回灌 `set model=deveco/GLM-5.1` →
  `currentValue=deveco/GLM-5.1`）；qoder `qmodel_38max`/`Qwen3.8-Max (default)`、
  `reasoning_effort` `xhigh`/`Extra High`…；opencode `effort` `low|high|max|default`
  → `Low|High|Max|Default`（152 个 model 全部带 name）。
- 新增事件 `product-subagents/config-option-error`：配置项应用失败时可被上层观测（不再只有 console.warn）。
- **provider 目录探测与缓存**：新增 `lib/provider-catalog.js`，用一条「建完就弃」的 ACP 会话
  拿到某 provider 的取值域，落盘 `~/.dsh/data/dsh-plugin-product-subagents/provider-catalog.json`
  （`{version:1, updatedAt, providers:{<name>:{models,modelOptions,efforts,effortOptions,modelEfforts?,modelEffortOptions?,source,probedAt,error}}}`），
  原子写 tmp+rename、损坏自愈、TTL 默认 24h。该文件是跨插件的数据面（事件不会自动转发到 GUI）。
  - 新增通知事件 `product-subagents/provider-catalog-updated`（`{providers:[name], at}`，每次缓存写完后发）。
  - 新增请求事件 `product-subagents/probe-provider`（payload `{provider?, cwd?, reason}`；
    `provider` 缺省 = 探测全部已注册 ACP provider；失败同样发 updated）。
  - 新增配置：`providerCatalogTtlMs`、`providerProbeOnStart`（默认 true，仅在缓存过期时拉起进程，
    **只约束启动预探**——`probe-provider` 事件一律真探覆盖，否则 GUI「刷新」按钮会被新鲜条目挡掉）、
    `providerProbeTimeoutMs`（默认 30000，单次探测硬上限，超时写 `error` 且不二次重试）。
  - 目录路径**不开放配置**（故意不提供 `providerCatalogDir`）：`provider-catalog.json` 是跨插件契约，
    消费方按固定路径 `$DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json` 读取，
    可配置只会让两仓路径分叉；配了该键会显式 warn 一次而不是静默失效。
  - `efforts` 语义收紧：产品按模型分组时取「当前 model 那一组」，不再给跨模型并集。

### Fixed
- **探测超时/失败会泄漏子进程**：`withTimeout(bridge.create())` 只 reject，`finally` 仅在
  `remote` 非空时 dispose，而 `bridge.create` 内部早已 spawn → 僵死 CLI 留在系统里还占着 stdio。
  现在 a) ACP 桥新增 `options.onSpawn(proc)` 观察者（`providers.js` 转发），prober 拿到句柄，
  超时即 SIGKILL；b) `create()` 落定得比放弃晚时补一次 `dispose`；c) acp.js 自身每个
  「已 spawn 但拿不到 remote」的出口（握手失败、`session/new` 被拒、reconnect 双失败）
  统一走 `killOrphan`。三条路径各有断言用例。
- **effort 硬编码 `configId:'effort'`**：改为「id 精确匹配优先（`effort`/`reasoning_effort`/`thought_level`）
  → `category:'thought_level'` 兜底」。实测 qoder 的 effort 是 `id=reasoning_effort` 且 `category=model`，
  仅靠 category 兜底会把模型档位当成 effort 写回去；model 同理（`id=model` → `category=model`，并排除对方 id）。
- **`setSessionConfigOption` 返回值被丢弃 → model→effort 联动陈旧**（唯一根因）。现在响应里的完整
  `configOptions` 一律回写共享快照后再应用 effort；实测 opencode 切 model 后 thought_level 值域
  由 `low|high|max|default` 变为 `low|medium|high|xhigh|max|default`。
- **配置项应用失败不再静默**：每个 `(kind,value)` 只告警一次，消息带上 agent 真实上报的
  `id(category=…, current=…, values=…)` 取值域，并附 `onConfigError` 回调。
- **手填错 model / effort 不再影响使用（回退到产品默认）**：`applySettings` 从「尽力而为、失败只 warn」
  升级为显式回退链——①空串或 `default` 视为「不指定」，不发调用；②值不在该 option 的 `options[].value`
  取值域内 → **不发** `session/set_config_option`（省一次必然失败的往返）；③产品没有该 option（如
  deveco 无 reasoning 档位）→ 不发；④发出去被产品拒绝 → 捕获，**不抛、不中断 `product_submit` 回合**。
  四种情形会话都沿用当前值（= 产品自己的默认档位），任务照常完成。新导出 `domainAccepts()`
  （空域一律放行：没有依据就判非法会把本来能用的配置挡死；分组形态按全组并集判定，避免误挡
  「换 model 后才合法」的档位）。
  `product-subagents/config-option-error` payload 增补 `{optionId, effective, available[], reason}`，
  `reason ∈ 'no-option' | 'not-in-values' | 'rejected'`；`effective` 优先取 set 响应回写后的
  `currentValue`，否则取会话现值。console.warn 仍按 `(kind,value)` 去重，但事件**每回合都发**，
  便于 dispatch 日志逐回合回答「填了 X 为什么没生效」。

### Tests
- `test/watchdog.test.js` 扩展：configOption 动态解析（纯函数，含 `domainAccepts` 预校验）+ 手搓
  ndjson JSON-RPC 假 agent 走线
  （create 捕获快照、真实 configId 回写、联动刷新、通知采集、告警去重），以及回退链三情形
  ——域外值（不发调用、`effective`=会话现值）、域内值被产品拒绝（捕获不抛、回合照常完成）、
  产品无对应 option（降级、不瞎猜 configId），另加「空串/`default` 不发调用也不报错」。共 26 项。
- `test/provider-catalog.test.js`（21 项）：载荷解析（扁平/分组/畸形）、显示名与 description 取舍
  （`value`↔`name` 分离、无名省略键、`models` 与 `modelOptions` 1:1 对齐）、冻结文件形状、
  TTL/失败语义、探测编排（串行、dispose、失败不影响他者、并发去重、`staleNames`、刷新绕过 TTL）、
  进程清理（超时 SIGKILL、迟到会话补 dispose、`session/new` 被拒收孤儿）。全部注入临时目录与假
  bridge/假 spawn，不依赖真实 CLI 或 API key。

## 0.5.6（2026-09-07）
- 重构：isPermissionPending 泛化为 isHumanWaitPending——豁免判定覆盖任何人类决策等待（授权 pendingDecisions + 预留问答 pendingQuestions 注册表，后者当前无写入方、结构就位）；acp.js 兼容旧键名。设计约束（记档）：ACP 会话任何等待人类决策的期间，看门狗不触发 kill/超时、10 分钟空闲回收自动推迟——问答功能落地时只需把问答挂起注册进 pendingQuestions 即自动获得豁免。

## 0.5.5（2026-09-07）
- 权限等待豁免：ACP 权限请求正等待人类决策期间（pendingDecisions 命中），看门狗不触发无输出冻结/空闲超时（虚拟心跳），10 分钟空闲回收自动推迟——静默等待决策是正常状态而非冻结；决策落定后冻结窗口从该刻重算。新增 isPermissionPending 回调（index.js→providers→acp.js）与 scheduleDispose 推迟逻辑，附单测。

## 0.5.4（2026-09-07）
- submit-ok / submit-failed / permission-pending 事件载荷补 remoteSessionId（binding 的远程会话 id），供编排层透出尾号排查 binding 失配归属。

- 修复（独立复跑发现）：① prompt 传输中断（ACP connection closed/ECONNRESET 等）不再逃逸看门狗循环——按 kill→reconnect→无限重试处理（仅 isClosed/abort/SUBMIT_TIMEOUT 终止）；② reconnect 失败路径加 250ms 防空转延迟；③ connect() 增加 options.spawn 测试缝，watchdog 单测纯 mock 不依赖真实 CLI。watchdog 测试 8/8，全量 95/95。
# Changelog

All notable changes to this project are documented in this file.

## [0.5.3] — 2026-09-07

### Added
- **child-closed 事件订阅**（A）：订阅 `product-subagents/child-closed` 事件 → 取消空闲定时器 + 立即 dispose 远程会话（bridge.dispose → closeSession + SIGTERM），agent-dispatch closeChild 不再依赖 idleTimeoutMs 被动回收。
- **中断语义**（B）：ACP bridge submit 监听 `exec.signal` abort → closeSession + SIGKILL 终止 in-flight prompt，保留 binding 允许后续 reconnect 冷恢复；抛出 `SUBMIT_ABORTED` 错误，submit-failed 事件附带 `interrupted: true` 标记。
- **reconnect 守卫**（C）：新增 `closedChildren` Set——已被 child-closed 标记的 childId 不允许恢复重连，抛出 `RECONNECT_BLOCKED` 错误，不再拉起进程。
- **自动冻结恢复看门狗**（F）：
  - in-flight prompt 连续无输出 ≥ `watchdogNoOutputMs`（默认 180000ms=3 分钟，可通过 provider config 配置）→ kill ACP 进程 → reconnect → 继续等待 prompt。
  - **无限重试**：冻结条件持续则 kill→reconnect 无限循环，唯一终止条件为 child 被 agent_close（`WATCHDOG_CLOSED`）或 interrupt（`SUBMIT_ABORTED`）或 prompt 自然返回。
  - **per-round 状态机**：每轮 submit 重新武装看门狗，prompt 返回/close/interrupt 解除；后续 submit 不受此前 interrupt 影响。
  - **与 C 守卫共用状态源**：`isClosed` 回调检查 `closedChildren` + `signal.aborted`，看门狗 kill→reconnect 循环复用同一判定。
  - 合法长生成区分：`lastActivityAt`（onActivity 实际输出）重置冻结窗口，慢网络/慢模型只要有输出继续等待。
  - `idleTimeoutMs`（默认 10 分钟）作为看门狗之上的兜底上限——超过此时间仍无输出则 `SUBMIT_TIMEOUT`。
  - kill 计数仅日志用途（"累计 N 次 kill 恢复"），不限制重试。
- **watchdogNoOutputMs 配置**：provider 定义新增 `watchdogNoOutputMs` 字段（如 `deveco: { type: acp, command: opencode, args: [acp], watchdogNoOutputMs: 120000 }`），透传至 acp bridge。

### Changed
- `deps` 传递 `closedChildren` 至 product-submit 工具。
- scheduleDispose 路径保留为兜底（事件不可达时仍按 idleTimeoutMs 回收）。
- acp bridge `submit` 签名新增 `isClosed` 回调参数（第六参数，默认 `() => false`）。
- 旧 `promptOnce` 替换为 `promptWithWatchdog`（含看门狗 kill→reconnect 循环）；旧 `reconnect-once` + `SUBMIT_TIMEOUT` 抛错路径整合进看门狗状态机。
- `product-submit.js` 传递 `isClosed` 回调至 bridge.submit。

### Tests
- `test/watchdog.test.js`（7 项）：看门狗配置、isClosed 守卫集成、冻结检测与 kill、守卫耗尽不再重连、活跃输出无误触发、配置覆盖默认值。

## [0.5.2] — 2026-09-06

### Fixed
- **P1: ACP 权限请求「无 binding → 静默 deny → 挂死循环」修复**：deveco 守护进程重启窗口期派发的子代理，ACP binding 的 remote.sessionId 与后续权限请求的 sessionId 失配时，旧代码仅 `console.warn + return 'deny'`，导致秒级重试全部被静默拒绝、挂死 15 分钟直到 idle 看门狗杀会话。
  - 无可见静默路径：未知 ACP 会话的权限请求改为 `console.error` 级富诊断（含 sessionId、product、description、paths、bindings 总数与各 binding 的 sessionId 快照），并 emit `product-subagents/permission-unknown-session` 事件供上层/未来 UI 挂钩。
  - deny 风暴熔断：按 `(product, sessionId)` 维护 30 秒窗口计数，≥3 次未知会话 deny 触发升级动作——console.error 告警 + emit 同一事件（`escalated: true`）。当前无 sessionId → connection handle 注册表，无法自动 abort/close 失配会话；上层编排应订阅此事件触发 failover。
  - 保持 fail-closed：未授权仍返回 `'deny'`，本修复只改可见性/时效，不改授权语义。

### Added
- `lib/unknown-session-tracker.js`：纯函数式窗口计数熔断器（`createUnknownSessionTracker`），可独立单测。
- `test/unknown-session-tracker.test.js`（9 项）+ `test/unknown-session-permission.test.js`（5 项）：覆盖窗口计数、阈值触发、独立键、窗口过期重置、deleteEntry、maxEntries 淘汰、与 decidePermission 集成。

## [0.3.8] — 2026-09-06

### Added
- **ACP 权限交互授权（requestPermission 三层策略）**：不再一律拒绝（旧版 unattended 行为是 deveco/opencode 越权读文件→空正文失败的根因之一）。
  - `permission: 'interactive'`（默认）：ACP 产品请求权限（读文件/执行命令等）时经宿主 `ctx.approval` 向用户弹窗——允许一次 / 总是允许 / 拒绝一次 / 总是拒绝；`allowed-once` 映射 ACP 协议 `selected + allow_once optionId`。
  - `permission: 'read'`：只读类请求自动放行（`allow_once`），其余交互。
  - `permission: 'all'`：全部自动放行（危险，仅信任产品时使用）。
  - `permission: 'deny'`：一律拒绝（旧 fail-closed 行为）。
  - 无审批通道 / 无 open turn / 审批异常 → fail-closed 拒绝（绝不放行）。
- **ACP 协议合规修复**：权限响应此前返回 `{outcome:'rejected'}`——ACP 协议只认 `cancelled` 或 `selected + optionId`，非法值会令严格实现的产品（deveco 等）行为异常；现按协议返回 `selected(reject_once/reject_always)` 或 `cancelled`。
- 权限请求处理器（`decidePermission`）导出为纯函数，新增 `test/permission.test.js` 14 项单测（autoGrant 全放行/只读/写拒绝、handler 同步/异步/optionId 直返/垃圾值 fail-closed/异常 fail-closed、sessionId 透传等）。

### Config
- provider 配置新增 `permission` 字段（interactive/read/all/deny），cordis.patch.yml 中按产品设置。

All notable changes to this project are documented in this file.

## [0.3.7] — 2026-09-06

### Added
- `product_submit` 抛错/成功时向事件总线 emit `product-subagents/submit-failed` / `submit-ok`（payload: childId/product/code/message）。这是与 dsh-agent-dispatch 1.7.1 自动换档机制的跨插件信号通道：relay child 是 LLM agent，工具报错后以 `completed` 正常结束回合，编排层无法从宿主 stopReason 感知产品侧故障（空正文/超时/限流耗尽），必须由工具层发出结构性失败信号，编排层才能按 fallback 链自动换档重试同一任务；`submit-ok` 供编排层清除同一回合二次提交成功后的残留失败标记。

All notable changes to this project are documented in this file.

## [0.3.1] — 2026-08-17

### Added
- Declare `dsh.bundle` in `package.json` and ship a `cordis.patch.yml` bundle
  patch. `dsh plugin --profile <name> add dsh-plugin-product-subagents` now
  automatically wires the plugin as a profile layer — no manual
  `cordis.patch.yml` editing required, and the "declares no dsh.bundle"
  warning is gone.

### Changed
- README (EN + zh): the recommended install method is now
  `dsh plugin --profile web add dsh-plugin-product-subagents`. The manual
  fallback switched from `npm i` to `pnpm add` with an explanation of why npm
  breaks the harness singleton (it auto-installs peer dependencies, shadowing
  the host's `@deepseek-ai/dsh-tools` symlink — the same root cause as #3).

### Notes
- Issue #3's code fix shipped in 0.3.0 (dsh-tools moved to `peerDependencies`),
  but `dsh plugin add` still resolved to 0.2.0 on machines running pnpm 11:
  pnpm 11 enables `minimumReleaseAge` by default, and 0.3.0 was too new to
  pass the age gate, so pnpm fell back to 0.2.0 (which has dsh-tools in
  `dependencies` and reproduces the crash). Once 0.3.0+ ages past the
  threshold the problem disappears; until then, pin explicitly with
  `dsh plugin --profile web add dsh-plugin-product-subagents@0.3.0`.

## [0.3.0] — 2026-08-17

### Fixed
- Windows: `winArgs()` wraps the whole `cmd /S /C` invocation in one outer
  pair of quotes, so `/S` strips exactly that pair instead of the command's
  own quotes. `product_delegate` (claude-code / codex) no longer fails with
  `'claude" -p ...' is not recognized` (fixes #1).
- Move `@deepseek-ai/dsh-tools` from `dependencies` to `peerDependencies`: the
  harness core package must share a singleton with the host, and a second
  pnpm-installed copy in the profile shadowed the symlink and crashed every
  tool call with `Cannot read properties of undefined (reading 'prepare')`
  (fixes #3).

## [0.2.0] — 2026-08-13

Open-source release restructuring.

### Added
- Standalone npm package (`dsh-plugin-product-subagents`), MIT licensed.
- Unit test suite (`node --test`) with a fake bridge; no product CLIs needed.
- GitHub Actions CI matrix (macOS / Ubuntu / Windows).
- Config validation (`zod`) for `providers`, roles, and plugin config.
- Bilingual README (EN + zh), CONTRIBUTING, SECURITY, ARCHITECTURE docs.
- Split `lib/index.js` into `lib/tools/*` (one module per tool).

## [0.1.0]

### Added
- Config-driven provider registry: built-in `claude-code`, `codex`, `acp` plus
  custom ACP agents via `config.providers` (e.g. `agent acp`, `cbc --acp`,
  `gemini --acp`).
- Declarative role library (`roles/*.json`): `general` (default, full
  permissions, may delegate), `code-review` (readonly), `explore` (readonly,
  never delegates), `debug` (default). Delegation defaults ON; `false` bans it.
- Role-based product permissions (`readonly` / `default` / `full`) mapped to
  each product's own CLI flags; the relay model is always a read-only pipe.
- Delegation permission ceiling: a child cannot spawn a descendant with more
  permission than it has.
- Continuable children with durable session recovery (registry file +
  session-log markers), idle disposal of remote sessions, configurable
  per-product timeouts, and a concurrency cap.
- Tools: `product_delegate`, `product_roles`, `product_submit`,
  `subagent_progress`, `product_wait`, `product_agents`.
- Cross-platform process launching (Windows `.cmd` shims via `cmd.exe`),
  Windows-safe path escaping, `fileURLToPath` for module paths.
