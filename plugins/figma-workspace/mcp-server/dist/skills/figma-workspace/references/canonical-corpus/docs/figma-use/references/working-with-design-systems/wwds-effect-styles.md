# Effect styles

Effect style 是可命名复用的阴影、内阴影和模糊定义, 常对应 elevation 或 surface token。它不是 Variable 的替代品: 单个 effect 可以把 color、radius、spread、offset 等字段绑定到变量, 但一整组 effect 仍由 style 管理。

## 发现正确的来源

先检查库和设计系统中是否已有 elevation 或 surface style, 再读取目标节点和它的变量。这样可以区分“应应用现有 style”和“确实缺少 style”两种任务。

```text
npm --silent run figma:libraries -- --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "elevation shadow" --styles --variables --library <library-key> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:metadata -- <target> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:variables -- <target> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- setBoundVariableForEffect --state-file C:/work/project/.figma-workspace/state.json
```

使用 `figma:design-system` 搜索样式和变量, `figma:libraries` 确认来源, `figma:metadata` 定位目标, `figma:variables` 核对现存 token/mode。仅当需要确认 effect API 的字段、可绑定性或返回类型时才使用 `figma:api:search`。

## 模型和写入规则

- 常见 effect 是 `DROP_SHADOW`, `INNER_SHADOW`, `LAYER_BLUR` 和 `BACKGROUND_BLUR`。
- 阴影颜色采用 0 到 1 的 RGBA, 例如 `{ r: 0, g: 0, b: 0, a: 0.16 }`, 不使用 0 到 255。
- `effects` 是只读数组视图。复制、修改并重新赋值, 不在原数组中原地修改。
- 叠放顺序有视觉意义; 不要为了“去重”而改变数组顺序。
- 创建 style 不会自动改变任何节点; 应用时把 style id 写到节点的 `effectStyleId`。

以下 `.figma.ts` 示例创建一个本地 style 并应用到已确认的 Frame。若设计系统已提供同一语义的 style, 应改为应用那个 style, 而不是创建重复条目。

```ts
const target = figma.getNodeById("123:456");
if (!target || !("effectStyleId" in target)) {
  throw new Error("Expected a node that supports effect styles.");
}

const style = figma.createEffectStyle();
style.name = "Elevation/200";
style.description = "Raised surface at the default elevation.";
style.effects = [{
  type: "DROP_SHADOW",
  color: { r: 0, g: 0, b: 0, a: 0.16 },
  offset: { x: 0, y: 4 },
  radius: 12,
  spread: 0,
  visible: true,
  blendMode: "NORMAL",
}];

target.effectStyleId = style.id;
return { styleId: style.id, targetId: target.id, effects: style.effects };
```

将脚本和运行输入保存到同一任务目录, 再由严格模式执行。执行前先查看 `figma:script:run -- --help`; fatal preflight diagnostics 表示没有写入。

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/elevation/run.json --state-file C:/work/project/.figma-workspace/state.json
```

## 检查清单和失败边界

- 已从库和设计系统搜索结果确认不应复用现有 style。
- 已确认目标节点支持 `effectStyleId`, 并且目标 id 来自本次读取。
- 每个 effect 的颜色、单位、顺序和可见性均按目标 token/mode 校验。
- 已把 style 名称和 description 写成可理解的系统语义, 而不是具体页面名称。
- 脚本返回 style id、目标 id 与最终 effect, 便于复核。

不知道应绑定哪个变量、没有得到目标主题下的视觉规范、或 style 会覆盖未知本地效果时, 不要写入。对已发布 style 的批量替换也需要明确迁移授权。若预检报错, 先修复 TypeScript 或节点类型问题; 不要改用未检查的临时调用绕过脚本流程。
