# Plugin API Standalone Type Document

Bundled local document:

`references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts`

Use this file as the source of truth for exact Figma Plugin API types, interfaces, method signatures, enum values, overloads, and node-specific properties.

Access rule: do not read the whole `.d.ts` into context. Search targeted symbols with `rg --heading -n`, then read only the matched neighborhood if needed.

Example:

```bash
rg --heading -n "interface FrameNode|createFrame|VariableCollection" "references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts"
```

This document reference complements `references/official-figma-skills/figma-use/references/plugin-api-standalone.index.md`; it does not replace the mandatory `figma-use` prerequisite before `use_figma`.
