# 在 FigJam 创建表格

当用户需要比较矩阵、名单、规划表或真正的行列数据时，使用 FigJam `TableNode`，而不是用 shapes 拼出一个伪表格。`figma.createTable()` 仅适用于 FigJam；它创建的单元格通过 `table.cellAt(row, column)` 访问，行列索引从 0 开始。

真实输入数据必须完整写入表格，不能与示例或占位数据混合。没有数据时，创建空白表格或先要求提供表头和行数据；不要发明业务内容，也不要删除 canvas 上的原始数据。

## `.figma.ts` 前置与执行

将目标位置、二维数据和尺寸约束写进本地 `.figma.ts`。先确保已为 FigJam 文件准备好 session，再使用同一个绝对 state 文件运行：

```json
{
  "sessionId": "<session-id>",
  "inputFile": "C:/work/project/.figma-workspace/board/create-roster.figma.ts",
  "surface": "figjam"
}
```

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/create-roster.json --state-file C:/work/project/.figma-workspace/state.json
```

对于已知 table 的一次单格修正，`figma:eval` 可以是小事务例外；创建或填充完整表格应使用脚本，使数据、尺寸和结果可复查。

## Plugin API 步骤

1. 用 `figma.createTable(rows, columns)` 创建精确的初始维度。`numRows`、`numColumns`、`width`、`height` 为只读。
2. 读取每个单元格的 `text`，在设置 `characters` 前加载其 `fontName`。
3. 用 `cellAt(row, column)` 填充数据；需要时给标题行设置 cell `fills` 与 text `fills`。
4. 通过 `resizeRow` 和 `resizeColumn` 设定尺寸；用 `insertRow`、`insertColumn`、`removeRow`、`removeColumn` 或 `moveRow`、`moveColumn` 改变结构。
5. 设置 table 的 `x`、`y` 并返回 table id 与最终维度。

## TypeScript 示例

```ts
const rows = [
  ['Name', 'Role', 'Status'],
  ['Ari', 'Research', 'Ready'],
  ['Bo', 'Design', 'In progress'],
]
const h = (r: number, g: number, b: number): RGB => ({ r: r / 255, g: g / 255, b: b / 255 })
const headerFill: Paint[] = [{ type: 'SOLID', color: h(0x3d, 0xad, 0xff) }]
const headerText: Paint[] = [{ type: 'SOLID', color: h(0xff, 0xff, 0xff) }]
const bodyText: Paint[] = [{ type: 'SOLID', color: h(0x1e, 0x1e, 0x1e) }]

const table = figma.createTable(rows.length, rows[0].length)
table.x = 120
table.y = 160
table.resizeRow(0, 44)
for (let column = 0; column < rows[0].length; column += 1) table.resizeColumn(column, 180)

for (let row = 0; row < rows.length; row += 1) {
  for (let column = 0; column < rows[row].length; column += 1) {
    const cell = table.cellAt(row, column)
    const cellFont = cell.text.fontName
    if (cellFont === figma.mixed) throw new Error(`Cell ${row},${column} has mixed fonts`)
    await figma.loadFontAsync(cellFont)
    cell.text.characters = rows[row][column]
    cell.text.fills = row === 0 ? headerText : bodyText
    if (row === 0) cell.fills = headerFill
  }
}

return { tableId: table.id, rows: table.numRows, columns: table.numColumns }
```

色值应使用 `hex / 255`，而不是四舍五入的小数，才能精确匹配 FigJam palette。暗色标题配白字，浅色主体配 Charcoal `#1E1E1E`；表格没有 `strokes`，不要试图给它设置边框。

## 验证与常见失败

- 用 `figma:inspect` 验证 table 类型、维度、位置和代表性单元格文本；必要时 capture 后用 `view_image` 检查可读性。
- **索引越界**: `cellAt` 使用从 0 开始的索引，循环上界应来自数组长度或 `numRows`/`numColumns`。
- **未加载字体**: 设置 `cell.text.characters` 前加载该单元格的 `text.fontName`。
- **试图 `resize()` table**: table 宽高只读，改用 `resizeRow` 和 `resizeColumn`。
- **遗漏输入数据**: 先校验每行列数与表头一致，再创建；不规则数据应显式补齐或向用户澄清。
