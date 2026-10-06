## [0.7.9] — 2026-10-06

真根因修复：qoder 的**真实工具名不在 `name`/`toolName`/`title` 任何一个里，而在
`toolCall._meta.qoder.toolName`**。0.7.8 的 L1 解析读不到它，于是 qoder 全部请求都
退化成 L2 逐路径记忆——这就是用户最初报告的「同会话内换个路径就重复弹」。

### 现场证据（宿主终端 stdout 原文，即 `lib/bridges/acp.js` 打印的 toolCall）

（该打印点自本版缺口C 起为 `lib/bridges/acp.js:789` 的
`logRequestPermissionToolCall`；`:480` 是 0.7.8 时的行号，下面这份原文即由它打出。）

```json
{
  "_meta": { "qoder": { "toolName": "Bash" } },
  "content": [ { "content": { "text": "ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin" }, "type": "content" } ],
  "kind": "execute",
  "rawInput": { "command": "ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin", "description": "List files in the nvm node bin directory" },
  "status": "pending",
  "title": "ls -la /Users/arming/.nvm/versions/node/v22.22.2/bin",
  "toolCallId": "call_19e6d181e8be4bfb942073ce"
}
```

同一进程内另两条同形态载荷（`echo`/`grep` 混合命令、`python3` heredoc）也是
`_meta.qoder.toolName="Bash"` + `title=整条命令正文`。**`title` 里是命令正文而非
工具名**，正是 0.7.8 那套「title 当权限类别 slug 用」的假设在 qoder 链路失效的地方。

### Fixed

- **`resolveToolName` 新增 `_meta` 来源**（`lib/permission-state.js`）：解析顺序
  `toolCall.name` → `toolCall.toolName` → **`toolCall._meta[<product>].toolName`** →
  **`toolCall._meta.toolName`**（协议级扁平兜底）→ `toolCall.title`。
  - 新增来源标签 `TOOL_NAME_SOURCE.meta = '_meta(TOOL_NAME_SLUGS)'`，随
    `permission-pending` 的 `toolNameSource` 下发（延续 m-1「来源与取值同源」）。
  - `_meta` 取值必须同时过**三重过滤**，一条都不绕过：
    `UNINFORMATIVE_CATEGORY` 占位集（other/unknown/default/misc）、
    `isPermissionScopeSlug` 拒绝集（`external_directory`/`doom_loop`，G-1）、
    `TOOL_NAME_SLUGS` 白名单。畸形输入（`_meta` 非对象、命名空间值非对象、
    `toolName` 缺失/非字符串/纯空白/数组/数字）一律跳过，不抛异常、不放行。
    命名空间与 `toolName` 只认**自身属性**（`ownValue`），不接受原型链上的同名值。
  - 归一化沿用既有规则：返回值保留原样大小写（`'Bash'`），写入侧/命中侧
    `trim().toLowerCase()` 后落 `${productSlug}:${normalized}` 键（`qoder:bash`），
    **不引入 slugify**。
  - 函数签名加第二参 `product`（`resolveToolName(toolCall, product)`）。产品 slug 的
    取法与唯一调用点一致：`product.trim().toLowerCase()`（与 `addToolGrant`/
    `toolGrantCovers` 的授权键前缀同构），并沿用 `lib/index.js` provider 白名单
    那一条 `-cli` 后缀宽容；库内不另造产品标识。省略 `product` 时只跳过命名空间
    那一跳，其余行为不变。
- **日志文案保真（`lib/index.js:271-279`）**：provider 白名单的
  「权限请求不在白名单，**转交互审批**」/「部分越权…**转交互审批**」改为
  「…**继续走会话期/交互判定**」。该分支从来不 `return`，后面还有工作区默认规则、
  会话期路径/类别、工具名、用户落盘白名单四道可能免弹的关卡；旧文案会在最终自动放行时留下一条
  与事实相反的日志，实测正是它把排障方向带偏成「预检顺序不对」。**纯文案，判据与
  返回值未变。**

### 关于「预检顺序」（诊断修正，未改动代码）

0.7.8 的工具名预检（`lib/index.js:295`，一条独立的
`if (toolName && bindParentSessionId && sessionRules.toolGrantCovers(...)) → return 'allow'`）
**本来就排在交互审批之前**。本版它已**不再是独立的一段**：0.7.9 的「统一模型」把它折进
1.5 的 `evaluateRuleSources`——命中会话档且 `via === 'tools'` 时打同一条归因日志并
`return 'allow'`（`lib/index.js:354-367`），位置照旧在弹窗与 `Promise.race` 之前。
它此前对 qoder 从不生效，原因
不是位置，而是 `resolveToolName` 返回 null ⇒ `toolName` 为空 ⇒ 预检条件短路、
`addToolGrant` 也从未被调用。本版不加任何前移动作，改为新增端到端用例锁定该顺序：
「部分越权」日志确实先打，但同一条请求随后被工具名预检放行、**不发
`permission-pending`、不进 `Promise.race`**（见
`test/permission-handler-wiring.test.js` 的
「allow-session 后 sessionRules 里查得到 qoder:bash；换完全不同命令+混合越权路径 ⇒ 直接放行」）。

### 行为影响（用户明确诉求）

同一主代理会话内，只要授权过一次 qoder 的 `Bash`（点「会话期总是允许」或「总是允许」），
**该会话内所有 qoder bash 请求一律免弹，与路径无关**——包括路径全部落在工作区外、
provider 白名单只覆盖了一半的「部分越权」命令。这正是工具名授权的既有语义，
0.7.8 因为读不到 `_meta` 而对 qoder 完全没生效。

### 行为例外（用户明确选择）：危险命令保留交互询问

上面那条「同会话内所有 qoder bash 免弹」有一个用户裁决的例外。用户在
`~/.qoder/settings.json` 的 `permissions.ask` 里定了三条必须每次都问：
`Bash(rm -rf:*)`、`npm publish`、`git push`（`deny: Bash(sudo:*)` 由 qoder 自己硬拒，
不归本插件管）。若不加处理，0.7.9 的工具名授权会把这三类一起放掉。

- **新增 `lib/dangerous-commands.js`**：`dangerousExecuteMatch(toolCall)` 纯函数判据，
  返回 `{rule, segment, source}` 或 `null`。
  - 生效条件：`toolCall.kind` 属执行类（`execute`/`exec`/`shell`/`bash`/`command`），
    **或**能取到 `rawInput.command`。命令正文取值优先级
    `rawInput.command` → `content[].content.text` → `title`。
    **不**把"只有 content 文本"当生效条件：Write/Edit 的 content 块装的是文件正文/diff，
    里面有 `rm -rf` 是代码而非命令（qoder 的执行类请求必然带 `kind:"execute"`，
    且 `rawInput.command` 与 `content[].text` 同值，不因此漏判）。
  - **分段匹配，不做全串 `includes`**：按 `;` `|` `||` `&` `&&` 与换行切成子命令
    （引号内不切分），**只对每段的命令开头判**。所以 `echo "git push"`、
    `echo npm publish`、`grep "git push" file`、`# rm -rf /tmp`、
    `curl 'a=1&rm -rf'`、`git log --grep push` 都不算危险命令。
  - 覆盖的等价写法：`rm -rf` / `rm -fr` / `rm -r -f` / `rm -f -r` / `rm -Rf` /
    `rm --recursive --force` / `rm --force --recursive` / `rm /x -rf` / `rm -v -rf`
    （**递归与强制必须同时具备**，`rm -r`、`rm -f` 单旗帜不触发）；
    `npm publish` 与 `git push` 允许前置全局选项（`npm --silent publish`、
    `git --no-pager push`，判据是"程序名之后第一个非选项 token"）；
    前导环境变量赋值会被跳过（`FOO=1 rm -rf x` 仍判危险）。
  - 大小写：命令名与子命令动词按**小写副本比对**（macOS APFS 默认大小写不敏感卷上
    `RM -RF x` 真会执行 rm）。只影响比对，不影响被记录/展示的原文。
- **接线位置**（`lib/index.js:246-254`）：门排在**一切规则/放行决定之前**——函数体第
  一句就是 `const danger = dangerousExecuteMatch(toolCall)`，命中即打一条
  `危险命令门命中（rm -rf，命令正文取自 rawInput.command），本次不因任何规则放行
  （provider 白名单/工作区默认/会话期/落盘一律关闭）` 的归因日志，然后：
  - provider 白名单快速路径条件带上 `!danger`（`:262`）；
  - 统一评估的 `ruleSources` 在 danger 命中时**整档不推入**（`:345-350`，
    session/disk/workspace 三档一并关闭），`ruleVerdict` 直接取
    `{allowed:false, uncovered: reqPaths}`（`:351-353`）；
  - 请求继续走原有交互审批 ⇒ **不静默放行、仍弹球**（与沙箱越权被排除时同形状）。
  命中范围因此是「任何免弹通道都不吃」，不只是工具名短路：`rm -rf` 即使目标路径在
  工作区内、即使 `qoder:bash` 已授权、即使落在用户落盘白名单里，也照样每次都问。
  （上一版本本节写过「只关掉工具名短路这一条通道」，与实现不符，已按实现改正。）
- **仍然保留的交互**：用户对危险命令点「会话期总是允许」也**不会**变成免弹——授权照旧
  写入 `toolGrants`（既有语义，不改），但下一次同名危险命令仍被门拦下继续询问
  （`test/permission-handler-wiring.test.js` 的「用户对危险命令点了『会话期总是允许』
  也不会把它变成免弹」与缺口A 的「工具档命中后，危险命令三条例外仍须逐次询问」两条钉住）。
- **不覆盖的间接写法**（与 qoder 自身 `Bash(rm -rf:*)` 前缀语义同等盲区，不做猜测性
  拦截）：`sudo rm -rf`、`command rm -rf`、`env rm -rf`、`bash -c 'rm -rf …'`、
  `sh -c`、`find | xargs rm -rf`、`git -C <dir> push`（全局选项带值把动词挤到第三位）、
  `pnpm publish` / `yarn publish` / `lerna publish`、以及 `git clean -fdx` /
  `git reset --hard` 这类同样具破坏性但不在用户名单里的子命令。清单已同步写入模块头
  注释，并有 `test/dangerous-commands.test.js` 的「已知不覆盖写法」用例钉住——
  将来扩展覆盖时必须同时改两处。
  ⚠️ **第三轮追加裁定已把此清单大幅收窄**：透明包装（`sudo`/`command`/`env`/`xargs`…）、
  `bash -c '…'` 解一层、取值选项（`git -C <dir> push`…）、`pnpm/yarn publish`
  **全部转为覆盖**（与宿主侧 `dsh-agent-dispatch` 的 `DANGEROUS_COMMAND_RULES` 对齐）；
  真正仍然不覆盖的是静态不可判定与名单之外的那几类，见下面「行为例外补充」与模块头注释。

### 行为例外补充（第三轮追加裁定）：名单 3 → 5 条 + 取值选项 + 包装写法（与宿主侧对齐）

用户裁决「这几类命令在**任何档位**都必须走交互询问」在宿主通道（`tool/call`）已生效，
但在 ACP 通道（qoder 等产品子代理）没生效——两侧名单与口径**跨仓不同步**：产品侧只有
3 条、且命令动词判定**不跳过取值选项**（宿主侧注释里那句「需人工保持同步」正是为此）。
本轮按宿主侧同一份口径补齐：

- **名单 3 → 5 条**：新增 `pnpm publish`、`yarn publish`（含 `yarn npm publish`，
  yarn 2+ 的写法）。
- **命令动词判定跳过"取值选项"**：`git -C <dir> push`、`git -c k=v push`、
  `npm --prefix <p> publish`、`npm -C /tmp publish`、`pnpm -C /tmp publish`、
  `pnpm --dir /tmp publish`、`yarn --cwd /tmp publish`（`--opt=value` 是单 token，
  不再吃掉下一个）。
  ⚠️ **查表前必须归一大小写**：宿主侧那两张表存的是 `-C`、`--user` 这类**大小写原样**
  的值，而 token 侧先 `toLowerCase()` ⇒ 不归一就永远匹配不上 `-c`，
  `npm -C /tmp publish` / `pnpm -C /tmp publish` **静默放行**（宿主侧实测踩过，本轮
  两侧一起修）。产品侧把**表与 token 都小写化**后查（`lowerSet`），并有专门用例钉住。
- **透明包装**：`sudo` / `command` / `env` / `nohup` / `nice` / `time` / `timeout` /
  `stdbuf` / `xargs` / `busybox` / `toybox`（含各自选项与数值参数：`sudo -u root rm …`、
  `nice -n 10 rm …`、`timeout 5 rm …`），可叠加；程序名按 **basename** 比对
  （`/bin/rm -rf`、`./rm -rf`、`/usr/bin/env rm -rf`）。
- **解一层 shell 包装**：`sh|bash|zsh|dash|ksh -c '<body>'`（含 `-lc`/`-ec` 组合短选项
  与 `-c'rm -rf x'` 粘连写法）把 body 再喂给同一份规则，**递归上限 2 层**；第 3 层起按
  `shell-nesting`（**可疑**）保守转交互，不做无限展开。shell 的 `-c` 判定**大小写敏感**
  （`-C` 是 noclobber，不是 `-c`）——该归一化**只**适用于"取值选项表"。
- 误伤守卫全绿（新增名单后逐条回归）：`echo "git push"`、`grep "git push" file`、
  `git commit -m "git push"`、`git log --grep push`、`npm run publish`、
  `pnpm run publish`、`yarn run publish`、`rm -r`、`rm -f`、`ls -la`、`echo hi`、
  `# rm -rf`、`bash --norc`，以及 `write`/`edit` 正文里提到这些词（正文不是命令字段）。

### 行为放宽（本轮明示）

以下两条是本轮**相对 0.7.8 的行为放宽**（`lib/index.js` 1.5 档的注释把工作区默认档的放宽
「写在 CHANGELOG 的『行为放宽』一节」，指的就是本节；此前该节缺失，属文档欠账）：

1. **工作区默认档：cwd 子树自动放行，无需任何配置**（`lib/permission-rules.js` 的
   `workspaceRuleOf`，挂在 `lib/index.js` 1.5 档的 `tier: 'workspace'`）。请求路径
   **全部**落在本 child 的工作目录子树内即免弹（对标 DSH `workspace-write` 沙箱语义：
   工作区内可写，工作区外才需要问）。cwd 取不到时本档不生效（退回交互审批）；
   危险命令门命中时本档整档关闭。
2. **`paths` 规则由「精确路径集合」改为「目录子树」**（`lib/permission-rules.js` 的
   `compileRulePath` / `pathMatchesClause`）：旧配置里写**文件**路径会覆盖它的**整个
   目录**；遗留 `allowlist.json` 里的 `/tmp/*` 等价于整棵 `/tmp` 子树（`/tmp`、`/tmp/`、
   `/tmp/*`、`/tmp/**` 四种写法同义，见下面「老 `~/.dsh/.../allowlist.json` 在新语义下
   怎么被解释」）。这条对**既有**规则同样生效：用户此前写的细粒度文件条目，本版会覆盖
   到它的兄弟文件。

第 ③ 条（legacy 出口现在按 cwd 绑定）属**收紧**，见下一节。

### 行为收紧：legacy 出口的会话规则改按 cwd 绑定

`lib/index.js` 的会话规则写入从

```js
sessionRules.add(sid, reqPaths, categoryKey)                    // cwd 缺省 ⇒ null ⇒ 通配
```

改为

```js
sessionRules.add(sid, plan.paths, effectiveCategoryKey, bindCwd, { expand: true })
```

即 legacy 出口（决策载荷**不带** `paths` 的老客户端）写出的会话规则现在带 `bindCwd`。
后果：同一主代理会话下、**换一个 cwd** 的同路径请求**不再被这条规则覆盖**，会**多弹一次**
授权球。这是**刻意的收紧**，与统一模型的「规则按 cwd 作用域」一致（工具名档本轮同样要求
「规则 cwd === 请求 cwd」）；`bindCwd` 取不到（null）时仍是通配，与 0.7.8 逐字节一致。
回归钉：`test/permission-state.test.js`「v0.7.9 复审 M-3：cwd 绑定的会话规则不跨 cwd 生效」。

