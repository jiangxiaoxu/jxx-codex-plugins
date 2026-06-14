## 项目约定

- rg plugin 当前已禁用 `SearchSession.nextJson()`,不要在 skill 文档,调用示例或新代码中使用它;搜索读取应使用 `SearchSession.next()`。
- 新增,重命名或移除 `plugins/*` 下的 plugin 时,必须同步维护 `.agents/plugins/marketplace.json` 和 `README.md` 的插件列表.
- 处理 `plugins/*` 下 plugin 的版本号 +1 时,必须同步提升对应 `plugins/<plugin>/.codex-plugin/plugin.json` 中 `version` 字段的数字版本号.
