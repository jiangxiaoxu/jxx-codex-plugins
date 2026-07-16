# Text styles

Text style 是可复用的排版契约: font family、style、size、line height、tracking、case 和段落规则共同组成一个 type ramp。它不是单一 Variable; 可以将可支持的单项属性绑定到变量, 但应先确认现有 token 和字体在目标文件中可用。

## 查询顺序

先用设计系统和库发现标准 type ramp, 再用 metadata 定位文本和容器, 用 variables 检查 token/mode。只有需要精确 API 细节时才查询 API。

```text
npm --silent run figma:libraries -- --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "heading body typography" --styles --variables --library <library-key> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:metadata -- <text-node-id> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:variables -- <text-node-id> --file <file-url-or-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:api:search -- loadFontAsync --state-file C:/work/project/.figma-workspace/state.json
```

`figma:design-system --styles --variables` 帮助辨别可应用的 type style 和 token; `figma:libraries` 确认其来源; `figma:metadata` 不应被跳过, 因为文本节点可能继承复杂的局部上下文。还需要了解 `TextStyle`, `setBoundVariable`、`lineHeight` 或 `letterSpacing` 时, 分别用 `figma:api:search` 查询。

## 精确的类型规则

- 改动 `fontName` 或文本内容前, 必须 `await figma.loadFontAsync(...)`。先通过 `figma.listAvailableFontsAsync()` 获取精确 family/style, 不要猜测字体 style 名称。
- `lineHeight` 和 `letterSpacing` 均为对象, 不是裸数字: `{ unit: "AUTO" }`, `{ value: 24, unit: "PIXELS" }`, `{ value: 150, unit: "PERCENT" }`。
- 可绑定字段包括 `fontFamily`, `fontSize`, `fontStyle`, `fontWeight`, `letterSpacing`, `lineHeight`, `paragraphSpacing` 与 `paragraphIndent`。变量存在且语义匹配时, 使用 `setBoundVariable`; 不存在时不要虚构 token。
- 创建 TextStyle 不会改变文本节点; 应用时设置 `textStyleId`, 或使用 `setTextStyleIdAsync`。
- style 名称不是唯一标识。对已知对象用 id 或 key, 不要仅按名称选择。

## `.figma.ts` 示例

下面的脚本先发现可用字体, 再创建并应用一个 style。它故意在字体不可用时失败, 以避免静默回退到错误字重。

```ts
const target = figma.getNodeById("123:456");
if (!target || target.type !== "TEXT") {
  throw new Error("Expected a TEXT node at 123:456.");
}

const desiredFont = { family: "Inter", style: "Semi Bold" };
const availableFonts = await figma.listAvailableFontsAsync();
const supported = availableFonts.some(
  (font) => font.fontName.family === desiredFont.family && font.fontName.style === desiredFont.style,
);
if (!supported) {
  throw new Error(`Font unavailable: ${desiredFont.family} ${desiredFont.style}`);
}

await figma.loadFontAsync(desiredFont);
const style = figma.createTextStyle();
style.name = "Heading/L";
style.description = "Large section heading. Use once per content region.";
style.fontName = desiredFont;
style.fontSize = 24;
style.lineHeight = { value: 32, unit: "PIXELS" };
style.letterSpacing = { value: 0, unit: "PIXELS" };
target.textStyleId = style.id;

return { styleId: style.id, targetId: target.id, font: desiredFont };
```

TypeScript 预检和执行只通过 JSON 输入的 `figma:script:run`. 输入文件带有会话, 脚本绝对路径和对应 surface; TypeScript 预检始终启用. 先运行命令 help 确认当前 schema.

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/type-ramp/run.json --state-file C:/work/project/.figma-workspace/state.json
```

## 检查清单和失败边界

- 已检查库、现有 type style、相关变量和目标 node, 没有建立重复的 type ramp。
- 字体由 `listAvailableFontsAsync` 确认, 并在每次直接字体写入或文本编辑前加载。
- line height、tracking 与 token/mode 有明确单位和预期值。
- 已应用 style 到目标 TextNode, 并返回 style id 和 target id 用于验证。
- 已为共享 style 写出意图、适用范围和使用限制。

字体不可用、目标不是 TextNode、变量语义不清、或现有库 style 应被复用时, 停止写入。不要以相近字体或裸数值替代设计契约。预检的 fatal diagnostics、未知实例影响和需要重写已发布排版系统的请求都应先解决或取得明确授权。