### 复审修复（B-1 阻断 / M-1 fail-open / M-2 口径不一 / M-5 nit）

- **B-1（阻断）：JSON 下钻不得再吃正文键**（`lib/bridges/acp.js` 的
  `extractStructuredPaths`）。旧实现对**任意**字符串值 `JSON.parse` 后下钻，于是改
  `*.json` 配置时（**被编辑文件的正文本身就是 JSON**）正文里的 `{"dest":"~/.ssh/id_rsa"}`
  被当成**结构化路径**收进 `extractPaths` —— 而它是**唯一**能自动变成规则的路径集合
  ⇒ 会话授权里多出 `~/.ssh`，此后同会话对该目录的请求被静默放行。修法两条：
  ① JSON 下钻只允许**容器键**（`CONTAINER_KEYS = {'arguments'}`，老模型把参数以 JSON
  字符串下发）；② 正文键 `newText`/`oldText`/`new_text`/`old_text`/`new_string`/
  `old_string`/`text`（含 `content[].content.text`）**一律不参与**提取。其余结构化来源
  不变：`content[]` diff 块的 `path`、`rawInput.file_path`/`rawInput.path`、
  `locations[].path`、`kind==='execute'` 时的命令字段。用例：
  `test/extract-paths.test.js` 的「v0.7.9 复审 B-1」整组 + `test/permission-handler-wiring.test.js`
  的端到端（编辑 JSON 配置后**不得**有 `~/.ssh*` 进会话/落盘规则，随后对
  `~/.ssh/known_hosts` 的请求仍须弹窗）。
  ⚠️ **第三轮复审已把这里的"按键名剪枝"升级成递归白名单**（值若是对象/数组，黑名单
  挡不住）——见下面「复审修复（第三轮）」的 Major-1 一条；本条的容器键口径仍然有效。
- **M-1（fail-open）：危险命令门的正文来源补 `arguments.command`**
  （`lib/dangerous-commands.js`，取值实现见新模块 `lib/execute-frame.js`）。旧实现只读
  `rawInput.command` → `content[].content.text` → `title`，于是
  `{name:'shell', arguments:'{"command":"git push --force"}'}` 判 null ⇒ 工具名档短路 ⇒
  门失效（该会话授权过一次 `Bash` 后，`git push`/`rm -rf`/`npm publish` 不再询问）。
  对象与 JSON 字符串两种形状都支持。
- **M-2（口径不一）：执行类判定与命令正文取值单点化**（新文件 `lib/execute-frame.js` 的
  `isExecuteFrame` / `executeCommandText`）。改前危险门的生效条件是「`kind` 属执行类
  **或** 拿得到 `rawInput.command`」，而 `lib/bridges/acp.js` 的路径兜底对 `kind` 明确
  非执行类的帧**一票否决** —— 同一载荷两处相反
  （`{kind:'edit', rawInput:{command:'rm -rf /tmp/x'}}` 在门上命中、在路径层被否）。
  现在两处共用同一份实现，口径统一为「`kind` 明确非执行类 ⇒ 不判危险命令」，`kind`
  缺失时按 `name`/`title` 的执行类 slug 兜底（Claude/Codex 老模型）；`acp.js` 里那句
  「与 `lib/dangerous-commands.js:36` 同一份口径（两处必须一起改）」的注释随之改成对
  单点模块的引用。
  ⚠️ **该"统一口径"已被第三轮复审推翻**：让门跟着 `kind` 一起否决会造成静默放行
  （阻断），现在改为**门与 `kind` 解耦、路径侧仍严格**的**有意不对称** —— 详见下面
  「复审修复（第三轮）」的阻断一条。本条的"单点化"与 `arguments.command` 两条仍然有效。
- **M-5（nit）**：`decisionPaths` 旁挂表在「登记后、消费前进程被打断」时会留下一条
  **不可达**条目（`permId` 单调递增且不复用 ⇒ 永不可能再被读到）——已在 `lib/index.js`
  就地写明前提与边界（未改行为，未扩大改动面）。

### 复审修复（第三轮）：危险命令门与 `kind` 解耦（阻断）+ 结构化提取改递归白名单

第三轮独立只读终审判定「修复后交付」，同时抓到一条阻断与两条 Major。本节记录这轮的
四条改动（**版本仍 0.7.9**，尚未发布）。核心的一句设计裁定先写在前面：

> **门宁可多问，路径宁可少授权。**
> 危险命令门回答的是「**要不要多问一次**」这一个布尔（多问一次是安全方向）；
> 路径提取的产物是**唯一**能自动变成规则的集合（放宽即 fail-open）。
> 两处口径**刻意不同**，谁改哪一侧之前先读 `lib/execute-frame.js` 文件头。

- **🔴 阻断（fail-safe）：危险命令门对「非执行类 kind + 真命令字段」失效 ⇒ 静默放行。**
  现场（终审探针实测）：同一会话先授权 `qoder:bash`（正常 `kind:'execute'` 帧），随后
  `{kind:'other', name:'bash', title:'bash', rawInput:{command:'rm -rf /tmp/build'}}`
  —— 上一版补丁**一条 pending 事件都不发、直接 allow**（补丁前 pristine 会弹窗）。
  根因：上一版把「两处口径统一」当成目标，让门跟着 `kind` 一起对非执行类一票否决
  ⇒ `executeCommandText` 判 null ⇒ 门整档关闭 ⇒ `lib/index.js` 的 `!danger` 分支把
  session/disk/workspace 三档全部推入 ⇒ 命中会话级工具名授权后静默放行。
  改前的老口径是「只要拿得到 `rawInput.command` 就判危险」——这道保守冗余被关掉了。
  现实性：qoder 主链路是 `kind:"execute"` 不受影响，但**仓库自己的 fixture 就把 bash
  帧建模成 `kind:'other'`**（`test/permission-handler-wiring.test.js` 的 `BASH`、
  `BASH_QODER`），且 opencode 的真实载荷从未抓到 ⇒ 无法排除「某产品用非执行类 kind
  发 shell」。
  **修法（第三轮终审裁定，不再自选方向）**：`dangerousExecuteMatch` 与 `kind` **解耦**
  —— 只要请求里存在**命令字段**（`rawInput.command` 或 `arguments.command`，字符串 /
  对象两种形状）就拿它跑危险命令规则。实现落在 `lib/execute-frame.js` 的
  `executeCommandText(toolCall, sources, options)`；`title` / `content[].content.text`
  这两条**文本**来源仍只在执行类帧下可信（否则「写一个叫 `rm -rf.sh` 的文件」会天天弹窗）。
  **路径侧保持严格不变**（`lib/bridges/acp.js` 的 `scanExecuteCommandPaths` 只认执行类
  kind，非执行类一票否决）：这是**有意的不对称**，已写进 `lib/execute-frame.js` 与
  `lib/dangerous-commands.js` 的文件头注释（旧注释被读成「两处必须一致」，正是这次
  出错的诱因）。
  **用户可感知后果（阳性方向）**：非执行类 kind 帧里出现 `rm -rf` / `npm publish` /
  `git push` 时**会多弹一次窗**（此前静默放行）。
- **🟠 Major-1（fail-closed）：结构化提取的黑名单剪枝改成递归白名单**
  （`lib/bridges/acp.js` 的 `extractStructuredPaths`）。旧实现「按键名剪枝」只看
  **键名**、不看**值类型**：值若是对象/数组照常下钻，命中 `PATH_KEYS` 即进产物。终审探针
  的 F 组四条原文：`rawInput.content` 为对象 ⇒ `["/p/a.json","/etc/passwd"]`、
  `arguments.content` 为对象 ⇒ 同样、`rawInput.body` 为对象 ⇒ `["/p/a.json","~/.ssh"]`、
  `rawInput.edits[]` 内层对象 ⇒ `["/p/a.json","/etc/passwd"]`。修法：**只有**
  `rawInput`/`arguments`/`content`/`locations`/`_meta` 这些**结构键**才允许继续下钻
  （外加 `PATH_KEYS` 那一层的取值），其余键一律视为**数据、整棵剪掉**。
  权衡与歧义裁决（注释写在 `descendPathValue` 上，方向 **fail-closed**）：
  「结构键名出现在工具参数里」的形状（`arguments.content` 装正文）按**正文**处理；
  `content[]`/`locations[]` 的**块数组**（块内有 `type`）照旧取块内 `path`（Edit 帧目标
  文件的**主来源**，不许砍）；「路径包在无名对象里」（`content[].content.path`）不再取。
- **🟠 Major-2（文档）：`rawInput` 以 JSON 字符串下发这一形状的用户可感知后果。**
  该形状下 `extractPaths` 归零（`CONTAINER_KEYS` 只含 `arguments`，刻意不含 `rawInput`），
  方向是 fail-closed。后果**必须按三个子形状分别说**（第四轮终审用真实
  `appendUserRule` / `readUserAllowlist` 写临时目录逐形状实测；本节此前把三者混成一条，
  其中形状 **A 写反了**）：

  | 子形状 | 触发条件 | 落盘内容 | `outcome` | 后续**同工具**请求 |
  | --- | --- | --- | --- | --- |
  | **A** | 工具名可解析（`name`/`toolName`/`title` 命中 `TOOL_NAME_SLUGS`）**且**客户端显式下发 `paths: []` | `{paths: [], tools: ["<product>:<toolName>"]}`（`planGrantWrites` 的 `tools` 出口） | `granted-always` | **免弹**（会话级工具档已写）—— 比路径档**更宽**（工具粒度、跨路径） |
  | **B** | 老客户端：**不发 `paths`**（`legacy` 出口；自动分析结果为空 ⇒ `{paths: []}` 被 `appendUserRule` 拒） | 无（落盘失败） | `granted-once-fallback` | **本会话内仍免弹**（`allow-always` 分支照旧写会话级工具档） |
  | **C** | 工具名**解析不出**（不在 `TOOL_NAME_SLUGS`） | 无 | `granted-once-fallback` | 仍弹窗 ⇒ **只有这一形状**才是"点了没用" |

  ⚠️ 形状 A 依赖 **dispatch 侧显式下发 `paths: []`**（1.12.6 起：推测组默认不勾选，
  用户在授权球里清空目录 ⇒ 走 `tools` 出口）；1.12.4 的 `legacy` 出口不带 `paths`，
  对应形状 B。代码依据：`lib/index.js:574-625`（`allow-always` 分支），
  用例：`test/permission-handler-wiring.test.js` 的「allow-always + paths: [] ⇒ 落盘为
  工具档 tools:["qoder:bash"]」（A）、「落盘失败 ⇒ granted-once-fallback」（失败归因）。
  结论：本节原先那句"落盘路径为空 ⇒ 回退成 `granted-once-fallback`（即「总是允许」不持久，
  用户会看到「点了没用」）"**只对形状 C 成立**。保留原口径：**一旦抓到真实载荷就把
  `rawInput` 加进 `CONTAINER_KEYS`**，不要退回"任意字符串都 try `JSON.parse`"。
- **Minor/nit**：① `lib/bridges/acp.js` 数组分支的 `walk(x, depth)` 未递增 depth
  ⇒ `depth > 6` 护栏可被纯数组嵌套绕过，已补 `depth + 1`；② `lib/execute-frame.js` 的
  `own()` 对带 throwing getter 的载荷对象会抛（当前**不可达**：载荷经 JSON-RPC，
  唯一生产调用点在 `lib/index.js:260` 的 try 内、异常收敛为 deny）——已加纯防御 try；
  ③ dispatch 侧的兜底链路见下一条。

- **B-1 的兜底链路（终审 Minor-3，与 dsh-agent-dispatch 版本对齐）**：dispatch 侧
  **1.12.4** 发决策时**不带 `paths`**（`planGrantWrites` 走 `legacy` 出口 ⇒ 只用
  **结构化**路径，推测档/正文里的路径一条都不参与）；**1.12.6** 把推测组设为
  **默认不勾选**（授权球里"推测出来的目录"预填但默认关闭）。两条合起来才是 B-1 的
  完整兜底：即便 `extractPaths` 这一层漏进一条正文假路径，用户那侧的默认值与
  legacy 出口也不会让它自动变成规则。

### 复审修复（第四轮）：正文对象冒充 ACP 块（**阻断**）+ `env -S` 静默放行（Major）

第四轮独立只读终审对上一轮冻结包给出「B-1 真关掉、不对称只朝安全（7 条路径侧阴性全 `[]`）、
误伤 0、跨仓对齐 FAILS=0、篡改变异 4/4 与自报吻合、不变式未放宽」，同时抓到
**1 阻断 + 4 Major + 7 Minor**。本节记录本轮改动（**版本仍 0.7.9**，尚未发布）。

- **🔴 阻断（fail-open）：递归白名单不完整 ⇒ 正文对象冒充 ACP 块 ⇒ 端到端变成会话授权。**
  改前实测（终审探针原文，本仓复现一致）：
  `{kind:'edit', rawInput:{file_path:'/p/a.json', content:{type:'module', path:'/etc/passwd'}}}`
  ⇒ `["/p/a.json","/etc/passwd"]`；`content:[{type:'object', path}]` ⇒ 同样；
  `rawInput:{files:[{content:{path:'/etc/passwd'}}]}` ⇒ 同样（再嵌一层也漏）；
  `_meta:{dest|path}`、`locations:{path}` ⇒ 同样。
  **端到端**（真实 `permissionHandler` 闭包 + 生产 `sessionRules` + `expandPathsWithParents`）：
  `content` 带 `type` 的 Write 帧 ⇒ `extractPaths=["/p/a.json","~/.ssh/id_rsa"]` ⇒ 一次
  `allow-session` 后会话规则含 `/Users/arming/.ssh` ⇒ 此后对 `~/.ssh/known_hosts` 的请求
  `pending=0`、`outcome=allow`（**静默放行**）；对照（正文对象无 `type`）不泄漏。
  根因三条：① `lib/bridges/acp.js` 的 `isContentBlock` 只判 `hasOwnProperty('type')`
  （任何带 `type` 的**正文对象**都被当 ACP 块）；② `descendPathValue` 的 `PATH_KEYS`
  数组分支**完全没有**块形状判定（与 `content[]` 那支口径不一致 ⇒ `files:[{content:{…}}]` 漏）；
  ③ `_meta` 在 `STRUCTURAL_KEYS` 里（只贡献攻击面、无收益）。
  修法三条（`lib/bridges/acp.js`）：
  ① `isContentBlock` 改为 **ACP 块类型白名单**（`ACP_BLOCK_TYPES` =
     text / image / audio / resource_link / resource / diff / content / terminal），
     并抽出**唯一一份**块数组谓词 `contentBlockItems`，`content[]` 那支与 `PATH_KEYS`
     数组分支**共用**它；
  ② **块数组资格只给 toolCall 顶层** 的 `content`/`locations`（`walk(..., atTop)`）：
     `rawInput.content` / `arguments.content` / `rawInput.locations` 这些同名键**一律当正文**
     （既不下钻、也不取值）；块内**不再**下钻同名键（`content[].content` 无论内层带不带
     `type` 都不取 —— 措辞与实现一致，Minor-5）；
  ③ `_meta` 移出 `STRUCTURAL_KEYS`（结构键只剩 `rawInput`/`arguments`）。
  验收：4 组载荷 ⇒ **只含真目标**；E2E 中 `allow-session` 后**会话与落盘**规则都不含任何
  `~/.ssh*`，且随后对 `~/.ssh/known_hosts` 的请求**仍弹窗**（`pending` 增加）。
  转红验证：把 `isContentBlock` 改回 `hasOwnProperty('type')` ⇒ 新增用例转红（含 E2E 一条）。
