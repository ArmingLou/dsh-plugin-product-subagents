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

- DeepSeek Harness 部署(web profile)。
- 至少一个产品 CLI 在 `PATH` 且已登录:`claude`、`codex`,或某个 ACP CLI(`opencode`、`agent`、`cbc`…)。
- Node ≥ 18。

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
```

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

## 开发

```bash
npm install
npm test        # node:test — 纯逻辑 + fake bridge,不需要 CLI 或密钥
npm run lint    # 语法检查所有模块
```

桥契约、权限模型与新增产品的方式见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。CI 在 macOS / Ubuntu / Windows × Node 18/20/22 上跑测试套件。

## 安全

这是**配置即信任边界**的工具:它会启动你配置的任何 CLI,`full` 会传递产品自己的"绕过所有权限检查"标志。见 [SECURITY.md](SECURITY.md)。

## License

MIT
