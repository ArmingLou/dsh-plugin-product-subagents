# dsh-plugin-product-subagents

**English** | [简体中文](README.zh.md)

Role-based **Codex / Claude Code / ACP** subagent providers for the DeepSeek
Harness. Turns external agent CLIs into durable, continuable subagents with a
declarative role library, per-role product permissions, delegation with a
permission ceiling, and cross-platform process launching.

## Features

- **Continuable children** — one-shot sync or async continuable (control with
  `send_message`, `list_agents`, `interrupt_agent`; attach synchronously with
  `product_wait`).
- **Session continuity** — a child's remote product session survives idle
  disposal and process restarts (durable registry + log markers; claude/codex
  resume by id, ACP reconnects).
- **Declarative roles** (`roles/*.json`) — `general` (default), `code-review`,
  `explore` (never delegates), `debug`. Delegation defaults ON; a role can ban
  it. Unknown roles fall back to `general`.
- **Two-layer permission model** — the relay model is always a read-only
  pipe; `permissionMode` (`readonly` / `default` / `full`) applies to the
  remote product and is mapped to each product's own CLI flags.
- **Permission ceiling** — a child can never spawn a descendant with more
  permission than it has.
- **Any ACP agent** — add Cursor (`agent acp`), CodeBuddy (`cbc --acp`),
  Gemini (`gemini --acp`) and more via `config.providers`; no code needed.
