# Plugin API Lookup

Bundled index: `references/official-figma-skills/figma-use/references/plugin-api-standalone.index.md`

Read when exact Figma Plugin API types, method signatures, node interfaces, enum values, or overloads are needed. Then read [plugin-api-standalone.md](plugin-api-standalone.md) for the local `.d.ts` document pointer and search rules.

Required before tool call: this reference is not a substitute for `figma-use`; read `figma-use` before every `use_figma` call.

Use [plugin-api-standalone.md](plugin-api-standalone.md) as the router's explicit document reference for the bundled source-of-truth `.d.ts` file:

`references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts`

Use targeted search instead of reading the whole file:

```bash
rg --heading -n "interface FrameNode|createFrame|VariableCollection" "references/official-figma-skills/figma-use/references/plugin-api-standalone.d.ts"
```
