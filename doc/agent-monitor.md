# Agent Monitor

Agent Monitor is a local Codex MCP App that sends only read-only data requests to an existing Codex daemon. It monitors Working and Ready threads with available uncompressed `.jsonl` rollouts, displaying output speed by model, root conversations, subagents, recorded token usage, acceleration evidence and daily usage history. Needs you, Inactive, compressed and unavailable-log threads are excluded. The global and thread entrypoints open the same dashboard.

Version 0.1.4 adds a global rate chart, model and service-tier counts, smoother displayed rates and a process-local background collection switch. The dashboard refreshes more frequently while visible, and chart samples remain unsmoothed.

For the previous 0.1.2 baseline, verification evidence and cross-machine continuation checklist, see the [2026-10-30 handoff](agent-monitor-handoff.md).

## Source map

| Path | Responsibility |
| --- | --- |
| `plugins/agent-monitor/src/monitor/runtime.mjs` | Existing-daemon observer, loaded-ID catalog, read-only path prefilter and projected thread metadata. |
| `plugins/agent-monitor/src/monitor/` | Candidate rollout parsing, metric aggregation and local history. |
| `plugins/agent-monitor/src/server.mjs` | Read-only MCP tools and the `ui://agent-monitor/dashboard` resource. |
| `plugins/agent-monitor/src/main.mjs` | Stdio process lifecycle and runtime paths. |
| `plugins/agent-monitor/src/diagnostics.mjs` | Structured local diagnostic events, sensitive-field filtering and log rotation. |
| `plugins/agent-monitor/ui/` | Compact MCP App, visible-only refresh and stable scrolling lists. |
| `plugins/agent-monitor/scripts/` | Deterministic bundling and package validation. |
| `plugins/agent-monitor/tests/` | Metric invariants, UI state and MCP integration. |
| `plugins/agent-monitor/dist/` | Tracked runtime server and self-contained dashboard. |

## Runtime

Node.js 24 or later is required on the plugin's execution host. The generated runtime is bundled; installing npm dependencies on that host is unnecessary.

The observer integration is verified against Codex 0.166.0. An existing daemon with `codex app-server proxy` support is required. Starting a separate app-server process cannot expose another process's loaded threads. An unavailable daemon is reported as unavailable; recently modified files are not silently treated as Ready.

- `CODEX_HOME` selects the Codex home. The default is `~/.codex`.
- `AGENT_MONITOR_STATE_DIR` selects plugin-owned persistent history. The default is `<CODEX_HOME>/state/agent-monitor`.
- On first collection, if the default database does not exist, an existing `~/.local/state/agent-monitor/metrics.sqlite` is copied as a SQLite snapshot, including committed WAL data. The old directory remains in place; old-version writes after that snapshot are not automatically merged. An existing destination database is not overwritten. Explicit `AGENT_MONITOR_STATE_DIR` disables this migration.
- `AGENT_MONITOR_LOG_LEVEL` selects `debug`, `info`, `warn` or `error`. The default is `info`; `debug` additionally records collection cycles, file reads and MCP request timings.
- `AGENT_MONITOR_CODEX_BIN` optionally selects the native Codex executable. Otherwise the daemon's managed `packages/app-server-daemon/current/bin/codex[.exe]` is preferred, followed by `codex` on PATH. On Windows, an npm `.cmd` shim is not a native executable.
- `AGENT_MONITOR_APP_SERVER_SOCKET` optionally selects the existing control socket. The default is `<CODEX_HOME>/app-server-control/app-server-control.sock`.
- `AGENT_MONITOR_STATE_DB` optionally selects the read-only Codex metadata database. The default is `<CODEX_HOME>/state_5.sqlite` for the verified daemon version. Its private schema and the thread path field are version-dependent.
- Codex rollout files are read only. Plugin state is written only under the configured state directory.
- The UI uses the MCP bridge. It does not open a localhost HTTP port or send conversation data to a remote service.

## Metrics and evidence

Measured output TPS uses completed model requests and their elapsed request duration, including time to first token. Streaming estimates are separate and are not exact per-token measurements. With no suitable completed sample, the plugin does not invent an estimate.

The daemon's model and reasoning effort describe current configuration, not a model execution result. Working requests prefer their recorded turn-context model and effort. Separately exposed configured values may already describe the next turn. A configuration change does not move an existing request's estimate to the new model, and estimates require samples for the applicable model.

The aggregate window is three seconds. All totals and model contributions share the same window. Each response belongs to one agent, and descendants contribute exactly once to root and monitored-set totals. Loaded `sessionId` supplies the actual root identity, so an unloaded intermediate parent does not split a surviving descendant into another group. Output token counts already include reasoning; the reasoning breakdown must not be added again.