- **🟠 Major-1（fail-open）：`env -S '<命令>'` / `env --split-string=…` 静默放行。**
  `WRAPPER_VALUE_OPTIONS.env` 登记了 `-S`，但 `-S` 的取值是**整条命令**（多 token），
  通用选项扫描只 `i += 1` 吃掉一个 ⇒ 命令头错位 ⇒ 判 `null` ⇒ 已授权 `qoder:bash` 时
  静默 `allow`。**真机证据**：`env -S "rm -rf /private/tmp/.../envprobe/v1"` 真的把目录
  删掉（exit 0）。修法：新增 `splitStringPayload`，把 `-S`/`--split-string` **之后的全部
  token 拼回**（含 `-S'…'`、`--split-string='…'` 粘连写法），去引号后重新分词、再喂给
  同一份规则。验收：`env -S "rm -rf /x"`、`env --split-string="rm -rf /x"`、
  `env -S'rm -rf /x'` 命中；`env -S "ls /x"`、`env -S "echo rm -rf /x"` 不命中；
  **监听器层**同验（已授权 `qoder:bash` 时三条危险写法各自新增 `pending`）。
  转红验证：把该修法改回原样 ⇒ `env -S` 组用例转红。
- **🟠 Major-2（文档）：删掉「名单与覆盖边界一致」的表述。**
  文件头原称与宿主侧"名单与**覆盖边界**必须一致"；本轮把两侧同一份语料逐条跑了一遍：
  **规则名单**（`RULES` ↔ 宿主 `DANGEROUS_COMMAND_RULES`，5 条 id 与判据语义）确实一致，
  但宿主另有 5 处覆盖、本仓实测 `null`：`coreutils rm -rf x`（宿主把 `coreutils` 当多调用
  二进制）、`find /tmp -exec|-execdir rm -rf {} +`（宿主判 `rm -rf`）、裸解释器读 stdin/脚本
  （`printf '…' | bash`、`bash <<< '…'`、`bash deploy.sh`；宿主按 `SHELL_STDIN_RULE
  ='shell-stdin'` 保守转交互）、`bash -C rm -rf`（宿主判 `rm -rf`；本仓 `shellBody` 对 `-c`
  大小写敏感 ⇒ `null`，**保留分歧不改行为**：本机 `/bin/rm` 是二进制、`bash -C rm` 是
  "执行名为 rm 的脚本"）、自定义执行工具（宿主 `argsTextOf` 拼 args 所有字符串值）。
  现改为「**规则名单一致 + 宿主独有的覆盖逐条列出（附本仓现状）**」，并在
  `test/dangerous-commands.test.js` 把每一条**钉成用例**（含 `bash -c "rm -rf /x"` 仍命中的
  反向断言，防止"放开 `-C`"被误读成"关掉 shell 正文"）。
- **🟠 Major-3（文档）：M-2 段的后果写错 ⇒ 按 A/B/C 逐形状改写**（见上方 M-2 的三行表格）。
  摘要：A（工具名可解析 + 客户端显式下发 `paths: []`）⇒ 落盘
  `{paths: [], tools: ["<product>:<toolName>"]}`、`granted-always`、后续同工具**免弹**
  （**比路径档更宽**）；B（legacy 不发 `paths`）⇒ `granted-once-fallback`，但同会话内仍免弹
  （会话工具档已写）；C（工具名解析不出）⇒ 才是原先描述的"点了没用"。
- **🟠 Major-4（补断言）：把上一轮删掉的正向断言补回。**
  `{title:'execute', rawInput:{command:'rm -rf /tmp/x'}}` ⇒ `rm -rf`（原
  `test/dangerous-commands.test.js:254`），以及终审复现的 `{title:'bash',
  content:[{content:{text:'rm -rf /tmp/x'}}]}` ⇒ `rm -rf`（来源
  `content[].content.text`）—— `kind` 缺失时由 `name`/`title` 的执行类 slug 兜底
  （`lib/execute-frame.js` 的 `isExecuteFrame`）。同时保留"title 不在执行类 slug ⇒
  `content`/`title` 两条文本来源不可信"的阴性对照。
- **Minor（本轮一并处理）**：
  ① **`sudo×9`（包装跳数用尽）静默放行** ⇒ 与宿主对齐：新增
  `WRAPPER_DEPTH_RULE='wrapper-nesting'`（**可疑**、保守转交互），跳数预算导出为
  `MAX_WRAPPER_HOPS=8`；
  ② `locations` 不吃块形状判定 ⇒ 与阻断修法统一口径（单个对象 / 非位置数组 ⇒ 数据）；
  ③ `extractPaths` 遇 throwing getter 会抛 ⇒ 加 `readOwn` + `Object.keys` 防御，与
  `lib/execute-frame.js` 的 `own()` 同口径（抛的那个键跳过，其余键照常收集）；
  ④ `valueOptionsOf` 对 `'__proto__'`/`null` 表会抛 ⇒ 纯防御（own-property + `instanceof Set`
  判定；两条都**不可达**）；
  ⑤ 「诚实降级」措辞比实际宽 ⇒ 按实际行为重写（**无名对象不下钻**；块内同名键一律不下钻）；
  ⑥ `bash -C rm -rf` 分歧**只记录、不改行为**；⑦ 「已知不覆盖」清单与终审实测逐条对齐
  （13 条放行那批保持不变，新增的每一条都在测试里对应一条断言）。

### 复审修复（第五轮）：`descendPathValue` 数组分支漏 `atTop` 约束（**阻断**）+ 块级 `path` 过宽（Major）

第五轮独立只读终审对第四轮冻结包给出「上一轮的 8 条泄漏形状全部真关掉（端到端 LEAK 0/8）、
`env -S` 9/9 命中 5/5 不误报、Major 2/3/4 与不变式全部独立复现、读数与冻结全对、变异 4/4 吻合」，
同时在**同一族**又抓到 **1 阻断 + 1 Major + 1 Minor（同根因）**。本节记录本轮改动
（**版本仍 0.7.9**，未发布、未部署）。

- **🔴 阻断（fail-open）：`descendPathValue` 数组分支漏 `atTop` 约束 ⇒ 正文对象伪造块即可偷渡。**
  终审探针改前实测（本仓复现一致）：
  ```
  ok     | ③原始（无 type）—— 第四轮已修              => ["/p/a.json"]
  LEAK   | ③+type:"diff" —— 只加一个键               => ["/p/a.json","/etc/passwd"]
  LEAK   | ③+type:"text"                            => ["/p/a.json","/etc/passwd"]
  LEAK   | 同族：paths[].content / dest[].content / directory[].content / locations[].content + type
  ```
  会因 `item.content` 下钻而泄漏的键共 **23 个**（`path`/`paths`/`file`/`files`/`file_path`/
  `filepath`/`notebook_path`/`absolute_path`/`target_file`/`target_path`/`target`/`dir`/`dirs`/
  `dir_path`/`directory`/`directories`/`dest`/`destination`/`src`/`source`/`uri`/`location`/
  `locations`），改前命中 **22 个**（本仓探针 46 形状：leak 44 / ok 2）。
  **端到端**（真实 `appendUserRule`/`readUserAllowlist` 落临时目录）：
  `{kind:'write', rawInput:{file_path:'/p/a.json', files:[{content:{type:'diff', path:'~/.ssh/known_hosts'}}]}}`
  ⇒ `extractPaths` 含 `~/.ssh/known_hosts` ⇒ 一次 `allow-session` 后会话规则含
  `/Users/arming/.ssh` ⇒ 第二条读 `~/.ssh/known_hosts` 的请求 **`pending` 不增加**
  （`pending=1`，第二次被静默放行），日志 `命中会话期授权（主代理会话 parent-1…，1 路径（目录子树）），自动放行`。
  **根因**：`lib/bridges/acp.js:301-302`（改前行号）
  ```js
  const innerBlocks = contentBlockItems(readOwn(item, 'content'))
  if (innerBlocks) for (const b of innerBlocks) walk(b, depth + 1)
  ```
  这一支**没有 `atTop` 约束**；而 `isContentBlock` 只看 `type` 是否在白名单内 —— **`type` 只是
  正文对象里的一个键，正文完全可控** ⇒ 白名单对「帧字段」是有效判别器，对「正文」不是。
  第四轮的修法②（只认顶层 `content`/`locations`）**只加在 `walk` 的键分支、没加在本分支**
  ⇒ 半应用。文件头声明（`:206-208`）也因此与实现不符：`rawInput.files[].content` 同样是
  「`rawInput` 下的同名键」，却照常下钻取值。
  **修法（1 条删除 + 文档 1 处 + 断言 1 处更正）**：
  ① **删掉该 `item.content` 下钻**（`lib/bridges/acp.js`）—— `content[]` 块内的路径已由
     `walk` 的顶层 `k === 'content'` 分支收集，删掉**不损失任何真帧**；
  ② 文件头声明改为准确表述：只有顶层 `content[]`/`locations[]` 的块内路径会被收集；
     `rawInput.*`/`arguments.*` 下的一切同名键（含 `files[].content`、`paths[].content`、
     `dest[].content` 等**任何** PATH_KEYS 数组元素的 `content`）都是**工具参数正文**，一律当数据剪掉；
  ③ `test/extract-paths.test.js:410-411`（改前行号）的期望 `[TARGET,'/proj/real.ts']`
     **更正**为 `[TARGET]`（理由见下「被更正的既有断言」）。
  验收：23 键 × 2 形状（`{content:{…}}` / `{content:[{…}]}`）= **46/46 恰为 `[TARGET]`、LEAK 0**；
  `locations:[{path:'/p/a.txt', content:{type:'diff',path:L}}]` ⇒ `['/p/a.txt']`；
  端到端会话档/落盘档均无任何 `.ssh`，随后 `~/.ssh/known_hosts` 请求 **`pending` 必须增加**；
  真帧（真①–⑤、多块 Edit、顶层 `content:[{type:'diff',path:'/proj/real.ts'}]`）零回归。
  转红验证：把该下钻加回去 ⇒ 新增用例转红（见下「转红验证」）。
- **🟠 Major-1（fail-open）：块类型白名单对 `path` 键过度接受。**
  终审探针 B5：`content:[{type:'TEXT', path:'/etc/passwd'}]` ⇒ `["/etc/passwd"]`（`type:'diff'`
  才是正常形状）。ACP 里只有**帧级**块类型带 `path`（`diff` 是规范里唯一有 `path` 的
  `ToolCallContent` 变体），`text`/`image`/`audio`/`resource_link`/`resource`/`terminal`
  各带自己的字段（`text`/`uri`/`mimeType`/`terminalId`），没有 `path`。
  **修法**：新增 `FRAME_PATH_BLOCK_TYPES = new Set(['diff','content'])`，`takeFromItem` 与
  `walk` 的泛化 `k === 'path'` 分支**共用**同一个闸 `blockPathAllowed`（两个入口一个判据，
  避免"闸装在一处、绕道在另一处"）。**`content` 在豁免名单里是本轮刻意保留的边界**：
  `content` 块在本仓既有形状恒为 `{type:'content', content:{text:…}}` 的**正文载体**，把它
  一并收掉会让 `test/extract-paths.test.js:317-319`（第三轮 Major-1 的既有断言，本轮
  **未获准改动**）转红；且阻断的 22 个 LEAK 形状全部经由 `rawInput.<PATH_KEYS>[].content`
  下钻（已删除），与该闸无关。若后续终审判定 `content` 也必须收，改
  `FRAME_PATH_BLOCK_TYPES` 一行即可（届时需同步更正 `:319` 的期望并报备）。
  验收：`type:'text'`/`'TEXT'`/`'Text'`/`image`/`audio`/`resource_link`/`resource`/`terminal`
  + `path` ⇒ **不产出**该路径；`type:'diff'`/`'DIFF'` + `path` ⇒ 照旧产出；`text` 块的 `uri`
  是它的真字段 ⇒ 照旧产出。转红验证：把该闸去掉 ⇒ 新增用例转红。
- **🟠 Minor-4（X1，与阻断同根因）：顶层块 `path` 为数组、内嵌带 `type` 的 `content` 块偷渡。**
  `{content:[{type:'diff', path:[L, {content:{type:'diff', path:'/etc/shadow'}}]}]}` 改前 ⇒
  `["/etc/passwd","/etc/shadow"]`。随阻断一并关掉（数组元素的 `content` 不再下钻）：
  现在 ⇒ `["/etc/passwd"]` —— **元素自身的 `path` 是帧字段（取）**，内嵌 `content` 块不是（不取）。

#### 被更正的既有断言（本轮唯一一条，逐条报备）

| 位置 | 改前 | 改后 | 理由 |
| --- | --- | --- | --- |
| `test/extract-paths.test.js:410-411` | `const realBlock = { kind:'edit', rawInput:{ file_path:TARGET, files:[{ content:[{ type:'diff', path:'/proj/real.ts' }] }] } }`<br>`assert.deepEqual(extractPaths(realBlock), [TARGET,'/proj/real.ts'], '真块（ACP 名单内的 type）仍要取块内路径')` | 期望改为 `[TARGET]`，断言串改为「`rawInput.files[].content` 是工具参数正文 ⇒ 即便内层带 ACP 名单内的 type 也不下钻」；**反向断言挪到真·顶层**：`{kind:'edit', rawInput:{file_path:TARGET}, content:[{type:'diff', path:'/proj/real.ts'}]}` ⇒ `[TARGET,'/proj/real.ts']` | 原断言在为**一个不存在的 ACP 形状**背书：ACP 规范里工具调用内容在**顶层** `content[]`，`rawInput.files[].content` 只是**工具参数正文**（被编辑文件里写着一段看起来像块的内容，并不会让它变成块）。`type` 只是正文对象里的一个键、正文完全可控 ⇒ 这条断言把偷渡口钉成了不变式。**未被放宽**：反向断言仍在，只是挪到了真帧形状上。 |

`test/extract-paths.test.js:317-319`（`type:'content'` + `path`）**刻意保持原样未改**——见上方
Major-1 的 `content` 豁免说明。

> **⚠️ 第六轮裁定（后续更新，历史记录保留不改）**：上面这条"刻意保持原样未改"**已被推翻**。
> 裁定认为该断言在为**另一个不存在的 ACP 形状**背书、并且正好充当了偷渡通道的挡箭牌
> （正是为了保住它才把 `FRAME_PATH_BLOCK_TYPES` 放宽成 `['diff','content']`）。第六轮已把
> 块级 `path` 收窄到**只认 `diff`**，并**更正**该断言的期望为 `[]`。详见下方
> 「复审修复（第六轮）」。

#### 本轮只登记、不改（确认已知晓）

- **Minor-1**：`PERMISSION_SCOPE_SLUGS` 只有 `externaldirectory`/`doomloop` 两条，注释已诚实
  声明 `filesystem_write`/`network_access` 之类不会被拦 ⇒ 文档与实现一致，**不动**、也不在任何
  地方写成「已彻底解决」。
- **Minor-2**：**冻结包不含 `node_modules`** —— 直接解包跑 `node --test` 会得到 195/16（缺依赖），
  软链仓库 `node_modules` 后 484/484。冒烟时必须复用仓库 `node_modules`。
- **Minor-3**：`bash deploy.sh` 是本仓与宿主 5 处分歧里**最日常**的一条（本仓放行、宿主
  `shell-stdin` 转交互）⇒ 保持现状，但它是**最可能咬人**的一条（见下方「已知限制」）。
- **Major 1 的已知残余（本轮记录，未修；第七轮收口时更正登记口径）**：`pathKeyAllowed` 只闸
  `path` 这**一个**键名（`(node, key) => (key === 'path' ? blockPathAllowed(node) : true)`）
  ⇒ **除 `path` 以外的全部 `PATH_KEYS`** 在**块对象**上都照收，**不止** `file`/`uri`/`filePath`/
  `file_path` 这四个别名。逐条实测（`{kind:'edit', content:[{type:'text', <key>: L}]}`）：
  `file`/`uri`/`filePath`/`file_path`/`dest`/`src`/`target`/`dir`/`directory`/`notebook_path`、
  `files:[L]`/`paths:[L]`，以及 `{type:'text', dest:{path:L}}` ⇒ **全部产出 `L`**；只有 `path` 不产出
  （块类型白名单 `FRAME_PATH_BLOCK_TYPES` 只对 `path` 生效，对其余键名一律无效）。
  **威胁模型（终审已确认，可接受）**：该形状只在 **toolCall 顶层 `content[]` 的块对象**上成立，
  **不可由被编辑正文控制**（正文里的同名键/块对象要么被整棵剪掉、要么过不了"只认顶层 + 形状合格"
  的块资格）⇒ **不是新阻断**，下一轮复审不要把 `dest`/`target` 当新发现重报。本轮只做终审点名的
  口径（`path`），不擅自扩大面；若要一并收紧，需先确认没有真实载荷依赖"非 diff 块 + 这些路径
  字段"，并配用例与重新冻结。

