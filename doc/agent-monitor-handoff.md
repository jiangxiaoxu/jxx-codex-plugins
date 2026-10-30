# Agent Monitor Handoff

交接日期: 2026-10-30 (UTC+08:00).

## 1. 当前基线

- Repository: <https://github.com/jiangxiaoxu/jxx-codex-plugins>.
- Branch: `main`.
- Plugin: `plugins/agent-monitor`, version `0.1.2`.
- 已发布的运行时代码提交: `9e5c21fada89c55bb91ebe0f39875040d2630b8c`.
- Commit: `perf(agent-monitor): monitor Working and Ready threads`.
- 上述提交已推送到 `origin/main`, 推送后远程 hash 已核验, 当时工作区干净.
- 本文及其链接属于后续文档提交, 不改变插件版本和运行时代码.

其他电脑的上下文入口是该电脑实际的 `AGENTS.md`, [Repository Guide](jxx-codex-plugins-repository-guide.md) 和 [Agent Monitor 维护文档](agent-monitor.md). 维护文档描述当前契约; 本文记录这次交接的版本基线, 验证证据和后续事项.

## 2. 用户目标和已经确定的范围

用户希望在 Codex MCP App 中看到紧凑的实时监视面板:

- 顶部总输出速率及各模型贡献.
- 根会话列表, 展开后查看主代理和子代理的模型, reasoning effort, token 用量, 速率和 Fast/Ultrafast 证据.
- 会话和子代理按最新交互排序, 使用滚动和逐步加载, 避免大量子代理无限堆叠.
- 面板显示时自动更新, 隐藏后停止请求和后台采集, 尽量降低 Codex App 的负担.
- 有足够的诊断日志, 断连或采集失败时保留上次有效结果, 避免显示假零.

最新监视范围是 CLI Agent command center 的 Working / Ready. 用户已明确接受完全跳过压缩线程及由此导致的旧历史不完整.

`0.1.2` 没有多主机聚合器. 插件后端只连接其执行主机上的现有 daemon, 读取同一主机的 Codex 数据. 本地 UI 不会自动把请求路由到其他电脑的 daemon.

## 3. 数据链路和状态语义

```text
MCP App UI
  -> MCP structuredContent tools
  -> Node Monitor
      -> codex app-server proxy --sock <existing control socket>
          -> existing daemon, WebSocket over stdio
      -> read-only state_5.sqlite, only loaded IDs' rollout paths
      -> selected plain JSONL, offset-based incremental reads
      -> plugin-owned metrics.sqlite and diagnostic JSONL
```

### Runtime 目录

Working / Ready 是运行时状态, 不存在于 `state_5.sqlite` 的普通线程元数据表中. 不能把最近修改的文件直接当作 Working 或 Ready.

- Working: `ThreadStatus.Active`, 且没有 `waitingOnApproval` / `waitingOnUserInput`.
- Ready: 仍 loaded 的 `ThreadStatus.Idle`.
- Needs you, SystemError / NotLoaded 等不属于当前采集集合.
- Ready 可能很久没有交互, 所以实现没有用最近 N 天或最近 N 条替代 runtime 分类.
- 根容器中任一被监视成员 Working, 容器即显示 Working. 主代理不在集合时, 仍可展示其存活后代.
- 根容器数量是可监视会话组的数量, 不保证等于 CLI 的全部线程计数.

后端只启动现有 daemon 的字节代理, 不另建 app-server. 新建独立 app-server 进程无法取得另一个进程的 loaded 状态.

请求白名单为 `initialize`, `thread/loaded/list`, `thread/read(includeTurns:false)`. 不调用 start, resume 或 subscribe. 新连接不会主动订阅会话正文.

### 初始化和压缩预筛选的两个关键点

1. 使用 `clientInfo.name = codex-backend`, `title = Agent Monitor`, experimental / approval / OAuth capability 均未启用. 已核验的 Codex 0.166.0 将该名称视作 non-originating helper, 不替换共享 daemon 的全局 originator, User-Agent suffix 或自动登录策略. 初始化仍有普通连接开销和 telemetry. 普通自定义 originating client 名称在该版本存在全局身份副作用.
2. `thread/read(false)` 仍可能内部读取 rollout header, legacy 路径甚至能透明打开 zst. 因此先用 loaded IDs 查询只读数据库的路径, stat 确认普通 JSONL 存在, 再发 metadata read. 被压缩的候选不会收到 metadata-read 请求. 返回的 `preview`, turns 和其他正文相关字段不进入保留的 metadata 投影.