- **Dynamic model / effort catalog** — each ACP session's `configOptions` is
  captured, kept fresh across `set_config_option` and `config_option_update`,
  published per child as an event, and cached per provider on disk. A value the
  product doesn't advertise falls back to its own default instead of failing the
  turn (see [Model & effort discovery](#model--effort-discovery)).
- **Resource management** — idle disposal, configurable timeouts, concurrency
  cap.
- **Cross-platform** — Windows `.cmd` shims, Windows-safe path escaping;
  CI runs macOS / Ubuntu / Windows.

## Requirements

- A DeepSeek Harness deployment (web profile) running **dsh `0.2.0-rc.1`**
  (the `0.2` line). This release targets the 0.2 subagent/tools seams; on
  dsh `0.1.x` use plugin `0.6.x`.
- At least one product CLI on `PATH` and authenticated: `claude`, `codex`, or
  an ACP CLI (`opencode`, `agent`, `cbc`, …).
- Node ≥ 18.

Verify an installation against the running harness with `npm run check:host`
(see [Host compatibility](#host-compatibility)).

## Install

### Recommended — `dsh plugin add`

```bash
dsh plugin --profile web add dsh-plugin-product-subagents
```

That single command installs the package **and** wires the host-plane row
automatically: the plugin ships a `cordis.patch.yml` declared via
`dsh.bundle` in its `package.json`, so `dsh plugin add` registers it as a
profile layer (no manual `cordis.patch.yml` editing needed). Restart the
harness afterwards so the plugin loads.

To customise the plugin (e.g. add ACP providers), target the `product-subagents`
id in your profile's own `cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: product-subagents
  config:
    idleTimeoutMs: 600000
    providers:
      cursor:    { type: acp, command: agent, args: [acp] }
      codebuddy: { type: acp, command: cbc, args: [--acp] }
```

> **Note:** a config override replaces the row's whole `config` object, so
> restate any keys you wish to keep (like `idleTimeoutMs` above).

### Install via your agent (one line)

Paste this to your DeepSeek Harness agent (or any coding agent with shell
access to the harness home) — it performs every step itself:

> Install the `dsh-plugin-product-subagents` plugin into my DeepSeek Harness
> web profile: run `dsh plugin --profile web add dsh-plugin-product-subagents`,
> then tell me to restart the harness so the plugin loads.

### Manual (advanced)

If you prefer to manage the profile yourself, use pnpm (not npm) inside the
profile directory so peer dependencies are not auto-installed:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-plugin-product-subagents
```

Then add a host-plane row to your profile's `cordis.patch.yml`:

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

## Quick start

In a session, the model has six tools:

| Tool | Purpose |
|---|---|
| `product_delegate` | delegate a task under a role (sync or continuable) |
| `product_roles` | list the role library |
| `product_submit` | per-child bridge (continuable children only) |
| `subagent_progress` | status + internal trace of one child |
| `product_wait` | block until a child settles, return its answer |
| `product_agents` | provider availability + live children |

```
product_delegate role=general task="Refactor demo-project/calc.js and run its tests"
product_wait subagent_id=<childId>
```

## Configuration

```yaml
config:
  providers: { cursor: { type: acp, command: agent, args: [acp] } }
  idleTimeoutMs: 600000       # settled children release their remote session
                              # after this idle period (0 disables)
  maxConcurrentChildren: 8    # cap on simultaneous continuable children
  rolesDir: <path>            # declarative role library (default: roles/)
  registryPath: <path>        # durable remote-session registry
  providerCatalogTtlMs: 86400000   # re-probe a provider once its entry is older than this
  providerProbeOnStart: true  # probe only stale providers at startup (0 cost when fresh)
  providerProbeTimeoutMs: 30000    # hard cap per provider probe, incl. CLI cold start;
                                   # on timeout the child process is SIGKILLed, the entry
                                   # records `error` and no second attempt is made
  # v0.7.3 submit-failure grading. Default (see lib/submit-failure.js):
  #   failover    → the orchestrator may silently switch to the next route
  #   fatal       → no route switch; reported as the final failure
  #   interrupted → a human cancel; neither a product fault nor retried
  # Anything unlisted falls back to `failover`, so only an explicitly `fatal`
  # error stops a route switch.
  submitFailureGrades:
    EMPTY_RESPONSE: failover      # the product answered with no text
    RATE_LIMITED: failover        # 429 / rate limit / quota / insufficient balance
    SUBMIT_TIMEOUT: failover
    INVALID_API_KEY: fatal        # auth: retrying cannot help
    INVALID_ARGUMENT: fatal       # bad request/params: retrying cannot help
    SYNTAX_ERROR: fatal
    MODEL_NOT_FOUND: fatal
    RECONNECT_BLOCKED: fatal
  # v0.7.4 failover hand-off mode. All three modes use a SIBLING replacement
  # (a direct child of the main agent); they differ only in who decides, and when:
  #   notify-then-auto (default) → publish a waking notice + expose agent_failover,
  #                              wait notifyWaitMs; on timeout the orchestrator
  #                              dispatches the sibling replacement itself
  #   notify                   → only wait for the main agent; on timeout the
  #                              submission FAILS (no automatic route switch)
  #   auto                     → no waiting, no notice; switch immediately
  failoverMode: notify-then-auto
  notifyWaitMs: 90000            # how long to wait for the main agent's decision
```

### Submit-failure grading and in-turn failover

`product_submit` classifies every submission failure before rethrowing it, and
publishes the grade on the `product-subagents/submit-failed` event payload
(`grade`). It also exposes `onFailover(handler)` on that payload: a listener may
register a handler **synchronously during the emit**, and `product_submit` then
**blocks on that handler instead of throwing**. That is what keeps a fallback
chain from leaking an intermediate failure to the parent agent — the failing
child's turn is still open, so the host has not settled it yet.

| handler returns | `product_submit` does |
|---|---|
| `{ handedOff: true, nextProvider, newChildId }` | throws `FAILOVER_HANDED_OFF`: this child is done — the orchestrator terminated it and dispatched the **next route as a sibling child of the main agent**. It emits **no** second `submit-failed` (that unknown code would grade as `failover`, re-register `onFailover` and start a second chain — i.e. two subagents on one task) and no `submit-ok` |
| `{ timedOut: true, summary, message }` | throws `FAILOVER_EXHAUSTED` carrying a self-explaining message: which routes were tried, each one's last error, **and why no switch happened** |
| `{ text }` | **legacy** (orchestrator <= 0.7.3): returns `text` as the answer of *this* submission and emits `submit-ok` with `viaFailover: true` |
| `{ exhausted: true, message }` | **legacy**: throws `FAILOVER_EXHAUSTED` carrying the self-explaining `message` |
| throws | logs and falls back to the original submission error — a broken orchestrator is never reported as an exhausted route chain |
| nothing registered | throws the original error, byte-identical to v0.3.7 behaviour |

Handlers are only consulted for `failover`-graded failures; `fatal` and
`interrupted` always throw straight through.

Two invariants worth stating explicitly:

- **The wait is bounded and is not raced against `exec.signal`.** The orchestrator
  owns the authoritative `notifyWaitMs` timer; this plugin additionally arms a
  `notifyWaitMs + 2s` safety net (cleared in a `finally`, so it never holds the host
  process open) purely so a *broken* orchestrator cannot leave `product_submit`
  blocked forever. Aborting is not a valid release: the host scheduler waits for
  in-flight tools even on abort, so an abort signal cannot unblock this tool — only
  the orchestrator redeeming the rendezvous can.
- **`FAILOVER_HANDED_OFF` is graded `interrupted`**, never `failover`. It means
  "a human (the main agent) decided to move this route elsewhere"; treating it as a
  product fault would start a second chain and put two subagents on one task.

The payload now also carries `failoverMode` and `notifyWaitMs`, so the
orchestrator honours this plugin's settings when both are configured.

The catalog path itself is **not configurable**: `provider-catalog.json` is a
cross-plugin contract and consumers read the fixed
`$DSH_HOME/data/dsh-plugin-product-subagents/provider-catalog.json`.

## Model & effort discovery

ACP v1 has no `availableModels` / `session/set_model`: the only portable source
for a session's models and reasoning levels is its `configOptions` (carried by
the `session/new|load|resume` response, every `session/set_config_option`
response, and every `config_option_update` notification). The option **ids are
product-defined** — this plugin resolves them as *exact id first, `category` as
fallback*, and never hard-codes one. A value is applied through
`session/set_config_option`, whose response is written back to the cached
snapshot (effort levels depend on the selected model; dropping that response
is what makes the pair go stale).

**A wrong value never breaks a turn.** A hand-edited `agents.json` model or
effort the product can't honour falls back to the agent's own default: empty or
`default` means "unspecified" (no call), a value outside the advertised
`options[].value` domain is not sent at all, a missing option is skipped, and a
rejection from the product is caught — the session keeps its current value and
`product_submit` completes normally either way. Every such attempt publishes
`product-subagents/config-option-error` `{…, kind, requested, optionId,
effective, available[], reason, error, configOptions, at}` where `reason` is
`no-option | not-in-values | rejected` and `effective` is the value that
actually applies. `console.warn` dedupes per `(kind, value)`; the event fires
on every turn so dispatch logs can answer "why didn't X take effect".

Consumers get two surfaces:

- **Events** — `product-subagents/config-options`
  `{childId, product, remoteSessionId, configOptions, at}` per child (emitted on
  bind, on every `config_option_update`, and after a cold resume);
  `product-subagents/config-option-error` for the fallback cases above;
  `product-subagents/provider-catalog-updated`
  `{providers: [name], at}` after each cache write; and the request event
  `product-subagents/probe-provider` `{provider?, cwd?, reason}` (omit
  `provider` to probe every registered ACP provider — failures still publish
  `provider-catalog-updated`).
- **`provider-catalog.json`** — provider-level cache and the cross-plugin data
  plane (events are not forwarded to the GUI). Shape is frozen:

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
    "source": "probe", "probedAt": "<ISO>", "error": "<only when the probe failed>" } } }
