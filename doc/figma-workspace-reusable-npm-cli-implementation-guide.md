# Reusable npm CLI Implementation Guide

## Purpose

本文从 `figma-workspace` 和 CthulhuGame Editor automation CLI 的实际迭代中提炼一套可迁移的 npm CLI 实现方法. 目标读者是需要为其他仓库设计, 重构或验收 agent-facing / automation-facing CLI 的维护者.

本指南描述稳定的 contract boundary, 实施顺序和验证矩阵, 不要求其他仓库照搬 Figma transport, Unreal Editor lifecycle, OAuth, session state 或任何固定阈值.

## Evidence Base

`figma-workspace` 的主要证据面:

- `plugins/figma-workspace/package.json`: public npm command directory.
- `plugins/figma-workspace/scripts/commands/*.mjs`: independent thin executable entrypoints.
- `plugins/figma-workspace/mcp-server/src/cli/figma-command-runtime.ts`: optimized typed command specs, parser, help and transport mapping.
- `plugins/figma-workspace/mcp-server/src/cli/figma-workspace-cli.ts`: complete transport CLI, Restricted Markdown, state, sidecar and exit behavior.
- `plugins/figma-workspace/tests/server.test.mjs`: plugin-root command, package and pack/install contract.
- `plugins/figma-workspace/mcp-server/tests/figma-command-runtime.test.mjs`: optimized command mapping and help contract.
- `plugins/figma-workspace/mcp-server/tests/build-output.test.mjs`: built CLI, output, sidecar, state and concurrency contract.

CthulhuGame Editor automation CLI 提供了另一组已验证经验: structured help defaults, option/positional order independence, strict integer parsing, canonical result envelope, observation exit semantics, total deadlines, opaque log cursors, bounded workflow streaming, project-operation locks, all-entrypoint help smoke 和 documentation routing validation.

## First Principle: Decide The Public Contract Before The Parser

不要从 `process.argv` 分支开始设计 CLI. 先锁定以下决策:

| Decision | Questions |
| --- | --- |
| Consumer | Human, shell script, AI agent, CI, or several of them? |
| Output | Restricted Markdown, JSON, JSONL, or another single declared format? |
| Failure | Which failures are usage, domain, configuration, transport, file I/O, timeout, or interrupt? |
| State | Stateless, persisted local state, remote session, or long-running action? |
| Result size | Can complete output always remain inline? If not, how is it recovered? |
| Compatibility | Is the next change breaking, deprecated, or backward compatible? |
| Distribution | Run source directly, build before use, or ship checked-in generated output? |

一个 command 在 help, parser, runtime, formatter, tests 和 docs 中必须表达同一 contract. 如果这些决策尚未完成, 先写 decision table 和 acceptance tests, 不要补 compatibility wrapper 掩盖不确定性.

## Recommended Architecture

### Public npm directory

将 `package.json` scripts 视为 public command index. 每个公开 command 对应一个可直接执行的 entrypoint:

```json
{
  "scripts": {
    "tool": "node scripts/commands/tool.mjs",
    "tool:search": "node scripts/commands/tool-search.mjs",
    "tool:run": "node scripts/commands/tool-run.mjs"
  }
}
```

entrypoint 只固定 command name 或 mode, 然后调用共享 runtime:

```js
import { runToolCommand } from "../../dist/cli/tool-command-runtime.js";

process.exitCode = await runToolCommand("search", process.argv.slice(2));
```

不要把 parser, validation, output formatting 或业务逻辑复制进 entrypoint. 也不要依赖 npm script 拼接复杂 subcommand 字符串来形成 public alias; 独立 entrypoint 更容易测试, 打包和发现.

### One typed command registry

command name, purpose, positional parameters, options, defaults, examples and transport mapping 应由一个 typed registry 管理:

```ts
interface CommandSpec {
  readonly name: string;
  readonly purpose: string;
  readonly positionals: readonly PositionalSpec[];
  readonly options: Readonly<Record<`--${string}`, OptionSpec>>;
  readonly examples: readonly string[];
}
```

registry 应同时驱动:

- parser allowlist 和 value validation.
- command-specific `--help`.
- optimized input 到 runtime input 的 mapping.
- package script / entrypoint consistency tests.
- removed option negative tests.

这里的 registry 应只描述 public command namespace. Login, cache inspection, corpus refresh, build, test 和其他 maintenance scripts 不属于 public command registry, 不应被 public wrapper 集合校验误收录.

避免用 README 或 skill Markdown 作为参数 schema. 文档只总结 command selection 和稳定 workflow; CLI help 与 runtime schema 才是参数真相源.

### Optional two-layer CLI

只有在底层 transport 需要完整 JSON schema, 而上层用户需要任务形状参数时, 才引入两层 CLI:

