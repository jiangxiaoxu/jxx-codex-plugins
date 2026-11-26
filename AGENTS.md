## 仓库上下文

- 开始仓库任务前,先阅读 `doc/jxx-codex-plugins-repository-guide.md`;单个 plugin 任务至少阅读对应 source map,validation 入口和列出的维护文档(如有).
- 不要依据记忆推断仓库结构;以当前目录,plugin manifest,marketplace 和 package scripts 为准.若 repository guide 与源码不一致,在同一任务中同步修正文档.

## 项目约定

- 本仓库的插件仅面向 Windows x64. 实现, 打包, 发布和验证均以该平台为目标.
- `AGENTS.md` 仅保存 AI 执行指令,不是项目 canonical 文档;不得复制或摘录其内容到项目文件.
- Plugin 维护文档统一放在 `doc/` 下,文件名包含对应 plugin 名称.
- 新增,重命名或移除 `plugins/*` 下的 plugin 时,同步维护 `.agents/plugins/marketplace.json`,`README.md` 和 repository guide 的 plugin inventory.

## 迭代收尾

- 本轮改动影响已有 plugin 的发布包时,由负责最终交付的 Agent 将受影响 plugin 的补丁版本各递增一次. 以迭代开始时 `plugins/<plugin>/.codex-plugin/plugin.json` 的 `version` 为基线. `task-memory` 另同步 `package.json` 的 `version` 和 `package-lock.json` 的 `version` 及 `packages[""].version`.
- 验证最终改动后,由负责最终交付的 Agent 自动暂存本轮改动并创建本地 Git 提交. 版本变更与对应 plugin 的改动放在同一提交. 用户明确指定版本或提交安排时,按其要求执行.
- 每次创建本地 Git 提交后,以新提交树中的 `.exe` blob 为保留集合. 如当前分支历史中有已被替换或移除的 `.exe` 生成产物,在提交收尾时重写该分支的历史并清除这些旧 blob.
- 重写前在仓库外保存并验证可恢复备份. 保留当前提交的完整内容及其他文件的历史,比对重写前后的 `HEAD^{tree}`,并确认旧 blob 已无法从该分支到达.
- 推送重写后的分支时,按用户已授权的范围执行,使用以重写前核对的远端 SHA 为预期值的 `--force-with-lease=<ref>:<sha>`.

## Plugin 发布与客户端更新

- 不得为了测试或开发迭代使用 cachebuster,`codex plugin add`,reinstall,修改 marketplace 配置或要求 Codex 立即加载本地 plugin.
- Plugin 更新只能通过递增正式版本,同步更新发布元数据,发布并推送后由客户端的正常自动更新行为取得.
- 未发布版本的验证仅限仓库内构建,测试,打包和其他不要求客户端加载 plugin 的检查.
