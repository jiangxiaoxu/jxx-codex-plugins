# 编辑 FigJam 文本

本页覆盖已有 `TEXT` 节点和文本子层的内容、范围样式、链接与列表修改。先用只读 `figma:run` 查找结构，再用 `figma:inspect` 确认精确节点 id；`figma:metadata` 是 Design-only。不要按名称猜测并对全页文本做未经确认的替换。

## `.figma.ts` 前置与执行

脚本应把目标 id、预期旧值和新值写成明确常量，先验证类型和当前内容再写入。执行 JSON 形状如下：

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

已知 id 上的单个短文本修正可作为 `figma:run` 小事务例外；涉及 font loading、范围样式、多个节点或 find/replace 时，使用 `.figma.ts`。

## Plugin API 步骤

1. `await figma.getNodeByIdAsync(id)` 并确认 `node.type === 'TEXT'`；文本子层同样应先确认其可编辑性。
2. 若 `hasMissingFont` 为真，停止内容或排版修改并返回明确诊断。
3. 通过 `getStyledTextSegments(['fontName'])` 收集并加载所有字体。整段改写 `characters` 前尤其必要。
4. 对整段替换设置 `characters`；对局部样式使用 `setRangeFontName`、`setRangeFontSize`、`setRangeFills`、`setRangeTextCase`、`setRangeHyperlink` 或 `setRangeListOptions`。
5. 返回 id、旧值/新值摘要和使用的字符范围。范围终点是 exclusive。

## TypeScript 示例: 受保护的内容与范围强调

```ts
const nodeId = '<text-node-id>'
const expected = '研究问题: 如何缩短反馈周期?'
const node = await figma.getNodeByIdAsync(nodeId)

if (!node || node.type !== 'TEXT') throw new Error(`Expected TEXT: ${nodeId}`)
if (node.hasMissingFont) throw new Error(`Cannot edit missing-font text: ${nodeId}`)
if (node.characters !== expected) throw new Error('Text changed since inspection; refusing stale overwrite')

const segments = node.getStyledTextSegments(['fontName'])
await Promise.all(segments.map((segment) => figma.loadFontAsync(segment.fontName)))

node.characters = '研究问题: 如何缩短反馈周期?'
const start = node.characters.indexOf('如何')
const end = start + '如何缩短反馈周期'.length
await figma.loadFontAsync({ family: 'Inter', style: 'Bold' })
node.setRangeFontName(start, end, { family: 'Inter', style: 'Bold' })
node.setRangeFills(start, end, [
  { type: 'SOLID', color: { r: 0x3d / 255, g: 0xad / 255, b: 0xff / 255 } },
])

return { nodeId, characters: node.characters, emphasized: { start, end } }
```

整段替换会使 mixed styling 回退到首字符样式。若必须保留范围样式，先检查 `getStyledTextSegments`，并通过 `deleteCharacters(start, end)` 与 `insertCharacters(start, replacement)` 做局部替换；每次编辑都从后向前处理匹配位置，避免索引漂移。

## 验证与常见失败

- 对同一 id 使用 `figma:inspect`，验证 characters 与需要的样式范围；视觉调整后 capture 并以 `view_image` 查看。
- **missing font**: 不要强行覆盖。报告节点与字体问题，待字体可用后再执行。
- **mixed font 未全量加载**: 使用 styled segments 或 `getRangeAllFontNames`，不要只加载 `node.fontName`。
- **范围偏一位**: `start` inclusive、`end` exclusive；在写入前检查 `indexOf` 不是 `-1`。
- **丢失混合样式**: 不要对需要保留样式的节点直接整体赋值 `characters`。