```text
task-shaped command
  -> typed parser and mapper
  -> canonical JSON transport command
  -> runtime / remote transport
```

`figma-workspace` 使用这一模式:

- direct commands 将 positional/options 组装成 JSON input.
- complex commands 只暴露 `--input <json-file|->` 等少量 escape-hatch options.
- public wrapper help 直接呈现完整 input schema; raw transport 只保留内部执行和显式 debug 能力.

普通单层 CLI 不需要为了“架构整齐”而增加 transport layer. 只有当它隔离稳定边界, 复用真实逻辑或保留完整低层能力时才值得存在.

## Parser Contract

### Single scan

推荐对 argv 单次扫描:

1. option token 立即消费其 value.
2. 非 option token 加入 positional list.
3. 精确 token `--` 后全部视为 positional, 包括 `-h` 和 `--help`; option-only command 则不接受 positional separator payload.
4. 扫描结束后校验 positional arity 和 required fields.

这样 options 与 positionals 可以任意顺序, 并避免 parser 假定 `argv[0]` 一定是 positional.

### Strict values

- Unknown option 必须失败, 不得 silent ignore.
- Scalar option 重复必须失败; repeatable option 必须在 help 中明确.
- Integer 使用严格 decimal grammar, 再检查 safe integer 和 min/max. 不接受 `1.0`, `1e3`, `+1`, 空字符串或隐式 floor.
- Enum 使用 exact normalized allowlist, 不做不可见 fallback.
- Required value 缺失时必须在任何 I/O 或 runtime mutation 前失败.
- Help token 应在 runtime validation 和文件读取前生效, 但普通 positional value `help` 不应被误判为 help command.
- Removed option 应明确返回 usage failure; 不保留 hidden alias.

### Usage behavior

推荐 usage error 使用 exit `2`, stderr 输出短错误和 command-specific help. `--help` / `-h` 使用 stdout 且 exit `0`.

如果仓库采用其他 exit taxonomy, 应在 public contract 中固定并测试, 而不是让每个 command 自行选择.

## Help Is Executable Contract

每个 public option 必须声明 omitted state, 例如:

- `Default: 100`.
- `Default: disabled`.
- `Default: unset; no filter is applied`.
- `Default: automatic from project configuration`.
- `Default: required`.
- `Default: fixed internally at 250ms; not configurable`.

help 至少包含:

```text
# tool search help
## Purpose
## Usage
## Arguments
## Options
## Examples
## Exit Codes
```

结构可以按项目裁剪, 但 parser allowlist, default behavior 和 help 文案必须由测试证明一致. 所有 independent entrypoint 都应执行 `--help` smoke, 并验证 help 不进入 runtime, 不读取 input file, 不创建 state, 不连接 remote service.

当 public JSON command 只接受 `--input <json-file|->` 时, help 仍应内联完整 input schema. 不要要求 agent 切换到 raw transport command 才能发现字段. `--input -` 必须通过 canonical 和 independent npm entrypoint 的真实 process 测试, 包括 npm 转发产生的孤立 `-` 和 duplicate input rejection.

## Stdout, Stderr And Exit Codes

### Choose one stdout grammar

不要同时支持未经设计的 Markdown 和 JSON stdout. 根据 consumer 选择一种:

- JSON 适合传统 machine consumer.
- Restricted Markdown 适合 agent/human 共用, 但必须限制 grammar.
- JSONL 只适合真正的 event stream, 不能作为随手增加的 compatibility mode.

Restricted Markdown 可限定为:

- headings.
- `Field: value` scalar lines.
- bullets.
- text/code fences.
- 针对已知 nested records 的显式 renderer.

不要让 npm lifecycle banner, debug log 或 progress text 混入 stdout. 使用 `npm --silent`, project `.npmrc`, 或等价机制, 并在 packed artifact 中重新验证.

### Stable presentation projection

可以在 backend-specific result 与 formatter 之间建立 typed presentation projection, 但不要为了统一 status 而重写 backend payload 或 sidecar. Projection 可以只负责 status, exit code, error 摘要和 warnings, 同时让 formatter 与 recovery sidecar 保留原始 backend 字段. 如果项目确实需要跨 backend 的 canonical envelope, 再将其作为单独的 public compatibility decision.

例如一个更强的 canonical envelope 可以是:

```ts
interface CliResult<T> {
  readonly success: boolean;
  readonly status: "ok" | "invalid" | "not-found" | "failed" | "missing" | "not-ready";
  readonly input: Readonly<Record<string, unknown>>;
  readonly data: T | null;
  readonly error: null | {
    readonly type: string;
    readonly code: string | number;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly warnings: readonly string[];
}
```

