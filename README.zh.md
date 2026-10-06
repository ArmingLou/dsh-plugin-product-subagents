# dsh-plugin-product-subagents

[English](README.md) | **简体中文**

面向 DeepSeek Harness 的**基于角色的 Codex / Claude Code / ACP 子代理插件**。把外部 Agent CLI 变成持久、可续聊的子代理:声明式角色库、按角色的产品权限、带权限天花板的委派、跨平台进程启动。

## 功能

- **可续聊子代理** — 同步 one-shot 或异步连续式(用 `send_message` / `list_agents` / `interrupt_agent` 控制;用 `product_wait` 同步 attach)。
- **会话连续性** — 子代理的远程产品会话在空闲释放与进程重启后仍可恢复(持久注册表 + 日志标记;claude/codex 按 id 恢复,ACP 重连)。
- **声明式角色**(`roles/*.json`)— `general`(默认)、`code-review`、`explore`(禁派)、`debug`。委派默认开启,角色可显式禁止;未知角色回退 `general`。
- **两层权限模型** — 中继模型永远是只读传话筒;`permissionMode`(`readonly` / `default` / `full`)作用于远程产品,映射到各产品自己的 CLI 标志。
- **权限天花板** — 子代理不能派生出比自己权限更高的后代。
- **任意 ACP Agent** — 通过 `config.providers` 加 Cursor(`agent acp`)、CodeBuddy(`cbc --acp`)、Gemini(`gemini --acp`)等,零代码。
- **动态模型 / effort 目录** — 采集每个 ACP 会话的 `configOptions`,在 `set_config_option` 与 `config_option_update` 后保持最新,按子代理以事件透出,并按 provider 落盘缓存;产品不提供该取值时回退到其默认档位,而不是让回合失败(见[模型与 effort 动态发现](#模型与-effort-动态发现))。
- **资源管理** — 空闲释放、可配超时、并发上限。
- **跨平台** — Windows `.cmd` 垫片、Windows 安全路径转义;CI 覆盖 macOS / Ubuntu / Windows。

## 环境要求

- DeepSeek Harness 部署(web profile),dsh 版本为 **`0.2.0-rc.1`**(即 0.2 线)。
  本版本适配 0.2 的 subagent / tools 接口;dsh `0.1.x` 请用插件 `0.6.x`。
- 至少一个产品 CLI 在 `PATH` 且已登录:`claude`、`codex`,或某个 ACP CLI(`opencode`、`agent`、`cbc`…)。
- Node ≥ 18。

可用 `npm run check:host` 对着运行中的 harness 复核安装态(见[宿主兼容性](#宿主兼容性))。

## 安装

### 推荐方式 — `dsh plugin add`

```bash
dsh plugin --profile web add dsh-plugin-product-subagents
```

这一条命令**同时**完成装包与接线:插件通过 `package.json` 里的 `dsh.bundle`
声明自带 `cordis.patch.yml`,`dsh plugin add` 会自动将其注册为 profile 层
(无需手动编辑 `cordis.patch.yml`)。装完后重启 harness 即可生效。

如需自定义插件配置(例如加 ACP provider),在 profile 自己的
`cordis.patch.yml`(`~/.dsh/profiles/web/cordis.patch.yml`)里按
`product-subagents` id 覆盖:

```yaml
- id: product-subagents
  config:
    idleTimeoutMs: 600000
    providers:
      cursor:    { type: acp, command: agent, args: [acp] }
      codebuddy: { type: acp, command: cbc, args: [--acp] }
```

> **注意:** config 覆盖会替换整行 `config` 对象,请把要保留的字段一并写上
> (如上面的 `idleTimeoutMs`)。

### 让 Agent 安装(一句话)

把这句粘贴给你的 DeepSeek Harness Agent(或任何有 shell 权限的编码 Agent),
它会自己完成所有步骤:

> 请把 `dsh-plugin-product-subagents` 插件装进我的 DeepSeek Harness
> web profile:执行 `dsh plugin --profile web add dsh-plugin-product-subagents`,
> 然后提醒我重启 harness 让插件生效。

### 手动安装(进阶)

如果你希望自己管理 profile,请在 profile 目录内使用 pnpm(不要用 npm),
以避免 peer 依赖被自动安装:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-plugin-product-subagents
```

然后在 profile 的 `cordis.patch.yml` 加一行宿主层:

```yaml
- insert:
    - id: product-subagents
      name: 'dsh-plugin-product-subagents'
      config:
        idleTimeoutMs: 600000
        providers:
          cursor:    { type: acp, command: agent, args: [acp] }
          codebuddy: { type: acp, command: cbc, args: [--acp] }
```

## 快速开始

会话中的模型有六个工具:

| 工具 | 用途 |
|---|---|
| `product_delegate` | 按角色委派任务(同步或连续式) |
| `product_roles` | 列出角色库 |
| `product_submit` | 子代理内部桥(仅连续式子代理) |
| `subagent_progress` | 单个子代理的状态 + 内部 trace |
| `product_wait` | 阻塞直到子代理结算,返回答案 |
| `product_agents` | Provider 可用性 + 活跃子代理 |

```
product_delegate role=general task="重构 demo-project/calc.js 并运行测试"
product_wait subagent_id=<childId>
```

## 配置

```yaml
config:
  providers: { cursor: { type: acp, command: agent, args: [acp] } }
  idleTimeoutMs: 600000       # 结算后的子代理闲置超过此时长则释放远程会话(0 禁用)
  maxConcurrentChildren: 8    # 同时存在的连续式子代理上限
  rolesDir: <path>            # 声明式角色库目录(默认 roles/)
  registryPath: <path>        # 持久化远程会话注册表
  providerCatalogTtlMs: 86400000   # 条目超过此时长即视为过期并重探(默认 24h,仅作用于启动预探)
  providerProbeOnStart: true  # 启动时只探测已过期的 provider(缓存新鲜时零进程开销)
  providerProbeTimeoutMs: 30000    # 单个 provider 探测硬上限(含 CLI 冷启动);超时则 SIGKILL 该子进程、
                                   # 写 error 条目,且不进行第二次重试
  # v0.7.3 提交失败分级(默认口径见 lib/submit-failure.js):
  #   failover    → 编排层可以静默换下一档 routes
  #   fatal       → 不换档,直接作为最终失败上报
  #   interrupted → 人为中断/取消,既不算产品故障也不重试
  # 未列出的错误码兜底为 failover——只有被明确归入 fatal 的那一类才停止换档。
  submitFailureGrades:
    EMPTY_RESPONSE: failover      # 产品返回了空正文
    RATE_LIMITED: failover        # 429 / rate limit / quota / insufficient_quota / 余额不足
    SUBMIT_TIMEOUT: failover
    INVALID_API_KEY: fatal        # 认证失败:重试不会改善
    INVALID_ARGUMENT: fatal       # 参数非法:重试不会改善
    SYNTAX_ERROR: fatal
    MODEL_NOT_FOUND: fatal
    RECONNECT_BLOCKED: fatal
  # v0.7.4 换档交接模式。三种模式一律使用【同级】替补档(主代理的直接子级),
  # 差别只在「谁来决定、何时决定」:
  #   notify-then-auto(默认) → 发唤醒信号 + 暴露 agent_failover,等 notifyWaitMs;
  #                            超时则由编排层自动派同级替补
  #   notify                 → 纯手动:只等主代理;超时按失败收尾,绝不自动换档
  #   auto                   → 不等待、不发信号,立即换档(保持 0.7.3 的全自动手感)
  failoverMode: notify-then-auto
  notifyWaitMs: 90000            # 等主代理决定的上限
```

## 提交失败分级与换档交接

`product_submit` 在抛错前先给每次提交失败定级,并把等级随
`product-subagents/submit-failed` 事件下发(载荷字段 `grade`)。同一载荷上还有
`onFailover(handler)`:监听方可在 **emit 期间同步登记**一个处理器,`product_submit`
随后 **阻塞等待该处理器** 而不是直接抛错。这正是「换档未走完不向父代理泄漏
中间态失败」的实现支点——失败档的回合仍然开着(宿主 `watchSettlement` 在算
`settlementState()` 之前先 `await whenIdle()`),宿主就不会结算它。

v0.7.4 起,**换档决定权归主代理、替补档是主代理的直接子级**,因此本档只可能被
「交接」或「判失败」,不再拿替补的答案当本次返回值。

| 处理器返回 | `product_submit` 的行为 |
|---|---|
| `{ handedOff: true, nextProvider, newChildId }` | 抛 `FAILOVER_HANDED_OFF`:本档到此为止——编排层已终止它并派出**主代理的直接子级**作为替补。**不**再 emit 第二次 `submit-failed`(该未知码兜底分级是 `failover`,会重复登记 `onFailover` 并再跑一条链 ⇒ 同一任务两个替补),也**不**补发 `submit-ok` |
| `{ timedOut: true, summary, message }` | 抛 `FAILOVER_EXHAUSTED`,`message` 自解释:已尝试哪些档、各自最后错误、**以及为什么没有换档** |
| `{ text }` | **旧编排层**(≤0.7.3):把 `text` 当作本次提交的答案返回,并补发 `submit-ok`(`viaFailover: true`) |
| `{ exhausted: true, message }` | **旧编排层**:抛 `FAILOVER_EXHAUSTED`,`message` 自解释 |
| 抛错 | 记日志后回落到原始提交错误——编排层的故障绝不被报成「路由链耗尽」 |
| 未登记处理器 | 抛原始错误,与 0.3.7 行为逐字一致 |

只有 `failover` 级失败才会询问处理器;`fatal` / `interrupted` 一律直接抛出。

两条需要显式记录的硬约束:

- **等待是有界的,且不 race `exec.signal`。** 权威计时器在编排层(它的 `notifyWaitMs`),
  本插件另加一道 `notifyWaitMs + 2s` 的安全网(`finally` 里 `clearTimeout`,正常路径绝不
  拖住宿主进程),只为保证「编排层存在却不兑现」时本工具调用不会**无限期阻塞**。
  abort 不是有效的释放手段:宿主调度器即使 abort 也等 in-flight 工具 settle,abort 信号
  解不开本工具——只有编排层兑现 rendezvous 才行。
- **`FAILOVER_HANDED_OFF` 定级为 `interrupted`,绝不是 `failover`。** 它的语义是
  「人(主代理)已决定把这一档挪到别处」;当成产品故障就会再跑一条链,让同一任务出现两个子代理。

事件载荷现在还带 `failoverMode` 与 `notifyWaitMs`,编排层据此采用本插件的设置。

目录路径本身**不可配置**:`provider-catalog.json` 是跨插件契约,消费方按固定路径
`$DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json` 读取。

## 模型与 effort 动态发现

ACP v1 没有 `availableModels` / `session/set_model`:会话可用的模型与推理档位,唯一可移植来源是
`configOptions`(由 `session/new|load|resume` 响应、每次 `session/set_config_option` 响应、
每次 `config_option_update` 通知各带一份完整快照)。配置项的 **id 由产品自定**,本仓库解析规则是
「id 精确匹配优先 → `category` 兜底」,绝不硬编码。取值通过 `session/set_config_option` 应用,
并把响应里的完整快照回写(effort 取值域依赖所选 model,丢弃响应就是联动陈旧的根因)。

**配错值不会弄坏回合。** 手写 `agents.json` 里的 model/effort 若产品不认,一律**回退到产品自己的默认档位**:
空串或 `default` 视为「不指定」(不发调用)、值不在产品自报的 `options[].value` 取值域内(不发调用)、
产品没有该 option(不发调用)、发出去被产品拒绝(捕获不抛)。四种情形会话都保持当前值,
`product_submit` 照常完成。每次回退都发
`product-subagents/config-option-error` `{…, kind, requested, optionId, effective, available[],
reason, error, configOptions, at}`,`reason ∈ no-option | not-in-values | rejected`,
`effective` 即本次真正生效的值。`console.warn` 按 `(kind,value)` 去重,事件则每回合都发,
方便 dispatch 日志回答「填了 X 为什么没生效」。

外部消费方有两个数据面:

- **事件** — `product-subagents/config-options`
  `{childId, product, remoteSessionId, configOptions, at}`(子代理绑定、每次
  `config_option_update`、以及冷恢复后各透出一次);回退(缺项/域外/被拒)时发
  `product-subagents/config-option-error`(字段见上);每次缓存写完后发
  `product-subagents/provider-catalog-updated` `{providers: [name], at}`;
  请求事件 `product-subagents/probe-provider` payload `{provider?, cwd?, reason}`
  (缺省 `provider` = 探测全部已注册 ACP provider;失败同样发 updated)。
- **`provider-catalog.json`** — provider 级缓存,也是跨插件的数据面(事件不会自动转发到 GUI)。形状冻结:

```json
{ "version": 1, "updatedAt": "<ISO>",
  "providers": { "deveco": {
    "models": ["deveco/GLM-5.1", "deveco/GLM-5.3"],
    "modelOptions": [
      { "value": "deveco/GLM-5.1", "name": "DevEco Code/GLM-5.1" } ],
    "efforts": ["low", "high", "max", "default"],
    "effortOptions": [ { "value": "low", "name": "Low" } ],
    "modelEfforts": { "…": ["…"] },
    "modelEffortOptions": { "…": [{ "value": "…", "name": "…" }] },
    "source": "probe", "probedAt": "<ISO>", "error": "<仅探测失败时>" } } }
```

**`value` 与 `name` 的分工就是契约**:`value` 是落盘并喂给 `session/set_config_option` 的那个 id
(如 `deveco/GLM-5.1`,**原样保留、不改写不丢弃**),`name` 是产品自报的显示名(GUI 下拉用,
如 `DevEco Code/GLM-5.1`),`description` 可选、缺失即省略键。分组形态
(`SessionConfigSelectGroup[]`)展开收集;`models` / `efforts` 仍是纯 value 字符串数组,
`*Options` 是**增量字段**,不替换旧字段。

缓存对用户配置**只读**:探测绝不写 `agents.json`、不"纠正"已存的 model;空清单的含义是
"这次没探到"(配 `error`),不是"该产品没有这些值"。

`modelEfforts` 只在产品自身按模型 id 分组 effort 时才填,拿不到关联就省略该键而不是猜。
探测失败写入 `models: []` + `error`,不抛异常、不影响其他 provider。

两条语义:

- `efforts` 是**探测时那个 model 下的**取值域(产品若按模型分组,取 `models[current]` 那一组,
  而不是跨模型并集);联动后的权威快照走 child 级 `config-options` 事件。
- TTL 只约束**启动预探**。`probe-provider` 事件一律真探覆盖 —— GUI 的「刷新」按钮不能被
  一条新鲜的缓存条目挡掉,新鲜但**失败**的条目同样重探。

## 角色与权限

每个角色文件:

```json
{
  "id": "code-review",
  "description": "审查代码的缺陷、安全与可维护性(只读)。",
  "provider": "claude-code",
  "permissionMode": "readonly",
  "allowDelegation": true,
  "instructions": "你是代码审查员。只读:绝不修改文件。…"
}
```

- `permissionMode` 映射到产品标志:`readonly`(claude `--permission-mode plan` / codex `--sandbox read-only`)、`full`(claude `--dangerously-skip-permissions` / codex `--dangerously-bypass-approvals-and-sandbox`)。
- **中继模型任何角色都拿不到可写工具**。
- **委派有天花板**:`readonly < default < full`;子代理不能派生出权限更高的后代。

## 自定义 ACP Provider

`config.providers` 接受任意讲 ACP 的 CLI —— 通用桥负责持久进程、`session/load` 恢复与死进程重连:

```yaml
providers:
  cursor:    { type: acp, command: agent, args: [acp] }    # Cursor CLI
  codebuddy: { type: acp, command: cbc, args: [--acp] }    # CodeBuddy
  gemini:    { type: acp, command: gemini, args: [--acp] } # Gemini CLI
  opencode:  { type: acp, command: opencode, args: [acp] } # opencode
```

只有命令在 `PATH` 上被检测到,Provider 才会出现在委派枚举里。内置三件套(`claude-code` / `codex` / `acp`)可用同名键覆盖。

## 宿主兼容性

本插件跟随 DSH 的某个世代:**dsh `0.2.x`**(peer 依赖
`@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-tools` 为 `~0.2.0-rc.1`)。
宿主会用**运行中的版本**校验插件的 `@deepseek-ai/dsh*` peer 范围,不满足就直接拒绝加载,
所以 harness 升级会停用未跟进的插件——对应关系如下:

| dsh 运行版本 | 插件版本 |
| --- | --- |
| `0.2.x` | `0.7.x`(本版本) |
| `0.1.x` | `0.6.x` |

DSH 升级后,对着运行中的 harness 复核安装态:

```bash
npm run check:host
# 或指定某个安装位置:
DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run check:host
```

它会用宿主**自己的**兼容性判定函数校验本 `package.json`,核对插件用到的
`ctx.subagents` 与会话接口面,并把 6 个插件工具经**运行时那份** `defineTool` 注册一遍。
其中两个接口面被重点守护:`Session.snapshotEvents()`(冷恢复链路背后的日志读取口)
与 `ctx.subagents.listChildren()` 条目(dsh 0.2 裁掉了条目的 `activity` /
`hasChildren`,现由 `lib/host-compat.js` 按宿主自身的驻留规则在本地推导)。

## 开发

```bash
npm install
npm test        # node:test — 纯逻辑 + fake bridge,不需要 CLI 或密钥
npm run lint    # 语法检查所有模块
```

桥契约、权限模型与新增产品的方式见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。CI 在 macOS / Ubuntu / Windows × Node 18/20/22 上跑测试套件。

> **拿冻结包冒烟时注意：** 交付用的冻结包**不含 `node_modules`**。直接解包跑
> `node --test` 会因缺依赖得到 `195/16`（缺 `@agentclientprotocol/sdk` / `zod`）；
> 要么把解包目录指到本仓 `node_modules`
> （`ln -s <repo>/node_modules <解包目录>/node_modules`），要么直接在仓库里跑套件。

## 安全

这是**配置即信任边界**的工具:它会启动你配置的任何 CLI,`full` 会传递产品自己的"绕过所有权限检查"标志。见 [SECURITY.md](SECURITY.md)。

## License

MIT