```

**`value` vs `name` is the contract**: `value` is what gets persisted and fed to
`session/set_config_option` (e.g. `deveco/GLM-5.1` — verbatim, never rewritten),
`name` is the product's own display label for the GUI (`DevEco Code/GLM-5.1`),
`description` is optional and omitted when absent. Grouped
`SessionConfigSelectGroup[]` options are flattened, and `models` / `efforts`
stay plain string arrays for existing readers — the `*Options` fields are
additive.

The catalog is **read-only with respect to user configuration**: probing never
writes `agents.json` or "corrects" a stored model, and an empty list means "this
probe failed" (`error` is set), never "this product has no models".

`modelEfforts` appears only when the product itself groups effort values by
model id; it is omitted rather than guessed. Failed probes store `models: []`
plus `error` instead of throwing.

Semantics worth knowing:

- `efforts` is the value domain **under the model that was current at probe
  time** (when the product groups efforts by model, the group of
  `models[current]` is used — never the cross-model union). The authoritative
  linked snapshot is the per-child `config-options` event.
- The TTL gates the **startup pre-probe only**. `probe-provider` always
  re-probes — a GUI "refresh" button must not be swallowed by a fresh cache
  entry, including a fresh *failed* one.

## Roles and permissions

Each role file:

```json
{
  "id": "code-review",
  "description": "Review code for bugs, security, maintainability (read-only).",
  "provider": "claude-code",
  "permissionMode": "readonly",
  "allowDelegation": true,
  "instructions": "You are a code reviewer. READ-ONLY: never modify files. …"
}
```

- `permissionMode` maps to product flags: `readonly` (claude
  `--permission-mode plan` / codex `--sandbox read-only`), `full` (claude
  `--dangerously-skip-permissions` / codex
  `--dangerously-bypass-approvals-and-sandbox`).
- **The relay model never gets write-capable tools**, in every role.
- **Delegation is capped**: `readonly < default < full`; a child cannot spawn
  a descendant with a higher mode.

## Custom ACP providers

`config.providers` accepts any ACP-capable CLI — the generic bridge handles a
persistent process, `session/load` resume, and dead-process reconnect:

```yaml
providers:
  cursor:    { type: acp, command: agent, args: [acp] }    # Cursor CLI
  codebuddy: { type: acp, command: cbc, args: [--acp] }    # CodeBuddy
  gemini:    { type: acp, command: gemini, args: [--acp] } # Gemini CLI
  opencode:  { type: acp, command: opencode, args: [acp] } # opencode