### 复审修复（第六轮）：块级 `path` 收窄到**只认 `diff`** + **信封边界**（`rawInput`/`arguments` 下数组一律不取路径）

第六轮裁决把两条"方向 fail-closed"的口径钉死。两条都不是"再补一个键名"，而是**收窄边界** ——
前五轮反复复漏的根因是：只要"**正文**里嵌了路径键"还能决定授权，补名单就永远补不完
（`path`/`file`/`uri`/`filePath`/`file_path`/`dest`/`src`/`target`… 下一个键名又会漏一次），
而正文是**被编辑/被写入的内容**，仓库里任何文件都可以写着 `/etc/passwd`、`~/.ssh`。

#### ① 块级 `path` 的闸收窄到 strict：`FRAME_PATH_BLOCK_TYPES = new Set(['diff'])`

- 改前：`new Set(['diff', 'content'])`。豁免 `content` 的**唯一**理由是"要保住
  `test/extract-paths.test.js:317-319` 那条既有断言" —— 该断言要求实现必须收下
  `{type:'content', path:'/p/a.json'}` 块身上的 `path`。**断言与实现互相为对方的不收紧背书**，
  这正是"五轮都关不干净"的机制之一。
- 改后：`new Set(['diff'])`。ACP 里只有 `ToolCallContent::Diff` 带 `path`；
  `text`/`image`/`audio`/`resource_link`/`resource`/`content`/`terminal` 各带自己的字段
  （`text`/`data`/`uri`/`content`/`terminalId`），**没有 `path`**。
  该断言在为**一个不存在的 ACP 形状**背书 ⇒ 本轮一并更正（见下表）。
- 验收（逐条真跑）：`type:'text'/'TEXT'/'Text'/'image'/'IMAGE'/'audio'/'resource_link'/
  'resource'/'terminal'/'content'/'CONTENT'` + `path` ⇒ **不产出**；
  `type:'diff'/'DIFF'` + `path` ⇒ **照旧产出**（大小写不敏感）；
  `text` 块的**真字段** `uri` 照旧产出、其 `path` 不产出。

#### ② 信封边界：`rawInput` / `arguments` 下的数组/对象一律不取路径、也不下钻

- **为什么不是加键名**：第五轮修完"数组元素的 `content` 不再下钻"之后仍留着一族 ——
  信封下的**数组元素**照样按 `PATH_KEYS` 取值，`files:[{path:L}]`、`files:[{file:L}]`、
  `files:[{file_path:L}]`、`files:[{uri:L}]`、`files:[{dest:L}]`、`files:[{type:'text',file:L}]`
  全部把**工具参数正文**里的路径送进产物。同一族已经吃了五轮 ⇒ 本轮按**边界**关，不按键名关。
- **新口径（三条一起才是关的）**：
  1. **只有 toolCall 顶层**的 `content[]` / `locations[]` 允许从**块内**取路径
     （块类型按白名单，且 `path` 只对 `diff` 成立）；
  2. **`rawInput` / `arguments` 下的数组/对象（任何键名、任何深度）一律不取路径、也不下钻**
     —— 它们是**工具参数正文**；块内再嵌 `content` 同样不下钻；
  3. 但信封**顶层自己**的**标量**路径字段**照旧取** —— `rawInput.file_path` 是 qoder Edit 帧的
     命脉，claude/codex 的 `arguments.file_path`、以及 `arguments` 为 JSON 字符串的信封形态
     也必须照旧工作。**这是真实帧的命脉，不许弄丢。**
- 实现落点：`walk` 新增 `inEnv` 形参（信封内为 `true`）；数组分支 `if (inEnv) return`；
  `PATH_KEYS` 分支 `if (inEnv && typeof v !== 'string') continue`。
- **⚠️ 本轮实测过的回归（已修，留作哨兵）**：进信封时若把 `atTop` **原样透传**
  （`walk(v, depth + 1, k, atTop, true)`），信封内的 `content`/`locations` 会被
  `k === 'content' || k === 'locations'` 那一支当**顶层块数组**收下 ——
  `rawInput.content:[{type:'diff',path:L}]` / `rawInput.locations:[{path:L}]` 立刻复漏，
  等于把刚关上的口子从"信封"这一侧重新打开。正确写法是 `walk(v, depth + 1, k, false, true)`
  （进信封即不再是 toolCall 顶层）。

- **边界 B（登记，未关闭 · 嵌套信封的标量仍会被取）**：信封内**再嵌** `rawInput`/`arguments`
  （即**嵌套信封**）时，其**标量**路径字段仍会被取；同一层信封内的数组/对象则一律剪掉（⇒ 不产出）。
  终审与本轮各自实测的四例：`{rawInput:{rawInput:{file_path:L}}}`、
  `{rawInput:{arguments:{file_path:L}}}`、`{arguments:{rawInput:{file_path:L}}}`、
  `{rawInput:{arguments:'{"file_path":"L"}'}}` ⇒ **仍产出该路径**；
  而 `{rawInput:{rawInput:{files:[{path:L}]}}}`、`{rawInput:{rawInput:{edits:{path:L}}}}` ⇒ `[]`。
  机制：`STRUCTURAL_KEYS` 分支无条件 `walk(v, depth + 1, k, false, true)` 继续下钻，只有
  "信封内的**非标量**"才被剪掉 ⇒ 嵌套层级的**标量**照旧取值。本仓全量语料中**无确证真帧**依赖
  该形状（真帧命脉是**单层**信封顶层的标量）。**不关闭**：终审建议先拿到实机 ACP 帧再动；若要关闭，
  把 `lib/bridges/acp.js` 的 `STRUCTURAL_KEYS` 分支在 `inEnv === true` 时改为 `continue` 即可
  （一行，需配用例与重新冻结）。

#### 被更正的既有断言（本轮 2 条，逐条报备）

| 位置 | 改前 | 改后 | 理由 |
| --- | --- | --- | --- |
| `test/extract-paths.test.js:317-319`（更正后落在 `:332`–`:349`，断言在 `:349`） | `const frame = { kind:'edit', content:[{ type:'content', path:TARGET, content:{ text:{ path:'/etc/passwd' } } }] }`<br>`assert.deepEqual(extractPaths(frame), [TARGET])` | 期望改为 `[]`（连 `TARGET` 也不取），并补一条**反向**断言：同一形状换成 `type:'diff'` ⇒ `[TARGET]` | 两条理由缺一不可：① **块级 `path` 只对 `diff` 成立**，ACP 的 `content` 变体没有 `path` 字段，帧里那个 `path` 是**正文对象里的一个键**——该断言在为**不存在的 ACP 形状**背书，且与第五轮 B5 探针（`content:[{type:'TEXT',path:'/etc/passwd'}]`）同族；② 它同时是**偷渡通道的挡箭牌**（第五轮正是为保住它才放宽 `FRAME_PATH_BLOCK_TYPES`）。**未被放宽**：`diff` 块的正向断言在本行就地补上。 |
| `test/extract-paths.test.js:65-70`（更正后落在 `:69`–`:82`，断言在 `:81-82`） | `assert.deepEqual(extractPaths({ rawInput: { paths: ['/proj/1.txt', '/proj/2.txt'] } }), ['/proj/1.txt', '/proj/2.txt'])` | 期望改为 `[]`，并就地写明理由与代价 | `rawInput.paths` 是**工具参数正文里的数组**，不是 toolCall 顶层的块数组——正文由被编辑内容决定，`paths:[…]` 里完全可以写着 `/etc/passwd`、`~/.ssh`。只要"信封内数组按 `PATH_KEYS` 取值"还在，补键名就补不完。**代价（明确记录、方向 fail-closed）**：真出现"产品把路径以数组形式放在 `rawInput` 下"的形状会少预填一条 ⇒ 弹框预填为空、用户手填。本仓全量语料（`lib`/`roles`/`docs`）中**没有任何**产品以此形状下发路径的确证证据；确证真帧走的是信封**顶层标量**，那一路有专门用例守着。 |

#### Tests（第六轮）

- 新增 `test/extract-paths.test.js` describe **「v0.7.9 第六轮裁定：信封边界（rawInput/arguments
  下数组一律不取路径）」**（6 条）：23 个 `PATH_KEYS` × 9 种形状 × 2 种信封（`rawInput`/`arguments`）
  = **23 × 9 × 2 = 414 次迭代 / 828 条断言**（每轮迭代 2 条 `deepEqual`；含跑满计数断言，
  防"循环提前退出"式假绿）；信封下**对象**与**深度嵌套**同族；
  信封内 `content`/`locations` **不是**块数组（`atTop` 回归哨兵）；`locations[].content` 不下钻；
  块级 `path` 只认 `diff` 的阳性/阴性矩阵；**真帧零损失**（真①–⑤、多块 `content[]`、
  `locations[]` 三写法 + 纯字符串、`arguments` JSON 字符串信封、信封顶层标量 + 信封内数组并存）。
- 新增 `test/permission-handler-wiring.test.js` describe **「v0.7.9 第六轮裁定：信封内数组不得把
  正文路径写进会话/落盘规则」**（4 条）：前置（信封内数组/对象零贡献 + strict `diff`）；
  **端到端会话档**（`allow-session` 后会话规则无任何 `.ssh`，随后 `~/.ssh/known_hosts`
  的 `pending` **必须增加**）；**端到端落盘档**（真实 `appendUserRule`/`readUserAllowlist`
  写**临时目录**，绝不碰真实 `~/.dsh`；读回的落盘规则无 `.ssh`，且 `~/.ssh/known_hosts`
  仍弹窗）；**对照（差分）**——证明断言不是恒真的空断言。
- `node --test test/*.test.js` ⇒ **`# tests 504 / # suites 73 / # pass 504 / # fail 0 /
  # cancelled 0 / # skipped 0 / # todo 0`**，退出码 `0`（第五轮冻结读数 494 ⇒ 本轮 **+10**）。
- `node scripts/lint.js` ⇒ `lint ok: 56 files`，退出码 `0`。`node --check` 对
  `lib/bridges/acp.js` 与两个测试文件均通过。
- **转红验证 2 项（各贴原始输出 + 逐字节恢复自证）**：
  1. 去掉 `walk` 的 `if (inEnv && typeof v !== 'string') continue` ⇒ **7 条转红**，原始读数
     `rawInput.path = [{path}]` 用例 actual `['/p/a.json','/etc/passwd']`（期望 `['/p/a.json']`）、
     端到端会话档 `suggestedDirs` actual 多出 `/Users/arming/.ssh`。恢复后 `cmp` 逐字节一致、
     md5 回基线 `1058cf85d762b2523f6a03206eb37292`、`MUT-` grep 计数 `0`、复跑 504/504/0。
  2. `FRAME_PATH_BLOCK_TYPES` 改回 `['diff','content']` ⇒ **4 条转红**（含被更正的 `:317-319`
     与两条新文案），原始读数 `+ actual ['/p/a.json'] / - expected []`。恢复自证同上。

#### 冻结包成员数（说明，非缺陷）

冻结包 `/tmp/dsh-plugin-product-subagents-0.7.9-freeze.tar.gz` **排除仓库内历史 `.tgz` 产物**
（`--exclude='*.tgz'`）⇒ 成员数 **88**（不必凑回 92）。上一轮冻结包同为 88 成员 / 319706 B，
成员数口径一致、可比。

### 缺口A：授权决议可携带 `paths`（用户给定目录），且 `paths` 与 `tools` 互斥

用户需求：授权球只有「按自动分析出的路径记」这一种粒度，想把授权收紧到**自己指定的
那几个目录**（或者干脆一个目录都不给、只按工具记）。

- **决议载荷新增可选字段** `paths: string[]`
  （`product-subagents/permission-decision`，`lib/index.js:142-146`）。它挂在不影响既有
  决议形状的旁挂表上（`decisionPaths` / `decisionPathsKey` / `takeDecisionPaths`，
  `lib/index.js:93-101`）：**不改** `pendingDecisions.settle` 的入参与
  `{childId, permId, answer}` 的既有断言形态；按 `${childId}\0${permId}` 建键，
  取用即删（`Map` 不留残渣），permId 未命中的决议不登记。
- **三种语义，互斥且只有这三种**（单点判定点 `lib/index.js:474-486`，纯函数
  `planGrantWrites`，`lib/permission-rules.js:355`）：

  | 客户端给的 `paths` | 出口 | 路径档 | 工具名档 |
  | --- | --- | --- | --- |
  | 没给（非数组/缺字段 = 老客户端） | `legacy` | 照旧写自动分析结果 | 照旧写 |
  | 给了，最终目录集**非空** | `paths` | 只写用户给定那组目录 | **不写** |
  | 给了，为 `[]` **或全部被服务端判非法** | `tools` | **一条不写** | 只写 `product:toolName` |

  互斥由两个布尔量单点投影：`writePathTier = plan.mode !== 'tools'`、
  `writeToolTier = plan.mode !== 'paths'`（`:485-486`），`allow-session` 与
  `allow-always` 两条分支都只看它，不再各自判一遍，避免同一份语义给出两个答案。
- **不可盲信客户端**：给定目录在服务端重新校验
  （`validateDeclaredPaths`，`lib/permission-rules.js:294`）——只认「非空字符串 +
  绝对路径」，做**词法**规范化（剥引号/尾部标点、展开 `~`、解析 `.`/`..`、去尾部分隔符），
  逐条丢弃 **空串 / 纯空白 / 相对路径 / 文件系统根（`/`、`//`、`" / "`）/ 含 NUL /
  含换行 / 非字符串**并记录原因；**全被丢弃 ⇒ 与 `[]` 同义**（走工具档）。
  不做 realpath：客户端声明的是「目录意图」而不是磁盘真相，跟着软链走反而会把授权挪到链外。
- **安全护栏（本轮实现中发现并关掉的一个洞）**：用户给定的目录**绕开**
  `expandPathsWithParents`（`sessionRules.add(..., {expand: plan.expand})`，
  `plan.expand === false`；`lib/permission-state.js:207-216`）。自动分析给的是**文件**
  路径，取父目录是为了「兄弟文件不再弹窗」；客户端给的已经是目录，再升一级会把
  「放行 `/tmp/newproj`」放大成「放行 `/tmp`」——而新建工程目录**大多还不存在**，
  不存在的目录 `statSync` 失败会被当成文件，放大得更狠。
  用例：「安全护栏：声明一个尚不存在的目录 ⇒ 不得被展开成它的父目录」。
- **落盘侧**（`lib/index.js:565-582`）：`allow-always` 同样按 `plan` 分支——
  `paths` 档落用户给定目录（note 写明「目录由用户给定」）、`legacy` 档与改动前逐字节
  一致（不带 note）、`tools` 档落 `tools: ["<product>:<toolName>"]`。
  ⚠️ **`tools` 档落盘是新增能力**：`lib/user-allowlist.js` 的模块头原话是「按钮
  『总是允许』只持久 `paths`，从不写 `tools`」。本版把它扩成「`paths: []` 时落工具档」，
  影响面比一条路径授权**更宽**（同项目同工具的任意路径此后一律免弹，跨会话存活）。
  它只在用户**显式清空目录并点击总是允许**时发生，且仍受 `rule.cwd` 全等与产品前缀约束；
  这是本轮唯一的、刻意的落盘面放宽，已用
  「allow-always + paths: [] ⇒ 落盘为工具档 `tools:["qoder:bash"]`（新增落盘维度，须如实上报）」
  钉住，读回与命中（含跨 cwd、跨产品两个反例）都在用例里。
