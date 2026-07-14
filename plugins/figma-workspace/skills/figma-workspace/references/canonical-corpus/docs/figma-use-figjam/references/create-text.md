# 在 FigJam 创建文本

使用 `figma.createText()` 创建独立的 FigJam 文本节点：标题、说明、标签和提示语都适用。sticky、shape、connector 或 table cell 内的文本应编辑它们自己的文本子层，而不是另建覆盖其上的 text node。需要改已有文本或 mixed styles 时见 `edit-text.md`。

## `.figma.ts` 前置与执行

先明确内容、层级、坐标和是否需要固定宽度换行。把这些值放在一个本地脚本中，并用已建立 FigJam session 运行：

```json
{
  "sessionId": "<session-id>",
  "inputFile": "C:/work/project/.figma-workspace/board/add-instructions.figma.ts",
  "strict": true,
  "surface": "figjam"
}
```

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/add-instructions.json --state-file C:/work/project/.figma-workspace/state.json
```

`figma:eval` 仅可用于已知单节点的一次小型、自足变更；新建文本通常包含字体、排版和位置，保留在 `.figma.ts` 更容易检查和重跑。

## Plugin API 步骤

1. 调用 `figma.createText()`；新节点位于当前 page。
2. 在写入 `characters`、`fontName`、`fontSize`、`textCase` 或排版属性前加载目标字体。
3. 写入内容后设置字号、颜色和坐标。默认正文和标题用 Charcoal `#1E1E1E`，通过字号而不是灰色制造层级。
4. 短标题保持 `textAutoResize = 'WIDTH_AND_HEIGHT'`。正文先设 `textAutoResize = 'HEIGHT'`，再在写入内容后调用 `resize(width, text.height)` 以获得换行。
5. 返回 node id、字符数、位置及最终宽高。

FigJam 常用 preset 对应 `Inter Medium`、`Merriweather Regular`、`Roboto Mono Medium` 和 `Figma Hand Regular`。选择字体前应以实际文档可用性为准。

## TypeScript 示例

```ts
const text = figma.createText()
const font: FontName = { family: 'Inter', style: 'Medium' }
await figma.loadFontAsync(font)

text.fontName = font
text.characters = '在此区域记录假设、问题和下一步。'
text.fontSize = 16
text.fills = [{ type: 'SOLID', color: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 } }]
text.textAutoResize = 'HEIGHT'
text.resize(336, text.height)
text.x = 96
text.y = 128

return {
  textId: text.id,
  characters: text.characters.length,
  bounds: { x: text.x, y: text.y, width: text.width, height: text.height },
}
```

若文本要放入 section，先将其 append 到目标 parent，再按该 parent 的本地坐标定位；可用宽度通常是 `section.width - padding * 2`。不要以 page 坐标定位后再 reparent。

## 验证与常见失败

- 用 `figma:inspect` 检查 node type 为 `TEXT`、内容、字体、大小和 bounds；对版面变化 capture 后使用 `view_image`。
- **字体未加载**: 字符、字体或字号写入失败。先 `loadFontAsync` 目标 `FontName`。
- **意外单行溢出**: 默认是 `WIDTH_AND_HEIGHT`。正文改为 `HEIGHT` 并在设置内容之后 resize。
- **文本被容器裁切或错位**: reparent 后坐标是相对 parent 的；检查 section padding 和最终 bounds。
- **颜色成为 custom**: palette 色使用 `0xNN / 255` 的精确分量，不使用近似小数。
