# 组件与实例

组件把稳定的视觉和结构决策集中到一个定义中, 实例则承载页面语境。设计系统工作不是只识别名字相同的节点, 而是确认组件的属性、嵌套关系、描述和变量绑定是否仍能解释实例的外观。

## 读操作的选择

每次命令都显式传入 Figma file 或 node target。命令标准输出是 Restricted Markdown; 结果指向 sidecar 时读取该 JSON 文件, 不要把标准输出当 JSON。

| 需要回答的问题 | 使用的命令 |
| --- | --- |
| 文件中有哪些组件、实例和层级入口? | `figma:metadata` |
| 哪个已发布或可用库组件最接近需求? | `figma:libraries` 后接 `figma:design-system --components` |
| 组件是否依赖 token, token 有哪些 mode? | `figma:variables` |
| 某个 Plugin API 成员的准确名称或类型是什么? | `figma:api:search` |

```text
npm --silent run figma:metadata -- --file <file-url-or-key> --node <target>
npm --silent run figma:libraries -- --file <file-url-or-key>
npm --silent run figma:design-system -- "input field" --components --library <library-key> --file <file-url-or-key>
npm --silent run figma:variables -- --file <file-url-or-key> --node <target>
npm --silent run figma:api:search -- componentPropertyReferences
```

`componentPropertyDefinitions` 的 owner 是 Component Set, 或不属于 Component Set 的 Component. variant Component 必须经其父 Component Set 读取定义. 验证属性是否真的生效还要遍历 descendants: 文本看 `characters`, 可见性看 `visible`, 嵌套实例替换看 `mainComponent`. 名称可读即可; 映射到代码 prop 的责任应放在明确的交付约定中, 不能靠猜测命名规则.

## 审计示例

把以下代码放进 `.figma.ts`, 用它审计单个已知组件。它只读取并返回结果, 不修改文件。

```ts
const component = figma.getNodeById("123:456");
if (!component || (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")) {
  throw new Error("Expected a COMPONENT or COMPONENT_SET at 123:456.");
}

const propertyOwner = component.type === "COMPONENT" && component.parent?.type === "COMPONENT_SET"
  ? component.parent
  : component;

const references = component.findAll((node) => "componentPropertyReferences" in node)
  .map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    references: node.componentPropertyReferences,
  }))
  .filter((entry) => entry.references !== undefined);

return {
  id: component.id,
  name: component.name,
  // `description` is valid only because the type guard above narrowed to
  // COMPONENT or COMPONENT_SET; INSTANCE and FRAME do not expose it.
  description: component.description,
  properties: propertyOwner.componentPropertyDefinitions,
  references,
};
```

预检与运行仍通过 `figma:run`; 在命令行显式提供 file target、surface 和 `.figma.ts` 路径。先运行 `figma:run -- --help` 获取本安装版本的完整输入说明。

```text
npm --silent run figma:run -- --file <figma-file-url-or-key> --surface design --script <path/to/script.figma.ts>
```

## 描述与使用规则

只为 Component 和 Component Set 写 `description`. 描述应解释意图, 何时选择它, 何时不要选择它, 以及非直观 property 的限制. 把共享说明放在 Component Set; 仅给某一个 variant 写说明通常不能帮助实例使用者. Instance 和普通 Frame 不暴露 `description`.

组件不等于任意可复用图层。页面局部、一次性排版和尚未稳定的视觉探索不应过早组件化。反过来, 多处复制且需要同步的结构, 或需要由 token 和属性表达的选择, 才是 Component 的候选。

## 检查清单与失败边界

- 搜索过可用库, 也检查过当前文件的结构; 没有用名称猜测组件身份。
- 核对过定义、descendant 引用和真实实例, 而不只看 `componentPropertyDefinitions`。
- 已检查相关变量及 mode, 尤其是同一组件在不同主题中的结果。
- 修改脚本只触及已确认 id, 返回变更 id 和验证说明。
- 对有发布影响的重命名、属性删除、实例迁移, 已获得明确任务授权。

未知 id、缺少库权限、搜索返回多种语义相近的组件、或 property 引用不完整时, 停止写入并报告证据。不能用复制一个组件、重置实例或删除“多余” variant 来绕过这些不确定性。严格 TypeScript 预检的 fatal diagnostics 必须先修复; 预检未执行不代表安全地跳过检查。