无论采用轻量 projection 还是 canonical envelope, formatter 都不应在多处猜测 `ok`, `found`, string error 或 legacy aliases. 保留底层稳定 `error.code`, 不在 catch 中全部压平为 generic failure.

### Observation is not mutation

status/inspect/doctor 命令完成观察后通常应 exit `0`, 即使被观察对象是 missing, not-ready 或 unhealthy. 这些是 data states, 不是 inspection failure.

真正的 I/O, configuration 或 transport failure 才使用 nonzero. 这能避免 CI 和 agent 将“服务尚未运行”误判为 CLI 自身损坏.

### Interrupts and deadlines

长运行 command 使用 monotonic total deadline, 而不是每次 poll 重置 timeout:

```text
remaining = totalDeadline - elapsed
perCallTimeout = min(remaining, transportMaximum)
```

delay 应响应 `AbortSignal` 和 Ctrl+C. 如果 runtime 支持 cooperative cancel, timeout/interrupt 后先发送 cancel, 再用有界 cleanup deadline 等待 terminal acknowledgement. Ctrl+C 通常使用 exit `130`.

idle deadline 只适用于可以可靠观察 activity 的 transport, 例如 HTTP/body stream 或 subprocess I/O. 对没有 progress signal 的 opaque remote RPC, 不要把无响应误判为 idle; 只执行 monotonic total deadline.

## Large Results And Sidecars

当 complete result 可能超过稳定 inline budget 时:

1. 用 UTF-8 byte count, 不用 JavaScript string length.
2. 明确 budget 作用于 rendered output 还是 serialized JSON.
3. exact boundary 必须有测试.
4. 超限后写 complete result sidecar; stdout 只返回 file path, size, omitted metadata 和恢复说明.
5. sidecar 使用同目录 temporary file + atomic rename.
6. `0` 可以定义为 always spill, 便于 machine consumer 获得完整 JSON.
7. sidecar path 必须经过集中路径解析, 并有 retention, cleanup, permission 和 secret policy.
8. 如果 remote mutation 已确认成功而本地 state/sidecar/lock 后处理失败, 保留已知业务结果和明确的 non-retry guidance, 不要用 generic failure 覆盖它.

不要只截断 stdout 而丢失完整数据. 也不要把巨大 JSON blob 包在 Markdown fence 中绕过 budget.

对于 event stream, prefix/rolling contract 必须明确. 如果选择 deterministic prefix, 首次越界后只输出一次 notice, 逻辑 cursor 和 seen/dropped counts 仍继续推进, terminal result 不重复完整 stream.

## State, Files And Concurrency

只有需要跨进程恢复时才引入 state file. Stateless search/help/doctor 不应为了统一接口而承担锁和写回开销.

state path resolution 应集中定义优先级:

```text
explicit CLI path -> environment -> project-local default
```

持久化要求:

- parse 后严格验证 schema.
- schema 需要显式版本, 并明确旧结构是 migrate, reject, 还是只读诊断.
- write to sibling temp file, fsync when durability matters, then atomic rename.
- managed root, ancestor 和 target 的 link/reparse-point policy 必须集中验证, 不能只靠 lexical path normalization.
- lock owner 使用 unique owner id, 不只依赖 PID.
- heartbeat 固定且内部化, 除非用户确实需要公开调节.
- force recovery 只回收 malformed, ownerless 或确认 dead owner 的 lock.
- release 前验证 ownership, 避免删除后来者 lock.

本地 `open(..., "wx")`, mtime heartbeat 和 PID liveness 不是 distributed lock. 网络盘, 容器共享卷和跨主机需要单独设计与验证.

## Source, Build And Distribution

### Source-first change order

推荐顺序:

1. canonical types, schemas and registry.
2. parser/runtime implementation.
3. focused unit/contract tests.
4. generated output.
5. independent entrypoints and `package.json`.
6. skill, README and maintenance docs.

如果 entrypoint import checked-in `dist`, source, dist, wrappers 和 package allowlist 是同一个 release unit. CI 应执行 build 后确认没有 unexpected diff, 或在 pack/install smoke 中验证构建产物真实可用.

是否提交 generated output 取决于发布模型. 普通源码仓库不必照搬 plugin 的 checked-in `dist`.

### Avoid multi-point drift

command registry, transport command list, wrappers 和 npm scripts 很容易形成多点同步. 优先从单一 registry 生成 wrappers/scripts; 如果暂不生成, 至少增加集合一致性断言:

- registry command names == expected public package scripts.
- every script target exists.
- every entrypoint delegates to the shared runtime.
- transport names == dispatch implementation names.
- packed files include every runtime target.

## Test Matrix

### Parser and help

