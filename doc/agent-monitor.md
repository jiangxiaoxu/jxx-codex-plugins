# Agent Monitor

Agent Monitor is a local, read-only Codex MCP App. It monitors only uncompressed `.jsonl` rollouts on the current host and displays output speed by model, root conversations, subagents, token usage, recorded acceleration modes and daily usage history. Compressed threads are excluded. The global and thread entrypoints open the same dashboard.

## Source map

| Path | Responsibility |
| --- | --- |
| `plugins/agent-monitor/src/monitor/` | Rollout discovery, incremental parsing, metric aggregation and local history. |
| `plugins/agent-monitor/src/server.mjs` | Read-only MCP tools and the `ui://agent-monitor/dashboard` resource. |
| `plugins/agent-monitor/src/main.mjs` | Stdio process lifecycle and runtime paths. |
| `plugins/agent-monitor/src/diagnostics.mjs` | Structured local diagnostic events, sensitive-field filtering and log rotation. |
| `plugins/agent-monitor/ui/` | Compact MCP App, visible-only refresh and stable scrolling lists. |
| `plugins/agent-monitor/scripts/` | Deterministic bundling and package validation. |
| `plugins/agent-monitor/tests/` | Metric invariants, UI state and MCP integration. |
| `plugins/agent-monitor/dist/` | Tracked runtime server and self-contained dashboard. |

## Runtime

Node.js 24 or later is required on the plugin's execution host. The generated runtime is bundled; installing npm dependencies on that host is unnecessary.

- `CODEX_HOME` selects the Codex home. The default is `~/.codex`.
- `AGENT_MONITOR_STATE_DIR` selects plugin-owned persistent history. The default is `~/.local/state/agent-monitor`.
- `AGENT_MONITOR_LOG_LEVEL` selects `debug`, `info`, `warn` or `error`. The default is `info`; `debug` additionally records collection cycles, file reads and MCP request timings.
- Codex rollout files are read only. Plugin state is written only under the configured state directory.
- The UI uses the MCP bridge. It does not open a localhost HTTP port or send conversation data to a remote service.

## Metrics and evidence

Measured output TPS uses completed model requests and their elapsed request duration, including time to first token. Streaming estimates are separate and are not exact per-token measurements. With no suitable completed sample, the plugin does not invent an estimate.

The aggregate window is three seconds. All totals and model contributions share the same window. Each response belongs to one agent, and descendants contribute exactly once to root and host totals. Output token counts already include reasoning; the reasoning breakdown must not be added again.

Agent curves retain up to 300 one-second samples. Long-term history exposes daily aggregates from stored response-level metric facts, not arbitrary historical second-by-second replay. `.jsonl.zst` files are not opened, decompressed or backfilled. Older compressed or deleted logs therefore make history incomplete. Previously stored metric facts are retained; existing data is not deleted when a rollout becomes compressed.

The data source is Codex rollout metadata, not privileged access to the running desktop client. Activity phases inferred from logs are identified as such. Unread state and authoritative app-server runtime status are unavailable unless a separate supported source supplies them; the plugin does not fabricate those states.

`service_tier` evidence is scoped to each agent. `priority` is displayed as Fast, `default` as Standard, and `ultrafast` as Ultrafast. Configuration defaults, selected settings, and recorded request values are distinct evidence. None proves which tier the backend served. Missing evidence is unknown, and reasoning effort is not an acceleration mode.

Only structured usage and session metadata are retained. Prompts, assistant text, tool output and credentials are not exported. Missing thread titles use stable identifiers rather than user message content.

## Data API

All data responses use MCP `structuredContent`. The model-visible `monitor_open` opens the App and returns its initial snapshot; the App queries the remaining read-only tools directly.

| Tool | Data |
| --- | --- |
| `monitor_snapshot` | Host-wide totals and model contributions, plus a cursor page of root conversations. `order` is `priority` or `recent`; `scope` is `all` or `active`. |
| `monitor_thread` | Root conversation summary and a cursor page of agents. Requires `threadId`; `scope` is `all`, `active`, or `completed`. |
| `monitor_agent` | One agent's metadata, own token totals, rate evidence and recent curve. Requires `agentId`. |
| `monitor_history` | Daily aggregates for `from` through `to`, using host-local `YYYY-MM-DD` dates. Defaults to the last seven days. |
| `monitor_diagnostics` | Current plugin version, local log path, log level and up to 100 recent sanitized service events. |