- **日志**（`lib/index.js:487-498`）：`allow-session` / `allow-always` 各打一行
  「授权写入判定点 → 档位=… 来源=… 规则=…（原样打印最终写入的规则集）…；服务端丢弃
  非法条目 N 条：原因(值) …」，三档文案互不相同，归因不混。
- **不做**：`tools` 与 `paths` 同时写（用户明示铁律）；客户端 `paths` 里出现根目录
  （`= 该会话内任意路径免弹`）；把 `legacy` 出口也过一遍校验（那会改变老客户端行为）。

### 缺口B：`permission-pending` 载荷新增 `suggestedDirs`（本版又补了 `inferredDirs`，见缺口D 修正）

- 新增字段 `suggestedDirs: string[]`（调用点 `lib/index.js:421` + 载荷字段 `:434`，纯函数
  `suggestedDirs`，`lib/permission-rules.js:386`）：对本次请求的**结构化**路径做
  「已存在的目录保留自身 / 文件取父目录 / 去重 / 词法规范化 / 丢根目录」，供 dispatch
  授权弹框那个「每行一个路径」的**可编辑文本框**预填，排在 `inferredDirs` 之前
  （弹框形态与来源收窄见缺口D 修正一节）。
- **既有 `paths` 字段语义一字未改**（仍是本次请求的结构化路径原文），新增是纯加法，
  老消费方不受影响；判定顺序、类别、工具名等其余键全部保留。
- `suggestedDirs` 的输出**不是**授权依据：真正写规则时用的仍是 `planGrantWrites` 的
  结果，二者刻意分离（预填给用户看的目录和被写入的目录可以不同）。

### 缺口C：`requestPermission` 日志改为结构化摘要

- `lib/bridges/acp.js` 的 `makeClient.requestPermission` 里那句
  `JSON.stringify(params.toolCall)?.slice(0, 500)` 换成
  `logRequestPermissionToolCall(command, params)`（调用点 `:789`；新函数
  `summarizeToolCallForLog` `:265`、`logRequestPermissionToolCall` `:347`）。
- **无条件**打印，每个字段**各自限长**、互不挤占：`toolCallId` / `kind` /
  `name` / `title` / `_meta` 的命名空间键名与其中的 `toolName`（qoder 的真名只在这里）/
  每个 diff 块的 `path`（无 diff path 时按 `rawInput.file_path` → `path` → `filePath`
  回退）与 `pathCount` / `locations[]` / `rawInput` 的**键名**（值一律截断）/
  `arguments` / `bodyChars`（正文真实长度）/ `preview`（正文预览，默认 **200** 字符，
  超出标 `…[+N字符]`）。载荷不是对象时如实打 `type=…`，不抛。
- 旧写法为什么必须换掉（差分实测，见 `test/toolcall-log-summary.test.js`）：Edit/Write
  帧的正文动辄 9KB，排在正文**之后**的字段整段被截没——包括 `_meta`（于是日志里根本
  看不到真工具名）、以及当正文块排在 diff 块之前时的 `content[].path` 与 `toolCallId`。
  排在正文之前的 `toolCallId`/`kind`/`rawInput.file_path` 旧写法本来也打得出，
  用例对此**如实承认**，不把差分写成「旧日志全瞎」。
- 前缀形状不变（`[product-subagents:perm] <command> requestPermission …`，仍走
  `console.warn`/stderr），既有 grep 抓法继续有效；诊断失败静默吞掉，绝不反过来搞崩审批链路。

### 缺口D：路径提取（规则面）移除对 diff 正文的文本扫描

- `extractPaths`（`lib/bridges/acp.js:51`）改为**结构化优先、兜底收口**：
  - Edit/Write/delete/move 等帧**只**认结构化字段：`content[].path` →
    `rawInput.file_path`/`rawInput.path` → `locations[].path`；
    **绝不**扫 `newText`/`oldText`/`content[].text` 等 diff 正文。
  - 兜底只允许一种场合：执行类帧（`kind` ∈ `execute`/`exec`/`shell`/`bash`/`command`；
    `kind` 缺失时看 `name`/`title` 的 slug）且结构化一无所获时，扫**命令正文**
    （`scanExecuteCommandPaths`，`:106`）——命令正文里的路径**就是**本次请求的客体
    （`cat /etc/hosts` 的对象确实是 `/etc/hosts`）。`kind` 明确为非执行类时一票否决，
    即便帧里夹带 `command` 字段也不扫。
  - 其它帧结构化一无所获 ⇒ 返回空集（宁可少一条路径去弹窗，也不写一条假授权）。
- 为什么必须收：会话级授权写的是「每条路径的上一级目录」，0.7.8 的兜底把 diff 正文里
  出现的字符串（`/etc/passwd`、`~/.qoder/settings.json`、示例路径、被测试的 fixture 路径…）
  也当请求路径 ⇒ **一条假路径就足以把一个无关目录写进授权集**。这不是显示瑕疵，是正确性前提。
- `scanPathsLoose` **不删**（本版修订口径），但它的产物**只有一条出路**：作为
  `permission-pending` 的 `inferredDirs`，预填进弹框文本框里 `suggestedDirs` **之后**
  的那几行。头注释（`lib/bridges/acp.js:190-206`）已改成这个契约：它的值**不得**进
  `extractPaths`、**不得**并进 `suggestedDirs`、**不得**出现在任何**自动**规则写入实参上；
  `extractPaths` 的函数体里也不许再出现它（`test/permission-handler-wiring.test.js` 的
  「源码不变量」用例同时钉这三条）。`test/extract-paths.test.js` 的差分用例继续拿它当"旧实现会怎样"
  的对照。
- ⚠️ **与本条转述不同的一处，如实上报**：用户口径是「只扫 `rawInput.command`」。
  实现同时接受老模型载荷的 `arguments.command`（含 `arguments` 是 JSON 字符串的形态），
  否则仓库既有的 `test/allowlist.test.js`「extractPaths: 嵌套 arguments 与 content 文本」
  这条历史用例会退化。收窄回「只认 `rawInput.command`」需要用户裁决（会把一类真实载荷
  的路径识别能力关掉）。两种来源都不碰 diff 正文，「绝不扫正文」这条保证未打折。
- `locations` 的裁决：**保留**，并已在 `extractPaths` 头注释与
  `PATH_KEYS` 处标注为「来源之一，不得作为唯一来源，更不得因为要喂 `locations` 而
  恢复正文扫描」。理由：ACP 规范里 `locations` 就是「本次调用触碰的文件位置」，
  语义正确（opencode 系实测会填）；qoder 目前不填它，保留无害。

### 缺口D 修正（用户改判两轮）：正文推测出的目录只作为 `inferredDirs` 预填，绝不进自动规则

上一节把正文扫描彻底挡在规则之外之后，用户改判：**方向对，但正文扫描正好可以喂弹框
预填**——只要加一道闸门。闸门的形式是**两个字段**（来源不同、预填顺序不同），而不是
一个字段。第二轮把**弹框形态定稿**：**没有勾选框**，弹框就是一个「每行一个路径」的
**可编辑文本框**，预填 = `suggestedDirs` 后接 `inferredDirs`（两档已互斥去重，直接顺序
拼接即可），用户**手动改行、手动删行**——删掉一行就等于去掉该项，也可以把某行改成
**更上层**的目录。

- **两个字段为什么仍然分开**（既然 UI 只是把它们拼成一段文本）：① 日志要能归因某一行
  是「实际触达」还是「正文推测」；② 「`paths` 缺省时的**自动**分析只用结构化结果」这条
  规则需要一条可断言的字段边界。分开**不是**两种勾选状态。
- **为什么要挡住正文推测项**：正文是被编辑的**内容**，不是意图——仓库里随便一个文件
  就可以写着 `/etc/passwd`、`~/.ssh/id_rsa`、`~/.qoder/settings.json`。若把它们和实际
  触达项混进同一档，用户无从判断哪些行值得删，而 `paths` 缺省时的自动分析会直接把
  这些敏感目录写成规则。
- **`suggestedDirs`（预填在前）的来源被收窄成"结构化"**：`content[].path`（diff 块）、
  `rawInput.file_path`/`rawInput.path`、`locations[].path`，以及 `kind==='execute'`
  时从 `rawInput.command` 识别出的路径——即 `extractPaths` 的结果，也就是本次请求
  **实际触达**的东西。语义与来源限制写在 `lib/permission-rules.js:369-385` 头注释
  （函数体 `:386`）。
- **`inferredDirs`（预填在后）= `scanPathsLoose` 的产物**，规范化口径与
  `suggestedDirs` 完全一致（同一套 `canonicalPath` + 取父目录 + 去重 + 丢根目录），
  并**排除** `suggestedDirs` 里已有的项。新函数 `inferredDirs` 在
  `lib/permission-rules.js:429`（契约写在 `:399-428`）；调用点唯一，在
  `lib/index.js:426`，字段落在载荷的 `:435`。排除的意义：同一目录若两档都有，
  文本框里就会出现**两行**，用户删一行还留着另一行。
- **不变的安全性质**（`test/permission-handler-wiring.test.js` 缺口D 修正那组钉住）：
  ① 没有任何来自文本扫描的路径会**自动**成为规则——用户改行/删行后，剩下的行经决议
  载荷的 `paths` 通道**显式**回传，仍要过 `validateDeclaredPaths` 服务端校验才可能写入；
  ② `extractPaths` 函数体不含 `scanPathsLoose`（自动规则输入只有结构化那一份）；
  ③ `lib/index.js` 里 `scanPathsLoose(` 只有 1 个调用点，且 `planGrantWrites(`、
  `sessionRules.add(`、`appendUserRule(`、`diskRule =` 四处实参都不许出现推测档；
  ④ 只有正文假路径、无结构化路径的畸形帧 ⇒ 自动分析**写不出任何**路径规则
  （`sessionRules.size === 0` 且 `toolGrantSize === 0`），但推测档照常预填那三个目录；
  ⑤ 决议**不带** `paths` 时，推测档每一项与「会话规则 ∪ 落盘规则」的序列化结果做
  `includes` 检查，交集为空。
- **推测档失败不得拖垮弹窗**：`inferredDirs(scanPathsLoose(toolCall), …)` 单独包了一层
  `try`（`lib/index.js` pending 事件处），文本扫描出任何岔子都只是少预填几行，
  `permission-pending` 事件与审批通道照常。
- **⚠️ 残留风险（用户已知并选择的形态）**：推测项既然被**预填**，用户**不改不删就点
  确认**时，这些目录仍会经 `paths` 通道落进规则。那条通道是**显式**授权（提交的是用户
  眼前文本框的内容），闸门只剩 `validateDeclaredPaths`（绝对路径、拒 `/`、非法丢弃、
  全非法视同空）与危险命令总闸。0.7.9 一侧不再为推测项做额外拦截——契约里已经没有
  「未勾选」这个概念，能做的只是把它们**排在后面**（用户一眼能看出后半截是猜的）。
  另外一条要说清的代价：两档拼成**同一个文本框**后，回传的 `paths` 数组里**没有来源标记**，
  所以落盘日志只能区分「用户给定 / 自动分析」，**无法**再区分「用户给定的这一行原本来自
  推测档」。要保留这条归因，需要宿主在提交时按档分开回传（属于契约变更，本轮未做）。
- **UI 侧（dispatch 宿主）需要配套改动才生效**：本仓库只负责把两组值放进载荷；
  「每行一个路径的可编辑文本框」的渲染在 `dsh-agent-dispatch` 那边，本轮未改
  （拼接顺序 `suggestedDirs → inferredDirs` 是宿主侧的实现约定，写在上面）。

### 老 `~/.dsh/.../allowlist.json` 在新语义下怎么被解释（只读兼容，未改写）

本轮**没有**读取、迁移、规范化用户磁盘上的那个文件（约束：不部署、不动 `~/.dsh`）。
下面说的是「新代码如何解释老条目」，用临时目录里的老形状文件验证
（`test/permission-rules.test.js` 的「老 allowlist.json 只读兼容」一节）。

- 目录子树语义与老写法**完全兼容**，`*` 不会被读成字面目录名：
  `/tmp/*`、`/tmp/**`、`/tmp/`、`/tmp` 四种写法都命中 `/tmp/build/out.txt`
  （`compileRulePath` 认「分隔符后紧跟 `*`/`**`」或「尾斜杠」为**显式目录**写法，
  并把 `/*` 剥掉后再做真身解析；macOS 上 `/tmp` 解析到 `/private/tmp`，请求侧走
  同一套解析，所以两边一致命中）。
- 需要**改写**的只有一种写法：`/tmp*`（`*` 前面没有分隔符）——它不是目录写法，而是
  一个名叫 `tmp*` 的字面目录（且因为 basename 不带点扩展名，启发式仍把它当目录），
  于是**永远命中不了** `/tmp/x`。推荐等价写法：直接写 `/tmp`（想要「仅这一层」的
  语义时写 `/tmp/` 也一样，两者都是子树）。
- 老条目缺 `product` 字段 ⇒ 只有当规则里的 `tools` 带 `product:` 前缀时才需要 product；
  纯路径规则不受影响（`compileRuleTools` 只在裸名时才要求规则自带 product）。
- 老条目指向「basename 带扩展名且磁盘上不存在」的路径（例如 `~/.dsh` 写成
  `/Users/x/.dsh` 时该目录尚未创建）会被启发式判成**文件**，只命中自身、不命中子树。
  这是既有启发式的已知边界（`compileRulePath`：显式写法 > 磁盘真相 > 字面扩展名），
  不是本轮引入的回归；想稳定表达目录意图就写 `/Users/x/.dsh/` 或 `/Users/x/.dsh/*`。
- 读侧**只读**：`readUserAllowlist` 不改文件字节（用例断言读一次、读两次之后
  文件内容与读之前完全相同）；写侧 `appendUserRule` 追加新条目时老条目原样保留、
  不重排、不补 `tools` 字段。

### 已知限制（仍未解决）

- 其他产品若同样不给 `name`/`toolName`/`_meta`，或只给一个不在 `TOOL_NAME_SLUGS`
  里的名字（本分支按用户口径**套了白名单**，比 `name`/`toolName` 侧更严），仍会退回
  L2 逐路径 / L3 仅本次。抓手自本版起变好：缺口C 的结构化日志会无条件打出
  `_meta` 里的工具名与命名空间键名。
- 白名单套在 `_meta` 侧的代价已写入 `resolveToolName` 头注释：将来某产品的真工具名
  （如 `search_codebase`）需要按名记忆时，只能往 `TOOL_NAME_SLUGS` 追加。
- 缺口A 的 `paths` 覆盖只作用于**授权写入**这一步；请求侧的路径识别仍由缺口D 的
  `extractPaths` 决定。用户给定目录里若有符号链接出界，`coverage` 走真身解析，
  与既有规则同源，本层不额外收紧。
- 跨产品隔离、`permId` FIFO 缺省逻辑本版未触碰；`lib/user-allowlist.js` 本版只改了
  「读侧允许 `tools`-only 规则」与新增 `tools` 档写入维度两处（见缺口A 的 ⚠️ 条目），
  进程级隔离（`rule.cwd` 全等 + paths 子集）语义未变。
- **冻结包不含依赖（第五轮终审 Minor-2，只登记）**：交付用的冻结包
  （`/tmp/dsh-plugin-product-subagents-0.7.9-freeze.tar.gz`）**不含 `node_modules`** ——
  直接解包跑 `node --test` 会得到 **195/16**（缺 `@agentclientprotocol/sdk` / `zod` 等依赖），
  软链或复用仓库 `node_modules` 后才是全绿。**冒烟测试必须复用仓库的 `node_modules`**
  （`ln -s <repo>/node_modules <unpacked>/node_modules` 或直接在仓库内跑）。
- **`bash deploy.sh` 是已知分歧里最可能咬人的一条（第五轮终审 Minor-3，只登记）**：
  本仓与宿主共 5 处分歧（见上方 Major-2 的清单），其中 `bash deploy.sh`（裸解释器执行脚本）
  **本仓判 `null`（放行）**、宿主按 `SHELL_STDIN_RULE='shell-stdin'` **保守转交互**。
  它是日常最常出现的写法（`bash deploy.sh`/`bash build.sh` 之类），**保留现状不改行为**
  （本仓只认命令正文里能自证的 `rm -rf` 之类；脚本内容不在载荷里，看不到），但使用本插件时
  要按"这条不会被危险门拦下"来预期。