- All entrypoints `-h` and `--help` exit `0` without runtime calls.
- Options before/after positionals produce equivalent input.
- `--` behavior is fixed.
- Unknown, duplicate, removed and missing-value options exit usage.
- Integer exact, boundary, overflow, fraction and scientific cases.
- Every option exposes accurate default/required/unset state.

### Output and exit behavior

- stdout contains only the declared grammar.
- stderr owns usage and thrown failures.
- success, domain failure, observation state, configuration, transport, file I/O, timeout and interrupt mappings.
- Dynamic labels and values sanitize control characters.
- Input summaries do not echo secrets, base64 or huge source text.
- npm source invocation and packed invocation both remain banner-free.

### Sidecar and state

- below, exact and above UTF-8 byte threshold.
- override precedence, maximum and `0` always-spill.
- sidecar is complete JSON and recoverable from stdout metadata.
- default, environment and explicit state paths.
- relative path resolution from documented cwd.
- concurrent writers, live lock refusal, dead/malformed recovery and ownership-safe release.
- atomic write or rename failure preserves any prior target, removes temporary files and returns no partial sidecar metadata.
- failure after partial mutation still persists recoverable state only when the domain requires it.

### Build and package

- typecheck.
- source build.
- unit and contract tests.
- generated output synchronization.
- `npm pack --dry-run --json` file allowlist.
- extract packed artifact and run representative help/result commands.
- `git diff --check`.

## Migration Plan For An Existing CLI

### Phase 1: Inventory

- Enumerate every public npm script, entrypoint, option, positional, environment variable, output mode, exit code and file side effect.
- Search docs, CI, skills and examples for real callers.
- Record dirty-worktree baseline before mechanical changes.

### Phase 2: Lock decisions

- Create a command matrix with retained/removed parameters and omitted states.
- Choose stdout grammar and either a lightweight presentation projection or a canonical public result envelope.
- Define usage/domain/observation/interrupt semantics.
- Decide state, deadline and sidecar policies.

### Phase 3: Stabilize parser and help

- Introduce typed command specs and shared strict scanner.
- Make removed options fail before runtime.
- Add table-driven help/default/parser tests.

### Phase 4: Normalize runtime boundaries

- Add the selected backend-to-presentation or backend-to-canonical projection.
- Centralize paths, state, errors and time budgets.
- Implement sidecar, lock or polling only when required by the domain.

### Phase 5: Thin entrypoints and packaging

- Move public commands to independent thin executables.
- Align package scripts and registry.
- Rebuild generated output and validate packed contents.

### Phase 6: Migrate callers and docs

- Replace removed options and legacy result fields repository-wide.
- Update concise user/agent routing docs after help and tests are stable.
- Do not preserve hidden aliases unless compatibility is an explicit product requirement.

For project-specific `figma-workspace` architecture, release, and validation rules, see [Figma Workspace AI Agent Development](figma-workspace-ai-agent-development.md). Keep this guide generic rather than duplicating a current plugin's contract.

## What Not To Copy

- 不要把 Figma remote MCP, OAuth bridge 或 `.figma.ts` workflow 当作 npm CLI 通用依赖.
- 不要把 Unreal Editor IPC, Live Coding, workflow poll 或 `0/10-19/130` exit table 当作通用 taxonomy.
- 不要无条件采用 4096, 10000, 12288 等项目阈值; budget 必须从 consumer 和 transport constraint 推导.
- 不要为了“兼容”同时保留 JSON stdout 和 Markdown stdout.
- 不要为 stateless command 增加 state file 和 lock.
- 不要把 checked-in `dist` 当成所有仓库的最佳实践.

## Release Checklist

- [ ] Public command matrix and breaking decisions are explicit.
- [ ] Every npm public script maps to one executable thin entrypoint.
- [ ] Registry, parser, help, runtime and docs describe the same command surface.
- [ ] All options define type, repeatability, range and omitted/default state.
- [ ] Unknown, duplicate, removed and invalid values fail before side effects.
- [ ] stdout, stderr and exit semantics are contract-tested.
- [ ] Observation states are not confused with inspection failures.
- [ ] Deadlines are total and interruptible when the command is long-running.
- [ ] Large results remain completely recoverable through tested sidecars.
- [ ] State writes and locks are atomic and ownership-safe when state exists.
- [ ] Remote-success/local-persistence failure retains the known operation outcome and blocks blind mutation replay.
- [ ] Source, generated output, wrappers and package files are synchronized.
- [ ] All entrypoints pass help smoke and representative runtime tests.
- [ ] Packed artifact behavior matches source-tree behavior.
- [ ] User/agent docs remain routing summaries, not a second parameter schema.
- [ ] `git diff --check` passes.