```

Providers appear in the delegation enum only when their command is detected
on `PATH`. Built-ins (`claude-code`, `codex`, `acp`) can be overridden with
the same keys.

## Host compatibility

This plugin tracks a DSH generation: **dsh `0.2.x`** (peer
`@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-tools` `~0.2.0-rc.1`). DSH
refuses to load a plugin whose `@deepseek-ai/dsh*` peer ranges do not satisfy
the *running* version, so a harness upgrade disables an un-updated plugin —
pair them as follows:

| dsh runtime | plugin |
| --- | --- |
| `0.2.x` | `0.7.x` (this release) |
| `0.1.x` | `0.6.x` |

After upgrading dsh, verify an installation against the running harness:

```bash
npm run check:host
# or point it at a specific install:
DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run check:host
```

It runs the host's **own** compatibility predicate against this `package.json`,
checks the `ctx.subagents` and session seams this plugin uses, and registers
all six plugin tools through the runtime's `defineTool`. Two seams it guards
specifically: `Session.snapshotEvents()` (the log reader behind cold-resume
recovery) and `ctx.subagents.listChildren()` entries (dsh 0.2 dropped their
`activity` / `hasChildren` fields; `lib/host-compat.js` derives them locally
with the host's own residency rule).

## Development

```bash
npm install
npm test        # node:test — pure logic + fake bridge, no CLIs or keys
npm run lint    # syntax-check every module
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the bridge contract, the
permission model, and how to add products. CI runs the suite on macOS /
Ubuntu / Windows × Node 18/20/22.

> **Smoke-testing a freeze tarball:** the frozen delivery archive does **not** contain
> `node_modules`. Unpacking it and running `node --test` there fails with missing
> dependencies (`195/16` — no `@agentclientprotocol/sdk` / `zod`); either point the
> unpacked copy at this repo's `node_modules`
> (`ln -s <repo>/node_modules <unpacked>/node_modules`) or run the suite inside the repo.

## Security

This is a **configuration-as-trust-boundary** tool: it spawns whatever CLIs
you configure, and `full` passes the products' own "bypass all permission
checks" flags. See [SECURITY.md](SECURITY.md).

## License

MIT