### Tests

`npm test`（= `node --test`）：**463 项全绿，0 失败**（0.7.8 交付时基线 352 项，
0.7.9 净增 111 项——其中前两轮复审修复追加 20 项、第三轮复审修复追加 19 项，
未删除任何既有用例）；`node scripts/lint.js`
（对 `lib` + `test` 逐文件 `node --check`）：**lint ok: 56 files**（0.7.8 为 54；
本版新增 1 个测试文件 + 1 个 lib 模块 `lib/execute-frame.js`）。

- **第三轮复审追加 19 项**：`test/dangerous-commands.test.js` 的
  「第三轮复审 B-1」整组 9 项（门与 `kind` 解耦的现场帧、`arguments.command` 两种
  形状、`kind` 缺失/空白/数字、`kind` 缺失 + `title` 为命令正文、纯 Edit 帧阴性对照、
  阳性对照，以及**同一帧在路径侧仍为空集**的不对称断言；两条既有断言被就地改成阳性
  并写明理由）**+「追加裁定：名单与宿主侧对齐」整组 6 项**（5 条名单含 `yarn npm publish`、
  取值选项跳过、**大小写归一**（`pnpm -C /tmp publish` 必须命中这条专门钉坑）、
  透明包装、解一层 shell（含粘连 `-c'…'`、2 层上限 `shell-nesting`、`-C` 不算 `-c`）、
  误伤守卫回归；第 3 条既有断言（"已知不覆盖"整组）被拆成"已覆盖/仍不覆盖"两组）；
  `test/extract-paths.test.js` 的「第三轮复审 Major-1」整组 4 项
  （F 组四条原文载荷、`content[].content.text` 值为对象、八个数据键的"换名就漏"形状、
  结构性来源一条不许砍、纯数组嵌套不再绕过深度护栏）；`test/permission-handler-wiring.test.js`
  的端到端 1 项（`kind:'other'` 的 bash 帧带真命令字段 ⇒ 已授权 `qoder:bash`
  也必须再弹一次，不得静默 `allow`）。

- **缺口D 修正追加 11 项**：`test/permission-handler-wiring.test.js` +6（Edit 帧两档
  分离 + 预填顺序为「结构化在前、推测在后」、只有正文假路径的畸形帧自动分析写不出规则、
  用户删行后显式回传 `paths` 才写且只写剩下的行、execute 帧命令路径归
  `suggestedDirs` 且推测档排除、决议不带 `paths` 时推测档 ∩ 写入面为空、源码不变量）；
  `test/permission-rules.test.js` +5（`inferredDirs` 的规范化口径与 `suggestedDirs`
  一致、重合项排除、`structuredDirs` 缺省/畸形不抛、`rawInferred` 畸形不抛、
  `planGrantWrites` 的 legacy 出口仍原样引用自动分析那一份）。

- **新增 `test/toolcall-log-summary.test.js`（14 项，缺口C）**：结构化摘要的字段齐备性、
  单行性、预览限长（含 200/自定义 40 两个边界与 `…[+N字符]` 标注）、`_meta` 工具名、
  多 diff 块、`locations`/`arguments`、原型链字段不算产品写的信息、非对象载荷不抛，
  以及两条**差分**用例（同一份载荷下旧写法丢哪些字段、新写法一个不丢）+ 一条
  源码不变量（调用点不许退回 `slice(0,500)`，且只有一处调用点）。
- **`test/permission-handler-wiring.test.js`（+3 个 describe、18 项，缺口A/B 接线面）**：
  给定目录恰好入规则、不存在目录不放大到父目录、已存在目录保留自身、
  `paths`/`tools` 互斥两个方向、`[]` ⇒ 只写工具档并免弹、`[]` + 无工具名 ⇒ 什么都没写、
  非法条目逐条丢弃（含计数与原因）、全非法 ⇒ 等价 `[]`、`paths` 缺省的 legacy 回归守卫、
  旁挂表按 permId 隔离且消费即删、工具档命中后危险命令三条例外仍逐次询问；
  `allow-always` 三条落盘用例（`paths` 档、`tools` 档、失败归因）一律用注入的
  `appendUserRule` 捕获 + `mkdtempSync` 临时目录读回，**不碰用户真实 `~/.dsh`**；
  缺口B 三条（`suggestedDirs` 取父/去重/规范化、老字段齐备、畸形 `paths` 不抛）。
- **`test/permission-rules.test.js`（+4 个 describe、24 项）**：`validateDeclaredPaths`
  逐条校验与丢弃原因、`planGrantWrites` 三条出口与互斥不变式、`suggestedDirs` 纯逻辑
  （注入假 fs，不依赖磁盘）、老 `allowlist.json` 只读兼容（读前读后字节全等、
  `/tmp/*` 与 `/tmp` 等价、`/tmp*` 命中不了、`tools`-only 新条目与老条目共存）。
- **`test/extract-paths.test.js`（+4 项，缺口D）**：非执行类帧夹带 `command` 不扫、
  `kind` 明确非执行类一票否决、Edit 帧路径集合**恰好**等于 `content[]` 各 diff 块的
  `path`（多块/去重/保序 + `rawInput.file_path`/`rawInput.path` 两级回退）、
  `newText` 塞满假路径的差分流（旧兜底确实会抓进 `/etc/passwd`、
  `Library/Preferences` 这类正文路径），兜底只在执行类命令正文这一场合合法。
- **改动的既有断言（4 处，全部因缺口D 的收口，逐条在测试里就地写了理由）**：
  `test/extract-paths.test.js` 里多行值 `/tmp/a\r\nb`、散文句
  `target: 'the file at /tmp/x.txt is missing'`、200 层嵌套对象这三条原本期望扫出路径，
  现改为期望空集（它们都不是执行类命令正文，正是本轮要关掉的面）；
  「兜底仍在」那条改为断言 `extractStructuredPaths` 为空 + `extractPaths` 走执行类兜底。
  `test/allowlist.test.js`「extractPaths: 嵌套 arguments 与 content 文本」的期望值未改，
  而是把 `arguments.command` 与 `name`/`title` 的执行类判定补进实现来保持兼容
  （见缺口D 的 ⚠️ 上报条目）。
- **复审修复追加 20 项**（B-1/M-1/M-2/M-3）：
  `test/extract-paths.test.js` +6（B-1：验收用例「编辑 `a.json`、正文含
  `{"path":"/etc/passwd"}` 与 `{"dest":"~/.ssh"}` ⇒ 只返回 `/p/a.json`」、正文键逐个剪枝、
  旧下钻分支与旧文本扫描的**差分证明**、容器键 `arguments` 下钻保留、非容器键不下钻、
  `content[].content.text` 多层剪枝）；
  `test/dangerous-commands.test.js` +7（M-1：`arguments.command` 的 JSON 字符串与对象两种
  形状、`kind=execute` 形态、来源优先级不变、畸形 `arguments` 不抛不命中；M-2：`kind` 明确
  非执行类一票否决**且与 `extractPaths` 同口径**、`kind` 缺失时按 `name`/`title` 兜底）；
  `test/permission-state.test.js` +3（M-3：cwd 绑定的会话规则不跨 cwd 生效、`cwd=null`
  通配形状对照 + 工具名档 cwd 全等、同 cwd 幂等去重）；
  `test/permission-handler-wiring.test.js` +4（B-1 端到端：编辑 JSON 配置后**没有**任何
  `~/.ssh*` 进会话规则、随后对 `~/.ssh/known_hosts` 的请求仍须弹窗；allow-always 的**落盘**
  出口同样干净（会话/落盘两条出口都验）；前置差分；旧行为对照证明本组断言有牙齿）。

- **第四轮复审修复追加 21 项**（阻断 / Major-1 / Major-4 / Minor）：
  `test/extract-paths.test.js` +7（新增 describe「第四轮终审阻断」：修法①「带 `type` 的正文
  对象不得被当块下钻 ⇒ 改回 `hasOwnProperty('type')` 即转红」、修法① 同一份谓词（`files[]`
  分支 + 内层真块仍取的反向断言）、修法② 只认 toolCall 顶层（`arguments.content`/
  `rawInput.locations` 一律当正文 + 顶层 `content[]` 不许砍）、修法③ `_meta` 出白名单、
  Minor-2 `locations` 块形状统一、Minor-3 throwing getter 不抛、**差分证明**旧判定确实
  会把那几条正文路径收进产物）；
  `test/dangerous-commands.test.js` +8（Major-1 三条：四种 `-S`/`--split-string` 写法命中、
  多 token payload 里其它规则同样生效、`env -S "ls /x"`/`echo …`/空取值不过度命中；
  Minor-1 两条：跳数预算边界（8 跳判规则、第 9 跳起 `wrapper-nesting`）与无害命令不误报；
  Major-4 三条：`title:'bash'` + `content[].content.text` 命中、补回
  `{title:'execute', rawInput:{command}}`、阴性对照；另 +1 条跨仓边界差异逐条钉住
  （`coreutils` / `find -exec` / shell-stdin / `bash -C`）与 `valueOptionsOf` 防御断言）；
  `test/permission-handler-wiring.test.js` +5（Major-1 **监听器层**端到端：已授权
  `qoder:bash` 时 `env -S`/`--split-string`/`sudo×9` 各新增一次 `pending` + 安全命令阴性
  对照；阻断端到端 4 条：前置提取只含真目标、`allow-session` 后会话规则无 `~/.ssh*` 且
  随后读 `known_hosts` **仍弹窗**、`allow-always` 落盘（真实 `appendUserRule` +
  `readUserAllowlist` 写临时目录读回）同样干净、**对照组**证明断言有牙齿）。
- **本轮无既有断言被放宽或删除**：只**新增**断言，并把上一轮删掉的那条正向断言补回
  （见 Major-4）；`node --test test/*.test.js` ⇒ `# tests 484 / # pass 484 / # fail 0`。

#### 读数订正（第五轮冻结时刻）

上面这条 `484` 是**第四轮冻结时刻**的读数，保留为历史记录。第五轮修复后全量读数为
`node --test test/*.test.js` ⇒ **`# tests 494 / # suites 71 / # pass 494 / # fail 0 /
# cancelled 0 / # skipped 0 / # todo 0`**，`node scripts/lint.js` ⇒ **`lint ok: 56 files`**。
第五轮净增 **10 项**（`test/extract-paths.test.js` 新增 1 个 describe / 6 项：23 键 × 2 形状全量、
加 `type` 的既载荷、Minor-4 的 X1、`locations[].content` 同族、Major-1 的块级 `path` 类型闸、
真帧零回归一组；`test/permission-handler-wiring.test.js` 新增 1 个 describe / 4 项：前置 23 键 +
B5 阴性对照、会话档端到端、落盘档端到端（真实 `appendUserRule`/`readUserAllowlist` 写临时目录 +
真实读盘参与后续判定）、对照组）；**未删除、未放宽、未加 `skip`/`only` 任何既有断言**，
唯一一条被**更正**的既有断言（`test/extract-paths.test.js:410-411`）已在
上方「被更正的既有断言」逐条报备。

### 版本

`package.json` 版本 `0.7.9`。本轮**不部署**：不改 `~/.dsh`、不安装到运行时目录，
线上生效的仍是 0.7.8。

## [0.7.8] — 2026-10-05

用户需求：「会话内允许」此前按**路径**记忆，换个路径又弹窗；改为按**工具名**记忆——
在某主代理会话内允许过某工具后，同一主代理会话内所有子代理的相同工具调用直接放行，
直到进程结束。宿主不可改，故 ACP/product 侧全部在本插件内实现。

### Changed

- **L1: 工具名解析 `resolveToolName(toolCall)`（`lib/permission-state.js`）**——按
  `toolCall.name` → `toolCall.toolName` → `toolCall.title` 顺序解析可授权的工具名，
  命中即以 `product:toolName` 写入会话级工具名授权（`sessionRules.addToolGrant`），
  预检在 `lib/index.js:295` 于弹窗前放行，跨路径、跨子代理生效。
  - `name`/`toolName` 侧**非占位、且不在权限范围拒绝集内即收**（过滤
    `UNINFORMATIVE_CATEGORY` 与 `PERMISSION_SCOPE_SLUGS`，后者见下方 G-1 条）；
    `title` 侧**必须命中 `TOOL_NAME_SLUGS` 白名单**才被当作工具名。
    解析结果自本版起为 `{ value, source }`，`source` 随 `permission-pending`
    载荷下发（见 Fixed 的 m-1 条），不再由调用侧反推。
  - **这个不对称是有意的，不是遗漏**：ACP 协议里 `name`/`toolName` 本身就是工具名
    （取值空间是工具表，各产品自带、白名单列不全），而 opencode 链路的 `title` 被当作
    **权限类别 slug** 使用（同 `lib/bridges/acp.js:78-90` 的 `KIND_LABEL` 分表处理），
    里面既有 `bash`/`edit` 这种恰好指代单个工具的，也有 `external_directory`
    （工作区外读+写这一**权限范围**）、`doom_loop`（循环保护这一**保护机制**）这种
    指代不了单一工具的。title 是唯一会把「权限范围」伪装成「工具名」的入口，
    所以只有它需要白名单。理由已写入 `resolveToolName` 的函数头注释，
    以免后来人"顺手统一"两个方向中的任意一个。
- **L2: 解析不出工具名但解析得出路径 → 只写路径级会话记忆**（`lib/index.js:395`
  `const effectiveCategoryKey = toolName ? categoryKey : null`）：类别规则在 `toolName`
  为 null 时语义过宽（记住 `external_directory` 等于此后所有无路径的该类请求都放行），
  故 L2 不写类别规则、也不写工具名授权，只写一条路径规则，**沿用既有 `cover()`
  前缀语义**。
  - **L2 的粒度是「父目录级」，不是「单个文件级」**：写入时经
    `expandPathsWithParents`（`lib/allowlist.js:126-141`）补上直接父目录，因此授权
    `/tmp/a.txt` 实际同时记住了 `/tmp`，此后 `/tmp/<任意文件>` 都不再弹窗。这与用户
    裁决的"解析不出工具名就解析**目录地址**"一致。**该语义是 0.6.2 起的既有行为，
    本版没有改它**——只是 L2 首次把它当作唯一的记忆通道（0.7.7 及以前所有请求都同时
    有路径规则和工具名授权两条通道，看不出这条通道的粒度边界）。
    已知后果，按目录级理解即可：一条工作区外文件路径被"会话内允许"后，
    **同目录其它文件在同一主代理会话内不再弹窗**；跨目录仍弹。
- **行为反转（用户已裁决接受）**：v0.6.2(m5)「执行类一律不进会话期记忆」在
  **工具名维度**上被反转——`bash`/`shell`/`exec` 等执行类 slug 已收录进
  `TOOL_NAME_SLUGS`，可按工具名记忆。`isExecutionCategory` 对**路径/类别规则**
  的拒写不变（无路径的执行类请求仍不落类别规则）。

### Security Fixed（行为收紧）

- **L3: 工具名与路径都解析不出 → 本次放行一次，但不写入任何会话级授权**
  （`lib/index.js:434-441`：`btnOutcome='allowed-once'`（`:435`）+ warn「本次未写入任何授权」
  （`:441`））。
  **这是相对 0.7.7 的行为收紧**：0.7.7 无脑取 `name || toolName || title` 作工具名，
  opencode 的 `title='external_directory'` 会被写成一条工具名授权，而工具名授权预检
  （`lib/index.js:295`）**完全不看路径**，于是同会话内此后**任意工作区外路径**的读写
  请求都被静默放行（实测：`/outside/ANYWHERE/x.txt`、`/Users/me/.ssh/id_rsa` 均命中放行）。
  0.7.8 下该 slug 不再具备工具粒度，落入 L2/L3。
  另注：L2 分支（`reqPaths` 非空却写不出规则，正常不应到达）此前误标为 L3，
  本版已把该处注释正名为「L2 路径写入失败」（`lib/index.js:421-424`，纯注释、
  未动判据/返回值/日志/断言）。