Agent curves retain up to 300 one-second samples. Long-term history exposes daily aggregates from stored response-level metric facts, not arbitrary historical second-by-second replay. `.jsonl.zst` files are not opened, decompressed or backfilled. Older compressed or deleted logs therefore make history incomplete. Previously stored metric facts are retained; existing data is not deleted when a rollout becomes compressed.

Working and Ready follow the CLI command center: `Active` without `waitingOnApproval` or `waitingOnUserInput` is Working, and loaded `Idle` is Ready. Recency comes from the daemon's `recencyAt`, rather than a new assistant output record. Log-derived generating/tool phases remain separate. A root group is Working when any monitored member is Working. Counts describe monitorable groups and can differ from the CLI when paths are compressed, missing or unavailable.

The backend spawns only `codex app-server proxy`, forwarding WebSocket bytes to the existing control socket. It never starts, resumes or subscribes to a thread. Requests are restricted to `initialize`, `thread/loaded/list` and `thread/read(includeTurns:false)`. Metadata reads can internally read rollout headers, so the observer first queries only loaded IDs' paths from Codex's read-only SQLite database and verifies that a plain JSONL exists. Compressed candidates never receive a metadata-read request. The returned `preview`, turns and other conversation fields are discarded by a metadata allowlist.

Initialization uses the upstream non-originating helper name `codex-backend`, title `Agent Monitor`, and no experimental, approval or OAuth capabilities. This avoids replacing the shared daemon's global originator, user-agent suffix or automatic-login policy. It still creates a normal observer connection and ordinary initialization telemetry.

`service_tier` evidence is scoped to each agent. `priority` is displayed as Fast, `default` as Standard, and `ultrafast` as Ultrafast. Configuration defaults, selected settings, and recorded request values are distinct evidence. None proves which tier the backend served. Missing evidence is unknown, and reasoning effort is not an acceleration mode.

Only structured usage and session metadata are retained. Prompts, assistant text, tool output and credentials are not exported. Missing thread titles use stable identifiers rather than user message content.

## Data API

All data responses use MCP `structuredContent`. The model-visible `monitor_open` opens the App and returns its initial snapshot; the App calls the remaining tools directly.

| Tool | Data |
| --- | --- |
| `monitor_snapshot` | Monitored-set rates, rate history, model and service-tier counts, plus a cursor page of root conversations. `order` is `recent` (default) or `priority`; `scope` is `all`, `working` or `ready`. Priority puts Working first. |
| `monitor_thread` | Root conversation summary and a cursor page of agents. Requires `threadId`; `scope` is `all`, `working` or `ready`. |
| `monitor_agent` | One agent's metadata, own token totals, rate evidence and recent curve. Requires `agentId`. |
| `monitor_history` | Daily aggregates for `from` through `to`, using host-local `YYYY-MM-DD` dates. Defaults to the last seven days. |
| `monitor_diagnostics` | Current plugin version, local log path, log level and up to 100 recent sanitized service events. |
| `monitor_background` | Set process-local background collection on or off. The switch resets to off when the plugin process restarts. |

List requests accept `limit` from 1 through 100 and an opaque `cursor`. UI filtering and loading fewer rows do not change monitored-set rates. Stored token totals and daily history retain earlier recorded facts, including facts from threads that subsequently leave the monitored set. They are sampled observations, not complete host or thread lifetime usage. `collection.coverage` is `sampled` and `historyComplete` is false. `tokens.output` includes `tokens.reasoning`; the latter is a breakdown. Rates expose `measuredTps`, `estimatedTps` and their sum `outputTps` separately.

Threads and agents that normally leave the monitored set return `thread:null` or `agent:null` with empty detail data. This is not an MCP transport/tool error. The UI removes the vanished selection without invalidating the aggregate snapshot.

Collection reads candidate-file increments with a 100 ms delay after each completed cycle. Cycles do not overlap. The loaded-ID catalog is reconciled at most once per second, thread status notifications update known entries immediately, and metadata/default mode configuration is refreshed every ten seconds. Initial parsing reads eligible plaintext files from the beginning. A generating/tool phase without new log evidence for 300 seconds becomes unknown; runtime Working/Ready remains separately identified. No global rollout directory scan is performed.

Multiple monitor processes can share the same state directory. Each process synchronizes newly committed response facts from the shared database before publishing a collection cycle, so duplicate parsing does not double-count and facts recorded by another process become visible. Samples can still differ briefly with collection timing and in-flight estimates. SQLite waits briefly for competing writers; a longer contention failure follows the normal collection error and retry path.

