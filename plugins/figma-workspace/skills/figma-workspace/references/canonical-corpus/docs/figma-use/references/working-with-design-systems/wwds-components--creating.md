# 创建组件

组件是设计系统的公开产品, 不是把一组图层转换成 Component 的机械步骤。先确定使用者要选择什么、编辑什么、替换什么, 再决定 Component Set 和属性模型。实例产生后再改结构会破坏使用方式, 因此先做小而完整的模型, 再扩展。

## 先发现, 后建模

所有命令都使用同一个绝对 `--state-file`, 并在第一次使用某个命令前查看 `--help`。不要凭名称假定库、变量或现有组件存在。

```text
npm --silent run figma:libraries -- --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "button action" --components --variables --styles --library <library-key> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:variables -- <node-id> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:metadata -- <node-id> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
```

- `figma:libraries` 用于列出可用库和取得库 key; 只在需要限定来源时把 key 传给 `figma:design-system --library`。
- `figma:design-system` 用于搜索可复用的组件、样式和变量。先复用匹配的库资产, 不要创建同名替代品。
- `figma:variables` 用于确认目标或节点已有的 token 绑定和 mode; 它不替代组件结构检查。
- `figma:metadata` 先取得宽泛的层级、组件和实例线索; 拿到目标 raw node ID 后再做针对性工作。
- `figma:api:search` 只在需要精确 Plugin API 符号、属性或返回类型时使用, 例如 `componentPropertyDefinitions`、`combineAsVariants` 或 `createComponent`。

```text
npm --silent run figma:api:search -- componentPropertyDefinitions --state-file C:/work/project/.figma-workspace/state.json
```

## 属性模型

把代码的 public props 映射为 Figma 的使用者选择, 而不是逐字段照抄。

- Variant 适合会改变视觉或结构的离散状态, 例如 `Size`, `Kind`, `State`。每个组合都是一个真实的 variant; 轴越多, 维护成本按组合数增长。
- Text property 适合实例中的文案。它必须通过 descendant 的 `componentPropertyReferences.characters` 连到实际 TextNode。
- Boolean property 适合可见性开关。它必须连接到 descendant 的 `componentPropertyReferences.visible`。
- Instance swap property 适合可替换的嵌套实例, 常见于 icon 或 leading/trailing content。它必须连接到 descendant 的 `componentPropertyReferences.mainComponent`。

优先减少 variant 轴。可选 icon 通常是 instance swap 加 boolean, 不是额外的 `Icon=On|Off` variant; 不会改变版式的文字也不应成为 variant。交互态可作为设计态 variant, 即使代码中是 pseudo-class, 但必须明确它不是运行时 prop。

## `.figma.ts` 写入方式

写操作只进入一个可审查的 `.figma.ts` 文件, 再由 `figma:script:run` 严格预检和执行。以下示例把已有的三种 Button Component 转为一个 Component Set; 实际任务应先替换 id、名称和属性值。

```ts
const candidates = ["Button / Primary", "Button / Secondary", "Button / Disabled"];
const componentsByName = new Map<string, ComponentNode[]>();
for (const component of figma.root.findAllWithCriteria({ types: ["COMPONENT"] })) {
  if (!candidates.includes(component.name)) continue;
  const matches = componentsByName.get(component.name) ?? [];
  matches.push(component);
  componentsByName.set(component.name, matches);
}

const components = candidates.map((name) => {
  const matches = componentsByName.get(name) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one component named "${name}", found ${matches.length}.`);
  }
  return matches[0];
});

components[0].name = "Kind=Primary, State=Default";
components[1].name = "Kind=Secondary, State=Default";
components[2].name = "Kind=Primary, State=Disabled";

const buttonSet = figma.combineAsVariants(components, figma.currentPage);
buttonSet.name = "Button";
buttonSet.description = "Action control. Choose Kind and State; use an instance property for the icon.";

return {
  componentSetId: buttonSet.id,
  variants: buttonSet.children.map((node) => ({ id: node.id, name: node.name })),
};
```

将运行输入保存在任务目录, 例如 `run-button.json`。`inputFile` 指向该 `.figma.ts`, `sessionId` 来自先前打开或准备的同一工作区会话; 运行结果里的预检诊断为 fatal 时不得执行后续写入。

```json
{
  "sessionId": "default",
  "inputFile": "C:/work/project/.figma-workspace/button/create-button.figma.ts",
  "strict": true,
  "surface": "design"
}
```

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/button/run-button.json --state-file C:/work/project/.figma-workspace/state.json
```

## 创建前检查清单

- 已搜索库和设计系统, 并说明为什么不能复用现有组件。
- 已列出 variant 轴、合法值和实际需要的组合, 没有为未来猜测的状态建组合。
- 每个 Text、Boolean 和 Instance swap property 都有明确的 descendant 引用。
- Component Set 描述写明意图、适用边界和不明显的选择规则。
- 已验证变量绑定及 mode 不会让某个 variant 在目标主题下失真。

## 失败边界

不要在不完整的参照物上创建“近似”组件: 缺少状态、尺寸、token 或代码语义时, 先报告缺口。不要把已发布组件或未知实例网络重构为新 Component Set, 除非任务明确授权迁移影响。若严格预检失败, 按行号修复脚本; 若设计系统搜索显示同一概念已有库资产, 停止创建并改为复用或请求架构决定。