List requests accept `limit` from 1 through 100 and an opaque `cursor`. List filtering and loading fewer rows do not change host-wide totals. `tokens.output` includes `tokens.reasoning`; the latter is a breakdown. Rates expose `measuredTps`, `estimatedTps` and their sum `outputTps` separately.

Collection scans new rollout locations and default mode configuration every ten seconds and reads appended records every second. A generating/tool phase without new evidence for 300 seconds becomes unknown. Those intervals describe log collection, not authoritative process liveness.

`sampledAt` anchors the query's rate window; `collection.lastSuccessAt` is the last successfully completed reader cycle. A query returning a new timestamp does not prove that collection advanced. `collection.skippedCompressedFiles` reports excluded files without opening them.

## UI behavior

The top overview covers the current execution host independently of the selected or visible rows. Root conversations occupy the top-level list; descendants are shown within their root. Priority groups follow the View activity pattern where evidence exists. Recent ordering uses session recency metadata. Existing row order and selected details remain stable during live updates.

Lists use bounded scrolling regions and cursor-based incremental loading rather than page buttons. While visible, the dashboard requests fresh metrics automatically every second. Hidden views stop both metric requests and the UI freshness timer; an already-sent request may finish, but hidden views do not continue the next page or detail request.

MCP discovery and resource reads only register the App and serve its files. They do not open the metrics database or scan rollout files. Data requests activate the collector and renew a five-second activity lease. With no further requests, background collection pauses after the current cycle and no later cycle is scheduled. Parsed offsets, metadata and the database remain cached for resume. Diagnostics requests alone do not activate collection. The subprocess remains available for MCP; paused does not mean that Codex has unloaded the plugin.

Disconnected, failed, initial-scanning or stale samples do not replace a valid reading with zero. The UI retains the last trusted values with an expired/retrying indication. Before any trusted sample exists it displays `-`. A fresh successful sample restores the live view, including genuine zero readings. Reader freshness uses server-relative timestamps plus elapsed UI time so remote clock offsets are not treated as failure.

## Diagnostics

Open the dashboard's diagnostics view to inspect the service log path, recent backend events and recent UI failures. UI failures are retained locally while the MCP connection is unavailable; they are not recursively sent over the failed connection.

Logs are JSONL under `<AGENT_MONITOR_STATE_DIR>/logs/`, with one filename family per process. Each file is limited to 5 MiB and each family keeps three files. Service startup/initialization/closure, entrypoint/resource reads, scan summaries, read failures and recovery are recorded at the default level. Set `AGENT_MONITOR_LOG_LEVEL=debug` in the normal execution environment for cycle and request-level detail. Warnings and errors also go to stderr for the host's MCP diagnostics; stdout remains reserved for the protocol.

Logs contain version, process ID, timestamps, event names, durations, source filenames and structured error metadata. Conversation bodies, tool arguments/results and credentials are excluded. A failure to write the log does not terminate monitoring; recent sanitized events remain available from the diagnostics API.

## Remote scope

A remote-host plugin process reads that host's `CODEX_HOME`. A local process does not automatically see logs from other Codex hosts. The plugin cannot switch the host of an existing MCP App frame. Its UI makes the current host explicit; a multi-host sidebar aggregator is outside this version.

## Validation

From `plugins/agent-monitor`:

```text
npm ci
npm run build
npm test
npm run check:dist
npm run validate
npm pack --dry-run --json
```

`build` writes tracked `dist/` artifacts. `check:dist` compares those artifacts with current source without rewriting them. Protocol validation runs against local in-memory transports, without installing or loading the plugin in Codex.

The measurement design references [Agent Speed](https://github.com/zoefix/agent-speed), especially its Codex parser and measurement specification. The monitor is a focused implementation; it does not run or bundle the Agent Speed desktop application.