### 元数据和层级

- 使用 daemon 的 `recencyAt` 表示最近交互, 不是每条 assistant 输出都重新排序.
- loaded DTO 的 `sessionId` 是实际 root thread ID. 即使中间父代理已卸载, 存活孙代理也归属正确根会话.
- `parentThreadId` 保留为直接父代理身份.
- 缺少标题时使用稳定 ID, 不从用户消息正文提取标题.
- runtime 的 model / effort 是当前配置, 可能已经描述下一轮. Working 请求优先使用记录的 `turn_context` 模型和 effort. `configuredModel` 等字段单独保留, UI 标注配置证据.

## 4. 刷新, 生命周期和一致性

| 项目 | 当前行为 |
| --- | --- |
| JSONL 采集 | 每个完整周期结束后延迟 250 ms, 不重叠. |
| UI | 可见时目标 500 ms start-to-start, 扣除上轮耗时, 慢请求不积压. |
| loaded 目录 | 最多每秒复查一次; status 通知更新已知状态并触发 metadata 更新. |
| 常规 metadata / 默认 mode | 每 10 秒复核. |
| 活动租期 | 数据请求续期 5 秒; 无后续请求时暂停, 关闭自己的 proxy 和只读 catalog DB. |
| MCP discovery / resource read | 不启动采集, 不连接 daemon. |
| Diagnostics 请求 | 本身不激活采集. |

UI 的隐藏检测使用页面可见性和 viewport intersection; teardown 也停止轮询. 已发送请求可以完成, 隐藏后的多页或详情链不会继续发下一次请求.

采集完成并通过 source / store 检查后, 才发布查询用的 committed view. 正在读取新文件时, snapshot / thread / agent 继续使用上次成功的完整视图, 不暴露中间态空列表或 token / mode 的部分更新. 提交前还会检查 runtime 连接.

断连, error, scanning, paused 或 stale 数据不会覆盖上次可信值. 尚无可信结果时显示 `-`. `sampledAt` 是查询时间, `collection.lastSuccessAt` 才是完整采集成功时间; 新的查询时间不等于采集健康.

正常线程消失返回 `thread:null` 或 `agent:null`, 空列表 / 曲线, 不作为 MCP tool error. metadata 查询期间的正常 unload 也会复查 loaded 集合后移除, 而非使整个面板失败. 迟到的旧 metadata 响应不会覆盖较新的 status 通知.

暂时进入 Needs you 的 loaded 线程保留 parser / offset, 但不继续采正文; 恢复后增量读取. 离开 loaded 集合后清理对应 reader cache.

## 5. UI 和指标边界

- 默认最近交互排序, 另有 Working 优先排序.
- Root 和子代理各自有独立加载预算, 初始 10, 只有用户滚动加载才增加.
- 被新排序挤出已加载前缀的选中项最多额外保留一行; nullable 详情确认离开后移除. 自动刷新不会因此不断扩大加载预算.
- 主代理固定在其组内首行, 子代理按 recency 排序.
- UI 筛选或少显示几行不改变当前监视集合的总速率和模型贡献.

速率窗口为 3 秒. `measuredTps` 来自完成请求的 token 和推断请求时长, 不是逐 token 网络流的精确计量. `estimatedTps` 独立标记; 在途估算要求有 turn-context 模型证据及匹配模型的已完成样本. 配置模型不直接充当当前请求执行证据.

每个 response 只计入一个 agent, 后代向 root 汇总一次. output 已包含 reasoning, reasoning 是分项而不是额外相加. 解析器处理 modern usage / legacy 镜像去重, copied-context ordinal 和时间边界, 不保留正文.

Fast / Standard / Ultrafast 来自配置, 选择值或请求记录的 `service_tier` 证据. 这些不证明服务端实际 served tier; 缺少证据显示未知.

曲线保留最近 300 个一秒槽位. 长期历史是持久化 response facts 的按日统计, 不是任意历史秒级重放. 当前速率只汇总被监视成员; daily history 保留以前已记录的事实, 包括后来不再 Working / Ready 的线程. API 的 coverage 为 sampled, historyComplete 为 false.

## 6. 首次读取策略和未采纳的方案

当前实际行为: 首次完整读取符合 Working / Ready 和普通 JSONL 条件的候选文件, 之后按 offset 增量. 不再全目录枚举和读取所有未压缩历史. 已有 metrics facts 保留并去重, 压缩文件完全跳过.