- **G-1（终审端到端实测复现后补修，安全相关）：权限范围 slug 在 `name`/`toolName`
  侧同样无条件拒绝**。0.7.8 初版的白名单只加在 `title` 侧（那处不对称是刻意的，见
  Changed 的 L1 条），于是 `{name:'other', toolName:'external_directory'}` 这类载荷
  仍会解析出 `toolName="external_directory"`（`source="name/toolName"`），点「会话内
  允许」后写出一条**会话级工具名授权**，而工具名授权预检完全不看路径 → 第二次同类
  请求静默放行。这等价于把 0.7.7 的「任意工作区外路径放行」缺口换个入口搬回
  `name`/`toolName` 侧，直接违背用户口径「**什么都分析不出来时，不要授权任意工作区外
  路径权限**」。它不是本版新引入（`{toolName:'external_directory'}` 单独出现时
  0.7.7 与 0.7.8 初版都已如此），但本版 m-2 拓宽了同一规则的覆盖形状。
  **修法**：新增显式拒绝集 `PERMISSION_SCOPE_SLUGS`（`lib/permission-state.js:387`，
  存"去分隔符、去大小写"形态；归一化函数 `permissionScopeKey:394-401`、判定
  `isPermissionScopeSlug:403-405`），内容 `external_directory`、`doom_loop`，
  **在 `resolveToolName` 的三个来源上无条件应用**——`name`/`toolName` 侧 `:505`、
  `title` 侧 `:512`。方向是**只收紧不放宽**：该集合只会让更多载荷返回 null → 落 L2/L3。
  它与白名单的分工是「**白名单防漏、黑名单防误**」，两者不冲突：白名单必然列不全，
  所以 `name`/`toolName` 侧不套白名单；但已知的、专门描述"权限范围/保护机制"的 slug
  在任何来源下都不是工具名。**误伤核对**：`TOOL_NAME_SLUGS` 全部 15 个成员以及
  `Write` 这类真名，在 `name`/`toolName`/`title` 三侧均仍可解析（用例逐成员覆盖）。
  理由已写入 `TOOL_NAME_SLUGS` 与 `resolveToolName` 的注释块。

### Fixed

- **授权键含 product 前缀**：`grantKey = `${productSlug}:${normalized}``
  （`lib/permission-state.js` `addToolGrant:230` / `toolGrantCovers:257`），
  同主代理会话下 A 产品的授权不放行 B 产品的同名工具。
- **`UNINFORMATIVE_CATEGORY` 写入侧（`lib/permission-state.js:229`）与命中侧（`:256`）
  同时过滤**，占位值不再产生通配授权。
- **把「按真实写入返回值组织日志」这一既有结构延伸到 L2/L3 并细化文案**：
  「`addToolGrant` 返回值参与日志组织」这件事 **0.7.7 就有**（`toolGranted` 直接吃返回值，
  0.7.7 `lib/index.js:383` 起即是 `stored.ok` / `toolGranted` / 仅本次 的三分支，
  见该版 `:388-394`），本版**不是新发明这个结构**。本轮做的是：
  ① 把该结构覆盖到新引入的 L2/L3 分支（`lib/index.js:420-441`）；
  ② L1 命中时把解析来源一起打进日志（`toolName(source)`）；
  ③ L2/L3 的失败原因改用条件式（`grantFailNote` `:429-431` / `l3Cause` `:438-440`），
  使「未能解析出工具名」这类话只在为真时说（详见下面 M-2 条）。
  首/次分支的判据、返回值与既有断言均未改动。
- **M-2（本版新引入缺陷，已修）：重复点击不再把「已授权」说成「什么都没写」**。
  `addToolGrant` 的布尔只回答「本次有没有写进一条**新**条目」，重复点击时返回 `false`
  而授权其实早已生效（`lib/permission-state.js:237` 把「已存在」与「被拒」并成一个
  `false`）。qoder 会把同一 `requestPermission` 连发多条（实测间隔 134–600 ms），
  用户对每条各点一次即触发：第二次点击落入 L3 分支，打出「未能解析出工具名」
  「本次未写入任何授权」两句**与事实相反**的话，并把 `btnOutcome` 从 `granted-session`
  降为 `allowed-once`（消费方看到的本轮结果失真）。
  修法为**写入前预检**（未改 `addToolGrant` 契约）：`lib/index.js:403-409` 与
  `:448-452` 先取 `grantPreexisting = toolGrantCovers(...)`，再取
  `grantWritten = addToolGrant(...)`，合并出 `toolGranted = grantWritten || grantPreexisting`，
  并仅在非首次写入时追加「（该会话此前已存在同名工具授权，本次未重复写入）」说明。
  首次授权路径的文案与改动前**逐字节一致**（插空串）。
  *未采用三态返回值方案的原因*：`test/permission-state.test.js:344`
  以 `assert.equal(rules.addToolGrant(...), false, '重复写入返回 false')` 钉死了布尔契约，
  改三态必然要动既有断言——本轮禁止动断言，故选预检方案。
- **M-2 同类项（终审裁定补修，纯文案）：allow-always 失败日志的归因不再一刀切**。
  `lib/index.js:465-471` 的 `noGrantReason` 原为 `(toolName ? 'addToolGrant 返回 false'
  : '未能解析出工具名…')` 两分支：当 `toolName` 非空但 `bindParentSessionId` 为 null 时，
  `addToolGrant` **根本没被调用**（被 `:450-451` 的三元短路），旧文案却宣称"返回 false"，
  把「无写入目标」说成「写入被拒」。现按真实原因三分：①解析不出工具名 /
  ②`无会话级写入目标（缺少主代理会话 id，本次未调用 addToolGrant）` /
  ③`addToolGrant 调用后被拒（product 非字符串/空，或工具名归一化后为空/占位）`。
  **只改字符串**：`!toolGranted`、`!toolName`、`!bindParentSessionId` 三个判据、外层
  `''` 兜底、`btnOutcome`、`:472` 的 `console.error` 模板均逐字未动。
  核对结论：无任何既有断言匹配旧串 `addToolGrant 返回 false`（全库检索 0 命中）；
  `:587`/`:595` 统计 `缺少主代理会话 id` 的两条断言只走 allow-session，`noGrantReason`
  在该路径不可达；`:615`/`:634` 只禁「已写入」，新串不含该子串。
  ③ 之所以近似不可达：条目已存在（去重）由 `:448` 的 `grantPreexisting` 兜住，
  不会落到 `!toolGranted`，故 ③ 只剩 `addToolGrant` 自身入参校验不合法一种可能。
- **m-1：`toolNameSource` 由 `resolveToolName` 自己给出，不再由调用侧反推**。
  原反推式 `toolCall?.name || toolCall?.toolName ? 'name/toolName' : 'title'`
  在「`name` 是占位值、真正命中的是 `title`」时说谎：`{name:'other',title:'bash'}`
  会被标成 `name/toolName`，而实际走的是白名单 title 通道。现
  `resolveToolName` 返回 `{ value, source }`（`lib/permission-state.js:493-517`，
  `TOOL_NAME_SOURCE` `:481-484`），`lib/index.js:190-192` 直取，
  `permission-pending` 载荷的 `toolNameSource` 与日志同源。仅修标注，不影响是否授权。
- **m-2（改进）：`name` 被占位过滤后继续看 `toolName`**。0.7.8 初版写作
  `const nameRaw = tool.name || tool.toolName`，当 `name` 是占位值（`other`/`unknown`/
  空白）而 `toolName` 带真名时，`||` 已把两者吞成一个、真名随占位过滤一起丢弃。
  现改为对 `[tool.name, tool.toolName]` 逐个试（`lib/permission-state.js:499-507`），
  占位过滤强度不变（`{name:'other',toolName:'Write'}` → `Write`）。
  这是**解析覆盖面的改进**，不是回退修复：0.7.7 及以前同样取不到该真名。
- **m-6：`sessionRules.add()` 无可写路径时补上 `reason`**。
  `lib/permission-state.js:202` 的兜底分支原先只回 `{ok:false}` 不带 `reason`，
  调用侧 L2 日志只能打成「路径/类别记忆也失败（未知）」，把「相对路径被 expand 滤光」
  这类可归因的失败说成不可知。现返回 `reason: 'no-usable-paths'`。
  `:180` 的 `!parentSessionId` 早退未动（保持 `cover/add` 入参不变量）。

### 已知限制（本版未解决，非缺陷）

- **opencode 真实 `requestPermission` 载荷始终未采集到**（M-1）。本版关于
  "`title` 装的是权限类别 slug 而不是工具名"的判断，**依据是显示侧的既成事实**——
  `lib/bridges/acp.js:78-86` 的 `describe()` 用 `KIND_LABEL` 表按 `tool.title` 查
  人类可读标签（`edit`/`bash`/`webfetch`/`doom_loop`/`external_directory` 五个键），
  即本插件早在 0.4.x 就按"title 是类别"来渲染弹窗。**没有一份 opencode 原始载荷
  被留存或抓取过**，因此 `name`/`toolName`/`kind` 在 opencode 链路里到底填不填、
  填什么，属于未知。测试里所有 `toolCall` 均为手工构造。
- **该未知的安全后果已核对，方向是 fail-closed**：白名单未命中的 `title` **一律落
  L2/L3**（`lib/permission-state.js:508-516`：白名单不中即 `return null`），
  最多是"该记的没记住、下次仍弹窗"，不会多放行任何东西；`name`/`toolName` 侧不设
  白名单，但 G-1 的 `PERMISSION_SCOPE_SLUGS` 已在该侧堵掉已知的两个权限范围 slug，
  真工具名照旧命中（m-2 后覆盖面更宽）。
  与 `KIND_LABEL` 的交叉核对结论：5 个键 ∩ `TOOL_NAME_SLUGS` =
  `edit` / `bash` / `webfetch` 三个 → 走 L1（它们确实各自指代一个工具，是想要的行为）；
  `doom_loop` / `external_directory` 两个 → 走 L2/L3（正是 0.7.8 要拦的"权限范围/保护机制"）。
  **当前没有任何真实类别 slug 被这个白名单误伤。**
- **残留风险面（三条，其中第 ③ 条是 fail-open 方向，不要当成"已彻底解决"）**：
  - ① opencode 日后新增一个恰好指代单个工具、但没进 `TOOL_NAME_SLUGS` 的类别 slug →
    该工具退化为路径级记忆，**多弹窗**（fail-closed）。
  - ② qoder / deveco 若把工具名写进 `title` 且该名不在白名单 → 同样退化为路径级，
    **多弹窗**（fail-closed）。①② 的处置动作都是"往白名单加一个 slug"，纯追加。
  - ③ **`PERMISSION_SCOPE_SLUGS` 同样是显式列举的清单，本身也可能不全**：若将来某产品
    把**新的**权限范围/保护机制 slug（如 `filesystem_write`、`network_access`、
    `yolo_mode` 之类）塞进 `name`/`toolName`，它仍会被当作工具名授权并跨路径免弹——
    **这一条的方向是"少弹窗"，即 fail-open，性质与 0.7.7 那个缺口同类**，故如实记录、
    不写作"已彻底解决"。同理，缩写/改名不在归一化射程内（`permissionScopeKey` 只处理
    大小写与分隔符，`externalDir` 不会命中；我们**故意没有**把它测成契约，以免把绕过
    固化成承诺）。处置手段只有两条：往拒绝集追加该 slug，或给该产品改配白名单。
  - **真机复核抓手**：`lib/bridges/acp.js:480` 会把原始载荷打到 stderr——
    `[product-subagents:perm] <command> requestPermission toolCall=<JSON 前 500 字符> options=…`。
    接上真机后按该日志一次性确认各产品 `title`/`name`/`toolName` 的实际取值空间，
    再决定两张清单要不要扩。**这一步是本版遗留的最重要待办。**
- **会话级工具名授权没有撤销入口**（m-8）。唯一清理点是 `session/disposed`
  （`lib/index.js:142-149` → `sessionRules.dispose`）；用户此后即使改点「拒绝」，
  也**不能**反向覆盖已经生效的工具名授权——预检在 `lib/index.js:295` 就 `return 'allow'`
  并结束本次，位于本轮拒绝判定 `isRoundRejected`（`:307`）**之前**，deny 分支根本走不到。
  这个先后次序 **0.7.7 完全相同**（0.7.7 亦为"先预检放行、后查本轮拒绝"），
  故**不是本版引入的回归**，只是本版把工具名通道变成主记忆维度后，其影响面从
  "同路径"扩大到"同会话内该工具名所有路径"。要立刻收口只有：退出宿主进程，
  或让主代理会话结束（`session/disposed`）。落盘的「总是允许(项目)」另有
  `allowlist.json`，可由用户手动编辑删除。
- **L1 免弹作用域 = 主代理会话 × product**，不区分子代理、不区分路径、不落盘；
  与 `sessionRules.cover` 的路径通道同级、互不覆盖（任一命中即放行）。

### Tests

- 新增 `describe('v0.7.8 L1/L2/L3 三级降级')`，现 **11 条**用例
  （`test/permission-handler-wiring.test.js:684-1126`）。其中**初版 6 条里有 4 条**
  （L2 / L3 / 跨产品 / 回归反证）在本版收尾前处于 **`cancelledByParent`**
  状态、从未真正执行：
  L2 用例给 `createSessionRules` 注入了 identity `expand`，
  而它断言的「同目录兄弟路径命中」恰恰依赖生产 `expandPathsWithParents` 的补父目录语义，
  于是第二次请求落在弹窗分支而用例没有应答者，`await` 永不 settle → 事件循环耗尽 →
  整个 describe 中止。**属测试写法缺陷**（判定证据：identity expand 下
  `cover(兄弟路径)=false`，生产 expand 下 `=true`，完全不同路径两者都为 `false`），
  代码语义未改；改为使用生产 expand，并补齐「未写工具名授权 / 未写类别规则 /
  命中时不得新增授权球 / deny 不得写规则」四组断言。
- L3 用例原用 `harness({_console})` 收集日志，但 harness 会把切片里的 `console`
  换成内置收集器、`_console` 根本不被注入 → 日志断言恒空。改为读 `h.logs`，
  并加断言「日志必须说『本次未写入任何授权』」。
- 跨产品用例原先 `h` 用 harness 默认表、`h2` 用另一张空表，**即便 product 前缀失效
  也照样通过（假绿）**。改为两表合一，并加一条「同产品另一 ACP 会话也必须免弹」的
  反证控制断言。
- **终审小修配套新增 4 + 5 条用例（全部为纯新增，未改任何既有断言）**：
  - `test/permission-handler-wiring.test.js`
    · `M-2: 同一 toolCall 连发两条、两次 allow-session 均不得失真`——复现 qoder 连发：
      两次点击后「授权球：会话期工具名授权」日志必须各 1 条、含「未能解析出工具名」的
      日志必须为 0 条、首条文案不得出现「此前已存在」（守住首次语义）、次条必须出现、
      两个 `resolved` 的 `outcome` 都必须是 `granted-session`、`toolGrantSize` 仍为 1；
      · `M-2: allow-always 重复点击不得把"此前已授权"说成"已写入"`；
      · `m-1: name 被占位过滤时，pending 载荷的 toolNameSource 必须是真实来源`（3 组载荷）；
      · `m-2: name 为占位值但 toolName 有真名 → 走 L1 用真名`（含跨路径免弹 + 不二次弹窗）。
  - `test/permission-state.test.js`：`resolveToolName 返回 {value, source}` 3 条
    （含「不放宽占位过滤」与 trim 语义）、`m-6：add() 拒写时的 reason 不得留空` 2 条
    （用生产 `expandPathsWithParents` 传相对路径，断言 `reason === 'no-usable-paths'`；
    并守住执行类 `reason` 不被覆盖）。
