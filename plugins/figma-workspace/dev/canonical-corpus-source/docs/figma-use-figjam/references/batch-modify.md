# FigJam 批量修改

当任务需要修改一组已有 FigJam 节点时使用本页，例如统一标题字号、给一批 stickies 改色，或替换某个区域内的文本。批量修改应先限定范围、记录候选节点，再逐个应用可验证的变更；不要把整张 board 的搜索结果直接当作可安全修改的集合。

## 先准备脚本

先用 `figma:metadata` 了解文件结构, 并用 `figma:inspect` 确认目标 section、table 或节点的 raw node ID. 在调用者选择的本地目录创建 `.figma.ts` 文件. 每次执行显式传入 FigJam file target、`--surface figjam` 和脚本路径; TypeScript 预检始终启用:

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

运行前先查看该命令的 help，然后执行：

```text
npm --silent run figma:run -- --file <figjam-file-url-or-key> --surface figjam --script <path/to/script.figma.ts>
```

`figma:run` 只适合一个小而自足的事务，例如已知单个节点的一个属性修正；范围搜索、字体加载或多节点更新都放在 `.figma.ts`。

## Plugin API 步骤

1. 选择最小容器作为搜索根节点。对纯类型筛选，优先 `findAllWithCriteria`；名称或属性条件才使用 `findAll`。
2. 建立候选数组，显式排除不应触碰的节点，并记录其 id、name 和变更前摘要。
3. 对文本内容、字体、字号或排版的修改，先加载每个文本节点实际使用的字体。混合字体要从 styled segments 收集全部字体。
4. 逐个更新；让不满足前置条件的节点进入 `skipped`，不要猜测或强制转换。
5. 返回修改 id、跳过原因和计数。随后对这些 id 做 targeted `figma:inspect`。

## TypeScript 示例: 限定区域的文本标准化

下面脚本只修改指定容器内、名称以 `Agenda` 开头的 `TEXT` 节点。它没有把 board 中其他文本纳入范围，并在返回值中保留审计结果。

```ts
const rootId = '<section-or-container-id>'
const root = await figma.getNodeByIdAsync(rootId)

if (!root || !('findAllWithCriteria' in root)) {
  throw new Error(`Target container is unavailable: ${rootId}`)
}

const candidates = root
  .findAllWithCriteria({ types: ['TEXT'] })
  .filter((node) => node.name.startsWith('Agenda'))
const changed: string[] = []
const skipped: Array<{ id: string; reason: string }> = []

for (const text of candidates) {
  if (text.hasMissingFont) {
    skipped.push({ id: text.id, reason: 'missing font' })
    continue
  }

  const segments = text.getStyledTextSegments(['fontName'])
  await Promise.all(segments.map((segment) => figma.loadFontAsync(segment.fontName)))
  text.fontSize = 24
  text.fills = [{ type: 'SOLID', color: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 } }]
  changed.push(text.id)
}

return { rootId, candidateCount: candidates.length, changed, skipped }
```

对仅按类型选择的场景可改为：

```ts
const textNodes = figma.currentPage.findAllWithCriteria({ types: ['TEXT'] })
```

这比全页 predicate 扫描更直接，但仍应在写入前以名称、父节点或其它业务条件缩小集合。

## 验证

- 检查脚本返回的 `candidateCount`、`changed` 和 `skipped` 是否符合预期。
- 使用 `figma:inspect` 检查若干 changed id，确认字体、字号、文本或 fills 已写入。
- 对大范围视觉变更使用 `figma:capture`，并用 `view_image` 检查生成的图片。
- 保留脚本和输出中的节点 id，方便后续修复或回滚范围判断。

## 常见失败

- **范围过大**: `figma.currentPage.findAll(...)` 匹配到无关内容。先获得 section/container id，并在该容器内搜索。
- **字体未加载或缺失**: 修改 `characters`、`fontSize`、`fontName` 等会失败。对每个文本节点加载全部 styled-segment 字体；`hasMissingFont` 为真时跳过并报告。
- **把 `fills` 当作所有节点共有属性**: 先以节点类型或 `'fills' in node` 守卫，避免写入不支持该属性的节点。
- **长操作不可诊断**: 返回结构化计数与 id，必要时按固定大小分批处理，而不是只输出一条成功日志。
