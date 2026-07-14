# 放置 FigJam 节点

当需要在 board 上对齐、相对摆放或将节点移入 section 时使用本页。`x`、`y` 总是相对父节点；把节点 reparent 到 section 后，原有坐标不再代表 page 坐标。因此，先 append，再按新 parent 的局部坐标设置位置。

## `.figma.ts` 前置与执行

先通过 `figma:metadata` 和 `figma:inspect` 获得 anchor node 与 parent/section 的准确 id、尺寸和现有内容。把间距、局部坐标和最小 section 边界写在本地 `.figma.ts`：

```json
{
  "sessionId": "<session-id>",
  "inputFile": "C:/work/project/.figma-workspace/board/place-summary.figma.ts",
  "strict": true,
  "surface": "figjam"
}
```

```text
npm --silent run figma:script:run -- --input C:/work/project/.figma-workspace/place-summary.json --state-file C:/work/project/.figma-workspace/state.json
```

已知 node 的单次 `x`/`y` 调整可作为 `figma:eval` 小事务例外；涉及 parent 变更、多个节点或 section 尺寸计算时必须以脚本运行并返回最终 bounds。

## Plugin API 步骤

1. 用 `getNodeByIdAsync` 得到 anchor 与目标节点，检查它们仍存在且 parent 可接受 child。
2. 若仅在同一 parent 内移动，按 anchor 的 `x + width + gap` 和 `y` 设置目标坐标。
3. 若移入 section，调用 `section.appendChild(node)`，然后用 section 本地坐标写入 `node.x`、`node.y`。
4. 计算 child 的右/下边界，必要时扩展 section，使其包含 children 和 padding。
5. 返回 node、parent、最终坐标与 section 尺寸，随后 inspect。

## TypeScript 示例: 放到 anchor 右侧并确保 section 包含它

```ts
const anchor = await figma.getNodeByIdAsync('<anchor-id>')
const node = await figma.getNodeByIdAsync('<node-id>')
const section = await figma.getNodeByIdAsync('<section-id>')

const isSceneNode = (value: BaseNode | null): value is SceneNode =>
  value !== null && value.type !== 'DOCUMENT' && value.type !== 'PAGE'

if (!isSceneNode(anchor) || !isSceneNode(node) || !section || section.type !== 'SECTION') {
  throw new Error('Anchor, node, or SECTION is unavailable')
}
if (anchor.parent?.id !== section.id) {
  throw new Error('Anchor must already be a direct child of the target section')
}
if (node.id === section.id) throw new Error('A section cannot contain itself')

const padding = 32
const gap = 40
section.appendChild(node)
node.x = anchor.x + anchor.width + gap
node.y = anchor.y

const requiredWidth = Math.max(section.width, node.x + node.width + padding)
const requiredHeight = Math.max(section.height, node.y + node.height + padding)
if (requiredWidth !== section.width || requiredHeight !== section.height) {
  section.resizeWithoutConstraints(requiredWidth, requiredHeight)
}

return {
  nodeId: node.id,
  parentId: section.id,
  bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
  sectionSize: { width: section.width, height: section.height },
}
```

这里的 anchor 坐标也必须属于同一个 section 才能直接相对使用。若 anchor 不在 section 内，先在同一坐标空间中选择 reference，或明确转换坐标；不要混用 page 与 section 坐标。

## 验证与常见失败

- 用 `figma:inspect` 验证 parent id、节点 bounds 及 section bounds；视觉布局使用 capture 后 `view_image` 检查。
- **先定位再 append**: append 后坐标空间改变，最终位置偏移。始终先 append、后定位。
- **section 裁切 child**: reparent 或移动后重算右/下边界并保留 padding。
- **使用不同 parent 的相对坐标**: 只有同一坐标空间的 `x`/`y` 才能直接相加。
- **覆盖已有内容**: 定位前 inspect 周围 bounds，选择明确 gap；复杂排布可先使用空位查找辅助而不是猜测坐标。