- **回归反证（G-1 后改为三组变异，措辞已按实测更正）**：
  - **A：只撤 `title` 侧白名单门**（去掉 `TOOL_NAME_SLUGS.has(titleSlug)`）→
    `268 tests / 267 pass / **1 fail** / 0 cancelled，退出码 1`，唯一转红的是
    `permission-pending toolName 取值优先级（仅 TOOL_NAME_SLUGS 收录的 title 可授权）`。
    **这条读数本身就是 G-1 生效的证据**：`external_directory`/`doom_loop` 现在被
    拒绝集拦着，单撤白名单已不能复现 0.7.7。故 A **不再足以**充当 0.7.7 反证——
    本版早前的自报（"撤白名单即 7 条转红"）是在 G-1 之前测的，现已随之失效，此处更正。
  - **B：白名单门 + 拒绝集同时撤（真·0.7.7 等价）**→
    `268 / 256 pass / **12 fail** / 0 cancelled，退出码 1`。12 条含 A 之前那 7 条全部
    （`L1: external_directory`、`L1: doom_loop`、`L2`、`L3`、`L1 regression`、
    `permission-pending toolName 取值优先级`、`m-1：source 报告真正命中的分支`）
    \+ 本 describe 的 `G-1` 端到端条 \+ G-1 单测 describe 的 4 条。
    关键证据仍是 `L1 regression`：`工具名授权为空` 报 `1 !== 0`（expected 0 / actual 1）。
  - **C：只清空 `PERMISSION_SCOPE_SLUGS`（白名单门保留）**→
    `268 / 263 pass / **5 fail** / 0 cancelled，退出码 1`，转红恰为 G-1 的
    `拒绝：external_directory 出现在任一来源`、`拒绝：doom_loop 同样三来源通拒`、
    `拒绝匹配跨写法`、`拒绝集是"只收紧不放宽"` 四条单测 \+ `G-1: …端到端复现终审载荷`
    一条；四条**放行锚点**与全量白名单不误伤用例保持绿（说明它们不依赖拒绝集，
    拒绝集没被拿来当"让测试变绿"的拐杖）。
  - 三轮变异恢复后均回到 `268 / 268 pass / 0 fail / 0 cancelled，退出码 0`，
    `lib/permission-state.js` 每次复原经 `cmp` + md5 双重校验逐字节一致
    （G-1 后基线 `52ae2c75cf0b86b64eb48f85f7c2d65c`）。
- **G-1 新增 7 条用例（全部纯新增，未改任何既有断言）**：
  `test/permission-state.test.js` 的 `describe('v0.7.8 G-1：PERMISSION_SCOPE_SLUGS 三来源拒绝')`
  6 条（三来源拒绝 × 2、跨写法归一化、放行锚点 4 例、15 个白名单成员三侧不误伤、
  被拒后仍回退真名），`test/permission-handler-wiring.test.js:1081` 端到端 1 条
  （复现终审载荷 → `pending.toolName === null`、`toolGrantSize === 0`、
  `toolGrantCovers('external_directory') === false`、落 L3 且日志说「本次未写入任何授权」、
  `outcome === 'allowed-once'`、**第二次同类请求仍弹球**、deny 后仍无授权、
  对照 `{toolName:'bash'}` 仍可解析）。
- **N-1（纯注释）**：`lib/permission-state.js` 的 `resolveToolName` 文档块内曾夹一个
  未闭合的 `/**`（注释不嵌套），导致 `const TOOL_NAME_SOURCE` 的文档注释被吸进上一块。
  已把该块正常闭合（`:474` 的 `*/`），**只动注释**，语法/行为/lint 均无影响。
- 全量：`node --test` → **268 tests / 268 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，
  退出码 0（34 suites）；`node scripts/lint.js` → `lint ok: 49 files`，退出码 0。

## [0.7.7] — 2026-10-05

### Fixed

- **B-#1: `allow-always` 落盘失败日志按真实写入结果分支**：此前日志只看 `toolName` 真假
  而不看 `addToolGrant` 返回值，导致占位 toolName（`other` 等）或 `bindParentSessionId`
  为 null 时日志声称「已写入」而实际未写入（与 allow-session 路径不对称）。
  现改为 `const toolGranted = sessionRules.addToolGrant(...)`，日志按 `toolGranted` 分支，
  与 allow-session 路径一致。验收：落盘失败 + 占位 toolName → 无「已写入」；
  落盘失败 + null parentSessionId → 无「已写入」且与 warn 不矛盾；
  落盘失败 + 有效 toolName + 有 parentSessionId → 「已写入」。

### Changed

- **Major-1: `size()` 语义窄化并明确**：`size()` 只统计路径/类别规则条数（注释已更正），
  新增 `toolGrantSize()` 查询工具名授权条数。选择窄化而非合并的理由：现有测试
  `rules.size('parent-1') === 0` 守的是「执行类路径/类别规则不得记忆」不变式，
  合并计数会掩盖该不变式违反。
- **Major-2: M4 仓库内测试覆盖补齐**：`PH_PARAMS` 补入 `missingParentSessionIdWarned`
  （此前缺项会导致测试缺失 parentSessionId 分支时 ReferenceError 崩掉）；新增 5 条
  真实用例覆盖 M4 行为（null parentSessionId 不写入、warn 去重、不影响其它工具、
  B-#1 验收三个场景）。
- **Minor: `missingParentSessionIdWarned` 清理**：在 `subagent/end` 回调中
  `delete(info.id)`（与 `clearRoundRejected` 同步），回合结束后新一轮可重新 warn。
- **Minor: CHANGELOG (a)(d) 断号修复**：v0.7.6 的 M2 披露中 (b)(c) 原为 B1/B2 修复
  自动闭环（占位过滤与 product 作用域已分别处理），现补为：
  - (b) 占位 toolName（`other` 等）在写入与命中两侧均被过滤，不再产生通配授权（B1 修复）；
  - (c) 工具名授权键纳入 product 前缀，不再跨产品越权放行（B2 修复）。
- **Minor: v0.7.5 历史段签名说明**：v0.7.6 中 `addToolGrant`/`toolGrantCovers` 签名
  由 2 参变为 3 参（新增 `product`），v0.7.5 历史段保留原 2 参描述不变。

## [0.7.6] — 2026-10-05

### Fixed

- **B1: 占位 toolName 不再产生通配授权**：`UNINFORMATIVE_CATEGORY`（`other`/`unknown`/`default`/`misc`/空串）
  的 toolName 在写入（`addToolGrant`）与命中（`toolGrantCovers`）两侧均被过滤，返回 false。
  此前，授权 `title:'other'` 后同一主会话内任何产品的 `other` 请求都被静默放行。
- **B2: 工具名授权键增加 product 作用域**：签名改为 `addToolGrant(parentSessionId, product, toolName)` /
  `toolGrantCovers(parentSessionId, product, toolName)`，内部键 = `${productSlug}:${toolName}`。
  此前键仅 `(parentSessionId, toolName)`，导致 qoder 授权 Bash 后 opencode 的 Bash 也被静默放行。

### Changed

- **M1: `allow-always` 落盘失败时的日志不再误导**：当 `cwd`/`paths` 缺失导致持久化落盘失败时，
  日志按 `addToolGrant` 真实返回值分支——写入成功则说「会话级工具名授权已写入」，
  写入失败（占位 toolName 或缺 parentSessionId）则不声称「已写入」。
  不再暗示「不会记忆」（实际会话级可能已记忆）。
- **M2: 补充披露**：
  - (a) opencode 系产品的 `title` 字段实为权限类别（如 `external_directory` = 工作区外读+写），
    故该产品的"工具名授权"实为类别粒度授权，而非单个工具。
  - (b) 占位 toolName（`other`/`unknown`/`default`/`misc` 等）在写入与命中两侧均被过滤，
    不再产生通配授权（B1 修复）。
  - (c) 工具名授权键纳入 product 前缀（`${productSlug}:${toolName}`），不再跨产品越权放行（B2 修复）。
  - (d) v0.6.2(m5)「执行类一律不记忆」的语义在本版被**反转**：执行类工具（`kind:'other'`）
    的路径/类别虽仍不记忆，但其工具名现在可被会话级授权记忆并跨路径免弹。
- **M3: `dispose()` 返回值纳入工具名授权计数**：此前只计路径/类别规则条数，
  工具名授权被清理但不计数 → 只放工具授权的会话销毁时无任何日志。现已修复。
- **M4: `bindParentSessionId` 缺失时加去重 warn 日志**：此前工具名授权在缺少
  主代理会话 id 时既不写入也不命中，且无任何日志，用户表现为「点了『本会话
  总是允许』却每次都还弹」，排障零线索。现加按 `childId` 去重的 warn 日志
  （同会话只打一次），说明「缺少主代理会话 id，本次工具名授权未写入会话级记忆」。
  日志位置：`lib/index.js:386`（allow-session）、`:405`（allow-always）。

## [0.7.5] — 2026-10-05

### Changed

- **会话级授权粒度从路径放宽为工具名**：用户在授权球点「本会话总是允许」后，
  同一主代理会话内、**不同路径**的同名工具调用直接放行，不再重复弹窗。
  记忆寿命 = 主代理会话存续期间（会话销毁即失效），不做进程级全局。
  - 新增 `addToolGrant(parentSessionId, toolName)` / `toolGrantCovers(parentSessionId, toolName)` 方法，
    与既有路径/类别规则并存、互不干扰。
  - 预检通道新增工具名判定：若本次请求的工具名命中该 `parentSessionId` 的工具名授权集合 → 直接放行，
    不进 `Promise.race`（与既有 `sessionRules.cover` 预检同级、同样返回形状）。
  - `permission-pending` 事件新增 `toolName` 字段（取值优先级：`toolCall.name` → `toolCall.toolName` → `toolCall.title`），
    老消费方不受影响（只增不改）。
  - `allow-always` 行为不变（进程级持久化仍按路径键）；额外写入会话级工具名授权作为会话期 bonus。
  - `toolName` 缺失时退化为现有行为（照常弹授权球），绝不因缺字段而误放行。
  - 工具名归一化：`trim()` + `toLowerCase()`；空值/undefined 不写入不命中。

## [0.7.4] — 2026-10-03

配合 dsh-agent-dispatch **1.11.24**：fallback 换档从「自动孙代」改为「主代理显式换档（同级子代理）」。
本仓只负责**阻塞等裁决并如实转达**；换档的决定权与替补的创建都在编排层。

### Added
- **`failoverMode`（`auto` | `notify` | `notify-then-auto`，默认 `notify-then-auto`）与
  `notifyWaitMs`（默认 `90000`）配置**，并随 `product-subagents/submit-failed` 事件下发，
  编排层据此决定「谁来换档」。三种模式**一律使用同级替补**（主代理的直接子级），
  差别只在「谁来决定、何时决定」：
  · `notify-then-auto`：先给主代理机会（`agent_failover`），超时由编排层自动换档；
  · `notify`：纯手动，超时按失败收尾；
  · `auto`：不等待，立即换档（保持 0.7.3 的全自动手感）。
- **`FAILOVER_HANDED_OFF` 错误码**（已归入 `interrupted` 级，绝不判 `failover`）：编排层完成
  交接后 `product_submit` 的收尾错误。
- **有界等待的安全网**：编排层自己的 `notifyWaitMs` 计时器是权威；本插件另加
  `notifyWaitMs + 2s` 的兜底（`finally` 里 `clearTimeout`，正常路径绝不拖住宿主进程），
  保证**编排层存在却不兑现**时本工具调用不会无限期阻塞。

### Changed
- **换档裁决的返回契约统一**：`{ handedOff }`（已交接）/ `{ timedOut, summary, message }`
  （通知模式超时，按失败收尾且信息自解释）/ `{ text }` / `{ exhausted }`（0.7.3 旧编排层，
  继续兼容）/ `null`（不接管）。
- `product_submit` 的模块头注释改写为新模型，并显式记录「交接路径**不得**二次 emit
  `submit-failed`」这条硬约束。

### Fixed
- **`FAILOVER_HANDED_OFF` 绝不可被当成产品故障**。该码未分级时兜底就是 `failover`
  （`classifySubmitFailure` 的最后一行），于是交接完成后再跑一条链 ⇒ **同一任务出现两个替补
  子代理**。现已在 `INTERRUPT_CODES` 中显式列出，与 dsh-agent-dispatch 的 `INTERRUPT_CODES`
  保持同构。

### Tests
- `test/submit-failover-handoff.test.js`（新，12 个用例）：`handedOff` 只 emit 一次
  `submit-failed`、`timedOut` 的自解释文案、载荷里的 `failoverMode` / `notifyWaitMs`
  （含非法值归一）、旧编排层 `{text}` / `{exhausted}` 兼容、`fatal` 完全不调处理器、
  安全网在宽限窗口内收尾。
- `test/submit-failover.test.js`：0.7.3 的既有 12 个用例全部继续通过（向后兼容回归）。

## [0.7.3] — 2026-10-03

### Fixed
- **fallback 链未走完就向父代理释放失败信号（用户现场两次事故的根因之一，配合 dsh-agent-dispatch 1.11.22）**：
  产品会话返回**空正文**（`stopReason=completed` 但无任何文本输出）时，宿主
  `@deepseek-ai/dsh-subagent` 的 `notifySettlement()` 会无条件给父代理发一条
  `Background subagent <childId> finished and will do no further work unless you send it more.`，
  而 Activation 结算发生在 relay child 回合结束的**瞬间**，早于编排层据 `subagent/end`
  做的换档判断。父代理于是先读到「任务已终结」，再看到后台新起一个 child 用同一份任务
  文本重投，误判失败后手工重派 → 两个同角色子代理并发覆盖同一批文件。
  **修法**：失败不再立刻抛给 relay child。`product-submissions` 事件载荷新增
  `onFailover(handler)` 登记口（向后兼容：旧字段一个没删），`product_submit` 在失败时
  **阻塞等待编排层登记的换档处理器**：换档成功 → 把新档答案当本次答案返回并补发
  `submit-ok`（本次提交从未失败）；链走完仍失败 → 抛 `FAILOVER_EXHAUSTED` 且错误文本
  自解释（已尝试哪些 route、各自最后错误）。未登记处理器（对接旧版编排层）时行为与
  0.3.7 逐字等价。
- **失败一律当作「可换档」处理**：`onChildEnd` 侧此前把**任何**产品故障都推进 fallback 链，
  认证失败、参数非法、语法错误这类「重试也不会有改善」的错误也会被换档重跑一遍
  （白烧请求，还把原因掩盖成「换档已停止」）。新增 `lib/submit-failure.js` 做三档分级：
  `failover`（限额/限流/空正文/超时/传输中断/5xx → 静默换下一档）、`fatal`
  （认证/参数/语法/模型不存在/人为拒绝/链已耗尽 → 不换档）、`interrupted`（人为取消）。
  判定顺序：配置覆盖 → 精确错误码 → 文本正则（先 failover 后 fatal）→ **兜底 failover**，
  即只有被明确归入 `fatal` 的才停止换档。等级随事件下发给编排层（权威来源）。

### Added
- `config.submitFailureGrades`：`{ "<错误码>": "failover"|"fatal"|"interrupted" }`，
  覆盖内置分级（大小写不敏感）。两侧（product-subagents / dsh-agent-dispatch）同名同义。
- `lib/submit-failure.js`：`classifySubmitFailure(code, message, overrides)`，纯函数、无依赖。
- `test/submit-failover.test.js`（12 例）：分级的真值表（含 `insufficient_quota` /
  `余额不足` / `overloaded` / 401 / 403 / schema / 模型不存在 / 余额不足 等边界）+
  换档握手的 5 条行为断言（无处理器抛裸错 / 空正文成功返回新档答案 / 429 成功返回 /
  链耗尽抛自解释汇总 / fatal 不调处理器且原样透出原始错误码 / 处理器抛错回落到原错误）。

### Compatibility
- 向后兼容：未登记 `onFailover` 的监听方（旧版 dsh-agent-dispatch）行为**逐字不变**——
  照原样抛错，`submit-failed` 载荷只**新增** `grade` 与 `onFailover` 两个字段。
- `product-subagents` 需要 `dsh-agent-dispatch >= 1.11.22` 才能真正抑制中间态通知；
  反向搭配（本插件新 + 编排层旧）自动退回旧语义，不会出错。

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
