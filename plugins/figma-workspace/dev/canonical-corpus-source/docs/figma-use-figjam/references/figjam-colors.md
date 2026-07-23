# FigJam 颜色与可复用预设

本页用于为 sticky、section、connector、shape-with-text、label、table 和独立文本选择一致的 FigJam 颜色。先确定节点类型与语义，再应用该类型允许的 paint 属性；不要把一个节点类型的颜色组合机械复制到另一个类型。

## `.figma.ts` 前置与执行

颜色变更应作为目标节点的脚本步骤，与节点创建或已验证的 id 放在一起。执行本地脚本时显式传入 FigJam file target、`--surface figjam` 与脚本路径：

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

对一个已确认节点的一次 `fills` 修正可使用 `figma:run` 小事务；协调多个节点、填充与文本色时使用脚本并返回实际更新的 id。

## 关键 API 规则

- 使用精确的 `hex / 255` 通道值。近似小数会令 palette 色在 FigJam 中成为 custom 色。
- sticky 用 `fills`；section 用更浅的 `fills`；connector 用 `strokes`；table 可用 table/cell `fills` 和 cell text `fills`。
- `createShapeWithText()` 的 shape 应同步设置 `fills`、`strokes` 与 `shape.text.fills`，以保证对比度。
- 默认独立文本、sticky text 与表格主体文本用 Charcoal `#1E1E1E`，不要用中灰作为正文层级。

## TypeScript 预设和示例

```ts
const h = (r: number, g: number, b: number): RGB => ({ r: r / 255, g: g / 255, b: b / 255 })
const WHITE = h(0xff, 0xff, 0xff)
const DARK = h(0x1e, 0x1e, 0x1e)

const colors = {
  stickyBlue: h(0xa8, 0xda, 0xff),
  sectionBlue: h(0xf5, 0xfb, 0xff),
  connectorBlue: h(0x3d, 0xad, 0xff),
  shapeBlue: { fill: h(0x3d, 0xad, 0xff), stroke: h(0x00, 0x7a, 0xd2), text: WHITE },
  charcoal: DARK,
}

const sticky = figma.createSticky()
sticky.fills = [{ type: 'SOLID', color: colors.stickyBlue }]

const shape = figma.createShapeWithText()
shape.shapeType = 'ROUNDED_RECTANGLE'
shape.fills = [{ type: 'SOLID', color: colors.shapeBlue.fill }]
shape.strokes = [{ type: 'SOLID', color: colors.shapeBlue.stroke }]
shape.text.fills = [{ type: 'SOLID', color: colors.shapeBlue.text }]

return { stickyId: sticky.id, shapeId: shape.id }
```

可将以下语义作为默认起点，用户指定品牌色时以用户要求为准：blue 表示讨论，yellow 表示问题，green 表示积极或完成，teal 表示决策，red 表示阻塞，violet 表示发散。section 使用浅色版本以衬托内容；饱和色 shape 使用白字，浅色 shape/table body 使用 Charcoal。

常用 palette hex：

| 用途 | 色值 |
| --- | --- |
| Charcoal text / black | `#1E1E1E` |
| Blue | `#3DADFF` |
| Green | `#66D575` |
| Teal | `#5AD8CC` |
| Violet | `#874FFF` |
| Pink | `#F849C1` |
| Red | `#FF7556` |
| Orange | `#FF9E42` |
| Yellow | `#FFC943` |
| Sticky blue | `#A8DAFF` |
| Section light blue | `#F5FBFF` |

## 验证与常见失败

- 用 `figma:inspect` 检查对应 `fills`、`strokes` 和 text fills；成组颜色变更后 capture 并用 `view_image` 判断对比度和语义。
- **palette 未识别**: 用 `0xNN / 255` 重写 RGB，避免 `0.66` 一类近似值。
- **深色背景仍是深色文字**: shape/table header 同时更新文本 fills。
- **错误属性**: connector 不使用 fills 作为线色；table 没有 strokes；先按节点类型写入。
- **无意义的自定义色**: 用户没有指定品牌色时优先 palette，以便在 FigJam UI 中可继续编辑。