曾向用户提出另一种选择: 仅使用有界头尾 bootstrap 恢复状态, 从面板打开后观察到的新 usage 开始累计, 进一步缩减首开读取量. 用户尚未明确采用该统计口径; `0.1.2` 未实施尾部 bootstrap 或仅新增用量累计. 完整候选初读已经实测约 1.4 秒.

如果后续选择尾部方案, 已发现的风险包括:

- 尾窗可能只留下 legacy token_count 镜像, 而对应 modern usage 在窗外. 直接按现有 parser 回补可能用不同 key 重复计数.
- 缺失请求起点时, runtime Active 不能用作测量起点.
- 丢失 SessionMeta / copied-context 边界可能把祖先用量归给子代理.
- 长时间隐藏后恢复, 或重新进入候选集合时, 也要明确是否追读全部缺口.
- Working 退出集合前最后一次 usage 的有界收尾尚未单独实施.

这些是后续设计事项, 不是已经交付的功能. 当前发布没有引入 2 MiB tail 预算, 独立历史 backfill worker 或持久化 parser checkpoint.

## 7. 验证和性能证据

运行时代码 `9e5c21f` 的最后验证全部通过:

- 37 tests: collector 18, UI state 11, runtime transport 2, diagnostics 4, MCP server 1, packaged runtime 1.
- build, check:dist, plugin validate, pack dry-run, git diff --check.
- 打包 10 个文件, unpacked size 2,255,393 bytes.
- 生产依赖 audit 为 0 个漏洞.
- ws 为 8.22.0, zod 为 4.6.7. zod 升级修复了此前 audit 报告的内存耗尽问题.

实机是 Windows, Node 25.3.0, daemon 0.166.0. 以下是短样本, 不等于目标电脑的性能保证:

| 测量 | 结果 |
| --- | --- |
| 旧全历史冷扫描 | 1,626 个 plain JSONL, 跳过 5,117 个压缩文件; 30 秒读约 3.19 GB 仍未完成. |
| 新 runtime catalog 首次连接和读取 | 约 73-97 ms. |
| runtime catalog 后续复查 | 约 4 ms. |
| 新候选首次完整解析 | 约 57-58 个文件, 319 MiB, 约 1.3-1.4 秒. |
| 当天统计原查询 | 67 MiB / 约 22.1 万条 response facts, 全表扫描 p50 20.51 ms. |
| 当天统计加日期索引后 | p50 0.75 ms; 创建索引约 75 ms. |
| 完整 warm 采集周期 | 加索引前 p50 27 ms / p95 32 ms; 后 p50 5 ms / p95 10 ms. |
| snapshot / thread / agent 查询 | 约 0.3-1.2 ms. |

日期索引是 `responses(day)`, 在 `MetricsStore` 初始化时幂等创建. 没有为此增加 aggregate cache 或独立统计服务.

实测使用临时 metrics 数据库副本, 原 daemon / rollout 只读, 临时文件已清理. 测试期间存在少量真实写入. 没有把未发布插件加载进客户端.

未验证的边界:

- 正式客户端更新到 0.1.2 后的端到端 UI, 实际隐藏通知, FPS 和长期占用.
- 其他电脑, OS 或 daemon 版本.
- 实机 loaded + compressed 的组合; 当次快照无此候选, 压缩预过滤由 transport fixture 覆盖.
- 所有远程执行和多 daemon 布局.

## 8. 另一台电脑的恢复入口

已有 clone 可更新到包含上述 runtime 提交及本文的 `main`. 新 clone 的仓库入口:

```text
git clone https://github.com/jiangxiaoxu/jxx-codex-plugins.git
cd jxx-codex-plugins
```

插件目录内的仓库验证:

```text
cd plugins/agent-monitor
npm ci
npm run build
npm test
npm run check:dist
npm run validate
npm pack --dry-run --json
npm audit --omit=dev
```

运行要求和路径以目标电脑为准, 不依赖原开发机的绝对目录:

| 配置 | 默认或用途 |
| --- | --- |
| Node | >= 24; 发布包已 bundle, 运行主机不需要安装 npm 依赖. |
| CODEX_HOME | `~/.codex`. |
| AGENT_MONITOR_STATE_DIR | `~/.local/state/agent-monitor`; 包含插件自己的 metrics.sqlite 和 logs/. |
| AGENT_MONITOR_LOG_LEVEL | 默认 info; debug 增加周期, 文件和请求耗时. |
| AGENT_MONITOR_CODEX_BIN | 可指定 native Codex executable; 默认先查 managed current/bin, 再 PATH. Windows npm .cmd shim 不是 native executable. |
| AGENT_MONITOR_APP_SERVER_SOCKET | 默认 `<CODEX_HOME>/app-server-control/app-server-control.sock`. |
| AGENT_MONITOR_STATE_DB | 默认 `<CODEX_HOME>/state_5.sqlite`. |

Windows control socket 使用 AF_UNIX, 不是 named pipe; stdio proxy 解决 Node 在此平台的连接适配. 数据库 schema, thread path 字段及 non-originating helper 行为均已针对 0.166.0 核验, 跨版本时需要检查现场实现.

仓库拉取会携带源码, dist 和本文, 不会携带原电脑的 metrics 历史, 日志, auth 或 daemon 数据. 客户端通过已配置 marketplace 的正常更新取得发布版本; 仓库 checkout 本身不等于客户端已加载该版本.

## 9. 推荐继续处理的顺序

1. 确认客户端实际取得 0.1.2, 诊断页 version 与预期一致, runtime.connected 的 serverVersion 是现场 daemon 版本.
2. 打开面板检查 Working / Ready, 排序, 大量子代理滚动, 选中项保留及模型配置标签.
3. 隐藏面板后检查请求停止, 租期结束出现 collection.pause / runtime.closed; 再打开检查恢复与 offset 增量.
4. 如仍出现 MCP 错误或更新停下, 先收集 UI error ring 和后端对应时间段日志, 再针对具体错误修复.
5. 只有明确选择改变历史统计口径后, 再评估尾部 bootstrap. 当前不是等待实现的既定规格.

有用的诊断事件包括 runtime.connected, runtime.catalog, runtime.request, runtime.disconnected, collection.candidates, collection.cycle, collection.error, collection.recovered 和 collection.pause. 默认日志每文件上限 5 MiB, 每进程文件族保留 3 份, 内存保留 100 条最近事件. stdout 仅供 MCP 协议使用.

## 10. Source map 和背景

| 文件 | 接续工作重点 |
| --- | --- |
| `src/monitor/runtime.mjs` | 同 daemon observer, readonly RPC 白名单, 路径预筛选, status revision 和正常 unload. |
| `src/monitor/index.mjs` | 候选选择, 生命周期, committed view, 根分组, 速率和 API 数据. |
| `src/monitor/parser.mjs` | usage 去重, inherited context 边界, turn 模型 / effort, tier 和日志阶段证据. |
| `src/monitor/store.mjs` | metrics.sqlite, response facts 和 day 索引. |
| `src/server.mjs`, `src/main.mjs` | MCP 工具 / resource, 版本和 stdio 生命周期. |
| `src/diagnostics.mjs` | 日志脱敏和轮转. |
| `ui/app.mjs`, `ui/state.mjs` | 可见轮询, health, 排序, prefix budgets 和 nullable detail. |
| `scripts/build.mjs`, `scripts/validate.mjs` | bundle, third-party notices 和插件契约验证. |
| `tests/runtime.test.mjs`, `tests/fixtures/runtime-proxy.mjs` | 无客户端的 WebSocket-over-stdio fixture, 压缩预筛和异步状态边界. |

上表路径均相对 `plugins/agent-monitor/`. `dist/` 是已跟踪的生成产物, 包含 bundled server, 单文件 dashboard 和第三方许可证.

参考项目为 [zoefix/agent-speed](https://github.com/zoefix/agent-speed), 研究基线 commit `29dffc4e6fbe1da435071e40781b1571dd45ac22`. 其实时监视主要用 mtime / watcher / offset, 不是 Codex state DB 的 Working / Ready 筛选. 其冷启动只回读本地今天零点前 15 分钟以来修改的文件, 不是最近 15 分钟; 历史分析另行低优先级处理. 我们当前的 runtime / DB 候选方案是独立实现.

Codex App 底部 Do anything 输入框是宿主 UI, 不在插件 iframe 内. 已检查的 App 版本没有公开用户配置可隐藏它; 内部由 Statsig dynamic config `2503859075` 的 app_ids / mcp_servers 名单控制. 插件当前没有提供隐藏该宿主输入框的能力.