Daily totals use an index on the recorded response day. On the measured 67 MiB history database, the previous full scan took about 20.5 ms per query; the indexed query took about 0.75 ms. Candidate-only cold parsing of roughly 319 MiB completed in about 1.4 seconds, and indexed warm collection cycles took about 5 ms median. These are short measurements on one active Windows host, not guarantees for daemon CPU or host UI rendering.

`sampledAt` anchors the query's rate window; `collection.lastSuccessAt` is the last successfully completed runtime-and-file reader cycle. A query returning a new timestamp does not prove that collection advanced. `collection.skippedCompressedFiles` reports compressed loaded candidates, not a scan of all compressed history. `collection.excluded` separately counts compressed, missing-metadata, missing-log and unsupported-path exclusions.

## UI behavior

The top overview covers monitorable Working/Ready agents independently of the selected or visible rows. Root conversations occupy the top-level list; descendants are shown within their root. Recent ordering uses session recency metadata and actually reorders existing rows when a new interaction occurs. The main agent stays first within a root; descendants follow recency. Prefix limits grow only through user scrolling. At most one selected row is retained outside a prefix, until the corresponding nullable detail response confirms it has left the monitored set.

An expanded conversation opens on its aggregate overview, followed by the main agent and its subagents. The overview covers the monitored group regardless of agent filtering or pagination; selecting an agent opens its individual details and rate chart.

Subagent names use the recorded task path when available, then the thread title or a stable ID. Generated agent nicknames are not used as task names.

Lists use bounded scrolling regions and cursor-based incremental loading rather than page buttons. While visible, the dashboard targets a 250 ms start-to-start refresh interval, subtracting the previous refresh's duration. Slow refreshes finish before another begins and do not create a backlog. Hidden views stop both metric requests and the UI freshness timer; an already-sent request may finish, but hidden views do not continue the next page or detail request. Displayed rate numbers use a short smoothing window and model/tier counts briefly stabilize before changing; chart samples remain unsmoothed.

The global and agent rate charts support selecting a time range, zooming and panning, and inspecting individual samples. The global chart sums the current monitored members regardless of list filters or pagination; its past values can change when membership changes. A historical view holds its captured five-minute window steady while live updates continue; returning to live follows the latest samples again. The tooltip reports measured and estimated rates, not historical runtime status or configuration, which are not recorded as a timeline. The charts cannot reconstruct older per-second history from the daily aggregates.

MCP discovery and resource reads only register the App and serve its files. They do not open the metrics database or connect to the daemon. Data requests activate the collector and renew a five-second activity lease. With no further requests, collection pauses after the current cycle unless the background switch is on. The switch is process-local, shared by windows using that process, and resets to off when the process restarts; it cannot keep a process alive if the host terminates it. The observer proxy and read-only catalog database close on pause; the Codex daemon remains running. Parsed offsets and plugin metrics remain cached for resume. Diagnostics requests alone do not activate collection. The MCP subprocess remains available; paused does not mean that Codex has unloaded the plugin.

Disconnected, failed, initial-scanning or stale samples do not replace a valid reading with zero. The UI retains the last trusted values with an expired/retrying indication. Before any trusted sample exists it displays `-`. A fresh successful sample restores the live view, including genuine zero readings. Reader freshness uses server-relative timestamps plus elapsed UI time so remote clock offsets are not treated as failure.

## Diagnostics

Open the dashboard's diagnostics view to inspect the service log path, recent backend events and recent UI failures. UI failures are retained locally while the MCP connection is unavailable; they are not recursively sent over the failed connection.

Logs are JSONL under `<AGENT_MONITOR_STATE_DIR>/logs/`, with one filename family per process. Each file is limited to 5 MiB and each family keeps three files. Service startup/initialization/closure, entrypoint/resource reads, scan summaries, read failures and recovery are recorded at the default level. Set `AGENT_MONITOR_LOG_LEVEL=debug` in the normal execution environment for cycle and request-level detail. Warnings and errors also go to stderr for the host's MCP diagnostics; stdout remains reserved for the protocol.

Logs contain version, process ID, timestamps, event names, durations, source filenames and structured error metadata. Conversation bodies, tool arguments/results and credentials are excluded. A failure to write the log does not terminate monitoring; recent sanitized events remain available from the diagnostics API.

## Remote scope

A remote-host plugin process reads that host's `CODEX_HOME` and connects to that host's existing daemon. A local process does not automatically see other machines or independent app-server instances. The observer verifies the connected daemon's home. The plugin cannot switch the host of an existing MCP App frame. Its UI makes the execution host explicit; a multi-host sidebar aggregator is outside this version.

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
