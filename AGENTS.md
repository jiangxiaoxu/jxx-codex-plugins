## 仓库上下文

- 开始仓库任务前,先阅读 `doc/jxx-codex-plugins-repository-guide.md`;单个 plugin 任务至少阅读对应 source map,validation 入口和列出的维护文档(如有).
- 不要依据记忆推断仓库结构;以当前目录,plugin manifest,marketplace 和 package scripts 为准.若 repository guide 与源码不一致,在同一任务中同步修正文档.

## 项目约定

- `AGENTS.md` 仅保存 AI 执行指令,不是项目 canonical 文档;不得复制或摘录其内容到项目文件.
- Plugin 维护文档统一放在 `doc/` 下,文件名包含对应 plugin 名称.
- 处理 `plugins/figma-workspace` 的开发,重构或维护任务前,先阅读 `doc/figma-workspace-ai-agent-development.md`.
- 新增,重命名或移除 `plugins/*` 下的 plugin 时,同步维护 `.agents/plugins/marketplace.json`,`README.md` 和 repository guide 的 plugin inventory.
- 将 plugin 数字版本号 +1 时,同步修改对应 `plugins/<plugin>/.codex-plugin/plugin.json` 的 `version`.

## Plugin 发布与客户端更新

- 不得为了测试或开发迭代使用 cachebuster,`codex plugin add`,reinstall,修改 marketplace 配置或要求 Codex 立即加载本地 plugin.
- Plugin 更新只能通过递增正式版本,同步更新发布元数据,发布并推送后由客户端的正常自动更新行为取得.
- 未发布版本的验证仅限仓库内构建,测试,打包和其他不要求客户端加载 plugin 的检查.
